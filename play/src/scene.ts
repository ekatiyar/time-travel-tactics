import { COLORS } from './engine/index.js';
import type { ActionOffer, Color, Dir, TurnEvent, Vec, View, ViewBody } from './engine/index.js';
import { legIndexes } from './lanes.js';

// Enough of SessionView to name players; keeps this module off the transport.
export type NamedView = View & { names: Partial<Record<Color, string>> };

export type RelativeDirection = 'matching' | 'opposing';
export type Front = View['fronts'][number];

export function plural(n: number, word: string): string {
  return n + ' ' + word + (n === 1 ? '' : 's');
}

export function nameOf(view: NamedView, color: Color): string {
  return view.names[color] || COLORS[color].name;
}

export function relativeDirection(view: NamedView, b: { dir: Dir }): RelativeDirection {
  return b.dir === view.me.dir ? 'matching' : 'opposing';
}

export type Described = { color: Color; p: number; t: number; dir: Dir; live: boolean };

export function describe(view: NamedView, b: Described): string {
  const relation = relativeDirection(view, b) === 'matching'
    ? 'same direction as you' : 'opposite direction from you';
  return nameOf(view, b.color) + ', index ' + b.p + ', world turn ' + b.t +
    ', walking ' + (b.dir === 1 ? 'forward' : 'backward') + ', ' + relation +
    (b.live ? ', current' : '');
}

export function frontText(view: NamedView, f: Front): string {
  if (f.target === null) return 'key at the center';
  if (f.target === view.me.color) return 'reaches you in ' + plural(f.gap, 'turn');
  const who = nameOf(view, f.target) + "'s last visible body";
  return f.gap === 0 ? 'reached ' + who : 'reaches ' + who + ' in ' + plural(f.gap, 'turn');
}

// Spread trail opacity across visible turns, not raw distance.
function shade(
  bodies: readonly ViewBody[], focusT: number, lookBack: number, floor: number
): Map<number, number> {
  const lo = Math.max(0, focusT - lookBack);
  const seen = new Set<number>();
  for (const b of bodies) if (b.t >= lo && b.t < focusT) seen.add(b.t);
  const turns = [...seen].sort((a, b) => b - a);
  const out = new Map<number, number>();
  turns.forEach((t, i) => {
    out.set(t, turns.length < 2 ? 1 : 1 - (1 - floor) * (i / (turns.length - 1)));
  });
  return out;
}

export type KeySideCount = { side: Vec; count: number };

export function keyHolders(view: NamedView): Map<string, KeySideCount[]> {
  const grouped = new Map<string, Map<string, KeySideCount>>();
  for (const k of view.keys) {
    const body = k.color + ':' + k.p, side = k.side.join(',');
    let sides = grouped.get(body);
    if (!sides) { sides = new Map(); grouped.set(body, sides); }
    const found = sides.get(side);
    if (found) found.count++;
    else sides.set(side, { side: [k.side[0], k.side[1]], count: 1 });
  }
  const out = new Map<string, KeySideCount[]>();
  for (const [body, sides] of grouped) out.set(body, [...sides.values()]);
  return out;
}

export type Token = Pick<ViewBody, 'color' | 'p' | 't' | 'dir' | 'live'> & {
  leg: number; keySides: KeySideCount[];
};

// One tile's worth of bodies at the focus turn. The occupancy rule keeps a stack single-colour.
export type Stack = {
  key: string;
  color: Color; x: number; y: number;
  tokens: Token[];
};

export type SceneFront = {
  key: string; color: Color; x: number; y: number; nth: number; text: string;
};

export type Scene = {
  focusT: number;
  center: Vec;
  stacks: Stack[];
  byTile: Map<string, Stack>;
  trails: Map<string, ViewBody[]>;
  shade: Map<number, number>;
  fronts: SceneFront[];
  keyAtCenter: boolean;
  targets: Map<string, ActionOffer>;
};

const tile = (x: number, y: number): string => x + ',' + y;

const stackKey = (color: Color, leg: number): string => color + '/' + leg;

export function sceneAt(
  view: NamedView, focusT: number, lookBack: number, choosing: boolean, floor = 0.14
): Scene {
  const lo = Math.max(0, focusT - lookBack);
  const held = keyHolders(view);
  const legs = legIndexes(view);

  const trails = new Map<string, ViewBody[]>();
  const byTile = new Map<string, Stack>();
  for (const b of view.bodies) {
    if (b.t === focusT) {
      const token: Token = {
        color: b.color, p: b.p, t: b.t, dir: b.dir,
        leg: legs.get(b.color + ':' + b.p) ?? 0,
        live: b.live, keySides: held.get(b.color + ':' + b.p) ?? []
      };
      const k = tile(b.x, b.y);
      const stack = byTile.get(k);
      if (stack) stack.tokens.push(token);
      else byTile.set(k, { key: '', color: b.color, x: b.x, y: b.y, tokens: [token] });
    } else if (b.t >= lo && b.t < focusT) {
      const k = tile(b.x, b.y);
      const trail = trails.get(k);
      if (trail) trail.push(b);
      else trails.set(k, [b]);
    }
  }
  for (const list of trails.values()) list.sort((a, b) => b.t - a.t);

  // The older leg names a shared stack so its element survives an inversion merge.
  const stacks = [...byTile.values()];
  for (const s of stacks) {
    s.tokens.sort((a, b) => a.p - b.p);
    s.key = stackKey(s.color, s.tokens[0]!.leg);
  }
  // Stable DOM order preserves transitions when the engine's priority order rotates.
  stacks.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));

  const fronts: SceneFront[] = [];
  const perTile = new Map<string, number>();
  const seq = new Map<Color, number>();
  for (const f of view.fronts) {
    // Tape order identifies each front across turns. Count before filtering to keep keys stable.
    const nthOfColor = seq.get(f.color) ?? 0;
    seq.set(f.color, nthOfColor + 1);
    if (f.t < lo || f.t > focusT) continue;
    // Slots coincide exactly, so fronts sharing a tile need an offset to stay separately hoverable.
    const at = tile(f.x, f.y);
    const nth = perTile.get(at) ?? 0;
    perTile.set(at, nth + 1);
    fronts.push({
      key: f.color + '#' + nthOfColor,
      color: f.color, x: f.x, y: f.y, nth, text: frontText(view, f)
    });
  }
  fronts.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));

  const targets = new Map<string, ActionOffer>();
  if (choosing && focusT === view.me.t) {
    for (const a of view.actions) if (a.move) targets.set(tile(a.x, a.y), a);
  }

  return {
    focusT,
    center: [view.center[0], view.center[1]],
    stacks,
    byTile,
    trails,
    shade: shade(view.bodies, focusT, lookBack, floor),
    fronts,
    keyAtCenter: view.keyAtCenter.some((t) => t === focusT),
    targets
  };
}

