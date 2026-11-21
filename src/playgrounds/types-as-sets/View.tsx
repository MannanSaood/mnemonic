"use client";
import { PgChoice, PgFrame, PgPredict, PgSources, useModel } from "../kit";
import {
  CHALLENGES, PREDICT_ANSWER, TYPE, TYPES, VALUE, VALUES, assignable, explain, init, members, readableKeys, regionOf,
  resultMembers, sameAs, step, type Op, type Predict, type Region, type State, type TypeId, type ValueId,
} from "./model";

const W = 560, H = 300;
const CA = { x: 210, y: 150 }, CB = { x: 350, y: 150 }, R = 120;
const SHORT: Record<ValueId, string> = {
  get: '"GET"', put: '"PUT"', delete: '"DELETE"', post: '"POST"', patch: '"PATCH"', lowerGet: '"get"',
  s200: "200", s503: "503", null: "null", undef: "undefined",
  reqGet: "{GET /inv}", reqPost: "{POST /chg}", reqPut: "{PUT /inv}", health: "{/healthz}", cfgDelete: "{DELETE ×3}", cfgPost: "{POST ×0}",
};

/** Slot centres for each region, filled top to bottom. */
function slots(region: Region, count: number): { x: number; y: number }[] {
  const col = (x: number, top: number, bottom: number, n: number) => {
    const gap = Math.min(22, (bottom - top) / Math.max(1, n));
    const start = (top + bottom) / 2 - (gap * (n - 1)) / 2;
    return Array.from({ length: n }, (_, i) => ({ x, y: start + i * gap }));
  };
  if (region === "aOnly") return col(150, 50, 250, count);
  if (region === "both") return col(280, 70, 230, count);
  if (region === "bOnly") return col(410, 50, 250, count);
  const left = Math.ceil(count / 2);
  return [...col(46, 16, 284, left), ...col(514, 16, 284, count - left)];
}

function layout(a: TypeId, b: TypeId) {
  const by: Record<Region, ValueId[]> = { aOnly: [], both: [], bOnly: [], neither: [] };
  for (const v of VALUES) by[regionOf(a, b, v.id)].push(v.id);
  const pos = {} as Record<ValueId, { x: number; y: number }>;
  (Object.keys(by) as Region[]).forEach((r) => slots(r, by[r].length).forEach((p, i) => { pos[by[r][i]] = p; }));
  return { by, pos };
}

function Venn({ st, onPick, reduced }: { st: State; onPick: (v: ValueId) => void; reduced: boolean }) {
  const { pos } = layout(st.a, st.b);
  const result = new Set(resultMembers(st.a, st.b, st.op));
  const union = st.op === "|";
  return (
    <svg className="tas-venn" viewBox={`0 0 ${W} ${H}`} role="img"
      aria-label={`Venn diagram. A is ${TYPE[st.a].name}, B is ${TYPE[st.b].name}. A ${st.op} B holds ${result.size} of ${VALUES.length} sample values.`}>
      <defs>
        <clipPath id="tas-clip-a"><circle cx={CA.x} cy={CA.y} r={R} /></clipPath>
      </defs>
      <rect x={1} y={1} width={W - 2} height={H - 2} className="tas-universe" />
      <text x={8} y={H - 8} className="tas-cap">unknown: every value</text>
      <circle cx={CA.x} cy={CA.y} r={R} className={"tas-set" + (union ? " on" : "")} />
      <circle cx={CB.x} cy={CB.y} r={R} className={"tas-set" + (union ? " on" : "")} />
      <circle cx={CB.x} cy={CB.y} r={R} clipPath="url(#tas-clip-a)" className="tas-lens" />
      <text x={CA.x - 70} y={CA.y - R + 2} className="tas-name" textAnchor="middle">A</text>
      <text x={CB.x + 70} y={CB.y - R + 2} className="tas-name" textAnchor="middle">B</text>
      {VALUES.map((v) => {
        const p = pos[v.id];
        const on = result.has(v.id);
        const sel = st.selected === v.id;
        const w = SHORT[v.id].length * 6.4 + 10;
        return (
          <g key={v.id} className={"tas-dot" + (on ? " in" : "") + (sel ? " sel" : "")} onClick={() => onPick(v.id)}
            style={{ transform: `translate(${p.x}px, ${p.y}px)`, transition: reduced ? "none" : "transform .45s var(--ease)" }} aria-hidden="true">
            <rect x={-w / 2} y={-9} width={w} height={18} />
            <text x={0} y={4} textAnchor="middle">{SHORT[v.id]}</text>
          </g>
        );
      })}
    </svg>
  );
}

