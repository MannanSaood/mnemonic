"use client";
import type { ReactNode } from "react";
import { usePrefs } from "@/components/Prefs";
import type { Lang } from "@/lib/types";
import { PgButton, PgChoice, PgFrame, PgPredict, PgSources, useModel } from "../kit";
import {
  DESIGNS, EVENTS, EVENT_IDS, FAT_METHODS, PREDICT_ANSWER, SERVICE, SERVICES, designKey, designName, init, predictRevealed,
  ripple, step, totals, type Action, type Design, type EventId, type Predict, type Mod, type Ripple, type Service, type State,
} from "./model";

const n = (k: number, one: string, many = one + "s") => `${k} ${k === 1 ? one : many}`;

/** The driver, its upgrade and its duplicate-key error, in the reader's language. */
const DRIVER: Record<Lang, { name: string; from: string; to: string; dupe: string }> = {
  go: { name: "pgx", from: "v4", to: "v5", dupe: "a *pgconn.PgError with code 23505" },
  python: { name: "psycopg", from: "psycopg2", to: "psycopg 3", dupe: "a psycopg UniqueViolation" },
  typescript: { name: "pg", from: "v7", to: "v8", dupe: "a pg DatabaseError with code 23505" },
  rust: { name: "sqlx", from: "0.7", to: "0.8", dupe: "a sqlx database error that is a unique violation" },
};
const eventTitle = (e: EventId, lang: Lang) =>
  e === "pgx" ? `Upgrade ${DRIVER[lang].name} ${DRIVER[lang].from} to ${DRIVER[lang].to}` : EVENTS[e].title;

/* ---------------- the dependency graph ---------------- */

interface Box { x: number; y: number; w: number; h: number }
const SX = [12, 148, 284, 420];
const SW = 128;

function layout(d: Design) {
  const svc: Record<Service, Box> = Object.fromEntries(SERVICES.map((s, i) => [s, { x: SX[i], y: 14, w: SW, h: 44 }])) as Record<Service, Box>;
  const iy = d.dip ? 84 : 158;
  const by = d.dip ? 204 : 216;
  const iface: Record<string, Box> = d.isp
    ? Object.fromEntries(SERVICES.map((s, i) => [s, { x: SX[i], y: iy, w: SW, h: 34 }]))
    : { fat: { x: 12, y: iy, w: 536, h: 34 } };
  return { svc, iface, pg: { x: 12, y: by, w: 170, h: 40 }, pgx: { x: 206, y: by, w: 120, h: 40 }, mem: { x: 350, y: by, w: 198, h: 40 }, line: 140 };
}

function Arrow({ x1, y1, x2, y2, cls }: { x1: number; y1: number; x2: number; y2: number; cls?: string }) {
  return <line className={"isd-edge" + (cls ? ` ${cls}` : "")} x1={x1} y1={y1} x2={x2} y2={y2} markerEnd="url(#isd-arrow)" />;
}

function Node({ b, title, sub, tone }: { b: Box; title: string; sub?: string; tone?: string }) {
  return (
    <g className={"isd-node" + (tone ? ` ${tone}` : "")}>
      <rect x={b.x} y={b.y} width={b.w} height={b.h} />
      <text className="t" x={b.x + b.w / 2} y={b.y + (sub ? b.h / 2 - 2 : b.h / 2 + 4)} textAnchor="middle">{title}</text>
      {sub && <text className="s" x={b.x + b.w / 2} y={b.y + b.h / 2 + 12} textAnchor="middle">{sub}</text>}
    </g>
  );
}

