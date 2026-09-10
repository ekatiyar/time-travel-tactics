# /// script
# dependencies = ["playwright"]
# ///
"""Smoke-check the two-phase turn handshake over real nostr relays.

Opens the prototype in two headless Chromium pages and builds a real Session
over a real PeerChannel in each, bypassing the UI. Then it drives two full
turns. Each side claims a colour and commits. One commitment alone must move
nothing; the second must resolve the turn on both sides with matching state.
It also checks the wire: every string either page sends must parse as a
claim, a commitment or a reveal, and each side must send exactly one
commitment and one reveal per turn.

Slow and dependent on relay availability, so run_tests.py does not pick it up
(that runs tests.js and tests.include only). Run it on its own:

    uv run --with playwright python play/live_check.py [timeout_seconds]

timeout_seconds (default 60) bounds each wait: for a peer, for a claim to
cross, for a commitment to land, and for a turn to resolve. A pass proves two
pages on this one machine can reach each other through the relay and complete
the handshake. It says nothing about NAT traversal between separate players on
separate networks.
"""
import pathlib
import random
import re
import sys
import time

from playwright.sync_api import sync_playwright

HERE = pathlib.Path(__file__).parent
PAGE = HERE / "index.html"

CLAIM_RE = re.compile(r"^!")
COMMIT_RE = re.compile(r"^#\d{1,4}[CPTA]:[0-9a-f]{32}$")
REVEAL_RE = re.compile(r"^.*\|[0-9a-f]{32}$")

