import { test } from "node:test";
import assert from "node:assert/strict";
import {
  CLIENT_ISS, SERVER_ISS, REQ_LEN, init, rowStates, simulate, startStates, step,
  type Action, type Config, type Segment, type Side, type State, type TcpState,
} from "../src/playgrounds/tcp-connection-lifecycle/model.ts";

const run = (s: State, ...actions: Action[]) => actions.reduce(step, s);
const sim = (c: Partial<Config>) => simulate({ mode: "listen", drops: [], abort: false, timeout: "none", ...c });
const segs = (c: Partial<Config>) => sim(c).rows.filter((r): r is Segment => r.kind === "seg");

/** Every state each side passes through, in order, without repeats. */
function path(c: Partial<Config>): Record<Side, TcpState[]> {
  const r = sim(c);
  let st = startStates(c.mode ?? "listen");
  const out: Record<Side, TcpState[]> = { c: [st.c], s: [st.s] };
  for (const row of r.rows) {
    st = rowStates(row);
    for (const side of ["c", "s"] as Side[]) if (out[side].at(-1) !== st[side]) out[side].push(st[side]);
  }
  return out;
}

test("tcp-lifecycle: a clean connection walks both state machines in RFC 9293 order", () => {
  const p = path({});
  assert.deepEqual(p.c, ["CLOSED", "SYN-SENT", "ESTABLISHED", "FIN-WAIT-1", "FIN-WAIT-2", "TIME-WAIT", "CLOSED"]);
  assert.deepEqual(p.s, ["LISTEN", "SYN-RECEIVED", "ESTABLISHED", "CLOSE-WAIT", "LAST-ACK", "CLOSED"]);
  const r = sim({});
  assert.deepEqual(r.outcome, { kind: "ok", connectedAt: 40, responseAt: 80 });
  assert.equal(r.timeWait, "c", "the side that closes first waits in TIME-WAIT");
  assert.equal(r.retransmissions, 0);
});

test("tcp-lifecycle: handshake numbers: SYN-ACK acknowledges ISS+1, data starts at ISS+1", () => {
  const [syn, synack, ack, req] = segs({});
  assert.deepEqual(syn.flags, ["SYN"]);
  assert.equal(syn.seq, CLIENT_ISS);
  assert.deepEqual(synack.flags, ["SYN", "ACK"]);
  assert.equal(synack.seq, SERVER_ISS);
  assert.equal(synack.ack, CLIENT_ISS + 1);
  assert.equal(ack.ack, SERVER_ISS + 1);
  assert.equal(req.seq, CLIENT_ISS + 1);
  assert.equal(req.len, REQ_LEN);
});

test("tcp-lifecycle: a closed port answers with a RST and connect fails in one round trip", () => {
  const r = sim({ mode: "closed" });
  assert.deepEqual(r.outcome, { kind: "refused", at: 40 });
  const rst = segs({ mode: "closed" }).find((x) => x.flags.includes("RST"));
  assert.equal(rst?.ack, CLIENT_ISS + 1);
  const s = run(init(), { type: "mode", mode: "closed" }, { type: "toEnd" });
  assert.ok(s.done.includes("refused"));
});

test("tcp-lifecycle: a firewall that drops SYNs hangs connect for about two minutes", () => {
  const r = sim({ mode: "filtered" });
  assert.deepEqual(r.outcome, { kind: "timeout", at: 127_000, by: "kernel" });
  const times = segs({ mode: "filtered" }).map((x) => x.sendT);
  assert.deepEqual(times, [0, 1000, 3000, 7000, 15000, 31000, 63000], "SYN resent with exponential backoff");
});

test("tcp-lifecycle: a 3 s connect timeout turns the same silence into a fast error", () => {
  const r = sim({ mode: "filtered", timeout: "3s" });
  assert.deepEqual(r.outcome, { kind: "timeout", at: 3000, by: "app" });
  let s = run(init(), { type: "predict", value: "2m" }, { type: "mode", mode: "filtered" }, { type: "toEnd" });
  assert.equal(s.revealed, true);
  assert.ok(!s.done.includes("hangThenFix"));
  s = run(s, { type: "timeout", value: "3s" }, { type: "toEnd" });
  assert.ok(s.done.includes("hangThenFix"));
});

test("tcp-lifecycle: a lost handshake ACK costs nothing when the request carries the same ACK", () => {
  const r = sim({ drops: ["ack3"] });
  assert.equal(r.outcome.kind, "ok");
  assert.equal(r.establishedByData, true);
  assert.equal(r.retransmissions, 0);
  const s = run(init(), { type: "toggleDrop", label: "ack3" }, { type: "toEnd" });
  assert.ok(s.done.includes("lostAck"));
});

test("tcp-lifecycle: a lost SYN costs a full initial RTO of 1 s", () => {
  const r = sim({ drops: ["syn"] });
  assert.equal(r.outcome.kind === "ok" && r.outcome.connectedAt, 1040);
  assert.equal(r.retransmissions, 1);
});

test("tcp-lifecycle: if the last ACK is lost, the server resends its FIN and TIME-WAIT answers it", () => {
  const r = sim({ drops: ["lastack"] });
  assert.equal(r.final.s, "CLOSED");
  assert.equal(r.retransmissions, 1);
  assert.ok(segs({ drops: ["lastack"] }).filter((x) => x.label === "lastack").length === 2);
});

test("tcp-lifecycle: a server crash mid-query resets the client, which fails in read, not connect", () => {
  const r = sim({ abort: true });
  assert.equal(r.outcome.kind, "reset");
  assert.deepEqual(r.final, { c: "CLOSED", s: "CLOSED" });
  assert.equal(r.timeWait, null, "an aborted connection skips TIME-WAIT");
  const s = run(init(), { type: "abort", on: true }, { type: "toEnd" });
  assert.ok(s.done.includes("reset"));
});

test("tcp-lifecycle: every droppable segment is recovered; the connection still completes", () => {
  for (const l of ["syn", "synack", "ack3", "req", "resp", "fin1", "finack", "fin2", "lastack"] as const) {
    const r = sim({ drops: [l] });
    assert.equal(r.outcome.kind, "ok", l);
    assert.deepEqual(r.final, { c: "CLOSED", s: "CLOSED" }, l);
  }
  const all = sim({ drops: ["syn", "synack", "ack3", "req", "resp", "fin1", "finack", "fin2", "lastack"] });
  assert.equal(all.outcome.kind, "ok");
});

test("tcp-lifecycle: stepping reveals rows one at a time; config changes rewind", () => {
  let s = run(init(), { type: "next" }, { type: "next" });
  assert.equal(s.cursor, 2);
  s = run(s, { type: "toggleDrop", label: "syn" });
  assert.equal(s.cursor, 0);
  assert.deepEqual(run(s, { type: "reset" }), init());
});