const typeOptions = TYPES.map((t) => ({ value: t.id, label: t.name, note: t.def }));
const n = (k: number, one: string, many = one + "s") => `${k} ${k === 1 ? one : many}`;

function Relations({ st }: { st: State }) {
  const ab = assignable(st.a, st.b), ba = assignable(st.b, st.a);
  const line = (from: TypeId, to: TypeId, r: { ok: boolean; witness: ValueId | null }, side: string) => (
    <li className={r.ok ? "ok" : ""}>
      <code>{TYPE[from].name}</code> assignable to <code>{TYPE[to].name}</code>?{" "}
      {r.ok
        ? <b>yes</b>
        : <><b>no</b>: <code>{VALUE[r.witness!].js}</code> is in {side} only.</>}
      {r.ok && <> The {side}-only region is empty.</>}
    </li>
  );
  return (
    <ul className="tas-rel">
      {line(st.a, st.b, ab, "A")}
      {line(st.b, st.a, ba, "B")}
    </ul>
  );
}

function Why({ st }: { st: State }) {
  if (!st.selected) return <p className="pg-empty">Click any value, in the picture or in the list, to see why it lands where it does.</p>;
  const e = explain(st, st.selected);
  return (
    <div className={"pg-entry " + (e.inResult ? "ok" : "fail")} aria-live="polite">
      <span className="label"><code>{VALUE[st.selected].js}</code></span>
      <p>In A (<code>{TYPE[st.a].name}</code>)? {e.a}.<br />In B (<code>{TYPE[st.b].name}</code>)? {e.b}.</p>
      <p><b>{e.verdict}</b></p>
    </div>
  );
}

function Result({ st }: { st: State }) {
  const amt = members(st.a).length, bmt = members(st.b).length;
  const and = resultMembers(st.a, st.b, "&").length, or = resultMembers(st.a, st.b, "|").length;
  const kAnd = readableKeys(st.a, st.b, "&"), kOr = readableKeys(st.a, st.b, "|");
  const same = sameAs(st.a, st.b, st.op);
  const expr = `${TYPE[st.a].name} ${st.op} ${TYPE[st.b].name}`;
  let take: string;
  if (same === "never") take = "No value is in both, so the intersection is the empty set: never. A variable of this type can never be given a value.";
  else if (kAnd && kAnd.length > Math.max(TYPE[st.a].keys.length, TYPE[st.b].keys.length) && and < Math.min(amt, bmt))
    take = `A & B promises ${n(kAnd.length, "property", "properties")}, more than either side, and fits ${and} of these values instead of ${amt} or ${bmt}. Every requirement you add rules values out. A | B promises ${kOr && kOr.length ? kOr.join(", ") : "no property at all"} and fits ${or}.`;
  else if (same === "a" && st.op === "&") take = "A & B is the same set as A, because A sits inside B. Intersecting with a bigger set changes nothing.";
  else if (same === "b" && st.op === "|") take = "A | B is the same set as B, because A sits inside B. Adding a subset to a set adds nothing.";
  else if (st.op === "&") take = `& keeps only the values in both: ${and} here, never more than the smaller side (${Math.min(amt, bmt)}).`;
  else take = `| keeps every value in either: ${or} here, never fewer than the bigger side (${Math.max(amt, bmt)}). The wider the type, the less you may assume about a value of it.`;
  return (
    <div className="pg-result">
      <span className="label">What your types hold</span>
      <p>
        <code>{expr}</code> fits {st.op === "|" ? or : and} of the {VALUES.length} sample values.
        {" "}A alone fits {amt}, B alone {bmt}; A &amp; B fits {and}, A | B fits {or}.
        {kAnd && <> Properties you may read without a check: A &amp; B {kAnd.length ? kAnd.join(", ") : "none"}; A | B {kOr && kOr.length ? kOr.join(", ") : "none"}.</>}
        {same === "a" && <> Over these values the result is the same set as A.</>}
        {same === "b" && <> Over these values the result is the same set as B.</>}
      </p>
      <p className="pg-takeaway">{take}</p>
    </div>
  );
}

