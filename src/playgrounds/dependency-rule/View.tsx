"use client";
import { usePrefs } from "@/components/Prefs";
import type { Lang } from "@/lib/types";
import { PgButton, PgFrame, PgPredict, PgSources, useModel } from "../kit";
import {
  CHALLENGES, PREDICT_ANSWER, RING, RING_NAME, SHORTCUTS, SWAPS, SWAP_IDS,
  breaksRule, challengeDone, edges, inCycle, init, predictRevealed, step, swapCost, testDrags, violations,
  type Mod, type ShortcutId, type State, type SwapId, type SwapResult,
} from "./model";

const n = (k: number, one: string, many = one + "s") => `${k} ${k === 1 ? one : many}`;

/** Names of the outer-ring pieces, before and after each swap, in the reader's language. */
const TECH: Record<Lang, { web: [string, string]; driver: [string, string]; smtp: string }> = {
  go: { web: ["gin", "echo"], driver: ["pgx", "aws-sdk-go-v2"], smtp: "net/smtp" },
  python: { web: ["Flask", "FastAPI"], driver: ["SQLAlchemy", "boto3"], smtp: "smtplib" },
  typescript: { web: ["Express", "Fastify"], driver: ["pg", "@aws-sdk/client-dynamodb"], smtp: "nodemailer" },
  rust: { web: ["actix-web", "axum"], driver: ["sqlx", "aws-sdk-dynamodb"], smtp: "lettre" },
};

/** The file and the import line of each shortcut, per language. */
const LINES: Record<Lang, Record<ShortcutId, { file: string; line: string }>> = {
  go: {
    ucDriver: { file: "refund/issue.go", line: 'import "github.com/jackc/pgx/v5/pgconn"' },
    ucRepo: { file: "refund/issue.go", line: 'import "shop/internal/postgres"' },
    ucWeb: { file: "refund/issue.go", line: 'import "github.com/gin-gonic/gin"' },
    entityDb: { file: "refund/order.go", line: 'import "github.com/jackc/pgx/v5/pgtype"' },
    handlerRepo: { file: "httpapi/refunds.go", line: 'import "shop/internal/postgres"' },
  },
  python: {
    ucDriver: { file: "shop/refunds/issue.py", line: "from sqlalchemy.exc import OperationalError" },
    ucRepo: { file: "shop/refunds/issue.py", line: "from shop.adapters.postgres import PgOrders" },
    ucWeb: { file: "shop/refunds/issue.py", line: "from flask import request" },
    entityDb: { file: "shop/domain/order.py", line: "from sqlalchemy.orm import Mapped, mapped_column" },
    handlerRepo: { file: "shop/web/refunds.py", line: "from shop.adapters.postgres import PgOrders" },
  },
  typescript: {
    ucDriver: { file: "src/refunds/issue.ts", line: 'import { DatabaseError } from "pg";' },
    ucRepo: { file: "src/refunds/issue.ts", line: 'import { PgOrders } from "../adapters/postgres";' },
    ucWeb: { file: "src/refunds/issue.ts", line: 'import type { Request } from "express";' },
    entityDb: { file: "src/domain/order.ts", line: 'import type { QueryResultRow } from "pg";' },
    handlerRepo: { file: "src/web/refunds.ts", line: 'import { PgOrders } from "../adapters/postgres";' },
  },
  rust: {
    ucDriver: { file: "refunds/src/issue.rs", line: "use sqlx::error::DatabaseError;" },
    ucRepo: { file: "refunds/src/issue.rs", line: "use pg_adapter::PgOrders;" },
    ucWeb: { file: "refunds/src/issue.rs", line: "use actix_web::HttpRequest;" },
    entityDb: { file: "domain/src/order.rs", line: "use sqlx::FromRow;" },
    handlerRepo: { file: "web/src/refunds.rs", line: "use pg_adapter::PgOrders;" },
  },
};