function Graph({ d, r, event, lang }: { d: Design; r: Ripple | null; event: EventId | null; lang: Lang }) {
  const L = layout(d);
  const tone = (m: Mod) =>
    r?.created.includes(m) ? "new" : r?.edited.includes(m) ? "edited" : r?.rebuilt.includes(m) ? "rebuilt" : undefined;
  const ifaceEdited = (k: string) => event === "bulkBan" && (k === "fat" || k === "admin");
  const showMem = event === "memstore";
  const home = d.dip ? (d.isp ? "package of each service" : "package users") : "package postgres";
  const cx = (b: Box) => b.x + b.w / 2;
  return (
    <svg className="isd-graph" viewBox="0 0 560 266" role="img"
      aria-label={`Dependency graph: ${designName(d)}. Arrows point from the importing module to the module it imports.`}>
      <defs>
        <marker id="isd-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
          <path d="M0,0 L10,5 L0,10 z" className="isd-head" />
        </marker>
      </defs>
      <line className="isd-boundary" x1={0} x2={560} y1={L.line} y2={L.line} />
      <text className="isd-zone" x={556} y={L.line - 6} textAnchor="end">business code</text>
      <text className="isd-zone" x={556} y={L.line + 14} textAnchor="end">database code</text>

      {/* service -> interface */}
      {SERVICES.map((s) => {
        const a = L.svc[s], b = d.isp ? L.iface[s] : L.iface.fat;
        return <Arrow key={s} x1={cx(a)} y1={a.y + a.h} x2={cx(a)} y2={b.y - 2} />;
      })}
      {/* postgres -> interface(s): implements, and in the inverted design it imports them */}
      {Object.entries(L.iface).map(([k, b]) => (
        <Arrow key={k} x1={cx(L.pg)} y1={L.pg.y} x2={d.isp ? cx(b) : cx(L.pg)} y2={b.y + b.h + 2} cls="impl" />
      ))}
      <Arrow x1={L.pg.x + L.pg.w} y1={L.pg.y + 20} x2={L.pgx.x - 2} y2={L.pgx.y + 20} />
      {!d.dip && <Arrow x1={cx(L.svc.signup) + 30} y1={L.svc.signup.y + L.svc.signup.h} x2={cx(L.pgx)} y2={L.pgx.y - 2} cls="leak" />}
      {showMem && <Arrow x1={cx(L.mem)} y1={L.mem.y} x2={d.isp ? cx(L.iface.signup) + 20 : cx(L.mem)} y2={(d.isp ? L.iface.signup : L.iface.fat).y + 36} cls="impl" />}

      {SERVICES.map((s) => (
        <Node key={s} b={L.svc[s]} title={SERVICE[s].name} sub={`fake: ${d.isp ? SERVICE[s].methods.length : FAT_METHODS.length} methods`}
          tone={r?.fakesEdited.includes(s) && !r.edited.includes(s) && !r.rebuilt.includes(s) ? "fake" : tone(s)} />
      ))}
      {Object.entries(L.iface).map(([k, b]) => (
        <Node key={k} b={b} title={k === "fat" ? `UserRepository · ${FAT_METHODS.length + (event === "bulkBan" ? 1 : 0)} methods` : `${SERVICE[k as Service].iface} · ${SERVICE[k as Service].methods.length + (event === "bulkBan" && k === "admin" ? 1 : 0)}`}
          sub={k === "fat" ? home : undefined} tone={ifaceEdited(k) ? "edited" : undefined} />
      ))}
      <Node b={L.pg} title="PgUserRepository" sub="package postgres" tone={tone("postgres")} />
      <Node b={L.pgx} title={`${DRIVER[lang].name} driver`} sub={event === "pgx" ? `${DRIVER[lang].from} → ${DRIVER[lang].to}` : DRIVER[lang].from} tone={tone("pgx")} />
      {showMem && <Node b={L.mem} title="MemStore" sub="new, for local dev" tone="new" />}
    </svg>
  );
}

/* ---------------- the same request in all four designs ---------------- */

function cellText(e: EventId, r: Ripple): string {
  switch (e) {
    case "bulkBan": return `${n(r.fakesEdited.length, "fake")} edited · ${n(r.bystanders.length, "bystander")} rebuilt`;
    case "pgx": return `${n(r.unasked.length, "service edit")} · ${n(r.bystanders.length, "service")} rebuilt`;
    case "memstore": return `${n(r.methods, "method")} to write · ${n(r.unasked.length, "service edit")}`;
    case "test": return `${n(r.methods, "fake method")} · ${r.driverInTest ? "driver in the test" : "no driver"}`;
  }
}

