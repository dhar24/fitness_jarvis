import { useEffect, useState } from "react";
import { entriesForDay, dayName, MEAL_LABEL } from "./lib/log";

// A voice delete acts on rows you cannot see, so it has to show them first.
// Undo on a visible row needs no confirmation; this does.

export default function ConfirmDelete({ spec, onCancel, onConfirm }) {
  const [rows, setRows] = useState(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    entriesForDay(spec.day_offset)
      .then((all) =>
        all.filter((e) => {
          if (spec.type && e.type !== spec.type) return false;
          if (!spec.meal) return true;
          const fd = Array.isArray(e.food_detail) ? e.food_detail[0] : e.food_detail;
          return fd?.meal === spec.meal;
        })
      )
      .then(setRows)
      .catch(() => setRows([]));
  }, [spec]);

  const scope = [
    spec.meal ? MEAL_LABEL[spec.meal] : null,
    spec.type === "food" ? "food" : spec.type === "activity" ? "activity" : null,
  ]
    .filter(Boolean)
    .join(" ");

  return (
    <div className="sheet" role="dialog" aria-label="Confirm delete">
      <div className="sheet__panel">
        <div className="row row--between">
          <strong>{`Delete ${scope || "everything"} from ${dayName(spec.day_offset)}?`}</strong>
          <button className="linkish" onClick={onCancel}>
            Cancel
          </button>
        </div>

        {rows === null ? (
          <p className="sheet__hint">Checking what is there.</p>
        ) : rows.length === 0 ? (
          <>
            <p className="sheet__hint">Nothing matches, so there is nothing to delete.</p>
            <button className="btn btn--quiet" onClick={onCancel}>
              Close
            </button>
          </>
        ) : (
          <>
            <ul className="plan">
              {rows.map((e) => {
                const fd = Array.isArray(e.food_detail) ? e.food_detail[0] : e.food_detail;
                const ad = Array.isArray(e.activity_detail) ? e.activity_detail[0] : e.activity_detail;
                return (
                  <li className="plan__row" key={e.id}>
                    <span className="plan__name">
                      {fd
                        ? `${fd.qty ?? 1} ${fd.unit ?? ""} ${fd.food?.name ?? "food"}`.replace(/\s+/g, " ")
                        : `${ad?.activity_key ?? "entry"}${ad?.duration_min ? `, ${ad.duration_min} min` : ""}`}
                    </span>
                  </li>
                );
              })}
            </ul>

            <p className="sheet__hint">
              {`${rows.length} ${rows.length === 1 ? "entry" : "entries"}. Hidden, not destroyed, so this can be undone in the database.`}
            </p>

            <div className="row">
              <button
                className="btn"
                disabled={busy}
                onClick={() => {
                  setBusy(true);
                  onConfirm();
                }}
              >
                Yes, delete
              </button>
              <button className="linkish" onClick={onCancel}>
                Keep them
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
