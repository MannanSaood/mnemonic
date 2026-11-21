import { getGlossary } from "@/lib/content";

export const metadata = { title: "Glossary" };

export default function GlossaryPage() {
  const terms = Object.values(getGlossary()).sort((a, b) => a.term.localeCompare(b.term));
  return (
    <div className="wrap">
      <section className="hero">
        <span className="label">Glossary</span>
        <h1>Terms used across Mnemonic</h1>
        <p>Every term here also shows its definition when you hover it inside a lesson.</p>
      </section>
      <dl className="gloss" data-pagefind-body>
        {terms.map((g) => (
          <div key={g.id} id={g.id}>
            <dt>{g.term}</dt>
            <dd>{g.short}</dd>
          </div>
        ))}
      </dl>
    </div>
  );
}
