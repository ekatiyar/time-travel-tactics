import { Wire, COLORS, fnv1a, isAction, isColor, metaTurn, validName } from './engine.js';
import type { Action, Color, Config, DecodedAction, MetaTurn, Match, View } from './engine.js';

function hex8(n: number): string { return (n >>> 0).toString(16).padStart(8, '0'); }
function rid(): string {
  return hex8(fnv1a(Math.random() + '-' + Date.now())) + hex8(fnv1a(Math.random() + ''));
}

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
// Both sides must hash this exact preimage.
async function digest128(turn: number, color: string, action: string, nonce: string): Promise<string> {
  const pre = new TextEncoder().encode(turn + ':' + color + ':' + action + ':' + nonce);
  const buf = await crypto.subtle.digest('SHA-256', pre);
  return hexOf(new Uint8Array(buf, 0, 16));
}

const Code = {
  roomId: function (s: unknown): string {
    const str = String(s == null ? '' : s).trim();
    return 'tbtt-' + hex8(fnv1a(str)) + hex8(fnv1a('~' + str));
  }
};

// Partial turns lack commitments and cannot safely join a live room.
function trimUnresolved(str: string): string {
  const r = Wire.decodeExport(str);
  if (!r.ok) return str;
  const full = r.value.config.roster.length;
  const count = new Map<number, number>();
  for (const e of r.value.log) count.set(e.turn, (count.get(e.turn) ?? 0) + 1);
  let cut = 0;
  while (count.get(cut) === full) cut++;
  const log = r.value.log.filter((e) => e.turn < cut);
  return Wire.encodeExport(r.value.config, log, r.value.names);
}

export type ChannelState = 'offline' | 'connecting' | 'live' | 'failed';
export type ChannelStatus = { state: ChannelState; peers: string[]; detail: string | null };
export type Channel = {
  id: string;
  send: (text: string) => void;
  onMessage: ((text: string) => void) | null;
  onStatus: ((s: ChannelStatus) => void) | null;
  close: () => void;
};

// Subscribers need the current state, not just later changes.
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

