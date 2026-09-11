import { Wire, COLORS, fnv1a, isColor, metaTurn } from './engine.js';
import type { Action, Color, Config, DecodedAction, MetaTurn, Match, View } from './engine.js';

function hex8(n: number): string { return (n >>> 0).toString(16).padStart(8, '0'); }
function rid(): string {
  return hex8(fnv1a(Math.random() + '-' + Date.now())) + hex8(fnv1a(Math.random() + ''));
}

// ---------- the sealed half of a turn ----------

function hexOf(bytes: Uint8Array): string {
  let out = '';
  for (const b of bytes) out += b.toString(16).padStart(2, '0');
  return out;
}
function nonce128(): string {
  const b = new Uint8Array(16);
  crypto.getRandomValues(b);
  return hexOf(b);
}
// Preimage is pinned in turn-transport.md §5. Changing one without the other
// produces commitments that never open, which on screen looks exactly like a
// diverged timeline and is not.
async function digest128(turn: number, color: string, action: string, nonce: string): Promise<string> {
  const pre = new TextEncoder().encode(turn + ':' + color + ':' + action + ':' + nonce);
  const buf = await crypto.subtle.digest('SHA-256', pre);
  return hexOf(new Uint8Array(buf, 0, 16));
}

// ---------- the match code envelope ----------

// One transport, so a match code is the engine's own six-segment string and
// nothing else. All this does is turn it into a room.
const Code = {
  roomId: function (s: unknown): string {
    const str = String(s == null ? '' : s).trim();
    return 'tbtt-' + hex8(fnv1a(str)) + hex8(fnv1a('~' + str));
  }
};

