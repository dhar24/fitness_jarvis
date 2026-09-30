// The query registry.
//
// The model picks one of these and fills its parameters. Postgres computes
// every number. Nothing here asks a model for a figure, which is the whole
// reason summaries can be trusted.
//
// Metrics read from daily_rollup, which the database keeps current on every
// write, so a summary is a primary-key lookup rather than an aggregation.
import { METRIC_LABEL as GOAL_LABEL } from "./goals";
import { supabase } from "./supabase";
import { localDay } from "./log";
import { ACTIVITY_LABELS } from "./parser";

const METRIC_LABEL = {
  kcal_in: "kcal eaten",
  kcal_out: "kcal burned",
  protein_g: "g protein",
  carb_g: "g carbs",
  fat_g: "g fat",
  fibre_g: "g fibre",
  active_min: "min active",
};

const MACRO_KEYS = new Set(["protein_g", "carb_g", "fat_g", "fibre_g"]);

function dayString(offset = 0) {
  const d = new Date();
  d.setDate(d.getDate() - offset);
  return localDay(d);
}

function dayName(offset) {
  if (offset === 0) return "today";
  if (offset === 1) return "yesterday";
  const d = new Date();
  d.setDate(d.getDate() - offset);
  return d.toLocaleDateString([], { weekday: "long", day: "numeric", month: "short" });
}

function round(n) {
  return n == null ? 0 : Math.round(Number(n));
}

function valueOf(row, metric) {
  if (!row) return 0;
  if (MACRO_KEYS.has(metric)) return Number(row.macros?.[metric] ?? 0);
  return Number(row[metric] ?? 0);
}

async function rollups(fromDay, toDay) {
  const { data, error } = await supabase
    .from("daily_rollup")
    .select("day, active_min, kcal_in, kcal_out, macros, entry_count")
    .gte("day", fromDay)
    .lte("day", toDay)
    .order("day");

  if (error) throw error;
  return data ?? [];
}

