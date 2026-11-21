// Purpose. After this, the reader can answer: "Why does TDD go red first, then take the smallest
// step to green, and only then clean up? What do I lose when I take a big step instead?"
//
// The model: a guided red-green-refactor loop on a cart total (cents, a 10% bulk discount from
// $100.00, a SAVE5 coupon, never below zero). The reader:
// - picks the next test from a test list; the suite runs and should go red;
// - picks a change to get to green, from small (return a constant) to big (write everything now);
// - refactors while green, with the tests as a safety net (one tempting "tidy" is a slip that
//   changes behaviour, and a test catches it if one was written).
// The implementation is a small set of features, evaluated for real against each test. Metrics:
// the bar history, surprise reds (red after a change meant to be green), tests never seen red,
// the largest step in lines, and lines that no test asked for.
//
// Plain state + a pure step function, so it can be tested without a browser.

export type TestId = "t1" | "t2" | "t3" | "t4" | "t5" | "t6";
export const TEST_IDS: TestId[] = ["t1", "t2", "t3", "t4", "t5", "t6"];

export interface Item { name: string; cents: number; qty: number }
const MUG: Item = { name: "mug", cents: 1200, qty: 2 };
const POSTER: Item = { name: "poster", cents: 3000, qty: 1 };
const LAMP: Item = { name: "lamp", cents: 10000, qty: 1 };
const STICKER: Item = { name: "sticker", cents: 300, qty: 1 };

export interface TestDef { id: TestId; name: string; items: Item[]; coupon: string | null; want: number }
export const TESTS: Record<TestId, TestDef> = {
  t1: { id: "t1", name: "an empty cart costs $0.00", items: [], coupon: null, want: 0 },
  t2: { id: "t2", name: "two $12.00 mugs cost $24.00", items: [MUG], coupon: null, want: 2400 },
  t3: { id: "t3", name: "mugs and a $30.00 poster add up", items: [MUG, POSTER], coupon: null, want: 5400 },
  t4: { id: "t4", name: "exactly $100.00 gets 10% off", items: [LAMP], coupon: null, want: 9000 },
  t5: { id: "t5", name: "SAVE5 takes $5.00 off", items: [MUG], coupon: "SAVE5", want: 1900 },
  t6: { id: "t6", name: "a coupon never makes the total negative", items: [STICKER], coupon: "SAVE5", want: 0 },
};

export const money = (c: number) => `${c < 0 ? "-" : ""}$${(Math.abs(c) / 100).toFixed(2)}`;
export const itemsText = (t: TestDef) =>
  "[" + t.items.map((i) => `${i.name} ${money(i.cents)} × ${i.qty}`).join(", ") + "]" + (t.coupon ? `, "${t.coupon}"` : "");

// ---------------------------------------------------------------- the code under test

export interface Impl {
  sum: "none" | "zero" | "const2400" | "loop";
  discount: "none" | "ge" | "gt";
  coupon: "none" | "minus5" | "floor";
  named: boolean;
  extracted: boolean;
}
export const EMPTY: Impl = { sum: "none", discount: "none", coupon: "none", named: false, extracted: false };

/** Run the implementation. null means it does not exist yet (does not compile). */
export function total(impl: Impl, t: TestDef): number | null {
  if (impl.sum === "none") return null;
  let tot = impl.sum === "zero" ? 0 : impl.sum === "const2400" ? (t.items.length === 0 ? 0 : 2400) : t.items.reduce((a, i) => a + i.cents * i.qty, 0);
  if (impl.discount === "ge" ? tot >= 10000 : impl.discount === "gt" ? tot > 10000 : false) tot -= Math.floor(tot / 10);
  if (t.coupon === "SAVE5") {
    if (impl.coupon === "minus5") tot -= 500;
    if (impl.coupon === "floor") tot = Math.max(0, tot - 500);
  }
  return tot;
}

