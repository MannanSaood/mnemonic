// Purpose. After this, the reader can answer: "Why refactor in small steps with a test run after
// each?" Because when a step changes behaviour by accident, the tests point at that one step and
// the fix is a one-step revert. After one big rewrite, the same red test points at everything.
//
// The model: a legacy order-total function with six tests and a refactoring plan of six steps
// from the catalogue (Change Function Declaration and Rename Variable, Replace Magic Literal,
// Extract Function twice, Inline Function, Move Function). One step slips: the extracted
// shippingFee() writes <= where the original said <, so an order of exactly 50.00 starts paying
// shipping. The reader applies steps one at a time or rewrites everything at once, runs the tests
// when they choose, and can revert to the last green commit. The model counts test runs, red
// runs, the suspects (steps and changed lines since the last green run) and work thrown away.
//
// Plain data + pure functions, so it can be tested without a browser.

export interface PlanStep { id: number; move: string; catalogue: string; what: string }
export const PLAN: PlanStep[] = [
  { id: 1, move: "Rename", catalogue: "Change Function Declaration · Rename Variable", what: "calc → orderTotal, o → order, t → total" },
  { id: 2, move: "Name the numbers", catalogue: "Replace Magic Literal", what: "10, 0.9, 0.95, 50, 4.99 become named constants" },
  { id: 3, move: "Extract lineTotal", catalogue: "Extract Function", what: "the loop body becomes lineTotal(line)" },
  { id: 4, move: "Extract shippingFee", catalogue: "Extract Function", what: "the shipping rule becomes shippingFee(subtotal)" },
  { id: 5, move: "Inline isGold", catalogue: "Inline Function", what: "a one-line helper used once goes back into the caller" },
  { id: 6, move: "Move the discount", catalogue: "Move Function", what: "the gold rule moves to Customer.discountRate()" },
];
export const SLIP_STEP = 4;

/* ---------------- the code at each point in the plan ---------------- */

const CONSTS = [
  "const BULK_QTY = 10;",
  "const BULK_RATE = 0.9;",
  "const GOLD_RATE = 0.95;",
  "const FREE_SHIPPING_FROM = 50;",
  "const SHIPPING_FEE = 4.99;",
  "",
];
const IS_GOLD = ["function isGold(c: Customer) {", '  return c.tier === "gold";', "}", ""];
const LINE_TOTAL = [
  "function lineTotal(line: Line): number {",
  "  const gross = line.qty * line.price;",
  "  return line.qty >= BULK_QTY ? gross * BULK_RATE : gross;",
  "}",
  "",
];
const shippingFn = (cmp: string) => [
  "function shippingFee(subtotal: number): number {",
  `  return subtotal ${cmp} FREE_SHIPPING_FROM ? SHIPPING_FEE : 0;`,
  "}",
  "",
];
const DISCOUNT_RATE = [
  "class Customer {",
  "  // ...existing fields",
  "  discountRate(): number {",
  '    return this.tier === "gold" ? GOLD_RATE : 1;',
  "  }",
  "}",
  "",
];

