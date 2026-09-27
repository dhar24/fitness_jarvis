import { useEffect, useState } from "react";
import { searchFoods, correctEntry, createMyFood } from "./foods";

const TIER_LABEL = { 1: "yours", 2: "used before", 3: "household", 4: "reference", 5: "estimated" };

/**
 * Tapping a logged food opens this. Two jobs: pick the right food, or define
 * your own. Either way the correction writes a binding, so the same mistake
 * does not happen twice.
 */
export default function FoodFix({ entry, onClose, onDone }) {
  const detail = Array.isArray(entry.food_detail) ? entry.food_detail[0] : entry.food_detail;
  const spoken = entry.raw_transcript ?? detail?.food?.name ?? "";

  const [query, setQuery] = useState(detail?.food?.name ?? "");
  const [results, setResults] = useState([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [mode, setMode] = useState("pick");

  const [form, setForm] = useState({
    name: detail?.food?.name ?? "",
    unit: detail?.unit ?? "serving",
    unitGrams: "",
    kcal: "", protein_g: "", carb_g: "", fat_g: "", fibre_g: "",
  });

  useEffect(() => {
    let live = true;
    const id = setTimeout(async () => {
      try {
        const rows = await searchFoods(query);
        if (live) setResults(rows);
      } catch (err) {
        if (live) setError(err.message);
      }
    }, 200);
    return () => {
      live = false;
      clearTimeout(id);
    };
  }, [query]);

  async function choose(food) {
    setBusy(true);
    setError(null);
    try {
      await correctEntry({
        detailId: detail.id,
        food,
        spoken,
        qty: detail?.qty,
        unit: detail?.unit,
      });
      onDone();
    } catch (err) {
      setError(err.message);
      setBusy(false);
    }
  }

  async function create() {
    if (!form.name.trim() || !form.unitGrams) {
      setError("Name and unit weight are both needed.");
      return;
    }

    setBusy(true);
    setError(null);
    try {
      const food = await createMyFood({
        name: form.name,
        aliases: spoken && spoken !== form.name ? [spoken] : [],
        unit: form.unit,
        unitGrams: form.unitGrams,
        macrosPerUnit: {
          kcal: form.kcal, protein_g: form.protein_g,
          carb_g: form.carb_g, fat_g: form.fat_g, fibre_g: form.fibre_g,
        },
      });
      await correctEntry({ detailId: detail.id, food, spoken, qty: 1, unit: form.unit });
      onDone();
    } catch (err) {
      setError(err.message);
      setBusy(false);
    }
  }

  function field(key, label, suffix) {
    return (
      <label className="mini">
        <span>{label}</span>
        <input
          className="field field--mini"
          inputMode="decimal"
          value={form[key]}
          onChange={(e) => setForm({ ...form, [key]: e.target.value })}
        />
        {suffix && <em>{suffix}</em>}
      </label>
    );
  }

  return (
    <div className="sheet" role="dialog" aria-label="Fix this food">
      <div className="sheet__panel">
        <div className="row row--between">
          <strong>{mode === "pick" ? "Which one was it?" : "Define your own"}</strong>
          <button className="linkish" onClick={onClose}>Close</button>
        </div>

        {spoken && <p className="sheet__heard">You said: {spoken}</p>}

        {mode === "pick" ? (
          <>
            <input
              className="field"
              autoFocus
              placeholder="Search foods"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />

            <ul className="picker">
              {results.map((food) => (
                <li key={food.id}>
                  <button className="picker__row" disabled={busy} onClick={() => choose(food)}>
                    <span className="picker__name">{food.name}</span>
                    <span className={`chip chip--t${food.tier}`}>{TIER_LABEL[food.tier]}</span>
                  </button>
                </li>
              ))}
              {!results.length && query.length > 1 && (
                <li className="picker__empty">Nothing close. Define it yourself below.</li>
              )}
            </ul>

            <button className="mic mic--on" onClick={() => setMode("create")}>
              None of these, define my own
            </button>
          </>
        ) : (
          <>
            <input
              className="field"
              placeholder="Name, e.g. my protein shake"
              value={form.name}
              onChange={(e) => setForm({ ...form, name: e.target.value })}
            />

            <div className="row">
              <label className="mini">
                <span>One</span>
                <input
                  className="field field--mini"
                  value={form.unit}
                  onChange={(e) => setForm({ ...form, unit: e.target.value })}
                />
              </label>
              {field("unitGrams", "weighs", "g")}
            </div>

            <p className="sheet__hint">Now the numbers for one {form.unit || "serving"}.</p>

            <div className="grid">
              {field("kcal", "kcal")}
              {field("protein_g", "protein", "g")}
              {field("carb_g", "carbs", "g")}
              {field("fat_g", "fat", "g")}
              {field("fibre_g", "fibre", "g")}
            </div>

            <div className="row">
              <button className="mic mic--off" disabled={busy} onClick={create}>
                Save and use
              </button>
              <button className="linkish" onClick={() => setMode("pick")}>Back to search</button>
            </div>
          </>
        )}

        {error && <p className="error">{error}</p>}
      </div>
    </div>
  );
}
