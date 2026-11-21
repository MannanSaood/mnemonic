import Link from "next/link";
import { listRoadmaps } from "@/lib/content";

export const metadata = { title: "Roadmaps" };

export default function Roadmaps() {
  const list = listRoadmaps();
  return (
    <div className="wrap">
      <section className="hero">
        <span className="label">Roadmaps</span>
        <h1>Pick a goal, get an ordered path</h1>
        <p>Each roadmap is a goal: the skills a role needs, and how deep. Mnemonic turns it into an ordered list of lessons, prerequisites first, and tells you why each lesson is on it. Lessons you have already passed at the needed depth are marked so you can skip them.</p>
      </section>
      <ul className="topic-list" style={{ marginBottom: 64 }}>
        {list.map((r) => (
          <li key={r.id}><Link href={`/roadmaps/${r.id}/`}><span><span className="t">{r.title}</span><span className="s">{r.summary}</span></span><span className="progress-pill">{r.goals.length} skills</span></Link></li>
        ))}
      </ul>
    </div>
  );
}
