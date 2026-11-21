import { test } from "node:test";
import assert from "node:assert/strict";
import { FIRST_TOKEN, TTL, init, staleAccepted, staleRejected, step, type Action, type State } from "../src/playgrounds/leader-election-and-fencing/model.ts";

const run = (s: State, ...actions: Action[]) => actions.reduce(step, s);
const adv = (s: State, ms: number) => step(s, { type: "tick", ms });

test("fencing: a healthy leader renews its lease and keeps writing with one token", () => {
  const s = adv(init(), 60_000);
  assert.equal(s.lock.holder, 0);
  assert.equal(s.lock.token, FIRST_TOKEN);
  assert.ok(s.writes.length >= 25);
  assert.ok(s.writes.every((w) => w.by === 0 && w.token === FIRST_TOKEN));
  assert.equal(staleAccepted(s), 0);
  assert.equal(s.overlap, 0);
});

test("fencing: a pause shorter than the lease does no harm", () => {
  let s = adv(init(), 4_000);
  s = run(s, { type: "setPause", ms: 5_000 }, { type: "pause", who: 0 });
  s = adv(s, 20_000);
  assert.equal(s.lock.holder, 0);
  assert.equal(s.lock.token, FIRST_TOKEN);
  assert.equal(staleAccepted(s), 0);
  assert.ok(s.done.includes("short"));
});

test("fencing: the predicted case, a paused leader wakes and overwrites newer data without fencing", () => {
  let s = adv(init(), 4_000);
  s = run(s, { type: "pause", who: 0 });
  assert.equal(s.pauseLen, 15_000);
  s = adv(s, 14_000);
  assert.equal(s.lock.holder, 1, "B took the lease while A was frozen");
  assert.equal(s.lock.token, FIRST_TOKEN + 1);
  assert.ok(s.writes.some((w) => w.by === 1 && w.token === FIRST_TOKEN + 1), "B has written");
  assert.ok(s.overlap > 0, "both believe they lead");
  s = adv(s, 2_000);
  const stale = s.writes.find((w) => w.by === 0 && w.token === FIRST_TOKEN && w.at > 15_000)!;
  assert.ok(stale, "A's stale write arrives after it wakes");
  assert.ok(stale.leaseSeenUntil < stale.at, "its lease check passed before the pause, for a lease that had expired by the write");
  assert.equal(staleAccepted(s), 1, "plain storage accepts the stale write over B's");
  assert.equal(staleRejected(s), 1, "fenced storage rejects it");
  assert.equal(s.fenced.highest, FIRST_TOKEN + 1);
  assert.equal(s.workers[0].role, "standby", "A steps down at its next renew");
  assert.ok(s.done.includes("stale"));
});

test("fencing: after the stale write, the fenced store holds only the new leader's data", () => {
  let s = adv(init(), 4_000);
  s = adv(run(s, { type: "pause", who: 0 }), 20_000);
  const fencedLast = s.writes.find((w) => w.id === s.fenced.value)!;
  assert.equal(fencedLast.by, 1);
  const rejected = s.fenced.log.filter((r) => !r.accepted).map((r) => s.writes.find((w) => w.id === r.write)!);
  assert.ok(rejected.every((w) => w.token < s.fenced.highest));
});

test("fencing: pausing the new leader hands the lease back with a higher token", () => {
  let s = adv(init(), 4_000);
  s = adv(run(s, { type: "pause", who: 0 }), 20_000);
  s = adv(run(s, { type: "pause", who: 1 }), 20_000);
  assert.equal(s.lock.holder, 0);
  assert.equal(s.lock.token, FIRST_TOKEN + 2);
  assert.ok(s.done.includes("second"));
  assert.equal(staleRejected(s), 2, "both zombie writes rejected");
  // At most one holder per token, and tokens only grow.
  const tokens = s.holds.map((h) => h.token);
  assert.deepEqual(tokens, [...tokens].sort((a, b) => a - b));
  assert.equal(new Set(tokens).size, tokens.length);
});

test("fencing: only a running leader can be paused, and reset restores the start", () => {
  const s = init();
  assert.equal(step(s, { type: "pause", who: 1 }), s);
  const p = step(s, { type: "pause", who: 0 });
  assert.equal(step(p, { type: "pause", who: 0 }), p);
  assert.equal(run(adv(p, TTL), { type: "reset" }).now, 0);
});
