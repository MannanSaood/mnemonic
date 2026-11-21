"use client";
import { useState, type ReactNode } from "react";
import { usePrefs } from "@/components/Prefs";
import type { Lang } from "@/lib/types";
import { PgButton, PgFrame, PgPredict, PgSources, useModel } from "../kit";
import {
  NAME, init, requestCost, requestDone, sideDone, step,
  type Action, type Event, type Place, type Provider, type Side, type SideState, type State,
} from "./model";

/* ---------------- code snippets in the reader's language ---------------- */

const EXT: Record<Lang, string> = { go: "go", python: "py", typescript: "ts", rust: "rs" };
const quote = (ps: Provider[]) => ps.map((p) => `"${p}"`).join(", ");
const SYNTAX: Record<Lang, {
  config: (ps: Provider[]) => string; pay: string; refund: string; arm: (p: Provider, first: boolean) => string;
  paypalRefund: (fixed: boolean) => string;
}> = {
  go: {
    config: (ps) => `var providers = []string{${quote(ps)}}`,
    pay: "func (c *Checkout) Pay(o Order) …", refund: "func (c *Checkout) Refund(r Receipt) …",
    arm: (p) => `    case "${p}":`,
    paypalRefund: (f) => `        return c.paypal.${f ? "RefundPayment" : "RefundSale"}(r.ID)`,
  },
  python: {
    config: (ps) => `PROVIDERS = {${quote(ps)}}`,
    pay: "def pay(self, order): …", refund: "def refund(self, receipt): …",
    arm: (p, first) => `    ${first ? "if" : "elif"} self.provider == "${p}":`,
    paypalRefund: (f) => `        self.paypal.${f ? "refund_payment" : "refund_sale"}(receipt.id)`,
  },
  typescript: {
    config: (ps) => `export const PROVIDERS = [${quote(ps)}];`,
    pay: "async pay(order) { switch … }", refund: "async refund(receipt) { switch … }",
    arm: (p) => `    case "${p}":`,
    paypalRefund: (f) => `      return this.paypal.${f ? "refundPayment" : "refundSale"}(receipt.id);`,
  },
  rust: {
    config: (ps) => `const PROVIDERS: &[&str] = &[${quote(ps)}];`,
    pay: "fn pay(&self, order: &Order) { match … }", refund: "fn refund(&self, receipt: &Receipt) { match … }",
    arm: (p) => `    "${p}" => …,`,
    paypalRefund: (f) => `        "paypal" => self.paypal.${f ? "refund_payment" : "refund_sale"}(&receipt.id),`,
  },
};

function Line({ children, tone, action }: { children: ReactNode; tone?: "new" | "bad" | "file" | "head"; action?: ReactNode }) {
  return (
    <div className={"pgc-line" + (tone ? ` ${tone}` : "")}>
      <code>{children}</code>
      {action}
    </div>
  );
}

function BranchCode({ s, st, lang, dispatch }: { s: SideState; st: State; lang: Lang; dispatch: (a: Action) => void }) {
  const x = SYNTAX[lang];
  const add = (place: Place) =>
    st.request === 0 && !s.places[place].includes("klarna") ? (
      <PgButton onClick={() => dispatch({ type: "editPlace", place })}>+ klarna</PgButton>
    ) : null;
  const arms = (place: Place) =>
    s.places[place].map((p, i) => {
      const fixable = place === "refund" && p === "paypal" && st.request === 1;
      return (
        <div key={p}>
          <Line tone={p === "klarna" ? "new" : undefined}>{x.arm(p, i === 0)}</Line>
          {fixable && (
            <Line tone={s.paypalFixed ? "new" : "bad"}
              action={!s.paypalFixed ? <PgButton onClick={() => dispatch({ type: "fixPaypal", side: "branch" })}>Fix call</PgButton> : null}>
              {x.paypalRefund(s.paypalFixed)}
            </Line>
          )}
        </div>
      );
    });
  return (
    <div className="pgc">
      <Line tone="file">config.{EXT[lang]}</Line>
      <Line tone={s.places.config.includes("klarna") ? "new" : undefined} action={add("config")}>{x.config(s.places.config)}</Line>
      <Line tone="file">checkout.{EXT[lang]}</Line>
      <Line tone="head" action={add("pay")}>{x.pay}</Line>
      {arms("pay")}
      <Line tone="head" action={add("refund")}>{x.refund}</Line>
      {arms("refund")}
    </div>
  );
}

