import { test as t } from "node:test";
import assert from "node:assert/strict";
import {
  PROBES, bestK, buildBits, curve, falseNegatives, fill, formula, init, measured, positions, probeUrl, step, test, urlFor,
  type Action, type State,
} from "../src/playgrounds/bloom-filters-and-sketches/model.ts";

const run = (s: State, ...actions: Action[]) => actions.reduce(step, s);
const crawl = (pages: number): Action => ({ type: "crawl", pages });

t("bloom: positions are k distinct-enough indices inside the array", () => {
  for (let i = 0; i < 200; i++) {
    const p = positions(urlFor(i), 256, 8);
    assert.equal(p.length, 8);
    for (const x of p) assert.ok(Number.isInteger(x) && x >= 0 && x < 256);
  }
});

t("bloom: no false negatives without deletes, whatever m and k", () => {
  for (const m of [128, 256, 512, 1024] as const)
    for (const k of [1, 3, 8]) {
      const s = run(init(), { type: "m", m }, { type: "k", k }, crawl(10));
      assert.ok(s.crawled.length > 60);
      assert.equal(falseNegatives(s).length, 0, `m ${m} k ${k}`);
      assert.equal(s.recrawls, 0);
      for (const u of s.crawled) assert.ok(test(s.bits, u, k));
    }
});

t("bloom: measured false positives track the formula", () => {
  for (const [m, k, pages] of [[256, 3, 4], [512, 4, 8], [1024, 7, 10]] as const) {
    const s = run(init(), { type: "m", m }, { type: "k", k }, crawl(pages));
    const n = s.crawled.length;
    const got = measured(s.bits, k), want = formula(n, m, k);
    assert.ok(Math.abs(got - want) < Math.max(0.015, want * 0.4), `m ${m} k ${k} n ${n}: ${got} vs ${want}`);
    // And the classic shortcut: the rate is about fill^k.
    assert.ok(Math.abs(got - fill(s.bits) ** k) < 0.02);
  }
});

t("bloom: the predict answer, k = 1 is worst and the best k is in the middle", () => {
  for (const pages of [3, 4]) {
    const c = curve(run(init(), crawl(pages)).crawled, 256);
    const best = c.reduce((a, b) => (b.measured < a.measured ? b : a));
    assert.ok(best.k >= 3 && best.k <= 6, `best k ${best.k} after ${pages} pages`);
  }
  const s = run(init(), crawl(3));
  assert.ok(s.crawled.length >= 32);
  const c = curve(s.crawled, 256);
  const best = c.reduce((a, b) => (b.measured < a.measured ? b : a));
  assert.ok(c[0].measured > 2 * best.measured, "one hash is far worse");
  assert.ok(c[7].measured > best.measured, "eight hashes overfill the array");
  assert.equal(bestK(32, 256), 6);
  const r = run(s, { type: "k", k: 5 }, { type: "k", k: 8 });
  assert.equal(r.kTried.length, 3, "the predict is revealed after three k values");
});

t("bloom: about 10 bits per URL with the best k gives about 1%", () => {
  const s = run(init(), { type: "m", m: 1024 }, { type: "k", k: 7 }, crawl(11));
  const n = s.crawled.length;
  assert.ok(n >= 103 && 1024 / n <= 10, `n ${n}`);
  assert.ok(measured(s.bits, 7) < 0.02);
  assert.ok(Math.abs(formula(1000, 9585, 7) - 0.01) < 0.001, "9.6 bits per item is the 1% point");
  assert.ok(s.done.tight);
});

t("bloom: a no skips the database; only maybes cost a lookup", () => {
  const s = run(init(), { type: "m", m: 1024 }, crawl(5));
  assert.equal(s.links, 100);
  assert.equal(s.skipped + s.storeLookups, s.links);
  assert.ok(s.skipped > 40, "new URLs never touch the database");
  assert.ok(s.falsePositives <= 2);
});

t("bloom: an overfull filter says maybe to almost everything", () => {
  const s = run(init(), { type: "m", m: 128 }, crawl(10));
  assert.ok(fill(s.bits) > 0.9);
  assert.ok(measured(s.bits, s.k) > 0.5);
  assert.ok(s.done.flood);
});

t("bloom: clearing bits to delete creates false negatives and recrawls", () => {
  let s = run(init(), crawl(4));
  for (const u of [...s.crawled].reverse()) {
    if (falseNegatives(s).length) break;
    s = run(s, { type: "remove", url: u });
  }
  assert.ok(falseNegatives(s).length > 0);
  assert.ok(s.done.falseNeg);
  // The stranded URLs are still in the crawl database; links to them now get crawled again.
  s = run(s, crawl(10));
  assert.ok(s.recrawls > 0);
  // Rebuilding from the database (change k and back) repairs the filter.
  const fixed = run(s, { type: "k", k: 4 }, { type: "k", k: 3 });
  assert.equal(falseNegatives(fixed).length, 0);
});

t("bloom: the probe set never overlaps crawled URLs, and a probe is a certain no or a maybe", () => {
  const s = run(init(), crawl(3), { type: "probe" });
  assert.ok(s.last && (s.last.verdict === "probeNo" || s.last.verdict === "probeFp"));
  const set = new Set(s.crawled);
  for (let i = 0; i < PROBES; i++) assert.ok(!set.has(probeUrl(i)));
  assert.deepEqual(buildBits([], 64, 3), Array(64).fill(0));
});

t("bloom: the best-k challenge and the prediction lock", () => {
  let s = run(init(), { type: "m", m: 512 }, crawl(7));
  assert.ok(s.crawled.length >= 64);
  const c = curve(s.crawled, 512);
  const best = c.reduce((a, b) => (b.measured < a.measured ? b : a));
  s = run(s, { type: "k", k: best.k === 1 ? 2 : 1 }, { type: "k", k: best.k });
  assert.ok(s.done.bestK);
  const p = run(init(), { type: "predict", value: "mid" }, { type: "predict", value: "1" });
  assert.equal(p.prediction, "mid");
});
