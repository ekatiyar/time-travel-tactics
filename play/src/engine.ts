// Prevent mixing turn and tape indexes.
declare const brand: unique symbol;
type Branded<T extends string> = { readonly [brand]: T };

export type WorldTurn = number & Branded<'world'>;
export type MetaTurn = number & Branded<'meta'>;
export type PersonalIndex = number & Branded<'personal'>;

export const worldTurn = (n: number): WorldTurn => n as WorldTurn;
export const metaTurn = (n: number): MetaTurn => n as MetaTurn;
export const personalIndex = (n: number): PersonalIndex => n as PersonalIndex;

export type Color = 'C' | 'P' | 'T' | 'A';
export type Move = 'W' | 'A' | 'S' | 'D';
export type Action = Move | 'H' | 'I';
export type Dir = 1 | -1;
export type EventKind = 'moved' | 'held' | 'inverted' | 'blocked' | 'stuck';
export type Vec = [number, number];

export type Failure = { ok: false; value?: undefined; error: string };
export type Result<T> = { ok: true; value: T; error?: undefined } | Failure;
export type Outcome = { ok: true; error?: undefined } | Failure;

const ORDER: Color[] = ['C', 'P', 'T', 'A'];
const COLORS: Record<Color, { name: string; hex: string; ink: string }> = {
  C: { name: 'Coral',  hex: '#D85A30', ink: '#FBEDE7' },
  P: { name: 'Purple', hex: '#7F77DD', ink: '#EDECFB' },
  T: { name: 'Teal',   hex: '#2E9E8F', ink: '#E7F5F2' },
  A: { name: 'Amber',  hex: '#C98F12', ink: '#FBF2DF' }
};
const DIRS: Record<Move, Vec> = { W: [0, -1], A: [-1, 0], S: [0, 1], D: [1, 0] };
const MOVES: Move[] = ['W', 'A', 'S', 'D'];
const ACTIONS: Action[] = ['W', 'A', 'S', 'D', 'H', 'I'];

function isColor(c: unknown): c is Color {
  return typeof c === 'string' && (ORDER as string[]).includes(c);
}
function isAction(a: unknown): a is Action {
  return typeof a === 'string' && (ACTIONS as string[]).includes(a);
}

export type Config = {
  w: number; h: number; wallPct: number; seed: string; cap: number; roster: Color[];
};
// Unvalidated configuration from forms, codes, and exports.
export type ConfigInput = {
  w: number; h: number; wallPct: number; seed: string; cap: number; roster: readonly string[];
};
export type LogEntry = { turn: MetaTurn; color: Color; action: Action };

type Player = {
  color: Color; dir: Dir; t: WorldTurn; p: PersonalIndex;
  x: number; y: number; horizon: WorldTurn; stuck: boolean;
};
type Players = Partial<Record<Color, Player>>;
type Target = { t: WorldTurn; x: number; y: number; move: boolean };

export type Body = {
  color: Color; p: PersonalIndex; t: WorldTurn; x: number; y: number;
};
export type TurnEvent = {
  turn: MetaTurn; color: Color; kind: EventKind;
  t: WorldTurn; x: number; y: number; by: Color | null; dir: Dir;
};
export type ViewBody = Body & { live: boolean };
export type ActionOffer = {
  action: Action; reason: string | null;
  t: WorldTurn; x: number; y: number; move: boolean;
};
export type View = {
  w: number; h: number; cap: number; seed: string;
  turn: MetaTurn; over: boolean; hash: string;
  roster: Color[]; priority: Color[]; pending: Color[];
  walls: Vec[];
  me: {
    color: Color; p: PersonalIndex; t: WorldTurn; x: number; y: number;
    dir: Dir; horizon: WorldTurn; stuck: boolean;
  };
  bodies: ViewBody[];
  events: TurnEvent[];
  actions: ActionOffer[];
};

type Derived = {
  players: Players; bodies: Body[]; occ: Map<string, Color>;
  events: TurnEvent[]; turn: MetaTurn; over: boolean; hash: string;
};

