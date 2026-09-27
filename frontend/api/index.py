"""
Weekend 1 backend.

Single job: mint a short lived Deepgram key so the browser can open a
websocket straight to Deepgram. We do not proxy audio through this
service. Proxying would add a round trip to every chunk and the whole
point of the build is that the hot path is short.
"""

import os
import json
from pydantic import BaseModel
import httpx
# from dotenv import load_dotenv
# from fastapi import FastAPI, HTTPException
from fastapi import FastAPI, File, HTTPException, UploadFile
from fastapi.middleware.cors import CORSMiddleware

# load_dotenv()

DEEPGRAM_API_KEY = os.environ.get("DEEPGRAM_API_KEY")
DEEPGRAM_BASE = "https://api.deepgram.com/v1"
KEY_TTL_SECONDS = 60

app = FastAPI(title="voice-logger")

ALLOWED_ORIGINS = [
        o.strip()
        for o in os.environ.get("ALLOWED_ORIGINS", "http://localhost:5173").split(",")
        if o.strip()
    ]

    app.add_middleware(
        CORSMiddleware,
        allow_origins=ALLOWED_ORIGINS,
        allow_methods=["GET", "POST"],
        allow_headers=["*"],
        max_age=3600,
    )

_project_id_cache: str | None = None


async def _auth_headers() -> dict[str, str]:
    if not DEEPGRAM_API_KEY:
        raise HTTPException(500, "DEEPGRAM_API_KEY is not set")
    return {"Authorization": f"Token {DEEPGRAM_API_KEY}"}


async def _project_id(client: httpx.AsyncClient) -> str:
    global _project_id_cache
    if _project_id_cache:
        return _project_id_cache

    resp = await client.get(f"{DEEPGRAM_BASE}/projects", headers=await _auth_headers())
    resp.raise_for_status()
    projects = resp.json().get("projects", [])
    if not projects:
        raise HTTPException(500, "No Deepgram projects found for this key")

    _project_id_cache = projects[0]["project_id"]
    return _project_id_cache


@app.get("/health")
async def health() -> dict[str, str]:
    return {"status": "ok"}


@app.post("/api/stt/token")
async def stt_token() -> dict[str, object]:
    """Return a scoped key that expires in a minute."""
    async with httpx.AsyncClient(timeout=10) as client:
        project_id = await _project_id(client)
        resp = await client.post(
            f"{DEEPGRAM_BASE}/projects/{project_id}/keys",
            headers=await _auth_headers(),
            json={
                "comment": "voice-logger browser session",
                "scopes": ["usage:write"],
                "time_to_live_in_seconds": KEY_TTL_SECONDS,
            },
        )

    if resp.status_code >= 400:
        raise HTTPException(resp.status_code, f"Deepgram rejected the key request: {resp.text}")

    return {"key": resp.json()["key"], "expires_in": KEY_TTL_SECONDS}

GROQ_API_KEY = os.environ.get("GROQ_API_KEY")
GROQ_URL = "https://api.groq.com/openai/v1/audio/transcriptions"

PROMPT = ("Mostly Indian food and fitness logging. Terms: bhindi, chapathi, dal, roti, paratha, "
            "sabzi, idli, uttapam, ramja, kale chole, white chole, sandwich, eggs, half fry, omelette, katori, "
            "sambhar, methi, strength, training, cardio, running, walking, poha, upma, saviya")

@app.post("/api/stt/transcribe")
async def transcribe(audio: UploadFile = File(...)) -> dict[str,str]:
    if not GROQ_API_KEY:
        raise HTTPException(500, "GROQ_API_KEY is not set")
    payload = await audio.read()

    async with httpx.AsyncClient(timeout=30) as client:
        resp = await client.post(
            GROQ_URL,
            headers={"Authorization":f"Bearer {GROQ_API_KEY}"},
            files={"file": ("clip.webm", payload, "audio/webm")},
            data={
                "model": "whisper-large-v3-turbo",
                "language": "en",
                "prompt": PROMPT,
                "response_format": "json",
            },
        )
    if resp.status_code >= 400:
        raise HTTPException(resp.status_code, f"Groq rejected the clip: {resp.text}")

    return {"text": resp.json().get("text","").strip()}








