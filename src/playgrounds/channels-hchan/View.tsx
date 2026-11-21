"use client";
import { PgButton, PgChoice, PgFrame, PgLog, PgPredict, PgSources, useModel } from "../kit";
import {
  ANSWER, CAPS, CHALLENGES, RECEIVERS, SENDERS, canAct, init, step,
  type Action, type G, type Gid, type Guess, type State,
} from "./model";

const CSS = `
.channels-hchan-stage { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1.5fr) minmax(0, 1fr); gap: 10px; align-items: start; }
@media (max-width: 640px) { .channels-hchan-stage { grid-template-columns: 1fr; } }
.channels-hchan-col { display: grid; gap: 6px; }
.channels-hchan-g { border: 1px solid var(--line); background: var(--surface); padding: 6px 8px; display: grid; gap: 4px; }
.channels-hchan-g header { display: flex; justify-content: space-between; align-items: center; gap: 6px; }
.channels-hchan-name { font-family: var(--f-code); font-size: .72rem; letter-spacing: .08em; text-transform: uppercase; font-weight: 700; }
.channels-hchan-st { font-family: var(--f-code); font-size: .6rem; letter-spacing: .06em; text-transform: uppercase; padding: 1px 5px; border: 1px solid var(--line); color: var(--ink-2); }
.channels-hchan-g.parked { border-style: dashed; background: var(--bg); }
.channels-hchan-g.parked .channels-hchan-st { color: var(--pain); border-color: var(--pain); }
.channels-hchan-g.panicked { background: var(--pain-bg); border-color: var(--pain); }
.channels-hchan-g.panicked .channels-hchan-st { color: var(--pain); border-color: var(--pain); font-weight: 700; }
.channels-hchan-g .pg-btn { font-family: var(--f-code); font-size: .78rem; justify-self: start; }
.channels-hchan-got { margin: 0; font-family: var(--f-code); font-size: .74rem; color: var(--ink-2); }
.channels-hchan-chan { border: 2px solid var(--accent); background: var(--surface); padding: 8px; display: grid; gap: 8px; }
.channels-hchan-fields { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 1px; background: var(--line); border: 1px solid var(--line); margin: 0; }
.channels-hchan-fields div { background: var(--surface); padding: 3px 6px; }
.channels-hchan-fields dt { font-family: var(--f-code); font-size: .56rem; letter-spacing: .06em; text-transform: uppercase; color: var(--ink-2); }
.channels-hchan-fields dd { margin: 0; font-family: var(--f-code); font-size: .82rem; font-weight: 600; font-variant-numeric: tabular-nums; }
.channels-hchan-fields div.hot dd { color: var(--pain); }
.channels-hchan-ring { display: grid; grid-template-columns: repeat(var(--cap), minmax(0, 1fr)); gap: 4px; }
.channels-hchan-slot { display: grid; gap: 2px; text-align: center; }
.channels-hchan-cell { border: 1px solid var(--line); background: var(--bg); min-height: 2.1em; display: flex; align-items: center; justify-content: center; font-family: var(--f-code); font-size: .8rem; font-weight: 600; }
.channels-hchan-cell.full { background: var(--hl); border-color: var(--accent); }
.channels-hchan-mark { font-family: var(--f-code); font-size: .56rem; letter-spacing: .04em; text-transform: uppercase; color: var(--ink-2); min-height: 1.2em; }
.channels-hchan-mark b { color: var(--accent); }
.channels-hchan-none { margin: 0; font-size: .85rem; color: var(--ink-2); border: 1px dashed var(--line); padding: 6px; text-align: center; }
.channels-hchan-qs { display: grid; grid-template-columns: 1fr 1fr; gap: 6px; }
.channels-hchan-q { border: 1px dashed var(--line); padding: 4px 6px; min-height: 3.2em; display: grid; align-content: start; gap: 3px; }
.channels-hchan-q .label { font-size: .58rem; }
.channels-hchan-sudog { font-family: var(--f-code); font-size: .72rem; border: 1px solid var(--pain); color: var(--pain); padding: 1px 5px; justify-self: start; }
.channels-hchan-fresh { animation: pg-hop .35s var(--ease) both; }
.channels-hchan-goals { list-style: none; margin: 0; padding: 0; display: grid; gap: 4px; }
.channels-hchan-goals li { font-size: .9rem; padding-left: 1.6em; position: relative; }
.channels-hchan-goals li::before { content: "○"; position: absolute; left: 0; font-family: var(--f-code); color: var(--ink-2); }
.channels-hchan-goals li.met::before { content: "✓"; color: var(--good); font-weight: 700; }
.channels-hchan-crash { margin: 0; padding: 6px 8px; border: 1px solid var(--pain); background: var(--pain-bg); color: var(--pain); font-size: .88rem; }
@media (prefers-reduced-motion: reduce) { .channels-hchan-fresh { animation: none; } }
`;