function fnv1a(str: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}
function short(h: number): string {
  return ((((h >>> 16) ^ h) & 0xffff) >>> 0).toString(16).padStart(4, '0');
}
function mulberry32(a: number): () => number {
  return function () {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function tileKey(x: number, y: number): string { return x + ',' + y; }
function cellKey(t: WorldTurn, x: number, y: number): string { return t + ',' + x + ',' + y; }
function unkey(k: string): Vec {
  const i = k.indexOf(',');
  return [Number(k.slice(0, i)), Number(k.slice(i + 1))];
}

function spawnFor(color: Color, w: number, h: number): Vec {
  if (color === 'C') return [0, 0];
  if (color === 'P') return [w - 1, h - 1];
  if (color === 'T') return [w - 1, 0];
  return [0, h - 1];
}

function normalizeConfig(c: ConfigInput): Config {
  const asked = c.roster.slice();
  const w = Math.floor(c.w), h = Math.floor(c.h), wallPct = Math.floor(c.wallPct);
  const seed = String(c.seed), cap = Math.floor(c.cap);
  // Cap board size to keep rendering bounded.
  if (!(w >= 2 && w <= 64 && h >= 2 && h <= 64)) throw new Error('board must be between 2x2 and 64x64');
  if (!(wallPct >= 0 && wallPct <= 45)) throw new Error('wall density must be 0-45');
  if (!(cap >= 2 && cap <= 400)) throw new Error('turn cap must be 2-400');
  if (!/^[A-Za-z0-9_-]{1,24}$/.test(seed)) throw new Error('seed must be 1-24 letters, digits, - or _');
  if (!asked.length || asked.length > 4) throw new Error('need 1-4 players');

  const roster: Color[] = [];
  for (const col of asked) {
    if (!isColor(col)) throw new Error('unknown colour ' + col);
    if (roster.includes(col)) throw new Error('duplicate colour ' + col);
    roster.push(col);
  }
  const cfg: Config = { w, h, wallPct, seed, cap, roster };
  const spots = new Set<string>();
  for (const col of cfg.roster) {
    const s = tileKey(...spawnFor(col, cfg.w, cfg.h));
    if (spots.has(s)) throw new Error('board is too small to give every player its own corner');
    spots.add(s);
  }
  return cfg;
}

// Carve walls until every spawn is reachable.
function genWalls(cfg: Config): Set<string> {
  const w = cfg.w, h = cfg.h;
  const spawns = cfg.roster.map((c) => spawnFor(c, w, h));
  const first = spawns[0];
  if (!first) throw new Error('need 1-4 players');
  const protectedTiles = new Set(spawns.map((s) => tileKey(s[0], s[1])));

  const rnd = mulberry32(fnv1a('walls:' + cfg.seed));
  const wall = new Set<string>();
  const target = Math.floor(w * h * cfg.wallPct / 100);
  for (let guard = 0; wall.size < target && guard < w * h * 40; guard++) {
    const k = tileKey(Math.floor(rnd() * w), Math.floor(rnd() * h));
    if (!protectedTiles.has(k)) wall.add(k);
  }

  function reachable(): Set<string> {
    const seen = new Set([tileKey(first![0], first![1])]);
    const st: Vec[] = [first!];
    while (st.length) {
      const p = st.pop()!;
      for (const m of MOVES) {
        const v = DIRS[m], nx = p[0] + v[0], ny = p[1] + v[1], nk = tileKey(nx, ny);
        if (nx < 0 || ny < 0 || nx >= w || ny >= h || wall.has(nk) || seen.has(nk)) continue;
        seen.add(nk); st.push([nx, ny]);
      }
    }
    return seen;
  }
  for (let pass = 0; pass < w * h; pass++) {
    const seen = reachable();
    if (spawns.every((s) => seen.has(tileKey(s[0], s[1])))) break;
    let removed = false;
    for (let y = 0; y < h && !removed; y++) {
      for (let x = 0; x < w && !removed; x++) {
        const key = tileKey(x, y);
        if (!wall.has(key)) continue;
        for (const m of MOVES) {
          const mv = DIRS[m];
          if (seen.has(tileKey(x + mv[0], y + mv[1]))) { wall.delete(key); removed = true; break; }
        }
      }
    }
    if (!removed) break;
  }
  return wall;
}

function priorityFor(seed: string, turn: MetaTurn, roster: readonly Color[]): Color[] {
  const rnd = mulberry32(fnv1a('prio:' + seed + ':' + turn));
  const a = roster.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1));
    const t = a[i]!; a[i] = a[j]!; a[j] = t;
  }
  return a;
}

function hashState(bodies: readonly Body[], players: Players, roster: readonly Color[]): string {
  const b = bodies.slice().sort(function (x, y) {
    return x.color === y.color ? x.p - y.p : (x.color < y.color ? -1 : 1);
  }).map((o) => o.color + o.p + ':' + o.t + ':' + o.x + ':' + o.y).join(';');
  const p = roster.slice().sort().map((c) => {
    const pl = playerOf(players, c);
    return c + pl.dir + ':' + pl.t + ':' + pl.p;
  }).join(';');
  return short(fnv1a(b + '|' + p));
}