export default function TypesAsSetsPlayground() {
  const { state: st, dispatch, reduced } = useModel(step, init);
  const result = resultMembers(st.a, st.b, st.op);

  return (
    <PgFrame title="Drop values into two types" onReset={() => dispatch({ type: "reset" })}>
      <style>{CSS}</style>
      <div className="pg-req">
        <span className="label">The setup</span>
        <p>Sixteen values an HTTP client really meets: method strings, status codes, <code>null</code>, <code>undefined</code> and request objects. Pick a type for A and for B. Each value moves to the region it belongs to, and the shaded area is <code>A {st.op} B</code>.</p>
        <p className="pg-rule"><b>A type is a set of values. Assignable means subset.</b></p>
      </div>

      <PgPredict<Predict>
        question="{ method: Method } & { url: string } promises more properties than either side. Compared with each side alone, does it hold more values, fewer, or the same?"
        options={[{ value: "more", label: "More" }, { value: "fewer", label: "Fewer" }, { value: "same", label: "The same" }]}
        value={st.predict}
        onChange={(v) => dispatch({ type: "predict", value: v })}
        revealed={st.revealed}
        answer={PREDICT_ANSWER}
        explain={<>A value is in A &amp; B only if it is in A and also in B, so the intersection can never be bigger than either side. Each extra property is one more test a value must pass. The objects with no url, or with no method, drop out.</>}
      />

      <div className="tas-pick">
        <div className="tas-row"><span className="tas-tag">A =</span>
          <PgChoice<TypeId> label="Type A" value={st.a} options={typeOptions} onChange={(t) => dispatch({ type: "setA", t })} />
        </div>
        <div className="tas-ops">
          <PgChoice<Op> label="Operator" value={st.op}
            options={[{ value: "|", label: "A | B (union)" }, { value: "&", label: "A & B (intersection)" }]}
            onChange={(op) => dispatch({ type: "op", op })} />
          <button className="pg-btn ghost" onClick={() => dispatch({ type: "swap" })}>Swap A and B</button>
        </div>
        <div className="tas-row"><span className="tas-tag">B =</span>
          <PgChoice<TypeId> label="Type B" value={st.b} options={typeOptions} onChange={(t) => dispatch({ type: "setB", t })} />
        </div>
      </div>

      <p className="tas-defs"><b>A</b> <code>{TYPE[st.a].name}</code>: {TYPE[st.a].def}. <b>B</b> <code>{TYPE[st.b].name}</code>: {TYPE[st.b].def}.</p>

      <div className="tas-wrap">
        <Venn st={st} onPick={(v) => dispatch({ type: "select", v })} reduced={reduced} />
      </div>

      <div className="tas-values" role="group" aria-label="Sample values">
        {VALUES.map((v) => (
          <button key={v.id} className={"tas-chip" + (result.includes(v.id) ? " in" : "")} aria-pressed={st.selected === v.id}
            onClick={() => dispatch({ type: "select", v: v.id })}>
            <code>{v.js}</code>
          </button>
        ))}
      </div>

      <div className="pg-grid">
        <Why st={st} />
        <div className="tas-relbox">
          <span className="label">Assignability, read off the picture</span>
          <Relations st={st} />
        </div>
      </div>

      <dl className="pg-stats">
        <div><dt>In A</dt><dd>{members(st.a).length}</dd></div>
        <div><dt>In B</dt><dd>{members(st.b).length}</dd></div>
        <div><dt>In A {st.op} B</dt><dd>{result.length}</dd></div>
        <div className={result.length === 0 ? "bad" : ""}><dt>Result</dt><dd>{result.length === 0 ? "never" : `${result.length}/${VALUES.length}`}</dd></div>
      </dl>

      <Result st={st} />

      <div className="tas-challenges">
        <span className="label">Challenges</span>
        <ul>
          {CHALLENGES.map((c) => <li key={c.id} className={st.done.includes(c.id) ? "done" : ""}>{st.done.includes(c.id) ? "✓ " : "○ "}{c.text}</li>)}
        </ul>
      </div>

      <PgSources links={[
        { title: "the TypeScript Handbook on unions and intersections", href: "https://www.typescriptlang.org/docs/handbook/2/everyday-types.html#union-types" },
        { title: "Making sense of TypeScript using set theory", href: "https://dev.to/thoughtspile/making-sense-of-typescript-using-set-theory-lj7" },
        { title: "Learn TypeScript: sets of values", href: "https://learntypescript.dev/04/l8-sets-of-values" },
      ]} />
    </PgFrame>
  );
}

