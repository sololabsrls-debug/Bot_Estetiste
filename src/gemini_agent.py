"""
Gemini 2.5 Flash agent with function calling.
Builds system prompt with tenant/client context, declares tools,
and runs the function-calling loop (max 5 iterations).
"""

import json
import logging
import os
from typing import Optional

from google import genai
from google.genai import types

from src.conversation_manager import get_conversation_history
from src.supabase_client import get_supabase
from src.tools import ALL_TOOLS
from src.utils import format_date_italian

logger = logging.getLogger("BOT.gemini")

MAX_TOOL_ROUNDS = 5


def _fetch_tenant_services(tenant_id: str) -> list[dict]:
    """Fetch active services for a tenant from Supabase."""
    sb = get_supabase()
    try:
        response = (
            sb.table("services")
            .select("id, name, description, descrizione_breve, duration_min, price")
            .eq("tenant_id", tenant_id)
            .eq("is_active", True)
            .order("display_order")
            .order("name")
            .execute()
        )
        return response.data or []
    except Exception as e:
        logger.error(f"Error fetching services for prompt: {e}")
        return []


def _fetch_tenant_staff(tenant_id: str) -> list[dict]:
    """Fetch active staff for a tenant from Supabase."""
    sb = get_supabase()
    try:
        response = (
            sb.table("staff")
            .select("id, name")
            .eq("tenant_id", tenant_id)
            .eq("is_active", True)
            .order("name")
            .execute()
        )
        return response.data or []
    except Exception as e:
        logger.error(f"Error fetching staff for prompt: {e}")
        return []


def _format_services_for_prompt(services: list[dict]) -> str:
    """Format services list for inclusion in system prompt."""
    if not services:
        return "Nessun servizio disponibile al momento."
    lines = []
    for s in services:
        desc = s.get("descrizione_breve") or s.get("description") or ""
        price = f"€{float(s['price']):.2f}" if s.get("price") else "prezzo da definire"
        duration = f"{s['duration_min']} min" if s.get("duration_min") else "durata da definire"
        lines.append(f"- {s['name']} | {duration} | {price} | ID: {s['id']}")
        if desc:
            lines.append(f"  {desc}")
    return "\n".join(lines)


def _format_staff_for_prompt(staff: list[dict]) -> str:
    """Format staff list for inclusion in system prompt."""
    if not staff:
        return "Nessun operatore disponibile al momento."
    return "\n".join(f"- {s['name']} | ID: {s['id']}" for s in staff)


