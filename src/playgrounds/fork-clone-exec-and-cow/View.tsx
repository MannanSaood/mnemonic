"use client";
import { usePrefs } from "@/components/Prefs";
import type { Lang } from "@/lib/types";
import { PgButton, PgFrame, PgLog, PgPredict, PgSources, useModel } from "../kit";
import {
  CELLS, CELL_MIB, HOST_MIB, OTHER_MIB, SPAWN_MS, STRICT_LIMIT_MIB, THREAD_MS, committedMib, init, pageTableMib, sharedCells, step, usedMib,
  type Action, type Proc, type State,
} from "./model";

const CODE: Record<Lang, { fork: string; spawn: string; thread: string }> = {
  go: { fork: "SysProcAttr{Cloneflags: syscall.CLONE_NEWUSER, …}  // a real fork", spawn: 'exec.Command("unshare", "--user", …)  // CLONE_VM|CLONE_VFORK', thread: "go work()  // goroutines run on threads made with clone" },
  python: { fork: "subprocess.run(cmd, preexec_fn=sandbox)  # a real fork", spawn: 'subprocess.run(["setpriv", …, *cmd])  # vfork', thread: "threading.Thread(target=work).start()" },
  typescript: { fork: "execFile(cmd, args, { uid: 65534, gid: 65534 })  // libuv falls back to fork()", spawn: 'execFile("setpriv", [...SANDBOX, ...cmd])  // posix_spawn', thread: 'new Worker("work.js")  // a thread with its own V8 heap' },
  rust: { fork: "Command::new(cmd).uid(65534).gid(65534)  // fork, then exec", spawn: 'Command::new("setpriv").args(SANDBOX)  // posix_spawn', thread: "std::thread::spawn(work)" },
};

const gib = (mib: number) => `${(mib / 1024).toFixed(mib % 1024 === 0 ? 0 : 2)} GiB`;
const depth = (st: State, p: Proc): number => (p.ppid === null ? 0 : 1 + depth(st, st.procs.find((x) => x.pid === p.ppid)!));

type Dispatch = (a: Action) => void;

function Strip({ st, p, d }: { st: State; p: Proc; d: Dispatch }) {
  const m = st.mms[p.mm];
  if (!m.cells) return <p className="fk-small">pdftotext: {m.smallMib} MiB of its own memory. Nothing shared with the parent.</p>;
  if (p.kind === "thread") return <p className="fk-small">Same address space as its process: writes here are the process&apos;s writes.</p>;
  const running = p.status === "running";
  return (
    <div className="fk-strip" role="group" aria-label={`Heap of pid ${p.pid}: ${CELLS} cells of ${CELL_MIB} MiB. Press a cell to write to it.`}>
      {m.cells.map((f, i) => {
        const shared = (st.refs[f] ?? 0) > 1;
        return (
          <button key={i} className={"fk-cell" + (shared ? " shared" : "") + (f > CELLS ? " copied" : "")} disabled={!running}
            onClick={() => d({ type: "write", pid: p.pid, cell: i })}
            aria-label={`write cell ${i}, ${shared ? "shared copy-on-write" : "private"}`} title={`cell ${i}: ${shared ? "shared" : f > CELLS ? "copied" : "private"}`} />
        );
      })}
    </div>
  );
}

function ProcCard({ st, p, d }: { st: State; p: Proc; d: Dispatch }) {
  const m = st.mms[p.mm];
  const running = p.status === "running";
  const sh = m.cells && p.kind !== "thread" ? sharedCells(st, p.mm) : 0;
  return (
    <li className={"fk-proc " + p.status + (st.selected === p.pid ? " sel" : "")} style={{ marginLeft: `${Math.min(depth(st, p), 3) * 14}px` }}>
      <header>
        <b>{p.kind === "thread" ? "task" : "pid"} {p.pid}</b>
        <span>{p.name}</span>
        <span className="fk-kind">{p.kind === "root" ? "service" : p.kind === "fork" ? "forked" : p.kind === "spawn" ? "spawned" : "thread"}</span>
        {!running && <span className="fk-dead">{p.status === "killed" ? "killed by OOM" : "exited"}</span>}
        {running && m.cells && p.kind !== "thread" && <span className="fk-share">{sh ? `${gib(sh * CELL_MIB)} shared` : "all private"}</span>}
      </header>
      <Strip st={st} p={p} d={d} />
      {running && (
        <div className="pg-actions">
          {m.cells && p.kind !== "thread" && <PgButton onClick={() => d({ type: "fork", pid: p.pid })}>fork()</PgButton>}
          {p.kind === "root" && <PgButton onClick={() => d({ type: "spawn", pid: p.pid })}>spawn pdftotext</PgButton>}
          {p.kind === "root" && <PgButton onClick={() => d({ type: "thread", pid: p.pid })}>new thread</PgButton>}
          {p.kind === "root" && <PgButton onClick={() => d({ type: "burst", pid: p.pid })}>keep serving (write 1 GiB)</PgButton>}
          {p.kind === "fork" && m.cells && <PgButton primary onClick={() => d({ type: "exec", pid: p.pid })}>exec pdftotext</PgButton>}
          {p.kind !== "root" && <PgButton onClick={() => d({ type: "exit", pid: p.pid })}>exit</PgButton>}
        </div>
      )}
    </li>
  );
}