function title(m: Mod, lang: Lang, swap: SwapId | null): string {
  const t = TECH[lang];
  switch (m) {
    case "entity": return "Order";
    case "usecase": return "IssueRefund";
    case "handler": return swap === "web" ? `${t.web[1]} handler` : "HTTP handler";
    case "pgrepo": return swap === "db" ? "DynamoDB orders" : "Postgres orders";
    case "mailer": return "Email notifier";
    case "web": return swap === "web" ? t.web[1] : t.web[0];
    case "driver": return swap === "db" ? t.driver[1] : t.driver[0];
    case "smtp": return t.smtp;
    case "main": return "main";
  }
}
const SUB: Record<Mod, string> = {
  entity: "entity · refund rules", usecase: "use case · owns ports", handler: "adapter", pgrepo: "adapter · implements Orders",
  mailer: "adapter · implements Notifier", web: "web framework", driver: "database library", smtp: "mail library", main: "wires everything",
};

/* ---------------- the rings ---------------- */

interface Box { x: number; y: number; w: number; h: number }
const RINGS: Box[] = [
  { x: 196, y: 172, w: 168, h: 58 },
  { x: 110, y: 98, w: 340, h: 144 },
  { x: 24, y: 50, w: 512, h: 238 },
  { x: 2, y: 2, w: 556, h: 334 },
];
const AT: Record<Mod, Box> = {
  web: { x: 40, y: 12, w: 150, h: 30 },
  main: { x: 370, y: 12, w: 150, h: 30 },
  handler: { x: 40, y: 60, w: 150, h: 30 },
  usecase: { x: 200, y: 110, w: 160, h: 32 },
  entity: { x: 210, y: 186, w: 140, h: 32 },
  pgrepo: { x: 40, y: 250, w: 150, h: 30 },
  mailer: { x: 370, y: 250, w: 150, h: 30 },
  driver: { x: 40, y: 298, w: 150, h: 30 },
  smtp: { x: 370, y: 298, w: 150, h: 30 },
};
const center = (b: Box) => ({ x: b.x + b.w / 2, y: b.y + b.h / 2 });

/** Where the segment from the center of a to the center of b leaves box b's border. */
function clip(a: Box, b: Box, pad = 2) {
  const p = center(a), q = center(b);
  const dx = p.x - q.x, dy = p.y - q.y;
  const sx = dx === 0 ? Infinity : (b.w / 2 + pad) / Math.abs(dx);
  const sy = dy === 0 ? Infinity : (b.h / 2 + pad) / Math.abs(dy);
  const t = Math.min(sx, sy);
  return { x: q.x + dx * t, y: q.y + dy * t };
}

function Rings({ st, lang, r }: { st: State; lang: Lang; r: SwapResult | null }) {
  const es = edges(st.on);
  const cyc = inCycle(st.on);
  const tone = (m: Mod) => {
    if (r && st.swap && (m === r.rewritten || m === SWAPS[st.swap].replaced)) return "new";
    if (r?.edited.includes(m)) return "edited";
    if (r?.retested.includes(m)) return "rebuilt";
    return "";
  };
  return (
    <svg className="dr-graph" viewBox="0 0 560 338" role="img"
      aria-label={`Import graph in four rings. ${n(violations(st.on).length, "import")} point outward and break the rule.`}>
      <defs>
        <marker id="dr-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
          <path d="M0,0 L10,5 L0,10 z" className="dr-head" />
        </marker>
        <marker id="dr-arrow-bad" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
          <path d="M0,0 L10,5 L0,10 z" className="dr-head bad" />
        </marker>
      </defs>
      {[3, 2, 1, 0].map((i) => (
        <g key={i}>
          <rect className={`dr-ring r${i}`} x={RINGS[i].x} y={RINGS[i].y} width={RINGS[i].w} height={RINGS[i].h} />
          <text className="dr-ringname" x={RINGS[i].x + RINGS[i].w - 6} y={RINGS[i].y + (i === 0 ? RINGS[i].h - 5 : 12)} textAnchor="end">{RING_NAME[i]}</text>
        </g>
      ))}
      {es.map((e) => {
        const a = AT[e.from], b = AT[e.to];
        const s = clip(b, a), t = clip(a, b);
        const bad = breaksRule(e);
        return (
          <line key={`${e.from}-${e.to}`} className={"dr-edge" + (bad ? " bad" : "") + (e.shortcut && !bad ? " side" : "")}
            x1={s.x} y1={s.y} x2={t.x} y2={t.y} markerEnd={`url(#${bad ? "dr-arrow-bad" : "dr-arrow"})`} />
        );
      })}
      {(Object.keys(AT) as Mod[]).map((m) => {
        const b = AT[m];
        return (
          <g key={m} className={"dr-node " + tone(m) + (cyc.includes(m) ? " cyc" : "")}>
            <rect x={b.x} y={b.y} width={b.w} height={b.h} />
            <text className="t" x={b.x + b.w / 2} y={b.y + b.h / 2 - 2} textAnchor="middle">{title(m, lang, st.swap)}</text>
            <text className="s" x={b.x + b.w / 2} y={b.y + b.h / 2 + 10} textAnchor="middle">{SUB[m]}</text>
          </g>
        );
      })}
    </svg>
  );
}

