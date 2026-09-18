import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { Timeline, metaTurn } from '../play/src/engine/index.js';
import type { TimelineEvent } from '../play/src/engine/index.js';

const BIG = 1000;
const T = metaTurn(20);

function tl(): Timeline<string> {
  return new Timeline<string>(JSON.stringify);
}

function fronts(events: readonly TimelineEvent<string>[]): number[] {
  return events.map((e) => e.front);
}

function counting(events: readonly TimelineEvent<string>[]): boolean[] {
  return events.map((e) => e.counts);
}

function reads(t: Timeline<string>, i: number, event: TimelineEvent<string>): void {
  const r = t.at(i);
  assert.ok(r, `at(${i}) should read an event`);
  assert.equal(r.event, event, `at(${i}) reads ${event.value}`);
  assert.equal(r.offset, i - event.origin, `at(${i}) offset`);
}

describe('Timeline: empty', () => {
  it('reads null everywhere and has no events', () => {
    const t = tl();
    assert.equal(t.at(0), null);
    assert.equal(t.at(-5), null);
    assert.equal(t.at(17), null);
    assert.deepEqual(t.events(), []);
  });

  it('has a stable string digest', () => {
    const t = tl();
    const d = t.digest();
    assert.equal(typeof d, 'string');
    assert.equal(t.digest(), d);
    assert.equal(tl().digest(), d);
  });
});

describe('Timeline: record', () => {
  it('returns a counting event whose front is its origin', () => {
    const t = tl();
    const e = t.record(3, 'b', T);
    assert.equal(e.origin, 3);
    assert.equal(e.front, 3);
    assert.equal(e.counts, true);
    assert.equal(e.value, 'b');
    assert.equal(e.turn, T);
    assert.deepEqual(t.events(), [e]);
  });

  it('is readable at its origin with offset 0 and nowhere else before advancing', () => {
    const t = tl();
    const e = t.record(3, 'b', T);
    reads(t, 3, e);
    assert.equal(t.at(4), null);
    assert.equal(t.at(2), null);
  });
});

describe('Timeline: advance', () => {
  it('moves the front by step and extends coverage', () => {
    const t = tl();
    const e = t.record(3, 'b', T);
    assert.deepEqual(t.advance(2, BIG), []);
    assert.equal(e.front, 5);
    reads(t, 5, e);
    reads(t, 4, e);
    assert.equal(t.at(6), null);
    assert.deepEqual(t.advance(2, BIG), []);
    assert.equal(e.front, 7);
    reads(t, 7, e);
    assert.equal(t.at(8), null);
  });

  it('clamps the front at the cap', () => {
    const t = tl();
    const e = t.record(3, 'b', T);
    t.advance(2, 6);
    assert.equal(e.front, 5);
    t.advance(2, 6);
    assert.equal(e.front, 6);
    t.advance(2, 6);
    assert.equal(e.front, 6);
    assert.equal(e.counts, true);
    reads(t, 6, e);
    assert.equal(t.at(7), null);
  });
});

describe('Timeline: break on pass', () => {
  it('does not break an event whose origin is at or before the old front', () => {
    const t = tl();
    const a = t.record(3, 'a', T);
    t.advance(2, BIG);
    const b = t.record(5, 'b', metaTurn(21));
    const c = t.record(5, 'c', metaTurn(21));
    assert.deepEqual(t.advance(2, BIG), []);
    assert.equal(a.front, 7);
    assert.equal(b.front, 7);
    assert.equal(c.front, 7);
    assert.deepEqual(counting(t.events()), [true, true, true]);
  });
});

describe('Timeline: frozen coverage', () => {
  it('prefers a counting event where coverage overlaps and falls back to the broken one', () => {
    const t = tl();
    const b = t.record(3, 'b', T);
    t.advance(2, BIG);
    const c = t.record(8, 'c', metaTurn(21));
    t.advance(2, BIG);
    t.advance(2, BIG);
    assert.equal(c.counts, false);
    assert.equal(c.front, 10);
    assert.equal(b.front, 9);
    // 8 and 9: both cover; 10: only broken c.
    reads(t, 8, b);
    reads(t, 9, b);
    reads(t, 10, c);
    assert.equal(t.at(11), null);
  });

  it('reads the broken event at its own origin only if nothing counting covers it', () => {
    const t = tl();
    const b = t.record(3, 'b', T);
    t.advance(2, BIG);
    const c = t.record(7, 'c', metaTurn(21));
    t.advance(2, BIG);
    assert.equal(c.counts, false);
    assert.equal(b.front, 7);
    reads(t, 7, b);
    t.advance(2, 7);
    reads(t, 7, b);
  });
});

describe('Timeline: newest counting lookup', () => {
  it('reads the newest counting event covering an index', () => {
    const t = tl();
    const a = t.record(3, 'a', T);
    t.advance(2, BIG);
    assert.equal(a.front, 5);
    const b = t.record(4, 'b', metaTurn(21));
    reads(t, 3, a);
    reads(t, 4, b);
    reads(t, 5, a);

    assert.deepEqual(t.advance(2, BIG), []);
    assert.equal(a.front, 7);
    assert.equal(b.front, 6);
    assert.equal(a.counts, true);
    assert.equal(b.counts, true);
    reads(t, 3, a);
    reads(t, 4, b);
    reads(t, 5, b);
    reads(t, 6, b);
    reads(t, 7, a);
    assert.equal(t.at(8), null);
  });
});