export default function ForkPlayground() {
  const { lang } = usePrefs();
  const { state: st, dispatch, reduced } = useModel(step, init);
  const used = usedMib(st), committed = committedMib(st);
  const pt = pageTableMib(st);
  const framesMib = used - OTHER_MIB - pt;
  const forked = st.created.fork > 0;
  const forkStall = Math.round(st.stallMs - st.created.spawn * SPAWN_MS - st.created.thread * THREAD_MS);

  return (
    <PgFrame title="Run a helper from an 8 GiB service" onReset={() => dispatch({ type: "reset" })}>
      <div className="pg-req">
        <span className="label">The task</span>
        <p>A service holds 8 GiB of cache on a 16 GiB host. For each upload it runs <code>pdftotext</code> as an unprivileged user. Start helpers, let the service keep writing, and watch what is shared, what gets copied and what it costs.</p>
        <div className="pgc">
          <div className="pgc-line bad"><code>{CODE[lang].fork}</code></div>
          <div className="pgc-line new"><code>{CODE[lang].spawn}</code></div>
          <div className="pgc-line"><code>{CODE[lang].thread}</code></div>
        </div>
      </div>

      <div className="pg-grid">
        <div className="pg-card">
          <PgPredict<"copy" | "tables" | "nothing">
            question="The 8 GiB service calls fork(). Right after fork returns, how much more RAM is in use?"
            options={[{ value: "copy", label: "8 GiB: a full copy" }, { value: "tables", label: "About 16 MiB" }, { value: "nothing", label: "Nothing" }]}
            value={st.prediction}
            onChange={(v) => dispatch({ type: "predict", value: v })}
            revealed={forked}
            answer="tables"
            explain="fork copies the page tables, not the pages: one 8-byte entry per 4 KiB page, 16 MiB for 8 GiB, and it marks every private page read-only in both processes. The pages themselves are copied one at a time, later, when either side writes."
          />
        </div>
        <div className="pg-card">
          <span className="label">Host</span>
          <div className="fk-mem" role="img" aria-label={`RAM used ${gib(used)} of ${gib(HOST_MIB)}`}>
            <i className="other" style={{ width: `${(100 * OTHER_MIB) / HOST_MIB}%` }} />
            <i className="heap" style={{ width: `${(100 * framesMib) / HOST_MIB}%` }} />
            <i className="pt" style={{ width: `${Math.max(0.6, (100 * pt) / HOST_MIB)}%` }} />
          </div>
          <p className="fk-memtext">RAM {gib(used)} of {gib(HOST_MIB)} · page tables {pt.toFixed(1)} MiB</p>
          {st.strict && (
            <>
              <div className="fk-mem commit" role="img" aria-label={`Committed ${gib(committed)} of ${gib(STRICT_LIMIT_MIB)} limit`}>
                <i className={committed > STRICT_LIMIT_MIB ? "over" : "heap"} style={{ width: `${Math.min(100, (100 * committed) / HOST_MIB)}%` }} />
                <b style={{ left: `${(100 * STRICT_LIMIT_MIB) / HOST_MIB}%` }} />
              </div>
              <p className="fk-memtext">Committed {gib(committed)} · limit {gib(STRICT_LIMIT_MIB)}</p>
            </>
          )}
          <span className="label">Break it</span>
          <div className="pg-actions">
            <button className="pg-btn" aria-pressed={st.strict} onClick={() => dispatch({ type: "strict" })}>{st.strict ? "✓ " : ""}Strict overcommit</button>
          </div>
        </div>
      </div>

      <div className="pg-card">
        <span className="label">Process tree</span>
        <ul className="fk-tree">{st.procs.map((p) => <ProcCard key={p.pid} st={st} p={p} d={dispatch} />)}</ul>
        <p className="fk-legend"><span className="priv">private</span><span className="shared">shared, copy-on-write</span><span className="copied">copied after fork</span></p>
        <PgLog entries={st.events} reduced={reduced} empty="Press fork() on the service. Then write to a cell in either process, or press keep serving." />
        <dl className="pg-stats">
          <div><dt>Forks · spawns</dt><dd>{st.created.fork} · {st.created.spawn}</dd></div>
          <div className={st.stallMs > 10 ? "bad" : ""}><dt>Service stalled</dt><dd>{st.stallMs.toFixed(st.stallMs < 1 ? 2 : 0)} ms</dd></div>
          <div className={st.copies ? "bad" : ""}><dt>Copied by COW</dt><dd>{gib(st.copies * CELL_MIB)}</dd></div>
          <div className={st.peakMib > 14 * 1024 ? "bad" : ""}><dt>Peak RAM</dt><dd>{gib(st.peakMib)}</dd></div>
          <div className={st.failed ? "bad" : ""}><dt>Failed forks</dt><dd>{st.failed}</dd></div>
        </dl>
      </div>

      {(forked || st.failed > 0) && (
        <div className="pg-result" aria-live="polite">
          <span className="label">What your runs showed</span>
          <p className="pg-takeaway">
            {forked && `Your ${st.created.fork} fork${st.created.fork > 1 ? "s" : ""} stalled the service ${forkStall} ms copying page tables, and writes afterwards copied ${gib(st.copies * CELL_MIB)}, page by page. `}
            {st.oom && "Writing kept copying until the host ran out of RAM and the OOM killer took the service itself. "}
            {st.failed > 0 && `With strict overcommit, fork failed ${st.failed} time${st.failed > 1 ? "s" : ""}: the kernel had to promise the child a full 8 GiB it would never use. `}
            {st.created.spawn > 0
              ? `Your ${st.created.spawn} spawn${st.created.spawn > 1 ? "s" : ""} ran the same helper for ${(st.created.spawn * 0.1).toFixed(1)} ms in total and copied nothing. To run another program from a big process, spawn it; fork is for when the child must keep the parent's memory.`
              : "Now spawn the same helper and compare."}
          </p>
        </div>
      )}

      <PgSources links={[
        { title: "Redis docs: latency generated by fork", href: "https://redis.io/docs/latest/operate/oss_and_stack/management/optimization/latency/" },
        { title: "Baumann et al.: A fork() in the road (HotOS 2019)", href: "https://www.microsoft.com/en-us/research/publication/a-fork-in-the-road/" },
        { title: "man7: clone(2)", href: "https://man7.org/linux/man-pages/man2/clone.2.html" },
      ]} />

      <style>{`
        .fk-tree { list-style: none; margin: 0; padding: 0; display: grid; gap: 8px; }
        .fk-proc { border: 1px solid var(--line); background: var(--surface); padding: 6px; display: grid; gap: 6px; border-left: 3px solid var(--accent); }
        .fk-proc.killed, .fk-proc.exited { opacity: .55; border-left-color: var(--pain); }
        .fk-proc header { display: flex; flex-wrap: wrap; gap: 4px 10px; align-items: baseline; font-family: var(--f-code); font-size: .75rem; }
        .fk-kind { text-transform: uppercase; letter-spacing: .06em; font-size: .6rem; color: var(--ink-2); }
        .fk-dead { color: var(--pain); font-weight: 700; }
        .fk-share { color: var(--ink-2); }
        .fk-strip { display: grid; grid-template-columns: repeat(32, 1fr); gap: 1px; }
        .fk-cell { height: 20px; min-width: 0; padding: 0; border: 1px solid var(--ink-2); background: var(--surface-2); cursor: pointer; transition: background .2s var(--ease); }
        .fk-cell.shared { background: repeating-linear-gradient(45deg, var(--pain-bg) 0 3px, var(--surface) 3px 6px); border-color: var(--pain); }
        .fk-cell.copied { background: var(--hl); border-color: var(--accent); }
        .fk-cell:focus-visible { outline: 2px solid var(--accent); }
        .fk-cell:disabled { cursor: default; }
        .fk-small { margin: 0; font-size: .85rem; color: var(--ink-2); }
        .fk-mem { position: relative; display: flex; height: 14px; border: 1px solid var(--line); background: var(--bg); }
        .fk-mem i { display: block; height: 100%; transition: width .3s var(--ease); }
        .fk-mem i.other { background: var(--line); }
        .fk-mem i.heap { background: var(--accent); }
        .fk-mem i.pt { background: var(--pain); }
        .fk-mem i.over { background: var(--pain); }
        .fk-mem b { position: absolute; top: -3px; bottom: -3px; width: 2px; background: var(--ink); }
        .fk-memtext { margin: 2px 0 6px; font-family: var(--f-code); font-size: .7rem; color: var(--ink-2); }
        .fk-legend { display: flex; flex-wrap: wrap; gap: 4px 12px; margin: 0; font-family: var(--f-code); font-size: .65rem; color: var(--ink-2); }
        .fk-legend span::before { content: ""; display: inline-block; width: 10px; height: 10px; margin-right: 4px; vertical-align: -1px; border: 1px solid var(--ink-2); background: var(--surface-2); }
        .fk-legend .shared::before { background: repeating-linear-gradient(45deg, var(--pain-bg) 0 3px, var(--surface) 3px 6px); border-color: var(--pain); }
        .fk-legend .copied::before { background: var(--hl); border-color: var(--accent); }
        @media (prefers-reduced-motion: reduce) { .fk-cell, .fk-mem i { transition: none; } }
      `}</style>
    </PgFrame>
  );
}
