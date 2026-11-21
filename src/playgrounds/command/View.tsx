"use client";
import { PgButton, PgChoice, PgFrame, PgPredict, PgSources, useModel } from "../kit";
import {
  BUTTON, CHALLENGES, KINDS, MAX_ATTEMPTS, UNDOABLE, challengeDone, drift, init, serialize, step, undoTarget,
  type Fault, type State,
} from "./model";

const FAULTS: { value: Fault; label: string; note: string }[] = [
  { value: "ok", label: "OK", note: "The call succeeds and the worker hears back." },
  { value: "refused", label: "Refused", note: "The connection fails before the provider sees anything." },
  { value: "lost", label: "Times out after success", note: "The provider applies it, then the response is lost." },
];

const n = (k: number, one: string, many = one + "s") => `${k} ${k === 1 ? one : many}`;

function AccountView({ st }: { st: State }) {
  const d = drift(st);
  const rows: { label: string; value: string; asked: string; bad: boolean }[] = [
    { label: "Plan", value: st.account.plan, asked: st.intended.plan, bad: st.account.plan !== st.intended.plan },
    { label: "Refunded", value: `$${st.account.refunded}`, asked: `$${st.intended.refunded}`, bad: d.extraRefund > 0 },
    { label: "Credit", value: `$${st.account.credit}`, asked: `$${st.intended.credit}`, bad: d.extraCredit > 0 },
    { label: "Emails sent", value: String(st.account.emails), asked: String(st.intended.emails), bad: d.extraEmails > 0 },
  ];
  return (
    <dl className="pg-stats">
      {rows.map((r) => (
        <div key={r.label} className={r.bad ? "bad" : ""}>
          <dt>{r.label}</dt>
          <dd>{r.value}</dd>
          <span className="command-asked">{r.bad ? `asked for ${r.asked}` : "as asked"}</span>
        </div>
      ))}
    </dl>
  );
}

function Result({ st }: { st: State }) {
  if (!st.history.length) return null;
  const d = drift(st);
  const ran = st.history.filter((c) => c.status !== "dead").length;
  const bad = d.extraRefund + d.extraCredit + d.extraEmails > 0;
  return (
    <div className="pg-result" aria-live="polite">
      <span className="label">What your commands did</span>
      <p>
        You ran {n(ran, "command")} with {n(st.retries, "retry", "retries")}. The customer was refunded ${st.account.refunded} for ${st.intended.refunded} asked
        {st.intended.credit || st.account.credit ? `, and got $${st.account.credit} credit for $${st.intended.credit} asked` : ""}.
        Undo worked {n(st.undos, "time")}{st.refusedUndo ? ", and was refused for something that cannot be taken back" : ""}.
      </p>
      <p className="pg-takeaway">
        {bad
          ? "A retry delivers the same command a second time. Without a key, the provider cannot tell it from a new request, so anything that adds (a refund, a credit, an email) happens twice. The command object made the retry possible; the key it carries makes the retry safe."
          : "Turning each action into an object is what let you queue it, retry it, log it and undo it. Each of those needs something in the object: a key for safe retries, the old value for undo. Try the timeout with keys off to see what goes wrong without them."}
      </p>
    </div>
  );
}

