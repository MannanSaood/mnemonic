"use client";
import { useState } from "react";
import { usePrefs } from "@/components/Prefs";
import type { Lang } from "@/lib/types";
import { PgButton, PgChoice, PgFrame, PgPredict, PgSources, useModel } from "../kit";
import {
  BEST, FIELDS, HEADER, INFO, LINE_OPTIONS, POINTER, combos, goals, init, memory, step,
  type Field, type Lines,
} from "./model";

const mb = (b: number) => (b >= 1e9 ? `${(b / 1e9).toFixed(2)} GB` : b >= 1e6 ? `${Math.round(b / 1e6).toLocaleString("en-US")} MB` : `${Math.round(b / 1e3).toLocaleString("en-US")} KB`);
const num = (k: number) => Math.round(k).toLocaleString("en-US");
const short = (l: number) => (l >= 1e6 ? `${l / 1e6}M` : `${l / 1e3}k`);

const HOW: Record<Lang, string> = {
  go: "unique.Make(meta) (Go 1.23) returns a unique.Handle[LogMeta]. Equal values share one copy, and comparing two handles is a pointer compare. Before 1.23, a map[LogMeta]*LogMeta does the same job.",
  python: "sys.intern(s) shares one copy of a string. For a whole record, keep a dict of frozen dataclasses and hand out the same object. __slots__ shrinks each line object by dropping its __dict__.",
  typescript: "V8 interns string literals and property names, but not strings built at runtime, such as parsed log fields. Keep a Map from key to a frozen LogMeta and hand out the same object; each line holds a reference.",
  rust: "Keep a HashMap from LogMeta to Arc<LogMeta> and give each line a clone of the Arc: one pointer, plus a reference count in the shared allocation. Interning crates go further and replace strings with small integer ids.",
};

type Guess = "3GB" | "1GB" | "30MB";

function Chip({ f, shared, onClick }: { f: Field; shared: boolean; onClick: () => void }) {
  const i = INFO[f];
  return (
    <button className={"flyweight-chip" + (shared ? " shared" : "")} onClick={onClick} aria-pressed={shared}
      aria-label={`${i.label}, ${i.bytes} bytes, ${i.note}. ${shared ? "Shared; press to keep it on each line" : "On each line; press to share it"}`}>
      <span className="flyweight-name">{i.label}</span>
      <code>{i.example}</code>
      <span className="flyweight-meta">{i.bytes} B · {i.note}</span>
      <span className="flyweight-move" aria-hidden="true">{shared ? "← per line" : "share →"}</span>
    </button>
  );
}