function playerOf(players: Players, c: Color): Player {
  const pl = players[c];
  if (!pl) throw new Error('unknown colour ' + c);
  return pl;
}

const NAME_RE = /^[A-Za-z0-9_-]{1,12}$/;
function validName(s: unknown): s is string {
  return typeof s === 'string' && NAME_RE.test(s);
}

function group(m: RegExpExecArray, i: number): string {
  const v = m[i];
  if (v === undefined) throw new Error('pattern group ' + i + ' did not match');
  return v;
}

function targetOf(pl: Player, action: Action): Target {
  switch (action) {
    case 'I': return { t: pl.t, x: pl.x, y: pl.y, move: false };
    case 'H': return { t: worldTurn(pl.t + pl.dir), x: pl.x, y: pl.y, move: false };
    case 'W': case 'A': case 'S': case 'D': {
      const v = DIRS[action];
      return { t: worldTurn(pl.t + pl.dir), x: pl.x + v[0], y: pl.y + v[1], move: true };
    }
  }
}

function everyoneActed(
  acts: Partial<Record<Color, Action>>, roster: readonly Color[]
): acts is Record<Color, Action> {
  return roster.every((c) => typeof acts[c] === 'string');
}

class Match {
  private _cfg: Config;
  private _log: LogEntry[];
  private _walls: Set<string>;
  private _cache: Derived | null;

  constructor(config: ConfigInput, log?: readonly LogEntry[] | null) {
    this._cfg = normalizeConfig(config);
    this._log = (log ?? []).map((e) => ({ turn: e.turn, color: e.color, action: e.action }));
    this._walls = genWalls(this._cfg);
    this._cache = null;
  }

  static fromConfig(config: ConfigInput): Match { return new Match(config, []); }

  static fromExport(str: unknown): Result<{ match: Match; names: Partial<Record<Color, string>> }> {
    const r = Wire.decodeExport(str);
    if (!r.ok) return r;
    try {
      const match = new Match(r.value.config, r.value.log);
      const names: Partial<Record<Color, string>> = {};
      for (const c of r.value.config.roster) {
        const n = r.value.names[c];
        if (n !== undefined) names[c] = n;
      }
      return { ok: true, value: { match: match, names: names } };
    } catch (e) {
      return { ok: false, error: String(e instanceof Error ? e.message : e) };
    }
  }

  private _blockReason(pl: Player, action: Action, occ: Map<string, Color>): string | null {
    const cfg = this._cfg;
    const tg = targetOf(pl, action);
    if (tg.t < 0) return 'that is before the start of time';
    if (tg.x < 0 || tg.y < 0 || tg.x >= cfg.w || tg.y >= cfg.h) return 'off the board';
    if (this._walls.has(tileKey(tg.x, tg.y))) return 'wall';
    const who = occ.get(cellKey(tg.t, tg.x, tg.y));
    if (tg.t <= pl.horizon && who && (who !== pl.color || tg.move)) return 'occupied';
    return null;
  }

  private _legalFrom(pl: Player, occ: Map<string, Color>): Record<Action, string | null> {
    const out = {} as Record<Action, string | null>;
    for (const a of ACTIONS) out[a] = this._blockReason(pl, a, occ);
    return out;
  }

