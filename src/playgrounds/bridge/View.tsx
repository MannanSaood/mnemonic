"use client";
import { PgButton, PgFrame, PgPredict, PgSources, useModel } from "../kit";
import {
  CHANGES, CHANNELS, CHANNEL_NAME, KINDS, KIND_NAME, SMS_LIMIT, broken, changeCost, classes, init, render, revealed, step,
  type Change, type Channel, type Kind, type State,
} from "./model";

const CSS = `
.bridge-wrap { overflow-x: auto; }
.bridge-grid { border-collapse: collapse; width: 100%; min-width: 520px; table-layout: fixed; }
.bridge-grid th, .bridge-grid td { border: 1px solid var(--line); padding: 4px 5px; vertical-align: top; text-align: left; }
.bridge-grid th { background: var(--bg); font-family: var(--f-code); font-size: .62rem; letter-spacing: .06em; text-transform: uppercase; font-weight: 600; }
.bridge-grid th.touched { box-shadow: inset 0 0 0 2px var(--good); color: var(--good); }
.bridge-grid th small { display: block; font-weight: 400; color: var(--ink-2); letter-spacing: 0; text-transform: none; font-size: .62rem; }
.bridge-grid td { background: var(--surface); }
.bridge-grid td.touched { box-shadow: inset 0 0 0 2px var(--pain); }
.bridge-grid td.broken { background: var(--pain-bg); }
.bridge-cls { display: block; font-family: var(--f-code); font-size: .56rem; color: var(--ink-2); margin-bottom: 2px; }
.bridge-msg { display: block; font-family: var(--f-code); font-size: .6rem; line-height: 1.35; word-break: break-word; }
.bridge-msg + .bridge-msg { color: var(--ink-2); }
.bridge-why { display: block; font-size: .7rem; color: var(--pain); font-weight: 600; margin-top: 2px; }
.bridge-add { padding: 1px 6px; font-size: .72rem; }
.bridge-counts { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; }
.bridge-big { font-family: var(--f-code); font-size: 1.25rem; font-weight: 700; font-variant-numeric: tabular-nums; }
.bridge-big.bad { color: var(--pain); }
.bridge-big.good { color: var(--good); }
.bridge-bars { display: grid; gap: 3px; }
.bridge-bar { display: grid; grid-template-columns: 7.5em 1fr; gap: 6px; align-items: center; font-size: .72rem; }
.bridge-bar > span:first-child { font-family: var(--f-code); color: var(--ink-2); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.bridge-bar i { display: block; height: 7px; background: var(--pain); transition: width .4s var(--ease); }
.bridge-bar i + i { background: var(--good); margin-top: 2px; }
.bridge-changes { display: grid; grid-template-columns: repeat(auto-fit, minmax(190px, 1fr)); gap: 8px; }
.bridge-change { border: 1px solid var(--line); background: var(--bg); padding: 8px 10px; display: grid; gap: 6px; align-content: start; }
.bridge-change h4 { margin: 0; font-size: .95rem; }
.bridge-change p { margin: 0; font-size: .85rem; color: var(--ink-2); }
.bridge-change .cost { font-family: var(--f-code); font-size: .72rem; color: var(--ink); }
@media (prefers-reduced-motion: reduce) { .bridge-bar i { transition: none; } }
`;

const cap = (s: string) => s.replace(/\s+/g, "");

/** Which pair cells and which headers the most recent change touched. */
function touched(st: State): { cells: (k: Kind, c: Channel) => boolean; kinds: Kind[]; channels: Channel[] } {
  const last = st.shipped.at(-1);
  if (last === "runbook") return { cells: (k) => k === "incident", kinds: ["incident"], channels: [] };
  if (last === "blocks") return { cells: (_k, c) => c === "slack", kinds: [], channels: ["slack"] };
  if (last === "maxlen") return { cells: (k, c) => k === "digest" && c === "sms", kinds: ["digest"], channels: st.channels };
  return { cells: () => false, kinds: [], channels: [] };
}