const STATUS: Record<G["status"], string> = { running: "running", parked: "parked", panicked: "panicked" };

function Goroutine({ g, st, dispatch, fresh }: { g: G; st: State; dispatch: (a: Action) => void; fresh: boolean }) {
  const isSend = g.role === "send";
  const where = g.status === "parked" ? (isSend ? "parked · sendq" : "parked · recvq") : STATUS[g.status];
  const job = isSend ? "Order intake" : "DB writer";
  return (
    <div className={`channels-hchan-g ${g.status}` + (fresh ? " channels-hchan-fresh" : "")}>
      <header>
        <span className="channels-hchan-name">{g.id} · {job}</span>
        <span className="channels-hchan-st">{where}</span>
      </header>
      {isSend ? (
        <PgButton onClick={() => dispatch({ type: "send", g: g.id })} disabled={!canAct(st, g.id)}
          title={canAct(st, g.id) ? `${g.id} sends the next order` : `${g.id} is ${g.status}`}>
          ch &lt;- #{st.nextOrder}
        </PgButton>
      ) : (
        <PgButton onClick={() => dispatch({ type: "recv", g: g.id })} disabled={!canAct(st, g.id)}
          title={canAct(st, g.id) ? `${g.id} receives` : `${g.id} is ${g.status}`}>
          v, ok := &lt;-ch
        </PgButton>
      )}
      <p className="channels-hchan-got">
        {isSend
          ? g.status === "parked" ? `holding ${g.holding}, waiting` : g.status === "panicked" ? `panic: send on closed channel` : " "
          : g.status === "parked" ? "waiting for a value" : g.got === null ? " " : g.got === "" ? "got zero value, ok=false" : `got ${g.got}, ok=true`}
      </p>
    </div>
  );
}

function Hchan({ st, reduced }: { st: State; reduced: boolean }) {
  const fresh = (i: number) => (st.touched.slots.includes(i) && !reduced ? " channels-hchan-fresh" : "");
  return (
    <div className="channels-hchan-chan" aria-label="The channel's hchan structure">
      <span className="label">hchan · make(chan Order, {st.cap})</span>
      <dl className="channels-hchan-fields">
        <div><dt>qcount</dt><dd>{st.qcount}</dd></div>
        <div><dt>dataqsiz</dt><dd>{st.cap}</dd></div>
        <div className={st.closed ? "hot" : ""}><dt>closed</dt><dd>{st.closed ? 1 : 0}</dd></div>
        <div><dt>sendx</dt><dd>{st.cap ? st.sendx : "·"}</dd></div>
        <div><dt>recvx</dt><dd>{st.cap ? st.recvx : "·"}</dd></div>
        <div><dt>lock taken</dt><dd>{st.stats.locks}×</dd></div>
      </dl>
      <span className="label">buf</span>
      {st.cap === 0 ? (
        <p className="channels-hchan-none">No buffer. A value can only move from a sender&apos;s stack to a receiver&apos;s.</p>
      ) : (
        <div className="channels-hchan-ring" style={{ ["--cap" as string]: st.cap }} role="list" aria-label="Buffer slots">
          {st.buf.map((v, i) => (
            <div key={i} className="channels-hchan-slot" role="listitem" aria-label={`slot ${i}: ${v ?? "empty"}`}>
              <span className={"channels-hchan-cell" + (v ? " full" : "") + fresh(i)}>{v ?? ""}</span>
              <span className="channels-hchan-mark">
                {i === st.sendx && <b>sendx </b>}{i === st.recvx && <b>recvx</b>}{i !== st.sendx && i !== st.recvx && `[${i}]`}
              </span>
            </div>
          ))}
        </div>
      )}
      <div className="channels-hchan-qs">
        <div className="channels-hchan-q">
          <span className="label">recvq · parked receivers</span>
          {st.recvq.map((g) => <span key={g} className="channels-hchan-sudog">{g} · elem → {g}.v</span>)}
        </div>
        <div className="channels-hchan-q">
          <span className="label">sendq · parked senders</span>
          {st.sendq.map((w) => <span key={w.g} className="channels-hchan-sudog">{w.g} · elem {w.v}</span>)}
        </div>
      </div>
    </div>
  );
}

const n = (k: number, one: string, many = one + "s") => `${k} ${k === 1 ? one : many}`;

function Result({ st }: { st: State }) {
  const m = st.stats;
  if (m.sends + m.recvs < 4) return null;
  return (
    <div className="pg-result" aria-live="polite">
      <span className="label">Your numbers</span>
      <p>
        You sent {n(m.sends, "value")}. {m.handoffs} went straight from one goroutine&apos;s stack to another&apos;s,
        {" "}{m.buffered} went through a buffer slot, and goroutines parked {n(m.parks, "time")}. The channel&apos;s
        lock was taken {n(m.locks, "time")}{m.panics ? `, and ${n(m.panics, "panic")} would have ended the process` : ""}.
      </p>
      <p className="pg-takeaway">
        Every send asks the same questions in the same order: is a receiver already waiting, then is there a free
        slot, then park. A buffer only changes the second answer. It lets senders run ahead of the receivers by exactly the capacity (here {st.cap}), and after that
        they park just as they would on an unbuffered channel.
      </p>
    </div>
  );
}

