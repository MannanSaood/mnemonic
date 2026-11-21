import { test } from "node:test";
import assert from "node:assert/strict";
import { drain, init, play as play0, step, tally, type Action, type State } from "../src/playgrounds/isolation-levels-and-anomalies/model.ts";

const play = (s: State, sched: string) => drain(play0(s, sched));
const run = (s: State, ...actions: Action[]) => actions.reduce(step, s);
const at = (workload: "stock" | "oncall" | "report", level: "rc" | "rr" | "ser", mode: "plain" | "forUpdate" | "atomic" = "plain") =>
  run(init(), { type: "workload", workload }, { type: "level", level }, { type: "mode", mode });

test("isolation: the predicted case, read committed loses a sale", () => {
  const s = play(at("stock", "rc"), "121212");
  assert.equal(s.db.stock.value, 8, "T2 wrote 10 - 2 over T1's 7");
  assert.equal(s.outcome?.anomaly, "lost update");
  assert.equal(s.txs[1].status, "committed");
  assert.ok(s.events.some((e) => e.kind === "wait"), "T2's UPDATE waited for T1's row lock");
  assert.ok(s.done.includes("lost"));
});

test("isolation: repeatable read turns the lost update into a 40001 that a retry fixes", () => {
  let s = play(at("stock", "rr"), "121212");
  assert.equal(s.txs[1].status, "aborted");
  assert.match(s.txs[1].error ?? "", /40001 could not serialize access due to concurrent update/);
  assert.equal(s.outcome?.anomaly, null);
  assert.ok(s.done.includes("blocked40001"));
  s = play(run(s, { type: "retry", tx: 1 }), "222");
  assert.equal(s.db.stock.value, 5);
  assert.equal(s.txs[1].attempt, 2);
});

test("isolation: FOR UPDATE and an atomic UPDATE fix the lost update at read committed", () => {
  const fu = play(at("stock", "rc", "forUpdate"), "121212");
  assert.equal(fu.db.stock.value, 5);
  assert.equal(fu.outcome?.anomaly, null);
  assert.ok(fu.done.includes("fixedRC"));
  const atomic = play(at("stock", "rc", "atomic"), "1212");
  assert.equal(atomic.db.stock.value, 5);
});

test("isolation: write skew passes snapshot isolation and is caught by serializable", () => {
  const rr = play(at("oncall", "rr"), "121212");
  assert.equal(rr.outcome?.anomaly, "write skew");
  assert.equal(rr.db.alice.value + rr.db.bob.value, 0);
  assert.ok(rr.done.includes("skewRR"));
  const ser = play(at("oncall", "ser"), "121212");
  assert.equal(ser.outcome?.anomaly, null);
  assert.match(ser.txs[1].error ?? "", /read\/write dependencies/);
  assert.ok(ser.done.includes("ssi"));
  const retried = play(run(ser, { type: "retry", tx: 1 }), "222");
  assert.equal(retried.db.bob.value, 1, "on retry Bob sees Alice is off call and stays");
});

test("isolation: read skew at read committed, a consistent snapshot at repeatable read", () => {
  const rc = play(at("report", "rc"), "12221");
  assert.equal(rc.outcome?.anomaly, "read skew");
  assert.equal(rc.txs[0].vars.a + rc.txs[0].vars.b, 180);
  assert.ok(rc.done.includes("readSkew"));
  const rr = play(at("report", "rr"), "12221");
  assert.equal(rr.outcome?.anomaly, null);
  assert.equal(rr.txs[0].vars.a + rr.txs[0].vars.b, 150);
});

test("isolation: across every interleaving, serializable never lets an anomaly through", () => {
  for (const w of ["stock", "oncall", "report"] as const) {
    const t = tally(w, "ser", "plain");
    assert.equal(t.anomalies, 0, w);
    assert.equal(t.correct + t.aborted, t.histories);
  }
  const rc = tally("stock", "rc", "plain");
  assert.equal(rc.correct, 2, "only the two serial orders are right at read committed");
  assert.equal(tally("oncall", "rr", "plain").anomalies, 18);
  assert.equal(tally("report", "rr", "plain").anomalies, 0);
});

test("isolation: a waiting transaction cannot step, and changing a setting starts a new history", () => {
  let s = play0(at("stock", "rc"), "1212");
  assert.equal(s.txs[1].status, "waiting");
  const same = step(s, { type: "step", tx: 1 });
  assert.equal(same, s);
  s = run(s, { type: "level", level: "ser" });
  assert.equal(s.events.length, 0);
  assert.equal(s.level, "ser");
});
