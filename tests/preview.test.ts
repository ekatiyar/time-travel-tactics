import { it } from 'node:test';
import assert from 'node:assert/strict';
import { Match, previewBoard, worldTurn } from '../play/src/engine/index.js';
import type { Color } from '../play/src/engine/index.js';

it('previews the exact generated match layout across sizes, modes, rosters, and seeds', () => {
  for (const [w, h] of [[9, 7], [16, 9], [24, 13], [5, 5], [64, 64]] as const) {
    for (const mode of ['bootstrap', 'sandbox'] as const) {
      for (const roster of [['C', 'P'], ['C', 'P', 'T', 'A']] as Color[][]) {
        for (const seed of ['preview', 'another']) {
          const cfg = { mode, w, h, roster, seed, wallPct: 45, cap: 80 };
          const board = previewBoard(cfg), view = Match.fromConfig(cfg).view('C');
          assert.equal(board.w, view.w); assert.equal(board.h, view.h);
          assert.deepEqual(board.walls, view.walls);
          assert.deepEqual(board.spawns, view.spawns);
          assert.deepEqual(board.center, view.center);
          assert.equal(board.keyAtCenter, view.keyAtCenter.includes(worldTurn(0)));
          assert.deepEqual(board.roster, roster);
        }
      }
    }
  }
});

it('rejects invalid configuration instead of rendering a different board', () => {
  assert.throws(() => previewBoard({ mode: 'bootstrap', w: 4, h: 9, seed: 'test', wallPct: 11, cap: 43, roster: ['C', 'P'] }), /5x5/);
});
