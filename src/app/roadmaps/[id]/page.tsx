import { notFound } from "next/navigation";
import { getOutline, getSkills, getTracks, listRoadmaps, listTopics } from "@/lib/content";
import { computeRoadmap } from "@/lib/roadmap";
import { RoadmapView, type RoadmapItem } from "@/components/RoadmapView";
import type { TopicMeta } from "@/lib/types";

export const dynamicParams = false;

export function generateStaticParams() {
  return listRoadmaps().map((r) => ({ id: r.id }));
}

export async function generateMetadata({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const r = listRoadmaps().find((x) => x.id === id);
  return { title: r ? `Roadmap: ${r.title}` : "Roadmap", description: r?.summary };
}

export default async function RoadmapPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const profile = listRoadmaps().find((r) => r.id === id);
  if (!profile) notFound();

  // The graph: written lessons plus planned ones from the outlines (assumed to cover all depths).
  const written = listTopics();
  const planned = getTracks().flatMap((t) => getOutline(t.id)).map((l, i) => ({
    id: l.id, title: l.title, slug: l.id.split("/")[1], track: l.id.split("/")[0], skills: l.skills, prerequisites: l.prerequisites,
    depths: ["overview", "engineer", "deep"], order: 1000 + i,
  }) as unknown as TopicMeta);
  const all = [...written, ...planned];
  const { nodes } = computeRoadmap(profile, all);
  const isWritten = new Set(written.map((t) => t.id));
  const trackTitle = Object.fromEntries(getTracks().map((t) => [t.id, t.title]));
  const items: RoadmapItem[] = nodes.map((n) => ({
    ...n,
    track: trackTitle[n.id.split("/")[0]] ?? n.id.split("/")[0],
    href: isWritten.has(n.id) ? `/${n.id}/` : null,
  }));
  const skills = getSkills();

  return (
    <div className="wrap">
      <section className="hero">
        <span className="label">Roadmap</span>
        <h1>{profile.title}</h1>
        <p>{profile.summary}</p>
        <ul className="goal-list">
          {profile.goals.map((g) => (
            <li key={g.skill}><b>{skills[g.skill]?.title ?? g.skill}</b> <span className="badge">{g.depth}</span> {g.why}</li>
          ))}
        </ul>
      </section>
      <RoadmapView items={items} />
    </div>
  );
}
