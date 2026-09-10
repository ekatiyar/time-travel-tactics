# /// script
# dependencies = ["playwright"]
# ///
"""Run a prototype's tests.js against the engine inside its HTML file.

No node on this machine, so headless Chromium runs it. Load the page,
inject tests.js, evaluate. Usage:
    uv run --with playwright python run_tests.py [prototype_dir]

prototype_dir defaults to play and is resolved against this script's
directory. The page is whichever single .html file the directory holds.

If the prototype directory has a tests.include file, it lists other test
files (one path per line, relative to the prototype directory, '#' comments
allowed) to run against the same page before tests.js. Each one runs on its
own, because every test file defines a global runTests and the next
injection overwrites it.
"""
import pathlib
import sys

from playwright.sync_api import sync_playwright

HERE = pathlib.Path(__file__).parent
DEFAULT_PROTOTYPE = "play"


def main() -> int:
    target = pathlib.Path(sys.argv[1] if len(sys.argv) > 1 else DEFAULT_PROTOTYPE)
    if not target.is_absolute():
        target = HERE / target

    if not target.is_dir():
        print(f"missing prototype directory {target}")
        return 1

    pages = sorted(target.glob("*.html"))
    if len(pages) != 1:
        found = ", ".join(p.name for p in pages) or "nothing"
        print(f"expected exactly one .html in {target}, found {found}")
        return 1
    PAGE = pages[0]

    TESTS = target / "tests.js"
    if not TESTS.exists():
        print(f"missing {TESTS}")
        return 1

    includes = []
    include_file = target / "tests.include"
    if include_file.exists():
        for line in include_file.read_text().splitlines():
            line = line.strip()
            if not line or line.startswith("#"):
                continue
            included = target / line
            if not included.exists():
                print(f"missing included test file {included}")
                return 1
            includes.append(included)

    all_results = []
    with sync_playwright() as p:
        browser = p.chromium.launch()
        page = browser.new_page()
        errors = []
        page.on("pageerror", lambda e: errors.append(str(e)))
        page.goto(PAGE.as_uri())
        for included in includes + [TESTS]:
            page.add_script_tag(path=str(included))
            all_results.extend(page.evaluate("runTests()")["results"])
        browser.close()

    for e in errors:
        print(f"page error: {e}")

    for r in all_results:
        if r["ok"]:
            print(f"  ok   {r['name']}")
        else:
            print(f"  FAIL {r['name']}\n         {r['error']}")

    passed = sum(1 for r in all_results if r["ok"])
    total = len(all_results)
    print(f"\n{passed}/{total} passed")
    return 0 if passed == total and not errors else 1


if __name__ == "__main__":
    sys.exit(main())
