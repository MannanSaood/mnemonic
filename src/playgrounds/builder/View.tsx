"use client";
import type { ReactNode } from "react";
import { usePrefs } from "@/components/Prefs";
import type { Lang } from "@/lib/types";
import { PgButton, PgChoice, PgFrame, PgPredict, PgSources, useModel } from "../kit";
import { MEANT, SIG, TYPE, allCorrect, init, step, tally, validate, type Attempt, type Design, type Field } from "./model";

/* ---------------- the call, in the reader's language ---------------- */

const lit = (f: Field, v: string) => (TYPE[f] === "int" ? v : `"${v}"`);

const POS_HEAD: Record<Lang, [string, string]> = {
  go: ["d := NewDeployment(", ")"],
  python: ["d = Deployment(", ")"],
  typescript: ["const d = new Deployment(", ");"],
  rust: ["let d = Deployment::new(", ");"],
};

/** Builder form per language: [opening line, how each named step is written, closing line]. */
const NAMED: Record<Lang, { open: (name: ReactNode) => ReactNode; stepOf: (f: Field, arg: ReactNode) => ReactNode; close: string; kind: string; build: string }> = {
  go: {
    open: (n) => <>d, err := NewDeployment({n}).</>,
    stepOf: (f, a) => <>    {cap(f)}({a}).</>,
    close: "    Build()", kind: "Builder", build: "Build()",
  },
  python: {
    open: (n) => <>d = Deployment(name={n},</>,
    stepOf: (f, a) => <>    {f}={a},</>,
    close: ")  # __post_init__ validates", kind: "Keyword-only dataclass", build: "Construct (validates)",
  },
  typescript: {
    open: (n) => <>const d = deployment({"{"} name: {n},</>,
    stepOf: (f, a) => <>  {f}: {a},</>,
    close: "});  // validates, returns a frozen object", kind: "Options object", build: "Construct (validates)",
  },
  rust: {
    open: (n) => <>let d = Deployment::builder({n})</>,
    stepOf: (f, a) => <>    .{f}({a})</>,
    close: "    .build()?;", kind: "Builder", build: "build()",
  },
};
function cap(f: Field) {
  return ({ image: "Image", replicas: "Replicas", port: "Port", cpu: "CPU", memory: "Memory", probe: "ReadinessProbe", name: "Name" } as Record<Field, string>)[f];
}

const FIELD_LABEL: Record<Field, string> = { name: "name", image: "image", replicas: "replicas", port: "port", cpu: "cpu", memory: "memory", probe: "probe" };

const n = (k: number, one: string, many = one + "s") => `${k} ${k === 1 ? one : many}`;

function Report({ a }: { a: Attempt }) {
  const errs = a.kind === "build" && !a.reached;
  return (
    <div className={"pg-entry " + (a.healthy ? "ok" : "fail")} aria-live="polite">
      {errs ? (
        <p><b>Stopped before it existed.</b> The object was never created, and nothing was sent to the cluster.</p>
      ) : (
        <p><b>{a.healthy ? "Rolled out cleanly." : "Applied to the cluster. Production noticed."}</b></p>
      )}
      <div className="bd-scroll">
        <table className="bd-table">
          <thead><tr><th>Field</th><th>Ticket</th><th>{errs ? "Value" : "Kubernetes got"}</th><th>{errs ? "" : "Effect"}</th></tr></thead>
          <tbody>
            {a.effects.map((e) => (
              <tr key={e.field} className={e.ok ? "" : "bad"}>
                <th scope="row">{FIELD_LABEL[e.field]}</th>
                <td><code>{MEANT[e.field]}</code></td>
                <td><code>{e.got}</code></td>
                <td>{errs ? "" : e.text}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

export default function BuilderPlayground() {
  const { lang } = usePrefs();
  const { state: st, dispatch, reduced } = useModel(step, init);
  const t = tally(st);
  const last = st.attempts[st.attempts.length - 1];
  const errs = st.design === "builder" ? validate(st.args) : [];
  const sel = st.selected;

  const chip = (i: number) => {
    const f = SIG[i];
    const blocked = sel !== null && sel !== i && TYPE[SIG[sel]] !== TYPE[f];
    return (
      <button key={i} className={"bd-arg " + TYPE[f] + (sel === i ? " sel" : "") + (blocked ? " blocked" : "")}
        aria-pressed={sel === i} aria-label={`Argument ${i + 1} (${f}): ${st.args[i]}`}
        onClick={() => dispatch({ type: "pick", index: i })}>
        {st.design === "positional" && st.showNames && <span className="bd-hint">{f}: </span>}
        {lit(f, st.args[i])}
      </button>
    );
  };

  return (
    <PgFrame title="Review one Deployment, then ship it" onReset={() => dispatch({ type: "reset" })}>
      <div className="pg-req">
        <span className="label">The ticket</span>
        <p>Deploy <b>checkout-api</b> from <code>shop/checkout:2.3</code>: <b>3</b> replicas, port <b>8080</b>, <b>500m</b> CPU, <b>256Mi</b> memory, readiness probe <code>/healthz</code>.</p>
        <p className="pg-rule">The call below passed code review and compiles. Click two arguments of the same type to swap them. Different types cannot swap: the compiler would catch that, so this playground only lets you make the mistakes it cannot see.</p>
      </div>

      <div className="bd-controls">
        <PgChoice<Design> label="Design" value={st.design} onChange={(d) => dispatch({ type: "design", design: d })}
          options={[{ value: "positional", label: "Positional constructor" }, { value: "builder", label: NAMED[lang].kind }]} />
        {st.design === "positional" && (
          <PgButton onClick={() => dispatch({ type: "names" })}>{st.showNames ? "Hide" : "Show"} parameter names (IDE only)</PgButton>
        )}
      </div>

      <div className="pg-grid">
        <div className="pg-card">
          <span className="label">{st.design === "positional" ? "The call site, as a reviewer sees it" : "The same values, each next to its name"}</span>
          <div className="pgc bd-code">
            {st.design === "positional" ? (
              <div className="pgc-line"><code>{POS_HEAD[lang][0]}{SIG.map((_, i) => <span key={i}>{chip(i)}{i < SIG.length - 1 ? ", " : ""}</span>)}{POS_HEAD[lang][1]}</code></div>
            ) : (
              <>
                <div className="pgc-line"><code>{NAMED[lang].open(chip(0))}</code></div>
                {SIG.slice(1).map((f, j) => <div key={f} className="pgc-line"><code>{NAMED[lang].stepOf(f, chip(j + 1))}</code></div>)}
                <div className="pgc-line"><code>{NAMED[lang].close}</code></div>
              </>
            )}
          </div>
          {st.design === "builder" && (
            <p className={"muted bd-check" + (errs.length ? " bad" : "")}>
              {errs.length ? <>Validation will refuse: {errs.join("; ")}.</> : "Validation passes. That does not mean the values are right."}
            </p>
          )}
          <div className="pg-actions">
            {st.design === "positional"
              ? <PgButton primary onClick={() => dispatch({ type: "apply" })}>kubectl apply</PgButton>
              : <PgButton primary onClick={() => dispatch({ type: "build" })}>{NAMED[lang].build}, then apply</PgButton>}
            <span className="muted">{st.swaps ? n(st.swaps, "swap") : ""}{allCorrect(st.args) ? " · matches the ticket" : ""}</span>
          </div>
        </div>

        <div className="pg-card">
          <PgPredict<"3" | "8080" | "compile">
            question="This call passed review. How many pods will Kubernetes try to run?"
            options={[{ value: "3", label: "3" }, { value: "8080", label: "8080" }, { value: "compile", label: "None: it won't compile" }]}
            value={st.prediction}
            onChange={(v) => dispatch({ type: "predict", value: v })}
            revealed={st.attempts.length > 0}
            answer="8080"
            explain="The third parameter is replicas and the fourth is port. Both are integers, so 8080 and 3 swap without a compiler error. CPU and memory are both strings, and they swapped too."
          />
          {last ? <div className={reduced ? "" : "bd-fresh"} key={st.attempts.length}><Report a={last} /></div> : <p className="pg-empty">Nothing applied yet.</p>}
        </div>
      </div>

      <dl className="pg-stats">
        <div><dt>Applies</dt><dd>{t.positionalApplies + t.builds}</dd></div>
        <div className={t.brokenRollouts ? "bad" : ""}><dt>Broken rollouts</dt><dd>{t.brokenRollouts}</dd></div>
        <div><dt>Stopped by build</dt><dd>{t.caughtByBuild}</dd></div>
        <div><dt>Clean rollouts</dt><dd>{t.healthy}</dd></div>
      </dl>

      {st.attempts.length > 0 && (
        <div className="pg-result" aria-live="polite">
          <span className="label">What your attempts showed</span>
          <p>
            You applied the positional call {n(t.positionalApplies, "time")}; {n(st.attempts.filter((x) => x.design === "positional" && !x.healthy).length, "rollout")} hurt production.
            {t.builds ? ` With named steps you built ${n(t.builds, "time")}; build() stopped ${n(t.caughtByBuild, "bad object")} before it existed.` : " Now switch the design and build the same values."}
          </p>
          <p className="pg-takeaway">
            A positional constructor puts meaning in the order of the arguments, and order is invisible in review. A builder puts the name next to every value and checks the whole object once, in build(), so a half-right Deployment never exists.
            {" "}Validation is not magic: port 3 is a legal port, so only the name next to it gives that mistake away.
          </p>
        </div>
      )}

      <PgSources links={[
        { title: "Refactoring.Guru: Builder", href: "https://refactoring.guru/design-patterns/builder" },
        { title: "Rust Design Patterns: Builder", href: "https://rust-unofficial.github.io/patterns/patterns/creational/builder.html" },
        { title: "Kubernetes resource units", href: "https://kubernetes.io/docs/concepts/configuration/manage-resources-containers/" },
      ]} />

      <style>{`
        .bd-controls { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; }
        .bd-code code { white-space: pre-wrap; line-height: 2; }
        .bd-arg { border: 1px solid var(--line); background: var(--bg); padding: 1px 5px; font-family: var(--f-code); font-size: .72rem; margin: 1px 0; }
        .bd-arg.int { border-style: dashed; }
        .bd-arg.sel { background: var(--accent); color: var(--accent-ink); border-color: var(--accent); }
        .bd-arg.blocked { opacity: .45; }
        .bd-hint { color: var(--ink-2); font-style: italic; }
        .bd-arg.sel .bd-hint { color: inherit; }
        .bd-check.bad { color: var(--pain); }
        .bd-scroll { overflow-x: auto; }
        .bd-table { width: 100%; border-collapse: collapse; font-size: .82rem; }
        .bd-table th, .bd-table td { border: 1px solid var(--line); padding: 3px 6px; text-align: left; vertical-align: top; }
        .bd-table thead th { font-family: var(--f-code); font-size: .6rem; text-transform: uppercase; letter-spacing: .06em; color: var(--ink-2); }
        .bd-table tr.bad td { color: var(--pain); }
        .bd-fresh { animation: pg-hop .3s var(--ease) both; }
        @media (prefers-reduced-motion: reduce) { .bd-fresh { animation: none; } }
      `}</style>
    </PgFrame>
  );
}
