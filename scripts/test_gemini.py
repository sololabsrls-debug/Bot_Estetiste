"""
Test Gemini API connection and basic function calling.
Run: python scripts/test_gemini.py
"""

import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from dotenv import load_dotenv
load_dotenv("config/.env")
load_dotenv("config/.env.local")
load_dotenv(".env")
load_dotenv(".env.local")

from google import genai
from google.genai import types


def main():
    api_key = os.getenv("GOOGLE_API_KEY")
    if not api_key:
        print("ERROR: GOOGLE_API_KEY not set")
        sys.exit(1)

    print("Testing Gemini connection...")
    client = genai.Client(api_key=api_key)

    # Simple text generation test
    response = client.models.generate_content(
        model="gemini-2.5-flash",
        contents="Rispondi in italiano: Ciao, come stai?",
        config=types.GenerateContentConfig(
            temperature=0.7,
            max_output_tokens=100,
        ),
    )

    print(f"\nGemini response: {response.text}")

    # Test with function calling
    print("\n--- Function Calling Test ---")
    tool_decl = types.FunctionDeclaration(
        name="get_weather",
        description="Get current weather for a city",
        parameters={
            "type": "OBJECT",
            "properties": {
                "city": {"type": "STRING", "description": "City name"},
            },
            "required": ["city"],
        },
    )

    response = client.models.generate_content(
        model="gemini-2.5-flash",
        contents="Che tempo fa a Milano?",
        config=types.GenerateContentConfig(
            tools=[types.Tool(function_declarations=[tool_decl])],
            temperature=0.7,
        ),
    )

    for part in response.candidates[0].content.parts:
        if part.function_call:
            print(f"  Function call: {part.function_call.name}({dict(part.function_call.args)})")
        elif part.text:
            print(f"  Text: {part.text}")

    print("\nGemini connection OK!")


if __name__ == "__main__":
    main()
