"use client";
// Reference mode: a scannable doc page. Same content as the lesson, laid out for lookup.
import Link from "next/link";
import type { ReactNode } from "react";
import { CodePanel } from "./CodePanel";
import { Inline } from "./Inline";
import { usePrefs } from "./Prefs";
import { LANG_LABEL, pick, type GlossaryEntry, type Lang, type PreparedLang, type TopicMeta } from "@/lib/types";

const SECTIONS = [
  ["roles", "Roles"],
  ["how", "How it works"],
  ["code", "Code"],
  ["use", "Use or avoid"],
  ["tradeoffs", "Trade-offs"],
  ["lookalikes", "Look-alikes"],
  ["languages", "In each language"],
  ["terms", "Terms"],
] as const;

export function ReferenceView({ meta, code, extra, terms, learnHref }: {
  meta: TopicMeta; code: Record<Lang, PreparedLang>; extra: ReactNode; terms: GlossaryEntry[]; learnHref: string;
}) {
  const { lang } = usePrefs();
  const L = code[lang] ?? code[meta.languages[0]];
  const r = meta.reference;
  return (
    <div className="ref">
      <article data-pagefind-body>
        <div style={{ display: "grid", gap: 10 }}>
          <span className="label" data-pagefind-ignore>Reference · {meta.group} pattern</span>
          <h1 data-pagefind-meta="title">{meta.title}</h1>
          <p className="lead">{meta.summary}</p>
          <p><b>Intent.</b> {meta.intent}</p>
        </div>

        <h2 id="roles">Roles</h2>
        <div className="table-wrap">
          <table>
            <thead><tr><th>Role</th><th>In the example</th><th>Job</th></tr></thead>
            <tbody>
              {r.roles.map((x) => (
                <tr key={x.role}><td>{x.role}</td><td><code>{pick(x.example, lang)}</code></td><td>{x.job}</td></tr>
              ))}
            </tbody>
          </table>
        </div>

        <h2 id="how">How it works</h2>
        <ol style={{ margin: 0, paddingLeft: "1.3em", display: "grid", gap: 6 }}>
          {meta.walk.map((w, i) => <li key={i}><Inline text={pick(w.text, lang) ?? ""} /></li>)}
        </ol>

        <h2 id="code">Code</h2>
        <CodePanel code={L.after} note={LANG_LABEL[lang]} />
        {extra}

        <h2 id="use">Use or avoid</h2>
        <div className="twocol">
          <div><span className="label">Use when</span><ul>{r.useWhen.map((u) => <li key={u}><Inline text={u} /></li>)}</ul></div>
          <div><span className="label">Avoid when</span><ul>{r.avoidWhen.map((u) => <li key={u}><Inline text={u} /></li>)}</ul></div>
        </div>

        <h2 id="tradeoffs">Trade-offs</h2>
        <ul>{r.tradeoffs.map((u) => <li key={u}><Inline text={u} /></li>)}</ul>

        <h2 id="lookalikes">Look-alikes</h2>
        <div className="table-wrap">
          <table>
            <tbody>{r.lookalikes.map((x) => <tr key={x.name}><td><b>{x.name}</b></td><td>{x.how}</td></tr>)}</tbody>
          </table>
        </div>

        <h2 id="languages">In each language</h2>
        <div className="table-wrap">
          <table>
            <thead><tr><th>Language</th><th>How much you need it</th><th>How it is written</th><th>Seen in</th></tr></thead>
            <tbody>
              {meta.languages.map((l) => (
                <tr key={l}>
                  <td><b>{LANG_LABEL[l]}</b></td>
                  <td>{code[l].lens.needLabel}</td>
                  <td><Inline text={code[l].lens.note} /></td>
                  <td><Inline text={code[l].lens.seenIn} /></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <h2 id="terms">Terms</h2>
        <dl style={{ margin: 0, display: "grid", gap: 8 }}>
          {terms.map((g) => <div key={g.id}><dt><b>{g.term}</b></dt><dd style={{ margin: 0 }}>{g.short}</dd></div>)}
        </dl>
      </article>
      <aside aria-label="On this page" data-pagefind-ignore>
        <span className="label">On this page</span>
        {SECTIONS.map(([id, label]) => <a key={id} href={`#${id}`}>{label}</a>)}
        <span className="label" style={{ marginTop: 14 }}>Interactive</span>
        <Link href={learnHref}>Learn {meta.title} step by step →</Link>
      </aside>
    </div>
  );
}
