import { test } from "node:test";
import assert from "node:assert/strict";
import { broken, changeCost, classes, init, render, revealed, step, type Action, type State } from "../src/playgrounds/bridge/model.ts";

const run = (s: State, ...actions: Action[]) => actions.reduce(step, s);

test("bridge: one class per pair grows as N x M, the bridge as N + M", () => {
  assert.deepEqual(classes(3, 3), { inheritance: 9, bridge: 6 });
  const s = run(init(), { type: "guess", guess: "16" }, { type: "addChannel", channel: "sms" }, { type: "addKind", kind: "sla" });
  assert.ok(revealed(s));
  assert.deepEqual(s.history.at(-1), { label: "+ SLA breach", inheritance: 16, bridge: 8 });
  const t = run(s, { type: "addChannel", channel: "teams" }, { type: "addKind", kind: "deploy" });
  assert.deepEqual(t.history.at(-1)!.inheritance, 25);
  assert.deepEqual(t.history.at(-1)!.bridge, 10);
});

test("bridge: a change to one kind touches a whole row of pair classes, but one Alert class", () => {
  const s = run(init(), { type: "addChannel", channel: "sms" }, { type: "ship", change: "runbook" });
  assert.deepEqual(s.perChange.runbook, { inheritance: 4, bridge: 1 });
  for (const c of s.channels) assert.match(render("incident", c, s).lines.join(" "), /Runbook/);
});

test("bridge: a change to one channel touches a whole column of pair classes, but one Channel class", () => {
  const s = run(init(), { type: "addKind", kind: "sla" }, { type: "ship", change: "blocks" });
  assert.deepEqual(s.perChange.blocks, { inheritance: 4, bridge: 1 });
  assert.match(render("sla", "slack", s).lines[0], /\[header\]/);
});

test("bridge: the digest does not fit an SMS until Channel gets a MaxLength primitive", () => {
  let s = run(init(), { type: "addChannel", channel: "sms" });
  assert.deepEqual(broken(s).map((b) => `${b.kind}/${b.channel}`), ["digest/sms"]);
  const cost = changeCost("maxlen", s);
  assert.deepEqual(cost, { inheritance: 1, bridge: 5 }, "a new primitive on the joint costs every channel; the pair design only fixes DigestSMS");
  s = run(s, { type: "ship", change: "maxlen" });
  assert.equal(broken(s).length, 0);
  assert.ok(render("digest", "sms", s).lines[0].length <= 160);
});

test("bridge: MaxLength cannot ship before there is an SMS channel; shipping twice is a no-op", () => {
  const s = run(init(), { type: "ship", change: "maxlen" });
  assert.deepEqual(s.shipped, []);
  const t = run(init(), { type: "ship", change: "runbook" }, { type: "ship", change: "runbook" });
  assert.deepEqual(t.edits, { inheritance: 3, bridge: 1 });
});
