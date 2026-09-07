# /// script
# dependencies = ["playwright"]
# ///
"""Run prototype/tests.js against the engine inside the prototype HTML file.

No node on this machine, so the engine is exercised in headless Chromium:
load the page, inject tests.js, evaluate. Usage:
    uv run --with playwright python prototype/run_tests.py
"""
import pathlib
import sys

from playwright.sync_api import sync_playwright

HERE = pathlib.Path(__file__).parent
PAGE = HERE / "tbtt_prototype_time_travel_only.html"
TESTS = HERE / "tests.js"


def main() -> int:
    if not PAGE.exists():
        print(f"missing {PAGE}")
        return 1

    with sync_playwright() as p:
        browser = p.chromium.launch()
        page = browser.new_page()
        errors = []
        page.on("pageerror", lambda e: errors.append(str(e)))
        page.goto(PAGE.as_uri())
        page.add_script_tag(path=str(TESTS))
        result = page.evaluate("runTests()")
        browser.close()

    for e in errors:
        print(f"page error: {e}")

    for r in result["results"]:
        if r["ok"]:
            print(f"  ok   {r['name']}")
        else:
            print(f"  FAIL {r['name']}\n         {r['error']}")

    passed = sum(1 for r in result["results"] if r["ok"])
    total = len(result["results"])
    print(f"\n{passed}/{total} passed")
    return 0 if passed == total and not errors else 1


if __name__ == "__main__":
    sys.exit(main())
