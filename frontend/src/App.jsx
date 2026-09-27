import FoodFix from "./lib/FoodFix";

import { useCallback, useEffect, useRef, useState } from "react";

import { createRecorder } from "./lib/recorder";
import { parse, ACTIVITY_LABELS } from "./lib/parser";
import { parseWithModel, logParseFailure } from "./lib/fallback";
import { todaysLog, deleteEntry, loadProfile } from "./lib/log";
import { dispatch } from "./lib/router";

import "./lib/skills";

import { supabase } from "./lib/supabase";
import Auth from "./Auth";

function detailOf(entry) {
  const d = entry.activity_detail;
  return Array.isArray(d) ? d[0] : d;
}

function foodOf(entry) {
  const d = entry.food_detail;
  return Array.isArray(d) ? d[0] : d;
}

function round(n) {
  return n == null ? null : Math.round(n);
}

function timeOf(iso) {
  return new Date(iso).toLocaleTimeString([], {
    hour: "numeric",
    minute: "2-digit",
  });
}

function describe(entry) {
  if (entry.type === "food") {
    const food = foodOf(entry);

    if (!food) return "Food";

    const bits = [];

    if (food.qty) {
      bits.push(`${food.qty}${food.unit ? " " + food.unit : ""}`);
    }

    bits.push(food.food?.name ?? "food");

    if (food.grams) {
      bits.push(`${round(food.grams)}g`);
    }

    if (food.macros?.kcal) {
      bits.push(`${round(food.macros.kcal)} kcal`);
    }

    return bits.join(" · ");
  }

  const detail = detailOf(entry);

  if (!detail) return "Logged";

  const label =
    ACTIVITY_LABELS[detail.activity_key] ?? detail.activity_key;

  const bits = [label];

  if (detail.duration_min) {
    bits.push(`${detail.duration_min} min`);
  }

  if (detail.est_kcal) {
    bits.push(`${detail.est_kcal} kcal`);
  }

  return bits.join(" · ");
}

function isUnverified(entry) {
  return (
    entry.type === "food" &&
    foodOf(entry)?.food?.verified === false
  );
}

