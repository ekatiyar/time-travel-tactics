import { ACTIONS, COLORS, DIRS, isAction, isColor, metaTurn, personalIndex, worldTurn } from './types.js';
import type {
  Ack, Action, Body, Color, Config, ConfigInput, Dir, LogEntry, MetaTurn, Mode, ModeView,
  Outcome, PersonalIndex, Player, Players, Result, TurnContext, TurnEvent, Vec, View, WorldTurn
} from './types.js';
import { fnv1a, mulberry32, short } from './hash.js';
import { cellKey, centerOf, genWalls, normalizeConfig, spawnFor, tileKey, unkey } from './board.js';
import { Wire } from './wire.js';
import { MODES } from './modes/index.js';

type Target = { t: WorldTurn; x: number; y: number; move: boolean };

type Derived = {
  players: Players; bodies: Body[]; occ: Map<string, Color>; stacks: Map<string, Body[]>;
  events: TurnEvent[]; turn: MetaTurn; outcome: Outcome; hash: string;
  mode: unknown; ctx: TurnContext;
};

export function priorityFor(seed: string, turn: MetaTurn, roster: readonly Color[]): Color[] {
  const rnd = mulberry32(fnv1a('prio:' + seed + ':' + turn));
  const a = roster.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1));
    const t = a[i]!; a[i] = a[j]!; a[j] = t;
  }
  return a;
}

function hashState(
  bodies: readonly Body[], players: Players, roster: readonly Color[], digest: string
): string {
  const b = bodies.slice().sort(function (x, y) {
    return x.color === y.color ? x.p - y.p : (x.color < y.color ? -1 : 1);
  }).map((o) => o.color + o.p + ':' + o.t + ':' + o.x + ':' + o.y + ':' + o.dir).join(';');
  const p = roster.slice().sort().map((c) => {
    const pl = playerOf(players, c);
    return c + pl.dir + ':' + pl.t + ':' + pl.p;
  }).join(';');
  return short(fnv1a(b + '|' + p + '|' + digest));
}

function playerOf(players: Players, c: Color): Player {
  const pl = players[c];
  if (!pl) throw new Error('unknown colour ' + c);
  return pl;
}

