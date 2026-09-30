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


@app.get("/api/health")
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
  "intent": "log" | "query_summary" | "delete" | "set_goal" | "undo_last" | "unknown",
  "entries": [
    {
      "skill": "activity",
      "activity_key": string,
      "duration_min": integer or null,
      "distance_km": number or null,
      "level": "light" | "moderate" | "vigorous",
      "day_offset": integer
    },
    {
      "skill": "food",
      "name": string,
      "qty": number or null,
      "unit": string or null,
      "meal": <meal> or null,
      "day_offset": integer
    }
  ],
  "delete": { "day_offset": integer, "meal": <meal> or null, "type": "food" | "activity" or null },
  "goal": { "metric": <metric>, "target": number, "comparator": "at_least" | "at_most" },
  "confidence": number between 0 and 1,
  "question": string or null
}

Valid <meal>: early_snack, breakfast, morning_snack, lunch, afternoon_snack,
dinner, late_snack.

Valid <metric>: kcal_in, kcal_out, protein_g, carb_g, fat_g, fibre_g, active_min.

Rules for every intent:
- day_offset counts back from today. 0 is today, 1 is yesterday, 2 the day
  before that. "this morning" and "tonight" are still 0.
- Work out day_offset from the words only. Never from a clock. If no day is
  mentioned, use 0.

Rules for "log":
- One utterance may mix activities and foods. Return an entry for each thing
  mentioned, in the order spoken, tagged with its "skill".
- activity_key MUST be one of the allowed keys given by the user. Never invent
  one. If an activity fits none of them, leave it out and say so in "question".
- For food, return the dish name AS SPOKEN, tidied. Never return calories or
  macros; something else resolves those.
- Keep Indian dish names as they are: bhindi, chapati, toor dal, poha, idli.
- "unit" is the spoken household unit: katori, bowl, glass, plate, piece,
  roti, tbsp, g, ml. Null if none was said.
- "qty" is null if no quantity was said. Do not assume 1.
- "meal" comes ONLY from what was said ("for breakfast", "at dinner"). If no
  meal was mentioned, return null. Never guess it from the time of day.
- Speakers drop units on durations. "thirty strength training" is 30 minutes.
- Indian English and Hinglish are common. "ek ghanta" is 60 minutes.
- Never invent a duration that was not stated. Use null and ask.
- A duration over 4 hours: report it, set confidence below 0.5, and ask in
  "question" whether they meant minutes.
- Never return more than 8 entries.

Rules for "delete":
- "delete yesterday's entries", "remove yesterday's lunch", "clear today".
- Fill "delete" and leave "entries" empty.
- meal null means the whole day. type null means both food and activity.

Rules for "set_goal":
- "set my protein target to 150", "I want to stay under 2000 calories".
- "under", "at most", "less than" mean at_most. Otherwise at_least.
- Fill "goal" and leave "entries" empty.

Rules for "query_summary":
- Any question about what was logged, totals, averages, or goal progress.
- Leave "entries" empty; another step handles the question itself.
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
                "max_tokens": 1000,
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

    intent = parsed.get("intent", "unknown")
    question = parsed.get("question")

    def clamp_offset(value) -> int:
        try:
            return max(0, min(365, int(value)))
        except (TypeError, ValueError):
            return 0

    def clean_meal(value):
        return value if value in MEAL_SLOTS else None

    # --- delete -------------------------------------------------------
    if intent == "delete":
        spec = parsed.get("delete") or {}
        kind = spec.get("type")
        return {
            "intent": "delete",
            "entries": [],
            "delete": {
                "day_offset": clamp_offset(spec.get("day_offset")),
                "meal": clean_meal(spec.get("meal")),
                "type": kind if kind in ("food", "activity") else None,
            },
            "confidence": float(parsed.get("confidence") or 0),
            "question": question,
            "parsed_by": "haiku",
        }

    # --- set_goal -----------------------------------------------------
    if intent == "set_goal":
        spec = parsed.get("goal") or {}
        metric = spec.get("metric")
        if metric not in SUMMARY_METRICS:
            return {"intent": "unknown", "entries": [], "confidence": 0.0,
                    "question": f"I do not track {metric} yet.", "parsed_by": "haiku"}
        try:
            target = float(spec.get("target"))
        except (TypeError, ValueError):
            return {"intent": "unknown", "entries": [], "confidence": 0.0,
                    "question": "What number should the target be?", "parsed_by": "haiku"}

        comparator = spec.get("comparator")
        return {
            "intent": "set_goal",
            "entries": [],
            "goal": {
                "metric": metric,
                "target": target,
                "comparator": comparator if comparator in ("at_least", "at_most") else "at_least",
            },
            "confidence": float(parsed.get("confidence") or 0),
            "question": question,
            "parsed_by": "haiku",
        }

    # --- log ----------------------------------------------------------
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
        offset = clamp_offset(item.get("day_offset"))

        if skill == "activity":
            if item.get("activity_key") not in req.activity_keys:
                dropped += 1
                continue
            kept.append({
                "skill": "activity",
                "activity_key": item.get("activity_key"),
                "duration_min": item.get("duration_min"),
                "distance_km": item.get("distance_km"),
                "level": item.get("level") or "moderate",
                "day_offset": offset,
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
                "meal": clean_meal(item.get("meal")),
                "day_offset": offset,
            })

        else:
            dropped += 1

    if dropped and not question:
        question = f"I could not place {dropped} of those. Say that part again?"

    if intent in ("log", "log_activity"):
        intent = "log" if kept else "unknown"
        if intent == "unknown":
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



