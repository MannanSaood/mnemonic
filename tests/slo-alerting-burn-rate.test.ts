import { test } from "node:test";
import assert from "node:assert/strict";
import { budgetShare, evaluate, init, series, step, type Action, type Incident, type State } from "../src/playgrounds/slo-alerting-burn-rate/model.ts";

const run = (s: State, ...actions: Action[]) => actions.reduce(step, s);
const inc = (id: number, kind: Incident["kind"], day: number): Incident => ({ id, kind, day });
const DEF = { window: 60 as const, burn: 14.4 };

test("burn-rate: incident sizes match the budget arithmetic", () => {
  assert.ok(Math.abs(budgetShare(inc(1, "outage", 4)) - 15 / 43.2) < 1e-9, "15 min of 100% is 34.7%");
  assert.ok(Math.abs(budgetShare(inc(1, "leak", 4)) - 0.3) < 1e-9, "burn 3 for 3 days of 30 is 30%");
  assert.ok(budgetShare(inc(1, "blips", 4)) < 0.01, "a day of blips is under 1%");
});

test("burn-rate: the series is deterministic and a total outage fails every request", () => {
  const a = series([inc(1, "outage", 4)], "busy"), b = series([inc(1, "outage", 4)], "busy");
  assert.deepEqual(Array.from(a.err.slice(0, 5000)), Array.from(b.err.slice(0, 5000)));
  const m = 3 * 1440 + 600 + 3;
  assert.equal(a.err[m], a.req[m]);
});

test("burn-rate: a threshold at the SLO pages for every blip", () => {
  const [th] = evaluate([inc(1, "blips", 3), inc(2, "blips", 9)], "busy", DEF);
  assert.equal(th.pages, 8);
  assert.equal(th.falsePages, 8);
});

test("burn-rate: one 1 h window at 14.4x misses a slow leak; multiwindow opens a ticket in about a day", () => {
  const [, single, multi] = evaluate([inc(1, "leak", 10)], "busy", DEF);
  assert.equal(single.missed, 1);
  const d = multi.detections[0];
  assert.equal(d.severity, "ticket");
  assert.ok(d.at! > 18 * 60 && d.at! < 30 * 60, `ticket after ${d.at} min`);
  assert.equal(multi.pages, 0, "a slow leak does not wake anyone");
});

test("burn-rate: multiwindow pages for a total outage within minutes and stops soon after it ends", () => {
  const [, single, multi] = evaluate([inc(1, "outage", 5)], "busy", DEF);
  const d = multi.detections[0];
  assert.equal(d.severity, "page");
  assert.ok(d.at! <= 2, `detected after ${d.at} min`);
  assert.ok(d.reset! <= 35, `stops ${d.reset} min after`);
  assert.ok(single.detections[0].reset! > 40, "one 1 h window keeps firing for most of an hour");
  assert.equal(multi.tickets, 0, "the ticket rule is inhibited by the page");
});

test("burn-rate: a partial outage pages after about a quarter of an hour", () => {
  const [, , multi] = evaluate([inc(1, "partial", 8)], "busy", DEF);
  const d = multi.detections[0];
  assert.equal(d.severity, "page");
  assert.ok(d.at! >= 10 && d.at! <= 20, `${d.at}`);
});

test("burn-rate: in the default month the threshold is noisy, one window misses and multiwindow is clean", () => {
  const s = init();
  const [th, single, multi] = evaluate(s.incidents, s.traffic, s.single);
  assert.ok(th.falsePages >= 15);
  assert.equal(single.missed, 1);
  assert.equal(multi.missed, 0);
  assert.equal(multi.falsePages, 0);
});

test("burn-rate: a 6 h window at 2x catches everything but keeps firing for hours", () => {
  const s = init();
  const [, single] = evaluate(s.incidents, s.traffic, { window: 360, burn: 2 });
  assert.equal(single.missed, 0);
  assert.equal(single.falsePages, 0);
  assert.ok(single.worstReset! > 300);
});

test("burn-rate: at 10 requests an hour, single failed requests page every rule", () => {
  const s = init();
  const res = evaluate(s.incidents, "quiet", s.single);
  for (const r of res) assert.ok(r.falsePages > 0, r.rule.name);
});

test("burn-rate: the predict is revealed by running, and the challenges can all be completed", () => {
  let s = run(init(), { type: "predict", value: "single" }, { type: "run" });
  assert.ok(s.ran);
  s = run(s, { type: "tool", tool: "blips" }, { type: "day", day: 28 });
  s = run(s, { type: "window", window: 360 }, { type: "burn", burn: 2 });
  s = run(s, { type: "traffic", traffic: "quiet" });
  assert.ok(s.done.noisy, "noisy");
  assert.ok(s.done.leak, "leak");
  assert.ok(s.done.all, "all");
  assert.ok(s.done.quiet, "quiet");
});

test("burn-rate: a slow leak cannot start in the last two days, remove and clear work", () => {
  let s = run(init(), { type: "tool", tool: "leak" }, { type: "day", day: 30 });
  assert.equal(s.incidents.length, 8);
  s = run(s, { type: "tool", tool: "remove" }, { type: "day", day: 4 });
  assert.equal(s.incidents.length, 7);
  s = run(s, { type: "clear" });
  assert.equal(s.incidents.length, 0);
});
