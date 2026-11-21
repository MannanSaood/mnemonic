"use client";
import { useState } from "react";
import { usePrefs } from "@/components/Prefs";
import type { Lang } from "@/lib/types";
import { PgButton, PgChoice, PgFrame, PgPredict, PgSources, useModel } from "../kit";
import {
  CHALLENGES, EVICT_BELOW, HORIZON, NODE_CPU, NODE_MEM, PERIOD, PODS, POD_INFO, THREADS,
  apiPeriods, effReq, init, oomScoreAdj, qos, step,
  type PodId, type Res, type Run, type State,
} from "./model";

const HOW: Record<Lang, string> = {
  go: "Go: since Go 1.25 the runtime sets GOMAXPROCS from the cgroup CPU limit, so a 1-CPU limit no longer means 16 threads burning one quota. Set GOMEMLIMIT a little below the memory limit so the GC works harder before the kernel kills.",
  python: "Python: one interpreter mostly uses one core, so CPU limits bite through worker counts: gunicorn with 2 × cores workers sized from the host, not the limit, oversubscribes the quota. Size workers from the limit.",
  typescript: "Node.js: the JS thread is one core, but libuv's pool and the GC run in parallel and can burst past a small quota. V8 sizes its heap from the container's memory limit in recent versions; buffers and native memory still count.",
  rust: "Rust: tokio sizes its worker pool from the CPUs it detects, and on Linux std::thread::available_parallelism reads the cgroup CPU quota, so a 1-CPU limit means one worker, not one per host core. No GC to slow down first: memory over the limit is an immediate OOM kill.",
};

const CPU_OPTS = [null, 100, 250, 500, 1000, 1500, 2000, 3000];
const MEM_OPTS = [null, 256, 512, 768, 1024, 1536, 2048, 3072, 4096, 4608, 5120];
const cpuLabel = (v: number | null) => (v === null ? "none" : v >= 1000 && v % 1000 === 0 ? `${v / 1000}` : `${v}m`);
const memLabel = (v: number | null) => (v === null ? "none" : v >= 1024 && v % 1024 === 0 ? `${v / 1024}Gi` : `${v}Mi`);

type Guess = "no" | "yes" | "busy";

function Pick({ label, value, opts, fmt, onChange }: { label: string; value: number | null; opts: (number | null)[]; fmt: (v: number | null) => string; onChange: (v: number | null) => void }) {
  return (
    <label className="rlq-pick">
      <span>{label}</span>
      <select value={value === null ? "none" : String(value)} onChange={(e) => onChange(e.target.value === "none" ? null : Number(e.target.value))}>
        {opts.map((o) => <option key={String(o)} value={o === null ? "none" : String(o)}>{fmt(o)}</option>)}
        {value !== null && !opts.includes(value) && <option value={String(value)}>{fmt(value)}</option>}
      </select>
    </label>
  );
}

