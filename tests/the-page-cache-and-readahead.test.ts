import { test } from "node:test";
import assert from "node:assert/strict";
import {
  LOOKUP_PAGES, MAX_RA, PAGES, comparison, goals, init, initWindow, nextWindow, step,
  type Action, type State,
} from "../src/playgrounds/the-page-cache-and-readahead/model.ts";

const run = (s: State, ...actions: Action[]) => actions.reduce(step, s);
const last = (s: State) => s.runs[s.runs.length - 1];

test("page cache: window sizes follow mm/readahead.c (4, 8, 16, then the 32-page max)", () => {
  assert.equal(initWindow(1), 4);
  assert.deepEqual([nextWindow(4), nextWindow(8), nextWindow(16), nextWindow(32)], [8, 16, 32, MAX_RA]);
});

test("page cache: a cold sequential pass needs only a handful of I/Os", () => {
  const s = run(init(), { type: "sequential" });
  assert.equal(last(s).c.reads, PAGES);
  assert.equal(last(s).c.diskPages, PAGES);
  assert.ok(last(s).c.ios <= 12, `got ${last(s).c.ios}`);
});

test("page cache: cold random lookups pay one I/O per distinct page", () => {
  const s = run(init(), { type: "lookups" });
  const distinct = new Set(LOOKUP_PAGES).size;
  assert.ok(Math.abs(last(s).c.ios - distinct) <= 3, `${last(s).c.ios} vs ${distinct}`);
});

test("page cache: warming first beats cold lookups on both devices (the predict answer)", () => {
  for (const device of ["nvme", "network"] as const) {
    const s = run(init(), { type: "device", device }, { type: "lookups" }, { type: "drop" }, { type: "sequential" }, { type: "lookups" });
    const c = comparison(s)!;
    assert.ok(c, "comparison found");
    assert.equal(c.warmLookups.c.ios, 0, "every lookup is a hit after the warm-up");
    assert.ok(c.warmup.c.tookUs + c.warmLookups.c.tookUs < c.coldLookups.c.tookUs / 3);
    assert.equal(goals(s).warmBeatsCold, true);
  }
});

test("page cache: with readahead off the in-order pass is slower than the random lookups", () => {
  const s = run(init(), { type: "lookups" }, { type: "drop" }, { type: "readahead", on: false }, { type: "sequential" });
  assert.equal(last(s).c.ios, PAGES);
  assert.ok(last(s).c.tookUs > s.runs[0].c.tookUs);
  assert.equal(goals(s).noReadahead, true);
});

test("page cache: O_DIRECT makes a fully cached file as slow as a cold one", () => {
  let s = run(init(), { type: "sequential" }, { type: "direct", on: true }, { type: "sequential" });
  assert.equal(last(s).c.ios, PAGES);
  assert.equal(last(s).c.hits, 0);
  assert.equal(goals(s).directWarm, true);
  s = run(s, { type: "direct", on: false }, { type: "sequential" });
  assert.equal(last(s).c.ios, 0);
});

test("page cache: clicking reads one page; the marker starts async readahead", () => {
  let s = run(init(), { type: "read", page: 0 });
  assert.equal(s.log[0].kind, "miss");
  assert.deepEqual(s.log[0].io, [0, 3]);
  assert.equal(s.pages[1].mark, true);
  s = run(s, { type: "next" });
  assert.deepEqual(s.log[0].async, [4, 11]);
  s = run(s, { type: "read", page: 200 });
  assert.deepEqual(s.log[0].io, [200, 200], "a random miss reads only that page");
  assert.deepEqual(run(s, { type: "reset" }), init());
});
