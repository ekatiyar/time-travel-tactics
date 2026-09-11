
var ORDER = ['C', 'P', 'T', 'A'];
var COLORS = {
  C: { name: 'Coral',  hex: '#D85A30', ink: '#FBEDE7' },
  P: { name: 'Purple', hex: '#7F77DD', ink: '#EDECFB' },
  T: { name: 'Teal',   hex: '#2E9E8F', ink: '#E7F5F2' },
  A: { name: 'Amber',  hex: '#C98F12', ink: '#FBF2DF' }
};
var DIRS = { W: [0, -1], A: [-1, 0], S: [0, 1], D: [1, 0] };
var MOVES = ['W', 'A', 'S', 'D'];
var ACTIONS = ['W', 'A', 'S', 'D', 'H', 'I'];

function fnv1a(str) {
  var h = 0x811c9dc5;
  for (var i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}
function short(h) { return ((((h >>> 16) ^ h) & 0xffff) >>> 0).toString(16).padStart(4, '0'); }
function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    var t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Fixed corner per colour, so a two-player match starts diagonally opposed.
function spawnFor(color, w, h) {
  if (color === 'C') return [0, 0];
  if (color === 'P') return [w - 1, h - 1];
  if (color === 'T') return [w - 1, 0];
  return [0, h - 1];
}

function normalizeConfig(c) {
  var cfg = {
    w: Math.floor(c.w), h: Math.floor(c.h), wallPct: Math.floor(c.wallPct),
    seed: String(c.seed), cap: Math.floor(c.cap), roster: c.roster.slice()
  };
  // The same range the setup form offers. Unbounded, a typed 999 builds a
  // 998001-cell board and wedges the tab.
  if (!(cfg.w >= 2 && cfg.w <= 64 && cfg.h >= 2 && cfg.h <= 64)) throw new Error('board must be between 2x2 and 64x64');
  if (!(cfg.wallPct >= 0 && cfg.wallPct <= 45)) throw new Error('wall density must be 0-45');
  if (!(cfg.cap >= 2 && cfg.cap <= 400)) throw new Error('turn cap must be 2-400');
  if (!/^[A-Za-z0-9_-]{1,24}$/.test(cfg.seed)) throw new Error('seed must be 1-24 letters, digits, - or _');
  if (!cfg.roster.length || cfg.roster.length > 4) throw new Error('need 1-4 players');
  var seen = {};
  for (var i = 0; i < cfg.roster.length; i++) {
    var col = cfg.roster[i];
    if (ORDER.indexOf(col) < 0) throw new Error('unknown colour ' + col);
    if (seen[col]) throw new Error('duplicate colour ' + col);
    seen[col] = 1;
  }
  var spots = {};
  for (var j = 0; j < cfg.roster.length; j++) {
    var s = spawnFor(cfg.roster[j], cfg.w, cfg.h).join(',');
    if (spots[s]) throw new Error('board is too small to give every player its own corner');
    spots[s] = 1;
  }
  return cfg;
}

// Without the carve pass, a seed can silently seal a player into their corner.
function genWalls(cfg) {
  var w = cfg.w, h = cfg.h;
  var spawns = cfg.roster.map(function (c) { return spawnFor(c, w, h); });
  var protectedTiles = {};
  spawns.forEach(function (s) { protectedTiles[s[0] + ',' + s[1]] = 1; });

  var rnd = mulberry32(fnv1a('walls:' + cfg.seed));
  var wall = new Set();
  var target = Math.floor(w * h * cfg.wallPct / 100);
  for (var guard = 0; wall.size < target && guard < w * h * 40; guard++) {
    var k = Math.floor(rnd() * w) + ',' + Math.floor(rnd() * h);
    if (!protectedTiles[k]) wall.add(k);
  }

  function reachable() {
    var seen = new Set([spawns[0][0] + ',' + spawns[0][1]]);
    var st = [spawns[0]];
    while (st.length) {
      var p = st.pop();
      for (var d = 0; d < MOVES.length; d++) {
        var v = DIRS[MOVES[d]], nx = p[0] + v[0], ny = p[1] + v[1], nk = nx + ',' + ny;
        if (nx < 0 || ny < 0 || nx >= w || ny >= h || wall.has(nk) || seen.has(nk)) continue;
        seen.add(nk); st.push([nx, ny]);
      }
    }
    return seen;
  }
  for (var pass = 0; pass < w * h; pass++) {
    var seen = reachable();
    var missing = spawns.some(function (s) { return !seen.has(s[0] + ',' + s[1]); });
    if (!missing) break;
    var removed = false;
    for (var y = 0; y < h && !removed; y++) {
      for (var x = 0; x < w && !removed; x++) {
        var key = x + ',' + y;
        if (!wall.has(key)) continue;
        for (var m = 0; m < MOVES.length; m++) {
          var mv = DIRS[MOVES[m]];
          if (seen.has((x + mv[0]) + ',' + (y + mv[1]))) { wall.delete(key); removed = true; break; }
        }
      }
    }
    if (!removed) break;
  }
  return wall;
}

function priorityFor(seed, turn, roster) {
  var rnd = mulberry32(fnv1a('prio:' + seed + ':' + turn));
  var a = roster.slice();
  for (var i = a.length - 1; i > 0; i--) {
    var j = Math.floor(rnd() * (i + 1));
    var t = a[i]; a[i] = a[j]; a[j] = t;
  }
  return a;
}

function hashState(bodies, players, roster) {
  var b = bodies.slice().sort(function (x, y) {
    return x.color === y.color ? x.p - y.p : (x.color < y.color ? -1 : 1);
  }).map(function (o) { return o.color + o.p + ':' + o.t + ':' + o.x + ':' + o.y; }).join(';');
  var p = roster.slice().sort().map(function (c) {
    var pl = players[c];
    return c + pl.dir + ':' + pl.t + ':' + pl.p;
  }).join(';');
  return short(fnv1a(b + '|' + p));
}

var NAME_RE = /^[A-Za-z0-9_-]{1,12}$/;
function validName(s) { return typeof s === 'string' && NAME_RE.test(s); }

function Match(config, log, names) {
  this._cfg = normalizeConfig(config);
  this._log = (log || []).map(function (e) {
    return { turn: e.turn, color: e.color, action: e.action };
  });
  // Names are display only. They stay out of _log and out of hashState, so two
  // clients that know different names still agree on state.
  this._names = {};
  var self = this;
  Object.keys(names || {}).forEach(function (c) {
    if (self._cfg.roster.indexOf(c) >= 0 && validName(names[c])) self._names[c] = names[c];
  });
  this._walls = genWalls(this._cfg);
  this._cache = null;
}

Match.fromConfig = function (config) { return new Match(config, [], null); };

Match.fromExport = function (str) {
  var r = Wire.decodeExport(str);
  if (!r.ok) return r;
  try {
    return { ok: true, value: new Match(r.value.config, r.value.log, r.value.names) };
  } catch (e) {
    return { ok: false, error: String(e.message || e) };
  }
};

// Where an action would put you, given a player's current playhead. Inverting
// spends no world turn. You stay on the tile you already hold and only your
// direction flips, so its target can never be refused. Holding spends the world
// turn without the step, and can be refused like any other target.
function targetOf(pl, action) {
  if (action === 'I') return { t: pl.t, x: pl.x, y: pl.y, move: false };
  if (action === 'H') return { t: pl.t + pl.dir, x: pl.x, y: pl.y, move: false };
  var v = DIRS[action];
  if (!v) return null;
  return { t: pl.t + pl.dir, x: pl.x + v[0], y: pl.y + v[1], move: true };
}

Match.prototype._blockReason = function (pl, action, occ) {
  var cfg = this._cfg;
  var tg = targetOf(pl, action);
  if (!tg) return 'unknown action';
  if (tg.t < 0) return 'that is before the start of time';
  if (tg.x < 0 || tg.y < 0 || tg.x >= cfg.w || tg.y >= cfg.h) return 'off the board';
  if (this._walls.has(tg.x + ',' + tg.y)) return 'wall';
  var who = occ.get(tg.t + ',' + tg.x + ',' + tg.y);
  // Same colour on one tile is the turnstile; a move must diverge immediately.
  // The reason is shown as a tooltip and the target can sit past the viewer's
  // horizon, so it must never name a colour or a world turn.
  if (who && (who !== pl.color || tg.move)) return 'occupied';
  return null;
};

// Inverting is unblockable, so there is no state with nothing to do and no pass
// action to offer.
Match.prototype._legalFrom = function (pl, occ) {
  var out = {};
  for (var i = 0; i < ACTIONS.length; i++) {
    out[ACTIONS[i]] = this._blockReason(pl, ACTIONS[i], occ);
  }
  return out;
};

Match.prototype._derive = function () {
  if (this._cache) return this._cache;
  var self = this, cfg = this._cfg, roster = cfg.roster;

  var players = {};
  roster.forEach(function (c) {
    var s = spawnFor(c, cfg.w, cfg.h);
    players[c] = { color: c, dir: 1, t: 0, p: 0, x: s[0], y: s[1], horizon: 0, stuck: false };
  });

  var bodies = [];
  var occ = new Map();
  function place(color, p, t, x, y) {
    bodies.push({ color: color, p: p, t: t, x: x, y: y });
    occ.set(t + ',' + x + ',' + y, color);
  }
  roster.forEach(function (c) { place(c, 0, 0, players[c].x, players[c].y); });

  var byTurn = new Map();
  this._log.forEach(function (e) {
    if (!byTurn.has(e.turn)) byTurn.set(e.turn, {});
    byTurn.get(e.turn)[e.color] = e.action;
  });

  var events = [], turn = 0, hash = hashState(bodies, players, roster);

  for (; turn < cfg.cap; turn++) {
    var acts = byTurn.get(turn);
    if (!acts) break;
    var complete = roster.every(function (c) { return typeof acts[c] === 'string'; });
    if (!complete) break;

    var prio = priorityFor(cfg.seed, turn, roster);
    // Legality is judged against the board as it stood before the turn, because
    // that is what every player could see when they chose blind. Tiles taken
    // during this turn are a separate, later check.
    var occBase = new Map(occ);

    // Holders beat movers, and a bounced mover becomes a holder, so this iterates.
    // The holder and stuck sets only grow, which is why it terminates.
    var holds = {}, frozen = {}, bounceBy = {}, claim = null;

    for (var i = 0; i < prio.length; i++) {
      var c0 = prio[i], a0 = acts[c0];
      var lg = self._legalFrom(players[c0], occBase);
      // An action that was never legal, only reachable from a tampered import.
      // The turn is skipped entirely.
      if (!(a0 in lg) || lg[a0] !== null) frozen[c0] = 1;
      else if (a0 === 'I' || a0 === 'H') holds[c0] = 1;
    }

    for (var pass = 0; pass <= 2 * prio.length + 2; pass++) {
      claim = new Map();
      var changed = false;

      for (var i = 0; i < prio.length; i++) {   // holders reserve their squares first
        var c = prio[i];
        if (frozen[c] || !holds[c]) continue;
        var pl = players[c];
        var k = targetOf(pl, acts[c]).t + ',' + pl.x + ',' + pl.y;
        var occWho = occBase.get(k);
        // Another colour already recorded there, or two holders after one square
        // (priority breaks that tie). Nothing left to do but lose the turn.
        if ((occWho && occWho !== c) || claim.has(k)) { frozen[c] = 1; changed = true; continue; }
        claim.set(k, c);
      }

      for (var i = 0; i < prio.length; i++) {   // then movers, settled by priority
        var c = prio[i];
        if (frozen[c] || holds[c]) continue;
        var pl = players[c], tg = targetOf(pl, acts[c]);
        var k = tg.t + ',' + tg.x + ',' + tg.y;
        if (claim.has(k)) { holds[c] = 1; bounceBy[c] = claim.get(k); changed = true; continue; }
        claim.set(k, c);
      }

      if (!changed) break;
    }

    for (var i = 0; i < prio.length; i++) {
      var color = prio[i], pl = players[color], action = acts[color];
      if (frozen[color]) {
        pl.stuck = true;
        events.push({ turn: turn, color: color, kind: 'stuck', t: pl.t, x: pl.x, y: pl.y, by: null, dir: pl.dir });
        continue;
      }
      var tg = targetOf(pl, action);
      // Holding is a holder by choice; a bounce is one by force. Only the second
      // is worth telling the player about, so read it off who did the bouncing.
      var bounced = !!bounceBy[color];
      pl.stuck = false;
      if (action === 'I') pl.dir = -pl.dir;
      pl.t = tg.t;
      if (!bounced) { pl.x = tg.x; pl.y = tg.y; }
      pl.p += 1;
      if (pl.t > pl.horizon) pl.horizon = pl.t;
      place(color, pl.p, pl.t, pl.x, pl.y);
      events.push({
        turn: turn,
        color: color,
        kind: bounced ? 'blocked' : action === 'I' ? 'inverted' : action === 'H' ? 'held' : 'moved',
        t: pl.t, x: pl.x, y: pl.y,
        by: bounced ? bounceBy[color] : null, dir: pl.dir
      });
    }
    hash = hashState(bodies, players, roster);
  }

  this._cache = {
    players: players, bodies: bodies, occ: occ, events: events,
    turn: turn, over: turn >= cfg.cap, hash: hash
  };
  return this._cache;
};

Match.prototype.config = function () {
  var c = this._cfg;
  return { w: c.w, h: c.h, wallPct: c.wallPct, seed: c.seed, cap: c.cap, roster: c.roster.slice() };
};
Match.prototype.currentTurn = function () { return this._derive().turn; };
Match.prototype.stateHash = function () { return this._derive().hash; };

Match.prototype.pendingColors = function () {
  var d = this._derive(), turn = d.turn, done = {};
  this._log.forEach(function (e) { if (e.turn === turn) done[e.color] = 1; });
  return this._cfg.roster.filter(function (c) { return !done[c]; });
};

// Index into _log of this colour's entry for the current turn, or -1. A turn
// resolves the moment everyone is in, so an entry found here is always still a
// draft. It has not been applied to anything.
Match.prototype._draftIndex = function (color, d) {
  var turn = d.turn;
  for (var i = this._log.length - 1; i >= 0; i--) {
    if (this._log[i].turn === turn && this._log[i].color === color) return i;
  }
  return -1;
};

Match.prototype._myAction = function (color, d) {
  var i = this._draftIndex(color, d);
  if (i < 0) return null;
  return Wire.encodeAction({
    turn: d.turn, color: color, action: this._log[i].action,
    hash: d.hash, name: this._names[color]
  });
};

// If someone already pasted your first string, your replacement bounces off
// pendingColors as a repeat and neither of you finds out until the next hash.
Match.prototype.withdraw = function (color) {
  if (this._cfg.roster.indexOf(color) < 0) return { ok: false, error: 'colour ' + color + ' is not in this match' };
  var d = this._derive();
  if (d.over) return { ok: false, error: 'the match is over' };
  var i = this._draftIndex(color, d);
  if (i < 0) return { ok: false, error: 'you have not acted this turn' };
  this._log.splice(i, 1);
  this._cache = null;
  return { ok: true };
};

Match.prototype.legalActions = function (color) {
  var d = this._derive();
  if (!d.players[color]) throw new Error('unknown colour ' + color);
  if (d.over) {
    var out = {};
    ACTIONS.forEach(function (a) { out[a] = 'the match is over'; });
    return out;
  }
  return this._legalFrom(d.players[color], d.occ);
};

Match.prototype.submit = function (sub) {
  var d = this._derive();
  if (d.over) return { ok: false, error: 'the match is over' };
  if (this._cfg.roster.indexOf(sub.color) < 0) return { ok: false, error: 'colour ' + sub.color + ' is not in this match' };
  if (sub.turn !== d.turn) return { ok: false, error: 'that string is for turn ' + sub.turn + ', this match is on turn ' + d.turn };
  if (sub.hash !== d.hash) return { ok: false, error: 'state hash ' + sub.hash + ' does not match yours (' + d.hash + '). Your timelines have diverged' };
  if (this.pendingColors().indexOf(sub.color) < 0) return { ok: false, error: COLORS[sub.color].name + ' has already acted this turn' };
  var legal = this.legalActions(sub.color);
  if (!(sub.action in legal)) return { ok: false, error: '"' + sub.action + '" is not an action' };
  if (legal[sub.action] !== null) return { ok: false, error: 'illegal: ' + legal[sub.action] };
  if (sub.name != null && !this.setName(sub.color, sub.name)) {
    return { ok: false, error: 'a name must be 1-12 letters, digits, - or _' };
  }
  this._log.push({ turn: sub.turn, color: sub.color, action: sub.action });
  this._cache = null;
  return { ok: true };
};

// Names arrive on turn-0 action strings, in an export, or from the local setup
// screen. Late arrivals are ignored rather than refused. A player who renamed
// themselves mid-match would otherwise desync everyone who saw them first.
Match.prototype.setName = function (color, name) {
  if (this._cfg.roster.indexOf(color) < 0 || !validName(name)) return false;
  if (!(color in this._names)) this._names[color] = name;
  return true;
};

Match.prototype.names = function () {
  var out = {}, self = this;
  this._cfg.roster.forEach(function (c) { if (c in self._names) out[c] = self._names[c]; });
  return out;
};

Match.prototype.view = function (color) {
  var self = this, d = this._derive(), cfg = this._cfg;
  var me = d.players[color];
  if (!me) throw new Error('unknown colour ' + color);
  var hz = me.horizon;
  var walls = Array.from(this._walls).map(function (k) {
    var p = k.split(','); return [+p[0], +p[1]];
  }).sort(function (a, b) { return a[1] - b[1] || a[0] - b[0]; });

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
    // Horizon filtering happens here and only here, so no renderer can draw
    // past it by accident.
    bodies: d.bodies.filter(function (b) { return b.t <= hz; }).map(function (b) {
      return { color: b.color, p: b.p, t: b.t, x: b.x, y: b.y, live: d.players[b.color].p === b.p };
    }),
    // Copied, not filtered. Filter clones the array but not the entries, and a
    // caller holding a reference into the cache could edit the match's own past.
    events: d.events.filter(function (e) { return e.t <= hz; }).map(function (e) {
      return {
        turn: e.turn, color: e.color, kind: e.kind,
        t: e.t, x: e.x, y: e.y, by: e.by, dir: e.dir
      };
    }),
    names: this.names(),
    // The string this player owes everyone else, rebuilt from the log rather
    // than remembered by the screen, so it survives a reload or a re-import.
    myAction: this._myAction(color, d),
    // Every action with the square it would land on, so the board and the button
    // row read one structure and no renderer re-derives DIRS.
    actions: d.over ? [] : ACTIONS.map(function (a) {
      var tg = targetOf(me, a);
      return {
        action: a, reason: self._blockReason(me, a, d.occ),
        t: tg.t, x: tg.x, y: tg.y, move: tg.move
      };
    })
  };
};

