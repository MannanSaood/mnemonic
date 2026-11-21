"use client";
import Link from "next/link";
import { usePrefs } from "./Prefs";
import { DEPTHS, DEPTH_LABEL, LANG_SHORT, type Lang } from "@/lib/types";

interface Props {
  trackTitle: string;
  trackHref: string;
  title: string;
  group: string;
  mode: "learn" | "reference";
  learnHref: string;
  refHref: string;
  languages: Lang[];
  showDepth?: boolean;
}

/** The bar above every lesson: where you are, Learn/Reference, and the two lenses. */
export function LensBar({ trackTitle, trackHref, title, group, mode, learnHref, refHref, languages, showDepth = true }: Props) {
  const { lang, setLang, depth, setDepth } = usePrefs();
  return (
    <div className="lbar">
      <div className="crumbs">
        <Link href={trackHref}>{trackTitle}</Link> / {group} / <b>{title}</b>
      </div>
      <nav className="seg" aria-label="Mode">
        <Link href={learnHref} aria-current={mode === "learn" ? "page" : undefined}>Learn</Link>
        <Link href={refHref} aria-current={mode === "reference" ? "page" : undefined}>Reference</Link>
      </nav>
      <div className="lens-ctl">
        <span className="label">Lang</span>
        <div className="seg" role="group" aria-label="Language">
          {languages.map((l) => (
            <button key={l} aria-pressed={lang === l} onClick={() => setLang(l)}>{LANG_SHORT[l]}</button>
          ))}
        </div>
      </div>
      {showDepth && (
        <div className="lens-ctl">
          <span className="label">Depth</span>
          <div className="seg" role="group" aria-label="Depth">
            {DEPTHS.map((d) => (
              <button key={d} aria-pressed={depth === d} onClick={() => setDepth(d)}>{DEPTH_LABEL[d]}</button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
