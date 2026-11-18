-- 010_day_notifications.sql
-- Stato delle notifiche WhatsApp (tenant unofficial) calcolato per cliente e giorno.
--
-- Per ogni (cliente, giorno) si salva cosa è stato comunicato l'ultima volta
-- (snapshot). Lo scheduler confronta lo snapshot con gli appuntamenti attuali:
-- se la giornata è cambiata manda un solo messaggio (nuova prenotazione,
-- aggiornamento, spostamento, annullamento) con la situazione completa.
-- Se un invio fallisce lo snapshot non viene aggiornato, quindi il giro dopo
-- ritenta da solo.

create table if not exists public.appointment_day_notifications (
    client_id        uuid not null references public.clients(id) on delete cascade,
    day              date not null,                       -- giorno in Europe/Rome
    tenant_id        uuid not null references public.tenants(id) on delete cascade,
    snapshot         jsonb not null default '[]'::jsonb,  -- appuntamenti comunicati
    reminder_sent_at timestamptz,                         -- promemoria del giorno prima (o messaggio equivalente) per questo snapshot
    last_message_kind text,                               -- nuovo | aggiornato | spostato | annullato | promemoria | silenzioso
    last_message_at  timestamptz,
    updated_at       timestamptz not null default now(),
    primary key (client_id, day)
);

create index if not exists appointment_day_notifications_tenant_day_idx
    on public.appointment_day_notifications (tenant_id, day);

-- Tenant per cui lo stato iniziale è già stato costruito dagli appuntamenti
-- esistenti (così al primo avvio nessun cliente riceve messaggi arretrati).
create table if not exists public.appointment_notification_bootstrap (
    tenant_id uuid primary key references public.tenants(id) on delete cascade,
    done_at   timestamptz not null default now()
);

-- Tabelle interne del bot (service role): nessun accesso dal frontend.
alter table public.appointment_day_notifications enable row level security;
alter table public.appointment_notification_bootstrap enable row level security;