const CSS = `
.tas-pick { display: grid; gap: 8px; }
.tas-row { display: grid; grid-template-columns: 2.4em 1fr; gap: 6px; align-items: start; }
.tas-tag { font-family: var(--f-code); font-size: .8rem; font-weight: 600; padding-top: 6px; }
.tas-row .pg-choice { flex-wrap: wrap; }
.tas-ops { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; padding-left: 2.4em; }
.tas-defs { margin: 0; font-size: .92rem; }
.tas-wrap { border: 1px solid var(--line); background: var(--bg); }
.tas-venn { display: block; width: 100%; height: auto; }
.tas-universe { fill: none; stroke: var(--line); stroke-dasharray: 4 3; }
.tas-cap { font-family: var(--f-code); font-size: 10px; letter-spacing: .06em; text-transform: uppercase; fill: var(--ink-2); }
.tas-set { fill: transparent; stroke: var(--ink-2); stroke-width: 1.5; transition: fill .3s var(--ease); }
.tas-set.on { fill: var(--hl); }
.tas-lens { fill: var(--hl); stroke: var(--accent); stroke-width: 2; }
.tas-name { font-family: var(--f-code); font-size: 15px; font-weight: 700; fill: var(--ink); }
.tas-dot { cursor: pointer; }
.tas-dot rect { fill: var(--surface); stroke: var(--line); }
.tas-dot text { font-family: var(--f-code); font-size: 11px; fill: var(--ink-2); }
.tas-dot.in rect { fill: var(--accent); stroke: var(--accent); }
.tas-dot.in text { fill: var(--accent-ink); font-weight: 600; }
.tas-dot.sel rect { stroke: var(--pain); stroke-width: 2.5; }
.tas-values { display: flex; flex-wrap: wrap; gap: 4px; }
.tas-chip { border: 1px solid var(--line); background: var(--surface); color: var(--ink-2); padding: 2px 6px; font-size: .78rem; cursor: pointer; }
.tas-chip.in { border-color: var(--accent); color: var(--ink); background: var(--hl); }
.tas-chip[aria-pressed="true"] { outline: 2px solid var(--pain); outline-offset: 1px; }
.tas-relbox { border: 1px solid var(--line); background: var(--bg); padding: 10px 12px; display: grid; gap: 6px; align-content: start; }
.tas-rel { margin: 0; padding-left: 1.1em; display: grid; gap: 6px; font-size: .92rem; }
.tas-rel li.ok b { color: var(--good); }
.tas-challenges ul { list-style: none; margin: 4px 0 0; padding: 0; display: grid; gap: 3px; font-size: .95rem; }
.tas-challenges li.done { color: var(--good); }
@media (prefers-reduced-motion: reduce) { .tas-set, .tas-dot { transition: none !important; } }
`;