def _build_system_prompt(tenant: dict, client: dict, services: list[dict], staff: list[dict]) -> str:
    """Build the system prompt with tenant and client context."""
    tenant_name = tenant.get("name", "Centro Estetico")
    tenant_phone = tenant.get("phone", "")
    tenant_address = tenant.get("address", "")
    tenant_email = tenant.get("email", "")

    # Usa SOLO il campo name (verificato), mai il whatsapp_name (potrebbe essere emoji/nickname)
    client_name = (client.get("name") or "").strip()
    # Il nome è valido SOLO se ha almeno 2 parole composte da lettere (no emoji, numeri, ecc.)
    name_parts = [p for p in client_name.split() if p.isalpha()] if client_name else []
    name_is_complete = len(name_parts) >= 2
    # Se il nome non è valido, non mostrarlo a Gemini
    if not name_is_complete:
        client_name = ""

    services_text = _format_services_for_prompt(services)
    staff_text = _format_staff_for_prompt(staff)

    return f"""Sei l'assistente virtuale WhatsApp di "{tenant_name}", un centro estetico.
Rispondi sempre in italiano, con tono professionale ma cordiale e accogliente.

INFORMAZIONI CENTRO:
- Nome: {tenant_name}
- Telefono: {tenant_phone}
- Indirizzo: {tenant_address}
- Email: {tenant_email}

INFORMAZIONI CLIENTE:
- Nome: {client_name or 'NON DISPONIBILE'}
- Nome completo (nome + cognome): {"SI" if name_is_complete else "NO — DEVI chiedere nome e cognome completo PRIMA di qualsiasi prenotazione"}
- ID: {client.get('id', 'N/A')}

SERVIZI DISPONIBILI (lista completa e aggiornata dal database):
{services_text}

OPERATORI DISPONIBILI:
{staff_text}

LA DATA DI OGGI È: {format_date_italian()}. Usa SEMPRE questa data per calcolare "oggi", "domani", "dopodomani". IGNORA date nei messaggi precedenti.

=== REGOLA CRITICA: DISPONIBILITÀ ===
Quando il cliente menziona un orario, chiede se è disponibile, o vuole prenotare:
1. DEVI chiamare check_availability() COME PRIMA AZIONE — prima di scrivere qualsiasi testo
2. Rispondi SOLO in base agli slot restituiti dal tool
3. NON confermare MAI disponibilità basandoti sulla conversazione precedente

ESEMPIO CORRETTO:
  Cliente: "Domani alle 12:30 va bene?"
  Tu: [chiami check_availability(date="...")] → poi rispondi in base al risultato

ESEMPIO SBAGLIATO (DA NON FARE MAI):
  Cliente: "Domani alle 12:30 va bene?"
  Tu: "Sì, è disponibile!" ← VIETATO senza aver chiamato check_availability

Se NON chiami check_availability prima di confermare un orario, darai informazioni FALSE al cliente.
=== FINE REGOLA CRITICA ===

ALTRE REGOLE:
1. I servizi elencati sopra sono gli UNICI offerti. NON inventare servizi non in lista.
2. Per prezzi e durate, usa SOLO i dati dalla lista sopra.
3. PRIMA di prenotare, CONTROLLA "Nome completo" sopra. Se è "NO", chiedi nome e cognome e salvalo con update_client_name. NON prenotare se il nome è "NO".
4. Se il cliente chiede un operatore umano o hai dubbi, usa request_human_operator.
5. Non rivelare di essere un bot se non chiesto esplicitamente.
6. Formatta per WhatsApp (*grassetto*, _corsivo_, emoji con parsimonia).
7. Se il cliente saluta, rispondi cordialmente e chiedi come aiutarlo.
8. Orari in formato 24h (14:30, non 2:30 PM).
9. Per info dettagliate su un servizio, usa get_service_info.
10. Per cancellare/modificare appuntamenti, usa prima get_my_appointments poi cancel_appointment o modify_appointment.
"""


