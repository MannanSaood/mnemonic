"use client";
import { useState } from "react";
import { PgButton, PgChoice, PgFrame, PgPredict, PgSources, useModel } from "../kit";
import {
  ARGON2_LEVELS, COST_LEVELS, GPUS, POPULATION, SCHEMES, SCHEME_NAME, TIMES, TIME_NAME, USERS,
  coresFor, duplicates, fmtDuration, fmtRate, goals, guessRate, guessesPerUser, halfAt, init, loginMs, memoryMiB, salted,
  setupOf, shareAt, step, storedValue, tablesWork, userFallsAt,
  type Gpus, type Run, type Scheme, type Setup,
} from "./model";

const GPU_NAME: Record<Gpus, string> = { 1: "1 gaming GPU", 8: "8-GPU rig", 1000: "1,000 rented GPUs" };
const pct = (x: number) => `${(x * 100).toFixed(x < 0.01 && x > 0 ? 1 : 0)}%`;
const fmtMs = (ms: number) => (ms === 0 ? "0 ms" : ms < 0.01 ? "< 0.01 ms" : ms >= 1000 ? `${(ms / 1000).toFixed(1)} s` : `${Math.round(ms)} ms`);
const short = (v: string) => (v.length > 34 ? v.slice(0, 31) + "…" : v);

/* ---------------- the crack curve: share of users cracked against time ---------------- */

const T_MIN = 0, T_MAX = 9.5; // log10 seconds: 1 s .. 100 years
const MARKS: [number, string][] = [[0, "1s"], [Math.log10(60), "1m"], [Math.log10(3600), "1h"], [Math.log10(86_400), "1d"], [Math.log10(2_592_000), "1mo"], [Math.log10(31_536_000), "1y"], [Math.log10(31_536_000 * 100), "100y"]];

function points(s: Setup, W: number, H: number, pad: number) {
  const out: string[] = [];
  for (let i = 0; i <= 80; i++) {
    const lx = T_MIN + ((T_MAX - T_MIN) * i) / 80;
    const f = shareAt(s, 10 ** lx);
    out.push(`${(pad + ((W - 2 * pad) * i) / 80).toFixed(1)},${(H - pad - (H - 2 * pad) * f).toFixed(1)}`);
  }
  return out.join(" ");
}

function Curve({ cur, prev }: { cur: Run | null; prev: Run | null }) {
  const W = 520, H = 200, pad = 28;
  const x = (lx: number) => pad + ((W - 2 * pad) * (lx - T_MIN)) / (T_MAX - T_MIN);
  const y = (f: number) => H - pad - (H - 2 * pad) * f;
  return (
    <svg className="pws-curve" viewBox={`0 0 ${W} ${H}`} role="img"
      aria-label={cur ? `Share of accounts cracked over time with ${SCHEME_NAME[cur.scheme]}: half after ${fmtDuration(cur.half)}.` : "Crack curve, empty until you run an attack."}>
      {[0, 0.25, 0.5, 0.75, 1].map((f) => (
        <g key={f}><line className={"pws-gl" + (f === 0.5 ? " half" : "")} x1={pad} x2={W - pad} y1={y(f)} y2={y(f)} /><text className="pws-ax" x={4} y={y(f) + 3}>{f * 100}%</text></g>
      ))}
      {MARKS.map(([lx, l]) => (
        <g key={l}><line className="pws-gl" x1={x(lx)} x2={x(lx)} y1={pad} y2={H - pad} /><text className="pws-ax" x={x(lx)} y={H - 10} textAnchor="middle">{l}</text></g>
      ))}
      {prev && <polyline className="pws-line prev" points={points(prev, W, H, pad)} />}
      {cur && <polyline className="pws-line" points={points(cur, W, H, pad)} />}
      {cur && (
        <g>
          <line className="pws-now" x1={x(Math.log10(TIMES[cur.time]))} x2={x(Math.log10(TIMES[cur.time]))} y1={pad} y2={H - pad} />
          <circle className="pws-dot" cx={x(Math.log10(TIMES[cur.time]))} cy={y(cur.share)} r={4} />
        </g>
      )}
      {prev && <text className="pws-key prev" x={W - pad} y={pad - 8} textAnchor="end">faint: run {prev.n}, {SCHEME_NAME[prev.scheme]}</text>}
    </svg>
  );
}

