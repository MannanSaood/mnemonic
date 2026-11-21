"use client";
import { PgButton, PgChoice, PgFrame, PgLog, PgPredict, PgSources, useModel } from "../kit";
import {
  ANSWER, CHALLENGES, canAudit, canClone, canNext, canPut, canSend, canUse, holders, init, revealed, step, unreachable,
  type Action, type Block, type Guess, type Mode, type Slot, type State, type Tally, type VarName,
} from "./model";

const CSS = `
.ownership-stage { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1fr) minmax(0, 1fr); gap: 10px; align-items: start; }
@media (max-width: 680px) { .ownership-stage { grid-template-columns: 1fr; } }
.ownership-col { display: grid; gap: 6px; align-content: start; min-width: 0; }
.ownership-frame { border: 2px solid var(--accent); background: var(--surface); padding: 8px; display: grid; gap: 6px; }
.ownership-frame.closed { border-style: dashed; border-color: var(--line); background: var(--bg); }
.ownership-card { border: 1px solid var(--line); background: var(--surface); padding: 6px 8px; display: grid; gap: 5px; min-width: 0; }
.ownership-card header { display: flex; justify-content: space-between; align-items: center; gap: 6px; flex-wrap: wrap; }
.ownership-name { font-family: var(--f-code); font-size: .76rem; font-weight: 700; letter-spacing: .04em; }
.ownership-ptr { font-family: var(--f-code); font-size: .7rem; padding: 1px 6px; border: 1px solid var(--accent); color: var(--accent); }
.ownership-ptr.b2 { border-color: var(--good); color: var(--good); }
.ownership-ptr.b3, .ownership-ptr.b4 { border-color: var(--ink-2); color: var(--ink-2); }
.ownership-card.moved { border-style: dashed; background: var(--bg); color: var(--ink-2); }
.ownership-card.moved .ownership-ptr { text-decoration: line-through; border-color: var(--line); color: var(--ink-2); }
.ownership-btns { display: flex; flex-wrap: wrap; gap: 4px; }
.ownership-btns .pg-btn { font-family: var(--f-code); font-size: .74rem; padding: 3px 7px; }
.ownership-note { margin: 0; font-size: .8rem; color: var(--ink-2); }
.ownership-block { border: 1px solid var(--line); background: var(--surface); padding: 6px 8px; display: grid; gap: 3px; }
.ownership-block.b1 { border-left: 4px solid var(--accent); }
.ownership-block.b2 { border-left: 4px solid var(--good); }
.ownership-block.b3, .ownership-block.b4 { border-left: 4px solid var(--ink-2); }
.ownership-block.shared { background: var(--pain-bg); }
.ownership-block.freed { background: var(--bg); border-style: dashed; color: var(--ink-2); }
.ownership-block.garbage { opacity: .6; }
.ownership-bytes { font-family: var(--f-code); font-size: .8rem; font-weight: 600; }
.ownership-bytes.globex { color: var(--pain); }
.ownership-who { font-family: var(--f-code); font-size: .64rem; letter-spacing: .05em; text-transform: uppercase; color: var(--ink-2); }
.ownership-who.bad { color: var(--pain); font-weight: 700; }
.ownership-who.one { color: var(--good); font-weight: 700; }
.ownership-error { margin: 0; padding: 6px 8px; border: 1px solid var(--pain); background: var(--pain-bg); color: var(--pain); font-family: var(--f-code); font-size: .8rem; }
.ownership-crash { margin: 0; padding: 6px 8px; border: 1px solid var(--pain); background: var(--pain-bg); color: var(--pain); font-size: .88rem; }
.ownership-fresh { animation: pg-hop .35s var(--ease) both; }
.ownership-goals { list-style: none; margin: 0; padding: 0; display: grid; gap: 4px; }
.ownership-goals li { font-size: .9rem; padding-left: 1.6em; position: relative; }
.ownership-goals li::before { content: "○"; position: absolute; left: 0; font-family: var(--f-code); color: var(--ink-2); }
.ownership-goals li.met::before { content: "✓"; color: var(--good); font-weight: 700; }
.ownership-table { width: 100%; border-collapse: collapse; font-size: .82rem; }
.ownership-table th, .ownership-table td { border: 1px solid var(--line); padding: 3px 6px; text-align: right; font-variant-numeric: tabular-nums; }
.ownership-table th:first-child, .ownership-table td:first-child { text-align: left; }
.ownership-table th { font-family: var(--f-code); font-size: .6rem; letter-spacing: .06em; text-transform: uppercase; color: var(--ink-2); font-weight: 600; }
.ownership-table td.bad { color: var(--pain); font-weight: 700; }
@media (prefers-reduced-motion: reduce) { .ownership-fresh { animation: none; } }
`;

