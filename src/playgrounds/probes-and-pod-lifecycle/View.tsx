"use client";
import { useEffect, useState } from "react";
import { usePrefs } from "@/components/Prefs";
import type { Lang } from "@/lib/types";
import { PgButton, PgChoice, PgFrame, PgPredict, PgSources, useModel } from "../kit";
import {
  CAUSES, CAUSE_LABEL, CHALLENGES, DB_DOWN, DEPLOY_AT, HORIZON, LAG, READY_FAIL, READY_PERIOD, RPS, STARTUP_FAIL, STARTUP_PERIOD,
  init, step,
  type OnTerm, type Run, type Seg, type Settings, type State,
} from "./model";

const HOW: Record<Lang, string> = {
  go: "Go: signal.NotifyContext(ctx, syscall.SIGTERM) gives you a context that ends on SIGTERM; then call http.Server.Shutdown with a deadline below the grace period. Shutdown closes the listener at once, so the preStop sleep must come first.",
  python: "Python: uvicorn and gunicorn catch SIGTERM and drain in-flight requests (uvicorn's --timeout-graceful-shutdown bounds it). Your own code runs in the lifespan shutdown. Behind a shell entrypoint without exec, the signal never reaches Python at all.",
  typescript: "Node.js: with no handler, SIGTERM ends the process at once, mid-request. Add process.on('SIGTERM'), wait for the endpoint removal to spread, then server.close() and closeIdleConnections() to drain.",
  rust: "Rust: axum::serve(...).with_graceful_shutdown(signal) stops accepting and waits for in-flight requests; the signal future comes from tokio::signal::unix. As PID 1 with no handler, the process would ignore SIGTERM entirely.",
};

type Guess = "none" | "many" | "old";

const X0 = 46, W = 590, PX = (W - X0 - 6) / HORIZON;
const x = (t: number) => X0 + t * PX;
const ROW = 17;

const SEG_LABEL: Record<Seg, string> = {
  none: "", pending: "scheduling", booting: "booting", up: "running, not ready", ready: "ready, in endpoints",
  prestop: "preStop", draining: "SIGTERM: draining", lingering: "ignoring SIGTERM", backoff: "restart backoff",
};

function runsOf(segs: Seg[]) {
  const out: { seg: Seg; from: number; to: number }[] = [];
  segs.forEach((s, t) => {
    const last = out[out.length - 1];
    if (last && last.seg === s) last.to = t + 1;
    else out.push({ seg: s, from: t, to: t + 1 });
  });
  return out.filter((r) => r.seg !== "none");
}

function Timeline({ run, cursor, s }: { run: Run; cursor: number; s: Settings }) {
  const rows = run.pods.length;
  const chartY = 22 + rows * ROW + 12;
  const chartH = 44;
  const H = chartY + chartH + 18;
  const visible = (t: number) => t < cursor;
  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="prb-svg" role="img"
      aria-label={`Timeline of ${rows} pods over ${HORIZON} s. ${Math.round(run.avoidable)} avoidable failed requests.`}>
      {s.dbOutage && <rect x={x(DB_DOWN[0])} y={10} width={(DB_DOWN[1] - DB_DOWN[0]) * PX} height={H - 24} className="prb-db" />}
      {s.dbOutage && <text x={x(DB_DOWN[0]) + 3} y={18} className="prb-axis bad">database down</text>}
      <line x1={x(DEPLOY_AT)} x2={x(DEPLOY_AT)} y1={10} y2={H - 14} className="prb-deploy" />
      <text x={x(DEPLOY_AT) + 3} y={18} className="prb-axis">deploy v2</text>
      {run.pods.map((p, i) => {
        const y = 22 + i * ROW;
        return (
          <g key={p.name}>
            <text x={4} y={y + 11} className={"prb-name" + (p.crashLoop ? " bad" : "")}>{p.name}</text>
            {runsOf(p.segs).filter((r) => visible(r.from)).map((r) => (
              <rect key={r.from} x={x(r.from)} y={y + 2} width={(Math.min(r.to, cursor) - r.from) * PX} height={ROW - 5} className={"prb-seg " + r.seg}>
                <title>{`${p.name} ${r.from}–${r.to} s: ${SEG_LABEL[r.seg]}`}</title>
              </rect>
            ))}
            {p.marks.filter((m) => visible(m.t)).map((m, j) => m.kind === "restart"
              ? <text key={j} x={x(m.t)} y={y + 12} textAnchor="middle" className="prb-mark bad">✕</text>
              : <line key={j} x1={x(m.t)} x2={x(m.t)} y1={y} y2={y + ROW - 1} className={"prb-tick " + m.kind} />)}
          </g>
        );
      })}
      <text x={4} y={chartY + 12} className="prb-name">req/s</text>
      {run.seconds.map((sec, t) => {
        if (!visible(t)) return null;
        const failed = CAUSES.reduce((a, c) => a + sec.fail[c], 0);
        const hOk = (sec.ok / RPS) * chartH, hBad = (failed / RPS) * chartH;
        return (
          <g key={t}>
            {hOk > 0 && <rect x={x(t)} y={chartY + chartH - hOk} width={PX} height={hOk} className="prb-ok" />}
            {hBad > 0 && <rect x={x(t)} y={chartY + chartH - hOk - hBad} width={PX} height={hBad} className={sec.fail.database > failed / 2 ? "prb-dbfail" : "prb-fail"} />}
          </g>
        );
      })}
      <line x1={X0} x2={W - 6} y1={chartY + chartH} y2={chartY + chartH} className="prb-base" />
      {[0, 50, 100, 150, 200].map((t) => <text key={t} x={x(t)} y={H - 3} textAnchor="middle" className="prb-axis">{t} s</text>)}
      {cursor < HORIZON && <line x1={x(cursor)} x2={x(cursor)} y1={10} y2={H - 14} className="prb-cursor" />}
    </svg>
  );
}