/* ---------------- the reader's own result ---------------- */

function Result({ runs }: { runs: Run[] }) {
  const r = runs[runs.length - 1];
  const name = `${SCHEME_NAME[r.scheme]}${COST_LEVELS[r.scheme].length ? ` (${COST_LEVELS[r.scheme][r.cost]})` : ""}`;
  const lines = [
    `With ${name} and ${GPU_NAME[r.gpus]} for ${TIME_NAME[r.time]}, ${r.cracked.toLocaleString("en-US")} of ${POPULATION.toLocaleString("en-US")} accounts fell (${pct(r.share)}). Half fall after ${fmtDuration(r.half)}.`,
  ];
  const fast = runs.find((x) => x.scheme === "sha256" || x.scheme === "sha256salt");
  const slow = [...runs].reverse().find((x) => ["bcrypt", "scrypt", "argon2id", "pbkdf2"].includes(x.scheme));
  if (fast && slow && fast.gpus === slow.gpus && fast.time === slow.time)
    lines.push(`Same attacker, same time: ${SCHEME_NAME[fast.scheme]} lost ${pct(fast.share)}, ${SCHEME_NAME[slow.scheme]} lost ${pct(slow.share)}. The slow hash costs your server ${fmtMs(slow.loginMs)} per login and the attacker the same factor per guess.`);
  if (r.scheme === "plain") lines.push("Nothing to crack: the leak is the passwords.");
  else if (tablesWork(r)) lines.push("The lookup table did the work before the leak happened: no salt, so one table fits every site that stored plain SHA-256.");
  else if (r.fallen.includes("ana") && r.share < 0.5) lines.push("Even here, ana and dev fell: no hash setting saves 123456. Block breached passwords at sign-up and add a second factor.");
  return <p className="pg-takeaway">{lines.join(" ")}</p>;
}

/* ---------------- the playground ---------------- */

type G = "hour" | "day" | "year" | "centuries";