const MODE_LABEL: Record<Mode, string> = { rust: "Rust · ownership", gc: "GC · Go, Python, TS", manual: "Manual free · C" };
const MODE_RULE: Record<Mode, string> = {
  rust: "A move hands the buffer on and makes the old name unusable. Scope end drops what is still owned.",
  gc: "Passing the buffer copies a pointer. Memory is freed only when nothing points at it, but the pool still recycles it.",
  manual: "Passing the buffer copies a pointer. Every holder frees what it holds when it is done.",
};

const H = (id: number) => `H${id}`;

function Var({ st, v, dispatch, fresh }: { st: State; v: VarName; dispatch: (a: Action) => void; fresh: boolean }) {
  const sl = st.slots[v];
  if (sl.block === null) {
    return v === "copy" ? (
      <div className="ownership-card moved">
        <span className="ownership-name">copy</span>
        <p className="ownership-note">Not declared yet. Clone buf to create it.</p>
      </div>
    ) : null;
  }
  const moved = st.mode === "rust" && sl.movedTo !== null;
  const where = sl.movedTo === "audit" ? "the audit task" : "the pool";
  return (
    <div className={"ownership-card" + (moved ? " moved" : "") + (fresh ? " ownership-fresh" : "")}>
      <header>
        <span className="ownership-name">{v}: Vec&lt;u8&gt;</span>
        <span className={`ownership-ptr b${sl.block}`}>→ {H(sl.block)}</span>
      </header>
      {moved && <p className="ownership-note">moved to {where}: this name owns nothing</p>}
      {st.ingestOpen && (
        <div className="ownership-btns">
          <PgButton onClick={() => dispatch({ type: "send", from: v })} disabled={!canSend(st, v)} title="Hand the buffer to the audit task">audit.send({v})</PgButton>
          <PgButton onClick={() => dispatch({ type: "put", from: v })} disabled={!canPut(st, v)} title="Return the buffer to the pool">pool.put({v})</PgButton>
          <PgButton onClick={() => dispatch({ type: "read", v })} disabled={!canUse(st, v)} title="Read the frame">parse(&amp;{v})</PgButton>
          {v === "buf" && <PgButton onClick={() => dispatch({ type: "clone" })} disabled={!canClone(st)} title="Copy the 4 KiB into a new buffer">let copy = buf.clone()</PgButton>}
        </div>
      )}
    </div>
  );
}

const SLOT_LABEL: Record<Slot, string> = { buf: "buf", copy: "copy", audit: "audit", pool: "pool", next: "next req" };

function HeapBlock({ st, b, fresh }: { st: State; b: Block; fresh: boolean }) {
  const who = holders(st, b.id);
  const garbage = st.mode === "gc" && unreachable(st, b.id);
  const cls = ["ownership-block", `b${b.id}`, b.freed ? "freed" : "", who.length > 1 ? "shared" : "", garbage ? "garbage" : "", fresh ? "ownership-fresh" : ""].join(" ");
  return (
    <div className={cls} aria-label={`${H(b.id)}: ${b.freed ? "freed" : b.tenant + "'s frame"}`}>
      <span className="label">{H(b.id)} · 4 KiB</span>
      <span className={"ownership-bytes" + (b.tenant === "globex" && !b.freed ? " globex" : "")}>{b.freed ? "freed memory" : `tenant=${b.tenant} …`}</span>
      <span className={"ownership-who" + (who.length > 1 ? " bad" : who.length === 1 ? " one" : "")}>
        {b.freed
          ? who.length ? `freed, still pointed at by ${who.map((k) => SLOT_LABEL[k]).join(", ")}` : "freed"
          : garbage ? "garbage: collected later"
          : who.length === 0 ? "no owner"
          : who.length === 1 ? `owner: ${SLOT_LABEL[who[0]]}`
          : `shared by ${who.map((k) => SLOT_LABEL[k]).join(", ")}`}
      </span>
    </div>
  );
}

