// Purpose. After this, the reader can answer: "Why does a suite that checks every internal step go
// red when I refactor and still miss real bugs, while a suite that checks only what a caller can
// observe does the opposite?"
//
// The model: one shipping service, ShippingService.Ship(order), tested by two suites written by
// the same team on the same day.
// - Suite A tests through internals: it mocks the weight calculator and the stock reserver, spies
//   on the order's setters, and calls a private helper directly.
// - Suite B tests through observable behaviour: it calls Ship on a real order with real stock in
//   memory, reads the outcome through public getters, and checks the one call that leaves the
//   system (the courier booking) with a spy.
// The code map lists what each test touches. The reader applies five refactorings that change no
// outcome, one at a time, and counts the tests that go red (false alarms). Then the reader plants
// four real bugs and counts the suites that stay green (misses). The rules are explicit: a
// refactoring breaks every test that names the piece it reshapes; a bug is seen only by a test that
// checks the outcome it breaks without a double standing in for the faulty piece.
//
// Plain state + a pure step function, so it can be tested without a browser.

export type BlockId = "ship" | "weights" | "reserver" | "setters" | "warehouse" | "state" | "stock" | "courier";
export type RefactorId = "r1" | "r2" | "r3" | "r4" | "r5";
export type BugId = "x1" | "x2" | "x3" | "x4";
export type ChangeId = RefactorId | BugId;
export type SuiteId = "A" | "B";
export type TestId = "a1" | "a2" | "a3" | "a4" | "a5" | "a6" | "a7" | "b1" | "b2" | "b3" | "b4" | "b5";

export interface Block { id: BlockId; name: string; observable: boolean; what: string; refactor?: RefactorId; bug?: BugId }
export const BLOCKS: Block[] = [
  { id: "ship", name: "Ship(order)", observable: true, what: "The one operation a caller uses to ship an order.", refactor: "r5", bug: "x3" },
  { id: "weights", name: "WeightCalculator", observable: false, what: "Adds up the line weights into kilograms.", refactor: "r1", bug: "x1" },
  { id: "reserver", name: "InventoryReserver", observable: false, what: "Takes stock for each line.", refactor: "r3", bug: "x2" },
  { id: "setters", name: "SetStatus · SetShippedAt", observable: false, what: "How Ship changes the order today.", refactor: "r4" },
  { id: "warehouse", name: "pickWarehouse(country)", observable: false, what: "A private helper: which warehouse ships to which country.", refactor: "r2", bug: "x4" },
  { id: "state", name: "order.Status() · ShippedAt()", observable: true, what: "What the order looks like afterwards, through public getters." },
  { id: "stock", name: "stock.Available(sku)", observable: true, what: "How much is left to sell." },
  { id: "courier", name: "courier.Book(booking)", observable: true, what: "The call that leaves the system: a real truck is booked." },
];

export const CHANGES: Record<ChangeId, { kind: "refactor" | "bug"; block: BlockId; title: string; what: string }> = {
  r1: { kind: "refactor", block: "weights", title: "Fold the weight into a Parcel value", what: "WeightCalculator is deleted; Parcel.WeightKg() computes the same number." },
  r2: { kind: "refactor", block: "warehouse", title: "Rename pickWarehouse to nearestWarehouse", what: "Same table, clearer name." },
  r3: { kind: "refactor", block: "reserver", title: "Reserve all lines in one batch", what: "One ReserveAll(lines) call instead of Reserve per line. Same stock afterwards." },
  r4: { kind: "refactor", block: "setters", title: "Replace the setters with MarkShipped(at)", what: "Status and date change together, so they can never disagree." },
  r5: { kind: "refactor", block: "ship", title: "Move the cancelled check into Order.CanShip()", what: "The guard moves into the order. Same result for a cancelled order." },
  x1: { kind: "bug", block: "weights", title: "Grams where kilograms are expected", what: "Ship now passes weights in grams; the calculator still expects kilograms. The courier is told 2400 kg." },
  x2: { kind: "bug", block: "reserver", title: "Short stock no longer stops the order", what: "The reserver now returns a Shortage value instead of failing. Ship still waits for a failure, so it ships anyway." },
  x3: { kind: "bug", block: "ship", title: "Cancelled orders ship", what: "A merge dropped the cancelled-order guard. Cancelled orders get a courier booked." },
  x4: { kind: "bug", block: "warehouse", title: "Iceland ships from Oslo", what: "A typo maps IS to the Oslo warehouse instead of Reykjavik." },
};
export const REFACTORS: RefactorId[] = ["r1", "r2", "r3", "r4", "r5"];
export const BUGS: BugId[] = ["x1", "x2", "x3", "x4"];

