// Answering a question is two steps that never blur into one.
//
// 1. The model reads the question and picks a registered query. That is
//    classification, which models do reliably.
// 2. Postgres computes the answer and a template writes the sentence.
//
// Text to SQL would collapse these into one step and be quietly wrong some
// of the time, which is worse than saying "I cannot answer that yet".
//
// The last resolved query is kept so that a follow-up works: ask "how much
// protein today", then "and yesterday", and only the changed part moves.

import { API_BASE } from "./api";
import { ACTIVITY_KEYS } from "./parser";
import { QUERIES, isSupported } from "./queries";
import { supabase } from "./supabase";

let previous = null;

export function clearContext() {
  previous = null;
}

export async function answerQuestion(text) {
  const resp = await fetch(`${API_BASE}/api/summary`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      text,
      activity_keys: ACTIVITY_KEYS,
      previous,
    }),
  });

  if (!resp.ok) throw new Error(`Could not read that question (${resp.status})`);

  const { query_id, params, question } = await resp.json();

  if (!isSupported(query_id)) {
    await recordMiss(text, query_id);
    return {
      unsupported: true,
      value: "Not yet",
      label: question ?? "I cannot answer that one",
      say: question ?? "I cannot answer that one yet.",
      detail: null,
    };
  }

  previous = { query_id, params: params ?? {} };

  const query = QUERIES[query_id];
  const data = await query.run(params ?? {});
  return { queryId: query_id, ...query.format(data) };
}

/** Questions the registry could not match. This list is what to build next. */
async function recordMiss(text, queryId) {
  try {
    const { data: auth } = await supabase.auth.getUser();
    await supabase.from("query_miss").insert({
      user_id: auth?.user?.id ?? null,
      transcript: text,
      candidates: { query_id: queryId ?? null },
    });
  } catch {
    // Telemetry must never break an answer.
  }
}
