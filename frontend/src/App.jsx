import { useCallback, useEffect, useRef, useState } from "react";
import { createRecorder } from "./lib/recorder";
import { parse, ACTIVITY_LABELS } from "./lib/parser";
import { parseWithModel, logParseFailure } from "./lib/fallback";
import { todaysLog, deleteEntry, deleteDay, loadProfile, setMealSlot, MEALS, MEAL_LABEL, dayName } from "./lib/log";
import { dispatch } from "./lib/router";
import { answerQuestion } from "./lib/summary";
import { setGoal, METRIC_LABEL } from "./lib/goals";
import { say, prime, stop as stopSpeech, isMuted, setMuted, answerToSpeech } from "./lib/speech";
import "./lib/skills";
import { supabase } from "./lib/supabase";
import Auth from "./Auth";
import Onboarding from "./Onboarding";
import Household from "./Household";
import Confirm from "./Confirm";
import ConfirmDelete from "./ConfirmDelete";
import FoodFix from "./lib/FoodFix";

const detailOf = (e) => (Array.isArray(e.activity_detail) ? e.activity_detail[0] : e.activity_detail);
const foodOf = (e) => (Array.isArray(e.food_detail) ? e.food_detail[0] : e.food_detail);
const round = (n) => (n == null ? 0 : Math.round(Number(n)));

const timeOf = (iso) => new Date(iso).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });

function lines(entry) {
  if (entry.type === "food") {
    const food = foodOf(entry);
    if (!food) return { name: "Food", meta: null };

    const qty = food.qty ? `${food.qty} ${food.unit ?? "serving"}` : null;
    return {
      name: food.food?.name ?? "food",
      meta: [qty, food.grams ? `${round(food.grams)}g` : null, food.macros?.kcal ? `${round(food.macros.kcal)} kcal` : null]
        .filter(Boolean)
        .join("   "),
      estimated: food.food?.verified === false,
      needsMeal: food.meal === "unset" || !food.meal,
      meal: food.meal,
      detailId: food.id,
    };
  }

  const d = detailOf(entry);
  if (!d) return { name: "Logged", meta: null };

  return {
    name: ACTIVITY_LABELS[d.activity_key] ?? d.activity_key,
    meta: [d.duration_min ? `${d.duration_min} min` : null, d.est_kcal ? `${round(d.est_kcal)} kcal` : null]
      .filter(Boolean)
      .join("   "),
  };
}