function Grid({ st, dispatch }: { st: State; dispatch: (a: Action) => void }) {
  const e = st.event;
  if (!e) return null;
  const row = (dip: boolean, label: string) => (
    <tr>
      <th scope="row">{label}</th>
      {[false, true].map((isp) => {
        const d = { isp, dip };
        const cur = st.design.isp === isp && st.design.dip === dip;
        const r = ripple(d, e);
        return (
          <td key={String(isp)}>
            <button className={"isd-cell" + (cur ? " cur" : "")} aria-pressed={cur} onClick={() => dispatch({ type: "design", design: d })}>
              {cellText(e, r)}
            </button>
          </td>
        );
      })}
    </tr>
  );
  return (
    <table className="isd-grid">
      <caption className="label">The same request, all four designs (click one to switch)</caption>
      <thead><tr><th /><th scope="col">One fat interface</th><th scope="col">Role interfaces</th></tr></thead>
      <tbody>
        {row(false, "Owned by postgres")}
        {row(true, "Owned by the service")}
      </tbody>
    </table>
  );
}

function Explain({ e, d, r, lang }: { e: EventId; d: Design; r: Ripple; lang: Lang }): ReactNode {
  switch (e) {
    case "bulkBan":
      return d.isp
        ? d.dip
          ? <>Only AdminStore grew a method. AdminConsole, its fake and the Postgres adapter changed; the other three services did not even rebuild.</>
          : <>Only the admin fake changed, but AdminStore lives in package postgres, and every service imports that package. All {n(r.rebuilt.filter((m) => (SERVICES as string[]).includes(m)).length, "service")} rebuilt anyway.</>
        : <>BulkBan joined UserRepository, so every fake that implements it stopped compiling: {n(r.fakesEdited.length, "fake")} edited for a method only the admin console calls.</>;
    case "pgx":
      return d.dip
        ? <>The driver and the adapter changed. Nothing in the business code imports either, so nothing there rebuilt.</>
        : <>SignupService imports the driver to recognise a duplicate email, so it was edited for an upgrade nobody in signup asked for, and {n(r.bystanders.length, "service")} rebuilt.</>;
    case "memstore":
      return <>MemStore had to implement {n(r.methods, "method")}{d.isp ? ", only what SignupService uses" : `, ${FAT_METHODS.length - SERVICE.signup.methods.length} of which signup never calls`}. {d.dip ? "Signup did not change: the store returns signup's own ErrEmailTaken." : "Signup had to learn a second duplicate-email error, from a second database."}</>;
    case "test":
      return <>The fake for SignupService implements {n(r.methods, "method")}. {r.driverInTest ? `To test the duplicate-email path, the test builds ${DRIVER[lang].dupe}, so it imports the Postgres driver.` : "The duplicate path returns ErrEmailTaken, a plain error from the signup package."}</>;
  }
}

function Takeaway({ d }: { d: Design }) {
  if (!d.isp && !d.dip) return <>Every change reached every service: BulkBan through the fat interface, the driver upgrade through package postgres. Turn on one principle at a time and compare.</>;
  if (d.isp && !d.dip) return <>Small interfaces cut the fakes and the methods to write, but they still live in package postgres, so a driver upgrade still rebuilds all the business code. Segregation without inversion stops half the ripple.</>;
  if (!d.isp && d.dip) return <>The business code owns its interface now, so database changes stop at the boundary. But one fat interface still makes every service&apos;s fake pay for the admin console&apos;s new method.</>;
  return <>Each service owns a small interface of exactly what it uses. Database changes stop at the adapter, and a new method for one service touches only that service. That is interface segregation and dependency inversion together.</>;
}

