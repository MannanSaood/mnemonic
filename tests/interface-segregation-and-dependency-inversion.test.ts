import { test } from "node:test";
import assert from "node:assert/strict";
import {
  init, predictRevealed, ripple, step, totals, type Action, type State,
} from "../src/playgrounds/interface-segregation-and-dependency-inversion/model.ts";

const go = (s: State, ...actions: Action[]) => actions.reduce(step, s);
const FAT_CONCRETE = { isp: false, dip: false }, ROLE_CONCRETE = { isp: true, dip: false };
const FAT_INVERTED = { isp: false, dip: true }, ROLE_INVERTED = { isp: true, dip: true };

test("isp/dip: with one fat interface, BulkBan changes all four services' test fakes (the predicted answer)", () => {
  assert.equal(ripple(FAT_CONCRETE, "bulkBan").fakesEdited.length, 4);
  assert.equal(ripple(FAT_INVERTED, "bulkBan").fakesEdited.length, 4);
});

test("isp: role interfaces cut BulkBan's fake churn to the admin's own fake", () => {
  assert.deepEqual(ripple(ROLE_CONCRETE, "bulkBan").fakesEdited, ["admin"]);
});

test("isp alone does not stop rebuilds: interfaces in package postgres still drag every service along", () => {
  assert.equal(ripple(ROLE_CONCRETE, "bulkBan").bystanders.length, 3);
  assert.equal(ripple(ROLE_INVERTED, "bulkBan").bystanders.length, 0);
});

test("dip: a driver upgrade edits and rebuilds the business code only when postgres owns the interface", () => {
  const before = ripple(FAT_CONCRETE, "pgx");
  assert.deepEqual(before.unasked, ["signup"]);
  assert.equal(before.bystanders.length, 4);
  for (const d of [FAT_INVERTED, ROLE_INVERTED]) {
    const r = ripple(d, "pgx");
    assert.equal(r.bystanders.length, 0);
    assert.equal(r.unasked.length, 0);
  }
});

test("dip: an in-memory store is a new module only; isp: it implements 2 methods instead of 10", () => {
  assert.deepEqual(ripple(ROLE_INVERTED, "memstore").edited, []);
  assert.equal(ripple(ROLE_INVERTED, "memstore").methods, 2);
  assert.equal(ripple(FAT_INVERTED, "memstore").methods, 10);
  assert.deepEqual(ripple(FAT_CONCRETE, "memstore").unasked, ["signup"]);
});

test("isp/dip: testing SignupService needs 10 fake methods and the driver in the worst design, 2 and no driver in the best", () => {
  assert.deepEqual([ripple(FAT_CONCRETE, "test").methods, ripple(FAT_CONCRETE, "test").driverInTest], [10, true]);
  assert.deepEqual([ripple(ROLE_INVERTED, "test").methods, ripple(ROLE_INVERTED, "test").driverInTest], [2, false]);
});

test("isp/dip: only both principles together bring every total to its minimum", () => {
  const best = totals(ROLE_INVERTED);
  assert.deepEqual(best, { bystanders: 0, unasked: 0, fakesEdited: 1, fakeMethods: 2, memMethods: 2, driverInTest: false });
  for (const d of [FAT_CONCRETE, ROLE_CONCRETE, FAT_INVERTED]) {
    const t = totals(d);
    assert.ok(t.bystanders > 0 || t.fakesEdited > 1, "every other design costs something");
  }
});

test("isp/dip: shipping records per design and reveals the prediction only after BulkBan in a fat design", () => {
  let s = go(init(), { type: "predict", value: "1" }, { type: "isp", on: true }, { type: "ship", event: "bulkBan" });
  assert.equal(predictRevealed(s), false);
  s = go(s, { type: "isp", on: false }, { type: "ship", event: "bulkBan" }, { type: "predict", value: "4" });
  assert.equal(predictRevealed(s), true);
  assert.equal(s.predict, "1");
  assert.deepEqual(Object.keys(s.shipped).sort(), ["fat-concrete", "isp-concrete"]);
});