export default function CommandPlayground() {
  const { state: st, dispatch, reduced } = useModel(step, init);
  const head = st.queue[0];
  const target = undoTarget(st);
  const r = st.retryAfterLost;
  const answer = r ? (r.duplicated ? "80" : "40") : "80";

  return (
    <PgFrame title="An admin console where every action is a command" onReset={() => dispatch({ type: "reset" })}>
      <style>{CSS}</style>
      <PgPredict
        question="The refund call times out, but the provider had already sent the money. The worker retries the same command. How much does the customer get back?"
        options={[{ value: "40", label: "$40" }, { value: "80", label: "$80" }, { value: "0", label: "$0" }]}
        value={st.prediction}
        onChange={(v) => dispatch({ type: "predict", value: v })}
        revealed={!!r}
        answer={answer}
        explain={r?.duplicated
          ? "$80. The worker only saw a timeout, so it retried, and the provider treated the retry as a new refund. Retrying is safe only when the command carries an idempotency key the provider checks."
          : "$40. The retry carried the same idempotency key, so the provider recognised it and returned the first result instead of refunding again."}
      />

      <div className="pg-card">
        <span className="label">Admin console · each button creates a command and queues it</span>
        <div className="pg-actions">
          {KINDS.map((k) => (
            <PgButton key={k} onClick={() => dispatch({ type: "issue", kind: k })}>{BUTTON[k]}</PgButton>
          ))}
        </div>
      </div>

      <div className="pg-grid">
        <div className="pg-card">
          <span className="label">Queue · commands are data</span>
          {st.queue.length === 0 && <p className="pg-empty">Empty. Click a console button to queue a command.</p>}
          <ol className="command-queue">
            {st.queue.map((c, i) => (
              <li key={c.id} className={(i === 0 ? "head " : "") + (c.status === "retrying" ? "retrying" : "") + (reduced ? "" : " command-in")}>
                <span className="command-meta">#{c.id} {i === 0 ? "· next" : ""} {c.attempts ? `· attempt ${c.attempts}/${MAX_ATTEMPTS} done` : ""}</span>
                <code>{serialize(c, st.useKeys)}</code>
              </li>
            ))}
          </ol>
          <div className="command-worker">
            <span className="label">Network on the next attempt</span>
            <PgChoice label="Network on the next attempt" value={st.fault} options={FAULTS} onChange={(f) => dispatch({ type: "setFault", fault: f })} />
            <label className="command-check">
              <input type="checkbox" checked={st.useKeys} onChange={(e) => dispatch({ type: "setKeys", on: e.target.checked })} />
              Send an idempotency key with each command
            </label>
            <div className="pg-actions">
              <PgButton primary disabled={!head} onClick={() => dispatch({ type: "work" })}>{head ? `Run worker on #${head.id}` : "Run worker"}</PgButton>
              <PgButton disabled={!target} onClick={() => dispatch({ type: "undo" })}
                title={target && !UNDOABLE[target.kind] ? "This command has no undo" : undefined}>
                {target ? `Undo #${target.id}` : "Undo"}
              </PgButton>
            </div>
          </div>
        </div>

        <div className="pg-card">
          <span className="label">Customer account · what really happened</span>
          <AccountView st={st} />
          <span className="label">Audit log · newest first</span>
          <div className="pg-log" aria-live="polite">
            {st.log.length === 0 && <p className="pg-empty">Every command leaves a line here.</p>}
            {st.log.map((l, i) => (
              <div key={l.n} className={"pg-entry" + (l.tone === "bad" ? " fail" : "") + (l.tone === "warn" ? " command-warn" : "") + (l.tone === "undo" ? " command-undo" : "") + (i === 0 && !reduced ? " fresh" : "")}>
                <p>{l.text}</p>
              </div>
            ))}
          </div>
        </div>
      </div>

      <div className="pg-card">
        <span className="label">Challenges</span>
        <ol className="command-ch">
          {CHALLENGES.map((c) => (
            <li key={c.id} className={challengeDone(st, c.id) ? "done" : ""}>{challengeDone(st, c.id) ? "✓ " : ""}{c.text}</li>
          ))}
        </ol>
      </div>

      <Result st={st} />

      <PgSources links={[
        { title: "Refactoring.Guru's Command", href: "https://refactoring.guru/design-patterns/command" },
        { title: "Sidekiq's best practices", href: "https://github.com/sidekiq/sidekiq/wiki/Best-Practices" },
        { title: "Stripe's idempotent requests", href: "https://docs.stripe.com/api/idempotent_requests" },
      ]} />
    </PgFrame>
  );
}

const CSS = `
.command-queue { list-style: none; margin: 0; padding: 0; display: grid; gap: 6px; }
.command-queue li { border: 1px solid var(--line); background: var(--surface); padding: 5px 8px; display: grid; gap: 2px; min-width: 0; }
.command-queue li.head { border-color: var(--accent); }
.command-queue li.retrying { border-style: dashed; border-color: var(--pain); }
.command-queue code { font-size: .68rem; background: none; padding: 0; word-break: break-all; }
.command-meta { font-family: var(--f-code); font-size: .62rem; letter-spacing: .06em; text-transform: uppercase; color: var(--ink-2); }
.command-in { animation: pg-hop .3s var(--ease) both; }
.command-worker { border-top: 1px solid var(--line); padding-top: 8px; display: grid; gap: 6px; justify-items: start; }
.command-check { display: flex; gap: 6px; align-items: center; font-size: .92rem; }
.command-asked { font-family: var(--f-code); font-size: .58rem; color: var(--ink-2); }
.pg-stats div.bad .command-asked { color: var(--pain); }
.command-warn { border-left-color: var(--pain); }
.command-undo { border-left-color: var(--accent); }
.command-ch { margin: 0; padding-left: 1.2em; display: grid; gap: 4px; font-size: .95rem; }
.command-ch li.done { color: var(--good); }
@media (prefers-reduced-motion: reduce) { .command-in { animation: none; } }
`;
