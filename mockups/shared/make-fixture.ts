// Search random scripts for a rich bootstrap state and dump Coral's view as JSON.
import { writeFileSync } from 'node:fs';
import { Match } from '../../play/src/engine/index.js';
import type { ConfigInput, View } from '../../play/src/engine/index.js';

const cfg: ConfigInput = { mode: 'bootstrap', w: 16, h: 9, wallPct: 11, seed: 'demo', cap: 43, roster: ['C', 'P', 'T', 'A'] };

function rnd<T>(a: T[]): T { return a[Math.floor(Math.random() * a.length)]!; }

function towards(v: View, c: string, tx: number, ty: number): string[] {
  const me = v.bodies.find((b) => b.color === c && b.live)!;
  const out: string[] = [];
  if (tx > me.x) out.push('D'); if (tx < me.x) out.push('A');
  if (ty > me.y) out.push('S'); if (ty < me.y) out.push('W');
  return out;
}

function score(v: View): number {
  const grabs = v.events.filter((e) => e.kind === 'grab');
  const steals = grabs.filter((e) => e.by);
  const inv = v.events.filter((e) => e.kind === 'inverted' && e.color === 'C');
  const frontsToMe = v.fronts.filter((f) => f.target === 'C' && f.gap > 0);
  const opposing = v.bodies.filter((b) => b.dir !== v.me.dir).length;
  let s = 0;
  const cGrab = grabs.some((e) => e.color === 'C');
  const visiblePickup = v.keyAtCenter.length < v.me.horizon + 1;
  if (!cGrab || !visiblePickup) return 0;
  s += 10;
  if (v.me.t >= 3 && v.me.t <= v.me.horizon - 2) s += 2;
  if (v.me.x > 0 && v.me.y > 0 && v.me.x < v.w - 1 && v.me.y < v.h - 1) s += 1;
  if (grabs.length) s += 3;
  if (steals.length) s += 5;
  if (inv.length) s += 3;
  if (frontsToMe.length) s += 6;
  if (v.keys.some((k) => k.color === 'C')) s += 2;
  if (v.fronts.length >= 2) s += 2;
  if (opposing > 2) s += 1;
  if (v.events.some((e) => e.kind === 'blocked')) s += 1;
  return s;
}

let best: { s: number; log: Record<string, string>[]; view: View } | null = null;
for (let attempt = 0; attempt < 12000; attempt++) {
  const m = Match.fromConfig(cfg);
  const log: Record<string, string>[] = [];
  const turns = 12 + Math.floor(Math.random() * 6);
  for (let i = 0; i < turns; i++) {
    const acts: Record<string, string> = {};
    for (const c of cfg.roster) {
      const v = m.view(c);
      const legal = m.legalActions(c);
      let pool: string[];
      const goal = towards(v, c, v.center[0], v.center[1]);
      if (i < 6 && goal.length && Math.random() < 0.85) pool = goal;
      else if (Math.random() < 0.12) pool = ['I'];
      else pool = ['W', 'A', 'S', 'D', 'H', 'W', 'A', 'S', 'D'];
      pool = pool.filter((a) => legal[a as keyof typeof legal] === null);
      if (!pool.length) pool = Object.entries(legal).filter(([, r]) => r === null).map(([a]) => a);
      acts[c] = rnd(pool);
    }
    const turn = m.currentTurn(); const hash = m.stateHash();
    for (const [color, action] of Object.entries(acts)) {
      const r = m.submit({ turn, color, action, hash });
      if (!r.ok) throw new Error(r.error);
    }
    log.push(acts);
    if (m.outcome().status !== 'running') break;
  }
  const v = m.view('C');
  if (v.outcome.status !== 'running') continue;
  const s = score(v);
  if (!best || s > best.s) best = { s, log, view: v };
}
if (!best) throw new Error('no state');
console.log('score', best.s, 'turns', best.log.length);
writeFileSync('mockups/shared/fixture.json', JSON.stringify({ config: cfg, script: best.log, view: best.view }, null, 1));
