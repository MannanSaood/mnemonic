import { test } from "node:test";
import assert from "node:assert/strict";
import { GOALS, RECOMMENDED, START, allGoalsMet, changed, init, simulate, stackCount, step, type Action, type LayerId, type State } from "../src/playgrounds/decorator/model.ts";

const run = (s: State, ...actions: Action[]) => actions.reduce(step, s);

test("decorator: the starting order (Cache outside Auth) leaks Ana's orders to a request with no token", () => {
  const r = simulate(START);
  const anon = r.outcomes[2];
  assert.equal(anon.status, 200);
  assert.equal(anon.leak, true);
  assert.equal(anon.servedOrdersOf, "ana");
  assert.equal(anon.cells[0], "hit");
  assert.equal(r.metrics.leaks, 1);
});

test("decorator: Logging innermost keeps only the requests that reach the handler", () => {
  const r = simulate(START);
  assert.equal(r.metrics.logged, 2);
  assert.ok(r.outcomes.filter((o) => o.status === 401).every((o) => !o.logged), "401s never reach Logging");
});

test("decorator: predicting, then sending, records the baseline", () => {
  const s = run(init(), { type: "guess", guess: "leak" }, { type: "send" });
  assert.equal(s.guess, "leak");
  assert.ok(s.run && s.baseline);
  assert.equal(s.baseline!.metrics.leaks, 1);
  // the guess is locked once traffic has run
  assert.equal(run(s, { type: "guess", guess: "401" }).guess, "leak");
});

test("decorator: RateLimit inside Auth never answers 429; outside it, it protects the auth service", () => {
  const inside = simulate(["logging", "auth", "ratelimit", "cache"]);
  const outside = simulate(["logging", "ratelimit", "auth", "cache"]);
  assert.equal(inside.metrics.throttled, 0);
  assert.equal(outside.metrics.throttled, 2);
  assert.ok(outside.metrics.authChecks < inside.metrics.authChecks);
});

test("decorator: the recommended order meets every goal, and it is the only full order that does", () => {
  assert.ok(allGoalsMet(simulate(RECOMMENDED).metrics));
  const perms = (xs: LayerId[]): LayerId[][] => xs.length <= 1 ? [xs] : xs.flatMap((x) => perms(xs.filter((y) => y !== x)).map((p) => [x, ...p]));
  const winners = perms([...RECOMMENDED]).filter((p) => allGoalsMet(simulate(p).metrics));
  assert.deepEqual(winners, [RECOMMENDED]);
});

test("decorator: removing Auth serves order data to everyone without a token", () => {
  const r = simulate(["logging", "cache"]);
  assert.equal(r.metrics.leaks, 6);
});

test("decorator: the guided path from the starting stack to the recommended one", () => {
  let s = run(init(), { type: "send" });
  s = run(s, { type: "move", layer: "logging", dir: -1 }, { type: "move", layer: "logging", dir: -1 });
  assert.deepEqual(s.stack, ["logging", "cache", "auth"]);
  assert.equal(s.run!.metrics.logged, 9, "Logging outermost logs everything");
  assert.ok(changed(s.prev, s.run).length === 0, "moving Logging changes no response, only the log");
  s = run(s, { type: "move", layer: "cache", dir: 1 });
  assert.equal(s.run!.metrics.leaks, 0);
  assert.ok(changed(s.prev, s.run).includes(3), "the anonymous request now gets a 401");
  s = run(s, { type: "add", layer: "ratelimit" }, { type: "move", layer: "ratelimit", dir: 1 });
  assert.deepEqual(s.stack, RECOMMENDED);
  assert.ok(allGoalsMet(s.run!.metrics));
  assert.equal(s.changes, 5);
  assert.equal(GOALS.length, 4);
});

test("decorator: removing Auth from the recommended stack leaks to every tokenless request RateLimit lets through", () => {
  let s = run(init(), { type: "send" });
  s = { ...s, stack: [...RECOMMENDED] };
  s = run(s, { type: "remove", layer: "auth" });
  assert.equal(s.run!.metrics.leaks, 4);
  assert.equal(s.run!.metrics.throttled, 2);
});

test("decorator: four wrappers make 64 different stacks", () => {
  assert.equal(stackCount(4), 64);
});
