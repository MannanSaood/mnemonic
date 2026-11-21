import { getGlossary, getTopic, getTracks, listTopics, prepareCode } from "@/lib/content";
import { renderMdx } from "@/lib/mdx";
import { LensBar } from "@/components/LensBar";
import { ReferenceView } from "@/components/ReferenceView";

export const dynamicParams = false;

export function generateStaticParams() {
  return listTopics().map((t) => ({ track: t.track, topic: t.slug }));
}

type P = { params: Promise<{ track: string; topic: string }> };

export async function generateMetadata({ params }: P) {
  const { track, topic } = await params;
  const { meta } = getTopic(track, topic);
  return { title: `${meta.title}: reference`, description: meta.summary };
}

export default async function ReferencePage({ params }: P) {
  const { track, topic } = await params;
  const { meta, reference } = getTopic(track, topic);
  const code = await prepareCode(meta);
  const extra = reference ? await renderMdx(reference) : null;
  const gl = getGlossary();
  const terms = (meta.glossary ?? []).map((id) => gl[id]).filter(Boolean);
  const tr = getTracks().find((t) => t.id === track)!;
  const base = `/${track}/${topic}/`;
  return (
    <div className="wrap page">
      <LensBar trackTitle={tr.title} trackHref={`/${track}/`} title={meta.title} group={meta.group} mode="reference"
        learnHref={base} refHref={`${base}reference/`} languages={meta.languages} showDepth={false} />
      <div className="frame">
        <ReferenceView meta={meta} code={code} extra={extra} terms={terms} learnHref={base} />
      </div>
    </div>
  );
}
