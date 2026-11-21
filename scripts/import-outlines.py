"""Turn the local curriculum notes (reference/notes/*.md, not in git) into committed lesson
outlines: content/outlines/<track>.yaml. Only ids, titles, one-line summaries, prerequisites and
skills are kept; book references are dropped. Run: python scripts/import-outlines.py"""
import os, re, sys

NOTES = os.path.join("reference", "notes")
OUT = os.path.join("content", "outlines")
os.makedirs(OUT, exist_ok=True)

def cells(line):
    parts = [c.strip() for c in line.strip().strip("|").split("|")]
    return parts

def find(header, *names):
    for i, h in enumerate(header):
        if h.lower().strip() in names:
            return i
    return None

def yq(s):
    s = s.replace("\\", "\\\\").replace('"', '\\"')
    return f'"{s}"'

summary_of = {}
for f in sorted(os.listdir(NOTES)):
    if not f.endswith(".md") or f == "README.md":
        continue
    text = open(os.path.join(NOTES, f), encoding="utf-8").read()
    m = re.search(r"^## 2\..*?(?=^## 3\.)", text, re.S | re.M)
    if not m:
        print("no outline:", f, file=sys.stderr)
        continue
    lines = m.group(0).splitlines()
    header = None
    rows = []
    for ln in lines:
        if ln.startswith("|") and header is None and re.search(r"\|\s*#\s*\|", ln):
            header = [h.lower() for h in cells(ln)]
            continue
        if header and re.match(r"^\|\s*\d+\s*\|", ln):
            rows.append(cells(ln))
    if not header or not rows:
        print("no table:", f, file=sys.stderr)
        continue
    ci = find(header, "id")
    ct = find(header, "title")
    cs = find(header, "summary", "one-line summary")
    cp = find(header, "p", "prereqs", "prerequisites")
    ck = find(header, "skills", "skill tags")
    byno = {}
    lessons = []
    for r in rows:
        no = r[0]
        lid = r[ci].strip("` ")
        byno[no] = lid
        lessons.append((no, lid, r[ct] if ct is not None else lid, r[cs] if cs is not None else "", r[cp] if cp is not None else "", r[ck] if ck is not None else ""))
    track = lessons[0][1].split("/")[0]
    out = [f"# Lesson outline for the {track} track, from the curriculum notes. Lessons not yet written show as coming soon.", "lessons:"]
    for no, lid, title, summ, pre, skills in lessons:
        reqs = []
        for tok in re.split(r"[,;]\s*", pre):
            tok = tok.strip().strip("` ")
            if not tok or tok.lower() in ("none", "-", "—"):
                continue
            if re.fullmatch(r"\d+", tok):
                if tok in byno:
                    reqs.append(byno[tok])
            elif "/" in tok:
                reqs.append(tok.split()[0].strip("`"))
        sk = [s.strip().strip("`") for s in re.split(r"[,;]\s*", skills) if s.strip()]
        title = title.replace("`", "")
        summ = summ.replace("`", "")
        out.append(f"  - id: {lid}")
        out.append(f"    title: {yq(title)}")
        if summ:
            out.append(f"    summary: {yq(summ)}")
        out.append(f"    prerequisites: [{', '.join(reqs)}]")
        out.append(f"    skills: [{', '.join(sk)}]")
    open(os.path.join(OUT, f"{track}.yaml"), "w", encoding="utf-8").write("\n".join(out) + "\n")
    print(f"{track}: {len(lessons)} lessons (from {f})")
