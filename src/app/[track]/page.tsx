import Link from "next/link";
import { notFound } from "next/navigation";
import { getTracks, listTopics } from "@/lib/content";
import { ProgressPill } from "@/components/ProgressPill";

export const dynamicParams = false;

export function generateStaticParams() {
  const topics = listTopics();
  return getTracks().filter((t) => topics.some((p) => p.track === t.id)).map((t) => ({ track: t.id }));
}

export async function generateMetadata({ params }: { params: Promise<{ track: string }> }) {
  const { track } = await params;
  return { title: getTracks().find((t) => t.id === track)?.title };
}

export default async function TrackPage({ params }: { params: Promise<{ track: string }> }) {
  const { track } = await params;
  const tr = getTracks().find((t) => t.id === track);
  if (!tr) notFound();
  const topics = listTopics().filter((t) => t.track === track);
  const groups = tr.groups ?? [...new Set(topics.map((t) => t.group))];
  return (
    <div className="wrap">
      <section className="hero">
        <span className="label">Track</span>
        <h1>{tr.title}</h1>
        <p>{tr.summary}</p>
      </section>
      <div className="tracks">
        {groups.map((g) => {
          const list = topics.filter((t) => t.group === g);
          return (
            <section key={g} className={"track" + (list.length ? "" : " planned")}>
              <div><h2>{g}</h2></div>
              {list.length ? (
                <ul className="topic-list">
                  {list.map((t) => (
                    <li key={t.slug}>
                      <Link href={`/${t.track}/${t.slug}/`}>
                        <span><span className="t">{t.title}</span><span className="s">{t.summary}</span></span>
                        <ProgressPill id={`${t.track}/${t.slug}`} />
                      </Link>
                    </li>
                  ))}
                </ul>
              ) : <span className="soon">Coming next</span>}
            </section>
          );
        })}
      </div>
    </div>
  );
}
