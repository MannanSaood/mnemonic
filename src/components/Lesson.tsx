"use client";
// The Learn mode lesson. Every topic uses this same workflow: eight fixed steps, prose on the
// left, a sticky diagram + code on the right, Prev/Next and arrow keys to move.
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { animate } from "motion";
import { Diagram, edgeId, type ChangeMode } from "./Diagram";
import { CodePanel } from "./CodePanel";
import { Inline } from "./Inline";
import { usePrefs, readProgress, writeProgress } from "./Prefs";
import { Playground } from "@/playgrounds/Playground";
import { DEPTH_LABEL, LANG_LABEL, STEP_KEYS, STEP_LABEL, depthName, depthNumber, pick, type Lang, type PreparedCode, type PreparedLang, type Range, type StepKey, type TopicMeta } from "@/lib/types";

export interface LessonStep { key: StepKey; title: string; content: ReactNode }

interface Visual {
  t: number | null; // null: keep the slider's value
  change: ChangeMode;
  code: "before" | "pain" | "after" | "again" | "morph";
  caption: string;
  meter: "before" | "after" | null;
  lens?: boolean;
  /** The "Try it" step: the playground replaces the diagram and code. */
  play?: boolean;
}

const VISUALS: Record<StepKey, Visual> = {
  concept: { t: 1, change: "none", code: "after", caption: "The roles, and how they connect", meter: null },
  problem: { t: 0, change: "none", code: "before", caption: "Before: one method knows every variant", meter: null },
  pain: { t: 0, change: "ghost", code: "pain", caption: "The change request touches every marked line", meter: "before" },
  morph: { t: null, change: "none", code: "morph", caption: "Drag the slider to morph before into after", meter: null },
  walk: { t: 1, change: "none", code: "after", caption: "One call, start to finish", meter: null },
  again: { t: 1, change: "fresh", code: "again", caption: "After: the same request is one new piece", meter: "after" },
  play: { t: 1, change: "none", code: "after", caption: "", meter: null, play: true },
  lens: { t: 1, change: "none", code: "after", caption: "The same roles, in your language", meter: null, lens: true },
  check: { t: 1, change: "none", code: "after", caption: "The design you just built", meter: null },
};

const EASE = [0.65, 0, 0.35, 1] as const;

