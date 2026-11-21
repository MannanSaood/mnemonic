import { test } from "node:test";
import assert from "node:assert/strict";
import { allCorrect, effect, init, quantity, step, tally, validate, type Action, type State } from "../src/playgrounds/builder/model.ts";

const run = (s: State, ...actions: Action[]) => actions.reduce(step, s);
const swap = (i: number, j: number): Action[] => [{ type: "pick", index: i }, { type: "pick", index: j }];

test("builder: the reviewed call runs 8080 replicas and breaks production", () => {
  const s = run(init(), { type: "apply" });
  const a = s.attempts[0];
  assert.equal(a.reached, true);
  assert.equal(a.healthy, false);
  assert.equal(a.effects.find((e) => e.field === "replicas")!.got, "8080");
  assert.ok(a.effects.find((e) => e.field === "memory")!.text.includes("milli"));
  assert.equal(tally(s).brokenRollouts, 1);
});

test("builder: memory 500m is half a byte, cpu 256Mi is hundreds of millions of cores", () => {
  assert.equal(quantity("500m"), 0.5);
  assert.equal(quantity("256Mi"), 268435456);
  assert.equal(effect("cpu", "256Mi").ok, false);
  assert.equal(effect("cpu", "500m").ok, true);
});

test("builder: only same-typed arguments can swap", () => {
  const s = run(init(), ...swap(2, 4)); // replicas (int) with cpu (string)
  assert.equal(s.swaps, 0);
  assert.equal(s.args[2], "8080");
});

test("builder: fixing the two swaps makes the positional call roll out cleanly", () => {
  const s = run(init(), ...swap(2, 3), ...swap(4, 5), { type: "apply" });
  assert.ok(allCorrect(s.args));
  assert.equal(s.attempts[0].healthy, true);
});

test("builder: build() stops the same mistakes before the object exists", () => {
  const s = run(init(), { type: "design", design: "builder" }, { type: "build" });
  assert.equal(s.attempts[0].reached, false);
  assert.equal(validate(init().args).length, 3, "replicas, cpu and memory");
  assert.equal(tally(s).caughtByBuild, 1);
  assert.equal(tally(s).brokenRollouts, 0);
});

test("builder: validation cannot catch a legal but wrong port", () => {
  // With cpu and memory fixed, build() still refuses replicas = 8080.
  const fixedResources = run(init(), { type: "design", design: "builder" }, ...swap(4, 5));
  assert.deepEqual(validate(fixedResources.args), ["replicas 8080 is outside 1..50"]);
  // A wrong but valid port passes build() and still breaks the rollout.
  const portOnly = ["checkout-api", "shop/checkout:2.3", "3", "3", "500m", "256Mi", "/healthz"];
  assert.deepEqual(validate(portOnly), []);
  assert.equal(effect("port", "3").ok, false);
});
