"use client";
import { useState } from "react";
import { PgButton, PgChoice, PgFrame, PgPredict, PgSources, useModel } from "../kit";
import {
  DEFAULT_HOST, GOALS, PRESETS, SCALE, big, describe, disasm, history, init, program, step, walk,
} from "./model";

const n = (k: number, one: string, many = one + "s") => `${k} ${k === 1 ? one : many}`;
const show = (v: unknown) => JSON.stringify(v);
const ENVS = ["prod", "staging", "dev"];

type Guess = "5" | "10" | "fail";

export default function BytecodePlayground() {
  const { state: st, dispatch, reduced } = useModel(step, init);
  const [guess, setGuess] = useState<Guess | null>(null);
  const p = program(st);
  const vm = st.vm;
  const c = p.chunk;
  const ran = c ? history(c, p.slots, vm.executed) : [];
  const ranSet = new Set(ran);
  const next = c && !vm.done ? c.code[vm.ip] : null;
  const focus = c ? (vm.done ? (vm.last !== null ? c.code[vm.last] : null) : c.code[vm.ip]) : null;
  const tw = p.tree ? walk(p.tree, st.host) : null;
  const evals = SCALE.rules * SCALE.series;
  const revealed = st.src === PRESETS[0].src && st.jumps && st.host.requests === 0 && vm.done;

  return (
    <PgFrame title="Compile a rule to bytecode and step the VM" onReset={() => { setGuess(null); dispatch({ type: "reset" }); }}>
      <PgPredict<Guess>
        question="The service is idle, so requests is 0. The guarded ratio compiles to 10 instructions. How many of them run?"
        options={[{ value: "5", label: "5" }, { value: "10", label: "All 10" }, { value: "fail", label: "It fails: division by zero" }]}
        value={guess} onChange={setGuess} revealed={revealed} answer="5"
        explain={<>requests &gt; 0 is false, so the and is already false. The compiler put a conditional jump right after the left side, aimed just past the right side, so the VM jumps from instruction 3 to RETURN. The division never runs. That jump is how bytecode keeps the short-circuit the tree walker had.</>}
      />
      {!revealed && <p className="vm-small muted">Run the Guarded ratio on the idle service (requests 0) to check your answer.</p>}

      <div className="pg-grid">
        <div className="pg-card">
          <span className="label">The rule · compiled once, when it is saved</span>
          <div className="pg-actions">
            {PRESETS.map((pr, i) => (
              <button key={pr.label} className={"pg-btn" + (st.src === pr.src ? " primary" : "")} aria-pressed={st.src === pr.src} onClick={() => dispatch({ type: "preset", index: i })}>{pr.label}</button>
            ))}
          </div>
          <input className="vm-input" spellCheck={false} aria-label="Alert rule" value={st.src} onChange={(e) => dispatch({ type: "edit", src: e.target.value })} />
          <p className="vm-src" aria-label="Source span of the current instruction">
            {focus ? <>{st.src.slice(0, focus.span[0])}<mark>{st.src.slice(focus.span[0], focus.span[1])}</mark>{st.src.slice(focus.span[1])}</> : st.src}
          </p>
          <PgChoice<"jumps" | "ops"> label="How and/or compile" value={st.jumps ? "jumps" : "ops"}
            options={[{ value: "jumps", label: "and/or as jumps" }, { value: "ops", label: "as AND/OR instructions (break it)" }]}
            onChange={(v) => { if ((v === "jumps") !== st.jumps) dispatch({ type: "jumps" }); }} />
        </div>
        <div className="pg-card">
          <span className="label">The service this run reads · edit any metric</span>
          <div className="vm-host">
            {Object.keys(DEFAULT_HOST).map((k) => (
              <label key={k}>
                <span>{k}</span>
                {k === "env"
                  ? <select value={String(st.host[k])} onChange={(e) => dispatch({ type: "host", key: k, value: e.target.value })}>{ENVS.map((e) => <option key={e}>{e}</option>)}</select>
                  : <input type="number" step="any" value={Number(st.host[k])} onChange={(e) => dispatch({ type: "host", key: k, value: e.target.value === "" ? 0 : Number(e.target.value) })} />}
              </label>
            ))}
          </div>
          {c && <p className="vm-small muted">Slots: {c.slots.map((s, i) => `${i}=${s}`).join(", ")}. The engine fills this array from the series once; the VM reads it by index.</p>}
        </div>
      </div>

      {p.error || !c ? <p className="vm-small vm-bad">{p.error}</p> : (
        <div className="pg-grid">
          <div className="pg-card">
            <span className="label">Bytecode · {n(c.code.length, "instruction")}, {n(c.consts.length, "constant")}</span>
            <table className="vm-code">
              <tbody>
                {c.code.map((ins, i) => {
                  const d = disasm(c, i);
                  const state = !vm.done && i === vm.ip ? "next" : vm.last === i ? "last" : ranSet.has(i) ? "ran" : vm.done || (vm.executed > 0 && i < vm.ip) ? "skip" : "";
                  return (
                    <tr key={i} className={"vm-row " + state + (ins.op.startsWith("JUMP") ? " jump" : "") + (ins.op === "AND" || ins.op === "OR" ? " eager" : "")}>
                      <td className="vm-ip" aria-label={state === "next" ? "instruction pointer" : undefined}>{state === "next" ? "▶" : ""}</td>
                      <td className="vm-off">{d.offset}</td>
                      <td className="vm-op">{d.op}</td>
                      <td className="vm-arg">{d.arg} <i>{d.note}</i></td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
            <p className="vm-small muted">▶ next to run · bold: ran · faded: never ran (jumped over)</p>
          </div>

          <div className="pg-card">
            <span className="label">The VM · ip {vm.done ? "–" : vm.ip}</span>
            <div className="pg-actions">
              <PgButton primary onClick={() => dispatch({ type: "step" })} disabled={vm.done}>{vm.executed === 0 ? "Start" : "Step"}</PgButton>
              <PgButton onClick={() => dispatch({ type: "run" })} disabled={vm.done}>Run to end</PgButton>
              <PgButton onClick={() => dispatch({ type: "restart" })} disabled={vm.executed === 0}>Restart</PgButton>
            </div>
            <div className="vm-stack" aria-label="Value stack, top first">
              <span className="vm-stack-label">stack top</span>
              {[...vm.stack].reverse().map((v, i) => (
                <div key={vm.stack.length - i} className={"vm-cell" + (i === 0 && !reduced ? " fresh" : "")}>{show(v)}</div>
              ))}
              {vm.stack.length === 0 && <div className="vm-cell empty">empty</div>}
            </div>
            <p className={"vm-why" + (vm.error ? " bad" : "")} aria-live="polite">
              {vm.error ? <><b>Runtime error at {vm.last}:</b> {vm.error}.</>
                : vm.done ? <><b>Result:</b> {show(vm.result)}, {vm.result === true ? "the alert fires" : vm.result === false ? "no alert" : "a value"}.</>
                : next ? <><b>Next:</b> {describe(c, next)}</> : null}
            </p>
          </div>
        </div>
      )}

      {c && tw && (
        <div className="pg-card">
          <span className="label">Same rule, same service · tree walker against bytecode</span>
          <table className="vm-compare">
            <thead><tr><th></th><th>Tree walker</th><th>Bytecode VM {vm.done ? "" : "(so far)"}</th></tr></thead>
            <tbody>
              <tr><td>Work done</td><td>{n(tw.visits, "node visit")}, each a call</td><td>{n(vm.executed, "instruction")} in one loop</td></tr>
              <tr><td>Metric name lookups</td><td>{tw.lookups}</td><td>0 (slots by index)</td></tr>
              <tr><td>Deepest point</td><td>recursion depth {tw.depth}</td><td>{n(vm.maxStack, "value")} on the stack</td></tr>
              <tr><td>Answer</td><td>{tw.error ? `error: ${tw.error}` : show(tw.value)}</td><td className={vm.error ? "vm-bad" : ""}>{vm.done ? (vm.error ? `error: ${vm.error}` : show(vm.result)) : "…"}</td></tr>
              <tr><td>Every {SCALE.everySeconds} s at {SCALE.rules} rules × {big(SCALE.series)} series</td><td>{big(tw.visits * evals)} calls, {big(tw.lookups * evals)} lookups</td><td>{vm.done ? `${big(vm.executed * evals)} instructions, 0 lookups` : "run to the end"}</td></tr>
            </tbody>
          </table>
        </div>
      )}

      <div className="pg-req">
        <span className="label">Try these</span>
        <ul className="vm-goals">
          {GOALS.map((g) => <li key={g.id} className={st.goals[g.id] ? "done" : ""}>{st.goals[g.id] ? "✓ " : "○ "}{g.text}</li>)}
        </ul>
      </div>

      {vm.done && c && tw && (
        <div className="pg-result" aria-live="polite">
          <span className="label">What your run did</span>
          <p>
            Your rule compiled once into {n(c.code.length, "instruction")} and {n(c.consts.length, "constant")}. On this service the VM ran {n(vm.executed, "instruction")}
            {vm.jumpsTaken > 0 ? <>, and {n(vm.jumpsTaken, "jump")} skipped {n(vm.skipped, "instruction")}</> : null}; the stack never held more than {n(vm.maxStack, "value")}.
            {" "}The tree walker made {n(tw.visits, "recursive call")} and {n(tw.lookups, "name lookup")} for the same answer{vm.error ? <>, while this bytecode failed with {vm.error}</> : null}.
            {" "}You have finished {n(st.runs, "run")}.
          </p>
          <p className="pg-takeaway">
            Bytecode is the tree flattened once: operands are pushed, operators pop two and push one, names became slot numbers, and and/or became jumps whose targets the compiler patched in. Running it is one loop over an array, with no recursion and no lookups by name.
          </p>
        </div>
      )}

      <PgSources links={[
        { title: "Crafting Interpreters, A Virtual Machine", href: "https://craftinginterpreters.com/a-virtual-machine.html" },
        { title: "Python's dis module", href: "https://docs.python.org/3/library/dis.html" },
        { title: "Compiler Explorer", href: "https://godbolt.org/" },
      ]} />

      <style>{`
        .vm-small { font-size: .86rem; margin: 0; }
        .vm-small.muted { color: var(--ink-2); }
        .vm-bad { color: var(--pain); }
        .vm-input { width: 100%; font-family: var(--f-code); font-size: .85rem; padding: 6px 8px; border: 1px solid var(--line); background: var(--surface); color: var(--ink); border-radius: 0; }
        .vm-src { margin: 0; font-family: var(--f-code); font-size: .8rem; padding: 6px 8px; background: var(--bg); border: 1px solid var(--line); word-break: break-word; }
        .vm-src mark { background: var(--hl); color: var(--ink); outline: 1px solid var(--accent); }
        .vm-host { display: grid; grid-template-columns: repeat(auto-fill, minmax(110px, 1fr)); gap: 6px; }
        .vm-host label { display: grid; gap: 2px; }
        .vm-host span { font-family: var(--f-code); font-size: .6rem; text-transform: uppercase; letter-spacing: .06em; color: var(--ink-2); }
        .vm-host input, .vm-host select { font-family: var(--f-code); font-size: .82rem; padding: 3px 6px; border: 1px solid var(--line); background: var(--surface); color: var(--ink); border-radius: 0; min-width: 0; }
        .vm-code { width: 100%; border-collapse: collapse; font-family: var(--f-code); font-size: .76rem; }
        .vm-code td { padding: 2px 4px; border-top: 1px solid var(--line); }
        .vm-ip { width: 1.2em; color: var(--accent); }
        .vm-off { color: var(--ink-2); width: 2em; text-align: right; }
        .vm-op { font-weight: 500; }
        .vm-arg i { font-style: normal; color: var(--ink-2); }
        .vm-row { transition: background-color .15s, opacity .15s; }
        .vm-row.next { background: var(--hl); }
        .vm-row.last { background: var(--good-bg); }
        .vm-row.ran .vm-op, .vm-row.last .vm-op { font-weight: 700; }
        .vm-row.skip { opacity: .4; }
        .vm-row.jump .vm-op { color: var(--accent); }
        .vm-row.eager .vm-op { color: var(--pain); }
        .vm-stack { display: grid; gap: 3px; align-content: start; min-height: 90px; border: 1px solid var(--line); background: var(--bg); padding: 6px; }
        .vm-stack-label { font-family: var(--f-code); font-size: .56rem; text-transform: uppercase; letter-spacing: .06em; color: var(--ink-2); }
        .vm-cell { font-family: var(--f-code); font-size: .82rem; border: 1px solid var(--accent); background: var(--surface); padding: 3px 8px; }
        .vm-cell.empty { border-style: dashed; border-color: var(--line); color: var(--ink-2); }
        .vm-cell.fresh { animation: vm-push .2s var(--ease); }
        @keyframes vm-push { from { transform: translateY(-6px); opacity: 0; } to { transform: none; opacity: 1; } }
        .vm-why { margin: 0; font-size: .9rem; border-left: 3px solid var(--accent); padding: 4px 10px; background: var(--surface); }
        .vm-why.bad { border-left-color: var(--pain); color: var(--pain); }
        .vm-compare { width: 100%; border-collapse: collapse; font-size: .82rem; }
        .vm-compare th { font-family: var(--f-code); font-size: .58rem; text-transform: uppercase; letter-spacing: .06em; color: var(--ink-2); text-align: left; padding: 2px 6px; }
        .vm-compare td { border-top: 1px solid var(--line); padding: 4px 6px; vertical-align: top; }
        .vm-compare td:first-child { color: var(--ink-2); }
        .vm-goals { list-style: none !important; padding-left: 0 !important; }
        .vm-goals li.done { color: var(--good); }
        @media (prefers-reduced-motion: reduce) { .vm-row { transition: none; } .vm-cell.fresh { animation: none; } }
      `}</style>
    </PgFrame>
  );
}
