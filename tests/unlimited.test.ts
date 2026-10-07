import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { Match, Timeline, Wire, metaTurn } from '../play/src/engine/index.js';

describe('unlimited turns', () => {
  for (const mode of ['sandbox', 'bootstrap'] as const) {
    it(`${mode} continues beyond the former maximum and replays every turn`, () => {
      const m = Match.fromConfig({ mode, w: 7, h: 7, wallPct: 0, seed: 'unlimited', roster: ['C', 'P'] });
      for (let turn = 0; turn < 405; turn++) {
        const hash = m.stateHash();
        for (const color of ['C', 'P']) assert.ok(m.submit({ turn, color, action: 'H', hash }).ok);
      }
      assert.equal(m.currentTurn(), 405);
      assert.deepEqual(m.outcome(), { status: 'running' });
      assert.equal(m.view('C').me.horizon, 405);
      assert.equal(m.legalActions('C').H, null);
      assert.ok(!('cap' in m.config()));
      assert.ok(!('cap' in m.view('C')));
      const saved = Match.fromExport(m.export());
      assert.ok(saved.ok, saved.error);
      assert.deepEqual(saved.value.match.view('C'), m.view('C'));
    });
  }

  it('transmits actions beyond four-digit turns', () => {
    const action = { turn: metaTurn(10000), color: 'C' as const, action: 'H' as const, hash: 'a3f2' };
    const decoded = Wire.decodeAction(Wire.encodeAction(action));
    assert.ok(decoded.ok, decoded.error);
    assert.deepEqual(decoded.value, { ...action, name: null });
  });

  it('key fronts keep advancing beyond the former maximum', () => {
    const tape = new Timeline<string>(String);
    const front = tape.record(399, 'key', metaTurn(399));
    tape.advance(2);
    tape.advance(2);
    assert.equal(front.front, 403);
    assert.equal(tape.at(403)?.event, front);
  });
});