/** The source after `applied` plan steps. `slip` picks the faulty version of step 4. */
export function source(applied: number, slip: boolean): string[] {
  const cmp = slip ? "<=" : "<";
  switch (applied) {
    case 0:
      return [
        ...IS_GOLD,
        "function calc(o: Order): number {",
        "  let t = 0;",
        "  for (const l of o.lines) {",
        "    let p = l.qty * l.price;",
        "    if (l.qty >= 10) p = p * 0.9;",
        "    t = t + p;",
        "  }",
        "  if (isGold(o.customer)) t = t * 0.95;",
        "  if (t < 50) t = t + 4.99;",
        "  return Math.round(t * 100) / 100;",
        "}",
      ];
    case 1:
      return [
        ...IS_GOLD,
        "function orderTotal(order: Order): number {",
        "  let total = 0;",
        "  for (const line of order.lines) {",
        "    let p = line.qty * line.price;",
        "    if (line.qty >= 10) p = p * 0.9;",
        "    total = total + p;",
        "  }",
        "  if (isGold(order.customer)) total = total * 0.95;",
        "  if (total < 50) total = total + 4.99;",
        "  return Math.round(total * 100) / 100;",
        "}",
      ];
    case 2:
      return [
        ...CONSTS, ...IS_GOLD,
        "function orderTotal(order: Order): number {",
        "  let total = 0;",
        "  for (const line of order.lines) {",
        "    let p = line.qty * line.price;",
        "    if (line.qty >= BULK_QTY) p = p * BULK_RATE;",
        "    total = total + p;",
        "  }",
        "  if (isGold(order.customer)) total = total * GOLD_RATE;",
        "  if (total < FREE_SHIPPING_FROM) total = total + SHIPPING_FEE;",
        "  return Math.round(total * 100) / 100;",
        "}",
      ];
    case 3:
      return [
        ...CONSTS, ...IS_GOLD, ...LINE_TOTAL,
        "function orderTotal(order: Order): number {",
        "  let total = 0;",
        "  for (const line of order.lines) total = total + lineTotal(line);",
        "  if (isGold(order.customer)) total = total * GOLD_RATE;",
        "  if (total < FREE_SHIPPING_FROM) total = total + SHIPPING_FEE;",
        "  return Math.round(total * 100) / 100;",
        "}",
      ];
    case 4:
      return [
        ...CONSTS, ...IS_GOLD, ...LINE_TOTAL, ...shippingFn(cmp),
        "function orderTotal(order: Order): number {",
        "  let total = 0;",
        "  for (const line of order.lines) total = total + lineTotal(line);",
        "  if (isGold(order.customer)) total = total * GOLD_RATE;",
        "  total = total + shippingFee(total);",
        "  return Math.round(total * 100) / 100;",
        "}",
      ];
    case 5:
      return [
        ...CONSTS, ...LINE_TOTAL, ...shippingFn(cmp),
        "function orderTotal(order: Order): number {",
        "  let total = 0;",
        "  for (const line of order.lines) total = total + lineTotal(line);",
        '  if (order.customer.tier === "gold") total = total * GOLD_RATE;',
        "  total = total + shippingFee(total);",
        "  return Math.round(total * 100) / 100;",
        "}",
      ];
    default:
      return [
        ...CONSTS, ...DISCOUNT_RATE, ...LINE_TOTAL, ...shippingFn(cmp),
        "function orderTotal(order: Order): number {",
        "  let total = 0;",
        "  for (const line of order.lines) total = total + lineTotal(line);",
        "  total = total * order.customer.discountRate();",
        "  total = total + shippingFee(total);",
        "  return Math.round(total * 100) / 100;",
        "}",
      ];
  }
}

/** Lines added or removed between two versions (a simple multiset diff, enough for a size). */
export function changedLines(a: string[], b: string[]): number {
  const count = (xs: string[]) => { const m = new Map<string, number>(); for (const x of xs) if (x.trim()) m.set(x, (m.get(x) ?? 0) + 1); return m; };
  const ca = count(a), cb = count(b);
  let n = 0;
  for (const [k, v] of cb) n += Math.max(0, v - (ca.get(k) ?? 0));
  for (const [k, v] of ca) n += Math.max(0, v - (cb.get(k) ?? 0));
  return n;
}

/* ---------------- behaviour ---------------- */

export interface Order { lines: { qty: number; price: number }[]; gold: boolean }

/** What the code does. Every step but the slipped shippingFee preserves this exactly. */
export function total(o: Order, slip: boolean): number {
  let t = 0;
  for (const l of o.lines) {
    const gross = l.qty * l.price;
    t += l.qty >= 10 ? gross * 0.9 : gross;
  }
  if (o.gold) t *= 0.95;
  const pays = slip ? t <= 50 : t < 50;
  if (pays) t += 4.99;
  return Math.round(t * 100) / 100;
}

export interface Case { name: string; order: Order; expect: number }
export const TESTS: Case[] = [
  { name: "an empty order pays shipping only", order: { lines: [], gold: false }, expect: 4.99 },
  { name: "10 or more of a line get 10% off", order: { lines: [{ qty: 10, price: 3 }], gold: false }, expect: 31.99 },
  { name: "gold customers get 5% off", order: { lines: [{ qty: 1, price: 100 }], gold: true }, expect: 95 },
  { name: "orders under 50.00 pay 4.99 shipping", order: { lines: [{ qty: 2, price: 20 }], gold: false }, expect: 44.99 },
  { name: "an order of exactly 50.00 ships free", order: { lines: [{ qty: 2, price: 25 }], gold: false }, expect: 50 },
  { name: "totals round to cents", order: { lines: [{ qty: 3, price: 3.333 }], gold: false }, expect: 14.99 },
];

