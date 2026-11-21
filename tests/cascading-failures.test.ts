import { test } from "node:test";
import assert from "node:assert/strict";
import { challengeDone, init, simulate, step, type Action, type Config, type State } from "../src/playgrounds/cascading-failures/model.ts";

const run = (s: State, ...actions: Action[]) => actions.reduce(step, s);
const cfg = (c: Partial<Config>): Config => ({ retries: "every", deadlines: false, shedding: false, slow: 10, ...c });

test("cascade: with no slowdown every user is served and the database sees one call per checkout", () => {
  const { summary } = simulate(cfg({ slow: 0 }));
  assert.equal(summary.browseFail, 0);
  assert.equal(summary.checkoutFail, 0);
  assert.equal(summary.peakDb, 50);
  assert.deepEqual(summary.saturatedAt, [null, null, null, null]);
});

test("cascade: a slow database fills the pools from the bottom up and browse pages fail", () => {
  const { summary } = simulate(cfg({}));
  const [fe, chk, inv, db] = summary.saturatedAt;
  assert.ok(db !== null && inv !== null && chk !== null && fe !== null);
  assert.ok(db <= inv && inv <= chk && chk <= fe, `order ${summary.saturatedAt}`);
  assert.ok(summary.browseFail > 500, `browse errors ${summary.browseFail}`);
});

test("cascade: retries at every layer multiply database load, and the outage outlives the slowdown", () => {
  const { summary } = simulate(cfg({ slow: 5 }));
  assert.ok(summary.amplification > 2.5, `amplification ${summary.amplification}`);
  assert.equal(summary.recovery, null, "a 5 s slowdown is still an outage at 40 s");
  assert.ok(summary.dbWasted > 1000, "the database works for callers who left");
});

test("cascade: deadlines alone stop the wasted work and the spread to browse", () => {
  const { summary } = simulate(cfg({ deadlines: true }));
  assert.equal(summary.dbWasted, 0);
  assert.equal(summary.browseFail, 0);
  assert.equal(summary.recovery, 0);
});

test("cascade: shedding alone protects the frontend, but rejections are retried 3 x 3 x 3 times", () => {
  const { summary } = simulate(cfg({ shedding: true }));
  assert.equal(summary.browseFail, 0);
  assert.equal(summary.saturatedAt[0], null);
  assert.ok(summary.amplification >= 20, `amplification ${summary.amplification}`);
});

test("cascade: retrying at one layer only keeps browse up but recovery drags on through wasted work", () => {
  const { summary } = simulate(cfg({ retries: "one" }));
  assert.equal(summary.browseFail, 0);
  assert.ok(summary.recovery === null || summary.recovery >= 10, `recovery ${summary.recovery}`);
});

test("cascade: all three defences contain a 20-second slowdown", () => {
  const { summary } = simulate(cfg({ retries: "budget", deadlines: true, shedding: true, slow: 20 }));
  assert.equal(summary.browseFail, 0);
  assert.ok(summary.recovery !== null && summary.recovery <= 2);
  assert.ok(summary.amplification < 2);
  assert.ok(summary.checkoutOk > 1500, "most checkouts still complete");
});

test("cascade: runs are kept, newest first, at most five, and the scrubber stays in range", () => {
  let s = init();
  for (let i = 0; i < 6; i++) s = run(s, { type: "run" });
  assert.equal(s.runs.length, 5);
  assert.equal(s.runs[0].id, 6);
  s = run(s, { type: "at", t: 99 });
  assert.equal(s.at, 39);
  s = run(s, { type: "at", t: -3 });
  assert.equal(s.at, 0);
});

test("cascade: the guided challenges can all be completed", () => {
  const s = run(init(),
    { type: "run" },
    { type: "set", patch: { shedding: true } }, { type: "run" },
    { type: "preset", id: "kit" }, { type: "run" });
  assert.ok(challengeDone(s, "spread"));
  assert.ok(challengeDone(s, "outlast"));
  assert.ok(challengeDone(s, "amplify"));
  assert.ok(challengeDone(s, "contain"));
  assert.equal(s.config.slow, 10, "a preset keeps the slowdown");
});