export interface TestResult { id: TestId; pass: boolean; message: string }
export function runTest(impl: Impl, id: TestId): TestResult {
  const t = TESTS[id];
  const got = total(impl, t);
  if (got === null) return { id, pass: false, message: "cartTotal does not exist yet, so the test does not even compile." };
  return got === t.want
    ? { id, pass: true, message: `returned ${money(got)}` }
    : { id, pass: false, message: `returned ${money(got)}, want ${money(t.want)}` };
}
export const runSuite = (impl: Impl, written: TestId[]) => written.map((id) => runTest(impl, id));

/** Lines in the implementation that no written test asks for. */
export function untestedLines(impl: Impl, written: TestId[]): number {
  const has = (id: TestId) => written.includes(id);
  let n = 0;
  if (impl.sum === "loop" && !has("t2") && !has("t3")) n += 2;
  if (impl.discount !== "none" && !has("t4")) n += 2;
  if (impl.coupon !== "none" && !has("t5")) n += 2;
  if (impl.coupon === "floor" && !has("t6")) n += 1;
  return n;
}

// ---------------------------------------------------------------- moves

export interface Move { id: string; label: string; size: "small" | "medium" | "big" | "risky"; lines: number; apply: (i: Impl) => Impl }

const create = (i: Impl) => (i.sum === "none" ? 2 : 0); // the function signature and closing brace
const loop = (i: Impl): Impl => ({ ...i, sum: "loop" });
const loopLines = (i: Impl) => (i.sum === "loop" ? 0 : 2) + create(i);
const LEAP: Move = {
  id: "leap", label: "Write the whole calculator now: sum, 10% off over $100.00, SAVE5", size: "big", lines: 9,
  apply: (i) => ({ ...i, sum: "loop", discount: "gt", coupon: "minus5" }),
};

/** The changes on offer to turn the newest test green. */
export function greenMoves(impl: Impl, test: TestId): Move[] {
  const leap = impl.discount === "none" && impl.coupon === "none" ? [LEAP] : [];
  switch (test) {
    case "t1": return [
      { id: "zero", label: "Create cartTotal and return 0", size: "small", lines: 3, apply: (i) => ({ ...i, sum: "zero" }) },
      { id: "loop", label: "Create cartTotal and sum price × quantity", size: "medium", lines: 5, apply: loop },
      ...leap,
    ];
    case "t2": return [
      { id: "const", label: "Return 0 for an empty cart, otherwise 2400", size: "small", lines: 3 + create(impl), apply: (i) => ({ ...i, sum: "const2400" }) },
      { id: "loop", label: "Sum price × quantity over the items", size: "medium", lines: loopLines(impl), apply: loop },
      ...leap,
    ];
    case "t3": return [
      { id: "loop", label: "Sum price × quantity over the items", size: "small", lines: loopLines(impl), apply: loop },
      ...leap,
    ];
    case "t4": return [
      { id: "ge", label: "Take 10% off when the subtotal is $100.00 or more", size: "small", lines: 2 + loopLines(impl), apply: (i) => ({ ...loop(i), discount: "ge" }) },
      { id: "gt", label: "Take 10% off when the subtotal is over $100.00", size: "small", lines: 2 + loopLines(impl), apply: (i) => ({ ...loop(i), discount: "gt" }) },
      ...leap,
    ];
    case "t5": return [
      { id: "minus5", label: "Subtract $5.00 when the coupon is SAVE5", size: "small", lines: 2 + loopLines(impl), apply: (i) => ({ ...loop(i), coupon: "minus5" }) },
      { id: "floor5", label: "Subtract $5.00 for SAVE5, and never go below zero", size: "medium", lines: 3 + loopLines(impl), apply: (i) => ({ ...loop(i), coupon: "floor" }) },
      ...leap,
    ];
    case "t6": return [
      { id: "floor", label: "Clamp the total at $0.00 after the coupon", size: "small", lines: (impl.coupon === "none" ? 3 : 1) + loopLines(impl), apply: (i) => ({ ...loop(i), coupon: "floor" }) },
      ...leap,
    ];
  }
}

