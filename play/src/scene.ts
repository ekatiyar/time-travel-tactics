// Turns a view into what the board draws, and the difference between two draws into motions.
// Pure so the bucketing and the motion diff can be tested without a DOM.

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
export function shade(
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

export type Token = {
  key: string;
  color: Color; p: number; t: number; x: number; y: number; dir: Dir;
  leg: number; live: boolean; keySides: KeySideCount[];
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
  tokens: Token[];
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

function push<K, V>(m: Map<K, V[]>, k: K, v: V): void {
  const list = m.get(k);
  if (list) list.push(v);
  else m.set(k, [v]);
}

export function sceneAt(
  view: NamedView, focusT: number, lookBack: number, choosing: boolean, floor = 0.14
): Scene {
  const lo = Math.max(0, focusT - lookBack);
  const held = keyHolders(view);
  const legs = legIndexes(view);

  const tokens: Token[] = [];
  const trails = new Map<string, ViewBody[]>();
  const byTile = new Map<string, Stack>();
  for (const b of view.bodies) {
    if (b.t === focusT) {
      const token: Token = {
        key: b.color + ':' + b.p,
        color: b.color, p: b.p, t: b.t, x: b.x, y: b.y, dir: b.dir,
        leg: legs.get(b.color + ':' + b.p) ?? 0,
        live: b.live, keySides: held.get(b.color + ':' + b.p) ?? []
      };
      tokens.push(token);
      const k = tile(b.x, b.y);
      const stack = byTile.get(k);
      if (stack) stack.tokens.push(token);
      else byTile.set(k, { key: '', color: b.color, x: b.x, y: b.y, tokens: [token] });
    } else if (b.t >= lo && b.t < focusT) {
      push(trails, tile(b.x, b.y), b);
    }
  }
  for (const list of trails.values()) list.sort((a, b) => b.t - a.t);

  // Key a stack by colour and leg rather than by whether the colour happens to be split, so
  // every leg keeps one element and slides. Two legs share a tile on the turn an inversion
  // lands; the older one names the stack, so the element survives that merge.
  const stacks = [...byTile.values()];
  for (const s of stacks) {
    s.tokens.sort((a, b) => a.p - b.p);
    s.key = stackKey(s.color, s.tokens[0]!.leg);
  }
  // Order follows `view.bodies`, which the engine appends in each turn's priority order, and
  // priority rotates. Sorting by key keeps the keyed children stable, so a resolved turn is an
  // update in place and its left/top transition runs instead of an insertBefore teleport.
  stacks.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));

  const fronts: SceneFront[] = [];
  const perTile = new Map<string, number>();
  const seq = new Map<Color, number>();
  for (const f of view.fronts) {
    // Fronts arrive in tape order, so a colour's nth front is its nth counting tape event. Count
    // before the window test: keying on the event instead of the world turn is what lets one
    // element survive the front sweeping forward, and the count has to be window-independent.
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
    tokens,
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
  // The turn after an inversion parts the two co-located legs. The newer one has no element to
  // transition from, and reading the other way the older one keeps the only element, so these two
  // name the tile the leg has to travel from. `merge` also names where it lands: its subject is
  // absent from `next`, so the renderer has no drawn position to read.
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

// Every leg a scene draws, keyed as its own stack key would be, so a leg sharing an element with
// an older leg is still findable. Splits and merges are the legs whose home changes between
// having an element and sharing one.
function legHomes(scene: Scene): Map<string, Stack> {
  const out = new Map<string, Stack>();
  for (const s of scene.stacks) for (const t of s.tokens) out.set(stackKey(t.color, t.leg), s);
  return out;
}

export function motionBetween(prev: Scene, next: Scene, events: readonly TurnEvent[]): Motion[] {
  // Jumps of more than one world turn snap.
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
      // No element last draw. A home on another tile means the leg was inside an older leg's
      // element; anything else is a body appearing for the first time, which just lands.
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

  // Reading the other way: a leg that loses its element still travels, into the tile the older
  // leg's element now holds.
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
