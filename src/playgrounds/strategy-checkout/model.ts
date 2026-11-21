// Strategy playground: a mini checkout that takes payments through one of several providers.
// Plain state + a pure step function, so it can be tested without a browser.
//
// Two designs of the same checkout:
// - "switch":   Pay and Refund each branch on the provider name, and config lists the names.
//               Adding a provider means editing all three places; forget one and it fails.
// - "strategy": Checkout holds a PaymentProvider. Adding a provider means adding one type.

export type Design = "switch" | "strategy";
export type Place = "pay" | "refund" | "config";
export const PROVIDERS = ["stripe", "paypal", "adyen", "klarna"] as const;
export type Provider = (typeof PROVIDERS)[number];
export const PROVIDER_NAME: Record<Provider, string> = { stripe: "Stripe", paypal: "PayPal", adyen: "Adyen", klarna: "Klarna" };
const BUILT_IN: Provider[] = ["stripe", "paypal", "adyen"];
/** The new provider the change request asks for. */
export const NEW_PROVIDER: Provider = "klarna";

/** Lines added to each place to teach the switch design one provider (Go version of the code). */
export const LINES_PER_PLACE: Record<Place, number> = { pay: 2, refund: 2, config: 1 };
export const PLACE_LABEL: Record<Place, string> = { pay: "Pay switch", refund: "Refund switch", config: "config list" };

export interface Receipt { id: string; provider: Provider; amount: number; refunded: boolean }
export interface LogEntry { id: number; ok: boolean; text: string; path: string[] }

export interface State {
  design: Design;
  selected: Provider;
  amount: number; // cents
  /** switch design: which providers each place knows */
  places: Record<Place, Provider[]>;
  /** strategy design: which provider types exist */
  types: Provider[];
  receipts: Receipt[];
  log: LogEntry[];
  /** what the change request has cost so far */
  cost: { lines: number; places: Place[]; newTypes: number };
  seq: number;
}

export type Action =
  | { type: "design"; design: Design }
  | { type: "select"; provider: Provider }
  | { type: "pay" }
  | { type: "refund" }
  | { type: "teach"; place: Place; provider: Provider }
  | { type: "addType"; provider: Provider }
  | { type: "reset" };

export function init(design: Design = "switch"): State {
  return {
    design,
    selected: "stripe",
    amount: 4800,
    places: { pay: [...BUILT_IN], refund: [...BUILT_IN], config: [...BUILT_IN] },
    types: [...BUILT_IN],
    receipts: [],
    log: [],
    cost: { lines: 0, places: [], newTypes: 0 },
    seq: 0,
  };
}

export const money = (cents: number) => `€${(cents / 100).toFixed(2)}`;
const receiptId = (p: Provider, n: number) => `${p.slice(0, 2)}_${4100 + n}`;

function log(s: State, ok: boolean, text: string, path: string[]): State {
  const entry: LogEntry = { id: s.seq + 1, ok, text, path };
  return { ...s, seq: s.seq + 1, log: [entry, ...s.log].slice(0, 8) };
}

/** Which providers the reader can pick at the checkout right now. */
export function available(s: State): Provider[] {
  return s.design === "switch" ? s.places.config : s.types;
}

export function step(s: State, a: Action): State {
  switch (a.type) {
    case "reset":
      return init(s.design);
    case "design":
      return a.design === s.design ? s : init(a.design);
    case "select":
      return { ...s, selected: a.provider };

    case "pay": {
      const p = s.selected;
      const name = PROVIDER_NAME[p];
      if (s.design === "switch") {
        if (!s.places.config.includes(p))
          return log(s, false, `Config rejected "${p}": it is not in the provider list.`, ["config", "✗"]);
        if (!s.places.pay.includes(p))
          return log(s, false, `Pay failed: unknown provider "${p}". The Pay switch has no case for it.`, ["Checkout.Pay", "switch", "✗"]);
      } else if (!s.types.includes(p)) {
        return log(s, false, `There is no ${name} type yet, so main cannot build one.`, ["main", "✗"]);
      }
      const r: Receipt = { id: receiptId(p, s.seq), provider: p, amount: s.amount, refunded: false };
      const path = s.design === "switch"
        ? ["Checkout.Pay", `case "${p}"`, `${name}.Charge`]
        : ["Checkout.Pay", "PaymentProvider.Charge", `${name}.Charge`];
      return log({ ...s, receipts: [r, ...s.receipts] }, true, `Charged ${money(s.amount)} with ${name}. Receipt ${r.id}.`, path);
    }

    case "refund": {
      const r = s.receipts.find((x) => !x.refunded);
      if (!r) return log(s, false, "Nothing to refund yet. Pay first.", ["Checkout.Refund", "✗"]);
      const name = PROVIDER_NAME[r.provider];
      if (s.design === "switch" && !s.places.refund.includes(r.provider))
        return log(s, false, `Refund failed: unknown provider "${r.provider}". The customer paid ${money(r.amount)} with ${name} and cannot get it back.`, ["Checkout.Refund", "switch", "✗"]);
      const receipts = s.receipts.map((x) => (x === r ? { ...x, refunded: true } : x));
      const path = s.design === "switch"
        ? ["Checkout.Refund", `case "${r.provider}"`, `${name}.Refund`]
        : ["Checkout.Refund", "PaymentProvider.Refund", `${name}.Refund`];
      return log({ ...s, receipts }, true, `Refunded ${money(r.amount)} to the customer through ${name} (${r.id}).`, path);
    }

    case "teach": {
      if (s.design !== "switch" || s.places[a.place].includes(a.provider)) return s;
      const places = { ...s.places, [a.place]: [...s.places[a.place], a.provider] };
      const cost = {
        ...s.cost,
        lines: s.cost.lines + LINES_PER_PLACE[a.place],
        places: s.cost.places.includes(a.place) ? s.cost.places : [...s.cost.places, a.place],
      };
      return log({ ...s, places, cost }, true, `Edited the ${PLACE_LABEL[a.place]}: added "${a.provider}".`, ["edit", PLACE_LABEL[a.place]]);
    }

    case "addType": {
      if (s.design !== "strategy" || s.types.includes(a.provider)) return s;
      const cost = { ...s.cost, newTypes: s.cost.newTypes + 1 };
      return log({ ...s, types: [...s.types, a.provider], cost }, true,
        `Added ${PROVIDER_NAME[a.provider].toLowerCase()}.go with a ${PROVIDER_NAME[a.provider]} type. No existing file changed.`, ["new file", `${PROVIDER_NAME[a.provider]}`]);
    }
  }
}

/** Text and fill (0..1) for the change-cost meter. */
export function costOf(s: State): { text: string; value: number; good: boolean } | null {
  if (s.design === "switch") {
    if (s.cost.lines === 0) return null;
    return { text: `${s.cost.lines} lines · ${s.cost.places.length} places edited`, value: Math.min(1, s.cost.lines / 6), good: false };
  }
  if (s.cost.newTypes === 0) return null;
  return { text: `${s.cost.newTypes} new type · 0 edits`, value: 0.12, good: true };
}
