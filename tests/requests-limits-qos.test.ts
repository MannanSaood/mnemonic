import { test } from "node:test";
import assert from "node:assert/strict";
import { NAIVE, NODE_MEM, apiLatency, init, oomScoreAdj, qos, simulate, step, type PodId, type Res, type Settings, type State } from "../src/playgrounds/requests-limits-qos/model.ts";

const withRes = (s: Settings, p: PodId, r: Partial<Res>): Settings => ({ ...s, res: { ...s.res, [p]: { ...s.res[p], ...r } } });
const pod = (run: ReturnType<typeof simulate>, id: PodId) => run.pods.find((p) => p.id === id)!;
const act = (s: State, ...as: Parameters<typeof step>[1][]) => as.reduce(step, s);

test("qos: classes and oom_score_adj follow the documented rules", () => {
  assert.equal(qos(NAIVE.res.cache), "Guaranteed");
  assert.equal(qos(NAIVE.res.api), "Burstable");
  assert.equal(qos(NAIVE.res.shipper), "BestEffort");
  assert.equal(oomScoreAdj(NAIVE.res.cache), -997);
  assert.equal(oomScoreAdj(NAIVE.res.shipper), 1000);
  assert.equal(oomScoreAdj(NAIVE.res.api), 938); // 1000 - 1000 * 512 / 8192, integer division
  // a limit with no request: the request defaults to the limit, so this is Guaranteed
  assert.equal(qos({ cpuReq: null, cpuLim: 500, memReq: null, memLim: 256 }), "Guaranteed");
});

test("qos: the CPU limit throttles bursts even though the average is under half the limit (predict)", () => {
  let s = act(init(), { type: "run" });
  const r = s.run!;
  assert.ok(r.api.avgCpu < 500, `avg ${r.api.avgCpu}m`);
  assert.ok(r.api.throttledPct > 0);
  assert.equal(s.found.throttledLow, true);
  const unlimited = simulate(withRes(NAIVE, "api", { cpuLim: null }));
  assert.equal(unlimited.api.throttledPct, 0);
  assert.ok(unlimited.api.worst < r.api.worst);
});

test("qos: CFS quota arithmetic: work beyond limit x 100 ms waits for the next period", () => {
  assert.equal(apiLatency([150], 1000, 1).throttled, 1);
  assert.equal(apiLatency([90], 1000, 1).throttled, 0);
  assert.equal(apiLatency([150], 1000, 1).worst, Math.round(5 + 100 + 50 / 4));
});

test("qos: a memory limit kills the container while the node still has memory", () => {
  const s = act(init(), { type: "res", pod: "api", field: "memLim", value: 768 }, { type: "run" });
  const r = s.run!;
  assert.ok(pod(r, "api").oomKills > 0);
  assert.ok(r.peakMem < NODE_MEM - 1000);
  assert.equal(s.found.ownLimit, true);
});

test("qos: the scheduler adds requests, not usage: the import stays Pending on a half-idle node", () => {
  const s = act(init(), { type: "toggle", key: "importOn", on: true }, { type: "run" });
  const imp = pod(s.run!, "import");
  assert.equal(imp.scheduled, false);
  assert.match(imp.pendingReason!, /Insufficient memory/);
  assert.equal(s.found.pending, true);
});

test("qos: under node pressure the kubelet evicts the pod furthest above its request", () => {
  const s = act(init(), { type: "toggle", key: "bigReport", on: true }, { type: "run" });
  const ev = s.run!.events.find((e) => e.kind === "evict")!;
  assert.equal(ev.pod, "report");
  assert.equal(pod(s.run!, "cache").restarts, 0, "the Guaranteed cache is untouched");
  assert.equal(s.found.evicted, true);
});

test("qos: requesting what the report really uses moves eviction to pods above their requests", () => {
  const s = act(init(), { type: "toggle", key: "bigReport", on: true }, { type: "res", pod: "report", field: "memReq", value: 4608 }, { type: "run" });
  const report = pod(s.run!, "report");
  assert.equal(report.evicted, false);
  assert.equal(report.completed, true);
  assert.ok(s.run!.events.some((e) => e.kind === "evict" && e.pod !== "report"));
  assert.equal(s.found.protectedReport, true);
});

test("qos: overcommitting with lowered requests lets the kernel OOM killer act before the kubelet", () => {
  let st = withRes({ ...NAIVE, importOn: true }, "import", { memReq: 2048, cpuReq: 1000 });
  const r = simulate(st);
  assert.equal(pod(r, "import").scheduled, true);
  const k = r.events.find((e) => e.kind === "kernel-oom")!;
  assert.ok(k, "the kernel kills first");
  assert.notEqual(k.pod, "cache");
});

test("qos: under contention the CPU request decides how fast the API's bursts run", () => {
  const noisy = act(init(), { type: "toggle", key: "noisy", on: true }, { type: "run" });
  assert.equal(noisy.found.contention, true);
  const calm = simulate(NAIVE).api.worst;
  assert.ok(noisy.run!.api.worst > calm);
  const better = simulate(withRes({ ...NAIVE, noisy: true }, "api", { cpuReq: 1000 })).api.worst;
  assert.ok(better < noisy.run!.api.worst);
});

test("qos: reset restores the start", () => {
  const s = act(init(), { type: "run" }, { type: "toggle", key: "noisy", on: true });
  assert.deepEqual(step(s, { type: "reset" }), init());
});