export function Lesson({ id, meta, code, steps }: { id: string; meta: TopicMeta; code: Record<Lang, PreparedLang>; steps: LessonStep[] }) {
  const { lang, depth, setDepth } = usePrefs();
  const L = code[lang] ?? code[meta.languages[0]];
  const [step, setStep] = useState(0);
  const [t, setT] = useState(1);
  const [walk, setWalk] = useState(0);
  const [quiz, setQuiz] = useState<number | null>(null);
  const [hover, setHover] = useState<string | null>(null);
  const [seen, setSeen] = useState<number[]>([0]);
  const [reduce, setReduce] = useState(false);
  const anim = useRef<{ stop: () => void } | null>(null);
  const tRef = useRef(1);
  tRef.current = t;

  const key = STEP_KEYS[step];
  const vis = VISUALS[key];

  // restore progress and the step in the URL hash
  useEffect(() => {
    setReduce(window.matchMedia("(prefers-reduced-motion: reduce)").matches);
    const p = readProgress(id);
    setSeen(p.seen.length ? p.seen : [0]);
    const h = window.location.hash.slice(1);
    const i = (STEP_KEYS as readonly string[]).indexOf(h);
    if (i > 0) {
      setStep(i);
      const v = VISUALS[STEP_KEYS[i]];
      setT(v.t ?? 1);
    } else setT(VISUALS.concept.t ?? 1);
  }, [id]);

  const animateT = useCallback((target: number) => {
    anim.current?.stop();
    if (reduce) { setT(target); return; }
    anim.current = animate(tRef.current, target, { duration: 0.65, ease: EASE, onUpdate: (v) => setT(v) });
  }, [reduce]);

  const go = useCallback((i: number) => {
    if (i < 0 || i >= STEP_KEYS.length) return;
    setStep(i);
    setHover(null);
    setSeen((s) => {
      const next = s.includes(i) ? s : [...s, i];
      writeProgress(id, { ...readProgress(id), seen: next });
      return next;
    });
    const v = VISUALS[STEP_KEYS[i]];
    if (v.t !== null) animateT(v.t);
    history.replaceState(null, "", i === 0 ? window.location.pathname : `#${STEP_KEYS[i]}`);
  }, [animateT, id]);

  // follow links to a step (#pain, #walk, …) within the page
  useEffect(() => {
    const onHash = () => {
      const i = (STEP_KEYS as readonly string[]).indexOf(window.location.hash.slice(1));
      if (i >= 0 && i !== step) go(i);
    };
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, [go, step]);

  // keyboard: left/right arrows move between steps (not while typing or using the slider)
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement)?.tagName?.toLowerCase();
      if (tag === "input" || tag === "textarea" || e.altKey || e.metaKey || e.ctrlKey) return;
      if (e.key === "ArrowRight") { go(step + 1); e.preventDefault(); }
      if (e.key === "ArrowLeft") { go(step - 1); e.preventDefault(); }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [go, step]);

  // the check matches the reader's depth; fall back to the deepest the lesson covers
  const dn = depthName(depth);
  const checkDepth = meta.checks[dn] ? dn : meta.depths[meta.depths.length - 1];
  const check = meta.checks[checkDepth]!;
  useEffect(() => setQuiz(null), [checkDepth]);

  function answer(k: number) {
    setQuiz(k);
    if (check.options[k].correct) {
      const p = readProgress(id);
      const passed = p.passed.includes(checkDepth) ? p.passed : [...p.passed, checkDepth];
      writeProgress(id, { seen, passed });
    }
  }

  /* ---------- what the code panel shows ---------- */
  let shown: PreparedCode;
  let mode = vis.code;
  if (mode === "morph") mode = t < 0.5 ? "before" : "after";
  shown = mode === "before" ? L.before : mode === "pain" ? L.pain : mode === "again" ? L.again : L.after;

  let lit: Range | null = null;
  if (hover) {
    const node = meta.diagram.nodes.find((n) => n.id === hover);
    lit = shown.roles[hover] ?? (node?.kind === "concrete" ? shown.roles.strategy ?? null : null);
    if (hover === "brotli" || node?.appears === "change") lit = shown.roles.change ?? null;
  } else if (key === "walk") lit = shown.roles[meta.walk[walk].role] ?? null;

  const w = meta.walk[walk];
  const litNodes = key === "walk" ? w.nodes : [];
  const litEdges = key === "walk" ? w.edges.map((e) => { const [a, b] = e.split(">"); return edgeId(a, b); }) : [];

  const cost = vis.meter ? L.cost[vis.meter] : null;
  const s = steps[step];

  return (
    <div className="lesson">
      <div className="prose" data-pagefind-ignore>
        <ol className="rail" aria-label="Lesson steps">
          {STEP_KEYS.map((k, i) => (
            <li key={k}>
              <button onClick={() => go(i)} title={STEP_LABEL[k]} aria-label={`Step ${i + 1}: ${STEP_LABEL[k]}`}
                aria-current={i === step ? "step" : undefined} className={seen.includes(i) ? "seen" : ""}>{i + 1}</button>
            </li>
          ))}
        </ol>
        <span className="label">Step {step + 1} of {STEP_KEYS.length} · {STEP_LABEL[key]}{key === "check" ? ` · ${DEPTH_LABEL[depthNumber(checkDepth)]}` : ""}</span>
        <h1 className="step-title">{s.title}</h1>
        <div className="step-body" aria-live="polite">
          {s.content}

          {key === "morph" && (
            <div className="morph-ctl">
              <input id="morph" type="range" min={0} max={1000} value={Math.round(t * 1000)} aria-label="Morph from before to after"
                onChange={(e) => { anim.current?.stop(); setT(Number(e.target.value) / 1000); }} />
              <div className="ends"><span className="label">Before</span><span className="label">After</span></div>
            </div>
          )}

          {key === "walk" && (
            <ol className="walk">
              {meta.walk.map((ws, i) => (
                <li key={i}>
                  <button aria-pressed={walk === i} onClick={() => setWalk(i)}>
                    <span className="n">{i + 1}</span>
                    <span><Inline text={pick(ws.text, lang) ?? ""} /></span>
                  </button>
                </li>
              ))}
            </ol>
          )}

          {key === "play" && (
            <ol className="scenarios" aria-label="Scenarios to try">
              {meta.playground.scenarios.map((sc, i) => (
                <li key={i}><span><Inline text={sc.try} /></span><span className="notice">Notice: <Inline text={sc.notice} /></span></li>
              ))}
            </ol>
          )}

          {key === "check" && (
            <div className="quiz">
              <p><strong>{check.question}</strong></p>
              {check.options.map((o, i) => (
                <button key={i} onClick={() => answer(i)} className={quiz === i ? (o.correct ? "right" : "wrong") : ""}>{o.text}</button>
              ))}
              <p className="fb" aria-live="polite">{quiz === null ? "" : check.options[quiz].why}</p>
            </div>
          )}

          {depth < 3 && key !== "check" && key !== "play" && (
            <button className="go-deeper" onClick={() => setDepth((depth + 1) as 2 | 3)}>Go one level deeper</button>
          )}
        </div>
        <div className="nav">
          <button onClick={() => go(step - 1)} disabled={step === 0}>← Previous</button>
          <span className="pos">{step + 1} / {STEP_KEYS.length}</span>
          <button className="primary" onClick={() => go(step + 1)} disabled={step === STEP_KEYS.length - 1}>Next →</button>
        </div>
      </div>

      {vis.play ? (
        <div className="visual wide"><Playground model={meta.playground.model} /></div>
      ) : (
      <div className="visual">
        <figure className="figure" style={{ margin: 0 }}>
          <Diagram spec={meta.diagram} t={t} lang={lang} change={vis.change} litNodes={litNodes} litEdges={litEdges}
            markerEdges={key === "walk" ? litEdges : []} markerKey={`${key}-${walk}`} hover={hover} onHover={setHover} reduceMotion={reduce} />
          <figcaption className="fig-cap"><span>{vis.caption}</span><span className="label">{t < 0.5 ? "before" : "after"}</span></figcaption>
        </figure>
        <div className={"meter" + (cost ? (vis.meter === "after" ? " good" : "") : " idle")}>
          <span className="label">Change cost</span>
          <span className="bar"><i style={{ width: cost ? `${cost.value * 100}%` : "0%" }} /></span>
          <span className="val">{cost ? cost.text : "no change yet"}</span>
        </div>
        {vis.lens && (
          <div className="need">
            <p>
              <span className="label">How much you need it in {LANG_LABEL[lang]}</span>
              <span className="dots" aria-hidden="true">{[1, 2, 3, 4].map((i) => <i key={i} className={i <= L.lens.need ? "on" : ""} />)}</span>
              <b>{L.lens.needLabel}</b>
            </p>
            <p><Inline text={L.lens.note} /></p>
            <p><span className="label">Seen in</span><br /><Inline text={L.lens.seenIn} /></p>
          </div>
        )}
        <CodePanel code={shown} lit={lit} note={LANG_LABEL[lang]} />
      </div>
      )}
    </div>
  );
}