function Side({ st, dispatch, freshSlot }: { st: State; dispatch: (a: Action) => void; freshSlot: (s: Slot) => boolean }) {
  const ptr = (s: Slot) => {
    const b = st.slots[s].block;
    return b === null ? null : <span className={`ownership-ptr b${b}`}>→ {H(b)}</span>;
  };
  return (
    <div className="ownership-col" aria-label="Other owners">
      <span className="label">Audit task, pool, next request</span>
      <div className={"ownership-card" + (freshSlot("audit") ? " ownership-fresh" : "")}>
        <header><span className="ownership-name">audit task · entry</span>{st.auditDone ? <span className="ownership-note">done</span> : ptr("audit")}</header>
        <p className="ownership-note">{st.slots.audit.block === null ? "Waiting for a frame. It runs 30 ms behind." : st.auditDone ? "Wrote its entry and ended its scope." : "Has a frame queued, not yet written."}</p>
        <div className="ownership-btns">
          <PgButton onClick={() => dispatch({ type: "auditWrite" })} disabled={!canAudit(st)} title="The audit task appends its entry to the log">log.append(&amp;entry)</PgButton>
        </div>
      </div>
      <div className={"ownership-card" + (freshSlot("pool") ? " ownership-fresh" : "")}>
        <header><span className="ownership-name">pool</span>{ptr("pool")}</header>
        <p className="ownership-note">{st.slots.pool.block === null ? "Empty." : "Holds a buffer for the next request."}</p>
      </div>
      <div className={"ownership-card" + (freshSlot("next") ? " ownership-fresh" : "")}>
        <header><span className="ownership-name">next request · globex</span>{ptr("next")}</header>
        <div className="ownership-btns">
          <PgButton onClick={() => dispatch({ type: "nextRequest" })} disabled={!canNext(st)} title="The next request takes a buffer and reads globex's frame into it">pool.take() + read</PgButton>
        </div>
      </div>
    </div>
  );
}

const n = (k: number, one: string, many = one + "s") => `${k} ${k === 1 ? one : many}`;