function Bars({ st, t }: { st: State; t: number }) {
  const s = st.settings, run = st.run;
  const ids = PODS.filter((p) => p !== "import" || s.importOn);
  const scheduled = (id: PodId) => !run || run.pods.find((p) => p.id === id)?.scheduled;
  const req = (id: PodId, kind: "cpu" | "mem") => kind === "cpu" ? effReq(s.res[id].cpuReq, s.res[id].cpuLim) : effReq(s.res[id].memReq, s.res[id].memLim);
  const use = (id: PodId, kind: "cpu" | "mem") => run?.pods.find((p) => p.id === id)?.secs[t]?.[kind] ?? 0;
  const row = (label: string, total: number, val: (id: PodId) => number, unit: (v: number) => string, dashedFrom?: number) => {
    const sum = ids.reduce((a, id) => a + val(id), 0);
    return (
      <div className="rlq-bar-row">
        <span className="label">{label} · {unit(sum)} of {unit(total)}</span>
        <div className={"rlq-bar" + (sum > total ? " over" : "")}>
          {ids.map((id, i) => val(id) > 0 && (
            <i key={id} className={`rlq-seg p${i}`} style={{ width: `${Math.min(100, (val(id) / total) * 100)}%` }} title={`${POD_INFO[id].name}: ${unit(val(id))}`}>
              {val(id) / total > 0.09 ? <span>{POD_INFO[id].name}</span> : null}
            </i>
          ))}
          {dashedFrom !== undefined && <b className="rlq-evict" style={{ left: `${(dashedFrom / total) * 100}%` }} aria-hidden="true" />}
        </div>
      </div>
    );
  };
  const fmtCpu = (v: number) => `${(v / 1000).toFixed(v % 1000 ? 2 : 0)} CPU`;
  const fmtMem = (v: number) => `${(v / 1024).toFixed(1)} GiB`;
  return (
    <div className="pg-card rlq-node">
      <span className="label">One node · 4 CPU, 8 GiB allocatable</span>
      <p className="rlq-sub">The scheduler sees requests{s.importOn && run && !scheduled("import") ? " (the import does not fit)" : ""}:</p>
      {row("CPU requested", NODE_CPU, (id) => (scheduled(id) ? req(id, "cpu") : 0), fmtCpu)}
      {row("Memory requested", NODE_MEM, (id) => (scheduled(id) ? req(id, "mem") : 0), fmtMem)}
      {run && <>
        <p className="rlq-sub">The kernel sees usage, at t = {t} s:</p>
        {row("CPU used", NODE_CPU, (id) => use(id, "cpu"), fmtCpu)}
        {row("Memory used", NODE_MEM, (id) => use(id, "mem"), fmtMem, NODE_MEM - EVICT_BELOW)}
      </>}
    </div>
  );
}

function MemTimeline({ run, st }: { run: Run; st: State }) {
  const W = 600, X0 = 72, ROW = 34, PX = (W - X0 - 6) / HORIZON;
  const H = 14 + run.pods.length * ROW + 14;
  const max = 5120;
  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="rlq-svg" role="img" aria-label="Memory of each pod over 60 seconds, with its request and limit, and kills and evictions marked.">
      {run.pods.map((p, i) => {
        const y0 = 10 + i * ROW, h = ROW - 8;
        const yv = (mi: number) => y0 + h - (Math.min(mi, max) / max) * h;
        const r = st.settings.res[p.id];
        const reqM = effReq(r.memReq, r.memLim);
        const pts = p.secs.map((x, t) => `${X0 + t * PX},${yv(x.mem)}`).join(" ");
        return (
          <g key={p.id}>
            <text x={4} y={y0 + 11} className="rlq-name">{POD_INFO[p.id].name}</text>
            <text x={4} y={y0 + 22} className="rlq-tiny">{p.scheduled ? p.qos : "Pending"}</text>
            <rect x={X0} y={y0} width={W - X0 - 6} height={h} className="rlq-lane" />
            {p.scheduled && <polyline points={pts} className="rlq-line" />}
            {reqM > 0 && <line x1={X0} x2={W - 6} y1={yv(reqM)} y2={yv(reqM)} className="rlq-req"><title>{`request ${reqM} Mi`}</title></line>}
            {r.memLim !== null && <line x1={X0} x2={W - 6} y1={yv(r.memLim)} y2={yv(r.memLim)} className="rlq-lim"><title>{`limit ${r.memLim} Mi`}</title></line>}
            {run.events.filter((e) => e.pod === p.id && e.kind !== "pending").map((e, j) => (
              <text key={j} x={X0 + e.t * PX} y={y0 + 12} textAnchor="middle" className={"rlq-ev " + e.kind}>{e.kind === "done" ? "✓" : e.kind === "evict" ? "⏏" : "✕"}<title>{e.text}</title></text>
            ))}
          </g>
        );
      })}
      {[0, 20, 40, 60].map((t) => <text key={t} x={X0 + t * PX} y={H - 2} textAnchor="middle" className="rlq-tiny">{t} s</text>)}
    </svg>
  );
}

