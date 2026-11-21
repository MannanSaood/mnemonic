import { getTopic, getTracks, listTopics, prepareCode } from "@/lib/content";
import { renderMdx } from "@/lib/mdx";
import { Lesson } from "@/components/Lesson";
import { LensBar } from "@/components/LensBar";

export const dynamicParams = false;

export function generateStaticParams() {
  return listTopics().map((t) => ({ track: t.track, topic: t.slug }));
}

type P = { params: Promise<{ track: string; topic: string }> };

export async function generateMetadata({ params }: P) {
  const { track, topic } = await params;
  const { meta } = getTopic(track, topic);
  return { title: `${meta.title}: learn`, description: meta.summary };
}

export default async function LearnPage({ params }: P) {
  const { track, topic } = await params;
  const { meta, steps } = getTopic(track, topic);
  const code = await prepareCode(meta);
  const rendered = await Promise.all(steps.map(async (s) => ({ key: s.key, title: s.title, content: await renderMdx(s.mdx) })));
  const tr = getTracks().find((t) => t.id === track)!;
  const base = `/${track}/${topic}/`;
  return (
    <div className="wrap page">
      <LensBar trackTitle={tr.title} trackHref={`/${track}/`} title={meta.title} group={meta.group} mode="learn"
        learnHref={base} refHref={`${base}reference/`} languages={meta.languages} />
      <div className="frame">
        <Lesson id={`${track}/${topic}`} meta={meta} code={code} steps={rendered} />
      </div>
    </div>
  );
}