export default function App() {
  const [session, setSession] = useState(undefined);
  const [state, setState] = useState("idle");
  const [entries, setEntries] = useState([]);
  const [level, setLevel] = useState(0);
  const [error, setError] = useState(null);
  const [question, setQuestion] = useState(null);
  const [fixing, setFixing] = useState(null);
  const [heard, setHeard] = useState(null);
  

  const recorderRef = useRef(null);

  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => {
      setSession(data.session);
    });

    const { data: sub } = supabase.auth.onAuthStateChange(
      (_e, next) => {
        setSession(next);
      }
    );

    return () => sub.subscription.unsubscribe();
  }, []);

  const refresh = useCallback(async () => {
    try {
      setEntries(await todaysLog());
    } catch (err) {
      setError(err.message);
    }
  }, []);

  useEffect(() => {
    if (!session) return;

    loadProfile().catch((err) => setError(err.message));
    refresh();
  }, [session, refresh]);

  const handleTranscript = useCallback(
    async ({ text }) => {
      setHeard(text);
      setQuestion(null);

      let envelope = parse(text);

      if (
        envelope.intent === "unknown" ||
        envelope.confidence < 0.55
      ) {
        setState("thinking");

        try {
          const fromModel = await parseWithModel(text);

          if (
            fromModel.entries.length ||
            fromModel.confidence >= envelope.confidence
          ) {
            envelope = fromModel;
          }
        } catch (err) {
          setError(err.message);
        } finally {
          setState("idle");
        }
      }

      const loggable = ["log", "log_activity"].includes(
        envelope.intent
      );

      if (!loggable || !envelope.entries.length) {
        const { data: auth } = await supabase.auth.getUser();

        logParseFailure(
          supabase,
          auth?.user?.id,
          text,
          envelope.parsed_by,
          {
            intent: envelope.intent,
          }
        );

        setQuestion(
          envelope.question ??
            (envelope.intent === "unknown"
              ? "I did not catch that."
              : `${envelope.intent.replace("_", " ")} is not wired up yet.`)
        );

        return;
      }

      if (envelope.needs_confirmation && envelope.question) {
        setQuestion(envelope.question);
        return;
      }

      const stamp = Date.now();

      const optimistic = envelope.entries.map((item, i) => ({
        id: `pending-${stamp}-${i}`,
        type: item.skill,
        logged_at: new Date().toISOString(),
        raw_transcript: text,
        pending: true,

        activity_detail:
          item.skill === "activity"
            ? {
                activity_key: item.activity_key,
                duration_min: item.duration_min,
                level: item.level,
                est_kcal: null,
              }
            : null,

        food_detail:
          item.skill === "food"
            ? [
                {
                  qty: item.qty,
                  unit: item.unit,
                  grams: null,
                  meal: item.meal,
                  macros: {},
                  food: {
                    name: item.name,
                  },
                },
              ]
            : [],
      }));

      setEntries((prev) => [...optimistic, ...prev]);

      if (envelope.question) {
        setQuestion(envelope.question);
      }

      setState("writing");

      const { failed } = await dispatch(envelope);

      setState("idle");

      if (failed.length) {
        setError(
          failed.map((f) => f.error).join(". ")
        );
      }

      const ids = new Set(
        optimistic.map((o) => o.id)
      );

      setEntries((prev) =>
        prev.filter((e) => !ids.has(e.id))
      );

      await refresh();
    },
    [refresh]
  );

  function ensureRecorder() {
    if (recorderRef.current) {
      return recorderRef.current;
    }

    recorderRef.current = createRecorder({
      onState: setState,
      onLevel: setLevel,
      onFinal: handleTranscript,
      onError: setError,
    });

    return recorderRef.current;
  }

  function onPress() {
    setError(null);
    ensureRecorder().press();
  }

  function onRelease() {
    recorderRef.current?.release();
  }

  async function remove(id) {
    setEntries((prev) =>
      prev.filter((e) => e.id !== id)
    );

    try {
      await deleteEntry(id);
    } catch (err) {
      setError(err.message);
      refresh();
    }
  }

  if (session === undefined) {
    return null;
  }

  if (session === null) {
    return <Auth />;
  }

  const recording = state === "recording";

  const busy =
    state === "sending" ||
    state === "thinking" ||
    state === "writing";

  const ticks = Array.from(
    { length: 28 },
    (_, i) => i / 28 < level * 2.2
  );

  const totalMin = entries.reduce(
    (n, e) =>
      n + (detailOf(e)?.duration_min ?? 0),
    0
  );

  const kcalIn = entries.reduce(
    (n, e) =>
      n + (foodOf(e)?.macros?.kcal ?? 0),
    0
  );

  const proteinG = entries.reduce(
    (n, e) =>
      n + (foodOf(e)?.macros?.protein_g ?? 0),
    0
  );

  return (
    <main className="shell">
      <header className="head">
        <div className="row row--between">
          <h1>Today</h1>

          <button
            className="linkish"
            onClick={() => supabase.auth.signOut()}
          >
            Sign out
          </button>
        </div>

        <p className="sub">
          Hold the button and say what you did or ate.
          Both work in one sentence.
        </p>
      </header>

      <section className="panel">
        <button
          className={`mic mic--${recording ? "on" : "off"}`}
          onPointerDown={onPress}
          onPointerUp={onRelease}
          onPointerLeave={onRelease}
        >
          {busy
            ? "Working"
            : recording
              ? "Release to log"
              : "Hold to speak"}
        </button>

        <div
          className="meter"
          aria-hidden="true"
        >
          {ticks.map((lit, i) => (
            <span
              key={i}
              className={
                lit ? "tick tick--lit" : "tick"
              }
            />
          ))}
        </div>
      </section>

      <section className="totals">
        <div className="tot">
          <span className="tot__num">
            {totalMin}
          </span>

          <span className="tot__label">
            active min
          </span>
        </div>

        <div className="tot">
          <span className="tot__num">
            {round(kcalIn)}
          </span>

          <span className="tot__label">
            kcal in
          </span>
        </div>

        <div className="tot">
          <span className="tot__num">
            {round(proteinG)}
          </span>

          <span className="tot__label">
            g protein
          </span>
        </div>
      </section>

      {error && (
        <p className="error">
          {error}
        </p>
      )}

      {question && (
        <p className="notice">
          {question}

          {heard && (
            <span className="notice__heard">
              Heard: {heard}
            </span>
          )}
        </p>
      )}

      <div
        className="live"
        aria-live="polite"
      >
        {recording
          ? "Recording"
          : busy
            ? "Working"
            : ""}
      </div>

      <ol className="log">
        {entries.map((entry) => (
          <li key={entry.id} className={entry.pending ? "log__row log__row--pending" : "log__row"}>
            {entry.type === "food" && !entry.pending ? (
              <button
                className="log__text log__text--tappable"
                onClick={() => setFixing(entry)}
                title="Not right? Tap to fix"
              >
                {describe(entry)}
                {isUnverified(entry) && <span className="badge">estimated</span>}
              </button>
            ) : (
              <span className="log__text">
                {describe(entry)}
                {isUnverified(entry) && <span className="badge">estimated</span>}
              </span>
            )}
            <span className="log__meta">
              {timeOf(entry.logged_at)}
              {!entry.pending && (
                <button className="linkish" onClick={() => remove(entry.id)}>
                  Undo
                </button>
              )}
            </span>
          </li>
        ))}
      </ol>

      {!entries.length && (
        <p className="empty">
          Nothing logged today. Hold the button and say
          what you did.
        </p>
      )}

       {fixing && (
        <FoodFix
          entry={fixing}
          onClose={() => setFixing(null)}
          onDone={() => {
            setFixing(null);
            refresh();
          }}
        />
      )}
    </main>
  );
}