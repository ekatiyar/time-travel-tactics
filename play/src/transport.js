import { Wire, COLORS } from './engine.js';

// A copy of the engine's hash, not a call into it. The engine block is held
// byte-identical to the time_travel prototype and does not export fnv1a.
function fnv1a(str) {
  var h = 0x811c9dc5;
  for (var i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}
function hex8(n) { return (n >>> 0).toString(16).padStart(8, '0'); }
function rid() { return hex8(fnv1a(Math.random() + '-' + Date.now())) + hex8(fnv1a(Math.random() + '')); }

// ---------- the sealed half of a turn ----------

function hexOf(bytes) {
  var out = '';
  for (var i = 0; i < bytes.length; i++) out += bytes[i].toString(16).padStart(2, '0');
  return out;
}
function nonce128() {
  var b = new Uint8Array(16);
  crypto.getRandomValues(b);
  return hexOf(b);
}
// Preimage is pinned in turn-transport.md §5. Changing one without the other
// produces commitments that never open, which on screen looks exactly like a
// diverged timeline and is not.
function digest128(turn, color, action, nonce) {
  var pre = new TextEncoder().encode(turn + ':' + color + ':' + action + ':' + nonce);
  return crypto.subtle.digest('SHA-256', pre).then(function (buf) {
    return hexOf(new Uint8Array(buf, 0, 16));
  });
}

// ---------- the match code envelope ----------

// One transport, so a match code is the engine's own six-segment string and
// nothing else. All this does is turn it into a room.
var Code = {
  roomId: function (s) {
    var str = String(s == null ? '' : s).trim();
    return 'tbtt-' + hex8(fnv1a(str)) + hex8(fnv1a('~' + str));
  }
};

// Match.export() serialises partial turns. Importing one hands you a draft you
// never saw a commitment for, and the turn then resolves locally the moment you
// commit, so your reveal never goes out and the other side waits forever. Cut
// back to the last finished turn instead. Nothing is lost: anyone still in the
// room sees you arrive as a peer and announces their claim and commitment again.
function trimUnresolved(str) {
  var r = Wire.decodeExport(str);
  if (!r.ok) return str;              // leave the error to Match.fromExport
  var full = r.value.config.roster.length, count = {};
  r.value.log.forEach(function (e) { count[e.turn] = (count[e.turn] || 0) + 1; });
  var cut = 0;
  while (count[cut] === full) cut++;  // the same stop _derive makes
  var log = r.value.log.filter(function (e) { return e.turn < cut; });
  return Wire.encodeExport(r.value.config, log, r.value.names);
}

// ---------- Channel: the seam ----------
//
//   channel.id           stable client id, used for claim tiebreaks
//   channel.send(text)   broadcast to the room
//   channel.onMessage    fn(text); duplicates are fine, order does not matter
//   channel.onStatus     fn({state, peers, detail}); state is one of
//                        offline | connecting | live | failed
//   channel.close()
//
// No acks, no ordering, no retries: Match.submit already refuses a repeat and
// _derive stops at the first incomplete turn, so a dumb channel is enough.

// Assigning onStatus fires immediately with where the channel already is. A
// callback that only reports changes leaves a freshly opened Session blind.
function statusPort(ch, initial) {
  var fn = null, cur = initial;
  Object.defineProperty(ch, 'onStatus', {
    get: function () { return fn; },
    set: function (v) { fn = v; if (fn) fn(copyStatus(cur)); }
  });
  return function (next) { cur = next; if (fn) fn(copyStatus(cur)); };
}
function copyStatus(s) {
  return { state: s.state, peers: (s.peers || []).slice(), detail: s.detail || null };
}

// Trystero over nostr, version-pinned because 0.23 and 0.25 both changed the API.

// In 0.25 the peer callbacks are assigned, not called: room.onPeerJoin = fn, not
// room.onPeerJoin(fn). Calling one throws, and because the message channel is
// already wired by then the match keeps working while the status line says it
// failed.

// Imported from the CDN rather than vendored. A local .js module is blocked by
// CORS on a file:// page, a remote one is not. Dynamic import so a CDN or relay
// failure is catchable instead of killing the page.
var TRYSTERO = 'https://esm.sh/@trystero-p2p/nostr@0.25.2?bundle';

function PeerChannel(roomId) {
  var ch = { id: 'p-' + rid(), onMessage: null };
  var emit = statusPort(ch, { state: 'connecting', peers: [], detail: null });
  var room = null, act = null, peers = [], closed = false;

  ch.send = function (text) { if (act) act.send(String(text)); };
  ch.close = function () {
    closed = true;
    if (room) { try { room.leave(); } catch (e) { /* already gone */ } }
    room = null; act = null;
    emit({ state: 'offline', peers: [], detail: null });
  };

  // A room with nobody in it is not live, it is still connecting. joinRoom
  // resolving only means the relays were reached.
  function report() {
    emit({ state: peers.length ? 'live' : 'connecting', peers: peers.slice(), detail: null });
  }

  import(TRYSTERO).then(function (m) {
    if (closed) return;
    // Trystero shuffles its relay pool by appId and keeps the first five, so a
    // fixed one draws the same five relays forever, dead ones included. The
    // room id varies per match and both peers already compute it identically.
    room = m.joinRoom({ appId: roomId }, roomId);
    act = room.makeAction('m');                       // {send, onMessage, onReceiveProgress}
    act.onMessage = function (data) {                 // assigned, not called
      if (ch.onMessage) ch.onMessage(String(data));
    };
    room.onPeerJoin = function (id) {                 // assigned, not called
      if (peers.indexOf(id) < 0) peers.push(id);
      report();
    };
    room.onPeerLeave = function (id) {
      peers = peers.filter(function (p) { return p !== id; });
      report();
    };
    peers = Object.keys(room.getPeers() || {});
    report();
  }).catch(function (e) {
    emit({ state: 'failed', peers: [], detail: String((e && e.message) || e) });
  });

  return ch;
}

// Test-only. Delivery is synchronous, so a test never has to wait or pump.
var lbSeq = 0;
function LoopbackChannel(id) {
  var ch = { id: id, onMessage: null, wires: [] };
  var emit = statusPort(ch, { state: 'live', peers: [], detail: null });
  ch.emit = emit;
  ch.send = function (text) {
    ch.wires.slice().forEach(function (o) { if (o.onMessage) o.onMessage(String(text)); });
  };
  ch.close = function () { ch.wires = []; ch.onMessage = null; emit({ state: 'offline', peers: [], detail: null }); };
  return ch;
}
LoopbackChannel.make = function (id) { return LoopbackChannel(id || 'lb' + (++lbSeq)); };
// Wiring and announcing are one call, so a test can bring a peer in late and
// exercise the rejoin path.
LoopbackChannel.link = function (a, b) {
  if (a.wires.indexOf(b) < 0) a.wires.push(b);
  if (b.wires.indexOf(a) < 0) b.wires.push(a);
  a.emit({ state: 'live', peers: a.wires.map(function (o) { return o.id; }), detail: null });
  b.emit({ state: 'live', peers: b.wires.map(function (o) { return o.id; }), detail: null });
};
LoopbackChannel.pair = function () {
  var n = ++lbSeq;
  var a = LoopbackChannel('lb' + n + 'a'), b = LoopbackChannel('lb' + n + 'b');
  LoopbackChannel.link(a, b);
  return [a, b];
};

// ---------- Session: the module above the seam ----------
//
// Owns the Match and the Channel. Three message kinds share the one send() and
// are told apart by their first character: a claim with '!', a commitment with
// '#', a reveal with a digit.
//
//   !C~Rook@k3f9x2               a colour claim
//   #7C:9f3a1c4e...              a commitment: turn, colour, 128-bit digest
//   7C:D#a3f2|4b1e...            a reveal: the engine's action string, then the nonce
//
// The reveal is the only message anyone acts on, and that is what makes changing
// your mind safe. A commitment discloses nothing, so publishing three of them for
// one turn costs nobody anything; whichever one you open is the one that counts.

var CLAIM_RE = /^!([CPTA])~([A-Za-z0-9_-]{1,12})@([A-Za-z0-9_-]{1,80})$/;
var COMMIT_RE = /^#(\d{1,4})([CPTA]):([0-9a-f]{32})$/;
var REVEAL_RE = /^(.*)\|([0-9a-f]{32})$/;

function ckey(turn, color) { return turn + color; }

function Session(o) {
  this._match = o.match;
  this._ch = o.channel;
  this._onChange = o.onChange || function () {};
  this._claims = {};
  this._me = null;
  this._buffer = [];
  this._commitments = {};   // "0C" -> [digest, ...]; more than one is legitimate
  this._reveals = {};       // "0C" -> reveals whose commitment has not arrived yet
  this._mine = null;        // {turn, action, nonce, digest, revealed}
  this._peers = [];
  this._status = { state: 'offline', peers: [], detail: null };
  // Two kinds of bad news, and they behave differently. A notice is something
  // you can act on, such as picking another colour, and it clears when you do.
  // An error is a divergence. Nothing you do at the keyboard fixes it, so it latches.
  this._error = null;
  this._notice = null;
  var self = this;
  this._ch.onMessage = function (text) { self._receive(String(text)); };
  this._ch.onStatus = function (s) { self._statusChanged(s); };
}
Session.open = function (o) { return new Session(o); };

Session.prototype._changed = function () { this._onChange(this); };

Session.prototype._statusChanged = function (s) {
  var before = this._peers;
  this._status = copyStatus(s);
  this._peers = this._status.peers.slice();
  var fresh = this._peers.filter(function (p) { return before.indexOf(p) < 0; });
  // A peer appearing is the whole reconnect mechanism. Tell it who you are and
  // what you have already done this turn. No timers, no heartbeats, no hello.
  if (fresh.length) this._announce();
  this._changed();
};

Session.prototype._announce = function () {
  if (!this._me) return;
  if (this._claims[this._me]) this._ch.send(this._claimString(this._me));
  var m = this._mine;
  if (!m || m.turn !== this._match.currentTurn()) return;
  this._ch.send(this._commitString(m));
  // Given only the commitment, a client arriving after you opened would sit
  // forever on a turn everyone else has finished with.
  if (m.revealed) this._ch.send(this._revealString(m));
};

Session.prototype._commitString = function (m) { return '#' + m.turn + this._me + ':' + m.digest; };
Session.prototype._revealString = function (m) { return m.action + '|' + m.nonce; };

Session.prototype._claimString = function (color) {
  var c = this._claims[color];
  return '!' + color + '~' + c.name + '@' + c.clientId;
};

Session.prototype.claims = function () {
  var out = {}, self = this;
  Object.keys(this._claims).forEach(function (c) {
    out[c] = { name: self._claims[c].name, clientId: self._claims[c].clientId };
  });
  return out;
};

Session.prototype.color = function () { return this._me; };

// Giving up a seat has to give up what was played with it, or the draft stays in
// the log under a colour we no longer speak for and we run a turn ahead of the
// room. The broadcast commitment cannot be retracted, but our own copy of it can,
// or _maybeReveal counts that colour as in and opens our next action early.
Session.prototype._dropSeat = function (color) {
  var m = this._mine, turn = this._match.currentTurn();
  this._match.withdraw(color);        // no draft on this turn is not an error here
  if (m && m.turn === turn) {
    var k = ckey(turn, color), set = this._commitments[k] || [];
    this._commitments[k] = set.filter(function (d) { return d !== m.digest; });
  }
  this._mine = null;
};

// No authority and none needed. The lower client id keeps a contested colour, and
// every client runs that same comparison, so the same player is bounced on every
// screen.
Session.prototype.claim = function (color, name) {
  var self = this;
  function refuse(msg) { self._notice = msg; return { ok: false, error: msg }; }
  if (this._match.config().roster.indexOf(color) < 0) {
    return refuse('colour ' + color + ' is not in this match');
  }
  var held = this._claims[color];
  if (held && held.clientId !== this._ch.id && held.clientId < this._ch.id) {
    return refuse(COLORS[color].name + ' is taken by ' + held.name);
  }
  if (this._me && this._me !== color) this._dropSeat(this._me);
  this._claims[color] = { name: name, clientId: this._ch.id };
  this._me = color;
  this._notice = null;
  this._match.setName(color, name);
  this._ch.send(this._claimString(color));
  this._changed();
  return { ok: true, error: null };
};

Session.prototype._claimReceived = function (text) {
  var m = CLAIM_RE.exec(text);
  if (!m) return;
  var color = m[1], name = m[2], id = m[3];
  var held = this._claims[color];
  if (held && held.clientId <= id) return;
  this._claims[color] = { name: name, clientId: id };
  if (this._me === color && id < this._ch.id) {
    this._dropSeat(color);
    this._me = null;
    this._notice = COLORS[color].name + ' was claimed first by ' + name + '. Pick another colour.';
  }
  this._changed();
};

Session.prototype._receive = function (text) {
  if (text.charAt(0) === '!') return this._claimReceived(text);
  if (text.charAt(0) === '#') return this._commitmentReceived(text);
  return this._revealReceived(text);
};

// ---------- commitments ----------

Session.prototype._hasCommitment = function (turn, color) {
  var set = this._commitments[ckey(turn, color)];
  return !!(set && set.length);
};

Session.prototype._addCommitment = function (turn, color, digest) {
  var k = ckey(turn, color), set = this._commitments[k] || (this._commitments[k] = []);
  if (set.indexOf(digest) < 0) set.push(digest);
};

Session.prototype._commitmentReceived = function (text) {
  var m = COMMIT_RE.exec(text);
  if (!m) return;                          // noise on a public room is not the match's problem
  var turn = +m[1], color = m[2], digest = m[3];
  if (color === this._me) return;          // nobody else gets to seal for our colour
  if (this._match.config().roster.indexOf(color) < 0) return;
  if (turn < this._match.currentTurn() || turn >= this._match.config().cap) return;
  this._addCommitment(turn, color, digest);
  // This runs before reopening anything. A held reveal completing this turn
  // would advance the match and prune our own draft out from under us, unsent.
  this._maybeReveal();
  var self = this;
  this._reopen(turn, color).then(function () { self._changed(); });
  this._changed();
};

// ---------- reveals ----------

// A reveal that opens nothing is not dropped, it is kept. Over a channel with no
// ordering it may simply have overtaken its own commitment.
Session.prototype._revealReceived = function (text) {
  var m = REVEAL_RE.exec(text);
  if (!m) return;
  var d = Wire.decodeAction(m[1]);
  if (!d.ok) return;
  if (d.value.color === this._me) return;  // our own broadcast coming back
  if (this._match.config().roster.indexOf(d.value.color) < 0) return;
  if (d.value.turn < this._match.currentTurn() || d.value.turn >= this._match.config().cap) return;
  var self = this, rec = { action: m[1], nonce: m[2], v: d.value };
  this._open(rec).then(function (opened) {
    if (!opened) self._hold(rec);
    self._changed();
  });
};

Session.prototype._open = function (rec) {
  var self = this, v = rec.v;
  return digest128(v.turn, v.color, v.action, rec.nonce).then(function (d) {
    var set = self._commitments[ckey(v.turn, v.color)];
    if (!set || set.indexOf(d) < 0) return false;
    if (self._buffer.indexOf(rec.action) < 0) self._buffer.push(rec.action);
    // Held, not applied, until we have committed. Automatic delivery would
    // otherwise hand a free look at the opponent's move to whoever commits second.
    if (self._committed()) self._flush();
    return true;
  });
};

// A colour reveals once per turn, so one slot per colour per turn is the whole
// store. Latest wins: on a public room the store stays bounded either way, and a
// peer that changed its mind is better served by its newer reveal.
Session.prototype._hold = function (rec) {
  this._reveals[ckey(rec.v.turn, rec.v.color)] = rec;
};

Session.prototype._reopen = function (turn, color) {
  var self = this, k = ckey(turn, color), rec = this._reveals[k];
  if (!rec) return Promise.resolve();
  return this._open(rec).then(function (opened) { if (opened) delete self._reveals[k]; });
};

// Everything behind the playhead is settled and can go. Everything ahead of it
// stays. A commitment for the next turn arriving during this one is ordinary.
Session.prototype._prune = function () {
  var turn = this._match.currentTurn();
  [this._commitments, this._reveals].forEach(function (store) {
    Object.keys(store).forEach(function (k) { if (parseInt(k, 10) < turn) delete store[k]; });
  });
  if (this._mine && this._mine.turn < turn) this._mine = null;
};

Session.prototype._committed = function () {
  return !!this._me && this._match.pendingColors().indexOf(this._me) < 0;
};

// Every case the engine would refuse is decided here instead, on turn and hash.
// Parsing submit's error text would couple the transport to wording meant for
// a player to read.
Session.prototype._flush = function () {
  var self = this, keep = [];
  if (this._match.currentTurn() >= this._match.config().cap) { this._buffer = []; this._prune(); return; }
  this._buffer.forEach(function (text) {
    var d = Wire.decodeAction(text), turn = self._match.currentTurn();
    if (!d.ok) return;
    if (d.value.turn > turn) { keep.push(text); return; }   // ahead of us, hold it
    if (d.value.turn < turn) return;                        // behind us, already applied
    if (self._match.pendingColors().indexOf(d.value.color) < 0) return;
    if (d.value.hash !== self._match.stateHash()) {
      // The two matches are already broken and the only cure is a fresh
      // export/import, so this latches rather than flashes.
      self._error = 'turn ' + d.value.turn + ' arrived on state ' + d.value.hash +
        ', but this match is on ' + self._match.stateHash() +
        ', your timelines have diverged. Export and re-import to get back in step.';
      return;
    }
    var r = self._match.submit(d.value);
    if (!r.ok) self._error = r.error;   // nothing legitimate is left to fail on
  });
  this._buffer = keep;
  this._prune();
};

// Async, because sealing an action means hashing it. The local submit still
// happens first and synchronously, so the screen has something to draw while
// the opponent is still deciding, and myAction keeps working.
Session.prototype.commit = function (action) {
  if (!this._me) return Promise.resolve({ ok: false, error: 'pick a colour first' });
  var self = this, turn = this._match.currentTurn(), color = this._me;
  var r = this._match.submit({
    turn: turn, color: color, action: action, hash: this._match.stateHash()
  });
  if (!r.ok) return Promise.resolve(r);
  // The engine's own string, so a name still rides along on turn 0. An export is
  // never broadcast. It serialises partial turns and would leak the current one.
  var out = this._match.view(color).myAction;
  var nonce = nonce128();
  return digest128(turn, color, action, nonce).then(function (digest) {
    self._mine = { turn: turn, action: out, nonce: nonce, digest: digest, revealed: false };
    self._addCommitment(turn, color, digest);
    self._ch.send(self._commitString(self._mine));
    self._maybeReveal();
    self._flush();
    self._changed();
    return { ok: true, error: null };
  });
};

// Nobody asks for a reveal and nobody acks one. The last commitment landing is
// the signal. Every client sees it, so everything opens at once.
Session.prototype._maybeReveal = function () {
  var m = this._mine, self = this;
  if (!m || m.revealed || m.turn !== this._match.currentTurn()) return;
  var all = this._match.config().roster.every(function (c) { return self._hasCommitment(m.turn, c); });
  if (!all) return;
  m.revealed = true;
  this._ch.send(this._revealString(m));
};

Session.prototype.withdraw = function () {
  if (!this._me) return { ok: false, error: 'pick a colour first' };
  var m = this._mine;
  if (m && m.revealed && m.turn === this._match.currentTurn()) {
    return { ok: false, error: 'your action is already open, everyone has it' };
  }
  var r = this._match.withdraw(this._me);
  if (!r.ok) return r;
  // Dropping the digest only tidies our own books. The opponent cannot unsee a
  // commitment, and does not need to. It discloses nothing, and the replacement
  // we publish next is the one we will open.
  if (m) {
    var set = this._commitments[ckey(m.turn, this._me)] || [];
    this._commitments[ckey(m.turn, this._me)] = set.filter(function (d) { return d !== m.digest; });
    this._mine = null;
  }
  this._changed();
  return r;
};

// The engine's view with the transport's own fields merged in, so renderBoard,
// renderStrip, renderLegend and renderLog keep working untouched.
//
// Seatless, this renders the first colour in the roster so the picker has
// something to read. Do not put that on screen as a board. Check color() first.
Session.prototype.view = function () {
  var color = this._me || this._match.config().roster[0];
  var self = this, v = this._match.view(color);
  v.peers = this._status.peers.slice();
  v.detail = this._status.detail;
  // Live means a turn can actually resolve. Nothing opens until every roster
  // colour has committed, so a room short of players is still connecting no
  // matter what the channel thinks of its own sockets.
  v.peersNeeded = Math.max(0, this._match.config().roster.length - 1 - v.peers.length);
  v.status = this._status.state;
  if (v.status === 'live' && v.peersNeeded) v.status = 'connecting';
  // A commitment counts as in, one phase earlier than a submission does. That is
  // the moment you lose the right to change your action, so it is the moment the
  // strip has to stop saying you are owed something.
  v.waiting = v.pending.filter(function (c) {
    return c !== color && !self._hasCommitment(v.turn, c);
  });
  v.canChange = !!(this._mine && !this._mine.revealed && this._mine.turn === v.turn);
  v.error = this._error;
  v.notice = this._notice;
  return v;
};

Session.prototype.export = function () { return this._match.export(); };

Session.prototype.close = function () {
  this._ch.onMessage = null;
  this._ch.close();
};
export { Session, Code, trimUnresolved, PeerChannel, LoopbackChannel };
