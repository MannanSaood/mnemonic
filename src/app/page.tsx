import Link from "next/link";
import { getOutline, getTracks, listRoadmaps, listTopics } from "@/lib/content";

export default function Home() {
  const tracks = getTracks();
  const topics = listTopics();
  const roadmaps = listRoadmaps();
  return (
    <div className="wrap">
      <section className="hero">
        <span className="label">Free · interactive · Go, Python, TypeScript, Rust</span>
        <h1>Learn how software works by changing it.</h1>
        <p>
          Each lesson starts with working code, sends it a realistic change request and shows what the change costs.
          Then you morph the design, follow one call through it, and run it yourself in a playground.
        </p>
      </section>

      <div className="cards">
        {tracks.map((tr) => {
          const ready = topics.filter((t) => t.track === tr.id).length;
          const planned = getOutline(tr.id).length;
          return (
            <Link key={tr.id} href={`/${tr.id}/`} className={"card" + (ready ? "" : " planned")}>
              <span className="label">{ready ? `${ready} lesson${ready === 1 ? "" : "s"} ready` : "Coming soon"}{planned ? ` · ${planned} planned` : ""}</span>
              <h2>{tr.title}</h2>
              <p>{tr.summary}</p>
            </Link>
          );
        })}
      </div>

      {roadmaps.length > 0 && (
        <section className="home-roadmaps">
          <span className="label">Roadmaps</span>
          <h2>Pick a goal, get an ordered path</h2>
          <p>A roadmap orders the lessons a role needs, prerequisites first, at the depth that role needs, and says why each one is there.</p>
          <ul className="topic-list">
            {roadmaps.map((r) => (
              <li key={r.id}><Link href={`/roadmaps/${r.id}/`}><span><span className="t">{r.title}</span><span className="s">{r.summary}</span></span><span className="progress-pill">Open</span></Link></li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}