  private _derive(): Derived {
    if (this._cache) return this._cache;
    const cfg = this._cfg, roster = cfg.roster;

    const players: Players = {};
    for (const c of roster) {
      const s = spawnFor(c, cfg.w, cfg.h);
      players[c] = {
        color: c, dir: 1, t: worldTurn(0), p: personalIndex(0),
        x: s[0], y: s[1], horizon: worldTurn(0), stuck: false
      };
    }

    const bodies: Body[] = [];
    const occ = new Map<string, Color>();
    function place(color: Color, p: PersonalIndex, t: WorldTurn, x: number, y: number): void {
      bodies.push({ color: color, p: p, t: t, x: x, y: y });
      occ.set(cellKey(t, x, y), color);
    }
    for (const c of roster) {
      const pl = playerOf(players, c);
      place(c, pl.p, pl.t, pl.x, pl.y);
    }

    const byTurn = new Map<number, Partial<Record<Color, Action>>>();
    for (const e of this._log) {
      let slot = byTurn.get(e.turn);
      if (!slot) { slot = {}; byTurn.set(e.turn, slot); }
      slot[e.color] = e.action;
    }

    const events: TurnEvent[] = [];
    let hash = hashState(bodies, players, roster);
    let n = 0;

    for (; n < cfg.cap; n++) {
      const turn = metaTurn(n);
      const acts = byTurn.get(turn);
      if (!acts) break;
      if (!everyoneActed(acts, roster)) break;

      const prio = priorityFor(cfg.seed, turn, roster);
      // Resolve blind actions against the prior board state.
      const occBase = new Map(occ);

      // Bounces become holders; these sets only grow.
      const holds = new Set<Color>(), frozen = new Set<Color>();
      const bounceBy = new Map<Color, Color>();

      for (const c of prio) {
        const a = acts[c];
        const lg = this._legalFrom(playerOf(players, c), occBase);
        // A tampered import cannot move this player.
        if (lg[a] !== null) frozen.add(c);
        else if (a === 'I' || a === 'H') holds.add(c);
      }

      for (let pass = 0; pass <= 2 * prio.length + 2; pass++) {
        const claim = new Map<string, Color>();
        let changed = false;

        for (const c of prio) {
          if (frozen.has(c) || !holds.has(c)) continue;
          const pl = playerOf(players, c);
          const k = cellKey(targetOf(pl, acts[c]).t, pl.x, pl.y);
          const occWho = occBase.get(k);
          if ((occWho && occWho !== c) || claim.has(k)) { frozen.add(c); changed = true; continue; }
          claim.set(k, c);
        }

        for (const c of prio) {
          if (frozen.has(c) || holds.has(c)) continue;
          const pl = playerOf(players, c), tg = targetOf(pl, acts[c]);
          const k = cellKey(tg.t, tg.x, tg.y);
          const recorded = occBase.get(k);
          if (recorded !== undefined && recorded !== c) {
            holds.add(c); bounceBy.set(c, recorded); changed = true; continue;
          }
          const taken = claim.get(k);
          if (taken !== undefined) { holds.add(c); bounceBy.set(c, taken); changed = true; continue; }
          claim.set(k, c);
        }

        if (!changed) break;
      }

      for (const color of prio) {
        const pl = playerOf(players, color), action = acts[color];
        if (frozen.has(color)) {
          pl.stuck = true;
          events.push({ turn: turn, color: color, kind: 'stuck', t: pl.t, x: pl.x, y: pl.y, by: null, dir: pl.dir });
          continue;
        }
        const tg = targetOf(pl, action);
        const by = bounceBy.get(color) ?? null;
        pl.stuck = false;
        if (action === 'I') pl.dir = pl.dir === 1 ? -1 : 1;
        pl.t = tg.t;
        if (by === null) { pl.x = tg.x; pl.y = tg.y; }
        pl.p = personalIndex(pl.p + 1);
        if (pl.t > pl.horizon) pl.horizon = worldTurn(pl.t);
        place(color, pl.p, pl.t, pl.x, pl.y);
        events.push({
          turn: turn,
          color: color,
          kind: by !== null ? 'blocked' : action === 'I' ? 'inverted' : action === 'H' ? 'held' : 'moved',
          t: pl.t, x: pl.x, y: pl.y,
          by: by, dir: pl.dir
        });
      }
      hash = hashState(bodies, players, roster);
    }

    this._cache = {
      players: players, bodies: bodies, occ: occ, events: events,
      turn: metaTurn(n), over: n >= cfg.cap, hash: hash
    };
    return this._cache;
  }

  config(): Config {
    const c = this._cfg;
    return { w: c.w, h: c.h, wallPct: c.wallPct, seed: c.seed, cap: c.cap, roster: c.roster.slice() };
  }

  currentTurn(): MetaTurn { return this._derive().turn; }
  stateHash(): string { return this._derive().hash; }

  pendingColors(): Color[] {
    const turn = this._derive().turn;
    const done = new Set<Color>();
    for (const e of this._log) if (e.turn === turn) done.add(e.color);
    return this._cfg.roster.filter((c) => !done.has(c));
  }

  private _draftIndex(color: Color, d: Derived): number {
    for (let i = this._log.length - 1; i >= 0; i--) {
      const e = this._log[i]!;
      if (e.turn === d.turn && e.color === color) return i;
    }
    return -1;
  }

