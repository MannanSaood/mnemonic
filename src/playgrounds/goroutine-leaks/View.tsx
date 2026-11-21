"use client";
import type { ReactNode } from "react";
import { PgButton, PgChoice, PgFrame, PgPredict, PgSources, useModel } from "../kit";
import {
  ANSWER, BACKENDS, BASE_GOROUTINES, KIB_PER_LEAK, LEAKS_TO_OOM, ORIGINAL, POD_LIMIT_MIB, TIMEOUT_MS,
  goroutines, init, leakRate, memMiB, step,
  type Action, type BufSize, type Fate, type Fix, type Guess, type Req, type State,
} from "./model";

const CSS = `
.goroutine-leaks-row { display: flex; gap: 8px; flex-wrap: wrap; align-items: center; }
.goroutine-leaks-lanes { display: grid; gap: 6px; }
.goroutine-leaks-lane { display: grid; grid-template-columns: 6.5em minmax(0, 1fr); gap: 6px; align-items: center; }
.goroutine-leaks-who { font-family: var(--f-code); font-size: .66rem; letter-spacing: .06em; text-transform: uppercase; }
.goroutine-leaks-track { position: relative; height: 1.7em; background: var(--bg); border: 1px solid var(--line); }
.goroutine-leaks-bar { position: absolute; top: 0; bottom: 0; left: 0; background: var(--hl); border-right: 2px solid var(--accent); transition: width .3s var(--ease); }
.goroutine-leaks-bar.leaked { background: var(--pain-bg); border-right-color: var(--pain); }
.goroutine-leaks-bar.cancelled { background: repeating-linear-gradient(45deg, var(--surface-2) 0 4px, transparent 4px 8px); border-right-style: dashed; }
.goroutine-leaks-ret { position: absolute; top: -3px; bottom: -3px; width: 0; border-left: 2px dashed var(--ink); }
.goroutine-leaks-fate { position: absolute; left: 4px; top: 50%; transform: translateY(-50%); font-family: var(--f-code); font-size: .66rem; white-space: nowrap; }
.goroutine-leaks-fate.leaked { color: var(--pain); font-weight: 700; }
.goroutine-leaks-axis { display: flex; justify-content: space-between; font-family: var(--f-code); font-size: .58rem; color: var(--ink-2); padding-left: calc(6.5em + 6px); }
.goroutine-leaks-pile { display: grid; grid-template-columns: repeat(20, 1fr); gap: 2px; }
.goroutine-leaks-pile i { aspect-ratio: 1; background: var(--bg); border: 1px solid var(--line); }
.goroutine-leaks-pile i.on { background: var(--pain); border-color: var(--pain); }
.goroutine-leaks-mem { height: 10px; border: 1px solid var(--line); background: var(--bg); position: relative; }
.goroutine-leaks-mem b { position: absolute; inset: 0 auto 0 0; background: var(--accent); transition: width .3s var(--ease); }
.goroutine-leaks-mem.hot b { background: var(--pain); }
.goroutine-leaks-prof { margin: 0; font-family: var(--f-code); font-size: .72rem; line-height: 1.45; background: var(--bg); border: 1px solid var(--line); padding: 6px 8px; overflow-x: auto; white-space: pre; }
.goroutine-leaks-event { margin: 0; padding: 6px 8px; border: 1px solid var(--line); font-size: .88rem; }
.goroutine-leaks-event.oom { border-color: var(--pain); background: var(--pain-bg); color: var(--pain); }
.goroutine-leaks-runs { width: 100%; border-collapse: collapse; font-size: .85rem; }
.goroutine-leaks-runs th, .goroutine-leaks-runs td { border: 1px solid var(--line); padding: 3px 6px; text-align: left; }
.goroutine-leaks-runs th { font-family: var(--f-code); font-size: .6rem; letter-spacing: .06em; text-transform: uppercase; color: var(--ink-2); background: var(--bg); }
.goroutine-leaks-runs td.num { font-family: var(--f-code); text-align: right; font-variant-numeric: tabular-nums; }
.goroutine-leaks-runs tr.cur td { background: var(--hl); }
.goroutine-leaks-runs td.bad { color: var(--pain); font-weight: 700; }
.goroutine-leaks-runs td.good { color: var(--good); font-weight: 700; }
@media (prefers-reduced-motion: reduce) { .goroutine-leaks-bar, .goroutine-leaks-mem b { transition: none; } }
`;

