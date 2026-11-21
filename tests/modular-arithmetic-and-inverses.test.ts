import { test as t } from "node:test";
import assert from "node:assert/strict";
import {
  MODULI, PRIMES, EXPONENTS, bruteForce, euclid, factor, gcd, init, invariantHolds, inverse, key, mod, modPow, naivePow, orbit, powTrace, step,
  type Action, type State,
} from "../src/playgrounds/modular-arithmetic-and-inverses/model.ts";

const play = (s: State, ...actions: Action[]) => actions.reduce(step, s);

t("modular: the orbit of a visits m / gcd(a, m) ticks, and reaches 1 exactly when a has an inverse", () => {
  for (const m of MODULI)
    for (let a = 1; a < m; a++) {
      const o = orbit(a, m);
      assert.equal(o.length, m / gcd(a, m), `a ${a} m ${m}`);
      assert.equal(o.includes(1), gcd(a, m) === 1);
      const inv = inverse(a, m);
      if (gcd(a, m) === 1) {
        assert.equal((a * inv!) % m, 1);
        assert.equal(o.indexOf(1) + 1, inv, "the step count to reach 1 is the inverse");
      } else assert.equal(inv, null);
    }
  assert.deepEqual(orbit(8, 12), [8, 4, 0], "the predict answer: 3 ticks");
});

t("modular: extended Euclid keeps r = s·a (mod m) on every row and ends at the gcd", () => {
  for (const m of MODULI)
    for (let a = 1; a < m; a++) {
      const rows = euclid(a, m);
      for (const r of rows) assert.ok(invariantHolds(r, a, m));
      assert.equal(rows[rows.length - 1].r, 0);
      assert.equal(rows[rows.length - 2].r, gcd(a, m));
    }
  assert.equal(inverse(7, 26), 15);
  assert.equal(inverse(387_420_489, 1_000_000_000), 513_180_409, "the order-number inverse in the lesson");
  assert.equal(mod(-11, 26), 15);
});

t("modular: toy RSA round-trips every message, and d is the inverse of e mod φ", () => {
  const k = key(61, 53, 17);
  assert.deepEqual([k.n, k.phi, k.d], [3233, 3120, 2753]);
  assert.equal(modPow(65, 17, 3233), 2790);
  for (let m = 0; m < k.n; m++) assert.equal(modPow(modPow(m, k.e, k.n), k.d!, k.n), m);
  for (const p of PRIMES) for (const q of PRIMES) for (const e of EXPONENTS) {
    const kk = key(p, q, e);
    if (kk.d === null) assert.ok(p === q || gcd(e, kk.phi) > 1);
    else assert.equal((e * kk.d) % kk.phi, 1);
  }
  assert.equal(key(61, 53, 3).d, null, "3 divides φ = 3120");
  assert.equal(powTrace(65, 17, 3233).length, 5, "17 is 10001 in binary");
});

t("modular: without reducing each step, doubles get the power wrong and decryption breaks", () => {
  assert.notEqual(naivePow(65, 17, 3233), 2790);
  assert.ok(Number.isNaN(naivePow(2790, 2753, 3233)));
  let s = play(init(), { type: "naive" }, { type: "encrypt" }, { type: "decrypt" });
  assert.notEqual(s.decrypted, 65);
  assert.equal(s.done.roundTrip, false);
  s = play(s, { type: "naive" }, { type: "encrypt" }, { type: "decrypt" });
  assert.equal(s.decrypted, 65);
  assert.ok(s.done.roundTrip);
});

t("modular: a toy key falls to brute force and trial division", () => {
  const k = key(61, 53, 17);
  assert.deepEqual(bruteForce(2790, k), { msg: 65, tries: 66 });
  assert.deepEqual(factor(3233), { p: 53, divisions: 52 });
  const s = play(init(), { type: "encrypt" }, { type: "encrypt" }, { type: "attack" });
  assert.equal(s.sent[0].c, s.sent[1].c, "textbook RSA is deterministic");
  assert.equal(s.attack?.msg, 65);
  assert.ok(s.done.crack);
});

t("modular: the guided path and the challenges", () => {
  let s = play(init(), { type: "predict", value: "3" });
  assert.equal(s.sawEight, false);
  s = play(s, { type: "a", a: 8 });
  assert.ok(s.sawEight && s.done.skip);
  s = play(s, { type: "m", m: 26 }, { type: "a", a: 7 }, { type: "euclidAll" });
  assert.ok(s.done.inv7);
  s = play(s, { type: "e", e: 3 });
  assert.ok(s.done.noKey);
  s = play(s, { type: "msg", msg: 99999 });
  assert.equal(s.msg, 3232, "messages are clamped below n");
  assert.equal(play(s, { type: "a", a: 0 }).a, 7, "0 is not a step");
  assert.equal(play(s, { type: "predict", value: "12" }).prediction, "3");
  assert.deepEqual(play(s, { type: "reset" }), init());
});