function Grid({ st, dispatch }: { st: State; dispatch: (a: Parameters<typeof step>[1]) => void }) {
  const t = touched(st);
  const nextKind = KINDS.find((k) => !st.kinds.includes(k));
  const nextChannel = CHANNELS.find((c) => !st.channels.includes(c));
  return (
    <div className="bridge-wrap">
      <table className="bridge-grid" aria-label="Every alert kind on every channel">
        <thead>
          <tr>
            <th>Alert ↓ · Channel →</th>
            {st.channels.map((c) => <th key={c} className={t.channels.includes(c) ? "touched" : ""}>{CHANNEL_NAME[c]}<small>{c === "sms" ? `max ${SMS_LIMIT} chars` : "Channel"}</small></th>)}
            {nextChannel && <th><PgButton onClick={() => dispatch({ type: "addChannel", channel: nextChannel })}>+ {CHANNEL_NAME[nextChannel]}</PgButton></th>}
          </tr>
        </thead>
        <tbody>
          {st.kinds.map((k) => (
            <tr key={k}>
              <th className={t.kinds.includes(k) ? "touched" : ""}>{KIND_NAME[k]}<small>Alert</small></th>
              {st.channels.map((c) => {
                const r = render(k, c, st);
                return (
                  <td key={c} className={(t.cells(k, c) ? "touched" : "") + (r.broken ? " broken" : "")}>
                    <span className="bridge-cls">{cap(KIND_NAME[k])}{CHANNEL_NAME[c]}</span>
                    {r.lines.map((l, i) => <span key={i} className="bridge-msg">{l}</span>)}
                    {r.broken && <span className="bridge-why">{r.broken}</span>}
                  </td>
                );
              })}
              {nextChannel && <td />}
            </tr>
          ))}
          {nextKind && (
            <tr>
              <th><PgButton onClick={() => dispatch({ type: "addKind", kind: nextKind })}>+ {KIND_NAME[nextKind]}</PgButton></th>
              {st.channels.map((c) => <td key={c} />)}
              {nextChannel && <td />}
            </tr>
          )}
        </tbody>
      </table>
    </div>
  );
}

function Counts({ st }: { st: State }) {
  const now = classes(st.kinds.length, st.channels.length);
  const max = Math.max(...st.history.map((h) => h.inheritance));
  return (
    <div className="pg-card">
      <span className="label">Classes to write and keep</span>
      <div className="bridge-counts">
        <div>
          <span className="muted">One class per pair</span><br />
          <span className="bridge-big bad">{now.inheritance}</span> <span className="muted">= {st.kinds.length} × {st.channels.length} · {st.edits.inheritance} edits</span>
        </div>
        <div>
          <span className="muted">Bridge</span><br />
          <span className="bridge-big good">{now.bridge}</span> <span className="muted">= {st.kinds.length} + {st.channels.length} · {st.edits.bridge} edits</span>
        </div>
      </div>
      <div className="bridge-bars" aria-label="Class count after each step">
        {st.history.map((h, i) => (
          <div key={i} className="bridge-bar">
            <span>{h.label}</span>
            <span><i style={{ width: `${(h.inheritance / max) * 100}%` }} /><i style={{ width: `${(h.bridge / max) * 100}%` }} /></span>
          </div>
        ))}
      </div>
    </div>
  );
}

function Changes({ st, dispatch }: { st: State; dispatch: (a: Parameters<typeof step>[1]) => void }) {
  return (
    <div className="bridge-changes">
      {(Object.keys(CHANGES) as Change[]).map((c) => {
        const done = st.perChange[c];
        const blocked = c === "maxlen" && !st.channels.includes("sms");
        const preview = changeCost(c, st);
        return (
          <div key={c} className="bridge-change">
            <span className="label">Change request · touches {CHANGES[c].dimension === "joint" ? "the joint" : `one ${CHANGES[c].dimension}`}</span>
            <h4>{CHANGES[c].title}</h4>
            <p>{CHANGES[c].why}</p>
            {done ? (
              <span className="cost" aria-live="polite">Shipped. Pair classes edited: {done.inheritance}. Bridge classes edited: {done.bridge}.</span>
            ) : (
              <PgButton onClick={() => dispatch({ type: "ship", change: c })} disabled={blocked} title={blocked ? "Add SMS first" : `Edits: ${preview.inheritance} pair classes, or ${preview.bridge} in the bridge`}>
                {blocked ? "Add SMS first" : "Ship it"}
              </PgButton>
            )}
          </div>
        );
      })}
    </div>
  );
}