function Slider({ label, value, min, max, unit = "s", onChange, note }: { label: string; value: number; min: number; max: number; unit?: string; onChange: (v: number) => void; note?: string }) {
  return (
    <label className="prb-slider">
      <span>{label} <b>{value}{unit}</b></span>
      <input type="range" min={min} max={max} value={value} onChange={(e) => onChange(Number(e.target.value))} />
      {note && <small>{note}</small>}
    </label>
  );
}

function Yaml({ s }: { s: Settings }) {
  return (
    <pre className="prb-yaml" aria-label="The pod spec you have built">{`terminationGracePeriodSeconds: ${s.grace}
containers:
- name: api
${s.startup ? `  startupProbe:
    httpGet: { path: /livez, port: 8080 }
    periodSeconds: ${STARTUP_PERIOD}
    failureThreshold: ${STARTUP_FAIL}
` : ""}  livenessProbe:
    httpGet: { path: ${s.liveDb ? "/health   # pings the database" : "/livez"}, port: 8080 }
    initialDelaySeconds: ${s.liveDelay}
    periodSeconds: ${s.livePeriod}
    failureThreshold: ${s.liveThreshold}
${s.readiness ? `  readinessProbe:
    httpGet: { path: /readyz, port: 8080 }   # checks the database
    periodSeconds: ${READY_PERIOD}
    failureThreshold: ${READY_FAIL}
` : ""}${s.preStop ? `  lifecycle:
    preStop:
      sleep: { seconds: ${s.preStop} }
` : ""}`}</pre>
  );
}