/** Refactorings on offer while green. "slip" looks like a tidy-up but changes behaviour. */
export function refactorMoves(impl: Impl): Move[] {
  const out: Move[] = [];
  if (impl.sum === "const2400")
    out.push({ id: "dup", label: "Remove the duplication: 2400 is the mugs' price × quantity, so compute it from the items", size: "small", lines: 2, apply: loop });
  if (!impl.named && (impl.discount !== "none" || impl.coupon !== "none"))
    out.push({ id: "name", label: "Name the magic numbers 10_000 and 500", size: "small", lines: 3, apply: (i) => ({ ...i, named: true }) });
  if (!impl.extracted && impl.sum === "loop" && impl.discount !== "none" && impl.coupon !== "none")
    out.push({ id: "extract", label: "Extract subtotal, applyDiscount and applyCoupon", size: "medium", lines: 6, apply: (i) => ({ ...i, extracted: true }) });
  if (impl.discount === "ge")
    out.push({ id: "slip", label: "Tidy the discount check so it reads like the others: > instead of >=", size: "risky", lines: 1, apply: (i) => ({ ...i, discount: "gt" }) });
  return out;
}

// ---------------------------------------------------------------- state

export type Phase = "pick" | "red" | "broken" | "refactor" | "done";
export type BarKind = "red" | "green" | "surprise" | "caught";
export interface Bar { kind: BarKind; label: string }

export type Predict = "green" | "red" | "either";
export const PREDICT_ANSWER: Predict = "red";

export interface State {
  impl: Impl;
  /** The implementation before the last change, for undo after an unexpected red. */
  prev: Impl | null;
  /** Phase to return to when the reader undoes. */
  undoTo: "red" | "refactor";
  written: TestId[];
  current: TestId | null;
  phase: Phase;
  bars: Bar[];
  note: string;
  largestStep: number;
  surprises: number;
  neverRed: TestId[];
  slipsCaught: number;
  cycles: number;
  /** Lines changed by the last move, for highlighting. */
  lastLines: number;
  predict: Predict | null;
}

export type Action =
  | { type: "write"; test: TestId }
  | { type: "green"; move: string }
  | { type: "refactor"; move: string }
  | { type: "doneRefactoring" }
  | { type: "undo" }
  | { type: "predict"; value: Predict }
  | { type: "reset" };

export function init(): State {
  return {
    impl: EMPTY, prev: null, undoTo: "red", written: [], current: null, phase: "pick", bars: [],
    note: "Pick the first test from the list. Write it before any code.",
    largestStep: 0, surprises: 0, neverRed: [], slipsCaught: 0, cycles: 0, lastLines: 0, predict: null,
  };
}

const allGreen = (impl: Impl, written: TestId[]) => runSuite(impl, written).every((r) => r.pass);
const bar = (st: State, b: Bar) => [...st.bars, b].slice(-40);

function afterGreen(st: State): State {
  if (st.written.length === TEST_IDS.length) return { ...st, phase: "refactor" };
  return st;
}

