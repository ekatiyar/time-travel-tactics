# /// script
# dependencies = ["playwright"]
# ///
"""Smoke-check the live PeerChannel transport against real nostr relays.

Opens the turn_transport prototype in two headless Chromium pages, builds a
PeerChannel directly (bypassing the UI) in each, and checks that they find
each other and exchange a message over the real network. Slow and dependent
on relay availability by design, so it is NOT picked up by run_tests.py (that
only runs tests.js and tests.include) and must be run on its own:

    uv run --with playwright python prototypes/turn_transport/live_check.py [timeout_seconds]

timeout_seconds (default 60) bounds both the wait for a peer and the wait for
the message exchange. A pass here only proves two pages on this one machine
can reach each other through the relay; it says nothing about NAT traversal
between two separate players on separate networks.
"""
import pathlib
import random
import sys
import time

from playwright.sync_api import sync_playwright

HERE = pathlib.Path(__file__).parent
PAGE = HERE / "tbtt_prototype_turn_transport.html"

BUILD_CHANNEL = """(roomId) => {
    const {PeerChannel} = window.TBTT_TRANSPORT;
    const ch = PeerChannel(roomId);
    window.__seen = [];
    window.__status = [];
    ch.onMessage = t => window.__seen.push(t);
    ch.onStatus  = s => window.__status.push(s);
    window.__ch = ch;
}"""


def wait_for(page, predicate, timeout):
    """Poll predicate(page) until true or timeout (seconds). Returns elapsed or None."""
    start = time.monotonic()
    while time.monotonic() - start < timeout:
        if predicate(page):
            return time.monotonic() - start
        time.sleep(0.5)
    return None


def has_peer(page):
    return page.evaluate("window.__status.some(s => s.peers.length > 0)")


def saw(page, text):
    return page.evaluate("t => window.__seen.includes(t)", text)


def last_status(page):
    return page.evaluate("window.__status[window.__status.length - 1] || null")


def collect_console(page, errors, console_errors):
    page.on("pageerror", lambda e: errors.append(str(e)))
    page.on("console", lambda m: console_errors.append(m.text) if m.type == "error" else None)


def main() -> int:
    timeout = float(sys.argv[1]) if len(sys.argv) > 1 else 60.0
    room_id = f"live-check-{int(time.time())}-{random.randrange(1 << 32):08x}"

    errors_a, errors_b = [], []
    console_a, console_b = [], []

    with sync_playwright() as p:
        browser = p.chromium.launch()
        page_a = browser.new_page()
        page_b = browser.new_page()
        collect_console(page_a, errors_a, console_a)
        collect_console(page_b, errors_b, console_b)

        page_a.goto(PAGE.as_uri())
        page_b.goto(PAGE.as_uri())
        page_a.evaluate(BUILD_CHANNEL, room_id)
        page_b.evaluate(BUILD_CHANNEL, room_id)

        peer_time_a = wait_for(page_a, has_peer, timeout)
        peer_time_b = wait_for(page_b, has_peer, timeout)

        both_peered = peer_time_a is not None and peer_time_b is not None
        a_to_b_time = b_to_a_time = None
        if both_peered:
            page_a.evaluate("window.__ch.send('ping-from-a')")
            page_b.evaluate("window.__ch.send('ping-from-b')")
            a_to_b_time = wait_for(page_b, lambda pg: saw(pg, "ping-from-a"), timeout)
            b_to_a_time = wait_for(page_a, lambda pg: saw(pg, "ping-from-b"), timeout)

        status_a = last_status(page_a)
        status_b = last_status(page_b)

        page_a.evaluate("window.__ch.close()")
        page_b.evaluate("window.__ch.close()")
        browser.close()

    def fmt_time(t):
        return f"{t:.1f}s" if t is not None else f"no peer in {timeout:.0f}s"

    print(f"room: {room_id}")
    print(f"page A: peer in {fmt_time(peer_time_a)}")
    print(f"page B: peer in {fmt_time(peer_time_b)}")
    if both_peered:
        print(f"a -> b: {'landed in ' + fmt_time(a_to_b_time) if a_to_b_time is not None else f'did not land in {timeout:.0f}s'}")
        print(f"b -> a: {'landed in ' + fmt_time(b_to_a_time) if b_to_a_time is not None else f'did not land in {timeout:.0f}s'}")
    else:
        print("message exchange: skipped, at least one page never saw a peer")
    print(f"final status A: {status_a}")
    print(f"final status B: {status_b}")

    for label, errs, cons in (("A", errors_a, console_a), ("B", errors_b, console_b)):
        for e in errs:
            print(f"page {label} pageerror: {e}")
        for c in cons:
            print(f"page {label} console error: {c}")

    ok = both_peered and a_to_b_time is not None and b_to_a_time is not None
    if not ok:
        if not both_peered:
            print("FAIL: peers did not find each other")
        else:
            print("FAIL: message exchange did not complete in both directions")
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
