import { test } from "node:test";
import assert from "node:assert/strict";
import { applied, behind, init, screen, step, type Action, type State } from "../src/playgrounds/replication-lag-and-session-guarantees/model.ts";

const run = (s: State, ...actions: Action[]) => actions.reduce(step, s);
const save = (device: "laptop" | "phone" = "laptop"): Action => ({ type: "save", device });
const refresh = (device: "laptop" | "phone" = "laptop"): Action => ({ type: "refresh", device });

test("replication lag: followers apply the write lag seconds later, in log order", () => {
  let s = run(init(), save());
  assert.equal(applied(s, "leader"), 1);
  assert.equal(applied(s, "f1"), 1, "f1 lags 1 s and one second has passed");
  assert.equal(applied(s, "f2"), 0);
  assert.equal(behind(s, "f2"), 1);
  s = run(s, { type: "lag", follower: "f1", seconds: 6 }, save(), { type: "lag", follower: "f1", seconds: 0 }, save());
  // the third write would arrive at once, but f1 cannot apply it before the second
  assert.equal(applied(s, "f1"), 1);
});

test("replication lag: the predicted session, new name then the old name again on any-replica routing", () => {
  const s = run(init(), save(), refresh(), refresh());
  const reads = s.runs.any.reads;
  assert.equal(reads[0].node, "f1");
  assert.equal(reads[0].lsn, 1);
  assert.equal(reads[1].node, "f2");
  assert.equal(reads[1].lsn, 0, "f2 has not applied the save yet");
  assert.ok(reads[1].ryw && reads[1].mono);
  assert.deepEqual(s.done, ["vanish", "backwards"]);
});

test("replication lag: tokens give read-your-writes and monotonic reads on the same traffic", () => {
  const s = run(init(), save(), refresh(), refresh(), refresh(), save(), refresh(), refresh());
  assert.equal(s.runs.token.ryw, 0);
  assert.equal(s.runs.token.mono, 0);
  assert.ok(s.runs.any.ryw > 0);
});

test("replication lag: sticky sessions keep reads monotonic but can still hide your own write", () => {
  const s = run(init(), save("phone"), refresh("phone"), refresh("phone"), refresh("phone"), refresh("phone"));
  assert.equal(s.runs.sticky.mono, 0);
  assert.equal(s.runs.sticky.reads.every((r) => r.node === "f2"), true);
  assert.ok(s.runs.sticky.ryw >= 1, "f2 lags 4 s, so the phone sees the old name");
  assert.ok(s.done.includes("sticky"));
});

test("replication lag: a fixed leader window fails once lag exceeds it", () => {
  let s = run(init(), save(), refresh(), refresh(), refresh(), refresh());
  assert.equal(s.runs.window.ryw, 0, "lag 1 s and 4 s: the 3 s window plus rotation still works here");
  s = run(init(), { type: "lag", follower: "f1", seconds: 7 }, { type: "lag", follower: "f2", seconds: 7 }, save(), refresh(), refresh(), refresh());
  assert.equal(s.runs.window.reads[0].node, "leader");
  assert.equal(s.runs.window.reads[2].ryw, true);
  assert.ok(s.done.includes("window"));
});

test("replication lag: a token in the laptop's cookie does not help the phone, a per-user token does", () => {
  const lag = (f: "f1" | "f2"): Action => ({ type: "lag", follower: f, seconds: 5 });
  const perDevice = run(init(), lag("f1"), lag("f2"), save("laptop"), refresh("phone"));
  assert.equal(perDevice.runs.token.ryw, 1);
  assert.ok(perDevice.done.includes("device"));
  const perUser = run(init(), lag("f1"), lag("f2"), { type: "perUser", on: true }, save("laptop"), refresh("phone"));
  assert.equal(perUser.runs.token.ryw, 0);
  assert.equal(perUser.runs.token.reads[0].node, "leader");
  assert.equal(screen(perUser, "token", "phone").value, perUser.entries[0].value);
});

test("replication lag: waiting long enough makes every rule agree", () => {
  const s = run(init(), save(), { type: "wait", seconds: 10 }, refresh(), refresh());
  for (const p of ["any", "window", "sticky", "token"] as const) assert.equal(s.runs[p].ryw, 0);
  assert.equal(run(s, { type: "reset" }).entries.length, 0);
});