// Match.export() serialises partial turns. Importing one hands you a draft you
// never saw a commitment for, and the turn then resolves locally the moment you
// commit, so your reveal never goes out and the other side waits forever. Cut
// back to the last finished turn instead. Nothing is lost: anyone still in the
// room sees you arrive as a peer and announces their claim and commitment again.
function trimUnresolved(str: string): string {
  const r = Wire.decodeExport(str);
  if (!r.ok) return str;              // leave the error to Match.fromExport
  const full = r.value.config.roster.length;
  const count = new Map<number, number>();
  for (const e of r.value.log) count.set(e.turn, (count.get(e.turn) ?? 0) + 1);
  let cut = 0;
  while (count.get(cut) === full) cut++;  // the same stop _derive makes
  const log = r.value.log.filter((e) => e.turn < cut);
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

export type ChannelState = 'offline' | 'connecting' | 'live' | 'failed';
export type ChannelStatus = { state: ChannelState; peers: string[]; detail: string | null };
export type Channel = {
  id: string;
  send: (text: string) => void;
  onMessage: ((text: string) => void) | null;
  onStatus: ((s: ChannelStatus) => void) | null;
  close: () => void;
};

// Assigning onStatus fires immediately with where the channel already is. A
// callback that only reports changes leaves a freshly opened Session blind.
function statusPort(ch: Channel, initial: ChannelStatus): (next: ChannelStatus) => void {
  let fn: Channel['onStatus'] = null, cur = initial;
  Object.defineProperty(ch, 'onStatus', {
    get: function () { return fn; },
    set: function (v: Channel['onStatus']) { fn = v; if (fn) fn(copyStatus(cur)); }
  });
  return function (next) { cur = next; if (fn) fn(copyStatus(cur)); };
}
function copyStatus(s: ChannelStatus): ChannelStatus {
  return { state: s.state, peers: s.peers.slice(), detail: s.detail ?? null };
}

// ---------- PeerChannel: a room on the network ----------
//
// Only the five members PeerChannel touches. Trystero's own Room is far wider,
// and a fake room in a test has to satisfy this and nothing more.

export type RoomAction = {
  send: (data: string) => unknown;
  // Trystero hands the handler a second argument this code never reads. Typed
  // never rather than dropped, because the property is invariant: a one-argument
  // type would refuse the real room.
  onMessage: ((data: string, context: never) => void) | null;
};
export type Room = {
  makeAction: (namespace: string) => RoomAction;
  leave: () => unknown;
  getPeers: () => Record<string, unknown>;
  onPeerJoin: ((peerId: string) => void) | null;
  onPeerLeave: ((peerId: string) => void) | null;
};
export type RoomLoader = (roomId: string) => Promise<Room>;

// Trystero over nostr, version-pinned in package.json because 0.23 and 0.25
// both changed the API.
//
// In 0.25 the peer callbacks are assigned, not called: room.onPeerJoin = fn, not
// room.onPeerJoin(fn). Calling one throws, and because the message channel is
// already wired by then the match keeps working while the status line says it
// failed.
//
// Dynamic import so a bundle split keeps it out of the first load and so a
// failure to reach a relay is catchable instead of killing the page.
const joinTrystero: RoomLoader = async (roomId) => {
  const m = await import('@trystero-p2p/nostr');
  // Trystero shuffles its relay pool by appId and keeps the first five, so a
  // fixed one draws the same five relays forever, dead ones included. The room
  // id varies per match and both peers already compute it identically.
  return m.joinRoom({ appId: roomId }, roomId);
};

function PeerChannel(roomId: string, loadRoom: RoomLoader = joinTrystero): Channel {
  let room: Room | null = null, act: RoomAction | null = null;
  let peers: string[] = [], closed = false;

  const ch: Channel = {
    id: 'p-' + rid(),
    onMessage: null,
    onStatus: null,
    send: function (text) { if (act) act.send(String(text)); },
    close: function () {
      closed = true;
      if (room) { try { room.leave(); } catch { /* already gone */ } }
      room = null; act = null;
      emit({ state: 'offline', peers: [], detail: null });
    }
  };
  const emit = statusPort(ch, { state: 'connecting', peers: [], detail: null });

  // A room with nobody in it is not live, it is still connecting. Joining
  // resolving only means the relays were reached.
  function report(): void {
    emit({ state: peers.length ? 'live' : 'connecting', peers: peers.slice(), detail: null });
  }

  loadRoom(roomId).then(function (joined) {
    if (closed) return;
    room = joined;
    act = room.makeAction('m');                       // {send, onMessage, onReceiveProgress}
    act.onMessage = function (data) {                 // assigned, not called
      if (ch.onMessage) ch.onMessage(String(data));
    };
    room.onPeerJoin = function (id) {                 // assigned, not called
      if (peers.indexOf(id) < 0) peers.push(id);
      report();
    };
    room.onPeerLeave = function (id) {
      peers = peers.filter((p) => p !== id);
      report();
    };
    peers = Object.keys(room.getPeers() || {});
    report();
  }).catch(function (e: unknown) {
    emit({ state: 'failed', peers: [], detail: String(e instanceof Error ? e.message : e) });
  });

  return ch;
}

// Test-only. Delivery is synchronous, so a test never has to wait or pump.
export type LoopbackEnd = Channel & {
  wires: LoopbackEnd[];
  emit: (s: ChannelStatus) => void;
};

let lbSeq = 0;
function makeLoopback(id: string): LoopbackEnd {
  const ch: LoopbackEnd = {
    id: id,
    onMessage: null,
    onStatus: null,
    wires: [],
    emit: () => {},
    send: function (text) {
      for (const o of ch.wires.slice()) if (o.onMessage) o.onMessage(String(text));
    },
    close: function () {
      ch.wires = []; ch.onMessage = null;
      ch.emit({ state: 'offline', peers: [], detail: null });
    }
  };
  ch.emit = statusPort(ch, { state: 'live', peers: [], detail: null });
  return ch;
}

const LoopbackChannel = Object.assign(makeLoopback, {
  make: function (id?: string): LoopbackEnd { return makeLoopback(id || 'lb' + (++lbSeq)); },
  // Wiring and announcing are one call, so a test can bring a peer in late and
  // exercise the rejoin path.
  link: function (a: LoopbackEnd, b: LoopbackEnd): void {
    if (a.wires.indexOf(b) < 0) a.wires.push(b);
    if (b.wires.indexOf(a) < 0) b.wires.push(a);
    a.emit({ state: 'live', peers: a.wires.map((o) => o.id), detail: null });
    b.emit({ state: 'live', peers: b.wires.map((o) => o.id), detail: null });
  },
  pair: function (): [LoopbackEnd, LoopbackEnd] {
    const n = ++lbSeq;
    const a = makeLoopback('lb' + n + 'a'), b = makeLoopback('lb' + n + 'b');
    LoopbackChannel.link(a, b);
    return [a, b];
  }
});

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

const CLAIM_RE = /^!([CPTA])~([A-Za-z0-9_-]{1,12})@([A-Za-z0-9_-]{1,80})$/;
const COMMIT_RE = /^#(\d{1,4})([CPTA]):([0-9a-f]{32})$/;
const REVEAL_RE = /^(.*)\|([0-9a-f]{32})$/;

function ckey(turn: MetaTurn, color: Color): string { return turn + color; }

type Claim = { name: string; clientId: string };
type Mine = { turn: MetaTurn; action: string; nonce: string; digest: string; revealed: boolean };
type Held = { action: string; nonce: string; v: DecodedAction };

export type SessionOptions = {
  match: Match;
  channel: Channel;
  onChange?: (s: Session) => void;
};

// The engine's view with the transport's own fields merged in, so renderBoard,
// renderStrip, renderLegend and renderLog keep working untouched.
export type SessionView = View & {
  peers: string[];
  detail: string | null;
  peersNeeded: number;
  status: ChannelState;
  waiting: Color[];
  canChange: boolean;
  error: string | null;
  notice: string | null;
};

class Session {
  private _match: Match;
  private _ch: Channel;
  private _onChange: (s: Session) => void;
  private _claims: Partial<Record<Color, Claim>>;
  private _me: Color | null;
  private _buffer: string[];
  private _commitments: Map<string, string[]>;   // "0C" -> [digest, ...]; more than one is legitimate
  private _reveals: Map<string, Held>;           // "0C" -> reveals whose commitment has not arrived yet
  private _mine: Mine | null;
  private _peers: string[];
  private _status: ChannelStatus;
  // Two kinds of bad news, and they behave differently. A notice is something
  // you can act on, such as picking another colour, and it clears when you do.
  // An error is a divergence. Nothing you do at the keyboard fixes it, so it latches.
  private _error: string | null;
  private _notice: string | null;

  constructor(o: SessionOptions) {
    this._match = o.match;
    this._ch = o.channel;
    this._onChange = o.onChange ?? function () {};
    this._claims = {};
    this._me = null;
    this._buffer = [];
    this._commitments = new Map();
    this._reveals = new Map();
    this._mine = null;
    this._peers = [];
    this._status = { state: 'offline', peers: [], detail: null };
    this._error = null;
    this._notice = null;
    this._ch.onMessage = (text) => { this._receive(String(text)); };
    this._ch.onStatus = (s) => { this._statusChanged(s); };
  }

  static open(o: SessionOptions): Session { return new Session(o); }

  private _changed(): void { this._onChange(this); }

  private _statusChanged(s: ChannelStatus): void {
    const before = this._peers;
    this._status = copyStatus(s);
    this._peers = this._status.peers.slice();
    const fresh = this._peers.filter((p) => before.indexOf(p) < 0);
    // A peer appearing is the whole reconnect mechanism. Tell it who you are and
    // what you have already done this turn. No timers, no heartbeats, no hello.
    if (fresh.length) this._announce();
    this._changed();
  }

  private _announce(): void {
    if (!this._me) return;
    if (this._claims[this._me]) this._ch.send(this._claimString(this._me));
    const m = this._mine;
    if (!m || m.turn !== this._match.currentTurn()) return;
    this._ch.send(this._commitString(m));
    // Given only the commitment, a client arriving after you opened would sit
    // forever on a turn everyone else has finished with.
    if (m.revealed) this._ch.send(this._revealString(m));
  }

  private _commitString(m: Mine): string { return '#' + m.turn + this._me + ':' + m.digest; }
  private _revealString(m: Mine): string { return m.action + '|' + m.nonce; }

  private _claimString(color: Color): string {
    const c = this._claims[color];
    if (!c) throw new Error('no claim on ' + color);
    return '!' + color + '~' + c.name + '@' + c.clientId;
  }

  claims(): Partial<Record<Color, Claim>> {
    const out: Partial<Record<Color, Claim>> = {};
    for (const c of Object.keys(this._claims)) {
      const held = isColor(c) ? this._claims[c] : undefined;
      if (isColor(c) && held) out[c] = { name: held.name, clientId: held.clientId };
    }
    return out;
  }

  color(): Color | null { return this._me; }

  // Giving up a seat has to give up what was played with it, or the draft stays in
  // the log under a colour we no longer speak for and we run a turn ahead of the
  // room. The broadcast commitment cannot be retracted, but our own copy of it can,
  // or _maybeReveal counts that colour as in and opens our next action early.
  private _dropSeat(color: Color): void {
    const m = this._mine, turn = this._match.currentTurn();
    this._match.withdraw(color);        // no draft on this turn is not an error here
    if (m && m.turn === turn) {
      const k = ckey(turn, color), set = this._commitments.get(k) ?? [];
      this._commitments.set(k, set.filter((d) => d !== m.digest));
    }
    this._mine = null;
  }

  // No authority and none needed. The lower client id keeps a contested colour, and
  // every client runs that same comparison, so the same player is bounced on every
  // screen.
  claim(color: string, name: string): { ok: boolean; error: string | null } {
    const refuse = (msg: string) => { this._notice = msg; return { ok: false, error: msg }; };
    if (!isColor(color) || this._match.config().roster.indexOf(color) < 0) {
      return refuse('colour ' + color + ' is not in this match');
    }
    const held = this._claims[color];
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
  }

  private _claimReceived(text: string): void {
    const m = CLAIM_RE.exec(text);
    if (!m) return;
    const [, color = '', name = '', id = ''] = m;
    if (!isColor(color)) return;
    const held = this._claims[color];
    if (held && held.clientId <= id) return;
    this._claims[color] = { name: name, clientId: id };
    if (this._me === color && id < this._ch.id) {
      this._dropSeat(color);
      this._me = null;
      this._notice = COLORS[color].name + ' was claimed first by ' + name + '. Pick another colour.';
    }
    this._changed();
  }

  private _receive(text: string): void {
    if (text.charAt(0) === '!') return this._claimReceived(text);
    if (text.charAt(0) === '#') return this._commitmentReceived(text);
    return this._revealReceived(text);
  }

  // ---------- commitments ----------

  private _hasCommitment(turn: MetaTurn, color: Color): boolean {
    const set = this._commitments.get(ckey(turn, color));
    return !!(set && set.length);
  }

  private _addCommitment(turn: MetaTurn, color: Color, digest: string): void {
    const k = ckey(turn, color);
    let set = this._commitments.get(k);
    if (!set) { set = []; this._commitments.set(k, set); }
    if (set.indexOf(digest) < 0) set.push(digest);
  }

  private _commitmentReceived(text: string): void {
    const m = COMMIT_RE.exec(text);
    if (!m) return;                          // noise on a public room is not the match's problem
    const [, turnText = '', color = '', digest = ''] = m;
    if (!isColor(color)) return;
    const turn = metaTurn(+turnText);
    if (color === this._me) return;          // nobody else gets to seal for our colour
    if (this._match.config().roster.indexOf(color) < 0) return;
    if (turn < this._match.currentTurn() || turn >= this._match.config().cap) return;
    this._addCommitment(turn, color, digest);
    // This runs before reopening anything. A held reveal completing this turn
    // would advance the match and prune our own draft out from under us, unsent.
    this._maybeReveal();
    this._reopen(turn, color).then(() => { this._changed(); });
    this._changed();
  }

  // ---------- reveals ----------

  // A reveal that opens nothing is not dropped, it is kept. Over a channel with no
  // ordering it may simply have overtaken its own commitment.
  private _revealReceived(text: string): void {
    const m = REVEAL_RE.exec(text);
    if (!m) return;
    const [, action = '', nonce = ''] = m;
    const d = Wire.decodeAction(action);
    if (!d.ok) return;
    if (d.value.color === this._me) return;  // our own broadcast coming back
    if (this._match.config().roster.indexOf(d.value.color) < 0) return;
    if (d.value.turn < this._match.currentTurn() || d.value.turn >= this._match.config().cap) return;
    const rec: Held = { action: action, nonce: nonce, v: d.value };
    this._open(rec).then((opened) => {
      if (!opened) this._hold(rec);
      this._changed();
    });
  }

  private async _open(rec: Held): Promise<boolean> {
    const v = rec.v;
    const d = await digest128(v.turn, v.color, v.action, rec.nonce);
    const set = this._commitments.get(ckey(v.turn, v.color));
    if (!set || set.indexOf(d) < 0) return false;
    if (this._buffer.indexOf(rec.action) < 0) this._buffer.push(rec.action);
    // Held, not applied, until we have committed. Automatic delivery would
    // otherwise hand a free look at the opponent's move to whoever commits second.
    if (this._committed()) this._flush();
    return true;
  }

  // A colour reveals once per turn, so one slot per colour per turn is the whole
  // store. Latest wins: on a public room the store stays bounded either way, and a
  // peer that changed its mind is better served by its newer reveal.
  private _hold(rec: Held): void {
    this._reveals.set(ckey(rec.v.turn, rec.v.color), rec);
  }

  private async _reopen(turn: MetaTurn, color: Color): Promise<void> {
    const k = ckey(turn, color), rec = this._reveals.get(k);
    if (!rec) return;
    if (await this._open(rec)) this._reveals.delete(k);
  }

  // Everything behind the playhead is settled and can go. Everything ahead of it
  // stays. A commitment for the next turn arriving during this one is ordinary.
  private _prune(): void {
    const turn = this._match.currentTurn();
    for (const store of [this._commitments, this._reveals]) {
      for (const k of Array.from(store.keys())) {
        if (parseInt(k, 10) < turn) store.delete(k);
      }
    }
    if (this._mine && this._mine.turn < turn) this._mine = null;
  }

  private _committed(): boolean {
    return !!this._me && this._match.pendingColors().indexOf(this._me) < 0;
  }

  // Every case the engine would refuse is decided here instead, on turn and hash.
  // Parsing submit's error text would couple the transport to wording meant for
  // a player to read.
  private _flush(): void {
    const keep: string[] = [];
    if (this._match.currentTurn() >= this._match.config().cap) { this._buffer = []; this._prune(); return; }
    for (const text of this._buffer) {
      const d = Wire.decodeAction(text), turn = this._match.currentTurn();
      if (!d.ok) continue;
      if (d.value.turn > turn) { keep.push(text); continue; }   // ahead of us, hold it
      if (d.value.turn < turn) continue;                        // behind us, already applied
      if (this._match.pendingColors().indexOf(d.value.color) < 0) continue;
      if (d.value.hash !== this._match.stateHash()) {
        // The two matches are already broken and the only cure is a fresh
        // export/import, so this latches rather than flashes.
        this._error = 'turn ' + d.value.turn + ' arrived on state ' + d.value.hash +
          ', but this match is on ' + this._match.stateHash() +
          ', your timelines have diverged. Export and re-import to get back in step.';
        continue;
      }
      const r = this._match.submit(d.value);
      if (!r.ok) this._error = r.error;   // nothing legitimate is left to fail on
    }
    this._buffer = keep;
    this._prune();
  }

  // Async, because sealing an action means hashing it. The local submit still
  // happens first and synchronously, so the screen has something to draw while
  // the opponent is still deciding, and myAction keeps working.
  async commit(action: string): Promise<{ ok: boolean; error: string | null }> {
    if (!this._me) return { ok: false, error: 'pick a colour first' };
    const turn = this._match.currentTurn(), color = this._me;
    const r = this._match.submit({
      turn: turn, color: color, action: action, hash: this._match.stateHash()
    });
    if (!r.ok) return { ok: false, error: r.error };
    // The engine's own string, so a name still rides along on turn 0. An export is
    // never broadcast. It serialises partial turns and would leak the current one.
    const out = this._match.view(color).myAction;
    if (out === null) throw new Error('submitted action did not land in the log');
    const nonce = nonce128();
    const digest = await digest128(turn, color, action, nonce);
    this._mine = { turn: turn, action: out, nonce: nonce, digest: digest, revealed: false };
    this._addCommitment(turn, color, digest);
    this._ch.send(this._commitString(this._mine));
    this._maybeReveal();
    this._flush();
    this._changed();
    return { ok: true, error: null };
  }

  // Nobody asks for a reveal and nobody acks one. The last commitment landing is
  // the signal. Every client sees it, so everything opens at once.
  private _maybeReveal(): void {
    const m = this._mine;
    if (!m || m.revealed || m.turn !== this._match.currentTurn()) return;
    if (!this._match.config().roster.every((c) => this._hasCommitment(m.turn, c))) return;
    m.revealed = true;
    this._ch.send(this._revealString(m));
  }

  withdraw(): { ok: boolean; error: string | null } {
    if (!this._me) return { ok: false, error: 'pick a colour first' };
    const m = this._mine;
    if (m && m.revealed && m.turn === this._match.currentTurn()) {
      return { ok: false, error: 'your action is already open, everyone has it' };
    }
    const r = this._match.withdraw(this._me);
    if (!r.ok) return { ok: false, error: r.error };
    // Dropping the digest only tidies our own books. The opponent cannot unsee a
    // commitment, and does not need to. It discloses nothing, and the replacement
    // we publish next is the one we will open.
    if (m) {
      const k = ckey(m.turn, this._me);
      this._commitments.set(k, (this._commitments.get(k) ?? []).filter((d) => d !== m.digest));
      this._mine = null;
    }
    this._changed();
    return { ok: true, error: null };
  }

  // Seatless, this renders the first colour in the roster so the picker has
  // something to read. Do not put that on screen as a board. Check color() first.
  view(): SessionView {
    const roster = this._match.config().roster;
    const color = this._me ?? roster[0];
    if (!color) throw new Error('match has no roster');
    const v = this._match.view(color);
    const peers = this._status.peers.slice();
    // Live means a turn can actually resolve. Nothing opens until every roster
    // colour has committed, so a room short of players is still connecting no
    // matter what the channel thinks of its own sockets.
    const peersNeeded = Math.max(0, roster.length - 1 - peers.length);
    const status = this._status.state === 'live' && peersNeeded ? 'connecting' : this._status.state;
    return {
      ...v,
      peers: peers,
      detail: this._status.detail,
      peersNeeded: peersNeeded,
      status: status,
      // A commitment counts as in, one phase earlier than a submission does. That is
      // the moment you lose the right to change your action, so it is the moment the
      // strip has to stop saying you are owed something.
      waiting: v.pending.filter((c) => c !== color && !this._hasCommitment(v.turn, c)),
      canChange: !!(this._mine && !this._mine.revealed && this._mine.turn === v.turn),
      error: this._error,
      notice: this._notice
    };
  }

  export(): string { return this._match.export(); }

  close(): void {
    this._ch.onMessage = null;
    this._ch.close();
  }
}

export { Session, Code, trimUnresolved, PeerChannel, LoopbackChannel };