export interface TestCase {
  id: TestId;
  suite: SuiteId;
  name: string;
  /** The assertion, as the test reads. */
  code: string;
  /** Blocks the test names: internals it mocks, spies on or calls, and outcomes it reads. */
  touches: BlockId[];
  /** Why it fails under a refactoring (only refactorings that reshape a block it names). */
  breaksOn: Partial<Record<RefactorId, string>>;
  /** Why it fails under a bug (only bugs whose broken outcome it checks with the real code). */
  catches: Partial<Record<BugId, string>>;
  /** Why it does not see a bug that touches a block it names. */
  blind?: Partial<Record<BugId, string>>;
  optional?: boolean;
}

export const TESTS: TestCase[] = [
  {
    id: "a1", suite: "A", name: "asks WeightCalculator for the weight", code: "expect weights.Compute(lines) called once",
    touches: ["weights"], breaksOn: { r1: "WeightCalculator no longer exists, so the expected call never happens." }, catches: {},
    blind: { x1: "The call still happens with the same lines. Whether the units agree is not something a call check can see." },
  },
  {
    id: "a2", suite: "A", name: "reserves each line", code: "expect reserver.Reserve(sku, qty) once per line",
    touches: ["reserver"], breaksOn: { r3: "Ship now calls ReserveAll once; the per-line expectations are not met." }, catches: {},
  },
  {
    id: "a3", suite: "A", name: "sets status, then shipped-at", code: "order calls == [SetStatus(shipped), SetShippedAt(10:00)]",
    touches: ["setters"], breaksOn: { r4: "The order now receives MarkShipped(10:00). The spy saw a different list of calls." }, catches: {},
  },
  {
    id: "a4", suite: "A", name: "books the courier with the weight", code: "courier booked {AMS → customer, weights mock's 2.4 kg}",
    touches: ["weights", "courier"], breaksOn: { r1: "The test builds the service with a WeightCalculator mock, and the service no longer takes one." }, catches: {},
    blind: { x1: "The weight comes from the mock, which always says 2.4 kg. The real conversion never runs in this test." },
  },
  {
    id: "a5", suite: "A", name: "pickWarehouse knows the warehouses", code: "pickWarehouse(\"NL\") == AMS; pickWarehouse(\"IS\") == REY",
    touches: ["warehouse"], breaksOn: { r2: "The private function was renamed. The test calls a name that no longer exists." },
    catches: { x4: "pickWarehouse(\"IS\") returned OSL, want REY." },
  },
  {
    id: "a6", suite: "A", name: "cancelled order: no courier booked", code: "courier.Book never called; Ship returns ErrCancelled",
    touches: ["ship", "courier"], breaksOn: {}, catches: { x3: "courier.Book was called for a cancelled order." },
  },
  {
    id: "a7", suite: "A", name: "short stock: Ship fails", code: "reserver mock fails with OutOfStock; Ship returns it",
    touches: ["reserver"], breaksOn: { r3: "The mock was told to fail on Reserve. Ship now calls ReserveAll, which the mock does not know." }, catches: {},
    blind: { x2: "The mock still fails the old way, so Ship still stops. The real reserver changed its contract, and no test here runs it." },
  },
  {
    id: "b1", suite: "B", name: "ships an order: the courier booking", code: "courier booked once: AMS → customer, 2.4 kg",
    touches: ["ship", "courier"], breaksOn: {}, catches: { x1: "The courier was booked for 2400 kg, want 2.4 kg." },
  },
  {
    id: "b2", suite: "B", name: "ships an order: order and stock", code: "order shipped at 10:00; MUG-1 stock 5 → 3",
    touches: ["ship", "state", "stock"], breaksOn: {}, catches: {},
  },
  {
    id: "b3", suite: "B", name: "cancelled order is not shipped", code: "Ship returns ErrCancelled; no booking; stock unchanged",
    touches: ["ship", "courier", "stock"], breaksOn: {}, catches: { x3: "A booking was made and stock went down for a cancelled order." },
  },
  {
    id: "b4", suite: "B", name: "short stock: nothing ships", code: "Ship returns OutOfStock; order still paid; no booking",
    touches: ["ship", "state", "courier"], breaksOn: {}, catches: { x2: "The order was marked shipped and a courier booked with only 1 mug in stock." },
  },
  {
    id: "b5", suite: "B", name: "an Iceland order ships from Reykjavik", code: "courier booked: REY → customer", optional: true,
    touches: ["ship", "courier"], breaksOn: {}, catches: { x4: "The courier was booked from OSL, want REY." },
  },
];