export const QUERIES = {
  today_totals: {
    async run() {
      const rows = await rollups(dayString(0), dayString(0));
      return rows[0] ?? null;
    },
    format(row) {
      if (!row || !row.entry_count) {
        return { value: "Nothing yet", label: "logged today", detail: null };
      }
      return {
        value: round(row.kcal_in),
        unit: "kcal",
        label: "eaten today",
        detail: [
          `${round(row.macros?.protein_g)}g protein`,
          `${round(row.active_min)} min active`,
          `${round(row.kcal_out)} kcal burned`,
        ].join("   "),
      };
    },
  },

  metric_today: {
    async run({ metric }) {
      const rows = await rollups(dayString(0), dayString(0));
      return { metric, value: valueOf(rows[0], metric) };
    },
    format({ metric, value }) {
      return { value: round(value), label: `${METRIC_LABEL[metric]} today`, detail: null };
    },
  },

  metric_on_day: {
    async run({ metric, day_offset = 1 }) {
      const day = dayString(day_offset);
      const rows = await rollups(day, day);
      return { metric, day_offset, value: valueOf(rows[0], metric), empty: !rows.length };
    },
    format({ metric, day_offset, value, empty }) {
      if (empty) {
        return { value: "Nothing", label: `logged ${dayName(day_offset)}`, detail: null };
      }
      return { value: round(value), label: `${METRIC_LABEL[metric]} ${dayName(day_offset)}`, detail: null };
    },
  },

  metric_range_avg: {
    async run({ metric, days = 7 }) {
      const rows = await rollups(dayString(days - 1), dayString(0));
      const total = rows.reduce((n, r) => n + valueOf(r, metric), 0);
      const best = rows.reduce(
        (acc, r) => (valueOf(r, metric) > valueOf(acc, metric) ? r : acc),
        rows[0] ?? null
      );
      return { metric, days, logged: rows.length, avg: rows.length ? total / days : 0, best };
    },
    format({ metric, days, logged, avg, best }) {
      if (!logged) {
        return { value: "No data", label: `for the last ${days} days`, detail: null };
      }
      const detail = [`${logged} of ${days} days logged`];
      if (best) {
        detail.push(`best ${round(valueOf(best, metric))} on ${new Date(best.day).toLocaleDateString([], { day: "numeric", month: "short" })}`);
      }
      return {
        value: round(avg),
        label: `${METRIC_LABEL[metric]} a day, last ${days} days`,
        detail: detail.join("   "),
      };
    },
  },

  metric_week_compare: {
    async run({ metric }) {
      const rows = await rollups(dayString(13), dayString(0));
      const cutoff = dayString(6);
      let thisWeek = 0;
      let lastWeek = 0;
      for (const row of rows) {
        if (row.day >= cutoff) thisWeek += valueOf(row, metric);
        else lastWeek += valueOf(row, metric);
      }
      return { metric, thisWeek, lastWeek };
    },
    format({ metric, thisWeek, lastWeek }) {
      const diff = thisWeek - lastWeek;
      const direction = diff === 0 ? "level with" : diff > 0 ? "up on" : "down on";
      return {
        value: round(thisWeek),
        label: `${METRIC_LABEL[metric]} this week`,
        detail: lastWeek
          ? `${direction} last week by ${round(Math.abs(diff))}`
          : "nothing logged last week to compare",
      };
    },
  },

  foods_on_day: {
    async run({ day_offset = 0 }) {
      const day = dayString(day_offset);
      const { data, error } = await supabase
        .from("log_entry")
        .select("id, logged_at, food_detail(qty, unit, grams, macros, food:food_id(name))")
        .eq("local_day", day)
        .eq("type", "food")
        .order("logged_at");

      if (error) throw error;

      const items = [];
      let kcal = 0;
      for (const entry of data ?? []) {
        const detail = Array.isArray(entry.food_detail) ? entry.food_detail[0] : entry.food_detail;
        if (!detail) continue;
        kcal += Number(detail.macros?.kcal ?? 0);
        items.push(`${detail.qty ?? 1} ${detail.unit ?? "serving"} ${detail.food?.name ?? "food"}`);
      }
      return { day_offset, items, kcal };
    },
    format({ day_offset, items, kcal }) {
      if (!items.length) {
        return { value: "Nothing", label: `eaten ${dayName(day_offset)}`, detail: null };
      }
      return {
        value: items.length,
        unit: items.length === 1 ? "thing" : "things",
        label: `eaten ${dayName(day_offset)}, ${round(kcal)} kcal`,
        detail: items.join("   "),
      };
    },
  },

  activity_count_range: {
    async run({ activity_key = null, days = 30 }) {
      let query = supabase
        .from("log_entry")
        .select("id, local_day, activity_detail!entry_id(activity_key, duration_min)")
        .eq("type", "activity")
        .gte("local_day", dayString(days - 1))
        .lte("local_day", dayString(0));

      const { data, error } = await query;
      if (error) throw error;

      let count = 0;
      let minutes = 0;
      const days_seen = new Set();

      for (const entry of data ?? []) {
        const d = Array.isArray(entry.activity_detail) ? entry.activity_detail[0] : entry.activity_detail;
        if (!d) continue;
        if (activity_key && d.activity_key !== activity_key) continue;
        count += 1;
        minutes += Number(d.duration_min ?? 0);
        days_seen.add(entry.local_day);
      }

      return { activity_key, days, count, minutes, activeDays: days_seen.size };
    },
    format({ activity_key, days, count, minutes, activeDays }) {
      const what = activity_key ? (ACTIVITY_LABELS[activity_key] ?? activity_key).toLowerCase() : "sessions";
      if (!count) {
        return { value: "None", label: `${what} in the last ${days} days`, detail: null };
      }
      return {
        value: count,
        unit: count === 1 ? "session" : "sessions",
        label: `of ${what}, last ${days} days`,
        detail: `${minutes} minutes across ${activeDays} ${activeDays === 1 ? "day" : "days"}`,
      };
    },
  },

  goal_progress_today: {
    async run() {
      const { data, error } = await supabase
        .from("daily_progress")
        .select("metric, comparator, target_value, actual_value")
        .eq("day", dayString(0));

      if (error) throw error;
      return { rows: data ?? [] };
    },
    format({ rows }) {
      if (!rows.length) {
        return { value: "No targets", label: "set yet", detail: "Say what you want to aim for and I can store it." };
      }
      const met = rows.filter((r) =>
        r.comparator === "at_most"
          ? Number(r.actual_value ?? 0) <= Number(r.target_value)
          : Number(r.actual_value ?? 0) >= Number(r.target_value)
      );
      return {
        value: `${met.length}/${rows.length}`,
        label: "targets met today",
        detail: rows
          .map((r) => `${METRIC_LABEL[r.metric] ?? r.metric} ${round(r.actual_value)} of ${round(r.target_value)}`)
          .join("   "),
      };
    },
  },

  goal_days_met: {
    async run({ metric, days = 30 }) {
      const { data, error } = await supabase.rpc("goal_days_met", {
        p_metric: metric,
        p_from: dayString(days - 1),
        p_to: dayString(0),
      });

      if (error) throw error;
      const row = (data ?? [])[0] ?? {};
      return { metric, days, ...row };
    },
    format({ metric, days, days_met, days_with_data, target }) {
      const name = GOAL_LABEL[metric] ?? METRIC_LABEL[metric] ?? metric;
      if (target == null) {
        return {
          value: "No target",
          label: `set for ${name.toLowerCase()}`,
          say: `You have not set a ${name.toLowerCase()} target yet.`,
          detail: "Say: set my protein target to 150.",
        };
      }
      return {
        value: `${days_met ?? 0}/${days ?? 0}`,
        label: `days hit your ${name.toLowerCase()} target`,
        say: `${days_met ?? 0} of ${days} days hit your ${name.toLowerCase()} target.`,
        detail: `Target ${round(target)}. ${days_with_data ?? 0} of ${days} days have any data.`,
      };
    },
  },

  range_total: {
    async run({ metric, days = 7 }) {
      const rows = await rollups(dayString(days - 1), dayString(0));
      const total = rows.reduce((n, r) => n + valueOf(r, metric), 0);
      return { metric, days, total, logged: rows.length };
    },
    format({ metric, days, total, logged }) {
      return {
        value: round(total),
        label: `${METRIC_LABEL[metric]} over ${days} days`,
        detail: logged ? `${logged} of ${days} days logged` : "nothing logged in that window",
      };
    },
  },

  period_review: {
    async run({ days = 7 }) {
      const rows = await rollups(dayString(days - 1), dayString(0));
      const logged = rows.filter((r) => (r.entry_count ?? 0) > 0);
      const sum = (fn) => rows.reduce((n, r) => n + fn(r), 0);

      return {
        days,
        logged: logged.length,
        kcal: sum((r) => Number(r.kcal_in ?? 0)),
        protein: sum((r) => Number(r.macros?.protein_g ?? 0)),
        fibre: sum((r) => Number(r.macros?.fibre_g ?? 0)),
        active: sum((r) => Number(r.active_min ?? 0)),
      };
    },
    format({ days, logged, kcal, protein, fibre, active }) {
      if (!logged) {
        return {
          value: "Nothing",
          label: `logged in the last ${days} days`,
          say: `Nothing logged in the last ${days} days.`,
          detail: null,
        };
      }

      const perDay = (n) => round(n / logged);
      return {
        value: logged,
        unit: logged === 1 ? "day" : "days",
        label: `logged out of ${days}`,
        say:
          `${logged} of ${days} days logged. ` +
          `On a logged day, about ${perDay(kcal)} calories, ` +
          `${perDay(protein)} grams of protein, and ${perDay(active)} active minutes.`,
        detail: [
          `${perDay(kcal)} kcal a day`,
          `${perDay(protein)}g protein`,
          `${perDay(fibre)}g fibre`,
          `${perDay(active)} min active`,
        ].join("   "),
      };
    },
  },


};

export function isSupported(queryId) {
  return Object.prototype.hasOwnProperty.call(QUERIES, queryId);
}