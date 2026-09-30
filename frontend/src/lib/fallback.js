// Called when the grammar cannot resolve an utterance. Roughly half a second
// slower, which is fine because it only fires on phrasings the grammar does
// not already know. Returns a LIST of entries, each tagged with its skill,
// because one sentence can mix a workout and a meal.

import { ACTIVITY_KEYS } from "./parser";

// const API_BASE = import.meta.env.VITE_API_BASE ?? "";
import { API_BASE } from "./api";

export async function parseWithModel(raw) {
  const resp = await fetch(`${API_BASE}/api/parse`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text: raw, activity_keys: ACTIVITY_KEYS }),
  });

  if (!resp.ok) throw new Error(`Parse failed (${resp.status})`);

  const data = await resp.json();
  const confidence = data.confidence ?? 0;

  return {
    intent: data.intent ?? "unknown",
    entries: data.entries ?? [],
    confidence,
    parsed_by: "haiku",
    needs_confirmation: confidence < 0.8,
    question: data.question ?? null,
    raw,
  };
}

export async function logParseFailure(supabase, userId, transcript, stage, detail) {
  try {
    await supabase.from("parse_failure").insert({
      user_id: userId,
      transcript,
      stage,
      detail: detail ?? null,
    });
  } catch {
    // Never let telemetry break a log.
  }
}