function StrategyCode({ s, st, lang, dispatch }: { s: SideState; st: State; lang: Lang; dispatch: (a: Action) => void }) {
  const e = EXT[lang];
  return (
    <div className="pgc">
      <Line tone="file">checkout.{e}</Line>
      <Line>Checkout holds one PaymentProvider and calls it. Never edited.</Line>
      <Line tone="file">providers</Line>
      {s.types.map((p) => (
        <div key={p}>
          <Line tone={p === "klarna" ? "new" : undefined}>{p}.{e}  ·  {NAME[p]}: Charge, Refund</Line>
          {p === "paypal" && st.request === 1 && (
            <Line tone={s.paypalFixed ? "new" : "bad"}
              action={!s.paypalFixed ? <PgButton onClick={() => dispatch({ type: "fixPaypal", side: "strategy" })}>Fix call</PgButton> : null}>
              {SYNTAX[lang].paypalRefund(s.paypalFixed).trim()}
            </Line>
          )}
        </div>
      ))}
      {st.request === 0 && !s.types.includes("klarna") && (
        <Line action={<PgButton onClick={() => dispatch({ type: "addProvider" })}>+ klarna.{e}</PgButton>}>
          <span className="muted">a new file, plus its line in the registry</span>
        </Line>
      )}
    </div>
  );
}

/* ---------------- per-side panels ---------------- */

function Stats({ s }: { s: SideState }) {
  const c = requestCost(s);
  const changed = [c.lines ? `${c.lines} line${c.lines > 1 ? "s" : ""}` : "", c.files ? `${c.files} new file` : ""].filter(Boolean).join(" + ") || "0";
  return (
    <dl className="pg-stats">
      <div><dt>Deploys</dt><dd>{c.deploys}</dd></div>
      <div><dt>Changed</dt><dd>{changed}</dd></div>
      <div className={c.lostSales ? "bad" : ""}><dt>Lost sales</dt><dd>{c.lostSales}</dd></div>
      <div className={c.stuckRefunds ? "bad" : ""}><dt>Stuck refunds</dt><dd>{c.stuckRefunds}</dd></div>
    </dl>
  );
}

function Traffic({ events, reduced }: { events: Event[]; reduced: boolean }) {
  if (!events.length) return <p className="pg-empty">No traffic yet. Your first change ships, then customers use it.</p>;
  return (
    <div className="pg-log" aria-live="polite">
      {events.map((e, i) => (
        <div key={`${e.kind}-${e.id}-${i}`} className={"pg-entry" + (e.ok ? " ok" : " fail") + (reduced ? "" : " fresh")}>
          <div className="pg-path" aria-hidden="true">
            {e.path.map((p, j) => <span key={j} style={{ animationDelay: `${i * 90 + j * 110}ms` }}>{p}</span>)}
          </div>
          <p>{e.outcome}</p>
        </div>
      ))}
    </div>
  );
}

const SIDE_INFO: Record<Side, { title: string; sub: string }> = {
  branch: { title: "Branch design", sub: "Pay, Refund and the config list each name every provider." },
  strategy: { title: "Strategy design", sub: "Checkout holds one PaymentProvider; each provider is its own type." },
};

/* ---------------- requests and results ---------------- */

const REQUESTS = [
  {
    title: "Add Klarna",
    why: "Marketing launches Klarna in the EU. As soon as Klarna is in the provider list, customers start choosing it, and some of them will ask for refunds.",
    task: "Make Klarna work in both checkouts.",
  },
  {
    title: "PayPal changed its refund call",
    why: "PayPal has switched off RefundSale. PayPal refunds are failing in production right now, in both checkouts.",
    task: "Switch both checkouts to RefundPayment.",
  },
];

const n = (k: number, one: string, many = one + "s") => `${k} ${k === 1 ? one : many}`;

function Result({ st }: { st: State }) {
  const b = requestCost(st.branch), s = requestCost(st.strategy);
  if (st.request === 0) {
    const hurt = b.lostSales + b.stuckRefunds;
    return (
      <>
        <p><b>Branch design:</b> {n(b.deploys, "deploy")}, {n(b.lines, "line")} in {n(b.places.length, "place")}. While the change was half done: {n(b.lostSales, "lost sale")}, {n(b.stuckRefunds, "stuck refund")}.</p>
        <p><b>Strategy design:</b> {n(s.deploys, "deploy")}, 1 new file. There was never a half-done state: {n(s.lostSales, "lost sale")}, {n(s.stuckRefunds, "stuck refund")}.</p>
        <p className="pg-takeaway">
          {hurt > 0
            ? "Adding a provider meant finding every place that names providers, and every in-between state reached customers. With Strategy, the new provider is one unit: it is either fully there or not there at all."
            : "You found a safe order (config last), so no customer noticed. But you still had to know all three places and the right order. With Strategy there was nothing to find and no order to get wrong."}
        </p>
      </>
    );
  }
  return (
    <>
      <p><b>Both designs:</b> 1 line, in 1 place, 1 deploy. Branch: the PayPal arm of Refund. Strategy: the PayPal type.</p>
      <p className="pg-takeaway">Strategy did not help here, and that is the point. The change was inside one provider, and that code lives in exactly one place in both designs. Strategy makes adding and removing providers cheap; it does not make every change cheap.</p>
    </>
  );
}