  withdraw(color: string): Outcome {
    if (!isColor(color) || this._cfg.roster.indexOf(color) < 0) {
      return { ok: false, error: 'colour ' + color + ' is not in this match' };
    }
    const d = this._derive();
    if (d.over) return { ok: false, error: 'the match is over' };
    const i = this._draftIndex(color, d);
    if (i < 0) return { ok: false, error: 'you have not acted this turn' };
    this._log.splice(i, 1);
    this._cache = null;
    return { ok: true };
  }

  legalActions(color: string): Record<Action, string | null> {
    const d = this._derive();
    if (!isColor(color)) throw new Error('unknown colour ' + color);
    const me = playerOf(d.players, color);
    if (d.over) {
      const out = {} as Record<Action, string | null>;
      for (const a of ACTIONS) out[a] = 'the match is over';
      return out;
    }
    return this._legalFrom(me, d.occ);
  }

  submit(sub: { turn: number; color: string; action: string; hash: string }): Outcome {
    const d = this._derive();
    if (d.over) return { ok: false, error: 'the match is over' };
    if (!isColor(sub.color) || this._cfg.roster.indexOf(sub.color) < 0) {
      return { ok: false, error: 'colour ' + sub.color + ' is not in this match' };
    }
    if (sub.turn !== d.turn) return { ok: false, error: 'action is for turn ' + sub.turn + '; match is on turn ' + d.turn };
    if (sub.hash !== d.hash) return { ok: false, error: 'state ' + sub.hash + " does not match this match's state " + d.hash + '. Timelines diverged.' };
    if (this.pendingColors().indexOf(sub.color) < 0) return { ok: false, error: COLORS[sub.color].name + ' has already acted this turn' };
    const legal = this.legalActions(sub.color);
    if (!isAction(sub.action)) return { ok: false, error: '"' + sub.action + '" is not an action' };
    const reason = legal[sub.action];
    if (reason !== null) return { ok: false, error: 'illegal: ' + reason };
    this._log.push({ turn: d.turn, color: sub.color, action: sub.action });
    this._cache = null;
    return { ok: true };
  }

  view(color: string): View {
    const d = this._derive(), cfg = this._cfg;
    if (!isColor(color)) throw new Error('unknown colour ' + color);
    const me = playerOf(d.players, color);
    const hz = me.horizon;
    const walls = Array.from(this._walls).map(unkey)
      .sort((a, b) => a[1] - b[1] || a[0] - b[0]);

    return {
      w: cfg.w, h: cfg.h, cap: cfg.cap, seed: cfg.seed,
      turn: d.turn, over: d.over, hash: d.hash,
      roster: cfg.roster.slice(),
      priority: d.over ? [] : priorityFor(cfg.seed, d.turn, cfg.roster),
      pending: this.pendingColors(),
      walls: walls,
      me: {
        color: color, p: me.p, t: me.t, x: me.x, y: me.y,
        dir: me.dir, horizon: hz, stuck: me.stuck
      },
      // Filter here so renderers cannot reveal future positions.
      bodies: d.bodies.filter((b) => b.t <= hz).map((b) => ({
        color: b.color, p: b.p, t: b.t, x: b.x, y: b.y,
        live: playerOf(d.players, b.color).p === b.p
      })),
      events: d.events.filter((e) => e.t <= hz).map((e) => ({
        turn: e.turn, color: e.color, kind: e.kind,
        t: e.t, x: e.x, y: e.y, by: e.by, dir: e.dir
      })),
      actions: d.over ? [] : ACTIONS.map((a) => {
        const tg = targetOf(me, a);
        return {
          action: a, reason: this._blockReason(me, a, d.occ),
          t: tg.t, x: tg.x, y: tg.y, move: tg.move
        };
      })
    };
  }

  export(names?: Readonly<Partial<Record<Color, string>>> | null): string {
    return Wire.encodeExport(this.config(), this._log, names ?? null);
  }
}

export type DecodedAction = {
  turn: MetaTurn; color: Color; action: Action; hash: string; name: string | null;
};
export type DecodedExport = {
  config: Config; log: LogEntry[]; names: Partial<Record<Color, string>>;
};