function Numbers({ st }: { st: State }) {
  const rows: { k: keyof Tally; label: string; bad?: boolean }[] = [
    { k: "steps", label: "Steps run" },
    { k: "compileErrors", label: "Refused by the compiler" },
    { k: "goodEntries", label: "Correct audit entries" },
    { k: "wrongEntries", label: "Wrong audit entries", bad: true },
    { k: "useAfterFree", label: "Reads of freed memory", bad: true },
    { k: "doubleFrees", label: "Double frees", bad: true },
    { k: "bytesCopied", label: "Bytes cloned" },
  ];
  return (
    <table className="ownership-table" aria-label="Numbers per mode">
      <thead><tr><th>All runs</th><th>Rust</th><th>GC</th><th>Manual</th></tr></thead>
      <tbody>
        {rows.map((r) => (
          <tr key={r.k}>
            <td>{r.label}</td>
            {(["rust", "gc", "manual"] as Mode[]).map((m) => (
              <td key={m} className={r.bad && st.totals[m][r.k] > 0 ? "bad" : ""}>{st.totals[m][r.k]}</td>
            ))}
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function Result({ st }: { st: State }) {
  const t = st.totals;
  const tried = (["rust", "gc", "manual"] as Mode[]).filter((m) => t[m].steps > 0);
  if (tried.length < 2) return null;
  const bits: string[] = [];
  if (t.rust.steps) bits.push(`In Rust mode the compiler refused ${n(t.rust.compileErrors, "step")} and ${n(t.rust.wrongEntries, "audit entry", "audit entries")} went wrong`);
  if (t.gc.steps) bits.push(`with a garbage collector ${n(t.gc.wrongEntries, "entry", "entries")} recorded another tenant's frame`);
  if (t.manual.steps) bits.push(`with manual free you hit ${n(t.manual.doubleFrees, "double free")} and ${n(t.manual.useAfterFree, "read")} of freed memory`);
  return (
    <div className="pg-result" aria-live="polite">
      <span className="label">Your numbers</span>
      <p>{bits.join("; ")}.{t.rust.bytesCopied ? ` Your clones copied ${t.rust.bytesCopied.toLocaleString("en-US")} bytes in Rust, each one written down in the code.` : ""}</p>
      <p className="pg-takeaway">
        The mistakes were the same steps in every mode: two parties both acting as if they owned one buffer. A garbage
        collector stops the crash but not the mix-up, and manual free gets both. Rust gives each allocation one owner, so
        the second claim is a compile error and the free happens once, at the owner&apos;s closing brace.
      </p>
    </div>
  );
}

const GUESSES: { value: Guess; label: string }[] = [
  { value: "shared", label: "The pool and the audit task share it" },
  { value: "copy", label: "The pool gets a copy of the 4 KiB" },
  { value: "error", label: "It does not compile" },
];

export default function Ownership() {
  const { state: st, dispatch, reduced } = useModel(step, init);
  const freshSlot = (s: Slot) => st.touched.slots.includes(s) && !reduced;
  return (
    <PgFrame title="One frame buffer, three memory models" onReset={() => dispatch({ type: "reset" })}>
      <style>{CSS}</style>
      <p className="pg-rule">
        ingest has read a 4 KiB frame from tenant acme into a pooled buffer. Click the lines of code on each name to run
        them. The heap in the middle shows who points at each buffer. <b>Run the same steps in each mode and watch who frees what.</b>
      </p>

      <PgPredict<Guess>
        question="Rust mode: buf owns the frame. You run audit.send(buf), then pool.put(buf). What happens on the second line?"
        options={GUESSES}
        value={st.guess}
        onChange={(g) => dispatch({ type: "guess", guess: g })}
        revealed={revealed(st)}
        answer={ANSWER}
        explain="send(buf) moved the buffer into the channel. buf no longer owns anything, so pool.put(buf) is error E0382, use of moved value. Nothing is shared and nothing is copied unless you call clone(). Now try the same two steps in GC mode."
      />

      <div className="pg-actions" style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
        <span className="label">Memory model</span>
        <PgChoice<Mode> label="Memory model" value={st.mode}
          options={(["rust", "gc", "manual"] as Mode[]).map((m) => ({ value: m, label: MODE_LABEL[m] }))}
          onChange={(m) => dispatch({ type: "mode", mode: m })} />
      </div>
      <p className="muted">{MODE_RULE[st.mode]} Switching starts the frame again; the table keeps every run.</p>

      <div className="ownership-stage">
        <div className={"ownership-frame" + (st.ingestOpen ? "" : " closed")} aria-label="Stack frame of ingest">
          <span className="label">Stack · ingest()</span>
          <Var st={st} v="buf" dispatch={dispatch} fresh={freshSlot("buf")} />
          <Var st={st} v="copy" dispatch={dispatch} fresh={freshSlot("copy")} />
          {st.ingestOpen ? (
            <PgButton onClick={() => dispatch({ type: "endIngest" })} disabled={st.crashed} title="The closing brace of ingest: its locals go out of scope">{"}"} end of ingest</PgButton>
          ) : (
            <p className="ownership-note">Scope ended. Its locals are gone.</p>
          )}
        </div>
        <div className="ownership-col" aria-label="Heap">
          <span className="label">Heap</span>
          {st.blocks.map((b) => <HeapBlock key={b.id} st={st} b={b} fresh={st.touched.blocks.includes(b.id) && !reduced} />)}
        </div>
        <Side st={st} dispatch={dispatch} freshSlot={freshSlot} />
      </div>

      {st.error && <p className="ownership-error" role="status">{st.error}</p>}
      {st.crashed && <p className="ownership-crash" role="status">The process aborted on a double free. Pick a memory model to run the frame again.</p>}

      <div className="pg-grid">
        <div className="pg-card">
          <span className="label">What happened, newest first</span>
          <PgLog entries={st.log} empty="Nothing yet." reduced={reduced} />
        </div>
        <div className="pg-card">
          <span className="label">Challenges</span>
          <ul className="ownership-goals" aria-label="Challenges">
            {CHALLENGES.map((c) => <li key={c.id} className={st.done.includes(c.id) ? "met" : ""}>{c.text}</li>)}
          </ul>
          <Numbers st={st} />
        </div>
      </div>

      <Result st={st} />

      <PgSources links={[
        { title: "Aquascope (Brown University)", href: "https://cel.cs.brown.edu/aquascope/" },
        { title: "RustViz: Interactively Visualizing Ownership and Borrowing", href: "https://arxiv.org/abs/2011.09012" },
        { title: "The Rust Book, chapter 4.1", href: "https://doc.rust-lang.org/book/ch04-01-what-is-ownership.html" },
      ]} />
    </PgFrame>
  );
}
