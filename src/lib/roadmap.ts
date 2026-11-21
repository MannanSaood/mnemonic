// Roadmaps: a goal profile applied to the lesson graph. Pure functions, no I/O, so the
// future roadmap page (and tests) can call them with any data.
//
// computeRoadmap:
// 1. Every lesson tagged with a goal skill is required, at the deepest depth any of its
//    matching goals asks for (capped at the depths the lesson covers).
// 2. Prerequisites of required lessons are pulled in too, at Overview, unless already required.
// 3. The path is ordered so prerequisites come first (topological order); ties keep the
//    lessons' own order.
// 4. A lesson is "skippable" when its check is already passed at the required depth, either
//    in the lesson or in a placement check.
import type { DepthName, RoadmapProfile, TopicMeta } from "./types";

const RANK: Record<DepthName, number> = { overview: 0, engineer: 1, deep: 2 };

export interface RoadmapNode {
  id: string;
  title: string;
  depth: DepthName;
  /** Why the goal needs this lesson: one reason per matching goal, or the lessons that need it first. */
  why: string[];
  /** Pulled in only because another lesson needs it first. */
  prerequisiteOnly: boolean;
  skippable: boolean;
}

export interface RoadmapResult { nodes: RoadmapNode[]; missing: string[]; cyclic: string[] }

/** passed: lesson id -> depths whose check the reader has passed. */
export function computeRoadmap(profile: RoadmapProfile, lessons: TopicMeta[], passed: Record<string, DepthName[]> = {}): RoadmapResult {
  const byId = new Map(lessons.map((l) => [l.id, l]));
  const need = new Map<string, { depth: DepthName; why: string[]; prereqOnly: boolean }>();
  const deepestCovered = (l: TopicMeta, d: DepthName): DepthName => {
    const covered = l.depths.filter((x) => RANK[x] <= RANK[d]);
    return covered.length ? covered.reduce((a, b) => (RANK[a] >= RANK[b] ? a : b)) : l.depths[0];
  };

  for (const l of lessons) {
    const goals = profile.goals.filter((g) => l.skills.includes(g.skill));
    if (!goals.length) continue;
    const depth = goals.map((g) => g.depth).reduce((a, b) => (RANK[a] >= RANK[b] ? a : b));
    need.set(l.id, { depth: deepestCovered(l, depth), why: goals.map((g) => g.why), prereqOnly: false });
  }

  // pull in prerequisites, transitively
  const missing = new Set<string>();
  const queue = [...need.keys()];
  while (queue.length) {
    const id = queue.shift()!;
    for (const p of byId.get(id)?.prerequisites ?? []) {
      const pl = byId.get(p);
      if (!pl) { missing.add(p); continue; }
      const reason = `Needed before ${byId.get(id)!.title}.`;
      const cur = need.get(p);
      if (cur) { if (cur.prereqOnly && !cur.why.includes(reason)) cur.why.push(reason); continue; }
      need.set(p, { depth: pl.depths[0], why: [reason], prereqOnly: true });
      queue.push(p);
    }
  }

  // topological order (Kahn), stable by the lessons' own order
  const ids = [...need.keys()];
  const order = new Map(lessons.map((l, i) => [l.id, i]));
  const indeg = new Map(ids.map((id) => [id, 0]));
  for (const id of ids) for (const p of byId.get(id)!.prerequisites) if (need.has(p)) indeg.set(id, indeg.get(id)! + 1);
  const ready = ids.filter((id) => indeg.get(id) === 0);
  const out: string[] = [];
  while (ready.length) {
    ready.sort((a, b) => order.get(a)! - order.get(b)!);
    const id = ready.shift()!;
    out.push(id);
    for (const other of ids)
      if (byId.get(other)!.prerequisites.includes(id)) {
        indeg.set(other, indeg.get(other)! - 1);
        if (indeg.get(other) === 0) ready.push(other);
      }
  }
  // A cycle (possible in planned outlines) must not break the path: keep those lessons in
  // their own order at the point where the cycle blocks, and report them.
  const cyclic = ids.filter((i) => !out.includes(i)).sort((a, b) => order.get(a)! - order.get(b)!);
  out.push(...cyclic);

  return {
    nodes: out.map((id) => {
      const n = need.get(id)!;
      const l = byId.get(id)!;
      return {
        id, title: l.title, depth: n.depth, why: n.why, prerequisiteOnly: n.prereqOnly,
        skippable: (passed[id] ?? []).some((d) => RANK[d] >= RANK[n.depth]),
      };
    }),
    missing: [...missing],
    cyclic,
  };
}
