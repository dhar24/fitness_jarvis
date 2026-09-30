import { useCallback, useEffect, useState } from "react";
import { createInvite, householdMembers, sharedWith, shareWith } from "./lib/household";
import { activeGoals, setGoal, clearGoal, METRICS, METRIC_UNIT } from "./lib/goals";

// Household, sharing and goals in one screen, because all three are things
// you set once and forget.

export default function Household({ me, onClose }) {
  const [members, setMembers] = useState([]);
  const [shares, setShares] = useState(new Set());
  const [goals, setGoals] = useState([]);
  const [code, setCode] = useState(null);
  const [edits, setEdits] = useState({});
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      const [m, s, g] = await Promise.all([householdMembers(), sharedWith(), activeGoals()]);
      setMembers(m);
      setShares(s);
      setGoals(g);
      setEdits(Object.fromEntries(g.map((row) => [row.metric, String(row.target_value)])));
    } catch (err) {
      setError(err.message);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  async function toggleShare(viewerId, on) {
    setError(null);
    try {
      await shareWith(viewerId, on);
      setShares((prev) => {
        const next = new Set(prev);
        if (on) next.add(viewerId);
        else next.delete(viewerId);
        return next;
      });
    } catch (err) {
      setError(err.message);
    }
  }

  async function invite() {
    setBusy(true);
    setError(null);
    try {
      setCode(await createInvite());
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  async function saveGoal(metric) {
    const value = edits[metric];
    setError(null);
    try {
      if (value === "" || value == null) await clearGoal(metric);
      else await setGoal(metric, Number(value));
      await load();
    } catch (err) {
      setError(err.message);
    }
  }

  const others = members.filter((m) => m.id !== me?.id);
  const goalFor = Object.fromEntries(goals.map((g) => [g.metric, g]));

  return (
    <main className="shell">
      <header className="head">
        <div>
          <h1 className="head__day">Household</h1>
          <p className="head__sub">{me?.display_name}{me?.role === "admin" ? ", admin" : ""}</p>
        </div>
        <button className="linkish" onClick={onClose}>
          Back to today
        </button>
      </header>

      <section className="block">
        <h2 className="block__title">Targets</h2>
        <p className="block__note">Leave a field empty to remove that target.</p>

        {METRICS.map(([metric, label]) => (
          <div className="goalrow" key={metric}>
            <span className="goalrow__name">{label}</span>
            <input
              className="field field--mini"
              inputMode="decimal"
              value={edits[metric] ?? ""}
              onChange={(e) => setEdits({ ...edits, [metric]: e.target.value })}
            />
            <span className="goalrow__unit">{METRIC_UNIT[metric]}</span>
            <button className="linkish" onClick={() => saveGoal(metric)}>
              {goalFor[metric] ? "Update" : "Set"}
            </button>
          </div>
        ))}
      </section>

      <section className="block">
        <h2 className="block__title">Who can see my log</h2>
        <p className="block__note">
          Off by default. Being in the same household does not grant access on its own.
        </p>

        {others.length ? (
          others.map((m) => (
            <label className="goalrow" key={m.id}>
              <span className="goalrow__name">{m.display_name}</span>
              <input
                type="checkbox"
                checked={shares.has(m.id)}
                onChange={(e) => toggleShare(m.id, e.target.checked)}
              />
              <span className="goalrow__unit">{shares.has(m.id) ? "can see it" : "cannot"}</span>
            </label>
          ))
        ) : (
          <p className="block__note">Nobody else has joined yet.</p>
        )}
      </section>

      {me?.role === "admin" && (
        <section className="block">
          <h2 className="block__title">Invite someone</h2>
          <p className="block__note">
            They enter this code when they sign up. It lasts two weeks and works once.
          </p>

          {code ? (
            <p className="code">{code}</p>
          ) : (
            <button className="btn btn--quiet" disabled={busy} onClick={invite}>
              Generate a code
            </button>
          )}
        </section>
      )}

      {error && <p className="error">{error}</p>}
    </main>
  );
}