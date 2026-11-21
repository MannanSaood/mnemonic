"use client";
import { useState } from "react";
import { usePrefs } from "@/components/Prefs";
import type { Lang } from "@/lib/types";
import { PgButton, PgFrame, PgLog, PgPredict, PgSources, useModel } from "../kit";
import {
  CALLERS, CALLER_FILE, CALLER_NAME, CHANGES, PARTS, PART_NAME, best, init, partsUsed, step, wires,
  type Caller, type File, type Part, type State,
} from "./model";

/* ---------------- the scripts, in the reader's language ---------------- */

type Ln = { part: Part | "facade"; text: string; fresh: boolean };

const SYN: Record<Lang, { call: (obj: string, m: string, args: string) => string; ext: string }> = {
  go: { call: (o, m, a) => `${o}.${m[0].toUpperCase() + m.slice(1)}(ctx${a ? ", " + a : ""})`, ext: "go" },
  python: { call: (o, m, a) => `${o}.${m}(${a.replace("gitRef", "git_ref")})`, ext: "py" },
  typescript: { call: (o, m, a) => `await ${o}.${m}(${a});`, ext: "ts" },
  rust: { call: (o, m, a) => `${o}.${m}(${a ? a.replace("gitRef", "git_ref").split(", ").map((x) => (x.startsWith('"') ? x : "&" + x)).join(", ") : ""})?;`, ext: "rs" },
};

function scriptLines(st: State, file: File, lang: Lang): Ln[] {
  const s = SYN[lang];
  const has = (c: number) => st.applied[file].includes(c);
  const fresh = (c: number) => st.change === c && has(c);
  if (file !== "facade" && st.via[file]) return [{ part: "facade", text: s.call("deployer", "deploy", "version"), fresh: false }];
  const out: Ln[] = [];
  if (file !== "rollback") {
    out.push({ part: "build", text: s.call("builder", "build", "gitRef"), fresh: false });
    if (has(0)) out.push({ part: "scan", text: s.call("scanner", "scan", "img"), fresh: fresh(0) });
    out.push({ part: "registry", text: s.call("registry", "push", has(1) ? "img, region" : "img"), fresh: fresh(1) });
    out.push({ part: "migrate", text: s.call("migrator", "up", ""), fresh: false });
  }
  out.push({ part: "cluster", text: s.call("cluster", "rollout", file === "rollback" ? "previous" : "img"), fresh: false });
  out.push({ part: "cdn", text: s.call("cdn", "purge", '"/*"'), fresh: false });
  out.push({ part: "notify", text: has(2) ? s.call("notifier", "announce", "release") : s.call("notifier", "send", "msg"), fresh: fresh(2) });
  return out;
}

/* ---------------- the wiring picture ---------------- */

function Wiring({ st }: { st: State }) {
  const done = st.change;
  const cy = (i: number) => 22 + i * 62;
  const py = (i: number) => 12 + i * 35;
  const anyVia = CALLERS.some((c) => st.via[c]);
  const lines: { x1: number; y1: number; x2: number; y2: number; f: boolean }[] = [];
  CALLERS.forEach((c, i) => {
    if (st.via[c]) lines.push({ x1: 140, y1: cy(i) + 18, x2: 238, y2: 128, f: true });
    else for (const p of partsUsed(c, done)) lines.push({ x1: 140, y1: cy(i) + 18, x2: 450, y2: py(PARTS.indexOf(p)) + 13, f: false });
  });
  if (anyVia) for (const p of partsUsed("facade", done)) lines.push({ x1: 352, y1: 128, x2: 450, y2: py(PARTS.indexOf(p)) + 13, f: true });
  return (
    <svg className="facade-svg" viewBox="0 0 590 262" role="img" aria-label={`Wiring: ${wires(st)} dependencies from callers to the deploy subsystem`}>
      {lines.map((l, i) => <line key={i} x1={l.x1} y1={l.y1} x2={l.x2} y2={l.y2} className={l.f ? "facade-wire via" : "facade-wire"} />)}
      {CALLERS.map((c, i) => (
        <g key={c}>
          <rect x={4} y={cy(i)} width={136} height={36} className="facade-box" />
          <text x={12} y={cy(i) + 22} className="facade-t">{CALLER_NAME[c]}</text>
        </g>
      ))}
      <rect x={238} y={104} width={114} height={48} className={"facade-box facade-hub" + (anyVia ? " on" : "")} />
      <text x={248} y={124} className="facade-t">Deployer</text>
      <text x={248} y={141} className="facade-s">{anyVia ? "Deploy(version)" : "unused"}</text>
      {PARTS.map((p, i) => (
        <g key={p} opacity={p === "scan" && st.change === 0 ? 0.45 : 1}>
          <rect x={450} y={py(i)} width={136} height={26} className="facade-box part" />
          <text x={458} y={py(i) + 17} className="facade-t">{PART_NAME[p]}</text>
        </g>
      ))}
    </svg>
  );
}

