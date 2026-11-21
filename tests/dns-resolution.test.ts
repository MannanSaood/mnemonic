import { test } from "node:test";
import assert from "node:assert/strict";
import {
  NEW_IP, NS_TIMEOUT_MS, OLD_IP, authLoadPerHour, goals, init, liveCache, staleWindow, step,
  type Action, type State,
} from "../src/playgrounds/dns-resolution/model.ts";

const run = (s: State, ...actions: Action[]) => actions.reduce(step, s);
const api: Action = { type: "resolve", name: "api.example.com" };
const last = (s: State) => s.lookups[0];

test("dns: a cold lookup walks root, .com and example.com", () => {
  const l = last(run(init(), api));
  assert.equal(l.queries, 3);
  assert.deepEqual(l.steps.map((s) => s.server).filter(Boolean), ["root", "com", "excom"]);
  assert.equal(l.answer, OLD_IP);
  assert.ok(l.totalMs > 90);
});

test("dns: the second lookup within the TTL sends no queries (the first predict answer)", () => {
  const s = run(init(), api, { type: "wait", seconds: 10 }, api);
  assert.equal(last(s).queries, 0);
  assert.equal(last(s).totalMs, 2);
  assert.equal(s.counts.root, 1);
  assert.equal(goals(s).warm, true);
});

test("dns: a new name in a known zone costs one query (the second predict answer)", () => {
  const s = run(init(), api, { type: "resolve", name: "www.example.com" });
  assert.equal(last(s).queries, 1);
  assert.equal(last(s).steps.find((x) => x.server)?.server, "excom");
  assert.equal(goals(s).referral, true);
});

test("dns: a CNAME sends the resolver down a second branch of the tree", () => {
  const s = run(init(), api, { type: "resolve", name: "shop.example.com" });
  const servers = last(s).steps.map((x) => x.server).filter(Boolean);
  assert.deepEqual(servers, ["excom", "root", "net", "exnet"]);
  assert.equal(last(s).answer, "198.51.100.30");
});

test("dns: the answer expires after its TTL and the walk resumes at the zone, not the root", () => {
  const s = run(init(), { type: "ttl", ttl: 30 }, api, { type: "wait", seconds: 31 }, api);
  assert.equal(last(s).queries, 1, "the referrals are cached for two days");
  assert.equal(s.counts.root, 1);
});

test("dns: moving a cached record serves stale answers for the rest of the old TTL", () => {
  let s = run(init(), api, { type: "wait", seconds: 60 }, { type: "move" });
  assert.equal(staleWindow(s), 3540);
  s = run(s, { type: "ttl", ttl: 30 }, { type: "wait", seconds: 600 }, api);
  assert.equal(last(s).answer, OLD_IP, "lowering the TTL does not shorten copies already cached");
  assert.equal(last(s).stale, true);
  s = run(s, { type: "wait", seconds: 3000 }, api);
  assert.equal(last(s).answer, NEW_IP);
  assert.equal(goals(s).migrate, false);
});

test("dns: lower the TTL, wait out the old one, then move: under a minute of stale answers", () => {
  const s = run(init(), api, { type: "ttl", ttl: 30 }, { type: "wait", seconds: 3600 }, api, { type: "wait", seconds: 5 }, { type: "move" });
  assert.equal(staleWindow(s), 25);
  assert.equal(goals(s).migrate, true);
});

test("dns: a dead name server costs a timeout on cold lookups only", () => {
  let s = run(init(), api, { type: "ns1" }, api);
  assert.equal(last(s).queries, 0, "cached answers do not touch the name server");
  s = run(s, { type: "flush" }, api);
  assert.ok(last(s).steps.some((x) => x.kind === "timeout"));
  assert.ok(last(s).totalMs > NS_TIMEOUT_MS);
  assert.equal(last(s).answer, OLD_IP);
  assert.equal(goals(s).outage, true);
});

test("dns: flush empties the cache; lower TTLs mean more queries to your servers", () => {
  const s = run(init(), api, { type: "flush" });
  assert.equal(liveCache(s).length, 0);
  assert.ok(authLoadPerHour(30) > authLoadPerHour(3600));
  assert.deepEqual(run(s, { type: "reset" }), init());
});
