// Resolves a spoken food into a real row, then grams, then macros.
//
// This app shows no result list, so whatever ranks first IS the answer.
// search_food returns a tier alongside the text score: tier 1 is your own
// foods and bindings, tier 2 is anything you have logged before. Those beat
// reference data outright, regardless of how well the text matches.
//
// The model never picks a food id and never supplies nutrition for something
// already in the table. It only reports what was said.

import { supabase } from "./supabase";

const API_BASE = import.meta.env.VITE_API_BASE ?? "http://localhost:8000";

// Reference data needs a decent text match. Personal rows do not, because
// being yours is already strong evidence.
const REFERENCE_THRESHOLD = 0.55;
const PERSONAL_THRESHOLD = 0.4;

const portionCache = new Map();

async function portions() {
  if (portionCache.size) return portionCache;

  const { data } = await supabase.from("portion_unit").select("food_id, unit, grams");
  for (const row of data ?? []) {
    portionCache.set(`${row.food_id ?? "global"}:${row.unit}`, Number(row.grams));
  }
  return portionCache;
}

/**
 * Returns { food, tier, score, alternatives, usual } or { food: null }.
 * `usual` carries remembered portion, so "log dal" can mean your katori.
 */
export async function resolveFood(spoken) {
  const q = spoken.toLowerCase().trim();
  if (!q) return { food: null, alternatives: [] };

  const { data, error } = await supabase.rpc("search_food", { q, limit_n: 5 });
  if (error) throw error;

  const results = data ?? [];
  const best = results[0];
  if (!best) return { food: null, alternatives: [] };

  const threshold = best.tier <= 2 ? PERSONAL_THRESHOLD : REFERENCE_THRESHOLD;
  if (best.score < threshold) return { food: null, alternatives: results };

  return {
    food: best,
    tier: best.tier,
    score: best.score,
    usual: { qty: best.usual_qty, unit: best.usual_unit },
    alternatives: results.slice(1),
  };
}

/**
 * Nothing matched at all. Ask the model for an estimate and keep it.
 * Deliberately narrow: only when there is no plausible candidate, because a
 * confident wrong number that looks official is worse than an interruption.
 */
export async function seedFood(spoken) {
  const resp = await fetch(`${API_BASE}/api/food/estimate`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name: spoken }),
  });

  if (!resp.ok) throw new Error(`Could not work out what "${spoken}" is`);
  const estimate = await resp.json();

  const { data: auth } = await supabase.auth.getUser();

  const { data, error } = await supabase
    .from("food")
    .insert({
      name: estimate.name || spoken,
      aliases: [spoken.toLowerCase()],
      is_dish: true,
      source: "llm_seed",
      verified: false,
      owner_user_id: auth?.user?.id ?? null,
      per_100g: estimate.per_100g ?? {},
      serving_g: estimate.serving_g ?? null,
    })
    .select("id, name, per_100g, serving_g, verified")
    .single();

  if (error) throw error;
  return data;
}

/**
 * A food you define yourself, with your own numbers. Macros are entered per
 * your unit, not per 100g, because nobody knows their protein powder per 100g.
 */
export async function createMyFood({ name, aliases = [], unit, unitGrams, macrosPerUnit }) {
  const { data: auth } = await supabase.auth.getUser();
  if (!auth?.user) throw new Error("Not signed in");

  const grams = Number(unitGrams);
  if (!grams || grams <= 0) throw new Error("Unit weight must be more than zero");

  // Stored per 100g so everything downstream stays uniform.
  const per100 = {};
  for (const [key, value] of Object.entries(macrosPerUnit ?? {})) {
    const n = Number(value);
    if (!Number.isNaN(n) && value !== "" && value !== null) {
      per100[key] = Math.round((n * 100 / grams) * 100) / 100;
    }
  }

  const alias = [name, ...aliases].map((a) => a.toLowerCase().trim()).filter(Boolean);

  const { data: food, error } = await supabase
    .from("food")
    .insert({
      name: name.trim(),
      aliases: [...new Set(alias)],
      is_dish: true,
      source: "user",
      verified: true,
      owner_user_id: auth.user.id,
      per_100g: per100,
      serving_g: grams,
    })
    .select("id, name, per_100g, serving_g, verified")
    .single();

  if (error) throw error;

  if (unit) {
    await supabase.from("portion_unit").insert({ food_id: food.id, unit: unit.toLowerCase().trim(), grams });
    portionCache.clear();
  }

  await supabase.from("food_affinity").upsert({
    user_id: auth.user.id,
    food_id: food.id,
    hits: 1,
    pinned: true,
    usual_qty: 1,
    usual_unit: unit ? unit.toLowerCase().trim() : null,
  });

  return food;
}

/** Quantity plus unit to grams. Food specific portions beat global ones. */
export async function toGrams(food, qty, unit) {
  const amount = qty ?? 1;
  const table = await portions();

  if (unit) {
    const u = String(unit).toLowerCase().trim();
    const specific = table.get(`${food.id}:${u}`);
    if (specific) return Math.round(amount * specific * 10) / 10;

    const shared = table.get(`global:${u}`);
    if (shared) return Math.round(amount * shared * 10) / 10;

    if (["g", "gram", "grams", "ml"].includes(u)) return amount;
  }

  if (food.serving_g) return Math.round(amount * Number(food.serving_g) * 10) / 10;
  return amount * 100;
}

export function macrosFor(food, grams) {
  const per100 = food.per_100g ?? {};
  const factor = grams / 100;
  const out = {};

  for (const [key, value] of Object.entries(per100)) {
    const n = Number(value);
    if (!Number.isNaN(n)) out[key] = Math.round(n * factor * 10) / 10;
  }
  return out;
}

/** Fix a wrong match. Writes the binding so it never recurs. */
export async function correctEntry({ detailId, food, spoken, qty, unit }) {
  const grams = await toGrams(food, qty, unit);
  const macros = macrosFor(food, grams);

  const { error } = await supabase.rpc("correct_food_entry", {
    p_detail_id: detailId,
    p_food_id: food.id,
    p_spoken: spoken ?? null,
    p_qty: qty ?? null,
    p_unit: unit ?? null,
    p_grams: grams,
    p_macros: macros,
  });

  if (error) throw error;
}

export async function searchFoods(q) {
  if (!q || q.trim().length < 2) return [];
  const { data, error } = await supabase.rpc("search_food", { q: q.trim(), limit_n: 8 });
  if (error) throw error;
  return data ?? [];
}

export async function myFoods() {
  const { data: auth } = await supabase.auth.getUser();
  const { data, error } = await supabase
    .from("food")
    .select("id, name, aliases, per_100g, serving_g, source, verified")
    .eq("owner_user_id", auth?.user?.id)
    .order("name");

  if (error) throw error;
  return data ?? [];
}