/* ---------------- page ---------------- */

const n = (k: number, one: string, many = one + "s") => `${k} ${k === 1 ? one : many}`;
type Guess = "error" | "silent" | "auto";

function FileCard({ st, file, lang, dispatch }: { st: State; file: File; lang: Lang; dispatch: (a: Parameters<typeof step>[1]) => void }) {
  const caller = file === "facade" ? null : (file as Caller);
  const ev = caller ? st.lastRun.find((e) => e.caller === caller) : null;
  const edited = st.edited.includes(file), looked = st.looked.includes(file);
  const unused = file === "facade" && !CALLERS.some((c) => st.via[c]);
  const status = ev ? (ev.ok ? (ev.silent ? "unscanned" : "ok") : "failed") : "";
  return (
    <section className={"pg-side facade-file" + (file === "facade" ? " hub" : "")} aria-label={file === "facade" ? "Deployer facade" : CALLER_NAME[caller!]}>
      <header>
        <h4>{file === "facade" ? "Deployer (facade)" : CALLER_NAME[caller!]}</h4>
        <span className={"pg-status" + (status === "ok" ? " done" : "")}>{status}</span>
      </header>
      <div className="pgc">
        <div className="pgc-line file"><code>{file === "facade" ? "deploy/deployer" : CALLER_FILE[caller!]}.{SYN[lang].ext}</code></div>
        {unused
          ? <div className="pgc-line"><code className="muted">{"// written, but no caller uses it yet"}</code></div>
          : scriptLines(st, file, lang).map((l, i) => (
            <div key={i} className={"pgc-line" + (l.fresh ? " new" : "")}><code>{l.text}</code></div>
          ))}
      </div>
      <div className="pg-actions">
        {st.change <= 2 && !unused && !edited && !looked && (
          <PgButton onClick={() => dispatch({ type: "edit", file })}>Apply change {st.change + 1} here</PgButton>
        )}
        {edited && <span className="facade-note good">Changed for request {st.change + 1}.</span>}
        {looked && <span className="facade-note">Opened it: nothing here needs this change.</span>}
        {caller && st.change <= 2 && (
          <PgButton onClick={() => dispatch({ type: "route", caller })}>{st.via[caller] ? "Go direct again" : "Use Deployer.Deploy"}</PgButton>
        )}
      </div>
    </section>
  );
}