export default function IspDipPlayground() {
  const { lang } = usePrefs();
  const { state: st, dispatch } = useModel(step, init);
  const d = st.design;
  const r = st.event ? ripple(d, st.event) : null;
  const shippedHere = st.shipped[designKey(d)] ?? [];
  const t = totals(d), best = totals(DESIGNS[3]), worst = totals(DESIGNS[0]);
  const tried = Object.keys(st.shipped).length;

  return (
    <PgFrame title="Ship four requests through four designs" onReset={() => dispatch({ type: "reset" })}>
      <style>{CSS}</style>
      <div className="pg-req">
        <span className="label">The setup</span>
        <p>Four services use one user store backed by Postgres. Each has a unit test with a fake store. Arrows in the graph point from a module to the module it imports; when a module changes, everything that imports it rebuilds.</p>
        <p className="pg-rule"><b>Pick a design, ship a request, and watch how far it ripples.</b> Then flip a switch and ship it again.</p>
      </div>

      <PgPredict<Predict>
        question="Admins ask for BulkBan. With one fat UserRepository, how many of the four services must change their test fakes?"
        options={[{ value: "1", label: "1, the admin console" }, { value: "2", label: "2" }, { value: "4", label: "All 4" }]}
        value={st.predict}
        onChange={(v) => dispatch({ type: "predict", value: v })}
        revealed={predictRevealed(st)}
        answer={PREDICT_ANSWER}
        explain={<>Every fake implements the whole interface, so a new method breaks all four, though only one service will ever call it. Clients were forced to depend on a method they do not use.</>}
      />

      <div className="isd-switches">
        <div><span className="label">What each service sees</span>
          <PgChoice label="What each service sees" value={d.isp ? "role" : "fat"}
            options={[{ value: "fat", label: "The whole UserRepository" }, { value: "role", label: "Only the methods it uses" }]}
            onChange={(v) => dispatch({ type: "isp", on: v === "role" })} />
        </div>
        <div><span className="label">Who owns the interface</span>
          <PgChoice label="Who owns the interface" value={d.dip ? "service" : "postgres"}
            options={[{ value: "postgres", label: "Package postgres" }, { value: "service", label: "The code that uses it" }]}
            onChange={(v) => dispatch({ type: "dip", on: v === "service" })} />
        </div>
      </div>

      <div className="pg-actions" role="group" aria-label="Change requests">
        {EVENT_IDS.map((e) => (
          <PgButton key={e} primary={st.event === e} onClick={() => dispatch({ type: "ship", event: e })}
            title={`${EVENTS[e].who}: ${EVENTS[e].why}`}>
            {shippedHere.includes(e) ? "✓ " : ""}{eventTitle(e, lang)}
          </PgButton>
        ))}
      </div>

      <Graph d={d} r={r} event={st.event} lang={lang} />
      <p className="isd-legend"><span className="edited">edited</span> <span className="rebuilt">rebuilt</span> <span className="fake">fake edited</span> <span className="new">new</span> <span className="leak">signup imports the driver</span></p>

      {st.event && r && (
        <div className={"pg-entry" + (r.bystanders.length || r.unasked.length || r.fakesEdited.length > 1 || r.driverInTest || r.methods > 2 ? " fail" : " ok")} aria-live="polite">
          <div className="pg-path" aria-hidden="true"><span>{EVENTS[st.event].who}</span><span>{eventTitle(st.event, lang)}</span><span>{designName(d)}</span></div>
          <p><Explain e={st.event} d={d} r={r} lang={lang} /></p>
        </div>
      )}

      <Grid st={st} dispatch={dispatch} />

      {tried > 0 && (
        <div className="pg-result">
          <span className="label">This design, over all four requests</span>
          <dl className="pg-stats">
            <div className={t.bystanders ? "bad" : ""}><dt>Bystanders rebuilt</dt><dd>{t.bystanders}</dd></div>
            <div className={t.unasked ? "bad" : ""}><dt>Unasked service edits</dt><dd>{t.unasked}</dd></div>
            <div className={t.fakesEdited > 1 ? "bad" : ""}><dt>Fakes edited</dt><dd>{t.fakesEdited}</dd></div>
            <div className={t.fakeMethods > 2 ? "bad" : ""}><dt>Signup fake size</dt><dd>{t.fakeMethods}</dd></div>
          </dl>
          <p>
            {designName(d)}: {n(t.bystanders, "service")} rebuilt for changes they did not ask for, {n(t.unasked, "unasked edit")} to business code, {n(t.fakesEdited, "test fake")} edited, and a {t.fakeMethods}-method fake to test signup{t.driverInTest ? " that imports the Postgres driver" : ""}.
            {" "}The worst design scores {worst.bystanders}, {worst.unasked}, {worst.fakesEdited} and {worst.fakeMethods}; the best scores {best.bystanders}, {best.unasked}, {best.fakesEdited} and {best.fakeMethods}.
          </p>
          <p className="pg-takeaway"><Takeaway d={d} /></p>
        </div>
      )}

      <PgSources links={[
        { title: "the dependency inversion diagrams on Wikipedia", href: "https://en.wikipedia.org/wiki/Dependency_inversion_principle" },
        { title: "Rui Figueiredo, What inverts in the dependency inversion principle", href: "https://dev.to/ruidfigueiredo/what-inverts-in-the-dependency-inversion-principle" },
        { title: "Martin's Xerox Job class story", href: "https://en.wikipedia.org/wiki/Interface_segregation_principle" },
      ]} />
    </PgFrame>
  );
}