const fmt = (k: number) => Math.round(k).toLocaleString("en-US");
const fixName = (f: Fix) => `buffer ${f.buf} · ${f.ctx ? "ctx cancel" : "no ctx"}`;

/* ---------------- the handler, as currently deployed ---------------- */

function Line({ children, tone }: { children: ReactNode; tone?: "new" | "bad" }) {
  return <div className={"pgc-line" + (tone ? ` ${tone}` : "")}><code>{children}</code></div>;
}

function Code({ st }: { st: State }) {
  const f = st.fix;
  const leaking = (st.last?.leaked ?? 0) > 0 || st.totals.leaked > 0;
  return (
    <div className="pgc" aria-label="The handler as deployed">
      <Line>{"func (s *Server) Profile(ctx context.Context, id string) (*Profile, error) {"}</Line>
      {f.ctx && <Line tone="new">{"    ctx, cancel := context.WithTimeout(ctx, 100*time.Millisecond)"}</Line>}
      {f.ctx && <Line tone="new">{"    defer cancel() // tells the losers to stop"}</Line>}
      <Line tone={f.buf ? "new" : undefined}>{`    ch := make(chan *Profile${f.buf ? `, ${f.buf}` : ""})`}</Line>
      <Line>{"    for _, b := range s.backends {"}</Line>
      <Line>{"        go func() {"}</Line>
      <Line tone={f.ctx ? "new" : undefined}>{`            p, err := b.Get(${f.ctx ? "ctx, " : ""}id)`}</Line>
      <Line>{"            if err == nil {"}</Line>
      <Line tone={leaking ? "bad" : undefined}>{`                ch <- p${leaking ? " // parked here forever" : ""}`}</Line>
      <Line>{"            }"}</Line>
      <Line>{"        }()"}</Line>
      <Line>{"    }"}</Line>
      <Line>{"    select {"}</Line>
      <Line>{"    case p := <-ch:"}</Line>
      <Line>{"        return p, nil // the first answer wins"}</Line>
      <Line tone={f.ctx ? "new" : undefined}>{`    case <-${f.ctx ? "ctx.Done()" : "time.After(100 * time.Millisecond)"}:`}</Line>
      <Line>{"        return nil, ErrTimeout"}</Line>
      <Line>{"    }"}</Line>
      <Line>{"}"}</Line>
    </div>
  );
}

/* ---------------- one request, on a timeline ---------------- */

const FATE: Record<Fate, string> = {
  read: "answered first · read",
  slot: "sent to a free slot · exited",
  leaked: "ch <- p · parked forever",
  cancelled: "cancelled by ctx · exited",
  error: "backend error · exited",
};
const SCALE = 320; // ms shown on the axis

function Timeline({ req }: { req: Req }) {
  const pct = (ms: number) => `${Math.min(100, (ms / SCALE) * 100)}%`;
  return (
    <div className="goroutine-leaks-lanes" role="list" aria-label={`Request ${req.id}, backend by backend`}>
      {req.lanes.map((l) => {
        const shown = l.fate === "cancelled" ? req.returnAt : l.t;
        return (
          <div key={l.backend} className="goroutine-leaks-lane" role="listitem" aria-label={`${l.backend}: ${l.t} ms, ${FATE[l.fate]}`}>
            <span className="goroutine-leaks-who">{l.backend}</span>
            <span className="goroutine-leaks-track">
              <span className={`goroutine-leaks-bar ${l.fate}`} style={{ width: pct(shown) }} />
              <span className="goroutine-leaks-ret" style={{ left: pct(req.returnAt) }} title={`handler returned at ${req.returnAt} ms`} />
              <span className={`goroutine-leaks-fate ${l.fate}`}>{l.fate === "cancelled" ? `stopped at ${req.returnAt} ms` : `${l.t} ms`} · {FATE[l.fate]}</span>
            </span>
          </div>
        );
      })}
      <div className="goroutine-leaks-axis" aria-hidden="true"><span>0</span><span>{TIMEOUT_MS} ms timeout</span><span>{SCALE} ms</span></div>
      <p className="muted" style={{ margin: 0 }}>
        Request #{req.id}: the dashed line is where the handler returned ({req.timedOut ? "timed out" : `first answer at ${req.returnAt} ms`}).
        {req.leaked ? ` ${req.leaked} goroutine${req.leaked > 1 ? "s" : ""} finished after that and had nobody to send to.` : " Nothing was left behind."}
      </p>
    </div>
  );
}

/* ---------------- the pod ---------------- */