def _get_tool_declarations() -> list[types.FunctionDeclaration]:
    """Build Gemini function declarations from our tool functions."""
    declarations = []

    tool_schemas = {
        "get_services": {
            "description": "Recupera l'elenco dei servizi/trattamenti offerti dal centro estetico con prezzi e durate.",
            "parameters": {
                "type": "OBJECT",
                "properties": {
                    "category": {
                        "type": "STRING",
                        "description": "Categoria opzionale per filtrare (es. 'viso', 'corpo', 'massaggi')",
                    }
                },
            },
        },
        "get_service_info": {
            "description": "Recupera informazioni dettagliate su uno specifico servizio/trattamento (descrizione, durata, prezzo, benefici).",
            "parameters": {
                "type": "OBJECT",
                "properties": {
                    "service_name": {
                        "type": "STRING",
                        "description": "Nome del servizio da cercare",
                    }
                },
                "required": ["service_name"],
            },
        },
        "get_center_info": {
            "description": "Recupera informazioni generali sul centro estetico (orari di apertura, indirizzo, contatti).",
            "parameters": {
                "type": "OBJECT",
                "properties": {},
            },
        },
        "request_human_operator": {
            "description": "Trasferisci la conversazione a un operatore umano. Usa quando il cliente lo richiede esplicitamente o quando non riesci a gestire la richiesta.",
            "parameters": {
                "type": "OBJECT",
                "properties": {
                    "reason": {
                        "type": "STRING",
                        "description": "Motivo della richiesta di operatore umano",
                    }
                },
                "required": ["reason"],
            },
        },
        "check_availability": {
            "description": "Controlla la disponibilità di appuntamenti per una data specifica. Restituisce gli slot orari disponibili.",
            "parameters": {
                "type": "OBJECT",
                "properties": {
                    "date": {
                        "type": "STRING",
                        "description": "Data da controllare in formato YYYY-MM-DD",
                    },
                    "service_id": {
                        "type": "STRING",
                        "description": "ID del servizio (opzionale, per filtrare per durata necessaria)",
                    },
                    "staff_id": {
                        "type": "STRING",
                        "description": "ID dell'operatore specifico (opzionale)",
                    },
                },
                "required": ["date"],
            },
        },
        "book_appointment": {
            "description": "Prenota un appuntamento. DEVI aver prima verificato la disponibilità con check_availability.",
            "parameters": {
                "type": "OBJECT",
                "properties": {
                    "service_id": {
                        "type": "STRING",
                        "description": "ID del servizio",
                    },
                    "staff_id": {
                        "type": "STRING",
                        "description": "ID dell'operatore",
                    },
                    "date": {
                        "type": "STRING",
                        "description": "Data in formato YYYY-MM-DD",
                    },
                    "time": {
                        "type": "STRING",
                        "description": "Orario in formato HH:MM",
                    },
                },
                "required": ["service_id", "staff_id", "date", "time"],
            },
        },
        "get_my_appointments": {
            "description": "Recupera gli appuntamenti futuri del cliente.",
            "parameters": {
                "type": "OBJECT",
                "properties": {},
            },
        },
        "modify_appointment": {
            "description": "Modifica/sposta un appuntamento esistente del cliente. Verifica ownership e disponibilità.",
            "parameters": {
                "type": "OBJECT",
                "properties": {
                    "appointment_id": {
                        "type": "STRING",
                        "description": "ID dell'appuntamento da modificare",
                    },
                    "new_date": {
                        "type": "STRING",
                        "description": "Nuova data in formato YYYY-MM-DD",
                    },
                    "new_time": {
                        "type": "STRING",
                        "description": "Nuovo orario in formato HH:MM",
                    },
                },
                "required": ["appointment_id", "new_date", "new_time"],
            },
        },
        "cancel_appointment": {
            "description": "Cancella un appuntamento del cliente.",
            "parameters": {
                "type": "OBJECT",
                "properties": {
                    "appointment_id": {
                        "type": "STRING",
                        "description": "ID dell'appuntamento da cancellare",
                    },
                },
                "required": ["appointment_id"],
            },
        },
        "update_client_name": {
            "description": "Aggiorna il nome completo (nome e cognome) del cliente nel database.",
            "parameters": {
                "type": "OBJECT",
                "properties": {
                    "full_name": {
                        "type": "STRING",
                        "description": "Nome e cognome completo del cliente (es. 'Maria Rossi')",
                    },
                },
                "required": ["full_name"],
            },
        },
    }

    for name, schema in tool_schemas.items():
        declarations.append(
            types.FunctionDeclaration(
                name=name,
                description=schema["description"],
                parameters=schema.get("parameters"),
            )
        )

    return declarations


def _find_tool_function(name: str):
    """Find the tool function by name."""
    for tool_fn in ALL_TOOLS:
        if tool_fn.__name__ == name:
            return tool_fn
    return None