export default function App() {
  const [session, setSession] = useState(undefined);
  const [profile, setProfile] = useState(undefined);
  const [view, setView] = useState("day");

  const [state, setState] = useState("idle");
  const [entries, setEntries] = useState([]);
  const [level, setLevel] = useState(0);
  const [error, setError] = useState(null);
  const [question, setQuestion] = useState(null);
  const [heard, setHeard] = useState(null);
  const [answer, setAnswer] = useState(null);
  const [fixing, setFixing] = useState(null);
  const [plan, setPlan] = useState(null);
  const [pendingDelete, setPendingDelete] = useState(null);
  const [mealFor, setMealFor] = useState(null);
  const [muted, setMutedState] = useState(isMuted);

  const recorderRef = useRef(null);

  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => setSession(data.session));
    const { data: sub } = supabase.auth.onAuthStateChange((_e, next) => setSession(next));
    return () => sub.subscription.unsubscribe();
  }, []);

  const refresh = useCallback(async () => {
    try {
      setEntries(await todaysLog());
    } catch (err) {
      setError(err.message);
    }
  }, []);

  const loadMe = useCallback(async () => {
    try {
      setProfile(await loadProfile());
    } catch (err) {
      setError(err.message);
      setProfile(null);
    }
  }, []);

  useEffect(() => {
    if (!session) return;
    loadMe();
  }, [session, loadMe]);

  useEffect(() => {
    if (profile) refresh();
  }, [profile, refresh]);

  // ---- writing ----------------------------------------------------

  const commit = useCallback(
    async (rows, envelope) => {
      const stamp = Date.now();
      const optimistic = rows
        .filter((r) => (r.day_offset ?? 0) === 0)
        .map((item, i) => ({
          id: `pending-${stamp}-${i}`,
          type: item.skill,
          logged_at: new Date().toISOString(),
          raw_transcript: envelope.raw,
          pending: true,
          activity_detail:
            item.skill === "activity"
              ? { activity_key: item.activity_key, duration_min: item.duration_min, level: item.level, est_kcal: null }
              : null,
          food_detail:
            item.skill === "food"
              ? [{ qty: item.qty, unit: item.unit, grams: null, meal: item.meal, macros: {}, food: { name: item.name } }]
              : [],
        }));

      setEntries((prev) => [...optimistic, ...prev]);
      setState("writing");

      const { failed } = await dispatch({ ...envelope, entries: rows });

      setState("idle");
      if (failed.length) setError(failed.map((f) => f.error).join(". "));

      const ids = new Set(optimistic.map((o) => o.id));
      setEntries((prev) => prev.filter((e) => !ids.has(e.id)));
      await refresh();

      if (!failed.length) {
        const names = rows.map((item) =>
          item.skill === "food" ? item.name : ACTIVITY_LABELS[item.activity_key] ?? item.activity_key
        );
        const when = (rows[0]?.day_offset ?? 0) > 0 ? ` for ${dayName(rows[0].day_offset)}` : "";
        say(names.length > 3 ? `Logged ${names.length} things${when}.` : `Logged ${names.join(", ")}${when}.`);
      }
    },
    [refresh]
  );

  const handleTranscript = useCallback(
    async ({ text }) => {
      setHeard(text);
      setQuestion(null);
      setError(null);

      let envelope = parse(text);

      const askAnswer = async () => {
        setState("thinking");
        try {
          const result = await answerQuestion(text);
          setAnswer(result);
          say(answerToSpeech(result));
        } catch (err) {
          setError(err.message);
          say("Something went wrong answering that.");
        } finally {
          setState("idle");
        }
      };

      if (envelope.intent === "query_summary") {
        await askAnswer();
        return;
      }

      if (envelope.intent === "unknown" || envelope.confidence < 0.55) {
        setState("thinking");
        try {
          const fromModel = await parseWithModel(text);
          if (fromModel.entries.length || fromModel.intent !== "unknown" || fromModel.confidence >= envelope.confidence) {
            envelope = fromModel;
          }
        } catch (err) {
          setError(err.message);
        } finally {
          setState("idle");
        }
      }

      if (envelope.intent === "query_summary") {
        await askAnswer();
        return;
      }

      if (envelope.intent === "delete" && envelope.delete) {
        setPendingDelete(envelope.delete);
        return;
      }

      if (envelope.intent === "set_goal" && envelope.goal) {
        try {
          await setGoal(envelope.goal.metric, envelope.goal.target, envelope.goal.comparator);
          const label = METRIC_LABEL[envelope.goal.metric] ?? envelope.goal.metric;
          const line = `${label} target set to ${envelope.goal.target}.`;
          setQuestion(line);
          say(line);
        } catch (err) {
          setError(err.message);
        }
        return;
      }

      if (envelope.intent !== "log" || !envelope.entries.length) {
        const { data: auth } = await supabase.auth.getUser();
        logParseFailure(supabase, auth?.user?.id, text, envelope.parsed_by, { intent: envelope.intent });
        const asked = envelope.question ?? "I did not catch that.";
        setQuestion(asked);
        say(asked);
        return;
      }

      if (envelope.needs_confirmation && envelope.question) {
        setQuestion(envelope.question);
        say(envelope.question);
        return;
      }

      setAnswer(null);

      // Anything that cannot be checked at a glance gets reviewed first:
      // several entries at once, a past day, or a food with no meal stated.
      const needsReview =
        envelope.entries.length >= 3 ||
        envelope.entries.some((e) => (e.day_offset ?? 0) > 0) ||
        envelope.entries.some((e) => e.skill === "food" && !e.meal);

      if (needsReview) {
        setPlan({ entries: envelope.entries, raw: text, envelope });
        if (envelope.entries.some((e) => e.skill === "food" && !e.meal)) {
          say("Which meal was that?");
        }
        return;
      }

      await commit(envelope.entries, envelope);
    },
    [commit]
  );

  function ensureRecorder() {
    if (recorderRef.current) return recorderRef.current;
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
    prime();
    stopSpeech();
    ensureRecorder().press();
  }

  function onRelease() {
    recorderRef.current?.release();
  }

  async function remove(id) {
    setEntries((prev) => prev.filter((e) => e.id !== id));
    try {
      await deleteEntry(id);
      await refresh();
    } catch (err) {
      setError(err.message);
      refresh();
    }
  }

  async function chooseMeal(detailId, meal) {
    setMealFor(null);
    try {
      await setMealSlot(detailId, meal);
      await refresh();
    } catch (err) {
      setError(err.message);
    }
  }

  // ---- gates ------------------------------------------------------

  if (session === undefined) return null;
  if (session === null) return <Auth />;
  if (profile === undefined) return null;
  if (profile === null) return <Onboarding onDone={loadMe} />;

  if (view === "household") {
    return <Household me={profile} onClose={() => setView("day")} />;
  }

  // ---- day --------------------------------------------------------

  const recording = state === "recording";
  const busy = state === "sending" || state === "thinking" || state === "writing";
  const ticks = Array.from({ length: 32 }, (_, i) => i / 32 < level * 2.2);

  const activeMin = entries.reduce((n, e) => n + (detailOf(e)?.duration_min ?? 0), 0);
  const kcalIn = entries.reduce((n, e) => n + (foodOf(e)?.macros?.kcal ?? 0), 0);
  const proteinG = entries.reduce((n, e) => n + (foodOf(e)?.macros?.protein_g ?? 0), 0);

  const today = new Date().toLocaleDateString([], { weekday: "long", day: "numeric", month: "long" });

  return (
    <main className="shell">
      <header className="head">
        <div>
          <h1 className="head__day">{today}</h1>
          <p className="head__sub">
            {entries.length ? `${entries.length} ${entries.length === 1 ? "entry" : "entries"}` : "Nothing logged yet"}
          </p>
        </div>
        <div className="row">
          <button
            className={muted ? "speaker speaker--off" : "speaker"}
            aria-pressed={!muted}
            onClick={() => {
              const next = !muted;
              setMuted(next);
              setMutedState(next);
            }}
          >
            {muted ? "Silent" : "Speaking"}
          </button>
          <button className="linkish" onClick={() => setView("household")}>
            Household
          </button>
        </div>
      </header>

      {answer && (
        <section className={answer.unsupported ? "answer answer--miss" : "answer"}>
          <div className="answer__figure">
            <span className="answer__value">{answer.value}</span>
            {answer.unit && <span className="answer__unit">{answer.unit}</span>}
          </div>
          <p className="answer__label">{answer.label}</p>
          {answer.detail && <p className="answer__detail">{answer.detail}</p>}
          <button className="answer__close" onClick={() => setAnswer(null)}>
            Back to the day
          </button>
        </section>
      )}

      {error && <p className="note note--bad">{error}</p>}
      {question && (
        <p className="note">
          {question}
          {heard && <span className="note__heard">Heard: {heard}</span>}
        </p>
      )}

      {entries.length ? (
        <ol className="tape">
          {entries.map((entry) => {
            const row = lines(entry);
            const tappable = entry.type === "food" && !entry.pending;

            return (
              <li key={entry.id} className={entry.pending ? "tape__row tape__row--pending" : "tape__row"}>
                <span className="tape__time">{timeOf(entry.logged_at)}</span>

                <span className="tape__what">
                  {tappable ? (
                    <button className="tape__link" onClick={() => setFixing(entry)} title="Wrong? Tap to fix">
                      <span className="tape__name">
                        {row.name}
                        {row.estimated && <span className="mark">estimated</span>}
                      </span>
                    </button>
                  ) : (
                    <span className="tape__name">{row.name}</span>
                  )}

                  {row.meta && <span className="tape__meta">{row.meta}</span>}

                  {entry.type === "food" && !entry.pending && (
                    row.needsMeal ? (
                      mealFor === row.detailId ? (
                        <span className="chips">
                          {MEALS.map(([key, label]) => (
                            <button key={key} className="pill" onClick={() => chooseMeal(row.detailId, key)}>
                              {label}
                            </button>
                          ))}
                        </span>
                      ) : (
                        <button className="tape__ask" onClick={() => setMealFor(row.detailId)}>
                          Which meal?
                        </button>
                      )
                    ) : (
                      <span className="tape__slot">{MEAL_LABEL[row.meal]}</span>
                    )
                  )}
                </span>

                {entry.pending ? (
                  <span className={entry.type === "food" ? "tape__kind tape__kind--food" : "tape__kind"} />
                ) : (
                  <button className="tape__undo" onClick={() => remove(entry.id)}>
                    Undo
                  </button>
                )}
              </li>
            );
          })}
        </ol>
      ) : (
        <div className="empty">
          <p className="empty__lead">Hold the button and say what you did or ate.</p>
          <p className="empty__eg">Two chapatis and a katori of dal for lunch, then thirty minutes strength training.</p>
        </div>
      )}

      {entries.length > 0 && (
        <section className="totals">
          <div className="totals__item">
            <span className="totals__num">{round(kcalIn)}</span>
            <span className="totals__label">kcal in</span>
          </div>
          <div className="totals__item">
            <span className="totals__num">{round(proteinG)}</span>
            <span className="totals__label">g protein</span>
          </div>
          <div className="totals__item">
            <span className="totals__num">{activeMin}</span>
            <span className="totals__label">min active</span>
          </div>
        </section>
      )}

      <div className="dock">
        <div className="level" aria-hidden="true">
          {ticks.map((lit, i) => (
            <span key={i} className={lit ? "level__tick level__tick--lit" : "level__tick"} />
          ))}
        </div>

        <button
          className={`mic ${recording ? "mic--live" : busy ? "mic--busy" : ""}`}
          onPointerDown={onPress}
          onPointerUp={onRelease}
          onPointerLeave={onRelease}
          disabled={busy}
        >
          {recording ? "Release to log" : busy ? "Working" : "Hold to speak"}
        </button>

        <p className="hint">{recording ? "Listening" : busy ? "" : "Or ask: how many days did I hit my protein goal?"}</p>
      </div>

      {plan && (
        <Confirm
          plan={plan}
          onCancel={() => setPlan(null)}
          onCommit={async (rows) => {
            const envelope = plan.envelope;
            setPlan(null);
            await commit(rows, envelope);
          }}
        />
      )}

      {pendingDelete && (
        <ConfirmDelete
          spec={pendingDelete}
          onCancel={() => setPendingDelete(null)}
          onConfirm={async () => {
            const spec = pendingDelete;
            setPendingDelete(null);
            try {
              const n = await deleteDay({
                dayOffset: spec.day_offset,
                meal: spec.meal,
                type: spec.type,
              });
              const line = `Deleted ${n} ${n === 1 ? "entry" : "entries"} from ${dayName(spec.day_offset)}.`;
              setQuestion(line);
              say(line);
              await refresh();
            } catch (err) {
              setError(err.message);
            }
          }}
        />
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