export function targetOf(pl: Player, action: Action): Target {
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

function outcomeDigest(o: Outcome): string {
  return o.status === 'won' ? 'won:' + o.color : o.status;
}

export class Match {
  private _cfg: Config;
  private _mode: Mode<unknown>;
  private _log: LogEntry[];
  private _walls: Set<string>;
  private _cache: Derived | null;

  constructor(config: ConfigInput, log?: readonly LogEntry[] | null) {
    this._cfg = normalizeConfig(config);
    this._mode = MODES[this._cfg.mode];
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
    const cfg = this._cfg, roster = cfg.roster, mode = this._mode;

    const players: Players = {};
    const spawns: Partial<Record<Color, Vec>> = {};
    for (const c of roster) {
      const s = spawnFor(c, cfg.w, cfg.h);
      spawns[c] = s;
      players[c] = {
        color: c, dir: 1, t: worldTurn(0), p: personalIndex(0),
        x: s[0], y: s[1], horizon: worldTurn(0), stuck: false
      };
    }

    const bodies: Body[] = [];
    const occ = new Map<string, Color>();
    const stacks = new Map<string, Body[]>();
    function place(color: Color, p: PersonalIndex, t: WorldTurn, x: number, y: number, dir: Dir): Body {
      const b: Body = { color: color, p: p, t: t, x: x, y: y, dir: dir };
      bodies.push(b);
      const k = cellKey(t, x, y);
      occ.set(k, color);
      const st = stacks.get(k);
      if (st) st.push(b); else stacks.set(k, [b]);
      return b;
    }
    for (const c of roster) {
      const pl = playerOf(players, c);
      place(c, pl.p, pl.t, pl.x, pl.y, pl.dir);
    }

    const byTurn = new Map<number, Partial<Record<Color, Action>>>();
    for (const e of this._log) {
      let slot = byTurn.get(e.turn);
      if (!slot) { slot = {}; byTurn.set(e.turn, slot); }
      slot[e.color] = e.action;
    }

    const events: TurnEvent[] = [];
    const modeState = mode.init(cfg);
    const center = centerOf(cfg.w, cfg.h);
    const context = (turn: MetaTurn, prio: readonly Color[], actors: Body[]): TurnContext => ({
      cfg, turn, prio, players, bodies, actors, spawns, center, events,
      bodiesAt: (t, x, y) => stacks.get(cellKey(t, x, y)) ?? []
    });

    let outcome: Outcome = { status: 'running' };
    let hash = hashState(bodies, players, roster, cfg.mode + '|' + mode.digest(modeState) + '|' + outcomeDigest(outcome));
    let ctx = context(metaTurn(0), priorityFor(cfg.seed, metaTurn(0), roster), []);
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

      const actors: Body[] = [];
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
        actors.push(place(color, pl.p, pl.t, pl.x, pl.y, pl.dir));
        events.push({
          turn: turn,
          color: color,
          kind: by !== null ? 'blocked' : action === 'I' ? 'inverted' : action === 'H' ? 'held' : 'moved',
          t: pl.t, x: pl.x, y: pl.y,
          by: by, dir: pl.dir
        });
      }

      ctx = context(turn, prio, actors);
      mode.afterTurn(modeState, ctx);
      outcome = mode.outcome(modeState, ctx);
      if (outcome.status === 'running' && n + 1 >= cfg.cap) outcome = { status: 'draw' };
      hash = hashState(bodies, players, roster, cfg.mode + '|' + mode.digest(modeState) + '|' + outcomeDigest(outcome));
      if (outcome.status !== 'running') { n++; break; }
    }

    this._cache = {
      players, bodies, occ, stacks, events, outcome, hash, ctx,
      turn: metaTurn(n), mode: modeState
    };
    return this._cache;
  }

  config(): Config {
    const c = this._cfg;
    return { mode: c.mode, w: c.w, h: c.h, wallPct: c.wallPct, seed: c.seed, cap: c.cap, roster: c.roster.slice() };
  }

  currentTurn(): MetaTurn { return this._derive().turn; }
  stateHash(): string { return this._derive().hash; }
  outcome(): Outcome { return this._derive().outcome; }

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

  withdraw(color: string): Ack {
    if (!isColor(color) || this._cfg.roster.indexOf(color) < 0) {
      return { ok: false, error: 'colour ' + color + ' is not in this match' };
    }
    const d = this._derive();
    if (d.outcome.status !== 'running') return { ok: false, error: 'the match is over' };
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
    if (d.outcome.status !== 'running') {
      const out = {} as Record<Action, string | null>;
      for (const a of ACTIONS) out[a] = 'the match is over';
      return out;
    }
    return this._legalFrom(me, d.occ);
  }

  submit(sub: { turn: number; color: string; action: string; hash: string }): Ack {
    const d = this._derive();
    if (d.outcome.status !== 'running') return { ok: false, error: 'the match is over' };
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
    const over = d.outcome.status !== 'running';
    const walls = Array.from(this._walls).map(unkey)
      .sort((a, b) => a[1] - b[1] || a[0] - b[0]);
    // The mode only ever sees what the viewer may see.
    const seen = d.bodies.filter((b) => b.t <= hz);
    const modeView: ModeView = this._mode.view(d.mode, {
      ...d.ctx, bodies: seen,
      bodiesAt: (t, x, y) => t <= hz ? d.ctx.bodiesAt(t, x, y) : []
    }, hz);

    return {
      ...modeView,
      mode: cfg.mode,
      w: cfg.w, h: cfg.h, cap: cfg.cap, seed: cfg.seed,
      turn: d.turn, outcome: d.outcome, hash: d.hash,
      roster: cfg.roster.slice(),
      priority: over ? [] : priorityFor(cfg.seed, d.turn, cfg.roster),
      pending: this.pendingColors(),
      walls: walls,
      spawns: Object.fromEntries(Object.entries(d.ctx.spawns).map(([c, s]) => [c, [s[0], s[1]]])),
      center: [d.ctx.center[0], d.ctx.center[1]],
      me: {
        color: color, p: me.p, t: me.t, x: me.x, y: me.y,
        dir: me.dir, horizon: hz, stuck: me.stuck
      },
      // Filter here so renderers cannot reveal future positions.
      bodies: d.bodies.filter((b) => b.t <= hz).map((b) => ({
        color: b.color, p: b.p, t: b.t, x: b.x, y: b.y, dir: b.dir,
        live: playerOf(d.players, b.color).p === b.p
      })),
      events: d.events.filter((e) => e.t <= hz).map((e) => ({
        turn: e.turn, color: e.color, kind: e.kind,
        t: e.t, x: e.x, y: e.y, by: e.by, dir: e.dir
      })),
      actions: over ? [] : ACTIONS.map((a) => {
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
