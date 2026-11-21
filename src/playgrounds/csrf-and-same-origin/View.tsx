"use client";
import { useState } from "react";
import { PgChoice, PgFrame, PgPredict, PgSources, useModel } from "../kit";
import {
  ATTACKS, ORIGIN, OWN, SAMESITE_NAME, defencesOf, forgedThrough, goals, init, matrix, ownWorks, step,
  type Outcome, type SameSite,
} from "./model";

const n = (k: number, one: string, many = one + "s") => `${k} ${k === 1 ? one : many}`;
const CHECK_NAME = { sent: "Browser sends it", method: "Endpoint accepts the method", cookie: "Session cookie attached", origin: "Origin check", token: "CSRF token" } as const;

function cookieLine(s: SameSite) {
  return `session=7f3a…; Secure; HttpOnly${s === "default" ? "" : `; SameSite=${s === "none" ? "None" : s === "lax" ? "Lax" : "Strict"}`}`;
}

/* ---------------- one request, traced ---------------- */

function Trace({ o, reduced }: { o: Outcome; reduced: boolean }) {
  const own = o.attack === OWN.id;
  return (
    <div className={"csrf-trace" + (o.transferred && !own ? " bad" : "") + (reduced ? "" : " anim")} aria-live="polite">
      <div className="csrf-wire">
        <span className={"csrf-org " + o.from}>{ORIGIN[o.from].replace("https://", "")}</span>
        <span className="csrf-arrow" aria-hidden="true">{o.sent ? "──▶" : "──✕"}</span>
        <span className="csrf-org bank">bank.example</span>
      </div>
      <pre className="csrf-req">
        {`${o.method} /transfer${o.method === "GET" ? "?to=mallory&amount=250" : ""}\n`}
        {`Cookie: ${o.cookie ? "session=7f3a…" : "(withheld by the browser)"}\n`}
        {`Origin: ${o.headers.origin ?? "(not sent)"}\n`}
        {`Sec-Fetch-Site: ${o.headers.secFetchSite}`}
      </pre>
      <ol className="csrf-checks">
        {o.checks.map((c) => (
          <li key={c.id} className={c.result}>
            <span className="csrf-mark">{c.result === "pass" ? "✓" : c.result === "fail" ? "✕" : "–"}</span>
            <b>{CHECK_NAME[c.id]}</b> <span className="muted">{c.why}</span>
          </li>
        ))}
      </ol>
      <p className="csrf-verdict">
        <b>{o.status === null ? "Not sent." : `HTTP ${o.status}.`}</b> {o.transferred ? (own ? "Transfer done: " : "Money moved: ") : "Nothing moved: "}{o.why}.
      </p>
    </div>
  );
}

/* ---------------- the reader's own result ---------------- */

function Result({ fired }: { fired: Outcome[] }) {
  const forged = fired.filter((o) => o.from !== "bank");
  const through = forged.filter((o) => o.transferred);
  const lines = [`You fired ${n(forged.length, "forged request")}; ${through.length} moved money, ${250 * through.length} in all.`];
  const viaFetch = through.find((o) => o.attack === "fetch");
  if (viaFetch) lines.push("The fetch() got through with no CORS headers on the bank at all: the same-origin policy stopped the attacker reading the reply, never the request.");
  const viaGet = through.find((o) => o.method === "GET");
  if (viaGet) lines.push("A GET moved money. Every check skips GET because GET is meant to be safe, so a state change on GET defeats them all.");
  const viaSibling = through.find((o) => o.attack === "sibling");
  if (viaSibling) lines.push(`community.bank.example got through with SameSite=${viaSibling.d.sameSite}: it is the same site, so the cookie went along.`);
  const blocked = forged.filter((o) => !o.transferred);
  const byCheck = (id: string) => blocked.filter((o) => o.checks.some((c) => c.id === id && c.result === "fail")).length;
  if (blocked.length) lines.push(`Of the ${n(blocked.length, "blocked request")}: ${byCheck("cookie")} lacked the cookie, ${byCheck("origin")} failed the origin check, ${byCheck("token")} lacked the token, ${byCheck("method")} used a method the endpoint refuses, ${byCheck("sent")} never left the browser.`);
  if (!through.length && forged.length) lines.push("The bank can only tell its own pages from others by something the attacker cannot forge: a token it cannot read, or the Origin and Sec-Fetch-Site headers the browser sets.");
  return <p className="pg-takeaway">{lines.join(" ")}</p>;
}