export interface CaseResult { name: string; expect: number; got: number; ok: boolean }
export function runSuite(applied: number, slip: boolean): CaseResult[] {
  const s = applied >= SLIP_STEP && slip;
  return TESTS.map((t) => { const got = total(t.order, s); return { name: t.name, expect: t.expect, got, ok: got === t.expect }; });
}

/* ---------------- state ---------------- */

export interface Run {
  at: number;
  green: boolean;
  failed: string[];
  /** plan steps applied since the last green run: where the change could be */
  suspects: number[];
  changed: number;
}

export type Event =
  | { kind: "apply"; steps: number[]; slip: boolean }
  | { kind: "test"; run: Run }
  | { kind: "revert"; to: number; discarded: number };

export interface State {
  applied: number;
  slip: boolean;
  /** the reader reverted a red run whose only suspect was the slipped step, so they redo it right */
  learned: boolean;
  lastGreen: number;
  log: Event[];
  stepsApplied: number;
  runs: number;
  reds: number;
  discarded: number;
  lastRun: Run | null;
}

export type Action = { type: "apply" } | { type: "rewrite" } | { type: "test" } | { type: "revert" } | { type: "reset" };

export function init(): State {
  return { applied: 0, slip: false, learned: false, lastGreen: 0, log: [], stepsApplied: 0, runs: 0, reds: 0, discarded: 0, lastRun: null };
}

export const code = (s: Pick<State, "applied" | "slip">) => source(s.applied, s.slip);
export const greenCode = (s: Pick<State, "lastGreen">) => source(s.lastGreen, false);
export const done = (s: State) => s.applied === PLAN.length && s.lastGreen === PLAN.length;

function applyTo(s: State, to: number): State {
  if (to <= s.applied || to > PLAN.length) return s;
  const steps = PLAN.slice(s.applied, to).map((p) => p.id);
  const slip = s.slip || (steps.includes(SLIP_STEP) && !s.learned);
  return {
    ...s, applied: to, slip, stepsApplied: s.stepsApplied + steps.length, lastRun: null,
    log: [...s.log, { kind: "apply", steps, slip: steps.includes(SLIP_STEP) && slip }],
  };
}

export function step(s: State, a: Action): State {
  switch (a.type) {
    case "reset":
      return init();
    case "apply":
      return applyTo(s, s.applied + 1);
    case "rewrite":
      return applyTo(s, PLAN.length);
    case "test": {
      const results = runSuite(s.applied, s.slip);
      const green = results.every((r) => r.ok);
      const run: Run = {
        at: s.applied, green,
        failed: results.filter((r) => !r.ok).map((r) => r.name),
        suspects: PLAN.slice(s.lastGreen, s.applied).map((p) => p.id),
        changed: changedLines(greenCode(s), code(s)),
      };
      return {
        ...s, runs: s.runs + 1, reds: s.reds + (green ? 0 : 1), lastRun: run,
        lastGreen: green ? s.applied : s.lastGreen,
        log: [...s.log, { kind: "test", run }],
      };
    }
    case "revert": {
      if (s.applied === s.lastGreen) return s;
      const discarded = s.applied - s.lastGreen;
      const pinned = s.lastRun && !s.lastRun.green && s.lastRun.suspects.length === 1 && s.lastRun.suspects[0] === SLIP_STEP;
      return {
        ...s, applied: s.lastGreen, slip: false, learned: s.learned || !!pinned, discarded: s.discarded + discarded, lastRun: null,
        log: [...s.log, { kind: "revert", to: s.lastGreen, discarded }],
      };
    }
  }
}

/* ---------------- the two extremes, for comparison ---------------- */

export interface Plan { runs: number; suspects: number; changed: number }
/** One rewrite, one test run: red, and every step is a suspect. */
export function bigBang(): Plan {
  return { runs: 1, suspects: PLAN.length, changed: changedLines(source(0, false), source(PLAN.length, true)) };
}
/** A test run after every step: red right after step 4, with one suspect and a small diff. */
export function smallSteps(): Plan {
  return { runs: PLAN.length + 1, suspects: 1, changed: changedLines(source(SLIP_STEP - 1, false), source(SLIP_STEP, true)) };
}