const GUESSES: { value: Guess; label: string }[] = [
  { value: "buffer", label: "It is stored in the channel" },
  { value: "park", label: "S1 waits until R1 runs" },
  { value: "direct", label: "It is copied straight to R1" },
];

export default function ChannelsHchan() {
  const { state: st, dispatch, reduced } = useModel(step, init);
  const freshG = (g: Gid) => st.touched.gs.includes(g) && !reduced;
  return (
    <PgFrame title="One channel, five goroutines" onReset={() => dispatch({ type: "reset" })}
      toolbar={<PgButton onClick={() => dispatch({ type: "close" })} title="close(ch)">close(ch)</PgButton>}>
      <style>{CSS}</style>
      <p className="pg-rule">
        Three order-intake goroutines send orders on one channel; two database writers receive them. Click a
        goroutine to make it run its line once. The middle box is the channel as the runtime stores it.
        <b> Watch where each value goes and who parks.</b>
      </p>

      <PgPredict<Guess>
        question="R1 is already parked on this unbuffered channel, waiting. S1 now sends order #101. What happens to the value?"
        options={GUESSES}
        value={st.guess}
        onChange={(g) => dispatch({ type: "guess", guess: g })}
        revealed={st.stats.sends > 0}
        answer={ANSWER}
        explain="A send checks recvq before anything else. R1 is parked there, so the runtime copies #101 straight onto R1's stack and marks R1 runnable. S1 never waits and nothing is stored. Click S1 if you have not yet, then try the same with a buffer."
      />

      <div className="pg-actions" style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
        <span className="label">Capacity</span>
        <PgChoice<string> label="Channel capacity" value={String(st.cap)}
          options={CAPS.map((c) => ({ value: String(c), label: c === 0 ? "0 · unbuffered" : String(c) }))}
          onChange={(v) => dispatch({ type: "setCap", cap: Number(v) })} />
        <span className="muted">Changing it makes a new channel.</span>
      </div>

      <div className="channels-hchan-stage">
        <div className="channels-hchan-col" aria-label="Senders">
          <span className="label">Senders</span>
          {SENDERS.map((g) => <Goroutine key={g} g={st.gs[g]} st={st} dispatch={dispatch} fresh={freshG(g)} />)}
        </div>
        <Hchan st={st} reduced={reduced} />
        <div className="channels-hchan-col" aria-label="Receivers">
          <span className="label">Receivers</span>
          {RECEIVERS.map((g) => <Goroutine key={g} g={st.gs[g]} st={st} dispatch={dispatch} fresh={freshG(g)} />)}
        </div>
      </div>

      {st.crashed && <p className="channels-hchan-crash" role="status">A goroutine panicked. In a real program an unrecovered panic ends the whole process; here you can keep exploring, or pick a capacity to start a new channel.</p>}

      <div className="pg-grid">
        <div className="pg-card">
          <span className="label">What the runtime did, newest first</span>
          <PgLog entries={st.log.map((e) => ({ id: e.id, ok: e.ok, text: e.text, path: e.path }))} empty="Nothing yet." reduced={reduced} />
        </div>
        <div className="pg-card">
          <span className="label">Challenges</span>
          <ul className="channels-hchan-goals" aria-label="Challenges">
            {CHALLENGES.map((c) => <li key={c.id} className={st.done.includes(c.id) ? "met" : ""}>{c.text}</li>)}
          </ul>
          <dl className="pg-stats">
            <div><dt>Direct copies</dt><dd>{st.stats.handoffs}</dd></div>
            <div><dt>Via buffer</dt><dd>{st.stats.buffered}</dd></div>
            <div className={st.stats.parks ? "bad" : ""}><dt>Parks</dt><dd>{st.stats.parks}</dd></div>
            <div className={st.stats.panics ? "bad" : ""}><dt>Panics</dt><dd>{st.stats.panics}</dd></div>
          </dl>
        </div>
      </div>

      <Result st={st} />

      <PgSources links={[
        { title: "Kavya Joshi's Understanding Channels (GopherCon 2017)", href: "https://speakerdeck.com/kavya719/understanding-channels" },
        { title: "Ivan Danyliuk's Visualizing Concurrency in Go", href: "https://divan.dev/posts/go_concurrency_visualize/" },
        { title: "runtime/chan.go", href: "https://github.com/golang/go/blob/master/src/runtime/chan.go" },
      ]} />
    </PgFrame>
  );
}