Match.prototype.export = function () {
  return Wire.encodeExport(this.config(), this._log, this._names);
};

var Wire = {
  // A name rides along on turn 0 only. That is the one string every other client
  // is guaranteed to receive, so nobody has to broadcast a name separately.
  encodeAction: function (a) {
    var s = '' + a.turn + a.color + ':' + a.action + '#' + a.hash;
    if (a.turn === 0 && validName(a.name)) s += '~' + a.name;
    return s;
  },
  decodeAction: function (s) {
    var m = /^(\d{1,4})([CPTA]):([WASDHI])#([0-9a-f]{4})(?:~([A-Za-z0-9_-]{1,12}))?$/
      .exec(String(s == null ? '' : s).trim());
    if (!m) return { ok: false, error: 'not an action string (expected something like 7C:D#a3f2)' };
    return {
      ok: true,
      value: {
        turn: +m[1], color: m[2], action: m[3], hash: m[4],
        name: m[5] == null ? null : m[5]
      }
    };
  },

  encodeMatchCode: function (c) {
    return 'M1:' + c.w + 'x' + c.h + ':' + c.wallPct + ':' + c.seed + ':' + c.cap + ':' + c.roster.join('');
  },
  decodeMatchCode: function (s) {
    var m = /^M1:(\d{1,3})x(\d{1,3}):(\d{1,2}):([A-Za-z0-9_-]{1,24}):(\d{1,4}):([CPTA]{1,4})$/
      .exec(String(s == null ? '' : s).trim());
    if (!m) return { ok: false, error: 'not a match code (expected something like M1:16x9:11:19f4:43:CPTA)' };
    var roster = m[6].split('');
    if (new Set(roster).size !== roster.length) return { ok: false, error: 'match code repeats a colour' };
    return {
      ok: true,
      value: { w: +m[1], h: +m[2], wallPct: +m[3], seed: m[4], cap: +m[5], roster: roster }
    };
  },

  encodeExport: function (config, log, names) {
    var byTurn = [];
    log.forEach(function (e) {
      if (!byTurn[e.turn]) byTurn[e.turn] = [];
      byTurn[e.turn].push(e.color + e.action);
    });
    var groups = [];
    for (var i = 0; i < byTurn.length; i++) groups.push((byTurn[i] || []).join(''));
    var nm = Object.keys(names || {}).filter(function (c) {
      return ORDER.indexOf(c) >= 0 && validName(names[c]);
    }).sort().map(function (c) { return c + '~' + names[c]; });
    return 'X1:' + Wire.encodeMatchCode(config) + '|' + groups.join(',') + '|' + nm.join(',');
  },
  decodeExport: function (s) {
    s = String(s == null ? '' : s).trim();
    if (s.slice(0, 3) !== 'X1:') return { ok: false, error: 'not an export string (it should start with X1:)' };
    // Two-section exports, with no name section, still load.
    var parts = s.slice(3).split('|');
    if (parts.length < 2 || parts.length > 3) {
      return { ok: false, error: 'export string is missing its action section' };
    }
    var mc = Wire.decodeMatchCode(parts[0]);
    if (!mc.ok) return { ok: false, error: 'export carries a bad match code: ' + mc.error };

    var names = {};
    var nameParts = (parts[2] || '').length ? parts[2].split(',') : [];
    for (var n = 0; n < nameParts.length; n++) {
      var nm2 = /^([CPTA])~([A-Za-z0-9_-]{1,12})$/.exec(nameParts[n]);
      if (!nm2) return { ok: false, error: 'bad name entry "' + nameParts[n] + '" in export' };
      names[nm2[1]] = nm2[2];
    }

    var rest = parts[1], log = [];
    var groups = rest.length ? rest.split(',') : [];
    for (var turn = 0; turn < groups.length; turn++) {
      var g = groups[turn];
      if (g.length % 2) return { ok: false, error: 'malformed action group at turn ' + turn };
      for (var i = 0; i < g.length; i += 2) {
        var color = g[i], action = g[i + 1];
        if (ORDER.indexOf(color) < 0 || ACTIONS.indexOf(action) < 0) {
          return { ok: false, error: 'bad action "' + g.slice(i, i + 2) + '" at turn ' + turn };
        }
        log.push({ turn: turn, color: color, action: action });
      }
    }
    return { ok: true, value: { config: mc.value, log: log, names: names } };
  }
};

export { Match, Wire, COLORS, ORDER, DIRS, MOVES, ACTIONS, spawnFor };