export function step(st: State, a: Action): State {
  switch (a.type) {
    case "reset": return init();
    case "predict": return { ...st, predict: a.value };

    case "write": {
      if (st.phase !== "pick" || st.written.includes(a.test)) return st;
      const written = [...st.written, a.test];
      const r = runTest(st.impl, a.test);
      if (r.pass) {
        return afterGreen({
          ...st, written, current: a.test, phase: "refactor", neverRed: [...st.neverRed, a.test],
          bars: bar(st, { kind: "green", label: `${a.test} passed at once` }),
          note: `"${TESTS[a.test].name}" passed the moment you wrote it, so it never proved it can fail. An earlier step already built this behaviour: a big green step, or a refactoring that generalised the code. Check it by breaking the expected value once and watching it go red.`,
        });
      }
      return {
        ...st, written, current: a.test, phase: "red", bars: bar(st, { kind: "red", label: `${a.test} red` }), lastLines: 0,
        note: `Red, as expected: ${r.message}. Now make it pass with the smallest change you can.`,
      };
    }

    case "green": {
      if (st.phase !== "red" || !st.current) return st;
      const m = greenMoves(st.impl, st.current).find((x) => x.id === a.move);
      if (!m) return st;
      const impl = m.apply(st.impl);
      const results = runSuite(impl, st.written);
      const failing = results.filter((r) => !r.pass);
      const base = { ...st, prev: st.impl, impl, largestStep: Math.max(st.largestStep, m.lines), lastLines: m.lines };
      if (failing.length) {
        return {
          ...base, phase: "broken", undoTo: "red", surprises: st.surprises + 1,
          bars: bar(st, { kind: "surprise", label: `${failing.map((f) => f.id).join(", ")} red` }),
          note: `Still red, and you expected green: ${failing.map((f) => `${f.id} ${f.message}`).join("; ")}. Undo and take a smaller, more careful step.`,
        };
      }
      const untested = untestedLines(impl, st.written);
      return afterGreen({
        ...base, phase: "refactor", cycles: st.cycles + 1, bars: bar(st, { kind: "green", label: `green · ${m.lines} lines` }),
        note: `Green in ${m.lines} changed lines.${m.id === "zero" || m.id === "const" ? " Yes, it is a hard-coded answer. The duplication between the test and the code is what the next step removes." : ""}${untested ? ` ${untested} of those lines do something no test asks for yet.` : ""} Now refactor while green, or move on.`,
      });
    }

    case "refactor": {
      if (st.phase !== "refactor") return st;
      const m = refactorMoves(st.impl).find((x) => x.id === a.move);
      if (!m) return st;
      const impl = m.apply(st.impl);
      const failing = runSuite(impl, st.written).filter((r) => !r.pass);
      if (failing.length) {
        return {
          ...st, prev: st.impl, impl, phase: "broken", undoTo: "refactor", slipsCaught: st.slipsCaught + 1, lastLines: m.lines,
          bars: bar(st, { kind: "caught", label: `${failing.map((f) => f.id).join(", ")} red` }),
          note: `The safety net caught it: ${failing.map((f) => `${f.id} ${f.message}`).join("; ")}. That "tidy-up" changed behaviour. Undo it; a refactoring must keep every test green.`,
        };
      }
      return {
        ...st, prev: st.impl, impl, lastLines: m.lines, bars: bar(st, { kind: "green", label: `refactor · still green` }),
        note: m.id === "slip"
          ? "Still green, but only because no test pins the exact $100.00 boundary yet. The behaviour changed and nothing noticed."
          : "Still green. The code is cleaner and the tests say it does the same thing.",
      };
    }

    case "doneRefactoring": {
      if (st.phase !== "refactor") return st;
      if (st.written.length === TEST_IDS.length && allGreen(st.impl, st.written))
        return { ...st, phase: "done", note: "Every test on the list is written and green." };
      return { ...st, phase: "pick", current: null, note: "Pick the next test from the list." };
    }

    case "undo": {
      if (st.phase !== "broken" || !st.prev) return st;
      return { ...st, impl: st.prev, prev: null, phase: st.undoTo, lastLines: 0, note: st.undoTo === "red" ? "Undone. The new test is red again; pick another change." : "Undone. Back to green." };
    }
  }
}

export interface Summary { cycles: number; largestStep: number; surprises: number; neverRed: number; slipsCaught: number; untested: number; written: number }
export function summary(st: State): Summary {
  return {
    cycles: st.cycles, largestStep: st.largestStep, surprises: st.surprises, neverRed: st.neverRed.length,
    slipsCaught: st.slipsCaught, untested: untestedLines(st.impl, st.written), written: st.written.length,
  };
}

export const predictRevealed = (st: State) => st.bars.length > 0;