export type Motion =
  | { kind: 'slide'; key: string }
  | { kind: 'bounce'; key: string; toward: Vec }
  | { kind: 'invert'; key: string }
  | { kind: 'grab'; key: string; from: Vec }
  | { kind: 'lost'; key: string }
  // Split/merge legs lack an element in one scene, so carry their missing positions.
  | { kind: 'split'; key: string; from: Vec }
  | { kind: 'merge'; key: string; from: Vec; to: Vec };

// The engine records no aimed-at tile, so read it off the other party's body instead.
function adjacentTile(scene: Scene, color: Color | null, x: number, y: number): Vec | null {
  if (!color) return null;
  const found: Vec[] = [];
  for (const [dx, dy] of [[0, -1], [0, 1], [-1, 0], [1, 0]] as Vec[]) {
    const s = scene.byTile.get(tile(x + dx, y + dy));
    if (s && s.color === color) found.push([s.x, s.y]);
  }
  return found.length === 1 ? found[0]! : null;
}

const newestDir = (s: Stack): Dir => s.tokens[s.tokens.length - 1]!.dir;

// Every event records the actor's own tile, so a colour split across tiles is still reachable.
function stackAt(scene: Scene, color: Color, x: number, y: number): Stack | undefined {
  const s = scene.byTile.get(tile(x, y));
  return s && s.color === color ? s : undefined;
}

// Include legs sharing an older leg's element so splits and merges can find them.
function legHomes(scene: Scene): Map<string, Stack> {
  const out = new Map<string, Stack>();
  for (const s of scene.stacks) for (const t of s.tokens) out.set(stackKey(t.color, t.leg), s);
  return out;
}

export function motionBetween(prev: Scene, next: Scene, events: readonly TurnEvent[]): Motion[] {
  if (Math.abs(next.focusT - prev.focusT) > 1) return [];

  const out: Motion[] = [];
  const from = new Map(prev.stacks.map((s) => [s.key, s]));
  const claimed = new Set<string>();

  for (const e of events) {
    const s = stackAt(next, e.color, e.x, e.y);
    if (!s) continue;
    if (e.kind === 'blocked') {
      const toward = adjacentTile(next, e.by, e.x, e.y);
      // Ambiguous blockers read as a hold.
      if (toward) { out.push({ kind: 'bounce', key: s.key, toward }); claimed.add(s.key); }
    } else if (e.kind === 'inverted') {
      out.push({ kind: 'invert', key: s.key });
      claimed.add(s.key);
    } else if (e.kind === 'grab') {
      const src = e.by === null ? next.center : adjacentTile(next, e.by, e.x, e.y);
      if (src) out.push({ kind: 'grab', key: s.key, from: src });
    } else if (e.kind === 'lost') {
      out.push({ kind: 'lost', key: s.key });
    }
  }

  const homesBefore = legHomes(prev);
  const homesAfter = legHomes(next);

  for (const s of next.stacks) {
    const was = from.get(s.key);
    if (!was) {
      // Animate a split from its shared stack; a newly visible body just appears.
      const shared = homesBefore.get(s.key);
      if (shared && (shared.x !== s.x || shared.y !== s.y)) {
        out.push({ kind: 'split', key: s.key, from: [shared.x, shared.y] });
      }
      continue;
    }
    if (!claimed.has(s.key) && (was.x !== s.x || was.y !== s.y)) {
      out.push({ kind: 'slide', key: s.key });
    }
    // Scrubbing has no events to read, so inversion shows up as a direction change.
    if (!events.length && newestDir(was) !== newestDir(s)) {
      out.push({ kind: 'invert', key: s.key });
    }
  }

  const to = new Map(next.stacks.map((s) => [s.key, s]));
  for (const s of prev.stacks) {
    if (to.has(s.key)) continue;
    const shared = homesAfter.get(s.key);
    if (shared && (shared.x !== s.x || shared.y !== s.y)) {
      out.push({ kind: 'merge', key: s.key, from: [s.x, s.y], to: [shared.x, shared.y] });
    }
  }

  const wasAt = new Map(prev.fronts.map((f) => [f.key, f]));
  for (const f of next.fronts) {
    const was = wasAt.get(f.key);
    if (was && (was.x !== f.x || was.y !== f.y)) out.push({ kind: 'slide', key: f.key });
  }
  return out;
}