function Periods({ st, t }: { st: State; t: number }) {
  const lim = st.settings.res.api.cpuLim;
  const quota = lim === null ? null : (lim / 1000) * PERIOD;
  const work = apiPeriods(t);
  const W = 300, H = 110, top = 300;
  const y = (ms: number) => H - 14 - (Math.min(ms, top) / top) * (H - 24);
  const bw = (W - 20) / 10;
  return (
    <div className="pg-card">
      <span className="label">The API's CPU at t = {t} s · ten 100 ms periods · quota = limit × 100 ms</span>
      <svg viewBox={`0 0 ${W} ${H}`} className="rlq-svg" role="img" aria-label={`CPU work per period: ${work.join(", ")} ms. Quota ${quota ?? "none"} ms.`}>
        {work.map((w, i) => {
          const x = 10 + i * bw;
          const ok = quota === null ? w : Math.min(w, quota);
          return (
            <g key={i}>
              <rect x={x + 2} y={y(ok)} width={bw - 4} height={y(0) - y(ok)} className="rlq-work" />
              {quota !== null && w > quota && <rect x={x + 2} y={y(w)} width={bw - 4} height={y(quota) - y(w)} className="rlq-throttle"><title>{`${w - quota} ms of work waits for the next period`}</title></rect>}
              <text x={x + bw / 2} y={H - 3} textAnchor="middle" className="rlq-tiny">{w}</text>
            </g>
          );
        })}
        {quota !== null && <line x1={8} x2={W - 8} y1={y(quota)} y2={y(quota)} className="rlq-lim" />}
        {quota !== null && <text x={W - 10} y={y(quota) - 3} textAnchor="end" className="rlq-tiny bad">quota {quota} ms</text>}
      </svg>
      <p className="rlq-note">Bars: CPU-ms of work in each period, run on {THREADS} threads. Red: work past the quota. Every thread then waits for the next period, so those requests take 100 ms longer.</p>
    </div>
  );
}

function Result({ st }: { st: State }) {
  const r = st.run;
  if (!r) return null;
  const a = r.api;
  const lim = st.settings.res.api.cpuLim;
  const killed = r.events.filter((e) => e.kind === "oomkill" || e.kind === "kernel-oom" || e.kind === "evict");
  const pend = r.pods.filter((p) => !p.scheduled);
  let takeaway = "Requests are a reservation the scheduler adds up and a weight under contention. Limits are enforced by the kernel: over the CPU limit you wait for the next 100 ms period, over the memory limit you are killed. When the whole node runs short, pods above their requests go first.";
  if (pend.length) takeaway = "The scheduler adds up requests, never usage. A request that covers a rare peak reserves that much all the time, so a mostly idle node can refuse a pod. Lowering requests fits more pods, and moves the risk to the moment their usage adds up.";
  else if (killed.some((e) => e.kind === "kernel-oom")) takeaway = "Memory grew faster than the kubelet checks, so the kernel's OOM killer acted first, by oom_score: memory used plus oom_score_adj from the QoS class. Requests below real usage are what made the node overcommitted.";
  else if (killed.some((e) => e.kind === "evict")) takeaway = "The kubelet evicted the pod furthest above its memory request, whatever its QoS class. A pod that requests what it really uses is evicted last. Guaranteed pods are just the case where usage cannot exceed the request.";
  else if (killed.some((e) => e.kind === "oomkill")) takeaway = "A container above its own memory limit is killed even when the node has plenty free: the limit is a cgroup's memory.max. Exit code 137 and reason OOMKilled say so.";
  else if (a.throttledPct > 0 && lim !== null) takeaway = "The average says the API uses well under its limit. The quota is checked every 100 ms, and a burst on four threads spends it in a fraction of a period; then every thread waits. Throttling shows in latency and in nr_throttled, not in CPU graphs.";
  return (
    <div className="pg-result" aria-live="polite">
      <span className="label">Your node, in your numbers</span>
      <p>
        Requests reserve {(r.reqCpu / 1000).toFixed(2)} of 4 CPU and {(r.reqMem / 1024).toFixed(1)} of 8 GiB; memory use peaked at {(r.peakMem / 1024).toFixed(1)} GiB.
        {pend.length ? ` ${pend.map((p) => POD_INFO[p.id].name).join(", ")} stayed Pending.` : ""}
        {" "}The API averaged {a.avgCpu}m CPU {lim !== null ? `against a ${cpuLabel(lim)} limit (${Math.round((a.avgCpu / lim) * 100)}%)` : "with no limit"}, was throttled in {a.throttledPct}% of periods, and its slowest burst took {a.worst} ms.
        {killed.length ? ` ${killed.map((e) => `${POD_INFO[e.pod].name} was ${e.kind === "evict" ? "evicted" : e.kind === "oomkill" ? "OOMKilled by its limit" : "killed by the kernel OOM killer"} at ${e.t} s`).join("; ")}.` : " No container was killed or evicted."}
      </p>
      <p className="pg-takeaway">{takeaway}</p>
    </div>
  );
}