describe('Timeline: creation-order sweep', () => {
  it('moves every counting event in creation order and reports breaks in order', () => {
    const t = tl();
    const a = t.record(0, 'a', T);
    const b = t.record(1, 'b', T);
    const c = t.record(4, 'c', T);
    const d = t.record(5, 'd', T);
    const broken = t.advance(2, BIG);
    assert.deepEqual(broken, [b, d]);
    assert.deepEqual(fronts(t.events()), [2, 1, 6, 5]);
    assert.deepEqual(counting(t.events()), [true, false, true, false]);
    assert.deepEqual(t.events(), [a, b, c, d]);
  });

  it('never moves broken events on later advances', () => {
    const t = tl();
    t.record(0, 'a', T);
    const b = t.record(1, 'b', T);
    t.record(10, 'c', T);
    const d = t.record(11, 'd', T);
    t.advance(2, BIG);
    assert.deepEqual(t.advance(2, BIG), []);
    assert.deepEqual(fronts(t.events()), [4, 1, 14, 11]);
    assert.deepEqual(t.advance(3, BIG), []);
    assert.deepEqual(fronts(t.events()), [7, 1, 17, 11]);
    assert.equal(b.front, 1);
    assert.equal(d.front, 11);
  });
});

describe('Timeline: example 2 arithmetic', () => {
  it('B at 3 and C at 9, one advance per turn from turn 20', () => {
    const t = tl();
    const b = t.record(3, 'b', T);
    const c = t.record(9, 'c', T);
    const expectB = [5, 7, 9, 11, 13];
    const expectCcounts = [true, true, false, false, false];
    const expectCfront = [11, 13, 13, 13, 13];
    for (let i = 0; i < 5; i++) {
      const broken = t.advance(2, BIG);
      assert.deepEqual(broken, i === 2 ? [c] : [], `advance ${i + 1} (turn ${20 + i}) broken list`);
      assert.equal(b.front, expectB[i], `B front after advance ${i + 1}`);
      assert.equal(c.counts, expectCcounts[i], `C counts after advance ${i + 1}`);
      assert.equal(c.front, expectCfront[i], `C front after advance ${i + 1}`);
    }
    reads(t, 13, b);
    assert.equal(t.at(14), null);
  });
});

describe('Timeline: same-turn overtaking', () => {
  for (const cOrigin of [6, 7]) {
    it(`breaks C at ${cOrigin} in the sweep of the turn it was recorded`, () => {
      const t = tl();
      const b = t.record(3, 'b', T);
      t.advance(2, BIG);
      const c = t.record(cOrigin, 'c', metaTurn(21));
      assert.deepEqual(t.advance(2, BIG), [c]);
      assert.equal(c.counts, false);
      assert.equal(c.front, cOrigin);
      assert.equal(b.counts, true);
      assert.equal(b.front, 7);
    });
  }

  it('C at 8 survives the sweep of its own turn and breaks on the next', () => {
    const t = tl();
    const b = t.record(3, 'b', T);
    t.advance(2, BIG);
    const c = t.record(8, 'c', metaTurn(21));
    assert.deepEqual(t.advance(2, BIG), []);
    assert.equal(c.counts, true);
    assert.deepEqual(t.advance(2, BIG), [c]);
    assert.equal(c.counts, false);
    assert.equal(b.front, 9);
  });
});

describe('Timeline: digest', () => {
  function base(): Timeline<string> {
    const t = tl();
    t.record(3, 'b', T);
    t.record(9, 'c', T);
    t.advance(2, BIG);
    return t;
  }

  it('is equal for identically built timelines', () => {
    assert.equal(base().digest(), base().digest());
  });

  it('differs with an extra event', () => {
    const t = base();
    t.record(20, 'd', T);
    assert.notEqual(t.digest(), base().digest());
  });

  it('differs when one is advanced further', () => {
    const t = base();
    t.advance(2, BIG);
    assert.notEqual(t.digest(), base().digest());
  });

  it('differs with a different value', () => {
    const t = tl();
    t.record(3, 'x', T);
    t.record(9, 'c', T);
    t.advance(2, BIG);
    assert.notEqual(t.digest(), base().digest());
  });

  it('differs with a different turn', () => {
    const t = tl();
    t.record(3, 'b', metaTurn(21));
    t.record(9, 'c', T);
    t.advance(2, BIG);
    assert.notEqual(t.digest(), base().digest());
  });

  it('differs when an event is broken versus counting', () => {
    const a = tl();
    a.record(3, 'b', T);
    a.record(5, 'c', T);
    a.advance(2, BIG);
    const b = tl();
    b.record(3, 'b', T);
    b.advance(2, BIG);
    b.record(5, 'c', T);
    // Same origins, fronts, turns and values; only c's counts differs.
    assert.deepEqual(fronts(a.events()), fronts(b.events()));
    assert.deepEqual(counting(a.events()), [true, false]);
    assert.deepEqual(counting(b.events()), [true, true]);
    assert.notEqual(a.digest(), b.digest());
  });
});

describe('Timeline: events()', () => {
  it('keeps broken events in creation order', () => {
    const t = tl();
    const b = t.record(3, 'b', T);
    t.advance(2, BIG);
    const c = t.record(6, 'c', metaTurn(21));
    const d = t.record(30, 'd', metaTurn(21));
    t.advance(2, BIG);
    assert.equal(c.counts, false);
    assert.deepEqual(t.events(), [b, c, d]);
    assert.deepEqual(t.events().map((e) => e.value), ['b', 'c', 'd']);
  });
});
