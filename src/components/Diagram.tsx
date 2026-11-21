"use client";
// Box-and-arrow diagram that morphs between a "before" and an "after" layout.
// t = 0 is the before design, t = 1 the after design. Every box, label and edge is
// interpolated from t, so a slider or an animation can drive it.
import { useEffect, useRef } from "react";
import { pick, type DiagramSpec, type Lang } from "@/lib/types";

export type ChangeMode = "none" | "ghost" | "fresh";

interface Props {
  spec: DiagramSpec;
  t: number;
  lang: Lang;
  change: ChangeMode;
  litNodes?: string[];
  litEdges?: string[];
  /** Edge ids the marker travels along, in order. Changing `markerKey` replays it. */
  markerEdges?: string[];
  markerKey?: string | number;
  hover?: string | null;
  onHover?: (id: string | null) => void;
  reduceMotion?: boolean;
}

const clamp = (x: number) => Math.max(0, Math.min(1, x));
const lerp = (a: number, b: number, k: number) => a + (b - a) * k;
export const edgeId = (from: string, to: string) => `${from}>${to}`;

export function Diagram({ spec, t, lang, change, litNodes = [], litEdges = [], markerEdges = [], markerKey, hover, onHover, reduceMotion }: Props) {
  const paths = useRef<Record<string, SVGPathElement | null>>({});
  const marker = useRef<SVGRectElement>(null);

  // geometry for this frame
  const geo: Record<string, { x: number; y: number; w: number; h: number }> = {};
  const sizeK = clamp(t * 1.3);
  for (const n of spec.nodes) {
    geo[n.id] = {
      x: lerp(n.before.x, n.after.x, t),
      y: lerp(n.before.y, n.after.y, t),
      w: lerp(n.before.w, n.after.w, sizeK),
      h: lerp(n.before.h, n.after.h, sizeK),
    };
  }
  // labels swap around the midpoint and are never both visible
  const beforeOp = clamp((0.5 - t) / 0.08);
  const afterOp = clamp((t - 0.5) / 0.08);
  const drawK = clamp(t * 1.4 - 0.4);
  const kindOf = Object.fromEntries(spec.nodes.map((n) => [n.id, n]));

  // the marker: a small square that travels along edges at constant speed
  useEffect(() => {
    const m = marker.current;
    if (!m) return;
    m.setAttribute("x", "-40");
    if (reduceMotion || markerEdges.length === 0) return;
    const per = 520;
    let raf = 0;
    let start: number | null = null;
    const frame = (ts: number) => {
      start ??= ts;
      const el = ts - start;
      const k = Math.floor(el / per);
      if (k >= markerEdges.length) { m.setAttribute("x", "-40"); return; }
      const id = markerEdges[k];
      const p = paths.current[id];
      if (p) {
        const f = (el - k * per) / per;
        // implements-edges point from the concrete type to the interface; the call goes the other way
        const reverse = kindOf[id.split(">")[0]]?.kind === "concrete";
        const pt = p.getPointAtLength((reverse ? 1 - f : f) * p.getTotalLength());
        m.setAttribute("x", String(pt.x - 4.5));
        m.setAttribute("y", String(pt.y - 4.5));
      }
      raf = requestAnimationFrame(frame);
    };
    raf = requestAnimationFrame(frame);
    return () => cancelAnimationFrame(raf);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [markerKey, reduceMotion]);

  return (
    <svg viewBox={`0 0 ${spec.width} ${spec.height}`} role="img" aria-label="Diagram of the roles in this design">
      <defs>
        <marker id="mn-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
          <path d="M0,0 L10,5 L0,10 z" className="arrowhead" />
        </marker>
        <marker id="mn-hollow" viewBox="0 0 12 12" refX="11" refY="6" markerWidth="10" markerHeight="10" orient="auto">
          <path d="M1,1 L11,6 L1,11 z" className="hollow" />
        </marker>
      </defs>

      <g>
        {spec.edges.map((e) => {
          const id = edgeId(e.from, e.to);
          const a = geo[e.from], b = geo[e.to];
          const toNode = kindOf[e.to], fromNode = kindOf[e.from];
          let d: string, lx: number, ly: number;
          if (e.kind === "implements") {
            const sx = a.x + a.w / 2, sy = a.y;
            const tx = Math.min(Math.max(sx, b.x + 12), b.x + b.w - 12), ty = b.y + b.h + 2;
            d = `M${sx},${sy} C${sx},${sy - 40} ${tx},${ty + 40} ${tx},${ty}`;
            lx = (sx + tx) / 2 + 44; ly = (sy + ty) / 2 + 4;
          } else {
            const y1 = a.y + a.h / 2, y2 = b.y + b.h / 2;
            d = `M${a.x + a.w},${y1} L${b.x - 3},${y2}`;
            lx = (a.x + a.w + b.x) / 2; ly = (y1 + y2) / 2 - 8;
          }
          let vis = t > 0.3 ? 1 : 0;
          if (fromNode?.appears === "change" || toNode?.appears === "change") vis = change === "fresh" ? vis : 0;
          return (
            <g key={id} opacity={vis}>
              <path
                ref={(el) => { paths.current[id] = el; }}
                d={d}
                pathLength={1}
                strokeDasharray="1"
                strokeDashoffset={1 - drawK}
                className={"edge" + (litEdges.includes(id) ? " lit" : "")}
                markerEnd={drawK > 0.9 ? (e.kind === "implements" ? "url(#mn-hollow)" : "url(#mn-arrow)") : undefined}
              />
              {e.label && <text className="elabel" x={lx} y={ly} textAnchor="middle" opacity={clamp(t * 3 - 2)}>{e.label}</text>}
            </g>
          );
        })}
      </g>

      <g>
        {spec.nodes.map((n) => {
          const g = geo[n.id];
          let op = 1;
          if (n.appears === "after") op = clamp(t * 1.6 - 0.4);
          if (n.appears === "change") op = change === "none" ? 0 : 1;
          if (op === 0) return null;
          const bt = pick(n.before.title, lang) ?? "", bs = pick(n.before.sub, lang) ?? "";
          const at = pick(n.after.title, lang) ?? "", as = pick(n.after.sub, lang) ?? "";
          const cls = ["node", n.kind];
          if (n.appears === "change" && change === "ghost") cls.push("ghost");
          if (n.appears === "change" && change === "fresh") cls.push("fresh");
          if (n.kind === "context" && change === "ghost") cls.push("pain");
          if (litNodes.includes(n.id)) cls.push("lit");
          if (hover === n.id) cls.push("hov");
          const big = n.kind === "context";
          return (
            <g key={n.id} className={cls.join(" ")} opacity={op}
              onMouseEnter={() => onHover?.(n.id)} onMouseLeave={() => onHover?.(null)}
              onFocus={() => onHover?.(n.id)} onBlur={() => onHover?.(null)} tabIndex={onHover ? 0 : undefined}
              aria-label={at || bt}>
              <rect className="box" x={g.x} y={g.y} width={Math.max(1, g.w)} height={Math.max(1, g.h)} />
              {/* before labels */}
              <g opacity={beforeOp}>
                {big ? (
                  <>
                    <text className="title" x={g.x + 14} y={g.y + 24}>{bt}</text>
                    <text className="sub" x={g.x + 14} y={g.y + 42}>{bs}</text>
                  </>
                ) : (
                  <>
                    <text className="title" x={g.x + g.w / 2} y={g.y + (bs ? g.h / 2 - 2 : g.h / 2 + 4)} textAnchor="middle">{bt}</text>
                    {bs && <text className="sub" x={g.x + g.w / 2} y={g.y + g.h / 2 + 13} textAnchor="middle">{bs}</text>}
                  </>
                )}
              </g>
              {/* after labels */}
              <g opacity={afterOp}>
                <text className="title" x={g.x + g.w / 2} y={g.y + (as ? g.h / 2 - 3 : g.h / 2 + 4)} textAnchor="middle">{at}</text>
                {as && <text className="sub" x={g.x + g.w / 2} y={g.y + g.h / 2 + 13} textAnchor="middle">{as}</text>}
              </g>
            </g>
          );
        })}
      </g>
      <rect ref={marker} className="marker" width="9" height="9" x="-40" y="-40" />
    </svg>
  );
}
