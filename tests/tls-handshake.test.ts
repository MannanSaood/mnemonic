import { test } from "node:test";
import assert from "node:assert/strict";
import { connect, goals, init, step, verifyPeer, noBreaks, type Action, type State } from "../src/playgrounds/tls-handshake/model.ts";

const run = (s: State, ...actions: Action[]) => actions.reduce(step, s);
const last = (s: State) => s.runs[s.runs.length - 1];
const go: Action = { type: "connect" };

test("tls: a full TLS 1.3 handshake sends the request after 2 RTTs; first byte at 240 ms on 80 ms (the predict answer)", () => {
  const r = last(run(init(), go));
  assert.equal(r.outcome, "ok");
  assert.equal(r.requestRtts, 2);
  assert.equal(r.firstByteMs, 240);
  assert.deepEqual(Object.values(r.checks), ["pass", "pass", "pass", "pass"]);
});

test("tls: TLS 1.2 needs one more round trip and sends the certificate in plain text", () => {
  const r12 = last(run(init(), { type: "version", version: "1.2" }, go));
  assert.equal(r12.requestRtts, 3);
  assert.equal(r12.firstByteMs, 320);
  assert.ok(r12.plaintext.some((m) => m.includes("Certificate")));
  const r13 = last(run(init(), go));
  assert.ok(!r13.plaintext.some((m) => m.includes("Certificate")), "1.3 encrypts the certificate");
  assert.ok(r13.plaintext.some((m) => m.includes("SNI api.example.com")), "SNI stays visible");
});

test("tls: resumption needs a ticket; 0-RTT sends the request in the first flight", () => {
  let s = run(init(), { type: "resume", resume: "early" }, go);
  assert.equal(last(s).resumed, false, "no ticket yet, so a full handshake");
  s = run(s, go);
  assert.equal(last(s).resumed, true);
  assert.equal(last(s).early, true);
  assert.equal(last(s).requestRtts, 1);
  assert.equal(last(s).checks.chain, "not-run", "no certificate on resumption");
  assert.equal(goals(s.runs).oneRtt, true);
});

test("tls: each break fails its own check and the request is never sent", () => {
  const cases: [Action, string][] = [
    [{ type: "break", key: "expired" }, "dates"],
    [{ type: "break", key: "wrongName" }, "name"],
    [{ type: "break", key: "noIntermediate" }, "chain"],
    [{ type: "break", key: "untrustedRoot" }, "chain"],
  ];
  let all = init();
  for (const [brk, check] of cases) {
    const s = run(init(), brk, go);
    assert.equal(last(s).failed, check);
    assert.equal(last(s).outcome, "refused");
    assert.equal(last(s).requestRtts, null);
    assert.ok(!last(s).msgs.some((m) => m.label.startsWith("POST")));
    all = run(all, brk, go, brk);
  }
  all = run(all, { type: "attacker", attacker: "copied" }, go);
  assert.equal(goals(all.runs).allChecks, true);
});

test("tls: a copied certificate fails only the signature check, even with verification off", () => {
  const on = last(run(init(), { type: "attacker", attacker: "copied" }, go));
  assert.equal(on.failed, "signature");
  assert.equal(on.checks.chain, "pass");
  assert.equal(on.checks.name, "pass");
  const off = verifyPeer(false, "copied", noBreaks());
  assert.equal(off.failed, "signature");
});

test("tls: the attacker's own certificate fails the chain; with verification off it reads the request", () => {
  let s = run(init(), { type: "attacker", attacker: "own" }, go);
  assert.equal(last(s).failed, "chain");
  assert.equal(last(s).chainWhy, "self");
  s = run(s, { type: "verify" }, go);
  assert.equal(last(s).outcome, "mitm");
  assert.ok(last(s).msgs.some((m) => m.label.startsWith("POST")));
  assert.equal(goals(s.runs).leaked, true);
});

test("tls: an attacker cannot accept a ticket, so resumption falls back to a checked full handshake", () => {
  const s = run(init(), go, { type: "resume", resume: "ticket" }, { type: "attacker", attacker: "own" }, go);
  assert.equal(last(s).resumed, false);
  assert.equal(last(s).failed, "chain");
});

test("tls: round trips scale with the chosen RTT; reset clears everything", () => {
  const r = connect({ ...init(), rtt: 200 });
  assert.equal(r.firstByteMs, 600);
  assert.deepEqual(run(init(), go, { type: "reset" }), init());
});
