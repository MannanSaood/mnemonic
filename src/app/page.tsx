import Link from "next/link";
import { getTracks, listTopics } from "@/lib/content";
import { ProgressPill } from "@/components/ProgressPill";

export default function Home() {
  const tracks = getTracks();
  const topics = listTopics();
  return (
    <div className="wrap">
      <section className="hero">
        <span className="label">Free · interactive · Go, Python, TypeScript, Rust</span>
        <h1>Learn how software is designed, one change at a time.</h1>
        <p>
          Each lesson starts with working code, sends it a realistic change request, and shows what the change costs.
          Then you morph the design, watch one call move through it, and see the same request again.
        </p>
      </section>
      <div className="tracks">
        {tracks.map((tr) => {
          const list = topics.filter((t) => t.track === tr.id);
          const live = tr.status === "live" && list.length > 0;
          return (
            <section key={tr.id} className={"track" + (live ? "" : " planned")}>
              <div>
                <h2>{live ? <Link href={`/${tr.id}/`} style={{ color: "inherit", textDecoration: "none" }}>{tr.title}</Link> : tr.title}</h2>
                <p>{tr.summary}</p>
              </div>
              {live ? (
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
              ) : (
                <span className="soon">Planned</span>
              )}
            </section>
          );
        })}
      </div>
    </div>
  );
}