export function challenges(st: State) {
  const done = st.phase === "done";
  return [
    { id: "clean", text: "Finish the whole list with no surprise red bar.", done: done && st.surprises === 0 },
    { id: "small", text: "Finish with no step bigger than 5 lines.", done: done && st.largestStep <= 5 },
    { id: "net", text: "Let a test catch a refactoring that changed behaviour.", done: st.slipsCaught > 0 },
    { id: "never", text: "Find out how a test can pass the moment it is written.", done: st.neverRed.length > 0 },
  ];
}

// ---------------------------------------------------------------- the code, per language

export type Lang = "go" | "python" | "typescript" | "rust";

export function codeLines(i: Impl, lang: Lang): string[] {
  const X = i.named ? { go: "BulkFromCents", python: "BULK_FROM_CENTS", typescript: "BULK_FROM_CENTS", rust: "BULK_FROM_CENTS" }[lang] : "10_000";
  const S = i.named ? { go: "Save5Cents", python: "SAVE5_CENTS", typescript: "SAVE5_CENTS", rust: "SAVE5_CENTS" }[lang] : "500";
  const op = i.discount === "gt" ? ">" : ">=";
  const consts: Record<Lang, string[]> = {
    go: ["const (", "    BulkFromCents = 10_000", "    Save5Cents    = 500", ")", ""],
    python: ["BULK_FROM_CENTS = 10_000", "SAVE5_CENTS = 500", ""],
    typescript: ["const BULK_FROM_CENTS = 10_000;", "const SAVE5_CENTS = 500;", ""],
    rust: ["const BULK_FROM_CENTS: i64 = 10_000;", "const SAVE5_CENTS: i64 = 500;", ""],
  };
  if (i.sum === "none") return [{ go: "// cart.go: no code yet", python: "# cart.py: no code yet", typescript: "// cart.ts: no code yet", rust: "// cart.rs: no code yet" }[lang]];
  const head = i.named ? consts[lang] : [];
  const floor = i.coupon === "floor";
  if (i.extracted) {
    const ex: Record<Lang, string[]> = {
      go: [
        "func CartTotal(items []Item, coupon string) int {", "    return applyCoupon(applyDiscount(subtotal(items)), coupon)", "}", "",
        "func subtotal(items []Item) (t int) {", "    for _, it := range items {", "        t += it.PriceCents * it.Qty", "    }", "    return t", "}", "",
        "func applyDiscount(t int) int {", `    if t ${op} ${X} {`, "        return t - t/10", "    }", "    return t", "}", "",
        "func applyCoupon(t int, coupon string) int {", '    if coupon != "SAVE5" {', "        return t", "    }", floor ? `    return max(0, t-${S})` : `    return t - ${S}`, "}",
      ],
      python: [
        "def cart_total(items: list[Item], coupon: str | None = None) -> int:", "    return apply_coupon(apply_discount(subtotal(items)), coupon)", "", "",
        "def subtotal(items: list[Item]) -> int:", "    return sum(it.price_cents * it.qty for it in items)", "", "",
        "def apply_discount(total: int) -> int:", `    return total - total // 10 if total ${op} ${X} else total`, "", "",
        "def apply_coupon(total: int, coupon: str | None) -> int:", floor ? `    return max(0, total - ${S}) if coupon == "SAVE5" else total` : `    return total - ${S} if coupon == "SAVE5" else total`,
      ],
      typescript: [
        "export function cartTotal(items: Item[], coupon?: string): number {", "  return applyCoupon(applyDiscount(subtotal(items)), coupon);", "}", "",
        "const subtotal = (items: Item[]) => items.reduce((t, it) => t + it.priceCents * it.qty, 0);",
        `const applyDiscount = (t: number) => (t ${op} ${X} ? t - Math.floor(t / 10) : t);`,
        floor ? `const applyCoupon = (t: number, coupon?: string) => (coupon === "SAVE5" ? Math.max(0, t - ${S}) : t);` : `const applyCoupon = (t: number, coupon?: string) => (coupon === "SAVE5" ? t - ${S} : t);`,
      ],
      rust: [
        "pub fn cart_total(items: &[Item], coupon: Option<&str>) -> i64 {", "    apply_coupon(apply_discount(subtotal(items)), coupon)", "}", "",
        "fn subtotal(items: &[Item]) -> i64 {", "    items.iter().map(|it| it.price_cents * it.qty).sum()", "}", "",
        "fn apply_discount(total: i64) -> i64 {", `    if total ${op} ${X} { total - total / 10 } else { total }`, "}", "",
        "fn apply_coupon(total: i64, coupon: Option<&str>) -> i64 {", floor ? `    if coupon == Some("SAVE5") { (total - ${S}).max(0) } else { total }` : `    if coupon == Some("SAVE5") { total - ${S} } else { total }`, "}",
      ],
    };
    return [...head, ...ex[lang]];
  }
  const body: string[] = [];
  const mut = i.discount !== "none" || i.coupon !== "none";
  switch (lang) {
    case "go":
      body.push("func CartTotal(items []Item, coupon string) int {");
      if (i.sum === "zero") body.push("    return 0");
      else if (i.sum === "const2400") body.push("    if len(items) == 0 {", "        return 0", "    }", "    return 2400");
      else {
        body.push("    total := 0", "    for _, it := range items {", "        total += it.PriceCents * it.Qty", "    }");
        if (i.discount !== "none") body.push(`    if total ${op} ${X} {`, "        total -= total / 10", "    }");
        if (i.coupon !== "none") body.push('    if coupon == "SAVE5" {', floor ? `        total = max(0, total-${S})` : `        total -= ${S}`, "    }");
        body.push("    return total");
      }
      body.push("}");
      break;
    case "python":
      body.push("def cart_total(items: list[Item], coupon: str | None = None) -> int:");
      if (i.sum === "zero") body.push("    return 0");
      else if (i.sum === "const2400") body.push("    if not items:", "        return 0", "    return 2400");
      else {
        body.push("    total = sum(it.price_cents * it.qty for it in items)");
        if (i.discount !== "none") body.push(`    if total ${op} ${X}:`, "        total -= total // 10");
        if (i.coupon !== "none") body.push('    if coupon == "SAVE5":', floor ? `        total = max(0, total - ${S})` : `        total -= ${S}`);
        body.push("    return total");
      }
      break;
    case "typescript":
      body.push("export function cartTotal(items: Item[], coupon?: string): number {");
      if (i.sum === "zero") body.push("  return 0;");
      else if (i.sum === "const2400") body.push("  if (items.length === 0) return 0;", "  return 2400;");
      else {
        body.push(`  ${mut ? "let" : "const"} total = items.reduce((t, it) => t + it.priceCents * it.qty, 0);`);
        if (i.discount !== "none") body.push(`  if (total ${op} ${X}) total -= Math.floor(total / 10);`);
        if (i.coupon !== "none") body.push(floor ? `  if (coupon === "SAVE5") total = Math.max(0, total - ${S});` : `  if (coupon === "SAVE5") total -= ${S};`);
        body.push("  return total;");
      }
      body.push("}");
      break;
    case "rust":
      body.push("pub fn cart_total(items: &[Item], coupon: Option<&str>) -> i64 {");
      if (i.sum === "zero") body.push("    0");
      else if (i.sum === "const2400") body.push("    if items.is_empty() {", "        return 0;", "    }", "    2400");
      else {
        body.push(`    let ${mut ? "mut " : ""}total: i64 = items.iter().map(|it| it.price_cents * it.qty).sum();`);
        if (i.discount !== "none") body.push(`    if total ${op} ${X} {`, "        total -= total / 10;", "    }");
        if (i.coupon !== "none") body.push('    if coupon == Some("SAVE5") {', floor ? `        total = (total - ${S}).max(0);` : `        total -= ${S};`, "    }");
        body.push("    total");
      }
      body.push("}");
      break;
  }
  return [...head, ...body];
}