export default function FlyweightPlayground() {
  const { lang } = usePrefs();
  const { state: st, dispatch, reduced } = useModel(step, init);
  const [guess, setGuess] = useState<Guess | null>(null);
  const m = memory(st.shared, st.lines);
  const scale = Math.max(m.naive, m.total);
  const perLine = FIELDS.filter((f) => !st.shared.includes(f));
  const g = goals(st);
  const measured = st.tried.some((t) => t.lines === 10_000_000 && t.shared.length > 0);
  const best10 = memory(BEST, 10_000_000);
  const bestTried = st.tried.filter((t) => t.lines === 10_000_000).sort((a, b) => a.bytes - b.bytes)[0];
  const perObject = m.poolObjects ? st.lines / m.poolObjects : 0;

  return (
    <PgFrame title="Ten million log lines in memory" onReset={() => { setGuess(null); dispatch({ type: "reset" }); }}>
      <PgPredict<Guess>
        question="10 million log lines take 3.2 GB as plain objects. Move the six fields that repeat (level, service, host, region, version, template) into shared objects. How much memory do the lines take now?"
        options={[{ value: "3GB", label: "Still about 3 GB" }, { value: "1GB", label: "About 1 GB" }, { value: "30MB", label: "About 30 MB" }]}
        value={guess} onChange={setGuess} revealed={measured} answer="1GB"
        explain={<>That split comes to {mb(best10.total)}. The {num(best10.poolObjects)} shared objects take about {mb(best10.pool)}; almost everything left is the fields that are different on every line (timestamp, trace id, args), which sharing cannot touch.</>}
      />

      <div className="flyweight-record">
        <section className="pg-side" aria-label="Stored on every line (extrinsic)">
          <header><h4>On every line</h4><span className="pg-status">extrinsic</span></header>
          <p className="muted">Each of the {short(st.lines)} lines stores these, plus a {HEADER} B header{st.shared.length ? ` and an ${POINTER} B pointer to its shared object` : ""}.</p>
          <div className="flyweight-chips">
            {perLine.map((f) => <Chip key={f} f={f} shared={false} onClick={() => dispatch({ type: "toggle", field: f })} />)}
            {!perLine.length && <p className="pg-empty">Nothing left on the line but the pointer.</p>}
          </div>
        </section>
        <section className="pg-side flyweight-pool" aria-label="Shared objects (intrinsic)">
          <header><h4>Shared</h4><span className="pg-status done">intrinsic</span></header>
          <p className="muted">{st.shared.length ? `${num(m.poolObjects)} shared objects, each used by about ${num(perObject)} lines.` : "Press a field to move it into a shared object."}</p>
          <div className="flyweight-chips">
            {st.shared.map((f) => <Chip key={f} f={f} shared onClick={() => dispatch({ type: "toggle", field: f })} />)}
          </div>
        </section>
      </div>

      <div className="pg-actions">
        <PgChoice<`${Lines}`> label="Lines loaded" value={`${st.lines}` as `${Lines}`}
          options={LINE_OPTIONS.map((l) => ({ value: `${l}` as `${Lines}`, label: `${short(l)} lines` }))}
          onChange={(v) => dispatch({ type: "lines", lines: Number(v) as Lines })} />
        <PgButton primary onClick={() => dispatch({ type: "measure" })}>Measure this split</PgButton>
      </div>

      <div className="flyweight-bars" aria-live="polite">
        <div className="flyweight-bar">
          <span className="label">Every field on every line</span>
          <span className="flyweight-track"><i className="naive" style={{ width: `${(m.naive / scale) * 100}%` }} /></span>
          <b>{mb(m.naive)}</b>
        </div>
        <div className="flyweight-bar">
          <span className="label">Your split</span>
          <span className="flyweight-track">
            <i className={"lines" + (reduced ? "" : " anim")} style={{ width: `${(m.lineBytes / scale) * 100}%` }} />
            <i className={"pool" + (reduced ? "" : " anim")} style={{ width: `${(m.pool / scale) * 100}%` }} />
          </span>
          <b className={m.total > m.naive ? "flyweight-bad" : ""}>{mb(m.total)}</b>
        </div>
        <p className="flyweight-legend"><span className="lines" /> per-line data <span className="pool" /> shared pool (objects plus the factory&apos;s map)</p>
      </div>

      <dl className="pg-stats">
        <div><dt>Bytes per line</dt><dd>{num(m.lineBytes / st.lines)}</dd></div>
        <div><dt>Shared objects</dt><dd>{num(m.poolObjects)}</dd></div>
        <div><dt>Pool size</dt><dd>{mb(m.pool)}</dd></div>
        <div className={m.total > m.naive ? "bad" : ""}><dt>vs plain</dt><dd>{Math.round((m.total / m.naive) * 100)}%</dd></div>
      </dl>

      {m.total > m.naive && (
        <p className="pg-takeaway">Worse than no sharing. A field that is different on every line made every shared object unique: {num(m.poolObjects)} objects for {num(st.lines)} lines, each now paying for a pointer and a map entry on top.</p>
      )}
      {m.total <= m.naive && st.shared.length > 0 && combos(st.shared, st.lines) > st.lines / 2 && (
        <p className="pg-takeaway">At {short(st.lines)} lines most combinations appear only once or twice, so there is little to share yet. Flyweight pays off when the number of objects is far larger than the number of distinct shared states.</p>
      )}

      <div className="pg-req">
        <span className="label">Break it: write to a shared object</span>
        <p>Line 42 was logged as ERROR by mistake. The on-call engineer sets its level to WARN.</p>
        <div className="pg-actions"><PgButton onClick={() => dispatch({ type: "editLine" })}>Set line 42 to WARN</PgButton></div>
        {st.edit && (
          <p className={st.edit.changed > 1 ? "flyweight-bad" : ""} aria-live="polite">
            {st.edit.changed > 1
              ? `${num(st.edit.changed)} lines changed level. The level lives in a shared object, so the write landed on every line that points at it. Shared state must be immutable; to change one line, point it at a different shared object.`
              : "One line changed. The level is stored on the line itself (or every line has its own object), so the write stays local."}
          </p>
        )}
      </div>

      <p className="flyweight-how"><span className="label">How you share it here</span> {HOW[lang]}</p>

      {st.tried.length > 0 && (
        <div className="flyweight-table" role="region" aria-label="Your measurements" tabIndex={0}>
          <table>
            <thead><tr><th>Lines</th><th>Shared fields</th><th>Memory</th><th>vs plain</th></tr></thead>
            <tbody>
              {st.tried.slice(-6).map((t, i) => (
                <tr key={i}><td>{short(t.lines)}</td><td>{t.shared.map((f) => INFO[f].label).join(", ") || "none"}</td><td>{mb(t.bytes)}</td><td>{Math.round((t.bytes / t.naive) * 100)}%</td></tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {bestTried && (
        <p className="pg-takeaway">Your best split at 10M lines: {mb(bestTried.bytes)}, against {mb(bestTried.naive)} with every field on every line{bestTried.bytes <= best10.total ? ". That is the floor: everything that repeats is shared, everything that varies stays on the line." : `. The floor is ${mb(best10.total)}: share every field that repeats, and nothing that varies per line.`}</p>
      )}

      <div className="pg-req">
        <span className="label">Challenges</span>
        <ul className="flyweight-goals">
          <li className={g.third ? "done" : ""}>{g.third ? "✓" : "○"} Measure a split under 35% of plain at 10M lines.</li>
          <li className={g.best ? "done" : ""}>{g.best ? "✓" : "○"} Find the cheapest split of all.</li>
          <li className={g.worse ? "done" : ""}>{g.worse ? "✓" : "○"} Measure a split that uses more memory than no sharing.</li>
          <li className={g.mutated ? "done" : ""}>{g.mutated ? "✓" : "○"} Make one line&apos;s edit change hundreds of lines.</li>
        </ul>
      </div>

      <PgSources links={[
        { title: "Game Programming Patterns' Flyweight", href: "https://gameprogrammingpatterns.com/flyweight.html" },
        { title: "Refactoring.Guru's Flyweight", href: "https://refactoring.guru/design-patterns/flyweight" },
        { title: "the Go blog on the unique package", href: "https://go.dev/blog/unique" },
      ]} />

      <style>{`
        .flyweight-record { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); gap: 12px; }
        .flyweight-pool { border-color: var(--accent); }
        .flyweight-chips { display: grid; gap: 6px; }
        .flyweight-chip { display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: 2px 8px; text-align: left; border: 1px solid var(--line); background: var(--surface); padding: 6px 8px; transition: border-color .2s, background .2s; }
        .flyweight-chip.shared { border-color: var(--accent); background: var(--hl); }
        .flyweight-chip:hover { border-color: var(--ink-2); }
        .flyweight-name { font-family: var(--f-code); font-size: .72rem; letter-spacing: .06em; text-transform: uppercase; }
        .flyweight-chip code { grid-column: 1; font-size: .7rem; background: none; padding: 0; word-break: break-all; }
        .flyweight-meta { grid-column: 1; font-size: .78rem; color: var(--ink-2); }
        .flyweight-move { grid-column: 2; grid-row: 1 / span 3; align-self: center; font-family: var(--f-code); font-size: .66rem; color: var(--accent); white-space: nowrap; }
        .flyweight-bars { display: grid; gap: 6px; }
        .flyweight-bar { display: grid; grid-template-columns: 12em minmax(0, 1fr) 6.5em; gap: 8px; align-items: center; }
        .flyweight-bar b { font-family: var(--f-code); font-size: .85rem; text-align: right; font-variant-numeric: tabular-nums; }
        .flyweight-track { display: flex; height: 18px; border: 1px solid var(--line); background: var(--surface); }
        .flyweight-track i { display: block; height: 100%; }
        .flyweight-track i.anim { transition: width .35s var(--ease); }
        .flyweight-track .naive, .flyweight-legend .lines, .flyweight-track .lines { background: var(--ink-2); }
        .flyweight-track .pool, .flyweight-legend .pool { background: var(--accent); }
        .flyweight-legend { margin: 0; font-size: .8rem; color: var(--ink-2); display: flex; gap: 6px; align-items: center; flex-wrap: wrap; }
        .flyweight-legend span { display: inline-block; width: 10px; height: 10px; }
        .flyweight-bad { color: var(--pain) !important; }
        .flyweight-how { margin: 0; font-size: .92rem; }
        .flyweight-table { overflow-x: auto; }
        .flyweight-table table { border-collapse: collapse; width: 100%; font-size: .8rem; font-family: var(--f-code); }
        .flyweight-table th, .flyweight-table td { border: 1px solid var(--line); padding: 3px 6px; text-align: left; }
        .flyweight-table th { font-size: .62rem; text-transform: uppercase; letter-spacing: .06em; color: var(--ink-2); }
        .flyweight-goals { list-style: none; padding-left: 0 !important; }
        .flyweight-goals li.done { color: var(--good); }
        @media (max-width: 720px) {
          .flyweight-record { grid-template-columns: 1fr; }
          .flyweight-bar { grid-template-columns: 1fr auto; }
          .flyweight-bar .flyweight-track { grid-column: 1 / -1; grid-row: 2; }
        }
        @media (prefers-reduced-motion: reduce) { .flyweight-chip, .flyweight-track i.anim { transition: none; } }
      `}</style>
    </PgFrame>
  );
}
