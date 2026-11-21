import { test as t } from "node:test";
import assert from "node:assert/strict";
import {
  IMPORT_N, bitsNeeded, expectedPairs, firstCollision, idSet, init, meanFirst, n50, nFor, pCollide, pExact, rng, runImport, step,
  type Action, type State,
} from "../src/playgrounds/birthday-principle-and-collisions/model.ts";

const play = (s: State, ...actions: Action[]) => actions.reduce(step, s);
const close = (a: number, b: number, rel: number) => Math.abs(a / b - 1) <= rel;

t("birthday: the formula matches the exact product and the classic numbers", () => {
  const days = Math.log2(365);
  assert.ok(pExact(23, days) > 0.5 && pExact(22, days) < 0.5, "23 people for better than even odds");
  for (const [n, bits] of [[23, days], [100, 16], [300, 16], [5000, 24]] as const)
    assert.ok(Math.abs(pCollide(n, bits) - pExact(n, bits)) < 0.01, `n ${n} bits ${bits}`);
  assert.ok(close(n50(32), 77_163, 0.001), "32-bit IDs: 50% near 77,000");
  assert.ok(close(n50(6 * Math.log2(62)), 280_600, 0.001), "6 base62 chars: 50% near 280,000");
  assert.ok(close(expectedPairs(2_000_000, 32), 465.7, 0.001));
  assert.ok(pCollide(2_000_000, 32) > 0.999);
  assert.ok(pCollide(2_000_000, 122) < 1e-24 && pCollide(2_000_000, 122) > 0, "tiny but not rounded to zero");
  assert.ok(close(pCollide(nFor(0.1, 40), 40), 0.1, 1e-5), "nFor inverts the formula");
});

t("birthday: bits needed, and two bits per doubling of n", () => {
  assert.equal(bitsNeeded(1e9, 1e-9), 89);
  assert.ok(pCollide(1e9, 89) <= 1e-9 && pCollide(1e9, 88) > 1e-9);
  assert.equal(bitsNeeded(2e9, 1e-9) - bitsNeeded(1e9, 1e-9), 2);
});

t("birthday: simulated first collisions average about 1.25 √d", () => {
  for (const bits of [12, 16, 20]) {
    let seed = 42, sum = 0;
    const runs = 300;
    for (let i = 0; i < runs; i++) { let c: number; [c, seed] = firstCollision(seed, bits); sum += c; }
    assert.ok(close(sum / runs, meanFirst(bits), 0.08), `bits ${bits}: ${sum / runs} vs ${meanFirst(bits)}`);
  }
});

t("birthday: the generator spreads IDs uniformly and the set finds repeats", () => {
  const g = rng(7), counts = Array(16).fill(0);
  for (let i = 0; i < 160_000; i++) counts[g.id(4)]++;
  for (const c of counts) assert.ok(Math.abs(c - 10_000) < 400);
  const s = idSet(10);
  assert.ok(s.add(5) && s.add(2 ** 40) && !s.add(5) && s.size === 2);
});

t("birthday: importing 2 million files under 32-bit names overwrites hundreds; insert-if-absent loses none", () => {
  const [over] = runImport(1, IMPORT_N, 32, "overwrite");
  assert.ok(over.lost > 350 && over.lost < 600, `lost ${over.lost}`);
  const [safe] = runImport(1, IMPORT_N, 32, "retry");
  assert.equal(safe.lost, 0);
  assert.equal(safe.retries, safe.collisions);
  const [wide] = runImport(1, 200_000, 52, "overwrite");
  assert.equal(wide.lost, 0, "52 bits: 200,000 IDs are far below √d");
});

t("birthday: the guided path and the challenges", () => {
  let s = play(init(), { type: "predict", value: "77k" });
  assert.equal(s.ranSim, false);
  s = play(s, { type: "n", n: 80_000 });
  assert.ok(s.done.under100k);
  s = play(s, { type: "bits", bits: 16 }, { type: "trials" }, { type: "trials" });
  assert.ok(s.ranSim && s.trials.length === 20);
  assert.ok(s.done.agree, `mean ${s.trials.reduce((a, b) => a + b, 0) / 20} vs ${meanFirst(16)}`);
  s = play(s, { type: "bits", bits: 40 }, { type: "trials" });
  assert.equal(s.trials.length, 0, "trials reset with the bits, and stop above 32 bits");
  s = play(s, { type: "preset", id: "hex8" }, { type: "n", n: IMPORT_N }, { type: "import" });
  assert.ok(s.done.import && s.imported!.lost > 0);
  s = play(s, { type: "mode", mode: "retry" }, { type: "import" });
  assert.ok(s.done.safeImport);
  s = play(s, { type: "n", n: 1e9 }, { type: "bits", bits: 89 });
  assert.ok(s.done.billion);
  assert.equal(play(s, { type: "import" }), s, "no simulation past 2 million files");
  assert.equal(play(s, { type: "predict", value: "2b" }).prediction, "77k");
  assert.deepEqual(play(s, { type: "reset" }), init());
});
