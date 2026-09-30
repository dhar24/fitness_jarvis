import { supabase } from "./supabase";

export const METRICS = [
  ["kcal_in", "Calories eaten", "kcal", "at_most"],
  ["protein_g", "Protein", "g", "at_least"],
  ["fibre_g", "Fibre", "g", "at_least"],
  ["active_min", "Active time", "min", "at_least"],
  ["kcal_out", "Calories burned", "kcal", "at_least"],
];

export const METRIC_LABEL = Object.fromEntries(METRICS.map(([k, l]) => [k, l]));
export const METRIC_UNIT = Object.fromEntries(METRICS.map(([k, , u]) => [k, u]));
export const METRIC_DEFAULT_COMPARATOR = Object.fromEntries(
  METRICS.map(([k, , , c]) => [k, c])
);

export async function setGoal(metric, target, comparator) {
  const { error } = await supabase.rpc("set_goal", {
    p_metric: metric,
    p_target: Number(target),
    p_comparator: comparator ?? METRIC_DEFAULT_COMPARATOR[metric] ?? "at_least",
  });

  if (error) throw error;
}

export async function activeGoals() {
  const { data, error } = await supabase
    .from("goal_target")
    .select("id, metric, comparator, target_value, effective_from")
    .is("effective_to", null)
    .order("metric");

  if (error) throw error;
  return data ?? [];
}

export async function clearGoal(metric) {
  const { data: auth } = await supabase.auth.getUser();
  const { error } = await supabase
    .from("goal_target")
    .update({ effective_to: new Date().toISOString().slice(0, 10) })
    .eq("user_id", auth?.user?.id)
    .eq("metric", metric)
    .is("effective_to", null);

  if (error) throw error;
}