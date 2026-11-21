import { test } from "node:test";
import assert from "node:assert/strict";
import {
  bitsOf, drift, driftCents, equal, evaluate, exactDecimal, fields, gap, init, recovered, shortest, step, valueOf,
  type Action, type State,
} from "../src/playgrounds/floating-point/model.ts";

const run = (s: State, ...actions: Action[]) => actions.reduce(step, s);
const add = (n: number): Action => ({ type: "add", n });

test("floating point: the predict answer, ten adds of 0.10 in float64 miss 1.00 by a hair", () => {
  const s = run(init(), add(10));
  assert.equal(s.totals.f64, 0.9999999999999999);
  assert.equal(s.totals.cents, 100n);
  assert.equal(equal(s, "f64"), false);
  assert.ok(Math.abs(drift(s, "f64")) < 1e-10 && drift(s, "f64") < 0, "short by a tiny amount, far under a cent");
  assert.ok(s.done.notEqual);
});

test("floating point: the bits of 0.1 store a long binary fraction, and 0.1 + 0.2 is not 0.3", () => {
  assert.equal(exactDecimal(0.1), "0.1000000000000000055511151231257827021181583404541015625");
  assert.equal(exactDecimal(Math.fround(0.1)), "0.100000001490116119384765625");
  const r = evaluate("0.1 + 0.2", 64);
  assert.ok("value" in r && r.value === 0.30000000000000004);
  assert.notEqual(0.1 + 0.2, 0.3);
  assert.equal(exactDecimal(0.5), "0.5", "sums of powers of two are exact");
});

test("floating point: fields follow IEEE 754 binary32 and binary64", () => {
  const one = fields(bitsOf(1, 32), 32);
  assert.deepEqual([one.sign, one.exp, one.frac, one.kind], [0, 127, 0n, "normal"]);
  const neg = fields(bitsOf(-2, 64), 64);
  assert.deepEqual([neg.sign, neg.exp, neg.unbiased], [1, 1024, 1]);
  assert.equal(fields(bitsOf(NaN, 64), 64).kind, "nan");
  assert.equal(fields(bitsOf(Infinity, 32), 32).kind, "infinity");
  assert.equal(fields(1n, 64).kind, "subnormal");
  assert.equal(valueOf(1n, 64), 5e-324);
  assert.equal(valueOf(bitsOf(0.1, 64), 64), 0.1, "bits round-trip");
});

test("floating point: flipping a bit changes the stored value, and the exponent bit doubles it", () => {
  let s = run(init(), { type: "width", value: 32 }, { type: "enter", text: "1.5" });
  assert.equal(valueOf(s.insp.bits, 32), 1.5);
  s = run(s, { type: "toggleBit", i: 23 }); // lowest exponent bit: 127 -> 126
  assert.equal(valueOf(s.insp.bits, 32), 0.75);
  s = run(s, { type: "toggleBit", i: 31 });
  assert.equal(valueOf(s.insp.bits, 32), -0.75);
});

test("floating point: float32 runs out of integers at 2^24 + 1", () => {
  const r = evaluate("2^24 + 1", 32);
  assert.ok("value" in r && r.value === 16777216);
  const r64 = evaluate("2^24 + 1", 64);
  assert.ok("value" in r64 && r64.value === 16777217);
  assert.equal(gap(16777216, 32), 2);
});

test("floating point: a float32 balance of $300,000 ignores a one-cent deposit entirely", () => {
  const s = run(init(), { type: "start", value: "k300" }, { type: "amount", value: "c1" }, add(1000));
  assert.equal(gap(300000, 32), 0.03125, "neighbours are 1/32 of a dollar apart");
  assert.equal(s.totals.f32, 300000, "a thousand cents vanished");
  assert.equal(drift(s, "f32"), -1000);
  assert.equal(recovered(s, "f32"), 0, "subtracting the totals recovers a zero deposit");
  assert.ok(s.lastIgnored32 && s.done.ignored);
  assert.ok(Math.abs(drift(s, "f64")) < 0.01, "float64 still has digits to spare at this size");
});

test("floating point: at $20 trillion even float64 drifts by dollars, and cancellation corrupts a recovered deposit", () => {
  const s = run(init(), { type: "start", value: "t20" }, { type: "amount", value: "c1" }, add(1000));
  assert.equal(gap(2e13, 64), 0.00390625);
  assert.ok(drift(s, "f64") > 100, `drift ${drift(s, "f64")} cents`);
  assert.equal(recovered(s, "f64"), 0.01171875, "a cent comes back as three gaps");
  assert.ok(s.done.cent64);
  assert.equal(s.totals.cents, 2_000_000_000_001_000n, "integer cents are exact");
});

test("floating point: summing a million small amounts drifts, more in float32 than float64", () => {
  const s = run(init(), add(1_000_000));
  assert.equal(s.totals.cents, 10_000_000n);
  assert.ok(Math.abs(drift(s, "f64")) > 0 && Math.abs(drift(s, "f64")) < 1);
  assert.ok(Math.abs(drift(s, "f32")) > 10_000, `float32 is off by ${drift(s, "f32")} cents`);
});

test("floating point: drift is computed exactly from the bits", () => {
  assert.equal(driftCents(0.5, 50n), 0);
  assert.equal(driftCents(0.75, 50n), 25);
  assert.ok(driftCents(0.1, 10n) > 0, "the double nearest 0.1 is slightly above it");
  assert.equal(shortest(Math.fround(0.1), 32), "0.1");
  assert.equal(shortest(Math.fround(0.1), 64), "0.10000000149011612");
});

test("floating point: inspecting a wide-gap total completes the challenge; reset clears everything", () => {
  let s = run(init(), { type: "start", value: "k300" }, add(1), { type: "inspectTotal", col: "f32" });
  assert.equal(s.insp.width, 32);
  assert.ok(s.done.wideGap);
  s = run(s, { type: "reset" });
  assert.deepEqual(s, init());
});

test("floating point: bad input is reported, not stored", () => {
  const s = run(init(), { type: "enter", text: "ten cents" });
  assert.ok(s.insp.error);
  assert.equal(valueOf(s.insp.bits, 64), 0.1);
});