function Pod({ st }: { st: State }) {
  const mem = memMiB(st.pod.leaked);
  const fill = Math.round((st.pod.leaked / LEAKS_TO_OOM) * 100);
  return (
    <div style={{ display: "grid", gap: 8 }}>
      <dl className="pg-stats">
        <div className={st.pod.leaked ? "bad" : ""}><dt>NumGoroutine</dt><dd>{fmt(goroutines(st.pod))}</dd></div>
        <div className={mem > POD_LIMIT_MIB * 0.7 ? "bad" : ""}><dt>Memory</dt><dd>{mem.toFixed(1)} / {POD_LIMIT_MIB} MiB</dd></div>
        <div className={st.pod.restarts ? "bad" : ""}><dt>OOM restarts</dt><dd>{st.pod.restarts}</dd></div>
        <div><dt>Requests served</dt><dd>{fmt(st.pod.served)}</dd></div>
      </dl>
      <div className={"goroutine-leaks-mem" + (fill > 70 ? " hot" : "")} aria-hidden="true"><b style={{ width: `${Math.min(100, (mem / POD_LIMIT_MIB) * 100)}%` }} /></div>
      <span className="label">Parked goroutines · each square is 1% of what fits before the OOM kill</span>
      <div className="goroutine-leaks-pile" aria-hidden="true">
        {Array.from({ length: 100 }, (_, i) => <i key={i} className={i < fill ? "on" : ""} />)}
      </div>
      <span className="label">curl /debug/pprof/goroutine?debug=1</span>
      <pre className="goroutine-leaks-prof">{
        `goroutine profile: total ${fmt(goroutines(st.pod))}\n` +
        (st.pod.leaked ? `${fmt(st.pod.leaked)} @ main.(*Server).Profile.func1\n#\tprofile.go:8  chan send (parked)\n` : "") +
        `${BASE_GOROUTINES} @ net/http, database/sql, runtime ...`
      }</pre>
    </div>
  );
}

/* ---------------- runs and result ---------------- */