SUMMARY_SYSTEM = """You match a spoken question about someone's food and
exercise log to one registered query. You never compute or invent numbers.

Return ONLY a JSON object. No prose, no markdown fences.

{
  "query_id": string,
  "params": object,
  "confidence": number between 0 and 1,
  "question": string or null
}

Registered queries and their params:

today_totals          {}
    Everything for today at a glance.

metric_today          { "metric": <metric> }
    One number for today.

metric_on_day         { "metric": <metric>, "day_offset": integer }
    One number for a past day. day_offset 0 is today, 1 is yesterday.

metric_range_avg      { "metric": <metric>, "days": integer }
    Daily average over the last N days, N between 2 and 90.

metric_week_compare   { "metric": <metric> }
    This week's total against last week's.

foods_on_day          { "day_offset": integer }
    What was eaten on a given day.

activity_count_range  { "activity_key": string or null, "days": integer }
    How many sessions, optionally of one activity, over the last N days.

goal_progress_today   {}
    Today against the targets that are set.

goal_days_met         { "metric": <metric>, "days": integer }
     How many days in the last N met the target for that metric.

range_total           { "metric": <metric>, "days": integer }
    Total, not average, over the last N days.

period_review         { "days": integer }
    Everything worth knowing about the last N days.

Valid <metric> values: kcal_in, protein_g, carb_g, fat_g, fibre_g,
active_min, kcal_out.

Rules:
- Pick exactly one query_id from the list. Never invent one.
- If the question does not fit any of them, set query_id to "unsupported",
  leave params empty, and put a short plain sentence in "question" saying what
  you cannot answer yet.
- "how am I doing" or "how was today" means today_totals.
- "protein" means protein_g. "calories" eaten means kcal_in; calories burned
  means kcal_out. "exercise", "workout time" and "active" mean active_min.
- "this week so far" means metric_week_compare.
- "last month" means days 30. "last week" as a duration means days 7.
- Relative days: yesterday is day_offset 1, "day before yesterday" is 2.
- "how many days did I hit my protein goal" means goal_days_met.
- "review the last 7 days", "how was my week" mean period_review.
- A month means days 30, a week means days 7, a fortnight means days 14.
"""


class SummaryRequest(BaseModel):
    text: str
    activity_keys: list[str]
    previous: dict | None = None


MEAL_SLOTS = {
    "early_snack", "breakfast", "morning_snack", "lunch",
    "afternoon_snack", "dinner", "late_snack",
}

SUMMARY_QUERIES = {
    "today_totals", "metric_today", "metric_on_day", "metric_range_avg",
    "metric_week_compare", "foods_on_day", "activity_count_range",
    "goal_progress_today", "goal_days_met", "range_total", "period_review",
    "unsupported",
}


SUMMARY_METRICS = {
    "kcal_in", "protein_g", "carb_g", "fat_g", "fibre_g", "active_min", "kcal_out",
}


@app.post("/api/summary")
async def classify_summary(req: SummaryRequest) -> dict[str, object]:
    if not ANTHROPIC_API_KEY:
        raise HTTPException(500, "ANTHROPIC_API_KEY is not set")

    context = ""
    if req.previous and req.previous.get("query_id"):
        context = (
            f"Previous query: {req.previous.get('query_id')} "
            f"with params {json.dumps(req.previous.get('params') or {})}\n\n"
        )

    prompt = (
        f"Valid activity_key values: {', '.join(req.activity_keys)}\n\n"
        f"{context}"
        f"Question: {req.text}"
    )

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
                "system": SUMMARY_SYSTEM,
                "messages": [{"role": "user", "content": prompt}],
            },
        )

    if resp.status_code >= 400:
        raise HTTPException(resp.status_code, f"Summary model rejected the request: {resp.text}")

    blocks = resp.json().get("content", [])
    text = "".join(b.get("text", "") for b in blocks if b.get("type") == "text").strip()
    text = text.removeprefix("```json").removeprefix("```").removesuffix("```").strip()

    try:
        parsed = json.loads(text)
    except json.JSONDecodeError:
        return {"query_id": "unsupported", "params": {}, "confidence": 0.0,
                "question": "I did not follow that question."}

    query_id = parsed.get("query_id")
    params = parsed.get("params") or {}
    if not isinstance(params, dict):
        params = {}

    if query_id not in SUMMARY_QUERIES:
        return {"query_id": "unsupported", "params": {}, "confidence": 0.0,
                "question": "I cannot answer that one yet."}

    metric = params.get("metric")
    if metric is not None and metric not in SUMMARY_METRICS:
        return {"query_id": "unsupported", "params": {}, "confidence": 0.0,
                "question": f"I do not track {metric} yet."}

    activity_key = params.get("activity_key")
    if activity_key and activity_key not in req.activity_keys:
        params["activity_key"] = None

    for key, lo, hi in (("days", 2, 90), ("day_offset", 0, 365)):
        if key in params:
            try:
                params[key] = max(lo, min(hi, int(params[key])))
            except (TypeError, ValueError):
                params.pop(key)

    return {
        "query_id": query_id,
        "params": params,
        "confidence": float(parsed.get("confidence") or 0),
        "question": parsed.get("question"),
    }

