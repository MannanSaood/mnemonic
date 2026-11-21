import Link from "next/link";
import { notFound } from "next/navigation";
import { getOutline, getTracks, listTopics } from "@/lib/content";
import { ProgressPill } from "@/components/ProgressPill";
import type { OutlineLesson, TopicMeta } from "@/lib/types";

export const dynamicParams = false;

export function generateStaticParams() {
  return getTracks().map((t) => ({ track: t.id }));
}

export async function generateMetadata({ params }: { params: Promise<{ track: string }> }) {
  const { track } = await params;
  const tr = getTracks().find((t) => t.id === track);
  return { title: tr?.title, description: tr?.summary };
}

function Ready({ t }: { t: TopicMeta }) {
  return (
    <li>
      <Link href={`/${t.track}/${t.slug}/`}>
        <span><span className="t">{t.title}</span><span className="s">{t.summary}</span></span>
        <ProgressPill id={t.id} />
      </Link>
    </li>
  );
}

function Planned({ l }: { l: OutlineLesson }) {
  return (
    <li>
      <div className="soon-item">
        <span><span className="t">{l.title}</span>{l.summary && <span className="s">{l.summary}</span>}</span>
        <span className="soon">Coming soon</span>
      </div>
    </li>
  );
}

export default async function TrackPage({ params }: { params: Promise<{ track: string }> }) {
  const { track } = await params;
  const tr = getTracks().find((t) => t.id === track);
  if (!tr) notFound();
  const topics = listTopics().filter((t) => t.track === track);
  const planned = getOutline(track);
  const groups = tr.groups ?? [...new Set(topics.map((t) => t.group))];
  return (
    <div className="wrap">
      <section className="hero">
        <span className="label">Track · {topics.length ? `${topics.length} lesson${topics.length === 1 ? "" : "s"} ready` : "coming soon"}{planned.length ? ` · ${planned.length} planned` : ""}</span>
        <h1>{tr.title}</h1>
        <p>{tr.summary}</p>
      </section>
      <div className="tracks">
        {groups.map((g) => {
          const list = topics.filter((t) => t.group === g);
          if (!list.length) return null;
          return (
            <section key={g} className="track">
              <div><h2>{g}</h2></div>
              <ul className="topic-list">{list.map((t) => <Ready key={t.id} t={t} />)}</ul>
            </section>
          );
        })}
        {planned.length > 0 && (
          <section className="track planned">
            <div>
              <h2>{topics.length ? "More, coming soon" : "Planned lessons"}</h2>
              <p>The outline for this track. Lessons appear here as they are written.</p>
            </div>
            <ul className="topic-list">{planned.map((l) => <Planned key={l.id} l={l} />)}</ul>
          </section>
        )}
      </div>
    </div>
  );
}
