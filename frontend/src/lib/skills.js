// Skill handlers. Each owns its write path and returns a row the UI can
// render. Registered once at module load.
//
// day_offset comes from what was said, never from the clock, so logging
// yesterday's breakfast at 11pm lands on yesterday.

import { supabase } from "./supabase";
import { registerSkill } from "./router";
import { loadProfile, dayFromOffset, estimateKcal } from "./log";
import { resolveFood, seedFood, toGrams, macrosFor } from "./foods";

async function createEntry(type, envelope, dayOffset = 0) {
  const me = await loadProfile();
  if (!me) throw new Error("Finish setting up your account first.");

  const { data, error } = await supabase
    .from("log_entry")
    .insert({
      user_id: me.id,
      type,
      local_day: dayFromOffset(dayOffset),
      source: "voice",
      raw_transcript: envelope.raw,
      confidence: envelope.confidence,
      parsed_by: envelope.parsed_by,
      client_id: crypto.randomUUID(),
    })
    .select("id, logged_at")
    .single();

  if (error) throw error;
  return { entry: data, me };
}

registerSkill("activity", async (item, envelope) => {
  const { entry, me } = await createEntry("activity", envelope, item.day_offset);

  const { error } = await supabase.from("activity_detail").insert({
    entry_id: entry.id,
    activity_key: item.activity_key,
    duration_min: item.duration_min ?? 1,
    level: item.level ?? "moderate",
    distance_km: item.distance_km ?? null,
    est_kcal: estimateKcal(item.activity_key, item.duration_min, me.weight_kg),
  });

  if (error) throw error;
  return { id: entry.id, skill: "activity" };
});

registerSkill("food", async (item, envelope) => {
  const spoken = (item.name ?? "").trim();
  if (!spoken) throw new Error("No food name");

  const match = await resolveFood(spoken);
  let food = match.food;
  let guessed = false;

  if (!food) {
    food = await seedFood(spoken);
    guessed = true;
  }

  // Portion memory: you always have one katori of dal, so "log dal" means
  // one katori rather than a generic serving.
  const qty = item.qty ?? match.usual?.qty ?? 1;
  const unit = item.unit ?? match.usual?.unit ?? null;

  const grams = await toGrams(food, qty, unit);
  const macros = macrosFor(food, grams);

  const { entry } = await createEntry("food", envelope, item.day_offset);

  const { error } = await supabase.from("food_detail").insert({
    entry_id: entry.id,
    food_id: food.id,
    // 'unset' rather than a guess. The meal is asked for, never inferred
    // from the clock, because a wrong slot is invisible and permanent.
    meal: item.meal ?? "unset",
    qty,
    unit: unit ?? "serving",
    grams,
    macros,
  });

  if (error) throw error;

  return {
    id: entry.id,
    skill: "food",
    guessed,
    tier: match.tier ?? null,
    name: food.name,
    spoken,
  };
});
