"""Build the published site: master's tip at the root, every release tag under v/.

Each annotated tag matching v* becomes a playable version at v/<tag>/, and its
message becomes a card on the front page. Subject line is the title, the body is
the blurb, and a trailing 'entry: <path>' line names the playable file inside
that tag's tree. Usage:
    python tools/build_site.py [--root-ref REF] [--out DIR]

--root-ref defaults to origin/master, which is what CI wants: a tag push checks
out the tag, but the root of the site must still be the tip. Pass HEAD to
preview locally, which builds your last commit, not your working tree.
"""
import argparse
import io
import json
import pathlib
import re
import shutil
import subprocess
import sys
import tarfile

ROOT = pathlib.Path(__file__).parent.parent
TAG_GLOB = "v*"
DEFAULT_ENTRY = "play/index.html"
ENTRY_LINE = re.compile(r"^entry:\s*(\S.*)$")
UNIT, RECORD = "\x1f", "\x1e"


def git(*args: str) -> str:
    return subprocess.run(
        ["git", *args], cwd=ROOT, check=True, capture_output=True, text=True
    ).stdout


def export(ref: str, dest: pathlib.Path) -> None:
    """Unpack a ref's tree into dest."""
    tar = subprocess.run(
        ["git", "archive", "--format=tar", ref],
        cwd=ROOT, check=True, capture_output=True,
    ).stdout
    dest.mkdir(parents=True, exist_ok=True)
    with tarfile.open(fileobj=io.BytesIO(tar)) as t:
        t.extractall(dest, filter="data")


def read_tags() -> list[dict]:
    # objecttype is 'tag' only when annotated. A lightweight tag has no message
    # of its own and git hands back the commit's, so the subject is never empty.
    fmt = UNIT.join(
        ["%(refname:short)", "%(objecttype)", "%(creatordate:short)",
         "%(contents:subject)", "%(contents:body)"]
    ) + RECORD
    out = git("for-each-ref", f"refs/tags/{TAG_GLOB}", "--sort=-v:refname", f"--format={fmt}")

    tags = []
    for record in out.split(RECORD):
        record = record.strip("\n")
        if not record:
            continue
        tag, objecttype, date, subject, body = record.split(UNIT)

        entry = DEFAULT_ENTRY
        kept = []
        for line in body.splitlines():
            match = ENTRY_LINE.match(line.strip())
            if match:
                entry = match.group(1).strip()
            else:
                kept.append(line)

        tags.append({
            "tag": tag,
            "annotated": objecttype == "tag",
            "title": subject.strip(),
            "blurb": " ".join(" ".join(kept).split()),
            "entry": entry,
            "date": date,
        })
    return tags


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--root-ref", default="origin/master")
    ap.add_argument("--out", default=ROOT / "_site", type=pathlib.Path)
    args = ap.parse_args()

    out = args.out
    if out.exists():
        shutil.rmtree(out)
    export(args.root_ref, out)
    print(f"root  {args.root_ref}")

    releases = read_tags()
    for release in releases:
        tag, entry = release["tag"], release["entry"]
        if not release.pop("annotated") or not release["title"]:
            print(f"tag {tag} carries no message of its own. Annotate it: git tag -a -f {tag}")
            return 1
        dest = out / "v" / tag
        export(tag, dest)
        if not (dest / entry).is_file():
            print(f"tag {tag} names entry {entry}, which is not in its tree")
            return 1
        print(f"  v/{tag}  {entry}")

    (out / "releases.json").write_text(json.dumps(releases, indent=2) + "\n")
    print(f"\n{len(releases)} releases -> {out}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