function Result({ st }: { st: State }) {
  if (!revealed(st)) return null;
  const now = classes(st.kinds.length, st.channels.length);
  const r = st.perChange.runbook, b = st.perChange.blocks, m = st.perChange.maxlen;
  const bad = broken(st);
  return (
    <div className="pg-result" aria-live="polite">
      <span className="label">Your result</span>
      <p>
        You grew to {st.kinds.length} kinds of alert on {st.channels.length} channels. One class per pair: <b>{now.inheritance} classes</b>.
        Bridge: <b>{now.bridge}</b>.
        {r && ` Linking the runbook took ${r.inheritance} pair edits against ${r.bridge}.`}
        {b && ` Moving Slack to Block Kit took ${b.inheritance} against ${b.bridge}.`}
        {m && ` Adding MaxLength to the joint took ${m.inheritance} pair edit against ${m.bridge} in the bridge: every channel must implement a new primitive.`}
      </p>
      {bad.length > 0 && <p style={{ color: "var(--pain)" }}>Still broken: {bad.map((x) => `${KIND_NAME[x.kind]} on ${CHANNEL_NAME[x.channel]}`).join(", ")}. Ship the MaxLength change.</p>}
      <p className="pg-takeaway">What an alert says and where it goes change for different reasons. Kept apart and joined by one reference, each dimension grows by one class and each change lands in one place. The price is the joint: the Channel interface must offer the primitives every alert needs, and growing it touches every channel.</p>
    </div>
  );
}

export default function BridgePlayground() {
  const { state: st, dispatch } = useModel(step, init);
  return (
    <PgFrame title="Grow the alert grid, ship the changes" onReset={() => dispatch({ type: "reset" })}>
      <style>{CSS}</style>
      <p className="pg-rule">
        Every cell is a real message: one kind of alert delivered on one channel. With one class per pair, each cell is its
        own class (its name is in grey). With a bridge, an Alert composes the message and holds a Channel that delivers
        it, so only the row and column headers are classes. <b>Grow the grid, ship the changes, compare the bill.</b>
      </p>

      <PgPredict
        question="Today: 3 kinds × 3 channels, 9 classes with one class per pair. Product wants SMS and SLA-breach alerts. How many classes then?"
        options={[{ value: "11", label: "11" }, { value: "16", label: "16" }, { value: "18", label: "18" }]}
        value={st.guess}
        onChange={(g) => dispatch({ type: "guess", guess: g })}
        revealed={revealed(st)}
        answer="16"
        explain="4 kinds × 4 channels is 16: seven new classes for two new ideas. With a bridge it is 4 + 4 = 8, one class per new idea. Each new channel multiplies the pair design by the number of kinds."
      />

      <Grid st={st} dispatch={dispatch} />
      {broken(st).length > 0 && (
        <p className="pg-note" role="status" style={{ color: "var(--pain)" }}>
          The digest does not fit an SMS. A message that worked on every other channel is cut short here: the Channel interface has no way to say how much fits.
        </p>
      )}
      <div className="pg-grid">
        <Counts st={st} />
        <div className="pg-card">
          <span className="label">Changes that touch one dimension, and one that touches the joint</span>
          <Changes st={st} dispatch={dispatch} />
        </div>
      </div>
      <Result st={st} />

      <PgSources links={[
        { title: "Refactoring.Guru's Bridge (shapes × colours)", href: "https://refactoring.guru/design-patterns/bridge" },
        { title: "Slack's guide to moving from attachments to blocks", href: "https://docs.slack.dev/legacy/legacy-messaging/migrating-outmoded-message-compositions-to-blocks" },
      ]} />
    </PgFrame>
  );
}