export default function StrategyCheckout() {
  const { lang } = usePrefs();
  const { state: st, dispatch, reduced } = useModel(step, init);
  const done = requestDone(st);
  // Predict first, per request; the answer is revealed when the request is done.
  const [guess, setGuess] = useState<Record<number, string | null>>({});
  const PREDICT = [
    {
      question: "In the branch design you will edit three places, and each edit ships on its own. Will any customer notice before you finish?",
      options: [{ value: "no", label: "No, it only matters once all three are done" }, { value: "yes", label: "Yes, some customers hit the half-done code" }, { value: "tests", label: "Only if the tests fail" }],
      answer: "yes",
      explain: "Each edit is live the moment it ships. Offer Klarna before Pay or Refund can handle it, and real customers fall into the gap. Only one order of edits avoids it, and you have to know it.",
    },
    {
      question: "PayPal changed one call. Which design needs fewer edits to fix it?",
      options: [{ value: "branch", label: "Branch design" }, { value: "strategy", label: "Strategy design" }, { value: "same", label: "The same" }],
      answer: "same",
      explain: "The change is inside one provider, and that code lives in one place in both designs. Strategy only pays off when the list of providers changes.",
    },
  ];
  const req = REQUESTS[Math.min(st.request, 1)];

  return (
    <PgFrame title="Two checkouts, one change request at a time" onReset={() => dispatch({ type: "reset" })}>
      {st.request < 2 ? (
        <div className="pg-req">
          <span className="label">Change request {st.request + 1} of 2</span>
          <h3>{req.title}</h3>
          <p>{req.why}</p>
          <p className="pg-rule"><b>{req.task}</b> Every change you make ships to production immediately, and customers keep using both checkouts while you work.</p>
          <PgPredict question={PREDICT[st.request].question} options={PREDICT[st.request].options}
            value={guess[st.request] ?? null} onChange={(v) => setGuess((g) => ({ ...g, [st.request]: v }))}
            revealed={done} answer={PREDICT[st.request].answer} explain={PREDICT[st.request].explain} />
          {done && (
            <div className="pg-result" aria-live="polite">
              <span className="label">What this request cost</span>
              <Result st={st} />
              <PgButton primary onClick={() => dispatch({ type: "next" })}>{st.request === 0 ? "Next request →" : "See the summary →"}</PgButton>
            </div>
          )}
        </div>
      ) : (
        <div className="pg-req">
          <span className="label">Summary</span>
          <h3>What the two requests showed</h3>
          {(() => {
            const [r1, r2] = st.results;
            return (
              <ul>
                <li><b>Adding Klarna:</b> the branch design took {n(r1.branch.deploys, "deploy")} across {n(r1.branch.places.length, "place")}, and customers hit the half-done states ({n(r1.branch.lostSales, "lost sale")}, {n(r1.branch.stuckRefunds, "stuck refund")}). The strategy design took one new file and one deploy, with no failures.</li>
                <li><b>Fixing PayPal&apos;s refund call:</b> {n(r2.branch.lines, "line")} in the branch design, {n(r2.strategy.lines, "line")} in the strategy design. The same cost.</li>
                <li><b>So:</b> use Strategy where the list of variants changes. It buys you nothing for changes inside one variant.</li>
              </ul>
            );
          })()}
          <PgButton onClick={() => dispatch({ type: "reset" })}>Start over</PgButton>
        </div>
      )}

      <div className="pg-sides">
        {(["branch", "strategy"] as Side[]).map((d) => (
          <section key={d} className="pg-side" aria-label={SIDE_INFO[d].title}>
            <header>
              <h4>{SIDE_INFO[d].title}</h4>
              <span className={"pg-status" + (sideDone(st, d) ? " done" : "")}>{st.request < 2 ? (sideDone(st, d) ? "Done" : "Not done") : ""}</span>
            </header>
            <p className="muted">{SIDE_INFO[d].sub}</p>
            {d === "branch" ? <BranchCode s={st.branch} st={st} lang={lang} dispatch={dispatch} /> : <StrategyCode s={st.strategy} st={st} lang={lang} dispatch={dispatch} />}
            <Stats s={st[d]} />
            <span className="label">Live traffic after the last deploy</span>
            <Traffic events={st[d].lastBatch} reduced={reduced} />
          </section>
        ))}
      </div>
      <PgSources links={[
        { title: "Jake Lazaroff's interactive CRDT intro (two live peers side by side)", href: "https://jakelazaroff.com/words/an-interactive-intro-to-crdts/" },
        { title: "refactoring.guru on Strategy", href: "https://refactoring.guru/design-patterns/strategy" },
      ]} />
    </PgFrame>
  );
}