function Runs({ st }: { st: State }) {
  if (!st.runs.length) return null;
  return (
    <table className="goroutine-leaks-runs">
      <thead><tr><th>Handler version</th><th>Requests</th><th>Leaked per 1,000</th><th>Backend time after the answer</th></tr></thead>
      <tbody>
        {st.runs.map((r) => {
          const rate = leakRate(r.totals);
          const cur = r.fix.buf === st.fix.buf && r.fix.ctx === st.fix.ctx;
          return (
            <tr key={fixName(r.fix)} className={cur ? "cur" : ""}>
              <td>{fixName(r.fix)}</td>
              <td className="num">{fmt(r.totals.requests)}</td>
              <td className={"num " + (rate > 0 ? "bad" : "good")}>{rate.toFixed(rate > 0 && rate < 10 ? 1 : 0)}</td>
              <td className="num">{(r.totals.wastedMs / r.totals.requests).toFixed(0)} ms / request</td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

function Result({ st }: { st: State }) {
  const orig = st.runs.find((r) => r.fix.buf === ORIGINAL.buf && r.fix.ctx === ORIGINAL.ctx);
  const clean = st.runs.find((r) => r.totals.requests >= 1000 && r.totals.leaked === 0 && r.fix.ctx);
  const leakFree = st.runs.find((r) => r.totals.requests >= 1000 && r.totals.leaked === 0);
  if (!orig || orig.totals.requests < 1000 || !leakFree) return null;
  const o = leakRate(orig.totals);
  const perHour = (o * 50 * 3600) / 1000; // at 50 requests a second
  const best = clean ?? leakFree;
  return (
    <div className="pg-result" aria-live="polite">
      <span className="label">Your result</span>
      <p>
        <b>The original handler</b> left {o.toFixed(0)} goroutines parked for every 1,000 requests. At 50 requests a
        second that is {fmt(perHour)} an hour, about {fmt((perHour * KIB_PER_LEAK) / 1024)} MiB, so a {POD_LIMIT_MIB} MiB pod
        is OOM-killed in minutes, and the goroutine graph looks like a ramp.
      </p>
      <p>
        <b>{fixName(best.fix)}</b> left 0 over {fmt(best.totals.requests)} requests
        {best.fix.ctx ? ", and the backends stopped working on answers nobody would read." : `, but the backends still spent ${(best.totals.wastedMs / best.totals.requests).toFixed(0)} ms per request on answers nobody read. Add ctx to stop that.`}
      </p>
      <p className="pg-takeaway">
        A goroutine leaks when it waits for something that can no longer happen. Here, every sender that finished after
        the handler returned waited for a reader that was gone. Give each possible sender a slot (a buffer as big as the
        number of senders, not 1), and tell work that is no longer wanted to stop (cancel the context).
      </p>
    </div>
  );
}

const GUESSES: { value: Guess; label: string }[] = [
  { value: "zero", label: "About 0: they all finish" },
  { value: "one", label: "About 1,000: one per request" },
  { value: "losers", label: "About 2,000: every loser" },
];

export default function GoroutineLeaks() {
  const { state: st, dispatch } = useModel(step, init);
  const d = (a: Action) => dispatch(a);
  return (
    <PgFrame title="Leak lab: a handler that returns early" onReset={() => d({ type: "reset" })}>
      <style>{CSS}</style>
      <p className="pg-rule">
        <code>Profile</code> asks three backends at once and returns the first answer, or gives up after {TIMEOUT_MS} ms.
        It runs in a pod with a {POD_LIMIT_MIB} MiB memory limit. <b>Send traffic, watch the pod, then change the code until
        nothing is left behind.</b> Changing the code deploys it, which restarts the pod.
      </p>

      <PgPredict<Guess>
        question={`You send 1,000 requests through the handler as written (${BACKENDS.length} goroutines each). When they have all been answered, how many of those goroutines are still alive?`}
        options={GUESSES}
        value={st.guess}
        onChange={(g) => d({ type: "guess", guess: g })}
        revealed={st.totals.requests >= 1000 || st.runs.some((r) => r.totals.requests >= 1000)}
        answer={ANSWER}
        explain="The handler reads one value, then returns. The other two goroutines finish later and run ch <- p on an unbuffered channel that nobody will ever read again, so they park forever. Timeouts are worse: all three park. The runtime does not report it, because other goroutines are still running."
      />

      <div className="pg-grid">
        <div className="pg-card">
          <span className="label">The handler, as deployed</span>
          <Code st={st} />
          <div className="goroutine-leaks-row">
            <span className="label">Buffer</span>
            <PgChoice<string> label="Channel buffer size" value={String(st.fix.buf)}
              options={[0, 1, 2, 3].map((b) => ({ value: String(b), label: b === 0 ? "0 · unbuffered" : String(b) }))}
              onChange={(v) => d({ type: "setBuf", buf: Number(v) as BufSize })} />
          </div>
          <div className="goroutine-leaks-row">
            <span className="label">Context</span>
            <PgChoice<string> label="Context cancellation" value={st.fix.ctx ? "on" : "off"}
              options={[{ value: "off", label: "ignore it" }, { value: "on", label: "cancel on return" }]}
              onChange={(v) => d({ type: "setCtx", ctx: v === "on" })} />
          </div>
        </div>
        <div className="pg-card">
          <span className="label">Traffic</span>
          <div className="goroutine-leaks-row">
            <PgButton onClick={() => d({ type: "send", n: 1 })}>Send 1 request</PgButton>
            <PgButton primary onClick={() => d({ type: "send", n: 1000 })}>Send 1,000 requests</PgButton>
          </div>
          {st.event && <p className={"goroutine-leaks-event" + (st.event.startsWith("OOM") ? " oom" : "")} role="status">{st.event}</p>}
          {st.last ? <Timeline req={st.last} /> : <p className="pg-empty">No requests yet. Predict first, then send traffic.</p>}
        </div>
      </div>

      <div className="pg-grid">
        <div className="pg-card">
          <span className="label">The pod</span>
          <Pod st={st} />
        </div>
        <div className="pg-card">
          <span className="label">Your runs, per handler version</span>
          {st.runs.length ? <Runs st={st} /> : <p className="pg-empty">Each version you send traffic through gets a row here.</p>}
          <p className="pg-note">Try buffer 1: the fix that works for one sender. Then try ctx alone, and look closely at its number.</p>
        </div>
      </div>

      <Result st={st} />

      <PgSources links={[
        { title: "Ardan Labs, Goroutine Leaks: The Forgotten Sender", href: "https://www.ardanlabs.com/blog/2018/11/goroutine-leaks-the-forgotten-sender.html" },
        { title: "Uber's LeakProf", href: "https://www.uber.com/en-US/blog/leakprof-featherlight-in-production-goroutine-leak-detection/" },
        { title: "the Go blog on goroutine leak profiles", href: "https://go.dev/blog/goroutine-leak-profiles" },
      ]} />
    </PgFrame>
  );
}