const Wire = {
  encodeAction: function (a: {
    turn: MetaTurn; color: Color; action: Action; hash: string; name?: string | null
  }): string {
    let s = '' + a.turn + a.color + ':' + a.action + '#' + a.hash;
    if (a.turn === 0 && validName(a.name)) s += '~' + a.name;
    return s;
  },
  decodeAction: function (s: unknown): Result<DecodedAction> {
    const m = /^(\d{1,4})([CPTA]):([WASDHI])#([0-9a-f]{4})(?:~([A-Za-z0-9_-]{1,12}))?$/
      .exec(String(s == null ? '' : s).trim());
    if (!m) return { ok: false, error: 'not an action string (expected something like 7C:D#a3f2)' };
    const color = group(m, 2), action = group(m, 3);
    if (!isColor(color) || !isAction(action)) throw new Error('pattern and alphabet disagree');
    return {
      ok: true,
      value: {
        turn: metaTurn(+group(m, 1)), color: color, action: action, hash: group(m, 4),
        name: m[5] ?? null
      }
    };
  },

  encodeMatchCode: function (c: Config): string {
    return 'M1:' + c.w + 'x' + c.h + ':' + c.wallPct + ':' + c.seed + ':' + c.cap + ':' + c.roster.join('');
  },
  decodeMatchCode: function (s: unknown): Result<Config> {
    const m = /^M1:(\d{1,3})x(\d{1,3}):(\d{1,2}):([A-Za-z0-9_-]{1,24}):(\d{1,4}):([CPTA]{1,4})$/
      .exec(String(s == null ? '' : s).trim());
    if (!m) return { ok: false, error: 'not a match code (expected something like M1:16x9:11:19f4:43:CPTA)' };
    const roster = group(m, 6).split('').filter(isColor);
    if (new Set(roster).size !== roster.length) return { ok: false, error: 'match code repeats a colour' };
    return {
      ok: true,
      value: {
        w: +group(m, 1), h: +group(m, 2), wallPct: +group(m, 3),
        seed: group(m, 4), cap: +group(m, 5), roster: roster
      }
    };
  },

  encodeExport: function (
    config: Config, log: readonly LogEntry[], names: Readonly<Partial<Record<Color, string>>> | null
  ): string {
    const byTurn: string[][] = [];
    for (const e of log) {
      let g = byTurn[e.turn];
      if (!g) { g = []; byTurn[e.turn] = g; }
      g.push(e.color + e.action);
    }
    const groups: string[] = [];
    for (let i = 0; i < byTurn.length; i++) groups.push((byTurn[i] ?? []).join(''));
    const nm = ORDER.filter((c) => validName((names ?? {})[c]))
      .sort().map((c) => c + '~' + (names ?? {})[c]);
    return 'X1:' + Wire.encodeMatchCode(config) + '|' + groups.join(',') + '|' + nm.join(',');
  },
  decodeExport: function (raw: unknown): Result<DecodedExport> {
    const s = String(raw == null ? '' : raw).trim();
    if (s.slice(0, 3) !== 'X1:') return { ok: false, error: 'not an export string (it should start with X1:)' };
    const parts = s.slice(3).split('|');
    if (parts.length < 2 || parts.length > 3) {
      return { ok: false, error: 'export string is missing its action section' };
    }
    const mc = Wire.decodeMatchCode(parts[0]);
    if (!mc.ok) return { ok: false, error: 'export carries a bad match code: ' + mc.error };

    const names: Partial<Record<Color, string>> = {};
    const nameParts = (parts[2] ?? '').length ? parts[2]!.split(',') : [];
    for (const part of nameParts) {
      const nm = /^([CPTA])~([A-Za-z0-9_-]{1,12})$/.exec(part);
      if (!nm) return { ok: false, error: 'bad name entry "' + part + '" in export' };
      const c = group(nm, 1);
      if (!isColor(c)) throw new Error('pattern and alphabet disagree');
      names[c] = group(nm, 2);
    }

    const rest = parts[1]!, log: LogEntry[] = [];
    const groups = rest.length ? rest.split(',') : [];
    for (let turn = 0; turn < groups.length; turn++) {
      const g = groups[turn]!;
      if (g.length % 2) return { ok: false, error: 'malformed action group at turn ' + turn };
      for (let i = 0; i < g.length; i += 2) {
        const color = g[i]!, action = g[i + 1]!;
        if (!isColor(color) || !isAction(action)) {
          return { ok: false, error: 'bad action "' + g.slice(i, i + 2) + '" at turn ' + turn };
        }
        log.push({ turn: metaTurn(turn), color: color, action: action });
      }
    }
    return { ok: true, value: { config: mc.value, log: log, names: names } };
  }
};

export { Match, Wire, COLORS, ORDER, DIRS, MOVES, ACTIONS, spawnFor, fnv1a, isColor, isAction, validName };
