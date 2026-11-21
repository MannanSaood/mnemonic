import { test } from "node:test";
import assert from "node:assert/strict";
import {
  SERVICE_MS, erlangC, init, revealed, simulate, step, theoryWait,
  type Action, type Config, type State,
} from "../src/playgrounds/queues-and-utilisation/model.ts";

const run = (s: State, ...actions: Action[]) => actions.reduce(step, s);
const cfg = (c: Partial<Config>): Config => ({ rate: 50, servers: 1, variability: "random", bounded: false, burst: false, ...c });

test("queues: theory matches the textbook formulas", () => {
  assert.ok(Math.abs(theoryWait(50, 1, "random")! - 10) < 1e-9, "M/M/1 at 50%: S × ρ/(1−ρ) = 10 ms");
  assert.ok(Math.abs(theoryWait(90, 1, "random")! - 90) < 1e-9);
  assert.ok(Math.abs(theoryWait(90, 1, "constant")! - 45) < 1e-9, "M/D/1 waits half as long");
  assert.equal(theoryWait(100, 1, "random"), null);
  assert.ok(Math.abs(erlangC(1, 0.7) - 0.7) < 1e-12, "with one worker, P(wait) = ρ");
});

test("queues: the simulation agrees with theory on the flat part of the curve", () => {
  for (const rate of [10, 50, 80]) {
    const r = simulate(cfg({ rate }));
    assert.ok(Math.abs(r.meanWait - r.theoryWait!) / r.theoryWait! < 0.15, `rate ${rate}`);
    assert.ok(Math.abs(r.util - r.rho) < 0.02);
  }
});

test("queues: from 50% to 90% busy the wait grows about ninefold", () => {
  const half = simulate(cfg({ rate: 50 })), ninety = simulate(cfg({ rate: 90 }));
  assert.ok(ninety.meanWait / half.meanWait > 7);
  assert.ok(ninety.meanWait > 8 * SERVICE_MS);
});

test("queues: Little's law, L = λW, holds in the measurements", () => {
  for (const c of [cfg({ rate: 50 }), cfg({ rate: 90 }), cfg({ rate: 150, servers: 2 })]) {
    const r = simulate(c);
    assert.ok(Math.abs(r.inSystem - r.littleLW) / r.littleLW < 0.02);
  }
});

test("queues: past 100% the queue never drains; a bound trades waiting for rejections", () => {
  const over = simulate(cfg({ rate: 105 })), bounded = simulate(cfg({ rate: 105, bounded: true }));
  assert.equal(over.theoryWait, null);
  assert.ok(over.endQueue > 500);
  assert.ok(over.meanWait > 1000);
  assert.ok(bounded.maxQueue <= 50);
  assert.ok(bounded.rejected > 500);
  assert.ok(bounded.meanWait < over.meanWait / 5);
});

test("queues: adding a second worker at 95 jobs/s cuts the wait by far more than half", () => {
  const one = simulate(cfg({ rate: 95 })), two = simulate(cfg({ rate: 95, servers: 2 }));
  assert.ok(one.meanWait / two.meanWait > 10);
});

test("queues: a burst builds a long queue at low average load", () => {
  const r = simulate(cfg({ rate: 20, burst: true }));
  assert.ok(r.util < 0.3);
  assert.ok(r.maxQueue >= 30);
});

test("queues: the prediction is revealed at 90% and all challenges can be completed", () => {
  let s = run(init(), { type: "guess", value: "90" });
  assert.equal(revealed(s), false);
  s = run(s, { type: "rate", value: 90 });
  assert.equal(revealed(s), true);
  s = run(s, { type: "variability", value: "constant" }, { type: "variability", value: "random" },
    { type: "rate", value: 95 }, { type: "servers", value: 2 }, { type: "servers", value: 1 },
    { type: "rate", value: 20 }, { type: "burst", on: true });
  assert.deepEqual(s.done, ["cliff", "teller", "burst", "smooth"]);
  assert.equal(run(s, { type: "reset" }).done.length, 0);
});
