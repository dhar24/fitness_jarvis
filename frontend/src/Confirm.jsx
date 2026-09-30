import { useEffect, useState } from "react";
import { MEALS, MEAL_LABEL, dayName, entriesForDay } from "./lib/log";

// Shown before writing, for anything that cannot be checked at a glance:
// three or more entries, a past day, or a food with no meal stated.
//
// It also lists what is already logged on that day, because the realistic
// failure of a nightly recap is logging the same meal twice.

export default function Confirm({ plan, onCancel, onCommit }) {
  const [rows, setRows] = useState(plan.entries);
  const [existing, setExisting] = useState(null);
  const [busy, setBusy] = useState(false);

  const dayOffset = plan.entries[0]?.day_offset ?? 0;
  const past = dayOffset > 0;

  useEffect(() => {
    if (!past) return;
    entriesForDay(dayOffset)
      .then(setExisting)
      .catch(() => setExisting([]));
  }, [past, dayOffset]);

  function setMeal(index, meal) {
    setRows((prev) => prev.map((r, i) => (i === index ? { ...r, meal } : r)));
  }

  function drop(index) {
    setRows((prev) => prev.filter((_, i) => i !== index));
  }

  const missingMeal = rows.some((r) => r.skill === "food" && !r.meal);

  return (
    <div className="sheet" role="dialog" aria-label="Confirm before logging">
      <div className="sheet__panel">
        <div className="row row--between">
          <strong>{`Logging ${dayName(dayOffset)}`}</strong>
          <button className="linkish" onClick={onCancel}>
            Cancel
          </button>
        </div>

        {plan.raw && <p className="sheet__heard">You said: {plan.raw}</p>}

        {past && existing?.length > 0 && (
          <div className="already">
            <p className="already__title">Already logged {dayName(dayOffset)}</p>
            {existing.map((e) => {
              const fd = Array.isArray(e.food_detail) ? e.food_detail[0] : e.food_detail;
              const ad = Array.isArray(e.activity_detail) ? e.activity_detail[0] : e.activity_detail;
              return (
                <p className="already__row" key={e.id}>
                  {fd
                    ? `${fd.food?.name ?? "food"}${fd.meal && fd.meal !== "unset" ? `, ${MEAL_LABEL[fd.meal]}` : ""}`
                    : ad?.activity_key ?? "entry"}
                </p>
              );
            })}
          </div>
        )}

        <ul className="plan">
          {rows.map((row, i) => (
            <li className="plan__row" key={`${row.skill}-${i}`}>
              <div className="plan__head">
                <span className="plan__name">
                  {row.skill === "food"
                    ? `${row.qty ?? ""} ${row.unit ?? ""} ${row.name}`.replace(/\s+/g, " ").trim()
                    : `${row.activity_key}${row.duration_min ? `, ${row.duration_min} min` : ""}`}
                </span>
                <button className="linkish" onClick={() => drop(i)}>
                  Remove
                </button>
              </div>

              {row.skill === "food" && (
                <div className="chips">
                  {MEALS.map(([key, label]) => (
                    <button
                      key={key}
                      className={row.meal === key ? "pill pill--on" : "pill"}
                      onClick={() => setMeal(i, key)}
                    >
                      {label}
                    </button>
                  ))}
                </div>
              )}
            </li>
          ))}
        </ul>

        {missingMeal && <p className="sheet__hint">Pick a meal for each food, or log it and set it later.</p>}

        <div className="row">
          <button
            className="btn"
            disabled={busy || !rows.length}
            onClick={() => {
              setBusy(true);
              onCommit(rows);
            }}
          >
            {`Log ${rows.length} ${rows.length === 1 ? "entry" : "entries"}`}
          </button>
        </div>
      </div>
    </div>
  );
}