export default function FacadePlayground() {
  const { lang } = usePrefs();
  const { state: st, dispatch, reduced } = useModel(step, init);
  const [guess, setGuess] = useState<Guess | null>(null);
  const req = CHANGES[Math.min(st.change, 2)];
  const finished = st.change > 2;
  const firstRun = st.results.length > 0 || (st.change === 0 && st.ships > 0);
  const totals = st.results.reduce((a, r) => ({ edits: a.edits + r.edits, late: a.late + r.late, best: a.best + r.best, broken: a.broken + r.broken, silent: a.silent + r.silent }), { edits: 0, late: 0, best: 0, broken: 0, silent: 0 });

  return (
    <PgFrame title="Four callers, one deploy subsystem that keeps changing" onReset={() => { setGuess(null); dispatch({ type: "reset" }); }}>
      <PgPredict<Guess>
        question="Security adds a mandatory image scan between build and push. You add it to the CI pipeline only, then everyone deploys. What does the ChatOps /deploy command do?"
        options={[{ value: "error", label: "It fails with an error" }, { value: "silent", label: "It deploys an unscanned image and reports success" }, { value: "auto", label: "It picks up the scan by itself" }]}
        value={guess} onChange={setGuess} revealed={firstRun} answer="silent"
        explain={<>A step that is missing raises no error. The bot runs its own copy of the steps, which never mentions the scanner, so it deploys and says &quot;done&quot;. Only a facade, where the steps live once, guarantees every caller gets the new step.</>}
      />

      {!finished ? (
        <div className="pg-req">
          <span className="label">Change request {st.change + 1} of 3 · from the platform team</span>
          <h3>{req.title}</h3>
          <p>{req.why}</p>
          <p className="pg-rule"><b>Apply the change where it is needed, then ship.</b> Each ship runs one deploy from every caller. You can move callers onto the Deployer facade at any time; each move is one edit to that caller.</p>
          <div className="pg-actions">
            <PgButton primary onClick={() => dispatch({ type: "ship" })}>Ship: every caller deploys ▶</PgButton>
            {st.ships > 0 && <PgButton onClick={() => dispatch({ type: "next" })}>{st.change < 2 ? "Next request →" : "See the summary →"}</PgButton>}
          </div>
        </div>
      ) : (
        <div className="pg-req" aria-live="polite">
          <span className="label">Summary · your three requests</span>
          <p>You made <b>{n(totals.edits, "edit")}</b> for three subsystem changes{totals.late ? `, ${totals.late} of them only after a deploy went wrong` : ""}, plus {n(st.refactors, "routing edit")}. Deploys broke {n(totals.broken, "time")}, and {n(totals.silent, "unscanned image")} reached production without an error.</p>
          <p className="pg-takeaway">
            {totals.edits <= totals.best && totals.broken + totals.silent === 0
              ? `The floor is ${totals.best}: one edit to the Deployer per change, plus the rollback script when the notifier changed. You hit it. The order of the steps lived in one place, and the rollback, which needs a different order, kept its own.`
              : `With the three deploy callers on the facade, the same requests cost ${totals.best} edits: the Deployer once per change, plus the rollback script when the notifier changed. Every copy of the steps is one more place a change has to reach, and a missing step fails silently.`}
          </p>
          <PgButton onClick={() => dispatch({ type: "reset" })}>Start over</PgButton>
        </div>
      )}

      <div className="facade-top">
        <Wiring st={st} />
        <dl className="pg-stats facade-stats">
          <div><dt>Dependencies</dt><dd>{wires(st)}</dd></div>
          <div><dt>Edits this request</dt><dd>{st.edited.length}{!finished ? ` (floor ${best(st.change)})` : ""}</dd></div>
          <div className={st.broken ? "bad" : ""}><dt>Failed deploys</dt><dd>{st.broken}</dd></div>
          <div className={st.silent ? "bad" : ""}><dt>Silent bad deploys</dt><dd>{st.silent}</dd></div>
        </dl>
      </div>

      <div className="facade-files">
        {([...CALLERS, "facade"] as File[]).map((f) => <FileCard key={f} st={st} file={f} lang={lang} dispatch={dispatch} />)}
      </div>

      {st.lastRun.length > 0 && (
        <>
          <span className="label">The last ship, caller by caller</span>
          <PgLog reduced={reduced} empty="" entries={st.lastRun.map((e) => ({ id: e.id, ok: e.ok && !e.silent, text: e.text, path: e.path }))} />
        </>
      )}

      {st.results.length > 0 && (
        <div className="facade-table" role="region" aria-label="Cost per request" tabIndex={0}>
          <table>
            <thead><tr><th>Request</th><th>Edits</th><th>Late</th><th>Floor</th><th>Failed</th><th>Silent</th></tr></thead>
            <tbody>
              {st.results.map((r, i) => (
                <tr key={i}><td>{i + 1}. {CHANGES[i].title}</td><td>{r.edits}</td><td>{r.late}</td><td>{r.best}</td><td>{r.broken}</td><td>{r.silent}</td></tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <PgSources links={[
        { title: "Refactoring.Guru's Facade", href: "https://refactoring.guru/design-patterns/facade" },
        { title: "Facebook's layered module-dependency graph", href: "https://engineering.fb.com/developer-tools/visualizing-facebook-s-php-codebase" },
      ]} />

      <style>{`
        .facade-top { display: grid; grid-template-columns: minmax(0, 1.6fr) minmax(0, 1fr); gap: 12px; align-items: start; }
        .facade-svg { width: 100%; height: auto; border: 1px solid var(--line); background: var(--bg); }
        .facade-wire { stroke: var(--ink-2); stroke-width: 1; opacity: .55; transition: opacity .2s; }
        .facade-wire.via { stroke: var(--accent); opacity: .9; stroke-width: 1.4; }
        .facade-box { fill: var(--surface); stroke: var(--line); }
        .facade-box.part { stroke: var(--ink-2); }
        .facade-hub { stroke: var(--accent); stroke-dasharray: 4 3; }
        .facade-hub.on { stroke-dasharray: none; stroke-width: 1.6; }
        .facade-t { font-family: var(--f-code); font-size: 11px; letter-spacing: .04em; text-transform: uppercase; fill: var(--ink); }
        .facade-s { font-family: var(--f-code); font-size: 9.5px; fill: var(--ink-2); }
        .facade-stats { grid-template-columns: 1fr 1fr; }
        .facade-files { display: grid; grid-template-columns: repeat(auto-fill, minmax(230px, 1fr)); gap: 10px; }
        .facade-file.hub { border-color: var(--accent); }
        .facade-note { font-size: .85rem; color: var(--ink-2); align-self: center; }
        .facade-note.good { color: var(--good); }
        .facade-table { overflow-x: auto; }
        .facade-table table { border-collapse: collapse; width: 100%; font-size: .8rem; font-family: var(--f-code); }
        .facade-table th, .facade-table td { border: 1px solid var(--line); padding: 3px 6px; text-align: left; }
        .facade-table th { font-size: .62rem; text-transform: uppercase; letter-spacing: .06em; color: var(--ink-2); }
        @media (max-width: 720px) { .facade-top { grid-template-columns: 1fr; } }
        @media (prefers-reduced-motion: reduce) { .facade-wire { transition: none; } }
      `}</style>
    </PgFrame>
  );
}
