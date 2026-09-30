import { useState } from "react";
import { setUpNewHousehold, joinWithCode } from "./lib/household";
import { setGoal, METRICS } from "./lib/goals";

// Replaces the bootstrap SQL. A new account has no app_user row and cannot
// create one under row level security, so this runs the two functions that
// can. It is also where goals get asked, which is the only moment someone
// will willingly type five numbers.

export default function Onboarding({ onDone }) {
  const [step, setStep] = useState("who");
  const [mode, setMode] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  const [form, setForm] = useState({
    displayName: "",
    householdName: "",
    code: "",
    weightKg: "",
    diet: "",
  });

  const [targets, setTargets] = useState({});

  function set(key, value) {
    setForm((prev) => ({ ...prev, [key]: value }));
  }

  async function createOrJoin() {
    if (!form.displayName.trim()) {
      setError("What should I call you?");
      return;
    }

    setBusy(true);
    setError(null);
    try {
      if (mode === "join") {
        if (!form.code.trim()) throw new Error("Enter the invite code you were given.");
        await joinWithCode(form);
      } else {
        await setUpNewHousehold(form);
      }
      setStep("goals");
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  async function saveGoals() {
    setBusy(true);
    setError(null);
    try {
      if (form.diet) {
        const { data: auth } = await (await import("./lib/supabase")).supabase.auth.getUser();
        const { supabase } = await import("./lib/supabase");
        await supabase.from("app_user").update({ diet: form.diet }).eq("id", auth?.user?.id);
      }
      
      for (const [metric, value] of Object.entries(targets)) {
        if (value !== "" && !Number.isNaN(Number(value))) {
          await setGoal(metric, Number(value));
        }
      }
      onDone();
    } catch (err) {
      setError(err.message);
      setBusy(false);
    }
  }

  if (step === "who" && mode === null) {
    return (
      <main className="gate">
        <h1 className="gate__title">Set up</h1>
        <p className="gate__sub">
          A household keeps everyone's log separate. Nothing is shared until you say so.
        </p>

        <div className="stack">
          <button className="btn" onClick={() => setMode("new")}>
            Start a new household
          </button>
          <button className="btn btn--quiet" onClick={() => setMode("join")}>
            Join with an invite code
          </button>
        </div>
      </main>
    );
  }

  if (step === "who") {
    return (
      <main className="gate">
        <h1 className="gate__title">{mode === "join" ? "Join a household" : "Your household"}</h1>
        <p className="gate__sub">
          {mode === "join"
            ? "The person who invited you can generate a code from their Household screen."
            : "You will be the admin, so you can invite others later."}
        </p>

        <input
          className="field"
          placeholder="Your name"
          value={form.displayName}
          onChange={(e) => set("displayName", e.target.value)}
        />

        {mode === "join" ? (
          <input
            className="field"
            placeholder="Invite code"
            autoCapitalize="characters"
            value={form.code}
            onChange={(e) => set("code", e.target.value.toUpperCase())}
          />
        ) : (
          <input
            className="field"
            placeholder="Household name, e.g. Home"
            value={form.householdName}
            onChange={(e) => set("householdName", e.target.value)}
          />
        )}

        <label className="mini" style={{ marginTop: "0.5rem" }}>
          <span>Weight</span>
          <input
            className="field field--mini"
            inputMode="decimal"
            value={form.weightKg}
            onChange={(e) => set("weightKg", e.target.value)}
          />
          <em>kg, for calorie estimates</em>
        </label>

        <div className="row" style={{ marginTop: "1rem" }}>
          <button className="btn" disabled={busy} onClick={createOrJoin}>
            Continue
          </button>
          <button className="linkish" onClick={() => setMode(null)}>
            Back
          </button>
        </div>

        {error && <p className="error">{error}</p>}
      </main>
    );
  }

  return (
    <main className="gate">
      <h1 className="gate__title">What are you aiming for?</h1>
      <p className="gate__sub">
        Skip any of these. Numbers mean nothing without something to compare them to, and you
        can change them any time by saying so.
      </p>
      <div className="chips" style={{ marginBottom: "1.25rem" }}>
        {[
          ["veg", "Vegetarian"],
          ["egg", "Eggetarian"],
          ["nonveg", "Everything"],
        ].map(([key, label]) => (
          <button
            key={key}
            className={form.diet === key ? "pill pill--on" : "pill"}
            onClick={() => set("diet", key)}
          >
            {label}
          </button>
        ))}
      </div>
      <p className="block__note" style={{ marginTop: "-0.75rem" }}>
        Only used to filter food suggestions.
      </p>
      <div className="stack">
        {METRICS.map(([metric, label, unit, comparator]) => (
          <label className="mini mini--row" key={metric}>
            <span className="mini__label">{label}</span>
            <input
              className="field field--mini"
              inputMode="decimal"
              placeholder={comparator === "at_most" ? "at most" : "at least"}
              value={targets[metric] ?? ""}
              onChange={(e) => setTargets({ ...targets, [metric]: e.target.value })}
            />
            <em>{unit}</em>
          </label>
        ))}
      </div>

      <div className="row" style={{ marginTop: "1.25rem" }}>
        <button className="btn" disabled={busy} onClick={saveGoals}>
          Start logging
        </button>
        <button className="linkish" onClick={onDone}>
          Skip for now
        </button>
      </div>

      {error && <p className="error">{error}</p>}
    </main>
  );
}