/* ---------------- the import lines the reader can add ---------------- */

function Imports({ st, lang, dispatch }: { st: State; lang: Lang; dispatch: (a: Parameters<typeof step>[1]) => void }) {
  return (
    <ul className="dr-lines">
      {SHORTCUTS.map((s) => {
        const on = st.on.includes(s.id);
        const bad = breaksRule(s);
        const l = LINES[lang][s.id];
        return (
          <li key={s.id} className={on ? (bad ? "on bad" : "on ok") : ""}>
            <button aria-pressed={on} onClick={() => dispatch({ type: "toggle", id: s.id })}>
              <span className="dr-file">{l.file}</span>
              <code>{on ? "+ " : "  "}{l.line}</code>
            </button>
            <span className="dr-why">
              {s.why}
              {on && (bad
                ? <b> Breaks the rule: {RING_NAME[RING[s.from]].toLowerCase()} now name {RING_NAME[RING[s.to]].toLowerCase()}.</b>
                : <b> Allowed: both sides are adapters, in the same ring.</b>)}
            </span>
          </li>
        );
      })}
    </ul>
  );
}

function SwapReport({ st, lang, r }: { st: State; lang: Lang; r: SwapResult }) {
  const id = st.swap!;
  const t = TECH[lang];
  const tech = id === "db" ? `${t.driver[0]} to ${t.driver[1]}` : `${t.web[0]} to ${t.web[1]}`;
  const bad = r.business.length > 0;
  return (
    <div className={"pg-entry" + (bad ? " fail" : " ok")} aria-live="polite">
      <div className="pg-path" aria-hidden="true"><span>{SWAPS[id].title}</span><span>{tech}</span></div>
      <p>
        {title(r.rewritten, lang, id)} was rewritten and main changed one line, as expected.{" "}
        {r.edited.length === 0
          ? "Nothing else was edited: no file in the rings inside it names the old technology."
          : `Also edited: ${r.edited.map((m) => title(m, lang, null)).join(", ")}, because ${r.edited.length === 1 ? "it imports" : "they import"} the old technology directly.`}
        {r.retested.length > 0 && ` Rebuilt and retested: ${r.retested.map((m) => title(m, lang, null)).join(", ")}.`}
        {bad && ` That is ${n(r.business.length, "business file")} edited for a decision about ${id === "db" ? "storage" : "HTTP"}.`}
      </p>
    </div>
  );
}

