import { test } from "node:test";
import assert from "node:assert/strict";
import {
  MAX_KEYS, TOMB, avgHit, avgMiss, build, hashOf, home, init, keyFor, load, lookup, lostKeys, maxPile, step, theory,
  type Action, type State,
} from "../src/playgrounds/hash-tables/model.ts";

const run = (s: State, ...actions: Action[]) => actions.reduce(step, s);
const ins = (n: number): Action => ({ type: "insert", n });

test("hash tables: every inserted key is findable, with both strategies and every hash", () => {
  for (const strategy of ["probe", "chain"] as const)
    for (const hash of ["full", "tenant", "sum"] as const)
      for (const source of ["mixed", "big", "crafted"] as const) {
        const s = run(init(), { type: "strategy", value: strategy }, { type: "hash", value: hash }, { type: "source", value: source }, ins(100));
        assert.equal(s.keys.length, 100);
        assert.equal(new Set(s.keys).size, 100, "keys never repeat");
        assert.equal(lostKeys(s).length, 0, `${strategy}/${hash}/${source}`);
      }
});

test("hash tables: the table doubles when it passes the load cap and rehashes every key", () => {
  const s = run(init(), ins(6));
  assert.equal(s.table.m, 8);
  const t = run(s, ins(1));
  assert.equal(t.table.m, 16, "7 keys in 8 slots is over 0.75");
  assert.deepEqual(t.last?.resized, { from: 8, to: 16, moved: 6 });
  const big = run(init(), ins(MAX_KEYS));
  assert.ok(load(big) <= 0.75);
  assert.ok(big.moved / big.inserts < 2, "amortised: under two moves per insert");
  assert.ok(big.worst > 100, "but one insert pays for a whole resize");
});

test("hash tables: the predict answer, a tenant-only hash puts a big tenant's keys in one bucket", () => {
  const s = run(init(), { type: "hash", value: "tenant" }, { type: "source", value: "big" }, ins(32));
  assert.equal(maxPile(s), 32);
  assert.ok(load(s) <= 0.5);
  assert.ok(Math.abs(avgHit(s) - 16.5) < 0.01, `hit ${avgHit(s)}`);
  const good = run(s, { type: "hash", value: "full" });
  assert.ok(avgHit(good) < 2, "the same keys hashed on the whole key");
});

test("hash tables: crafted keys collide under the sum hash and spread under the seeded hash", () => {
  const keys = Array.from({ length: 50 }, (_, i) => keyFor("crafted", i));
  assert.equal(new Set(keys.map((k) => hashOf("sum", k))).size, 1);
  assert.ok(new Set(keys.map((k) => hashOf("full", k))).size === 50);
  const bad = run(init(), { type: "source", value: "crafted" }, { type: "hash", value: "sum" }, ins(40));
  const good = run(init(), { type: "source", value: "crafted" }, ins(40));
  assert.ok(avgHit(bad) > 10 * avgHit(good));
});

test("hash tables: linear probing degrades steeply near full, chaining does not fall off a cliff", () => {
  let s = run(init(), { type: "maxLoad", value: "0.9" }, ins(117));
  assert.equal(s.table.m, 256);
  const relaxed = avgMiss(s);
  s = run(s, { type: "maxLoad", value: "none" }, ins(113));
  assert.equal(s.table.m, 256, "no resize");
  assert.ok(load(s) >= 0.89);
  assert.ok(avgMiss(s) > 10 * relaxed, `miss ${avgMiss(s)} vs ${relaxed}`);
  assert.ok(s.done.slowMiss);
  const ch = run(s, { type: "strategy", value: "chain" });
  assert.ok(avgMiss(ch) < 2 && avgHit(ch) < 2);
});

test("hash tables: theory matches the textbook formulas", () => {
  assert.equal(theory("probe", 0.5).miss, 2.5);
  assert.equal(theory("probe", 0.5).hit, 1.5);
  assert.ok(Math.abs(theory("probe", 0.9).miss - 50.5) < 1e-9);
  assert.equal(theory("chain", 2).miss, 2);
});

test("hash tables: emptying a slot on delete strands keys further along the run; a tombstone does not", () => {
  // Find a key whose lookup passes through another key's slot, then delete that one.
  const setup = (tomb: boolean) => {
    let s = run(init(), { type: "tombstones", value: tomb }, ins(6));
    const victim = s.keys.find((k) => lookup(s.table, k).path.length > 1)!;
    const blocker = s.table.slots[home(s.table, victim)] as string;
    s = run(s, { type: "delete", key: blocker });
    return { s, victim };
  };
  const broken = setup(false);
  assert.ok(lostKeys(broken.s).includes(broken.victim));
  assert.ok(broken.s.done.lost);
  const fine = setup(true);
  assert.equal(lostKeys(fine.s).length, 0);
  assert.ok(fine.s.table.slots.includes(TOMB));
});

test("hash tables: a full table with resizing off refuses the insert", () => {
  const s = run(init(), ins(6), { type: "maxLoad", value: "none" }, ins(5));
  assert.equal(s.keys.length, 8);
  assert.equal(s.last?.kind, "full");
});

test("hash tables: build places keys at their home slot or later in the run", () => {
  const keys = Array.from({ length: 20 }, (_, i) => keyFor("mixed", i));
  const t = build("probe", "full", 32, keys);
  for (const k of keys) assert.equal(lookup(t, k).path[0], home(t, k));
});

test("hash tables: the prediction locks once made, and all challenges can be completed", () => {
  const p = run(init(), { type: "predict", value: "16" }, { type: "predict", value: "1" });
  assert.equal(p.prediction, "16");
  let s = run(init(), { type: "hash", value: "tenant" }, { type: "source", value: "big" }, ins(20)); // pileup, slow miss
  s = run(s, { type: "hash", value: "full" }, { type: "source", value: "mixed" }, { type: "strategy", value: "chain" }, ins(40)); // fast
  assert.ok(s.done.pileup && s.done.slowMiss && s.done.fast, JSON.stringify(s.done));
  s = run(s, { type: "strategy", value: "probe" }, { type: "tombstones", value: false });
  for (const k of [...s.keys]) {
    if (s.done.lost) break;
    s = run(s, { type: "delete", key: k });
  }
  assert.ok(s.done.lost);
});
