"use client";
import { usePrefs } from "@/components/Prefs";
import type { Lang } from "@/lib/types";
import { PgButton, PgChoice, PgFrame, PgPredict, PgSources, useModel } from "../kit";
import { BUF_SIZES, comparison, init, step, type BufSize, type Hop, type ReplayResult } from "./model";

const SIZE_LABEL: Record<BufSize, string> = { 0: "None", 4096: "4 KiB", 65536: "64 KiB", 1048576: "1 MiB" };
const kib = (b: BufSize) => (b >= 1048576 ? `${b / 1048576} << 20` : `${b / 1024} << 10`);

function codeFor(lang: Lang, b: BufSize): string[] {
  if (b === 0) {
    return {
      go: ["f, _ := os.Open(path)        // *os.File has no buffer", "io.ReadFull(f, hdr[:])       // read(2) for 4 bytes", "io.ReadFull(f, body[:n])     // read(2) for 96 bytes"],
      python: ['f = open(path, "rb", buffering=0)  # raw FileIO', "hdr = f.read(4)    # read(2) for 4 bytes", "body = f.read(n)   # read(2) for 96 bytes"],
      typescript: ['const fd = openSync(path, "r");', "readSync(fd, hdr, 0, 4, null);   // read(2) for 4 bytes", "readSync(fd, body, 0, n, null);  // read(2) for 96 bytes"],
      rust: ["let mut f = File::open(path)?;   // File has no buffer", "f.read_exact(&mut hdr)?;          // read(2) for 4 bytes", "f.read_exact(&mut body[..n])?;    // read(2) for 96 bytes"],
    }[lang];
  }
  const kb = b / 1024;
  return {
    go: [`r := bufio.NewReaderSize(f, ${kib(b)})`, "io.ReadFull(r, hdr[:])     // from the buffer", `io.ReadFull(r, body[:n])   // read(2) only when ${kb} KiB is used up`],
    python: [`f = open(path, "rb", buffering=${b})`, "hdr = f.read(4)    # from the buffer", `body = f.read(n)   # read(2) only when ${kb} KiB is used up`],
    typescript: [`const r = new BufReader(fd);  // readSync of ${kb} KiB at a time`, "r.read(hdr, 4);    // from the buffer", `r.read(body, n);   // read(2) only when ${kb} KiB is used up`],
    rust: [`let mut f = BufReader::with_capacity(${b}, File::open(path)?);`, "f.read_exact(&mut hdr)?;        // from the buffer", `f.read_exact(&mut body[..n])?;  // read(2) only when ${kb} KiB is used up`],
  }[lang];
}

const ms = (x: number) => (x >= 1000 ? `${(x / 1000).toFixed(1)} s` : x >= 10 ? `${Math.round(x)} ms` : `${x.toFixed(1)} ms`);
const num = (x: number) => x.toLocaleString("en-US");
const ns = (x: number) => (x >= 1000 ? `${(x / 1000).toFixed(1)} µs` : `${Math.round(x)} ns`);
const runLabel = (r: ReplayResult) => `${SIZE_LABEL[r.buffer]} buffer${r.strace ? " + strace" : ""}${r.kpti ? " + KPTI" : ""}`;

const COLS: Record<Hop["layer"], number> = { user: 1, edge: 2, kernel: 3 };

function Path({ hops, id, reduced }: { hops: Hop[]; id: number; reduced: boolean }) {
  return (
    <ol className="sp-path" key={id} aria-label="The path of this call, in order">
      <li className="sp-head" aria-hidden="true"><span>User space</span><span>Boundary</span><span>Kernel</span></li>
      {hops.map((h, i) => (
        <li key={i} className={"sp-hop " + h.layer + (reduced ? "" : " anim")} style={reduced ? undefined : { animationDelay: `${i * 160}ms` }}>
          <span className="sp-chip" style={{ gridColumn: COLS[h.layer] }}>{h.label}</span>
          <span className="sp-note">{h.note}</span>
        </li>
      ))}
    </ol>
  );
}

