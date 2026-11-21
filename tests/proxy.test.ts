import { test } from "node:test";
import assert from "node:assert/strict";
import { goals, init, simulate, step, type Action, type State } from "../src/playgrounds/proxy/model.ts";

const run = (s: State, ...actions: Action[]) => actions.reduce(step, s);
const last = (s: State) => s.runs[s.runs.length - 1];

test("proxy: with no proxy every request is a paid vendor call", () => {
  const r = last(run(init(), { type: "run" }));
  assert.equal(r.vendorCalls, 190);
  assert.equal(r.vendorByCaller.checkout, 120);
  assert.equal(r.checkoutAvgMs, 300);
  assert.equal(r.unauthorized, 40, "the export script gets every answer it asks for");
});

test("proxy: a 60 s cache cuts checkout to 6 vendor calls (the predict answer)", () => {
  const s = run(init(), { type: "add", layer: "cache" }, { type: "run" });
  const r = last(s);
  assert.equal(r.vendorByCaller.checkout, 6);
  assert.ok(r.vendorCalls < 20);
  assert.ok(r.checkoutAvgMs < 20);
  assert.equal(goals(s.runs).cheap, true);
});

test("proxy: the cache serves stale rates after the vendor moves, more with a longer TTL", () => {
  const b = { rateMove: true, outage: false };
  const none = simulate([], 60, b), short = simulate(["cache"], 10, b), mid = simulate(["cache"], 60, b), long = simulate(["cache"], 600, b);
  assert.equal(none.stale, 0);
  assert.ok(short.stale < mid.stale && mid.stale < long.stale);
  assert.ok(short.vendorCalls > mid.vendorCalls);
});

test("proxy: a 60 s cache rides out the vendor outage; no proxy does not", () => {
  const b = { rateMove: false, outage: true };
  assert.ok(simulate([], 60, b).errors > 0);
  assert.equal(simulate(["cache"], 60, b).errors, 0);
  assert.ok(simulate(["cache"], 10, b).errors > 0, "a short TTL expires during the outage");
  const s = run(init(), { type: "break", kind: "outage" }, { type: "add", layer: "cache" }, { type: "run" });
  assert.equal(goals(s.runs).outage, true);
});

test("proxy: guard in front blocks the export script; cache in front of the guard leaks", () => {
  let s = run(init(), { type: "add", layer: "cache" }, { type: "add", layer: "guard" });
  assert.deepEqual(s.chain, ["guard", "cache"]);
  s = run(s, { type: "run" });
  assert.equal(last(s).unauthorized, 0);
  assert.equal(last(s).denied, 40);
  s = run(s, { type: "move", layer: "guard", dir: 1 }, { type: "run" });
  assert.deepEqual(last(s).chain, ["cache", "guard"]);
  assert.ok(last(s).unauthorized > 0, "cache hits answer before the guard can refuse");
  const g = goals(s.runs);
  assert.equal(g.blocked, true);
  assert.equal(g.leak, true);
});

test("proxy: the lazy proxy moves the connect cost from startup to the first call", () => {
  assert.equal(simulate([], 60, { rateMove: false, outage: false }).startupMs, 800);
  const r = simulate(["lazy"], 60, { rateMove: false, outage: false });
  assert.equal(r.startupMs, 0);
  assert.ok(r.traces.some((t) => t.path.includes("connect")));
});

test("proxy: reset clears runs and chain", () => {
  const s = run(init(), { type: "add", layer: "guard" }, { type: "run" }, { type: "reset" });
  assert.deepEqual(s, init());
});