function Compare({ st }: { st: State }) {
  const rows = SWAP_IDS.map((id) => ({ id, clean: swapCost([], id), mine: swapCost(st.on, id) }));
  return (
    <table className="dr-table">
      <caption className="label">Each swap, the rule-following design vs your imports</caption>
      <thead><tr><th /><th scope="col">Follows the rule</th><th scope="col">With your imports</th></tr></thead>
      <tbody>
        {rows.map(({ id, clean, mine }) => (
          <tr key={id}>
            <th scope="row">{SWAPS[id].title}</th>
            <td>{n(clean.business.length, "business edit")} · {n(clean.edited.length, "extra file")}</td>
            <td className={mine.business.length ? "bad" : ""}>{n(mine.business.length, "business edit")} · {n(mine.edited.length, "extra file")}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function Result({ st, lang }: { st: State; lang: Lang }) {
  if (!st.log.length && !st.on.length) return null;
  const v = violations(st.on);
  const drags = testDrags(st.on);
  const db = swapCost(st.on, "db"), web = swapCost(st.on, "web");
  return (
    <div className="pg-result" aria-live="polite">
      <span className="label">What your imports cost</span>
      <p>
        Your design has {n(v.length, "import")} pointing outward. Moving the database would edit {n(db.business.length, "business file")} and {n(db.edited.length, "file")} beyond the adapter and main;
        replacing the web framework would edit {n(web.business.length, "business file")}. The use case&apos;s unit test {drags.length
          ? <>drags in {drags.map((m) => title(m, lang, null)).join(", ")}</>
          : <>runs with plain in-memory fakes</>}.
        {inCycle(st.on).length > 0 && " Your imports also form a cycle, which Go and Cargo refuse to build."}
      </p>
      <p className="pg-takeaway">
        Every arrow that points inward makes the ring it starts in replaceable. One arrow that points outward ties the business rules to a technology, and from then on every change to that technology, and every test of those rules, has to go through them.
      </p>
    </div>
  );
}

export default function DependencyRulePlayground() {
  const { lang } = usePrefs();
  const { state: st, dispatch } = useModel(step, init);
  const r = st.swap ? swapCost(st.on, st.swap) : null;
  const v = violations(st.on);
  const drags = testDrags(st.on);

  return (
    <PgFrame title="A refund service in rings" onReset={() => dispatch({ type: "reset" })}>
      <style>{CSS}</style>
      <div className="pg-req">
        <span className="label">The setup</span>
        <p>Each box is a package, each arrow an import. The rule: nothing in the two inner rings may name anything outside them. Adapters may import the library they wrap; that is their job. Add the shortcut imports below, then swap the database or the web framework and count what has to change.</p>
      </div>

      <PgPredict
        question="This design follows the rule. The team moves from Postgres to DynamoDB. How many files in the two inner rings must change?"
        options={[{ value: "0", label: "None" }, { value: "1", label: "1" }, { value: "2", label: "2" }, { value: "all", label: "Most of them" }]}
        value={st.predict}
        onChange={(x) => dispatch({ type: "predict", value: x })}
        revealed={predictRevealed(st)}
        answer={PREDICT_ANSWER}
        explain={<>None. The use case owns the Orders port and nothing inside names the database. The Postgres adapter is replaced by a DynamoDB one and main wires it in. Try it again with a shortcut import switched on.</>}
      />

      <div className="pg-actions" role="group" aria-label="Swap an outer ring">
        {SWAP_IDS.map((id) => (
          <PgButton key={id} primary={st.swap === id} onClick={() => dispatch({ type: "swap", swap: id })} title={SWAPS[id].why}>
            {SWAPS[id].title}
          </PgButton>
        ))}
      </div>

      <Rings st={st} lang={lang} r={r} />
      <p className="dr-legend"><span className="bad">breaks the rule</span> <span className="edited">edited</span> <span className="rebuilt">retested</span> <span className="new">replaced</span></p>

      {r && <SwapReport st={st} lang={lang} r={r} />}

      <dl className="pg-stats">
        <div className={v.length ? "bad" : ""}><dt>Outward imports</dt><dd>{v.length}</dd></div>
        <div className={r?.business.length ? "bad" : ""}><dt>Business edits, last swap</dt><dd>{r ? r.business.length : "–"}</dd></div>
        <div className={drags.length ? "bad" : ""}><dt>Use-case test needs</dt><dd>{drags.length ? drags.map((m) => title(m, lang, null)).join(", ") : "fakes only"}</dd></div>
        <div className={inCycle(st.on).length ? "bad" : ""}><dt>Import cycle</dt><dd>{inCycle(st.on).length ? "yes" : "no"}</dd></div>
      </dl>

      <div className="pg-card">
        <span className="label">Shortcut imports · click a line to add or remove it</span>
        <Imports st={st} lang={lang} dispatch={dispatch} />
      </div>

      <Compare st={st} />

      <div className="pg-card">
        <span className="label">Challenges</span>
        <ol className="dr-ch">
          {CHALLENGES.map((c) => (
            <li key={c.id} className={challengeDone(st, c.id) ? "done" : ""}>{challengeDone(st, c.id) ? "✓ " : ""}{c.text}</li>
          ))}
        </ol>
      </div>

      <Result st={st} lang={lang} />

      <PgSources links={[
        { title: "Robert C. Martin's Clean Architecture post", href: "https://blog.cleancoder.com/uncle-bob/2012/08/13/the-clean-architecture.html" },
        { title: "Alistair Cockburn's Hexagonal Architecture", href: "https://alistair.cockburn.us/hexagonal-architecture/" },
        { title: "import-linter's layers contract", href: "https://import-linter.readthedocs.io/" },
      ]} />
    </PgFrame>
  );
}

const CSS = `
.dr-graph { width: 100%; height: auto; display: block; border: 1px solid var(--line); background: var(--bg); background-image: linear-gradient(var(--grid) 1px, transparent 1px), linear-gradient(90deg, var(--grid) 1px, transparent 1px); background-size: 20px 20px; }
.dr-ring { fill: none; stroke: var(--accent); stroke-width: 1; stroke-dasharray: 6 4; }
.dr-ring.r0 { fill: var(--hl); stroke-dasharray: none; }
.dr-ring.r1 { fill: var(--surface-2); fill-opacity: .55; }
.dr-ringname { font-family: var(--f-code); font-size: 8.5px; letter-spacing: .08em; text-transform: uppercase; fill: var(--accent); }
.dr-node rect { fill: var(--surface); stroke: var(--line); stroke-width: 1.2; transition: fill .25s var(--ease), stroke .25s var(--ease); }
.dr-node .t { font-family: var(--f-code); font-size: 10px; letter-spacing: .04em; text-transform: uppercase; fill: var(--ink); }
.dr-node .s { font-family: var(--f-code); font-size: 8px; fill: var(--ink-2); }
.dr-node.edited rect { fill: var(--pain-bg); stroke: var(--pain); stroke-width: 2; }
.dr-node.rebuilt rect { fill: var(--hl); stroke: var(--accent); }
.dr-node.new rect { fill: var(--good-bg); stroke: var(--good); stroke-width: 2; }
.dr-node.cyc rect { stroke-dasharray: 3 2; }
.dr-edge { stroke: var(--ink-2); stroke-width: 1.2; }
.dr-edge.side { stroke: var(--accent); stroke-width: 1.6; }
.dr-edge.bad { stroke: var(--pain); stroke-width: 2; stroke-dasharray: 5 3; }
.dr-head { fill: var(--ink-2); }
.dr-head.bad { fill: var(--pain); }
.dr-legend { margin: 0; display: flex; flex-wrap: wrap; gap: 10px; font-size: .78rem; color: var(--ink-2); }
.dr-legend span { padding-left: 14px; position: relative; }
.dr-legend span::before { content: ""; position: absolute; left: 0; top: .3em; width: 10px; height: 10px; border: 1.5px solid var(--line); }
.dr-legend .bad::before { border: 0; border-top: 2px dashed var(--pain); top: .6em; }
.dr-legend .edited::before { background: var(--pain-bg); border-color: var(--pain); }
.dr-legend .rebuilt::before { background: var(--hl); border-color: var(--accent); }
.dr-legend .new::before { background: var(--good-bg); border-color: var(--good); }
.dr-lines { list-style: none; margin: 0; padding: 0; display: grid; gap: 6px; }
.dr-lines li { display: grid; gap: 2px; }
.dr-lines button { display: grid; gap: 2px; text-align: left; border: 1px solid var(--line); background: var(--surface); padding: 4px 8px; width: 100%; color: var(--ink); }
.dr-lines li.on.bad button { border-color: var(--pain); background: var(--pain-bg); }
.dr-lines li.on.ok button { border-color: var(--accent); background: var(--hl); }
.dr-lines code { font-size: .76rem; background: none; padding: 0; white-space: pre-wrap; overflow-wrap: anywhere; }
.dr-file { font-family: var(--f-code); font-size: .62rem; letter-spacing: .05em; text-transform: uppercase; color: var(--ink-2); }
.dr-why { font-size: .86rem; color: var(--ink-2); }
.dr-why b { color: var(--ink); font-weight: 600; }
.dr-table { border-collapse: collapse; width: 100%; font-size: .85rem; }
.dr-table caption { text-align: left; padding-bottom: 6px; }
.dr-table th, .dr-table td { border: 1px solid var(--line); padding: 4px 6px; text-align: left; }
.dr-table th { font-family: var(--f-code); font-size: .64rem; letter-spacing: .06em; text-transform: uppercase; color: var(--ink-2); font-weight: 500; background: var(--surface-2); }
.dr-table td.bad { color: var(--pain); font-weight: 700; }
.dr-ch { margin: 0; padding-left: 1.2em; display: grid; gap: 4px; font-size: .95rem; }
.dr-ch li.done { color: var(--good); }
@media (prefers-reduced-motion: reduce) { .dr-node rect { transition: none; } }
`;