function Result({ st }: { st: State }) {
  const r = st.run;
  if (!r) return null;
  const causes = CAUSES.filter((c) => c !== "database" && r.failed[c] > 0);
  const rollout = r.rolloutDone === null ? "never finished: the new pods never became ready" : `finished ${r.rolloutDone - DEPLOY_AT} s after it started`;
  let takeaway: string;
  if (r.failed.booting > 0) takeaway = "Without a readiness probe a pod is ready the moment its container starts, so the rollout removes old pods and sends traffic to new ones that are still booting. Readiness is the only thing that tells Kubernetes when traffic may come.";
  else if (r.rolloutDone === null) takeaway = "The liveness probe gave up before the app finished booting, so the kubelet restarted it, again and again, with growing backoff. A startup probe holds liveness off until the first success, so a slow start is not mistaken for a hang.";
  else if (st.found.storm && st.settings.liveDb && st.settings.dbOutage && r.restarts) takeaway = "The liveness probe checked the database, so a database outage looked like every pod being broken. All of them restarted, and were still booting when the database came back. Liveness should fail only when restarting this one container would fix it.";
  else if (r.failed.refused + r.failed.killed > 0) takeaway = `Removing a pod from the endpoints and sending it SIGTERM happen at the same time, but load balancers keep sending for about ${LAG} s. Keep serving through a preStop sleep at least that long, then drain in-flight requests.`;
  else if (r.shutdown !== null && r.shutdown >= st.settings.grace) takeaway = "No request failed, but every old pod waited for SIGKILL at the grace deadline, because the app ignored SIGTERM. Usually that is a process running as PID 1 with no handler. Handle the signal and drain instead.";
  else takeaway = "Readiness gated the traffic, the preStop sleep covered the endpoint lag, and the app drained in-flight requests before exiting. Every request was served.";
  return (
    <div className="pg-result" aria-live="polite">
      <span className="label">Your deploy, in your numbers</span>
      <p>
        Of {r.total} requests, <b>{r.avoidable}</b> failed because of how the pods start and stop{causes.length ? `: ${causes.map((c) => `${r.failed[c]} ${CAUSE_LABEL[c]}`).join(", ")}` : ""}.
        {st.settings.dbOutage ? ` Another ${r.failed.database} failed during the database outage, which no probe can prevent.` : ""}
        {" "}Containers restarted {r.restarts} times. The rollout {rollout}{r.shutdown !== null ? `, and the slowest old pod took ${r.shutdown} s to stop` : ""}.
        {st.previous ? ` Your previous run lost ${st.previous.failed} requests.` : ""}
      </p>
      <p className="pg-takeaway">{takeaway}</p>
    </div>
  );
}