export default function PasswordStorage() {
  const { state: st, dispatch, reduced } = useModel(step, init);
  const [guess, setGuess] = useState<G | null>(null);
  const r = st.runs[st.runs.length - 1] ?? null;
  const prev = st.runs.length > 1 ? st.runs[st.runs.length - 2] : null;
  const setup = setupOf(st);
  const g = goals(st);
  const dups = duplicates(setup);
  const revealRun = st.runs.find((x) => x.scheme === "sha256salt" && x.gpus === 1);
  const stale = !!r && (r.scheme !== st.scheme || r.cost !== st.cost || r.gpus !== st.gpus || r.time !== st.time || r.tables !== st.tables);
  const ms = loginMs(st.scheme, st.cost);
  const reset = () => { setGuess(null); dispatch({ type: "reset" }); };

  return (
    <PgFrame title="Crack a leaked users table" onReset={reset}>
      <PgPredict<G>
        question="100,000 users leak, stored as SHA-256 with a random salt per user. The attacker has one gaming GPU. How long until half the accounts are cracked?"
        options={[{ value: "hour", label: "Under an hour" }, { value: "day", label: "About a day" }, { value: "year", label: "About a year" }, { value: "centuries", label: "Centuries" }]}
        value={guess} onChange={setGuess} revealed={!!revealRun} answer="hour"
        explain={<>About {fmtDuration(halfAt({ scheme: "sha256salt", cost: 0, gpus: 1, time: 2, tables: false }))}. One GPU tries 22 billion SHA-256 guesses a second. The salt forces a separate job per user, which multiplies the work by 100,000, and that is still not enough: SHA-256 was built to be fast. Now switch to bcrypt or Argon2id and run the same attack.</>}
      />

      <div className="pws-controls">
        <div><span className="label">How the table stored passwords</span>
          <PgChoice<Scheme> label="Storage scheme" value={st.scheme} options={SCHEMES.map((s) => ({ value: s, label: SCHEME_NAME[s] }))}
            onChange={(v) => dispatch({ type: "scheme", scheme: v })} />
        </div>
        {COST_LEVELS[st.scheme].length > 0 && (
          <div><span className="label">Cost setting</span>
            <PgChoice<string> label="Cost setting" value={String(st.cost)}
              options={COST_LEVELS[st.scheme].map((l, i) => ({ value: String(i), label: l, note: st.scheme === "argon2id" ? ARGON2_LEVELS[i].note : undefined }))}
              onChange={(v) => dispatch({ type: "cost", cost: Number(v) })} />
          </div>
        )}
        <div><span className="label">Attacker</span>
          <PgChoice<`${Gpus}`> label="Attacker's GPUs" value={`${st.gpus}` as `${Gpus}`} options={GPUS.map((n) => ({ value: `${n}` as `${Gpus}`, label: GPU_NAME[n] }))}
            onChange={(v) => dispatch({ type: "gpus", gpus: Number(v) as Gpus })} />
        </div>
        <div className="pws-time">
          <label className="label" htmlFor="pws-time">Attacker keeps going for: <b>{TIME_NAME[st.time]}</b></label>
          <input id="pws-time" type="range" min={0} max={TIMES.length - 1} step={1} value={st.time}
            onChange={(e) => dispatch({ type: "time", time: Number(e.target.value) })} />
        </div>
        <div className="pg-actions">
          <button className="pg-btn pws-toggle" aria-pressed={st.tables} onClick={() => dispatch({ type: "tables" })}>{st.tables ? "✓ " : ""}Attacker has a precomputed lookup table</button>
          <PgButton primary onClick={() => dispatch({ type: "attack" })}>Crack ▶</PgButton>
        </div>
      </div>

      <p className="muted pws-rate">
        This setting: {fmtRate(guessRate(st.scheme, st.cost) * st.gpus)}{salted(st.scheme) ? ", spread over 100,000 separate salts" : st.scheme === "sha256" ? ", each guess tested against every user at once" : ""}.
        {" "}Your login server: {fmtMs(ms)} per login{memoryMiB(st.scheme, st.cost) >= 1 ? ` and ${memoryMiB(st.scheme, st.cost)} MiB` : ""}.
        {st.scheme === "argon2id" ? " Argon2id rate is a memory-bandwidth estimate (the attacker's best case)." : st.scheme !== "plain" ? " Rates: hashcat on one RTX 4090." : ""}
      </p>

      <div className="pws-grid">
        <div className="pws-panel">
          <span className="label">The leaked table · {SCHEME_NAME[st.scheme]}{dups.length ? ` · ${dups.length} group of equal values` : ""}</span>
          <div className="pws-table" role="region" aria-label="Leaked users table" tabIndex={0}>
            <table>
              <thead><tr><th>User</th><th>Stored value (click to find equal ones)</th><th>{r && !stale ? `After ${TIME_NAME[r.time]}` : "Status"}</th></tr></thead>
              <tbody>
                {USERS.map((u) => {
                  const v = storedValue(st.scheme, st.cost, u);
                  const at = userFallsAt(setup, u);
                  const fell = r && !stale && r.fallen.includes(u.name);
                  const same = st.picked !== null && st.picked === v;
                  return (
                    <tr key={u.name} className={(fell ? "fell" : "") + (same ? " same" : "") + (reduced ? "" : " anim")}>
                      <td>{u.name}</td>
                      <td><button className="pws-hash" aria-pressed={same} onClick={() => dispatch({ type: "pick", value: v })} title={v}>{short(v)}</button></td>
                      <td>{!r || stale ? <span className="muted">{stale ? "run again" : "–"}</span> : fell ? <><b>{u.password}</b> <span className="muted">({fmtDuration(at)})</span></> : <span className="muted">safe ({fmtDuration(at)})</span>}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          {st.picked && (
            <p className={"pws-note" + (dups.some((d) => d.length > 1 && USERS.filter((u) => storedValue(st.scheme, st.cost, u) === st.picked).length > 1) ? " bad" : "")} aria-live="polite">
              {USERS.filter((u) => storedValue(st.scheme, st.cost, u) === st.picked).length > 1
                ? st.scheme === "plain" ? "Equal passwords, in the clear." : "Two users, one value: they share a password, and you know it without cracking anything. Crack one, get both."
                : "No other row has this value. With a salt, equal passwords look unrelated."}
            </p>
          )}
        </div>
        <div className="pws-panel">
          <span className="label">Share of 100,000 accounts cracked over time</span>
          <Curve cur={r} prev={prev} />
          {!r && <p className="pg-empty">Answer the question, then press Crack.</p>}
        </div>
      </div>

      {r && (
        <dl className="pg-stats" aria-live="polite">
          <div className={r.share >= 0.5 ? "bad" : ""}><dt>Accounts cracked</dt><dd>{r.cracked.toLocaleString("en-US")}</dd></div>
          <div><dt>Half fall after</dt><dd>{fmtDuration(r.half)}</dd></div>
          <div><dt>Guesses per user</dt><dd>{isFinite(guessesPerUser(r, TIMES[r.time])) ? guessesPerUser(r, TIMES[r.time]).toExponential(1).replace("e+", "e") : "∞"}</dd></div>
          <div className={r.loginMs >= 1000 ? "bad" : ""}><dt>Login cost</dt><dd>{fmtMs(r.loginMs)}</dd></div>
          <div className={coresFor(r.loginMs) > 50 ? "bad" : ""}><dt>Cores for 200 logins/s</dt><dd>{coresFor(r.loginMs)}</dd></div>
        </dl>
      )}

      {r && (
        <div className="pg-result">
          <span className="label">What your runs show</span>
          <Result runs={st.runs} />
        </div>
      )}

      {st.runs.length > 1 && (
        <div className="pws-table" role="region" aria-label="Your runs" tabIndex={0}>
          <table>
            <thead><tr><th>Run</th><th>Stored as</th><th>Attacker</th><th>Time</th><th>Cracked</th><th>Half at</th><th>Login</th></tr></thead>
            <tbody>
              {st.runs.slice(-6).map((x) => (
                <tr key={x.n} className={x.share >= 0.5 ? "fell" : ""}>
                  <td>{x.n}</td><td>{SCHEME_NAME[x.scheme]}{COST_LEVELS[x.scheme].length ? ` ${COST_LEVELS[x.scheme][x.cost].split(" (")[0]}` : ""}{x.tables && x.scheme === "sha256" ? " + table" : ""}</td>
                  <td>{x.gpus} GPU{x.gpus > 1 ? "s" : ""}</td><td>{TIME_NAME[x.time]}</td><td>{pct(x.share)}</td><td>{fmtDuration(x.half)}</td><td>{fmtMs(x.loginMs)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <div className="pg-req">
        <span className="label">Challenges</span>
        <ul className="pws-goals">
          <li className={g.duplicates ? "done" : ""}>{g.duplicates ? "✓" : "○"} Find two users with the same password without cracking anything.</li>
          <li className={g.tableInstant ? "done" : ""}>{g.tableInstant ? "✓" : "○"} Crack half the table in the first minute.</li>
          <li className={g.survivesYear ? "done" : ""}>{g.survivesYear ? "✓" : "○"} Keep half the accounts safe from 1,000 GPUs for a year.</li>
          <li className={g.tooCostly ? "done" : ""}>{g.tooCostly ? "✓" : "○"} Push the cost so far that one login takes a second or a gigabyte. Would your login servers cope?</li>
        </ul>
      </div>

      <p className="muted pws-fine">
        The 100,000 users follow an illustrative curve shaped like real leaks: a few common passwords cover many people, random ones resist everything.
        Everything here is simulated in your browser; no real accounts or wordlists are involved.
      </p>

      <PgSources links={[
        { title: "Hive Systems' password table", href: "https://www.hivesystems.com/blog/are-your-passwords-in-the-green" },
        { title: "CrackStation's Salted Password Hashing", href: "https://crackstation.net/hashing-security.htm" },
        { title: "the RTX 4090 hashcat benchmarks", href: "https://gist.github.com/Chick3nman/32e662a5bb63bc4f51b847bb422222fd" },
      ]} />

      <style>{`
        .pws-controls { display: grid; gap: 10px; }
        .pws-controls > div { display: grid; gap: 4px; }
        .pws-time input { width: 100%; max-width: 360px; accent-color: var(--accent); }
        .pws-toggle[aria-pressed="true"] { border-color: var(--pain); color: var(--pain); background: var(--pain-bg); }
        .pws-rate { font-size: .82rem; margin: 0; }
        .pws-grid { display: grid; grid-template-columns: minmax(0, 1.2fr) minmax(0, 1fr); gap: 12px; align-items: start; }
        .pws-panel { border: 1px solid var(--line); background: var(--bg); padding: 8px; display: grid; gap: 8px; min-width: 0; }
        .pws-table { overflow-x: auto; }
        .pws-table table { border-collapse: collapse; width: 100%; font-size: .76rem; font-family: var(--f-code); }
        .pws-table th, .pws-table td { border: 1px solid var(--line); padding: 3px 6px; text-align: left; white-space: nowrap; }
        .pws-table th { font-size: .6rem; text-transform: uppercase; letter-spacing: .06em; color: var(--ink-2); }
        .pws-table tr.fell td { color: var(--pain); background: var(--pain-bg); }
        .pws-table tr.same td { outline: 2px solid var(--accent); outline-offset: -2px; }
        .pws-table tr.anim td { transition: background .25s var(--ease), color .25s var(--ease); }
        .pws-hash { font: inherit; background: none; border: 1px dashed transparent; color: inherit; padding: 0 2px; cursor: pointer; text-align: left; }
        .pws-hash:hover, .pws-hash:focus-visible, .pws-hash[aria-pressed="true"] { border-color: var(--accent); }
        .pws-note { font-size: .82rem; margin: 0; border-left: 3px solid var(--accent); padding-left: 8px; }
        .pws-note.bad { border-left-color: var(--pain); color: var(--pain); }
        .pws-curve { width: 100%; height: auto; display: block; }
        .pws-curve .pws-gl { stroke: var(--grid); stroke-width: 1; }
        .pws-curve .pws-gl.half { stroke: var(--line); stroke-dasharray: 4 3; }
        .pws-ax { font-family: var(--f-code); font-size: 9px; fill: var(--ink-2); }
        .pws-key { font-family: var(--f-code); font-size: 9px; fill: var(--ink-2); }
        .pws-line { fill: none; stroke: var(--pain); stroke-width: 2.2; }
        .pws-line.prev { stroke: var(--ink-2); stroke-width: 1.4; stroke-dasharray: 5 4; opacity: .7; }
        .pws-now { stroke: var(--accent); stroke-width: 1.4; }
        .pws-dot { fill: var(--accent); }
        .pws-goals { list-style: none; padding-left: 0 !important; }
        .pws-goals li.done { color: var(--good); }
        .pws-fine { font-size: .76rem; }
        @media (max-width: 760px) { .pws-grid { grid-template-columns: minmax(0, 1fr); } }
        @media (prefers-reduced-motion: reduce) { .pws-table tr.anim td { transition: none; } }
      `}</style>
    </PgFrame>
  );
}