ANTHROPIC_API_KEY = os.environ.get("ANTHROPIC_API_KEY")
ANTHROPIC_URL = "https://api.anthropic.com/v1/messages"
ANTHROPIC_MODEL = "claude-haiku-4-5-20251001"

PARSE_SYSTEM = """You convert spoken daily-log commands into JSON.

Return ONLY a JSON object. No prose, no markdown fences.

Schema:
{
  "intent": "log" | "query_summary" | "undo_last" | "unknown",
  "entries": [
    {
      "skill": "activity",
      "activity_key": string,
      "duration_min": integer or null,
      "distance_km": number or null,
      "level": "light" | "moderate" | "vigorous"
    },
    {
      "skill": "food",
      "name": string,
      "qty": number or null,
      "unit": string or null,
      "meal": "breakfast" | "lunch" | "snack" | "dinner" | "unspecified"
    }
  ],
  "confidence": number between 0 and 1,
  "question": string or null
}

Rules:
- ONE utterance may mix activities and foods. Return an entry for each thing
  mentioned, in the order spoken, each tagged with its "skill".
- activity_key MUST be one of the allowed keys given by the user. Never invent
  one. If an activity does not fit any allowed key, leave it out and mention it
  in "question".
- For food, return the dish name AS SPOKEN, tidied. Do NOT return nutrition
  numbers, calories or macros. Something else resolves those.
- Keep Indian dish names as they are: bhindi, chapati, toor dal, poha, idli.
- "unit" is the spoken household unit: katori, bowl, glass, plate, piece, roti,
  tbsp, g, ml. Use null if none was said.
- "qty" is null if no quantity was said. Do not assume 1, leave it null.
- "meal" comes from what was SAID ("for breakfast"), never from the time of day.
  Use "unspecified" when not stated.
- Speakers often drop units on durations. "thirty strength training" is 30 minutes.
- Indian English and Hinglish are common. "ek ghanta" is 60 minutes, "do" is 2.
- Never invent a duration that was not stated. Use null and ask in "question".
- If a duration exceeds 4 hours, report it but set confidence below 0.5 and ask
  whether they meant minutes.
- Never return more than 8 entries.
"""


class ParseRequest(BaseModel):
    text: str
    activity_keys: list[str]


