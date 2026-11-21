"use client";
// Shared pieces for every playground: a frame, controls, an event log and a cost meter.
// A playground = a model (state + pure step function) + a view built from these parts.
import { useEffect, useReducer, useState, type ReactNode } from "react";

/** Run a model: returns state and dispatch, plus whether the reader prefers reduced motion. */
export function useModel<S, A>(step: (s: S, a: A) => S, init: () => S) {
  const [state, dispatch] = useReducer(step, undefined, init);
  const [reduced, setReduced] = useState(false);
  useEffect(() => setReduced(window.matchMedia("(prefers-reduced-motion: reduce)").matches), []);
  return { state, dispatch, reduced };
}

export function PgFrame({ title, onReset, toolbar, children }: { title: string; onReset: () => void; toolbar?: ReactNode; children: ReactNode }) {
  return (
    <section className="pg" aria-label={`Playground: ${title}`}>
      <header className="pg-head">
        <span className="label">Playground · {title}</span>
        <div className="pg-tools">
          {toolbar}
          <button className="pg-btn ghost" onClick={onReset}>Reset</button>
        </div>
      </header>
      <div className="pg-body">{children}</div>
    </section>
  );
}

export function PgCard({ label, children, tone }: { label: string; children: ReactNode; tone?: "new" }) {
  return (
    <div className={"pg-card" + (tone ? ` ${tone}` : "")}>
      <span className="label">{label}</span>
      {children}
    </div>
  );
}

export function PgButton({ children, onClick, primary, disabled, title }: { children: ReactNode; onClick: () => void; primary?: boolean; disabled?: boolean; title?: string }) {
  return <button className={"pg-btn" + (primary ? " primary" : "")} onClick={onClick} disabled={disabled} title={title}>{children}</button>;
}

/** A single-choice control (radio group semantics, arrow keys move the choice). */
export function PgChoice<T extends string>({ label, value, options, onChange, disabledOptions = [] }: {
  label: string; value: T; options: { value: T; label: string; note?: string }[]; onChange: (v: T) => void; disabledOptions?: T[];
}) {
  return (
    <div className="pg-choice" role="radiogroup" aria-label={label}>
      {options.map((o) => {
        const off = disabledOptions.includes(o.value);
        return (
          <button key={o.value} role="radio" aria-checked={value === o.value} className={off ? "off" : ""}
            onClick={() => onChange(o.value)} title={o.note}>
            {o.label}
          </button>
        );
      })}
    </div>
  );
}

export interface PgLogEntry { id: number; ok: boolean; text: string; path: string[] }

/** The most recent events, newest first. The newest path lights up hop by hop. */
export function PgLog({ entries, empty, reduced }: { entries: PgLogEntry[]; empty: string; reduced: boolean }) {
  return (
    <div className="pg-log" aria-live="polite">
      {entries.length === 0 && <p className="pg-empty">{empty}</p>}
      {entries.map((e, i) => (
        <div key={e.id} className={"pg-entry" + (e.ok ? " ok" : " fail") + (i === 0 && !reduced ? " fresh" : "")}>
          <div className="pg-path" aria-hidden="true">
            {e.path.map((p, j) => (
              <span key={j} style={{ animationDelay: `${j * 140}ms` }}>{p}</span>
            ))}
          </div>
          <p>{e.text}</p>
        </div>
      ))}
    </div>
  );
}

export function PgMeter({ cost }: { cost: { text: string; value: number; good: boolean } | null }) {
  return (
    <div className={"meter" + (cost ? (cost.good ? " good" : "") : " idle")}>
      <span className="label">Change cost</span>
      <span className="bar"><i style={{ width: cost ? `${cost.value * 100}%` : "0%" }} /></span>
      <span className="val">{cost ? cost.text : "nothing changed yet"}</span>
    </div>
  );
}
