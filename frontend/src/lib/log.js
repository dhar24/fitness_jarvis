// Write path. Optimistic by design: the caller renders the entry immediately
// and this syncs underneath. client_id makes retries idempotent.

import { supabase } from "./supabase";



let profile = null;

export async function loadProfile() {
 if (profile) return profile;

 const { data: auth } = await supabase.auth.getUser();
 if (!auth?.user) return null;

 const { data, error } = await supabase
 .from("app_user")
 .select("id, display_name, weight_kg, timezone")
 .eq("id", auth.user.id)
 .maybeSingle();

 if (error) throw error;
 profile = data;
 return profile;
}

export function localDay(date = new Date()) {
 const offset = date.getTimezoneOffset() * 60000;
 return new Date(date.getTime() - offset).toISOString().slice(0, 10);
}


export async function writeActivity(envelope) {
 const me = await loadProfile();
 if (!me) throw new Error("No profile row. Run the bootstrap SQL first.");

 const { activity_key, duration_min, level, distance_km } = envelope.slots;
 const clientId = crypto.randomUUID();

 const { data: entry, error: entryError } = await supabase
 .from("log_entry")
 .insert({
 user_id: me.id,
 type: "activity",
 local_day: localDay(),
 source: "voice",
 raw_transcript: envelope.raw,
 confidence: envelope.confidence,
 parsed_by: envelope.parsed_by,
 client_id: clientId,
 })
 .select("id, logged_at")
 .single();

 if (entryError) throw entryError;

 const { error: detailError } = await supabase.from("activity_detail").insert({
 entry_id: entry.id,
 activity_key,
 duration_min: duration_min ?? 1,
 level: level ?? "moderate",
 distance_km: distance_km ?? null,
 est_kcal: estimateKcal(activity_key, duration_min, me.weight_kg),
 });

 if (detailError) throw detailError;

 return { id: entry.id, logged_at: entry.logged_at };
}

export async function todaysEntries() {
 const { data, error } = await supabase
 .from("log_entry")
 .select("id, logged_at, raw_transcript, confidence, activity_detail!entry_id(activity_key, duration_min, level, est_kcal)")
 .eq("local_day", localDay())
 .order("logged_at", { ascending: false });

 if (error) throw error;
 return data ?? [];
}

export async function deleteEntry(id) {
 const { error } = await supabase.from("log_entry").delete().eq("id", id);
 if (error) throw error;
}


export async function writeActivities(envelope) {
  const me = await loadProfile();
  if (!me) throw new Error("No profile row. Run the bootstrap SQL first.");

  const written = [];

  for (const item of envelope.entries) {
    const { data: entry, error: entryError } = await supabase
      .from("log_entry")
      .insert({
        user_id: me.id,
        type: "activity",
        local_day: localDay(),
        source: "voice",
        raw_transcript: envelope.raw,
        confidence: envelope.confidence,
        parsed_by: envelope.parsed_by,
        client_id: crypto.randomUUID(),
      })
      .select("id, logged_at")
      .single();

    if (entryError) throw entryError;

    const { error: detailError } = await supabase.from("activity_detail").insert({
      entry_id: entry.id,
      activity_key: item.activity_key,
      duration_min: item.duration_min ?? 1,
      level: item.level ?? "moderate",
      distance_km: item.distance_km ?? null,
      est_kcal: estimateKcal(item.activity_key, item.duration_min, me.weight_kg),
    });

    if (detailError) throw detailError;

    written.push(entry.id);
  }

  return written;
}


export const MET = {
  strength: 5.0, cardio: 7.0, running: 9.8, walking: 3.5, cycling: 7.5,
  swimming: 8.0, yoga: 3.0, hiit: 10.0, sports: 7.0, housework: 3.0,
};

export function estimateKcal(activityKey, durationMin, weightKg) {
  const met = MET[activityKey];
  if (!met || !durationMin || !weightKg) return null;
  return Math.round(met * weightKg * (durationMin / 60));
}

export async function todaysLog() {
  const { data, error } = await supabase
    .from("log_entry")
    .select(`
      id, type, logged_at, raw_transcript, confidence,
      activity_detail!entry_id(activity_key, duration_min, level, est_kcal),
      food_detail(id, qty, unit, grams, meal, macros, food:food_id(name, verified))
    `)
    .eq("local_day", localDay())
    .order("logged_at", { ascending: false });

  if (error) throw error;
  return data ?? [];
}
