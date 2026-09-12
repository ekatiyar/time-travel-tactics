"""Build the current site and tagged releases."""
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


def build(tree: pathlib.Path) -> str | None:
    """Build a tree with package.json, returning an error on failure."""
    if not (tree / "package.json").is_file():
        return None
    for cmd in (["npm", "ci", "--omit=dev"], ["npm", "run", "build"]):
        result = subprocess.run(cmd, cwd=tree, capture_output=True, text=True)
        if result.returncode != 0:
            return f"{' '.join(cmd)} exited {result.returncode}\n{result.stdout}{result.stderr}"
    return None


BUILD_INPUTS = ("node_modules", "package.json", "package-lock.json", "tsconfig.json")


def clean_build_inputs(tree: pathlib.Path) -> None:
    """Remove build inputs from the published tree."""
    for name in BUILD_INPUTS:
        path = tree / name
        if path.is_dir():
            shutil.rmtree(path)
        elif path.exists():
            path.unlink()


ATTR_REF = re.compile(r'''\b(?:src|href)=["']([^"']+)["']''')
JS_REF = re.compile(r'''\b(?:from|import)\s*\(?\s*["'](\.\.?/[^"']+)["']''')
SCHEME = re.compile(r"^[a-zA-Z][a-zA-Z0-9+.-]*:")


def local_ref(value: str) -> str | None:
    """Return a local reference without its query or fragment."""
    if not value or value.startswith(("#", "//", "/")) or SCHEME.match(value):
        return None
    return value.split("#", 1)[0].split("?", 1)[0] or None


def missing_refs(tree: pathlib.Path, entry: str) -> list[str]:
    """Return unresolved local references reachable from entry."""
    start = tree / entry
    if not start.is_file():
        return [entry]

    tree = tree.resolve()
    seen = {start.resolve()}
    worklist = [start]
    missing = []
    while worklist:
        current = worklist.pop()
        text = current.read_text(errors="replace")
        refs = ATTR_REF.findall(text)
        if current.suffix in (".js", ".mjs"):
            refs += JS_REF.findall(text)
        for raw in refs:
            rel = local_ref(raw)
            if rel is None:
                continue
            target = (current.parent / rel).resolve()
            try:
                target.relative_to(tree)
            except ValueError:
                missing.append(raw)
                continue
            if not target.is_file():
                missing.append(raw)
            elif target not in seen:
                seen.add(target)
                worklist.append(target)
    return missing


def read_tags() -> list[dict]:
    # Only annotated tags have release metadata.
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

    error = build(out)
    if error:
        print(f"root build failed:\n{error}")
        return 1
    clean_build_inputs(out)
    unresolved = missing_refs(out, DEFAULT_ENTRY)
    if unresolved:
        print(f"root entry {DEFAULT_ENTRY} is missing: {', '.join(unresolved)}")
        return 1

    kept = []
    for release in read_tags():
        tag, entry = release["tag"], release["entry"]
        if not release.pop("annotated") or not release["title"]:
            print(f"tag {tag} carries no message of its own. Annotate it: git tag -a -f {tag}")
            return 1
        dest = out / "v" / tag
        export(tag, dest)

        error = build(dest)
        if error:
            print(f"tag {tag} build failed, dropping it:\n{error}")
            shutil.rmtree(dest)
            continue
        clean_build_inputs(dest)
        unresolved = missing_refs(dest, entry)
        if unresolved:
            print(f"tag {tag} entry {entry} is missing: {', '.join(unresolved)}. dropping it")
            shutil.rmtree(dest)
            continue

        kept.append(release)
        print(f"  v/{tag}  {entry}")

    (out / "releases.json").write_text(json.dumps(kept, indent=2) + "\n")
    print(f"\n{len(kept)} releases -> {out}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
