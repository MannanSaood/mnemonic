"use client";
import Link from "next/link";
import { useEffect, useState } from "react";
import { readProgress } from "./Prefs";
import type { DepthName } from "@/lib/types";
import type { RoadmapNode } from "@/lib/roadmap";

export interface RoadmapItem extends RoadmapNode { track: string; href: string | null }

const RANK: Record<DepthName, number> = { overview: 0, engineer: 1, deep: 2 };

/** The ordered path. Marks lessons the reader has already passed at the required depth. */
export function RoadmapView({ items }: { items: RoadmapItem[] }) {
  const [passed, setPassed] = useState<Record<string, DepthName[]>>({});
  useEffect(() => {
    setPassed(Object.fromEntries(items.map((i) => [i.id, readProgress(i.id).passed])));
  }, [items]);
  const ready = items.filter((i) => i.href).length;
  const done = items.filter((i) => (passed[i.id] ?? []).some((d) => RANK[d] >= RANK[i.depth])).length;
  return (
    <>
      <p className="roadmap-summary">
        <b>{items.length} lessons</b> on this path · {ready} ready now · {done} already done at the depth this goal needs.
      </p>
      <ol className="roadmap">
        {items.map((it, k) => {
          const isDone = (passed[it.id] ?? []).some((d) => RANK[d] >= RANK[it.depth]);
          const body = (
            <>
              <span className="rm-n">{k + 1}</span>
              <span className="rm-main">
                <span className="rm-track label">{it.track}</span>
                <span className="t">{it.title}</span>
                <span className="rm-why">{it.why.join(" ")}</span>
              </span>
              <span className="rm-tags">
                <span className="badge">{it.depth}</span>
                {isDone ? <span className="soon done">Done</span> : !it.href ? <span className="soon">Coming soon</span> : null}
              </span>
            </>
          );
          return (
            <li key={it.id} className={(isDone ? "done " : "") + (it.prerequisiteOnly ? "pre" : "")}>
              {it.href ? <Link href={it.href}>{body}</Link> : <div>{body}</div>}
            </li>
          );
        })}
      </ol>
    </>
  );
}