const CSS = `
.isd-switches { display: flex; flex-wrap: wrap; gap: 10px 22px; }
.isd-switches > div { display: grid; gap: 4px; }
.isd-graph { width: 100%; height: auto; display: block; border: 1px solid var(--line); background: var(--bg); background-image: linear-gradient(var(--grid) 1px, transparent 1px), linear-gradient(90deg, var(--grid) 1px, transparent 1px); background-size: 20px 20px; }
.isd-node rect { fill: var(--surface); stroke: var(--line); stroke-width: 1.2; transition: fill .25s var(--ease), stroke .25s var(--ease); }
.isd-node .t { font-family: var(--f-code); font-size: 10.5px; letter-spacing: .04em; text-transform: uppercase; fill: var(--ink); }
.isd-node .s { font-family: var(--f-code); font-size: 9px; fill: var(--ink-2); }
.isd-node.edited rect { fill: var(--pain-bg); stroke: var(--pain); stroke-width: 2; }
.isd-node.rebuilt rect { fill: var(--hl); stroke: var(--accent); }
.isd-node.fake rect { fill: var(--surface); stroke: var(--pain); stroke-dasharray: 4 3; stroke-width: 2; }
.isd-node.new rect { fill: var(--good-bg); stroke: var(--good); stroke-width: 2; }
.isd-edge { stroke: var(--ink-2); stroke-width: 1.2; }
.isd-edge.impl { stroke: var(--accent); stroke-dasharray: 5 3; }
.isd-edge.leak { stroke: var(--pain); stroke-width: 1.6; stroke-dasharray: 2 3; }
.isd-head { fill: var(--ink-2); }
.isd-boundary { stroke: var(--accent); stroke-width: 1; stroke-dasharray: 8 4; }
.isd-zone { font-family: var(--f-code); font-size: 9px; letter-spacing: .08em; text-transform: uppercase; fill: var(--accent); }
.isd-legend { margin: 0; display: flex; flex-wrap: wrap; gap: 10px; font-size: .78rem; color: var(--ink-2); }
.isd-legend span { padding-left: 14px; position: relative; }
.isd-legend span::before { content: ""; position: absolute; left: 0; top: .3em; width: 10px; height: 10px; border: 1.5px solid var(--line); }
.isd-legend .edited::before { background: var(--pain-bg); border-color: var(--pain); }
.isd-legend .rebuilt::before { background: var(--hl); border-color: var(--accent); }
.isd-legend .fake::before { border-color: var(--pain); border-style: dashed; }
.isd-legend .new::before { background: var(--good-bg); border-color: var(--good); }
.isd-legend .leak::before { border: 0; border-top: 2px dotted var(--pain); top: .6em; }
.isd-grid { border-collapse: collapse; width: 100%; font-size: .85rem; }
.isd-grid caption { text-align: left; padding-bottom: 6px; }
.isd-grid th, .isd-grid td { border: 1px solid var(--line); padding: 4px; text-align: left; }
.isd-grid th { font-family: var(--f-code); font-size: .64rem; letter-spacing: .06em; text-transform: uppercase; color: var(--ink-2); font-weight: 500; background: var(--surface-2); }
.isd-cell { width: 100%; min-height: 40px; text-align: left; border: 1px solid var(--line); background: var(--surface); font-size: .8rem; color: var(--ink); padding: 4px 6px; }
.isd-cell.cur { border-color: var(--accent); background: var(--hl); font-weight: 600; }
@media (prefers-reduced-motion: reduce) { .isd-node rect { transition: none; } }
`;
