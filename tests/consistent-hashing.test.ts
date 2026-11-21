import { test } from "node:test";
import assert from "node:assert/strict";
import {
  KEYS, KEY_HASH, busiest, init, lookup, modOwners, ringOwners, ringPoints, step,
  type Action, type Server, type State,
} from "../src/playgrounds/consistent-hashing/model.ts";

const run = (s: State, ...actions: Action[]) => actions.reduce(step, s);
const four: Server[] = ["cache-a", "cache-b", "cache-c", "cache-d"];

test("consistent hashing: lookup takes the first point clockwise and wraps past the top", () => {
  const pts = [{ pos: 100, server: "cache-a" as Server }, { pos: 200, server: "cache-b" as Server }];
  assert.equal(lookup(pts, 50), "cache-a");
  assert.equal(lookup(pts, 100), "cache-a");
  assert.equal(lookup(pts, 150), "cache-b");
  assert.equal(lookup(pts, 250), "cache-a", "past the last point it wraps to the first");
});

test("consistent hashing: the ring has one point per server per virtual node, sorted", () => {
  const pts = ringPoints(four, 50);
  assert.equal(pts.length, 200);
  for (let i = 1; i < pts.length; i++) assert.ok(pts[i - 1].pos <= pts[i].pos);
});

test("consistent hashing: going from 4 to 5 servers moves about 80% of keys with hash % N (the predict answer)", () => {
  const s = run(init(), { type: "add" });
  const c = s.changes[0];
  assert.ok(c.modCount > 750 && c.modCount < 850, `moved ${c.modCount}`);
  // Exactly: a key stays only when h % 4 === h % 5.
  const stay = KEY_HASH.filter((h) => h % 4 === h % 5).length;
  assert.equal(c.modCount, KEYS - stay);
});

test("consistent hashing: on the ring a join moves keys only to the new server, never between old ones", () => {
  for (const v of [1, 10, 200] as const) {
    const s = run(init(), { type: "vnodes", vnodes: v }, { type: "add" });
    const c = s.changes[0];
    assert.deepEqual(Object.keys(c.ringTo), c.ringCount ? ["cache-e"] : []);
    assert.ok(c.ringCount < c.modCount);
  }
});

test("consistent hashing: with many virtual nodes a join moves close to the 1/N minimum", () => {
  const c = run(init(), { type: "vnodes", vnodes: 200 }, { type: "add" }).changes[0];
  assert.ok(Math.abs(c.ringCount - KEYS / 5) < 40, `moved ${c.ringCount}`);
});

test("consistent hashing: one point per server gives uneven arcs; 200 points even them out", () => {
  assert.ok(busiest(four, ringOwners(four, 1)) > 1.5);
  assert.ok(busiest(four, ringOwners(four, 200)) < 1.1);
});

test("consistent hashing: with one point a dead server's keys all go to one neighbour; with many they spread", () => {
  const one = run(init(), { type: "remove", server: "cache-d" }).changes[0];
  assert.equal(Object.keys(one.ringTo).length, 1);
  const many = run(init(), { type: "vnodes", vnodes: 200 }, { type: "remove", server: "cache-d" }).changes[0];
  assert.equal(Object.keys(many.ringTo).length, 3, "every survivor takes a share");
  assert.ok(many.modCount > 600, "modulo reshuffles most keys on a removal too");
});

test("consistent hashing: modulo owners follow the config list order", () => {
  const o = modOwners(four);
  KEY_HASH.forEach((h, i) => assert.equal(o[i], four[h % 4]));
});

test("consistent hashing: the fleet never drops below two servers and never exceeds eight", () => {
  let s = run(init(), { type: "remove", server: "cache-a" }, { type: "remove", server: "cache-b" }, { type: "remove", server: "cache-c" });
  assert.equal(s.servers.length, 2);
  for (let i = 0; i < 10; i++) s = step(s, { type: "add" });
  assert.equal(s.servers.length, 8);
});

test("consistent hashing: the prediction locks once made", () => {
  const s = run(init(), { type: "predict", value: "800" }, { type: "predict", value: "200" });
  assert.equal(s.prediction, "800");
});

test("consistent hashing: the guided challenges can all be completed", () => {
  const s = run(init(),
    { type: "add" },                                   // hot (cache-e lands on a tiny arc) and small
    { type: "vnodes", vnodes: 200 },                   // even
    { type: "remove", server: "cache-a" });            // spread
  assert.deepEqual(s.done, { small: true, hot: true, spread: true, even: true });
});