async def process_message(
    tenant: dict,
    client: dict,
    conversation: dict,
    user_message: str,
) -> Optional[dict]:
    """
    Process a user message through Gemini with function calling.
    Returns dict {"text": str, "tool_context": {...} | None} or None.
    """
    api_key = os.getenv("GOOGLE_API_KEY")
    if not api_key:
        logger.error("GOOGLE_API_KEY not set")
        return {"text": "Ci scusi, il servizio non è momentaneamente disponibile.", "tool_context": None}

    gemini_client = genai.Client(api_key=api_key)

    # Fetch fresh services and staff from Supabase for this tenant
    services = _fetch_tenant_services(tenant["id"])
    staff = _fetch_tenant_staff(tenant["id"])

    system_prompt = _build_system_prompt(tenant, client, services, staff)
    tool_declarations = _get_tool_declarations()

    # Build conversation history
    conversation_id = conversation.get("id")
    tenant_id = tenant["id"]
    history = await get_conversation_history(
        tenant_id=tenant_id,
        client_id=client.get("id"),
        client_phone=client.get("whatsapp_phone", ""),
    ) if client.get("id") else []

    contents = []
    for msg in history:
        role = "user" if msg["role"] == "user" else "model"
        contents.append(types.Content(role=role, parts=[types.Part.from_text(text=msg["content"])]))

    # Add current user message
    contents.append(
        types.Content(role="user", parts=[types.Part.from_text(text=user_message)])
    )

    # Tool config
    tools = [types.Tool(function_declarations=tool_declarations)]

    config = types.GenerateContentConfig(
        system_instruction=system_prompt,
        tools=tools,
        temperature=0.7,
        max_output_tokens=1024,
    )

    # Context for tool execution
    tool_context = {
        "tenant_id": tenant["id"],
        "client_id": client.get("id"),
        "conversation_id": conversation_id,
    }

    # Track last tool call for interactive message routing
    last_tool_name = None
    last_tool_result = None

    try:
        # Function calling loop
        for round_num in range(MAX_TOOL_ROUNDS):
            response = gemini_client.models.generate_content(
                model="gemini-2.5-flash",
                contents=contents,
                config=config,
            )

            candidate = response.candidates[0] if response.candidates else None
            if not candidate or not candidate.content or not candidate.content.parts:
                logger.warning("Empty Gemini response")
                return {"text": "Ci scusi, non ho capito. Può ripetere?", "tool_context": None}

            # Check if there are function calls
            function_calls = [
                part for part in candidate.content.parts
                if part.function_call is not None
            ]

            if not function_calls:
                # No function calls: extract text response
                text_parts = [
                    part.text for part in candidate.content.parts
                    if part.text
                ]
                text = "\n".join(text_parts) if text_parts else None
                if text is None:
                    return None
                return {
                    "text": text,
                    "tool_context": {
                        "last_tool": last_tool_name,
                        "last_result": last_tool_result,
                    } if last_tool_name else None,
                }

            # Process function calls
            contents.append(candidate.content)

            function_responses = []
            for fc_part in function_calls:
                fc = fc_part.function_call
                fn_name = fc.name
                fn_args = dict(fc.args) if fc.args else {}

                logger.info(f"Tool call: {fn_name}({fn_args})")

                tool_fn = _find_tool_function(fn_name)
                if tool_fn:
                    try:
                        result = await tool_fn(**fn_args, **tool_context)
                        # Track for interactive message routing
                        last_tool_name = fn_name
                        last_tool_result = result
                    except Exception as e:
                        logger.error(f"Tool {fn_name} error: {e}")
                        result = {"error": str(e)}
                else:
                    result = {"error": f"Unknown tool: {fn_name}"}

                result_str = json.dumps(result, ensure_ascii=False, default=str)
                function_responses.append(
                    types.Part.from_function_response(
                        name=fn_name,
                        response={"result": result_str},
                    )
                )

            contents.append(
                types.Content(role="user", parts=function_responses)
            )

        # Exhausted rounds
        logger.warning("Max tool rounds reached")
        return {"text": "Mi scusi, sto avendo difficoltà a elaborare la richiesta. Può riprovare?", "tool_context": None}

    except Exception as e:
        logger.exception(f"Gemini error: {e}")
        return {"text": "Ci scusi, si è verificato un problema tecnico. La ricontatteremo al più presto.", "tool_context": None}
