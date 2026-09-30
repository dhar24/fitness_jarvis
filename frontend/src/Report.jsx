import { METRICS, METRIC_UNIT, METRIC_LABEL } from "./lib/goals";

// A period report. It exists because you asked for it and leaves when you
// tap back, so it never becomes a dashboard you browse.
//
// Days logged is the headline rather than an average, because an average
// across days you did not log is a lie.

const ROW_KEYS = {
  kcal_in: "kcal_in",
  kcal_out: "kcal_out",
  active_min: "active_min",
  protein_g: "protein_g",
  carb_g: "carb_g",
  fat_g: "fat_g",
  fibre_g: "fibre_g",
};

const round = (n) => Math.round(Number(n ?? 0));

function Strip({ rows, metric, target, comparator }) {
  const key = ROW_KEYS[metric];
  const values = rows.map((r) => Number(r[key] ?? 0));
  const ceiling = Math.max(target ?? 0, ...values, 1);
  const targetPct = target ? (target / ceiling) * 100 : null;

  return (
    <>
      <div className="strip">
        {target != null && <span className="strip__target" style={{ bottom: `${targetPct}%` }} />}
        {rows.map((row, i) => {
          const value = values[i];
          const met =
            target == null ? null : comparator === "at_most" ? value <= target : value >= target;
          const cls = !row.logged
            ? "strip__bar strip__bar--none"
            : met === false
              ? "strip__bar strip__bar--miss"
              : met === true
                ? "strip__bar strip__bar--met"
                : "strip__bar";

          return (
            <span
              key={row.day}
              className={cls}
              style={{ height: row.logged ? `${Math.max((value / ceiling) * 100, 3)}%` : "4%" }}
              title={`${row.day}: ${round(value)}`}
            />
          );
        })}
      </div>
      <div className="strip__axis">
        {rows.map((row) => (
          <span key={row.day}>
            {new Date(row.day).toLocaleDateString([], { weekday: "narrow" })}
          </span>
        ))}
      </div>
    </>
  );
}

export default function Report({ report, onClose }) {
  const { days, rows, goals } = report;
  const logged = rows.filter((r) => r.logged);
  const goalFor = Object.fromEntries((goals ?? []).map((g) => [g.metric, g]));

  const from = rows[0]?.day;
  const to = rows[rows.length - 1]?.day;
  const fmt = (d) =>
    d ? new Date(d).toLocaleDateString([], { day: "numeric", month: "short" }) : "";

  const avg = (metric) => {
    if (!logged.length) return 0;
    const key = ROW_KEYS[metric];
    return Math.round(logged.reduce((n, r) => n + Number(r[key] ?? 0), 0) / logged.length);
  };

  const metCount = (metric, goal) => {
    if (!goal) return null;
    const key = ROW_KEYS[metric];
    return logged.filter((r) =>
      goal.comparator === "at_most"
        ? Number(r[key] ?? 0) <= Number(goal.target_value)
        : Number(r[key] ?? 0) >= Number(goal.target_value)
    ).length;
  };

  const shown = METRICS.filter(([metric]) => goalFor[metric] || avg(metric) > 0);

  return (
    <main className="shell">
      <header className="head">
        <div>
          <h1 className="head__day">{`Last ${days} days`}</h1>
          <p className="head__sub">{`${fmt(from)} to ${fmt(to)}`}</p>
        </div>
        <button className="linkish" onClick={onClose}>
          Today
        </button>
      </header>

      <section className="answer">
        <div className="answer__figure">
          <span className="answer__value">{logged.length}</span>
          <span className="answer__unit">{`of ${days} days logged`}</span>
        </div>
        <p className="answer__label">Averages below count logged days only.</p>
      </section>

      {shown.length === 0 && (
        <div className="empty">
          <p className="empty__lead">Nothing to report for this window.</p>
          <p className="empty__eg">Log a few days, then ask again.</p>
        </div>
      )}

      {shown.map(([metric, label]) => {
        const goal = goalFor[metric];
        const met = metCount(metric, goal);

        return (
          <section className="mblock" key={metric}>
            <div className="mblock__head">
              <span className="mblock__name">{label}</span>
              {goal ? (
                <span className={met === logged.length ? "mblock__met" : "mblock__part"}>
                  {`${met} of ${logged.length} days ${goal.comparator === "at_most" ? "under" : "met"}`}
                </span>
              ) : (
                <span className="mblock__part">no target</span>
              )}
            </div>

            <div className="mblock__figure">
              <span className="mblock__num">{avg(metric)}</span>
              <span className="mblock__unit">
                {`${METRIC_UNIT[metric]} a day${goal ? `, ${goal.comparator === "at_most" ? "cap" : "target"} ${round(goal.target_value)}` : ""}`}
              </span>
            </div>

            <Strip
              rows={rows}
              metric={metric}
              target={goal ? Number(goal.target_value) : null}
              comparator={goal?.comparator}
            />
          </section>
        );
      })}

      <p className="hint" style={{ padding: "1.5rem 0 2.5rem" }}>
        {`Ask for a different window: review the last 30 days.`}
      </p>
    </main>
  );
}