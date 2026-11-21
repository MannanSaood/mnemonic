import { test } from "node:test";
import assert from "node:assert/strict";
import { MAJORITY, challengeDone, init, maxTerm, step, usableLeader, type Action, type State } from "../src/playgrounds/raft-leader-election/model.ts";

const run = (s: State, ...actions: Action[]) => actions.reduce(step, s);
const adv = (s: State, ms: number) => { for (let i = 0; i < ms; i += 50) s = step(s, { type: "tick", ms: 50 }); return s; };
const leaders = (s: State) => s.servers.filter((x) => x.alive && x.role === "leader");

test("raft: a healthy leader's heartbeats keep everyone in term 1", () => {
  const s = adv(init(), 3000);
  assert.equal(maxTerm(s), 1);
  assert.equal(leaders(s).length, 1);
  assert.equal(s.elections, 1);
});

test("raft: killing the leader leads to a new leader within a second, with randomised timeouts", () => {
  let s = adv(init(), 500);
  s = adv(run(s, { type: "kill", id: 0 }), 1500);
  const l = usableLeader(s);
  assert.ok(l && l.id !== 0);
  assert.ok(l.term > 1);
  assert.ok(challengeDone(s, "replaced"));
  assert.ok(s.failovers[0] < 1000);
});

test("raft: at most one leader per term, ever", () => {
  let s = adv(init(), 300);
  const seen = new Map<number, number>();
  for (let k = 0; k < 6; k++) {
    const l = usableLeader(s);
    if (l) s = run(s, { type: "kill", id: l.id });
    for (let t = 0; t < 40; t++) {
      s = adv(s, 50);
      for (const x of leaders(s)) {
        const prev = seen.get(x.term);
        assert.ok(prev === undefined || prev === x.id, `two leaders in term ${x.term}`);
        seen.set(x.term, x.id);
      }
    }
    for (const x of s.servers) if (!x.alive) s = run(s, { type: "revive", id: x.id });
  }
});

test("raft: equal timeouts split the vote again and again", () => {
  let s = adv(run(init(), { type: "setMode", mode: "fixed" }), 500);
  s = adv(run(s, { type: "kill", id: 0 }), 3000);
  assert.ok(s.splitVotes >= 5);
  assert.equal(usableLeader(s), null);
  assert.ok(challengeDone(s, "split"));
});

test("raft: the minority side of a partition keeps raising its term and never elects", () => {
  let s = adv(init(), 500);
  s = adv(run(s, { type: "partition", kind: "leader-in-majority" }), 2000);
  const minority = s.servers.filter((x) => x.side === 1);
  assert.equal(minority.length, 2);
  assert.ok(minority.every((x) => x.role !== "leader"));
  assert.ok(Math.max(...minority.map((x) => x.term)) >= 4);
  assert.equal(usableLeader(s)?.id, 0, "the majority keeps its leader");
  assert.ok(challengeDone(s, "minorityClimb"));
});

test("raft: a leader cut off in the minority keeps leading until it sees a higher term", () => {
  let s = adv(init(), 500);
  s = adv(run(s, { type: "partition", kind: "leader-in-minority" }), 2000);
  assert.equal(leaders(s).length, 2, "the old leader still thinks it leads");
  assert.ok(s.flags.twoLeaders);
  const fresh = usableLeader(s);
  assert.ok(fresh && fresh.id !== 0 && fresh.term > s.servers[0].term);
  s = adv(run(s, { type: "partition", kind: "none" }), 500);
  assert.equal(s.servers[0].role, "follower");
  assert.equal(leaders(s).length, 1);
  assert.ok(challengeDone(s, "deposed"));
});

test("raft: with three of five servers down, no leader can be elected", () => {
  let s = adv(init(), 500);
  s = adv(run(s, { type: "kill", id: 0 }, { type: "kill", id: 1 }, { type: "kill", id: 2 }), 2500);
  assert.equal(leaders(s).length, 0);
  assert.ok(s.servers.filter((x) => x.alive).length < MAJORITY);
  assert.ok(challengeDone(s, "noQuorum"));
  s = adv(run(s, { type: "revive", id: 2 }), 2000);
  assert.ok(usableLeader(s), "a third server back restores a majority");
});

test("raft: a restarted server keeps its term from disk and rejoins as a follower", () => {
  let s = adv(init(), 500);
  s = adv(run(s, { type: "kill", id: 0 }), 1500);
  s = adv(run(s, { type: "revive", id: 0 }), 500);
  assert.equal(s.servers[0].role, "follower");
  assert.equal(s.servers[0].term, usableLeader(s)?.term);
});

test("raft: the simulation is deterministic", () => {
  const a = adv(run(adv(init(), 400), { type: "kill", id: 0 }), 1200);
  const b = adv(run(adv(init(), 400), { type: "kill", id: 0 }), 1200);
  assert.deepEqual(a.servers, b.servers);
});