export type RoomAction = {
  send: (data: string) => unknown;
  // Required by Trystero's invariant callback type.
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

const joinTrystero: RoomLoader = async (roomId) => {
  const m = await import('@trystero-p2p/nostr');
  // The room ID varies the relay subset while remaining shared by peers.
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
      if (room) { try { room.leave(); } catch {} }
      room = null; act = null;
      emit({ state: 'offline', peers: [], detail: null });
    }
  };
  const emit = statusPort(ch, { state: 'connecting', peers: [], detail: null });

  // Trystero callbacks may arrive after close().
  function report(): void {
    if (closed) return;
    emit({ state: peers.length ? 'live' : 'connecting', peers: peers.slice(), detail: null });
  }

  loadRoom(roomId).then(function (joined) {
    if (closed) return;
    room = joined;
    act = room.makeAction('m');
    act.onMessage = function (data) {
      if (ch.onMessage) ch.onMessage(String(data));
    };
    room.onPeerJoin = function (id) {
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

const CLAIM_RE = /^!([CPTA])~([A-Za-z0-9_-]{1,12})@([A-Za-z0-9_-]{1,80})$/;
const COMMIT_RE = /^#(\d{1,4})([CPTA]):([0-9a-f]{32})$/;
const REVEAL_RE = /^(.*)\|([0-9a-f]{32})$/;

function ckey(turn: MetaTurn, color: Color): string { return turn + color; }

export type Claim = { name: string; clientId: string };
type Mine = { turn: MetaTurn; action: string; nonce: string; digest: string; revealed: boolean };
type Held = { action: string; nonce: string; v: DecodedAction };

export type SessionOptions = {
  match: Match;
  channel: Channel;
  names?: Readonly<Partial<Record<Color, string>>> | null;
  onChange?: (s: Session) => void;
};

export type SessionView = View & {
  names: Partial<Record<Color, string>>;
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
  // Exported names record the first player for each color.
  private _logNames: Partial<Record<Color, string>>;
  private _me: Color | null;
  private _buffer: string[];
  private _commitments: Map<string, string[]>;
  private _reveals: Map<string, Held>;
  private _mine: Mine | null;
  private _peers: string[];
  private _status: ChannelStatus;
  private _error: string | null;
  private _notice: string | null;

  constructor(o: SessionOptions) {
    this._match = o.match;
    this._ch = o.channel;
    this._onChange = o.onChange ?? function () {};
    this._claims = {};
    this._logNames = {};
    for (const c of Object.keys(o.names ?? {})) {
      if (isColor(c)) this._recordName(c, (o.names ?? {})[c]);
    }
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

  // Keep names stable so clients label the log identically.
  private _recordName(color: Color, name: unknown): void {
    if (this._match.config().roster.indexOf(color) < 0 || !validName(name)) return;
    if (!(color in this._logNames)) this._logNames[color] = name;
  }

  private _statusChanged(s: ChannelStatus): void {
    const before = this._peers;
    this._status = copyStatus(s);
    this._peers = this._status.peers.slice();
    const fresh = this._peers.filter((p) => before.indexOf(p) < 0);
    if (fresh.length) this._announce();
    this._changed();
  }

  private _announce(): void {
    if (!this._me) return;
    if (this._claims[this._me]) this._ch.send(this._claimString(this._me));
    const m = this._mine;
    if (!m || m.turn !== this._match.currentTurn()) return;
    this._ch.send(this._commitString(m));
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

  // Remove local state so a lost seat cannot advance this client alone.
  private _dropSeat(color: Color): void {
    const m = this._mine, turn = this._match.currentTurn();
    this._match.withdraw(color);
    if (m && m.turn === turn) {
      const k = ckey(turn, color), set = this._commitments.get(k) ?? [];
      this._commitments.set(k, set.filter((d) => d !== m.digest));
    }
    this._mine = null;
  }

  // Client IDs deterministically resolve contested seats.
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
    this._recordName(color, name);
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
    if (!m) return;
    const [, turnText = '', color = '', digest = ''] = m;
    if (!isColor(color)) return;
    const turn = metaTurn(+turnText);
    if (color === this._me) return;
    if (this._match.config().roster.indexOf(color) < 0) return;
    if (turn < this._match.currentTurn() || turn >= this._match.config().cap) return;
    this._addCommitment(turn, color, digest);
    this._maybeReveal();
    this._reopen(turn, color).then(() => { this._changed(); });
    this._changed();
  }

  private _revealReceived(text: string): void {
    const m = REVEAL_RE.exec(text);
    if (!m) return;
    const [, action = '', nonce = ''] = m;
    const d = Wire.decodeAction(action);
    if (!d.ok) return;
    if (d.value.color === this._me) return;
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
    // Do not reveal an opponent's move before committing our own.
    if (this._committed()) this._flush();
    return true;
  }

  private _hold(rec: Held): void {
    this._reveals.set(ckey(rec.v.turn, rec.v.color), rec);
  }

  private async _reopen(turn: MetaTurn, color: Color): Promise<void> {
    const k = ckey(turn, color), rec = this._reveals.get(k);
    if (!rec) return;
    if (await this._open(rec)) this._reveals.delete(k);
  }

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

  private _flush(): void {
    const keep: string[] = [];
    if (this._match.currentTurn() >= this._match.config().cap) { this._buffer = []; this._prune(); return; }
    for (const text of this._buffer) {
      const d = Wire.decodeAction(text), turn = this._match.currentTurn();
      if (!d.ok) continue;
      if (d.value.turn > turn) { keep.push(text); continue; }
      if (d.value.turn < turn) continue;
      if (this._match.pendingColors().indexOf(d.value.color) < 0) continue;
      if (d.value.hash !== this._match.stateHash()) {
        this._error = 'Turn ' + d.value.turn + ' is for state ' + d.value.hash +
          '; this match is on ' + this._match.stateHash() + '. Export, then re-import.';
        continue;
      }
      const r = this._match.submit(d.value);
      if (!r.ok) { this._error = r.error; continue; }
      this._recordName(d.value.color, d.value.name);
    }
    this._buffer = keep;
    this._prune();
  }

  async commit(action: string): Promise<{ ok: boolean; error: string | null }> {
    if (!this._me) return { ok: false, error: 'pick a colour first' };
    const turn = this._match.currentTurn(), color = this._me, hash = this._match.stateHash();
    const r = this._match.submit({ turn: turn, color: color, action: action, hash: hash });
    if (!r.ok) return { ok: false, error: r.error };
    if (!isAction(action)) throw new Error('the match accepted ' + action);
    const out = Wire.encodeAction({
      turn: turn, color: color, action: action, hash: hash, name: this._logNames[color]
    });
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
    if (m) {
      const k = ckey(m.turn, this._me);
      this._commitments.set(k, (this._commitments.get(k) ?? []).filter((d) => d !== m.digest));
      this._mine = null;
    }
    this._changed();
    return { ok: true, error: null };
  }

  view(): SessionView {
    const roster = this._match.config().roster;
    const color = this._me ?? roster[0];
    if (!color) throw new Error('match has no roster');
    const v = this._match.view(color);
    const peers = this._status.peers.slice();
    const peersNeeded = Math.max(0, roster.length - 1 - peers.length);
    const status = this._status.state === 'live' && peersNeeded ? 'connecting' : this._status.state;
    const names: Partial<Record<Color, string>> = {};
    for (const c of roster) {
      const held = this._claims[c];
      const n = (held && held.name) || this._logNames[c];
      if (n) names[c] = n;
    }
    return {
      ...v,
      names: names,
      peers: peers,
      detail: this._status.detail,
      peersNeeded: peersNeeded,
      status: status,
      waiting: v.pending.filter((c) => c !== color && !this._hasCommitment(v.turn, c)),
      canChange: !!(this._mine && !this._mine.revealed && this._mine.turn === v.turn),
      error: this._error,
      notice: this._notice
    };
  }

  export(): string { return this._match.export(this._logNames); }

  close(): void {
    this._ch.onMessage = null;
    this._ch.close();
  }
}

export { Session, Code, trimUnresolved, PeerChannel, LoopbackChannel, joinTrystero };