/* ---------------- the playground ---------------- */

type G = "cors" | "sent" | "strip" | "allowed";

export default function CsrfPlayground() {
  const { state: st, dispatch, reduced } = useModel(step, init);
  const [guess, setGuess] = useState<G | null>(null);
  const d = defencesOf(st);
  const m = matrix(d);
  const g = goals(st);
  const through = forgedThrough(d);
  const own = ownWorks(d);
  const revealed = st.fired.some((o) => o.attack === "fetch");
  const reset = () => { setGuess(null); dispatch({ type: "reset" }); };

  return (
    <PgFrame title="Forge a transfer from another site" onReset={reset}>
      <PgPredict<G>
        question="The session cookie is SameSite=None and the bank sends no CORS headers. The attacker's page runs fetch() to POST a form-encoded transfer with credentials: 'include'. What happens?"
        options={[
          { value: "cors", label: "CORS blocks the request" },
          { value: "sent", label: "It is sent with the cookie; only the reply is hidden" },
          { value: "strip", label: "The browser strips cookies from fetch" },
          { value: "allowed", label: "It works only if the bank allows deals.example" },
        ]}
        value={guess} onChange={setGuess} revealed={revealed} answer="sent"
        explain={<>A form-encoded POST is a simple request, so there is no preflight: the browser sends it, cookie and all, and the bank moves the money. CORS and the same-origin policy decide whether the attacker&apos;s script may <em>read</em> the reply. CSRF never needs the reply. Now try SameSite=Lax, then the token, then the origin check.</>}
      />

      <div className="csrf-controls">
        <div><span className="label">Session cookie</span>
          <PgChoice<SameSite> label="Cookie SameSite" value={st.sameSite}
            options={(["none", "default", "lax", "strict"] as SameSite[]).map((v) => ({ value: v, label: v === "default" ? "Not set" : SAMESITE_NAME[v], note: SAMESITE_NAME[v] }))}
            onChange={(v) => dispatch({ type: "sameSite", value: v })} />
        </div>
        <div className="pg-actions">
          <button className="pg-btn csrf-def" aria-pressed={st.token} onClick={() => dispatch({ type: "toggle", key: "token" })}>{st.token ? "✓ " : ""}CSRF token</button>
          <button className="pg-btn csrf-def" aria-pressed={st.originCheck} onClick={() => dispatch({ type: "toggle", key: "originCheck" })}>{st.originCheck ? "✓ " : ""}Origin / Sec-Fetch-Site check</button>
          <button className="pg-btn csrf-break" aria-pressed={st.acceptGet} onClick={() => dispatch({ type: "toggle", key: "acceptGet" })}>{st.acceptGet ? "✓ " : ""}/transfer also accepts GET</button>
          <button className="pg-btn csrf-break" aria-pressed={st.freshLogin} onClick={() => dispatch({ type: "toggle", key: "freshLogin" })}>{st.freshLogin ? "✓ " : ""}Logged in under 2 minutes ago</button>
        </div>
      </div>

      <div className="csrf-tabs">
        <section className="csrf-tab bank" aria-label="Bank tab">
          <div className="csrf-bar"><span className="csrf-dot" aria-hidden="true" />https://bank.example/account</div>
          <div className="csrf-tabbody">
            <p className="csrf-bal">Balance <b>{st.balance.toLocaleString("en-US")}</b></p>
            <p className="csrf-cookie"><span className="label">Cookie jar</span><code>{cookieLine(st.sameSite)}</code></p>
            <button className="pg-btn primary" onClick={() => dispatch({ type: "fire", id: OWN.id })}>Pay 250 to landlord (your own form)</button>
            {!own && <p className="csrf-warn">Your own form is failing.</p>}
            <ol className="csrf-ledger" aria-label="Ledger">
              {st.ledger.length === 0 && <li className="muted">No transfers yet.</li>}
              {[...st.ledger].reverse().map((l) => <li key={l.n} className={l.forged ? "forged" : ""}>−{l.amount} · {l.text}</li>)}
            </ol>
          </div>
        </section>
        <section className="csrf-tab evil" aria-label="Attacker tab">
          <div className="csrf-bar"><span className="csrf-dot" aria-hidden="true" />https://deals.example/you-won</div>
          <div className="csrf-tabbody">
            <p className="muted csrf-small">Each card is something this page can make your browser do. The badge shows what it would do right now.</p>
            <div className="csrf-attacks">
              {ATTACKS.map((a, i) => {
                const o = m[i];
                return (
                  <div key={a.id} className={"csrf-atk" + (o.transferred ? " hot" : "")}>
                    <div className="csrf-atk-head">
                      <b>{a.title}</b>
                      <span className={"csrf-badge" + (o.transferred ? " hot" : "")}>{o.transferred ? "gets through" : "blocked"}</span>
                    </div>
                    {a.from === "sibling" && <span className="csrf-small muted">from {ORIGIN.sibling.replace("https://", "")}</span>}
                    <pre className="csrf-snip">{a.snippet}</pre>
                    <button className="pg-btn" onClick={() => dispatch({ type: "fire", id: a.id })}>Fire ▶</button>
                  </div>
                );
              })}
            </div>
          </div>
        </section>
      </div>

      {st.last && (
        <div className="csrf-last">
          <span className="label">Last request</span>
          <Trace key={st.fired.length} o={st.last} reduced={reduced} />
        </div>
      )}

      <dl className="pg-stats">
        <div className={through ? "bad" : ""}><dt>Forged requests that get through now</dt><dd>{through} of {ATTACKS.length}</dd></div>
        <div className={own ? "" : "bad"}><dt>Your own form</dt><dd>{own ? "works" : "broken"}</dd></div>
        <div className={st.balance < 2000 && st.ledger.some((l) => l.forged) ? "bad" : ""}><dt>Lost to mallory</dt><dd>{st.ledger.filter((l) => l.forged).reduce((s, l) => s + l.amount, 0)}</dd></div>
      </dl>

      {st.fired.some((o) => o.from !== "bank") && (
        <div className="pg-result">
          <span className="label">What your requests show</span>
          <Result fired={st.fired} />
        </div>
      )}

      <div className="pg-req">
        <span className="label">Challenges</span>
        <ul className="csrf-goals">
          <li className={g.corsMyth ? "done" : ""}>{g.corsMyth ? "✓" : "○"} Move money with fetch(), with no CORS on the bank.</li>
          <li className={g.laxGet ? "done" : ""}>{g.laxGet ? "✓" : "○"} Get a forged transfer past SameSite=Lax.</li>
          <li className={g.sibling ? "done" : ""}>{g.sibling ? "✓" : "○"} Get a forged transfer past SameSite=Strict.</li>
          <li className={g.allBlocked ? "done" : ""}>{g.allBlocked ? "✓" : "○"} Block all seven while your own form still works.</li>
        </ul>
      </div>

      <p className="muted csrf-small">The browser rules follow the Fetch and cookie specs and Chrome&apos;s defaults; every page and request here is simulated.</p>

      <PgSources links={[
        { title: "web.dev's SameSite cookies explained", href: "https://web.dev/articles/samesite-cookies-explained" },
        { title: "PortSwigger's CSRF labs", href: "https://portswigger.net/web-security/csrf" },
        { title: "Hacksplaining's CSRF lesson", href: "https://www.hacksplaining.com/exercises/csrf" },
      ]} />

      <style>{`
        .csrf-controls { display: grid; gap: 8px; }
        .csrf-controls > div { display: grid; gap: 4px; }
        .csrf-controls .pg-actions { display: flex; flex-wrap: wrap; gap: 6px; }
        .csrf-def[aria-pressed="true"] { border-color: var(--good); color: var(--good); background: var(--good-bg); }
        .csrf-break[aria-pressed="true"] { border-color: var(--pain); color: var(--pain); background: var(--pain-bg); }
        .csrf-tabs { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1.4fr); gap: 12px; align-items: start; }
        .csrf-tab { border: 1px solid var(--line); background: var(--bg); min-width: 0; }
        .csrf-tab.evil { border-color: var(--pain); }
        .csrf-bar { font-family: var(--f-code); font-size: .74rem; padding: 4px 8px; border-bottom: 1px solid var(--line); background: var(--surface-2); display: flex; align-items: center; gap: 6px; overflow: hidden; white-space: nowrap; text-overflow: ellipsis; }
        .csrf-dot { width: 8px; height: 8px; border: 1px solid var(--ink-2); display: inline-block; }
        .csrf-tab.evil .csrf-dot { border-color: var(--pain); background: var(--pain); }
        .csrf-tabbody { padding: 8px; display: grid; gap: 8px; }
        .csrf-bal { margin: 0; font-family: var(--f-code); }
        .csrf-bal b { font-size: 1.3rem; }
        .csrf-cookie { margin: 0; display: grid; gap: 2px; }
        .csrf-cookie code { font-size: .72rem; word-break: break-all; }
        .csrf-warn { margin: 0; color: var(--pain); font-weight: 700; font-size: .82rem; }
        .csrf-ledger { list-style: none; padding: 0; margin: 0; font-family: var(--f-code); font-size: .74rem; display: grid; gap: 2px; }
        .csrf-ledger li.forged { color: var(--pain); }
        .csrf-attacks { display: grid; grid-template-columns: repeat(auto-fill, minmax(220px, 1fr)); gap: 8px; }
        .csrf-atk { border: 1px solid var(--line); border-left: 3px solid var(--good); padding: 6px; display: grid; gap: 4px; background: var(--surface); min-width: 0; }
        .csrf-atk.hot { border-left-color: var(--pain); }
        .csrf-atk-head { display: flex; justify-content: space-between; gap: 6px; align-items: baseline; font-size: .8rem; }
        .csrf-badge { font-family: var(--f-code); font-size: .62rem; text-transform: uppercase; letter-spacing: .05em; color: var(--good); white-space: nowrap; }
        .csrf-badge.hot { color: var(--pain); font-weight: 700; }
        .csrf-snip { margin: 0; font-size: .66rem; white-space: pre-wrap; word-break: break-all; max-height: 7.5em; overflow: auto; background: var(--bg); border: 1px solid var(--line); padding: 4px; }
        .csrf-atk .pg-btn { justify-self: start; padding: 2px 8px; font-size: .76rem; }
        .csrf-small { font-size: .76rem; margin: 0; }
        .csrf-trace { border: 1px solid var(--line); border-left: 3px solid var(--good); padding: 8px; display: grid; gap: 6px; background: var(--surface); }
        .csrf-trace.bad { border-left-color: var(--pain); background: var(--pain-bg); }
        .csrf-trace.anim { animation: pg-hop .3s var(--ease) both; }
        .csrf-wire { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; font-family: var(--f-code); font-size: .78rem; }
        .csrf-org { border: 1px solid var(--line); padding: 1px 6px; }
        .csrf-org.attacker, .csrf-org.sibling { border-color: var(--pain); color: var(--pain); }
        .csrf-arrow { color: var(--ink-2); }
        .csrf-req { margin: 0; font-size: .74rem; white-space: pre-wrap; word-break: break-all; background: var(--bg); border: 1px solid var(--line); padding: 6px; }
        .csrf-checks { list-style: none; padding: 0; margin: 0; display: grid; gap: 3px; font-size: .82rem; }
        .csrf-checks li.pass { color: var(--good); } .csrf-checks li.fail { color: var(--pain); } .csrf-checks li.skip { color: var(--ink-2); }
        .csrf-checks li .muted { font-weight: 400; }
        .csrf-mark { display: inline-block; width: 1.4em; font-family: var(--f-code); }
        .csrf-verdict { margin: 0; font-size: .86rem; }
        .csrf-goals { list-style: none; padding-left: 0 !important; }
        .csrf-goals li.done { color: var(--good); }
        @media (max-width: 760px) { .csrf-tabs { grid-template-columns: minmax(0, 1fr); } }
        @media (prefers-reduced-motion: reduce) { .csrf-trace.anim { animation: none; } }
      `}</style>
    </PgFrame>
  );
}