export default function SyscallPathPlayground() {
  const { lang } = usePrefs();
  const { state: st, dispatch, reduced } = useModel(step, init);
  const t = st.trace;
  const cmp = comparison(st.runs);
  const maxMs = Math.max(1, ...st.runs.map((r) => r.ms));

  return (
    <PgFrame title="Replay a write-ahead log at startup" onReset={() => dispatch({ type: "reset" })}>
      <div className="pg-req">
        <span className="label">The task</span>
        <p>At startup the service replays its write-ahead log: 1,000,000 records, 100 MB, already in the page cache, so no disk is involved. Each record is a 4-byte length and a 96-byte body. Restarts are slow. Trace single reads, then replay the whole log.</p>
      </div>

      <div className="pg-grid">
        <div className="pg-card">
          <span className="label">User-space buffer</span>
          <PgChoice<"0" | "4096" | "65536" | "1048576"> label="User-space buffer size" value={String(st.buffer) as "0"}
            onChange={(v) => dispatch({ type: "buffer", size: Number(v) as BufSize })}
            options={BUF_SIZES.map((b) => ({ value: String(b) as "0", label: SIZE_LABEL[b] }))} />
          <div className="pgc">{codeFor(lang, st.buffer).map((l) => <div key={l} className="pgc-line"><code>{l}</code></div>)}</div>
          <span className="label">Break it</span>
          <div className="pg-actions">
            <button className="pg-btn" aria-pressed={st.strace} onClick={() => dispatch({ type: "strace" })}>{st.strace ? "✓ " : ""}strace attached</button>
            <button className="pg-btn" aria-pressed={st.kpti} onClick={() => dispatch({ type: "kpti" })}>{st.kpti ? "✓ " : ""}Older CPU (KPTI)</button>
          </div>
        </div>

        <div className="pg-card">
          <PgPredict<"same" | "2x" | "10x">
            question="The whole log is already in RAM. Replay it once with no buffer and once with a 64 KiB buffer. How much faster is the buffered replay?"
            options={[{ value: "same", label: "About the same" }, { value: "2x", label: "About 2x" }, { value: "10x", label: "More than 10x" }]}
            value={st.prediction}
            onChange={(v) => dispatch({ type: "predict", value: v })}
            revealed={cmp !== null}
            answer="10x"
            explain="Both replays copy the same 100 MB. The difference is the number of trips into the kernel: two per record without a buffer, one per 64 KiB with it. Each trip costs the same whether it carries 4 bytes or 65,536."
          />
        </div>
      </div>

      <div className="pg-card">
        <span className="label">Trace one call</span>
        <div className="pg-actions">
          <PgButton primary onClick={() => dispatch({ type: "step" })}>Trace the next read()</PgButton>
          <PgButton onClick={() => dispatch({ type: "vdso" })}>Trace clock_gettime()</PgButton>
        </div>
        {!t && <p className="pg-empty">Press Trace the next read(). Each press is one read your loop makes: a 4-byte header, then a 96-byte body.</p>}
        {t && (
          <>
            <Path hops={t.hops} id={st.traceId} reduced={reduced} />
            {t.syscall && (
              <dl className="sp-regs" aria-label="Registers at the syscall instruction">
                <div><dt>rax</dt><dd>0 (read)</dd></div>
                <div><dt>rdi</dt><dd>3 (fd)</dd></div>
                <div><dt>rsi</dt><dd>buffer address</dd></div>
                <div><dt>rdx</dt><dd>{num(t.count)}</dd></div>
                <div><dt>returns</dt><dd>rax = {num(t.count)}</dd></div>
              </dl>
            )}
            <p className="sp-verdict" aria-live="polite">
              {t.kind === "vdso"
                ? `About ${ns(t.ns)}, all in user space.`
                : t.syscall
                  ? `One trip into the kernel for ${num(t.count)} bytes: about ${ns(t.ns)}.`
                  : `No trip into the kernel: about ${ns(t.ns)}.`}
            </p>
          </>
        )}
        <dl className="pg-stats">
          <div><dt>Reads your code made</dt><dd>{num(st.appReads)}</dd></div>
          <div className={st.stepSyscalls && st.stepSyscalls === st.appReads ? "bad" : ""}><dt>read(2) syscalls</dt><dd>{num(st.stepSyscalls)}</dd></div>
          <div><dt>Mode switches</dt><dd>{num(st.stepSyscalls * 2)}</dd></div>
        </dl>
      </div>

      <div className="pg-card">
        <span className="label">Replay the whole log</span>
        <div className="pg-actions">
          <PgButton primary onClick={() => dispatch({ type: "replay" })}>Replay 1,000,000 records ({SIZE_LABEL[st.buffer]} buffer{st.strace ? ", strace" : ""}{st.kpti ? ", KPTI" : ""})</PgButton>
        </div>
        {st.last && (
          <dl className="pg-stats" aria-live="polite">
            <div className={st.last.syscalls > 100000 ? "bad" : ""}><dt>read(2) syscalls</dt><dd>{num(st.last.syscalls)}</dd></div>
            <div><dt>Mode switches</dt><dd>{num(st.last.modeSwitches)}</dd></div>
            <div className={st.last.ms > 100 ? "bad" : ""}><dt>Replay time</dt><dd>{ms(st.last.ms)}</dd></div>
            <div><dt>Spent crossing</dt><dd>{Math.round((100 * st.last.crossingMs) / st.last.ms)}%</dd></div>
          </dl>
        )}
        {st.runs.length > 0 && (
          <div className="sp-bars" role="list" aria-label="Replay times by configuration">
            {st.runs.map((r) => (
              <div key={runLabel(r)} className="sp-bar" role="listitem">
                <span className="sp-bar-l">{runLabel(r)}</span>
                <span className="sp-bar-t"><i className={r.ms > 100 ? "bad" : ""} style={{ width: `${Math.max(0.5, (100 * r.ms) / maxMs)}%` }} /></span>
                <span className="sp-bar-v">{ms(r.ms)} · {num(r.syscalls)} calls</span>
              </div>
            ))}
          </div>
        )}
      </div>

      {cmp && (
        <div className="pg-result" aria-live="polite">
          <span className="label">What your replays showed</span>
          <p className="pg-takeaway">
            Without a buffer, your replay made {num(cmp.slow.syscalls)} syscalls and took {ms(cmp.slow.ms)}. With a {SIZE_LABEL[cmp.fast.buffer]} buffer it made {num(cmp.fast.syscalls)} and took {ms(cmp.fast.ms)}: {cmp.speedup.toFixed(0)}x faster for the same 100 MB.
            {" "}The cost is paid per trip into the kernel, not per byte, so the fix is fewer, bigger reads.
            {st.runs.some((r) => r.strace && r.buffer === 0) ? " And with strace attached, every one of those trips also stops for the tracer: profile with strace -c on a buffered run, or use perf trace." : " Now attach strace and replay without a buffer."}
          </p>
        </div>
      )}

      <PgSources links={[
        { title: "packagecloud: The Definitive Guide to Linux System Calls", href: "https://blog.packagecloud.io/the-definitive-guide-to-linux-system-calls/" },
        { title: "Brendan Gregg: strace Wow Much Syscall", href: "https://www.brendangregg.com/blog/2014-05-11/strace-wow-much-syscall.html" },
        { title: "Julia Evans: strace zine", href: "https://wizardzines.com/zines/strace/" },
      ]} />

      <style>{`
        .sp-path { list-style: none; margin: 8px 0 0; padding: 0; display: grid; gap: 4px; background-image: linear-gradient(var(--grid) 1px, transparent 1px), linear-gradient(90deg, var(--grid) 1px, transparent 1px); background-size: 12px 12px; border: 1px solid var(--line); padding: 6px; }
        .sp-head, .sp-hop { display: grid; grid-template-columns: 1fr 1fr 1fr; column-gap: 6px; }
        .sp-head span { font-family: var(--f-code); font-size: .6rem; letter-spacing: .08em; text-transform: uppercase; color: var(--ink-2); border-bottom: 1px dashed var(--line); padding-bottom: 2px; }
        .sp-head span:nth-child(2) { text-align: center; }
        .sp-head span:nth-child(3) { text-align: right; }
        .sp-chip { grid-row: 1; font-family: var(--f-code); font-size: .72rem; border: 1px solid var(--line); background: var(--surface); padding: 2px 6px; justify-self: start; overflow-wrap: anywhere; }
        .sp-hop.edge .sp-chip { justify-self: center; border-color: var(--pain); color: var(--pain); background: var(--pain-bg); font-weight: 700; }
        .sp-hop.kernel .sp-chip { justify-self: end; border-color: var(--accent); background: var(--hl); }
        .sp-note { grid-column: 1 / -1; grid-row: 2; font-size: .82rem; color: var(--ink-2); }
        .sp-hop.kernel .sp-note { text-align: right; }
        .sp-hop.edge .sp-note { text-align: center; }
        .sp-hop.anim { opacity: 0; animation: sp-in .25s var(--ease) forwards; }
        @keyframes sp-in { from { opacity: 0; transform: translateY(-3px); } to { opacity: 1; transform: none; } }
        .sp-regs { display: flex; flex-wrap: wrap; gap: 4px 12px; margin: 8px 0 0; font-family: var(--f-code); font-size: .75rem; }
        .sp-regs div { display: flex; gap: 4px; }
        .sp-regs dt { color: var(--ink-2); text-transform: uppercase; }
        .sp-regs dd { margin: 0; }
        .sp-verdict { margin: 6px 0 0; font-weight: 600; }
        .sp-bars { display: grid; gap: 4px; margin-top: 8px; }
        .sp-bar { display: grid; grid-template-columns: minmax(7em, 11em) 1fr; gap: 2px 8px; align-items: center; font-size: .82rem; }
        .sp-bar-l { font-family: var(--f-code); font-size: .72rem; }
        .sp-bar-t { height: 10px; border: 1px solid var(--line); background: var(--surface); }
        .sp-bar-t i { display: block; height: 100%; background: var(--accent); transition: width .3s var(--ease); }
        .sp-bar-t i.bad { background: var(--pain); }
        .sp-bar-v { grid-column: 2; font-family: var(--f-code); font-size: .7rem; color: var(--ink-2); }
        @media (prefers-reduced-motion: reduce) { .sp-hop.anim { animation: none; opacity: 1; } .sp-bar-t i { transition: none; } }
      `}</style>
    </PgFrame>
  );
}
