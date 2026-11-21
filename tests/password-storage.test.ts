import { test } from "node:test";
import assert from "node:assert/strict";
import {
  USERS, attack, crackedShare, duplicates, goals, guessRate, halfAt, init, loginMs, rankForShare, sha256Hex, shareAt, step,
  storedValue, userFallsAt, type Action, type Setup, type State,
} from "../src/playgrounds/password-storage/model.ts";

const run = (s: State, ...actions: Action[]) => actions.reduce(step, s);
const last = (s: State) => s.runs[s.runs.length - 1];
const go: Action = { type: "attack" };
const HOUR = 3600, DAY = 86_400, YEAR = 31_536_000;
const setup = (p: Partial<Setup>): Setup => ({ scheme: "sha256salt", cost: 0, gpus: 1, time: 2, tables: false, ...p });

test("passwords: the SHA-256 in the table is the real one", () => {
  assert.equal(sha256Hex("123456"), "8d969eef6ecad3c29a3a629280e686cf0c3f5d5a86aff3ca12020c923adc6c92");
  assert.equal(sha256Hex(""), "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
});

test("passwords: the population curve and its inverse agree", () => {
  for (const f of [0.1, 0.35, 0.5, 0.7, 0.9]) assert.ok(Math.abs(crackedShare(rankForShare(f)) - f) < 1e-9);
  assert.equal(crackedShare(0.5), 0);
});

test("passwords: plain text hands over every account at once", () => {
  const r = last(run(init(), { type: "scheme", scheme: "plain" }, { type: "time", time: 0 }, go));
  assert.equal(r.share, 1);
  assert.equal(r.fallen.length, USERS.length);
});

test("passwords: salted SHA-256 on one GPU loses half the users in under an hour (the predict answer)", () => {
  const half = halfAt(setup({}));
  assert.ok(half > 60 && half < HOUR, `half at ${half}s`);
  const r = last(run(init(), go));
  assert.ok(r.share > 0.6, "a day cracks well over half");
});

test("passwords: unsalted SHA-256 shows equal passwords as equal hashes; a salt hides them", () => {
  assert.deepEqual(duplicates(setup({ scheme: "sha256" })), [["ana", "dev"]]);
  assert.deepEqual(duplicates(setup({ scheme: "sha256salt" })), []);
  assert.deepEqual(duplicates(setup({ scheme: "bcrypt", cost: 1 })), []);
  const ana = USERS.find((u) => u.name === "ana")!;
  const s = run(init(), { type: "scheme", scheme: "sha256" }, { type: "pick", value: storedValue("sha256", 0, ana) });
  assert.equal(goals(s).duplicates, true);
});

test("passwords: a precomputed table cracks unsalted hashes instantly and does nothing against a salt", () => {
  const s = run(init(), { type: "scheme", scheme: "sha256" }, { type: "tables" }, { type: "time", time: 0 }, go);
  assert.ok(last(s).share >= 0.55);
  assert.equal(halfAt(setup({ scheme: "sha256", tables: true })), 0);
  assert.equal(goals(s).tableInstant, true);
  const salted = setup({ tables: true, time: 0 });
  assert.equal(shareAt(salted, 60), shareAt({ ...salted, tables: false }, 60));
});

test("passwords: a salt multiplies the attacker's work by the number of users", () => {
  const ratio = halfAt(setup({})) / halfAt(setup({ scheme: "sha256" }));
  assert.ok(Math.abs(ratio - 100_000) / 100_000 < 0.01);
});

test("passwords: bcrypt cost 10 is thousands of times slower to attack than salted SHA-256", () => {
  const fast = guessRate("sha256salt", 0), slow = guessRate("bcrypt", 1);
  assert.ok(fast / slow > 1e6);
  assert.ok(halfAt(setup({ scheme: "bcrypt", cost: 1 })) > 50 * YEAR);
  assert.ok(guessRate("bcrypt", 2) * 4 === guessRate("bcrypt", 1), "each cost step halves the rate");
});

test("passwords: a slow hash does not save 123456", () => {
  const s = setup({ scheme: "argon2id", cost: 1 });
  const ana = USERS.find((u) => u.name === "ana")!, fay = USERS.find((u) => u.name === "fay")!;
  assert.ok(userFallsAt(s, ana) < DAY, "the most common password still falls within a day");
  assert.ok(userFallsAt(s, fay) > 1e6 * YEAR, "four random words do not");
});

test("passwords: surviving a year against 1,000 GPUs takes a high cost, and the cost lands on the login server", () => {
  let s = run(init(), { type: "gpus", gpus: 1000 }, { type: "time", time: 5 }, { type: "scheme", scheme: "bcrypt" }, { type: "cost", cost: 2 }, go);
  assert.ok(last(s).share >= 0.5, "bcrypt 12 is not enough against 1,000 GPUs for a year");
  s = run(s, { type: "cost", cost: 3 }, go);
  assert.ok(last(s).share < 0.5);
  assert.equal(goals(s).survivesYear, true);
  assert.ok(last(s).loginMs >= 1000);
  assert.equal(goals(s).tooCostly, true);
  assert.ok(loginMs("bcrypt", 3) === 16 * loginMs("bcrypt", 1));
});

test("passwords: the attack result counts users out of 100,000 and reset clears everything", () => {
  const r = attack(setup({ scheme: "sha256" }), 1);
  assert.equal(r.cracked, Math.round(r.share * 100_000));
  const s = run(init(), go, { type: "reset" });
  assert.equal(s.runs.length, 0);
});
