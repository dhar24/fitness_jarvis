import { supabase } from "./supabase";

export const MET = {
  strength: 5.0, cardio: 7.0, running: 9.8, walking: 3.5, cycling: 7.5,
  swimming: 8.0, yoga: 3.0, hiit: 10.0, sports: 7.0, housework: 3.0,
};

export const MEALS = [
  ["early_snack", "Early snack"],
  ["breakfast", "Breakfast"],
  ["morning_snack", "Morning snack"],
  ["lunch", "Lunch"],
  ["afternoon_snack", "Afternoon snack"],
  ["dinner", "Dinner"],
  ["late_snack", "Late snack"],
];

export const MEAL_LABEL = Object.fromEntries(MEALS);

let profile = null;

export function clearProfile() {
  profile = null;
}

/** Null means this account has signed up but not been set up yet. */
export async function loadProfile() {
  if (profile) return profile;

  const { data: auth } = await supabase.auth.getUser();
  if (!auth?.user) return null;

  const { data, error } = await supabase
    .from("app_user")
    .select("id, display_name, weight_kg, timezone, role, household_id")
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

/** Day string for "N days ago", which is how every spoken date arrives. */
export function dayFromOffset(offset = 0) {
  const d = new Date();
  d.setDate(d.getDate() - Number(offset || 0));
  return localDay(d);
}

export function dayName(offset = 0) {
  if (offset === 0) return "today";
  if (offset === 1) return "yesterday";
  const d = new Date();
  d.setDate(d.getDate() - offset);
  return d.toLocaleDateString([], { weekday: "long", day: "numeric", month: "short" });
}

export function estimateKcal(activityKey, durationMin, weightKg) {
  const met = MET[activityKey];
  if (!met || !durationMin || !weightKg) return null;
  return Math.round(met * weightKg * (durationMin / 60));
}

const ENTRY_SELECT = `
  id, type, logged_at, local_day, raw_transcript, confidence,
  activity_detail!entry_id(activity_key, duration_min, level, est_kcal),
  food_detail(id, qty, unit, grams, meal, macros, food:food_id(name, verified))
`;

export async function entriesForDay(dayOffset = 0) {
  const { data, error } = await supabase
    .from("log_entry")
    .select(ENTRY_SELECT)
    .eq("local_day", dayFromOffset(dayOffset))
    .is("deleted_at", null)
    .order("logged_at", { ascending: false });

  if (error) throw error;
  return data ?? [];
}

export const todaysLog = () => entriesForDay(0);

/** Soft delete. The row is hidden, the transcript survives. */
export async function deleteEntry(id) {
  const { error } = await supabase
    .from("log_entry")
    .update({ deleted_at: new Date().toISOString() })
    .eq("id", id);

  if (error) throw error;
}

export async function deleteDay({ dayOffset = 0, meal = null, type = null }) {
  const { data, error } = await supabase.rpc("soft_delete_day", {
    p_day: dayFromOffset(dayOffset),
    p_meal: meal,
    p_type: type,
  });

  if (error) throw error;
  return data ?? 0;
}

export async function setMealSlot(detailId, meal) {
  const { error } = await supabase.from("food_detail").update({ meal }).eq("id", detailId);
  if (error) throw error;
}