import { test } from "node:test";
import assert from "node:assert/strict";
import { BEST_COST, challengeDone, disputeResult, init, step, summary, type Action, type State } from "../src/playgrounds/chain-of-responsibility/model.ts";

const run = (s: State, ...actions: Action[]) => actions.reduce(step, s);

test("chain: the starting chain drops the big dispute and the privacy request off the end", () => {
  const s = run(init(), { type: "sendAll" });
  assert.equal(disputeResult(s)?.outcome, "dropped");
  const lost = s.results.filter((r) => r.outcome !== "handled").map((r) => r.ticket.id);
  assert.deepEqual(lost, [3, 7]);
  assert.ok(challengeDone(s, "drop"));
});

test("chain: a catch-all at the end means nothing is lost", () => {
  const s = run(init(), { type: "add", id: "lead" }, { type: "sendAll" });
  assert.equal(summary(s.results).lost, 0);
  assert.ok(challengeDone(s, "clean"));
});

test("chain: putting an expensive desk first overpays for cheap tickets", () => {
  const s = run(init(), { type: "move", id: "tier2", by: -1 }, { type: "move", id: "tier2", by: -1 }, { type: "sendAll" });
  assert.equal(s.chain[0], "tier2");
  assert.ok(summary(s.results).overpaid >= 10);
  assert.ok(challengeDone(s, "overpay"));
});

test("chain: cheap narrow desks first, a catch-all last, is the cheapest chain that loses nothing", () => {
  const s = run(init(), { type: "add", id: "finance" }, { type: "add", id: "lead" }, { type: "sendAll" });
  const sm = summary(s.results);
  assert.equal(sm.lost, 0);
  assert.equal(sm.cost, BEST_COST);
  assert.ok(challengeDone(s, "best"));
});

test("chain: a desk that forgets to pass on swallows tickets even when a later desk could handle them", () => {
  const s = run(init(), { type: "add", id: "lead" }, { type: "toggleSwallow", id: "bot" }, { type: "sendAll" });
  assert.equal(s.results.find((r) => r.ticket.id === 2)?.outcome, "swallowed");
  assert.ok(summary(s.results).lost > 0);
});

test("chain: changing the chain restarts the run", () => {
  const s = run(init(), { type: "send" }, { type: "send" }, { type: "add", id: "lead" });
  assert.equal(s.cursor, 0);
  assert.equal(s.results.length, 0);
});