export default function ProbesPlayground() {
  const { lang } = usePrefs();
  const { state: st, dispatch, reduced } = useModel(step, init);
  const [guess, setGuess] = useState<Guess | null>(null);
  const [cursor, setCursor] = useState(HORIZON);
  const s = st.settings;
  const set = (patch: Partial<Settings>) => { setCursor(HORIZON); dispatch({ type: "set", patch }); };
  const runDeploy = () => { dispatch({ type: "run" }); setCursor(reduced ? HORIZON : 0); };
  useEffect(() => {
    if (cursor >= HORIZON) return;
    const h = window.setTimeout(() => setCursor((c) => Math.min(HORIZON, c + 4)), 40);
    return () => window.clearTimeout(h);
  }, [cursor]);
  const r = st.run;
  const f = st.found;

  return (
    <PgFrame title="A rolling update, request by request" onReset={() => { setGuess(null); setCursor(HORIZON); dispatch({ type: "reset" }); }}
      toolbar={<PgButton primary onClick={runDeploy}>{r ? "Replay the deploy" : "Run the deploy"}</PgButton>}>
      <PgPredict<Guess>
        question={`Three pods serve ${RPS} requests a second. The new version takes ${s.boot} s to boot and has no readiness probe. During the rolling update, what happens to requests?`}
        options={[
          { value: "none", label: "None fail: the rollout waits for each new pod" },
          { value: "many", label: "Many fail: new pods get traffic before they listen" },
          { value: "old", label: "Only a few fail, as old pods stop" },
        ]}
        value={guess} onChange={setGuess} revealed={!!r && cursor >= HORIZON} answer="many"
        explain={<>With no readiness probe, a pod counts as ready as soon as its container starts. The Deployment saw ready pods within seconds, removed the old ones, and the Service sent traffic to pods that were still booting. Turn on the readiness probe and run again.</>}
      />

      <div className="prb-layout">
        <div className="prb-settings">
          <div className="pg-card">
            <span className="label">Startup</span>
            <Slider label="App boot time" value={s.boot} min={5} max={60} onChange={(v) => set({ boot: v })} />
            <PgChoice<"off" | "on"> label="Startup probe" value={s.startup ? "on" : "off"} onChange={(v) => set({ startup: v === "on" })}
              options={[{ value: "off", label: "No startup probe" }, { value: "on", label: `Startup probe · ${STARTUP_PERIOD * STARTUP_FAIL} s budget` }]} />
          </div>
          <div className="pg-card">
            <span className="label">Liveness · restart when it fails</span>
            <Slider label="initialDelaySeconds" value={s.liveDelay} min={0} max={60} onChange={(v) => set({ liveDelay: v })} />
            <Slider label="periodSeconds" value={s.livePeriod} min={1} max={20} onChange={(v) => set({ livePeriod: v })} />
            <Slider label="failureThreshold" value={s.liveThreshold} min={1} max={6} unit="" onChange={(v) => set({ liveThreshold: v })} />
            <PgChoice<"db" | "proc"> label="Liveness checks" value={s.liveDb ? "db" : "proc"} onChange={(v) => set({ liveDb: v === "db" })}
              options={[{ value: "db", label: "Process + database" }, { value: "proc", label: "Process only" }]} />
          </div>
          <div className="pg-card">
            <span className="label">Readiness · traffic only when it passes</span>
            <PgChoice<"off" | "on"> label="Readiness probe" value={s.readiness ? "on" : "off"} onChange={(v) => set({ readiness: v === "on" })}
              options={[{ value: "off", label: "No readiness probe" }, { value: "on", label: "Readiness: app + database" }]} />
          </div>
          <div className="pg-card">
            <span className="label">Shutdown</span>
            <PgChoice<OnTerm> label="On SIGTERM the app" value={s.onTerm} onChange={(v) => set({ onTerm: v })}
              options={[{ value: "exit", label: "Exits at once" }, { value: "drain", label: "Drains, then exits" }, { value: "ignore", label: "Ignores it (PID 1)" }]} />
            <Slider label="preStop sleep" value={s.preStop} min={0} max={40} onChange={(v) => set({ preStop: v })} />
            <Slider label="terminationGracePeriodSeconds" value={s.grace} min={5} max={60} onChange={(v) => set({ grace: v })} />
          </div>
          <div className="pg-card">
            <span className="label">Break it</span>
            <PgChoice<"off" | "on"> label="Database outage" value={s.dbOutage ? "on" : "off"} onChange={(v) => set({ dbOutage: v === "on" })}
              options={[{ value: "off", label: "Database healthy" }, { value: "on", label: `Database down ${DB_DOWN[0]}–${DB_DOWN[1]} s` }]} />
            <p className="prb-note">Load balancers see endpoint changes {LAG} s late. Restarts back off 10 s, 20 s, 40 s.</p>
          </div>
        </div>

        <div className="prb-main">
          {r ? (
            <div className="pg-card">
              <span className="label">Each pod over time · bottom: requests served and failed each second</span>
              <Timeline run={r} cursor={cursor} s={s} />
              <p className="prb-legend">
                <i className="booting" />booting <i className="up" />running, not ready <i className="ready" />ready <i className="prestop" />preStop <i className="draining" />after SIGTERM <i className="backoff" />restart backoff <span className="bad">✕</span> restart
              </p>
            </div>
          ) : (
            <div className="pg-card prb-empty">
              <span className="label">Nothing deployed yet</span>
              <p>Make your prediction, then press <b>Run the deploy</b>. After the first run, every change re-runs the same deploy at once.</p>
            </div>
          )}
          {r && (
            <dl className="pg-stats">
              <div className={r.avoidable ? "bad" : ""}><dt>Failed requests</dt><dd>{r.avoidable}</dd></div>
              {s.dbOutage && <div><dt>Outage errors</dt><dd>{r.failed.database}</dd></div>}
              <div className={r.restarts ? "bad" : ""}><dt>Restarts</dt><dd>{r.restarts}</dd></div>
              <div className={r.rolloutDone === null ? "bad" : ""}><dt>Rollout</dt><dd>{r.rolloutDone === null ? "stalled" : `${r.rolloutDone - DEPLOY_AT} s`}</dd></div>
              <div><dt>Slowest stop</dt><dd>{r.shutdown ?? "–"} s</dd></div>
            </dl>
          )}
          <details className="prb-yaml-wrap">
            <summary>The pod spec you have built</summary>
            <Yaml s={s} />
          </details>
        </div>
      </div>

      <Result st={st} />

      <div className="pg-req">
        <span className="label">Challenges</span>
        <ul className="prb-goals">
          {CHALLENGES.map((c) => <li key={c.id} className={f[c.id] ? "done" : ""}>{f[c.id] ? "✓" : "○"} {c.text}</li>)}
        </ul>
      </div>

      <p className="prb-lang"><span className="label">In your language</span> {HOW[lang]}</p>

      <PgSources links={[
        { title: "Learnk8s: graceful shutdown and zero downtime deployments", href: "https://learnk8s.io/graceful-shutdown" },
        { title: "Colin Breck on liveness and readiness probes", href: "https://blog.colinbreck.com/kubernetes-liveness-and-readiness-probes-how-to-avoid-shooting-yourself-in-the-foot/" },
        { title: "the Kubernetes docs on pod termination", href: "https://kubernetes.io/docs/concepts/workloads/pods/pod-lifecycle/#pod-termination" },
      ]} />

      <style>{`
        .prb-layout { display: grid; grid-template-columns: minmax(0, 0.9fr) minmax(0, 1.6fr); gap: 8px; align-items: start; }
        .prb-settings { display: grid; gap: 8px; }
        .prb-settings .pg-card { display: grid; gap: 6px; }
        .prb-settings .pg-choice button { font-size: .72rem; padding: 3px 6px; }
        .prb-main { display: grid; gap: 8px; }
        .prb-slider { display: grid; gap: 2px; font-size: .82rem; }
        .prb-slider span { display: flex; justify-content: space-between; gap: 8px; font-family: var(--f-code); font-size: .7rem; }
        .prb-slider b { font-variant-numeric: tabular-nums; }
        .prb-slider input { width: 100%; accent-color: var(--accent); }
        .prb-note { margin: 0; font-size: .8rem; color: var(--ink-2); }
        .prb-svg { width: 100%; height: auto; display: block; background: var(--surface); border: 1px solid var(--line); }
        .prb-name { font-family: var(--f-code); font-size: 9px; fill: var(--ink); }
        .prb-name.bad, .prb-axis.bad, .prb-mark.bad { fill: var(--pain); }
        .prb-axis { font-family: var(--f-code); font-size: 8px; fill: var(--ink-2); }
        .prb-mark { font-size: 10px; font-weight: 700; }
        .prb-seg.pending { fill: var(--surface-2); }
        .prb-seg.booting { fill: var(--hl); }
        .prb-seg.up { fill: var(--accent); opacity: .35; }
        .prb-seg.ready { fill: var(--accent); }
        .prb-seg.prestop { fill: var(--good); opacity: .6; }
        .prb-seg.draining, .prb-seg.lingering { fill: var(--pain); opacity: .45; }
        .prb-seg.backoff { fill: var(--pain-bg); stroke: var(--pain); stroke-dasharray: 2 2; }
        .prb-tick { stroke: var(--ink); stroke-width: 1.5; }
        .prb-tick.sigkill { stroke: var(--pain); stroke-width: 2.5; }
        .prb-db { fill: var(--pain-bg); opacity: .6; }
        .prb-deploy { stroke: var(--ink-2); stroke-dasharray: 3 3; }
        .prb-cursor { stroke: var(--accent); stroke-width: 2; }
        .prb-ok { fill: var(--good); }
        .prb-fail { fill: var(--pain); }
        .prb-dbfail { fill: var(--pain); opacity: .4; }
        .prb-base { stroke: var(--line); }
        .prb-legend { margin: 0; display: flex; flex-wrap: wrap; gap: 4px 10px; align-items: center; font-family: var(--f-code); font-size: .6rem; text-transform: uppercase; letter-spacing: .04em; color: var(--ink-2); }
        .prb-legend i { display: inline-block; width: 10px; height: 10px; margin-right: 3px; vertical-align: -1px; border: 1px solid var(--line); }
        .prb-legend i.booting { background: var(--hl); }
        .prb-legend i.up { background: var(--accent); opacity: .35; }
        .prb-legend i.ready { background: var(--accent); }
        .prb-legend i.prestop { background: var(--good); opacity: .6; }
        .prb-legend i.draining { background: var(--pain); opacity: .45; }
        .prb-legend i.backoff { background: var(--pain-bg); border-color: var(--pain); }
        .prb-legend .bad { color: var(--pain); }
        .prb-empty p { margin: 0; }
        .prb-yaml-wrap summary { cursor: pointer; font-family: var(--f-code); font-size: .72rem; text-transform: uppercase; letter-spacing: .05em; }
        .prb-yaml { margin: 6px 0 0; font-family: var(--f-code); font-size: .74rem; background: var(--surface); border: 1px solid var(--line); padding: 6px 8px; overflow-x: auto; }
        .prb-goals { list-style: none; padding-left: 0 !important; }
        .prb-goals li.done { color: var(--good); }
        .prb-lang { margin: 0; font-size: .92rem; }
        @media (max-width: 760px) { .prb-layout { grid-template-columns: 1fr; } }
      `}</style>
    </PgFrame>
  );
}