export interface TestResult { test: TestCase; red: boolean; reason: string }

export function activeTests(st: Pick<State, "iceland">): TestCase[] {
  return TESTS.filter((t) => !t.optional || st.iceland);
}

/** Run every test against the code with one change applied (or none). */
export function runAll(change: ChangeId | null, st: Pick<State, "iceland">): TestResult[] {
  return activeTests(st).map((t) => {
    if (!change) return { test: t, red: false, reason: "Passes on today's code." };
    const c = CHANGES[change];
    if (c.kind === "refactor") {
      const why = t.breaksOn[change as RefactorId];
      return why ? { test: t, red: true, reason: why } : { test: t, red: false, reason: "Still passes: it does not name anything this refactoring reshaped." };
    }
    const why = t.catches[change as BugId];
    if (why) return { test: t, red: true, reason: why };
    const blind = t.blind?.[change as BugId];
    return { test: t, red: false, reason: blind ?? "Still passes: it does not check the outcome this bug breaks." };
  });
}

export interface SuiteOutcome { red: boolean; failing: number }
export function outcome(results: TestResult[], suite: SuiteId): SuiteOutcome {
  const f = results.filter((r) => r.test.suite === suite && r.red).length;
  return { red: f > 0, failing: f };
}

// ---------------------------------------------------------------- state

export type Predict = "none" | "some" | "most";
export const PREDICT_ANSWER: Predict = "most";

export interface State {
  /** The change currently applied to the code (one at a time), or null for today's code. */
  active: ChangeId | null;
  /** Every change the reader has applied at least once. */
  tried: ChangeId[];
  /** The reader added the Iceland test to suite B. */
  iceland: boolean;
  predict: Predict | null;
}

export type Action =
  | { type: "apply"; change: ChangeId }
  | { type: "revert" }
  | { type: "iceland"; on: boolean }
  | { type: "predict"; value: Predict }
  | { type: "reset" };

export function init(): State {
  return { active: null, tried: [], iceland: false, predict: null };
}

export function step(st: State, a: Action): State {
  switch (a.type) {
    case "reset": return init();
    case "predict": return { ...st, predict: a.value };
    case "revert": return { ...st, active: null };
    case "iceland": return { ...st, iceland: a.on };
    case "apply":
      return { ...st, active: st.active === a.change ? null : a.change, tried: st.tried.includes(a.change) ? st.tried : [...st.tried, a.change] };
  }
}

export interface Score {
  refactors: number; bugs: number;
  falseAlarms: Record<SuiteId, number>;
  testEdits: Record<SuiteId, number>;
  misses: Record<SuiteId, number>;
}

/** The reader's numbers, over every change tried so far (re-evaluated live, so adding a test counts). */
export function score(st: State): Score {
  const s: Score = { refactors: 0, bugs: 0, falseAlarms: { A: 0, B: 0 }, testEdits: { A: 0, B: 0 }, misses: { A: 0, B: 0 } };
  for (const c of st.tried) {
    const rs = runAll(c, st);
    const kind = CHANGES[c].kind;
    if (kind === "refactor") s.refactors++; else s.bugs++;
    for (const suite of ["A", "B"] as SuiteId[]) {
      const o = outcome(rs, suite);
      if (kind === "refactor") { if (o.red) s.falseAlarms[suite]++; s.testEdits[suite] += o.failing; }
      else if (!o.red) s.misses[suite]++;
    }
  }
  return s;
}

export const predictRevealed = (st: State) => REFACTORS.every((r) => st.tried.includes(r));

export function challenges(st: State) {
  const s = score(st);
  return [
    { id: "refactor", text: "Apply all five refactorings. Count suite A's false alarms.", done: s.refactors === 5 },
    { id: "bugs", text: "Plant all four bugs. Which suite misses which?", done: s.bugs === 4 },
    { id: "iceland", text: "Make suite B catch the Iceland bug without touching any internal.", done: st.iceland && st.tried.includes("x4") },
  ];
}