export default function RequestsLimitsPlayground() {
  const { lang } = usePrefs();
  const { state: st, dispatch } = useModel(step, init);
  const [guess, setGuess] = useState<Guess | null>(null);
  const [t, setT] = useState(23);
  const s = st.settings, run = st.run, f = st.found;
  const ids = PODS.filter((p) => p !== "import" || s.importOn);
  const set = (pod: PodId, field: keyof Res, value: number | null) => dispatch({ type: "res", pod, field, value });
  const status = (id: PodId) => {
    const p = run?.pods.find((x) => x.id === id);
    if (!p) return "–";
    if (!p.scheduled) return "Pending";
    if (p.evicted) return "Evicted";
    const parts = [p.oomKills ? `OOMKilled ×${p.oomKills}` : "", p.kernelKills ? `node OOM ×${p.kernelKills}` : "", p.completed ? "Completed" : ""].filter(Boolean);
    return parts.join(" · ") || "Running";
  };

  return (
    <PgFrame title="One node, five pods, the kernel and the kubelet" onReset={() => { setGuess(null); setT(23); dispatch({ type: "reset" }); }}
      toolbar={<PgButton primary onClick={() => dispatch({ type: "run" })}>{run ? "Run again" : "Run 60 s"}</PgButton>}>
      <PgPredict<Guess>
        question="The API averages about 0.4 CPU, and its CPU limit is 1 CPU. The node has spare CPU. Is the API ever throttled?"
        options={[
          { value: "no", label: "No: it uses under half its limit" },
          { value: "yes", label: "Yes: some 100 ms periods use more than the quota" },
          { value: "busy", label: "Only when the node is busy" },
        ]}
        value={guess} onChange={setGuess} revealed={!!run} answer="yes"
        explain={<>A 1-CPU limit is a quota of 100 ms of CPU time per 100 ms period, shared by all the container's threads. Once a second the API does a {apiPeriods(0)[3]} ms burst on {THREADS} threads, spends the quota in about 25 ms, and waits out the rest of the period. The average hides it; the slowest requests do not.</>}
      />

      <div className="rlq-top">
        <Bars st={st} t={t} />
        <Periods st={st} t={t} />
      </div>

      <div className="pg-card rlq-pods">
        <span className="label">Pods · set requests and limits</span>
        <div className="rlq-table" role="table" aria-label="Pods">
          {ids.map((id) => {
            const r = s.res[id];
            return (
              <div key={id} className="rlq-pod" role="row">
                <div className="rlq-who">
                  <b>{POD_INFO[id].name}</b>
                  <small>{POD_INFO[id].role}</small>
                  <span className={"rlq-qos " + qos(r)}>{qos(r)} · adj {oomScoreAdj(r)}</span>
                </div>
                <Pick label="CPU req" value={r.cpuReq} opts={CPU_OPTS} fmt={cpuLabel} onChange={(v) => set(id, "cpuReq", v)} />
                <Pick label="CPU lim" value={r.cpuLim} opts={CPU_OPTS} fmt={cpuLabel} onChange={(v) => set(id, "cpuLim", v)} />
                <Pick label="Mem req" value={r.memReq} opts={MEM_OPTS} fmt={memLabel} onChange={(v) => set(id, "memReq", v)} />
                <Pick label="Mem lim" value={r.memLim} opts={MEM_OPTS} fmt={memLabel} onChange={(v) => set(id, "memLim", v)} />
                <span className={"rlq-status" + (/Pending|Evicted|OOM/.test(status(id)) ? " bad" : "")}>{status(id)}</span>
              </div>
            );
          })}
        </div>
        <div className="pg-actions">
          <PgChoice<"off" | "on"> label="Nightly import" value={s.importOn ? "on" : "off"} onChange={(v) => dispatch({ type: "toggle", key: "importOn", on: v === "on" })}
            options={[{ value: "off", label: "No import" }, { value: "on", label: "Add the import pod" }]} />
          <PgChoice<"off" | "on"> label="Noisy neighbour" value={s.noisy ? "on" : "off"} onChange={(v) => dispatch({ type: "toggle", key: "noisy", on: v === "on" })}
            options={[{ value: "off", label: "Report: 1.2 CPU" }, { value: "on", label: "Report wants every CPU" }]} />
          <PgChoice<"off" | "on"> label="Report size" value={s.bigReport ? "on" : "off"} onChange={(v) => dispatch({ type: "toggle", key: "bigReport", on: v === "on" })}
            options={[{ value: "off", label: "Report peaks 3.5 GiB" }, { value: "on", label: "Big report: 4.5 GiB" }]} />
        </div>
      </div>

      {run ? (
        <div className="pg-card">
          <span className="label">Memory over 60 s · dashed: request · red: limit · ✕ killed · ⏏ evicted</span>
          <MemTimeline run={run} st={st} />
          <label className="rlq-cursor">
            <span>Inspect second <b>{t}</b> (the API's traffic spikes from 20 s to 40 s)</span>
            <input type="range" min={0} max={HORIZON - 1} value={t} onChange={(e) => setT(Number(e.target.value))} />
          </label>
          <dl className="pg-stats">
            <div><dt>API avg CPU</dt><dd>{run.api.avgCpu}m</dd></div>
            <div className={run.api.throttledPct ? "bad" : ""}><dt>Throttled periods</dt><dd>{run.api.throttledPct}%</dd></div>
            <div className={run.api.worst > 150 ? "bad" : ""}><dt>Slowest burst</dt><dd>{run.api.worst} ms</dd></div>
            <div className={run.events.some((e) => e.kind !== "pending" && e.kind !== "done") ? "bad" : ""}><dt>Kills + evictions</dt><dd>{run.events.filter((e) => e.kind !== "pending" && e.kind !== "done").length}</dd></div>
          </dl>
          <ul className="rlq-log" aria-live="polite">
            {run.events.map((e, i) => <li key={i} className={e.kind}><span>{e.t} s</span> {e.text}</li>)}
          </ul>
        </div>
      ) : (
        <div className="pg-card"><span className="label">Not run yet</span><p className="rlq-note">Make your prediction, then press <b>Run 60 s</b>. After that, every change re-runs the minute at once.</p></div>
      )}

      <Result st={st} />

      <div className="pg-req">
        <span className="label">Challenges</span>
        <ul className="rlq-goals">
          {CHALLENGES.map((c) => <li key={c.id} className={f[c.id] ? "done" : ""}>{f[c.id] ? "✓" : "○"} {c.text}</li>)}
        </ul>
      </div>

      <p className="rlq-lang"><span className="label">In your language</span> {HOW[lang]}</p>

      <PgSources links={[
        { title: "Learnk8s on setting requests and limits", href: "https://learnk8s.io/setting-cpu-memory-limits-requests" },
        { title: "the kernel's CFS bandwidth control docs", href: "https://docs.kernel.org/scheduler/sched-bwc.html" },
        { title: "the Kubernetes docs on node-pressure eviction", href: "https://kubernetes.io/docs/concepts/scheduling-eviction/node-pressure-eviction/" },
      ]} />

      <style>{`
        .rlq-top { display: grid; grid-template-columns: minmax(0, 1.2fr) minmax(0, 1fr); gap: 8px; }
        .rlq-node { display: grid; gap: 6px; align-content: start; }
        .rlq-sub { margin: 4px 0 0; font-size: .82rem; color: var(--ink-2); }
        .rlq-bar-row { display: grid; gap: 2px; }
        .rlq-bar { position: relative; display: flex; height: 22px; border: 1px solid var(--ink-2); background: repeating-linear-gradient(90deg, var(--surface) 0 15px, var(--grid) 15px 16px); overflow: hidden; }
        .rlq-bar.over { border-color: var(--pain); }
        .rlq-seg { display: flex; align-items: center; justify-content: center; height: 100%; border-right: 1px solid var(--surface); overflow: hidden; transition: width .3s var(--ease); }
        .rlq-seg span { font-family: var(--f-code); font-size: .56rem; text-transform: uppercase; white-space: nowrap; color: var(--accent-ink); }
        .rlq-seg.p0 { background: var(--accent); }
        .rlq-seg.p1 { background: var(--accent); opacity: .7; }
        .rlq-seg.p2 { background: var(--good); }
        .rlq-seg.p3 { background: var(--hl); }
        .rlq-seg.p3 span { color: var(--ink); }
        .rlq-seg.p4 { background: var(--pain); opacity: .7; }
        .rlq-evict { position: absolute; top: -2px; bottom: -2px; width: 0; border-left: 2px dashed var(--pain); }
        .rlq-svg { width: 100%; height: auto; display: block; background: var(--surface); border: 1px solid var(--line); }
        .rlq-work { fill: var(--accent); }
        .rlq-throttle { fill: var(--pain); opacity: .55; }
        .rlq-lim { stroke: var(--pain); stroke-width: 1.5; }
        .rlq-req { stroke: var(--ink-2); stroke-dasharray: 4 3; }
        .rlq-lane { fill: none; stroke: var(--line); }
        .rlq-line { fill: none; stroke: var(--accent); stroke-width: 2; }
        .rlq-name { font-family: var(--f-code); font-size: 9px; fill: var(--ink); }
        .rlq-tiny { font-family: var(--f-code); font-size: 7.5px; fill: var(--ink-2); }
        .rlq-tiny.bad { fill: var(--pain); }
        .rlq-ev { font-size: 11px; font-weight: 700; fill: var(--pain); }
        .rlq-ev.done { fill: var(--good); }
        .rlq-note { margin: 0; font-size: .8rem; color: var(--ink-2); }
        .rlq-pods { display: grid; gap: 8px; }
        .rlq-table { display: grid; gap: 4px; }
        .rlq-pod { display: grid; grid-template-columns: minmax(0, 1.6fr) repeat(4, minmax(0, 0.7fr)) minmax(0, 1fr); gap: 6px; align-items: center; padding: 4px 0; border-bottom: 1px solid var(--line); }
        .rlq-who { display: grid; }
        .rlq-who small { font-size: .74rem; color: var(--ink-2); }
        .rlq-qos { font-family: var(--f-code); font-size: .6rem; text-transform: uppercase; letter-spacing: .04em; }
        .rlq-qos.Guaranteed { color: var(--good); }
        .rlq-qos.BestEffort { color: var(--pain); }
        .rlq-pick { display: grid; gap: 1px; font-family: var(--f-code); font-size: .6rem; text-transform: uppercase; color: var(--ink-2); }
        .rlq-pick select { font: inherit; font-size: .78rem; text-transform: none; color: var(--ink); background: var(--surface); border: 1px solid var(--line); padding: 2px; }
        .rlq-status { font-family: var(--f-code); font-size: .7rem; color: var(--good); }
        .rlq-status.bad { color: var(--pain); }
        .rlq-cursor { display: grid; gap: 2px; font-size: .82rem; }
        .rlq-cursor input { width: 100%; accent-color: var(--accent); }
        .rlq-log { list-style: none; margin: 0; padding: 0; display: grid; gap: 2px; font-size: .84rem; }
        .rlq-log li { border-left: 3px solid var(--pain); padding: 2px 8px; }
        .rlq-log li.done { border-color: var(--good); }
        .rlq-log li span { font-family: var(--f-code); font-size: .66rem; color: var(--ink-2); }
        .rlq-goals { list-style: none; padding-left: 0 !important; }
        .rlq-goals li.done { color: var(--good); }
        .rlq-lang { margin: 0; font-size: .92rem; }
        @media (max-width: 760px) {
          .rlq-top { grid-template-columns: 1fr; }
          .rlq-pod { grid-template-columns: repeat(2, minmax(0, 1fr)); }
          .rlq-who, .rlq-status { grid-column: 1 / -1; }
        }
        @media (prefers-reduced-motion: reduce) { .rlq-seg { transition: none; } }
      `}</style>
    </PgFrame>
  );
}