BUILD_SESSION = """(roomId) => {
    const {Session, PeerChannel} = window.TBTT_TRANSPORT;
    const {Match} = window.TBTT;
    const cfg = {w: 16, h: 9, wallPct: 0, seed: 'live', cap: 40, roster: ['C', 'P']};
    const ch = PeerChannel(roomId);
    window.__sent = [];
    const raw = ch.send.bind(ch);
    ch.send = t => { window.__sent.push(t); return raw(t); };
    window.__s = Session.open({match: Match.fromConfig(cfg), channel: ch, onChange() {}});
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
    return page.evaluate("window.__s.view().status === 'live' && window.__s.view().peers.length > 0")


def has_both_claims(page):
    return page.evaluate("Object.keys(window.__s.claims()).length >= 2")


def coral_not_waited_on(page):
    return page.evaluate("window.__s.view().waiting.indexOf('C') < 0")


def turn_is(page, n):
    return page.evaluate(f"window.__s.view().turn === {n}")


def view_hash(page):
    return page.evaluate("window.__s.view().hash")


def view_turn(page):
    return page.evaluate("window.__s.view().turn")


def sent_messages(page):
    return page.evaluate("window.__sent")


def commit(page, action):
    page.evaluate(f"async () => {{ await window.__s.commit('{action}'); }}")


def collect_console(page, errors, console_errors):
    page.on("pageerror", lambda e: errors.append(str(e)))
    page.on("console", lambda m: console_errors.append(m.text) if m.type == "error" else None)


def check_wire_discipline(sent):
    """Every message must be a claim, commitment, or reveal."""
    bad = [t for t in sent if not (CLAIM_RE.match(t) or COMMIT_RE.match(t) or REVEAL_RE.match(t))]
    return bad


def count_per_turn(sent):
    """How many commitments and reveals each page sent, ignoring claims."""
    commits = sum(1 for t in sent if COMMIT_RE.match(t))
    reveals = sum(1 for t in sent if REVEAL_RE.match(t) and not COMMIT_RE.match(t))
    return commits, reveals


def main() -> int:
    timeout = float(sys.argv[1]) if len(sys.argv) > 1 else 60.0
    room_id = f"live-check-{int(time.time())}-{random.randrange(1 << 32):08x}"

    errors_a, errors_b = [], []
    console_a, console_b = [], []
    fail = None

    with sync_playwright() as p:
        browser = p.chromium.launch()
        page_a = browser.new_page()
        page_b = browser.new_page()
        collect_console(page_a, errors_a, console_a)
        collect_console(page_b, errors_b, console_b)

        page_a.goto(PAGE.as_uri())
        page_b.goto(PAGE.as_uri())
        page_a.evaluate(BUILD_SESSION, room_id)
        page_b.evaluate(BUILD_SESSION, room_id)

        peer_time_a = wait_for(page_a, has_peer, timeout)
        peer_time_b = wait_for(page_b, has_peer, timeout)
        both_peered = peer_time_a is not None and peer_time_b is not None
        if not both_peered:
            fail = "peers did not find each other"

        claim_time = None
        if not fail:
            page_a.evaluate("window.__s.claim('C', 'Rook')")
            page_b.evaluate("window.__s.claim('P', 'Vale')")
            claim_time_a = wait_for(page_a, has_both_claims, timeout)
            claim_time_b = wait_for(page_b, has_both_claims, timeout)
            claim_time = claim_time_a if claim_time_a is not None else None
            if claim_time_a is None or claim_time_b is None:
                fail = "claims did not cross the wire"

        # Turn 0.
        commit0_time = resolve0_time = None
        if not fail:
            commit(page_a, "D")
            commit0_time = wait_for(page_b, coral_not_waited_on, timeout)
            if commit0_time is None:
                fail = "page B never saw coral's commitment (waiting list did not clear)"
            elif view_turn(page_b) != 0:
                fail = "turn advanced on a lone commitment, before the second side opened anything"

        if not fail:
            commit(page_b, "A")
            resolve0_time = wait_for(
                page_a, lambda pg: turn_is(pg, 1) and turn_is(page_b, 1), timeout
            )
            if resolve0_time is None:
                fail = "turn 0 did not resolve on both sides"
            elif view_hash(page_a) != view_hash(page_b):
                fail = "turn 0 resolved but the two sides disagree on state hash"

        # Turn 1: same shape, to exercise prune and the per-turn stores once the
        # playhead has moved.
        commit1_time = resolve1_time = None
        if not fail:
            commit(page_a, "D")
            commit1_time = wait_for(page_b, coral_not_waited_on, timeout)
            if commit1_time is None:
                fail = "page B never saw coral's second commitment"

        if not fail:
            commit(page_b, "A")
            resolve1_time = wait_for(
                page_a, lambda pg: turn_is(pg, 2) and turn_is(page_b, 2), timeout
            )
            if resolve1_time is None:
                fail = "turn 1 did not resolve on both sides"
            elif view_hash(page_a) != view_hash(page_b):
                fail = "turn 1 resolved but the two sides disagree on state hash"

        sent_a = sent_messages(page_a)
        sent_b = sent_messages(page_b)

        page_a.evaluate("window.__s.close()")
        page_b.evaluate("window.__s.close()")
        browser.close()

    def fmt_time(t):
        return f"{t:.1f}s" if t is not None else f"timed out after {timeout:.0f}s"

    print(f"room: {room_id}")
    print(f"page A: peer in {fmt_time(peer_time_a)}")
    print(f"page B: peer in {fmt_time(peer_time_b)}")
    print(f"claims crossed the wire: {fmt_time(claim_time)}")
    print(f"turn 0: commitment seen in {fmt_time(commit0_time)}, resolved in {fmt_time(resolve0_time)}")
    print(f"turn 1: commitment seen in {fmt_time(commit1_time)}, resolved in {fmt_time(resolve1_time)}")

    wire_ok = True
    if not fail:
        bad_a = check_wire_discipline(sent_a)
        bad_b = check_wire_discipline(sent_b)
        commits_a, reveals_a = count_per_turn(sent_a)
        commits_b, reveals_b = count_per_turn(sent_b)
        print(f"page A sent: {len(sent_a)} messages, {commits_a} commitments, {reveals_a} reveals")
        print(f"page B sent: {len(sent_b)} messages, {commits_b} commitments, {reveals_b} reveals")
        if bad_a or bad_b:
            wire_ok = False
            for t in bad_a:
                print(f"page A sent malformed message: {t!r}")
            for t in bad_b:
                print(f"page B sent malformed message: {t!r}")
        # Two turns played, one commitment and one reveal each, per page.
        if commits_a != 2 or reveals_a != 2 or commits_b != 2 or reveals_b != 2:
            wire_ok = False
            print("wire discipline: expected exactly 2 commitments and 2 reveals per page across 2 turns")
        if not fail and not wire_ok:
            fail = "wire discipline violated"

    for label, errs, cons in (("A", errors_a, console_a), ("B", errors_b, console_b)):
        for e in errs:
            print(f"page {label} pageerror: {e}")
        for c in cons:
            print(f"page {label} console error: {c}")

    ok = fail is None
    if not ok:
        print(f"FAIL: {fail}")
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
