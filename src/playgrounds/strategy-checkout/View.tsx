"use client";
import { PgButton, PgCard, PgChoice, PgFrame, PgLog, PgMeter, useModel } from "../kit";
import {
  NEW_PROVIDER, PLACE_LABEL, PROVIDERS, PROVIDER_NAME, available, costOf, init, money, step,
  type Design, type Place, type Provider,
} from "./model";

const PLACES: Place[] = ["pay", "refund", "config"];

export default function StrategyCheckout() {
  const { state: s, dispatch, reduced } = useModel(step, () => init("switch"));
  const avail = available(s);
  const last = s.receipts.find((r) => !r.refunded);
  const newName = PROVIDER_NAME[NEW_PROVIDER];

  return (
    <PgFrame
      title="Mini checkout"
      onReset={() => dispatch({ type: "reset" })}
      toolbar={
        <PgChoice<Design> label="Design" value={s.design} onChange={(d) => dispatch({ type: "design", design: d })}
          options={[{ value: "switch", label: "Switch design" }, { value: "strategy", label: "Strategy design" }]} />
      }
    >
      <div className="pg-grid">
        <PgCard label="The shop">
          <p className="pg-line"><span>2 items in the cart</span><b>{money(s.amount)}</b></p>
          <span className="label">Pay with</span>
          <PgChoice<Provider> label="Payment provider" value={s.selected} onChange={(p) => dispatch({ type: "select", provider: p })}
            options={PROVIDERS.map((p) => ({ value: p, label: PROVIDER_NAME[p], note: avail.includes(p) ? undefined : "Not set up yet" }))}
            disabledOptions={PROVIDERS.filter((p) => !avail.includes(p))} />
          <div className="pg-actions">
            <PgButton primary onClick={() => dispatch({ type: "pay" })}>Pay {money(s.amount)}</PgButton>
            <PgButton onClick={() => dispatch({ type: "refund" })} disabled={!last}>
              Refund {last ? `${PROVIDER_NAME[last.provider]} payment` : "last payment"}
            </PgButton>
          </div>
        </PgCard>

        <PgCard label={s.design === "switch" ? "The code: three places know the providers" : "The code: one type per provider"}>
          {s.design === "switch" ? (
            <ul className="pg-places">
              {PLACES.map((pl) => {
                const has = s.places[pl].includes(NEW_PROVIDER);
                return (
                  <li key={pl}>
                    <span className="pg-place">{PLACE_LABEL[pl]}</span>
                    <span className="pg-chips">{s.places[pl].map((p) => <code key={p} className={p === NEW_PROVIDER ? "new" : ""}>{p}</code>)}</span>
                    <PgButton onClick={() => dispatch({ type: "teach", place: pl, provider: NEW_PROVIDER })} disabled={has}
                      title={has ? "Already added" : `Add a "${NEW_PROVIDER}" branch here`}>{has ? "Done" : `+ ${NEW_PROVIDER}`}</PgButton>
                  </li>
                );
              })}
            </ul>
          ) : (
            <ul className="pg-places">
              <li>
                <span className="pg-place">PaymentProvider</span>
                <span className="pg-chips">{s.types.map((p) => <code key={p} className={p === NEW_PROVIDER ? "new" : ""}>{PROVIDER_NAME[p]}</code>)}</span>
                <PgButton onClick={() => dispatch({ type: "addType", provider: NEW_PROVIDER })} disabled={s.types.includes(NEW_PROVIDER)}>
                  {s.types.includes(NEW_PROVIDER) ? "Done" : `+ ${newName} type`}
                </PgButton>
              </li>
              <li className="pg-note">Checkout, Pay and Refund never change. main picks one provider and hands it in.</li>
            </ul>
          )}
        </PgCard>
      </div>
      <PgMeter cost={costOf(s)} />
      <PgLog entries={s.log} reduced={reduced} empty="Pay with a provider to see the call go through the checkout." />
    </PgFrame>
  );
}