@app.post("/api/parse")
async def parse_utterance(req: ParseRequest) -> dict[str, object]:
    if not ANTHROPIC_API_KEY:
        raise HTTPException(500, "ANTHROPIC_API_KEY is not set")

    prompt = f"Allowed activity_key values: {', '.join(req.activity_keys)}\n\nUtterance: {req.text}"

    async with httpx.AsyncClient(timeout=20) as client:
        resp = await client.post(
            ANTHROPIC_URL,
            headers={
                "x-api-key": ANTHROPIC_API_KEY,
                "anthropic-version": "2023-06-01",
                "content-type": "application/json",
            },
            json={
                "model": ANTHROPIC_MODEL,
                "max_tokens": 900,
                "system": PARSE_SYSTEM,
                "messages": [{"role": "user", "content": prompt}],
            },
        )

    if resp.status_code >= 400:
        raise HTTPException(resp.status_code, f"Parse model rejected the request: {resp.text}")

    blocks = resp.json().get("content", [])
    text = "".join(b.get("text", "") for b in blocks if b.get("type") == "text").strip()
    text = text.removeprefix("```json").removeprefix("```").removesuffix("```").strip()

    try:
        parsed = json.loads(text)
    except json.JSONDecodeError:
        return {"intent": "unknown", "entries": [], "confidence": 0.0,
                "question": "I did not catch that.", "parsed_by": "haiku"}

    raw_entries = parsed.get("entries") or []
    if not isinstance(raw_entries, list):
        raw_entries = []

    kept: list[dict[str, object]] = []
    dropped = 0

    for item in raw_entries[:8]:
        if not isinstance(item, dict):
            dropped += 1
            continue

        skill = item.get("skill")

        if skill == "activity":
            # Never trust an activity key the model invented.
            if item.get("activity_key") not in req.activity_keys:
                dropped += 1
                continue
            kept.append({
                "skill": "activity",
                "activity_key": item.get("activity_key"),
                "duration_min": item.get("duration_min"),
                "distance_km": item.get("distance_km"),
                "level": item.get("level") or "moderate",
            })

        elif skill == "food":
            name = (item.get("name") or "").strip()
            if not name:
                dropped += 1
                continue
            kept.append({
                "skill": "food",
                "name": name,
                "qty": item.get("qty"),
                "unit": item.get("unit"),
                "meal": item.get("meal") or "unspecified",
            })

        else:
            dropped += 1

    question = parsed.get("question")
    if dropped and not question:
        question = f"I could not place {dropped} of those. Say that part again?"

    intent = parsed.get("intent", "unknown")
    if intent in ("log", "log_activity") and kept:
        intent = "log"
    elif intent in ("log", "log_activity"):
        intent = "unknown"
        question = question or "What was that?"

    return {
        "intent": intent,
        "entries": kept,
        "confidence": float(parsed.get("confidence") or 0),
        "question": question,
        "parsed_by": "haiku",
    }




FOOD_SYSTEM = """You estimate the nutrition of a single named dish.

Return ONLY a JSON object. No prose, no markdown fences.

{
  "name": string,
  "per_100g": { "kcal": number, "protein_g": number, "carb_g": number,
                "fat_g": number, "fibre_g": number },
  "serving_g": number,
  "note": string or null
}

Rules:
- Values are per 100 grams of the dish AS SERVED, cooked, not raw ingredients.
- "serving_g" is the weight of one normal household portion in grams. For Indian
  dishes assume a katori is about 150g, a roti or chapati about 45g, an idli
  about 40g, a dosa about 90g.
- Give your best estimate for typical home cooking. Do not refuse.
- "name" should be the tidied, conventional spelling of the dish.
"""


class FoodEstimateRequest(BaseModel):
    name: str


@app.post("/api/food/estimate")
async def estimate_food(req: FoodEstimateRequest) -> dict[str, object]:
    if not ANTHROPIC_API_KEY:
        raise HTTPException(500, "ANTHROPIC_API_KEY is not set")

    async with httpx.AsyncClient(timeout=20) as client:
        resp = await client.post(
            ANTHROPIC_URL,
            headers={
                "x-api-key": ANTHROPIC_API_KEY,
                "anthropic-version": "2023-06-01",
                "content-type": "application/json",
            },
            json={
                "model": ANTHROPIC_MODEL,
                "max_tokens": 400,
                "system": FOOD_SYSTEM,
                "messages": [{"role": "user", "content": f"Dish: {req.name}"}],
            },
        )

    if resp.status_code >= 400:
        raise HTTPException(resp.status_code, f"Estimate failed: {resp.text}")

    blocks = resp.json().get("content", [])
    text = "".join(b.get("text", "") for b in blocks if b.get("type") == "text").strip()
    text = text.removeprefix("```json").removeprefix("```").removesuffix("```").strip()

    try:
        parsed = json.loads(text)
    except json.JSONDecodeError:
        raise HTTPException(502, "Estimate came back unparseable")

    per_100g = parsed.get("per_100g") or {}
    clean = {k: float(v) for k, v in per_100g.items() if isinstance(v, (int, float))}

    return {
        "name": parsed.get("name") or req.name,
        "per_100g": clean,
        "serving_g": parsed.get("serving_g"),
        "note": parsed.get("note"),
    }

