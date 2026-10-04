import { Match, Wire, ORDER, isColor, isAction, validName } from './engine/index.js';
import type { Action, Color, View } from './engine/index.js';
import { Code, trimUnresolved } from './transport.js';
import type { Channel, ChannelStatus } from './transport.js';

type Names = Partial<Record<Color, string>>;
type Result = { ok: boolean; error: string | null };
type Reservation = { owner: string; name: string; token: string; ready: boolean; seq: number };
type Seats = Partial<Record<Color, Reservation>>;
type Snapshot = { turn: number; digest: string };
type Hello = Snapshot & {
  seq: number; host: string | null; established: boolean; reserved: boolean; group: string[];
  entry: 'create' | 'join' | 'resume'; connected: string[]; epoch: number;
};
type Lobby = Snapshot & { host: string; epoch: number; seats: Seats; started: boolean };
type Proposal = Lobby & { id: string; names: Names; frozenDigest: string };
type Request = { host: string; seq: number; name?: string; color?: Color };
type Consent = { host: string; seq: number; token: string; name: string; ready: boolean };
type TurnTag = { id: string; turn: number; baseline: string; color: Color; revision: number };
type Commitment = TurnTag & { digest: string | null };
type Reveal = TurnTag & { action: Action; nonce: string };
type Message =
  | { type: 'hello'; value: Hello }
  | { type: 'lobby'; value: Lobby }
  | { type: 'request'; value: Request }
  | { type: 'consent'; value: Consent }
  | { type: 'proposal' | 'activate'; value: Proposal }
  | { type: 'ack'; value: { id: string; digest: string } }
  | { type: 'commit'; value: Commitment }
  | { type: 'reveal'; value: Reveal }
  | { type: 'checkpoint'; value: Snapshot & { id: string } };

type Envelope = Message & { v: 2; room: string };
const yes: Result = { ok: true, error: null };
const no = (error: string): Result => ({ ok: false, error });
const same = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);
function nonce(): string { return Array.from(crypto.getRandomValues(new Uint8Array(16)), (b) => b.toString(16).padStart(2, '0')).join(''); }
async function hash(text: string): Promise<string> {
  return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text))),
    (b) => b.toString(16).padStart(2, '0')).join('');
}
function copySeats(seats: Seats): Seats {
  const out: Seats = {};
  for (const c of ORDER) if (seats[c]) out[c] = { ...seats[c] };
  return out;
}
function owners(seats: Seats): string[] { return ORDER.flatMap((c) => seats[c] ? [seats[c]!.owner] : []).sort(); }
function imported(text: string): Match {
  const r = Match.fromExport(text);
  if (!r.ok) throw new Error(r.error);
  return r.value.match;
}
function preimage(value: Reveal): string {
  return JSON.stringify([value.id, value.turn, value.baseline, value.color, value.revision, value.action, value.nonce]);
}

// Validate transport data before letting it reach the state machine.
function decode(text: string, room: string): Envelope | null {
  if (text.length > 24000) return null;
  let raw: unknown;
  try { raw = JSON.parse(text); } catch { return null; }
  const obj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
  const str = (v: unknown): v is string => typeof v === 'string' && v.length > 0 && v.length <= 160;
  const num = (v: unknown): v is number => Number.isSafeInteger(v) && (v as number) >= 0;
  const digest = (v: unknown): boolean => typeof v === 'string' && /^[a-f0-9]{64}$/.test(v);
  const ids = (v: unknown): boolean => Array.isArray(v) && v.length <= 128 && v.every(str) && new Set(v).size === v.length;
  const snap = (v: Record<string, unknown>): boolean => num(v.turn) && digest(v.digest);
  const seats = (v: unknown): boolean => obj(v) && Object.entries(v).every(([c, s]) => isColor(c) && obj(s) &&
    str(s.owner) && validName(s.name) && str(s.token) && typeof s.ready === 'boolean' && num(s.seq));
  const lobby = (v: Record<string, unknown>): boolean => snap(v) && str(v.host) && num(v.epoch) && seats(v.seats) && typeof v.started === 'boolean';
  if (!obj(raw) || raw.v !== 2 || raw.room !== room || !obj(raw.value)) return null;
  const v = raw.value;
  let valid = false;
  switch (raw.type) {
    case 'hello': valid = snap(v) && num(v.seq) && (v.host === null || str(v.host)) && typeof v.established === 'boolean' && typeof v.reserved === 'boolean' &&
      ids(v.group) && ids(v.connected) && ['create', 'join', 'resume'].includes(String(v.entry)) && num(v.epoch); break;
    case 'lobby': valid = lobby(v); break;
    case 'proposal': case 'activate': valid = lobby(v) && str(v.id) && digest(v.frozenDigest) && obj(v.names) &&
      Object.entries(v.names).every(([c, name]) => isColor(c) && validName(name)); break;
    case 'request': valid = str(v.host) && num(v.seq) && (validName(v.name) || isColor(v.color)); break;
    case 'consent': valid = str(v.host) && num(v.seq) && str(v.token) && validName(v.name) && typeof v.ready === 'boolean'; break;
    case 'ack': valid = str(v.id) && digest(v.digest); break;
    case 'commit': case 'reveal': {
      valid = str(v.id) && num(v.turn) && digest(v.baseline) && isColor(v.color) && num(v.revision);
      valid &&= raw.type === 'commit' ? (v.digest === null || digest(v.digest)) :
        isAction(v.action) && typeof v.nonce === 'string' && /^[a-f0-9]{32}$/.test(v.nonce);
      break;
    }
    case 'checkpoint': valid = snap(v) && str(v.id); break;
  }
  return valid ? raw as Envelope : null;
}

export type SessionOptions = {
  match: Match; channel: Channel; entry: 'create' | 'join' | 'resume';
  names?: Readonly<Names> | null; onChange?: (session: Session) => void;
};
export type SeatView = {
  color: Color; name: string | null; ownerId: string | null; present: boolean; ready: boolean;
  isLocal: boolean; isHost: boolean; canClaim: boolean;
};
export type SessionView = View & {
  started: boolean; names: Names; seats: SeatView[]; peers: string[]; detail: string | null; peersNeeded: number;
  status: ChannelStatus['state']; uncommitted: Color[]; canChange: boolean;
  error: string | null; notice: string | null;
  phase: 'connecting' | 'lobby' | 'electing' | 'agreeing' | 'playing' | 'paused' | 'full' | 'mismatch' | 'ended';
  hostId: string | null; localId: string | null; localColor: Color | null; canReady: boolean; canEditName: boolean; canCommit: boolean;
  pauseReason: 'connection' | 'election' | 'seats' | 'agreement' | 'checkpoint' | 'snapshot' | null;
};

export class Session {
  private match: Match;
  private names: Names;
  private readonly ch: Channel;
  private readonly entry: 'create' | 'join' | 'resume';
  private readonly room: string;
  private readonly onChange: (session: Session) => void;
  private status: ChannelStatus = { state: 'connecting', peers: [], detail: null };
  private closed = false;
  private serial = Promise.resolve();
  private generation = 0;
  private baseline = '';
  private host: string | null = null;
  private established = false;
  private started: boolean;
  private group: string[] = [];
  private adverts = new Map<string, Hello>();
  private helloSeq = 0;
  private epoch = 0;
  private seenEpoch = 0;
  private seats: Seats = {};
  private proposal: Proposal | null = null;
  private proposing = false;
  private offered: { proposal: Proposal; sender: string; activate: boolean } | null = null;
  private conflicts = new Set<string>();
  private acknowledgments = new Set<string>();
  private active: Proposal | null = null;
  private error: string | null = null;
  private notice: string | null = null;
  private localSeq = 0;
  private resumeChoice: { color: Color; name: string | undefined; digest: string; ready: boolean } | null = null;
  private processed = new Map<string, number>();
  private intent: { type: 'request'; value: Omit<Request, 'host'> } | { type: 'consent'; value: Omit<Consent, 'host'> } | null = null;
  private commitments = new Map<Color, Commitment>();
  private reveals = new Map<Color, Reveal>();
  private heldReveals = new Map<Color, Reveal>();
  private mine: Reveal | null = null;
  private revealed = false;
  private committing = false;
  private revision = 0;
  private operation = 0;
  private checkpoint = new Map<string, Snapshot>();
  private early: Array<{ message: Message; sender: string }> = [];

  constructor(o: SessionOptions) {
    this.ch = o.channel;
    this.entry = o.entry;
    this.started = this.entry === 'resume';
    const text = trimUnresolved(o.match.export(o.names));
    this.match = imported(text);
    const decoded = Wire.decodeExport(text);
    this.names = decoded.ok ? decoded.value.names : {};
    this.room = Code.roomId(Wire.encodeMatchCode(this.match.config()));
    this.onChange = o.onChange ?? (() => {});
    this.ch.onMessage = (text, sender) => {
      const message = decode(text, this.room);
      if (message) this.enqueue(async () => { await this.receive(message, sender); });
    };
    this.ch.onStatus = (status) => this.statusChanged(status);
    this.enqueue(async () => {
      this.baseline = await hash(this.export());
      if (this.closed) return;
      if (this.resumeChoice && !this.resumeChoice.digest) this.resumeChoice.digest = this.baseline;
      this.elect(); this.announce(); this.sendIntent(); this.changed();
    });
  }
  static open(o: SessionOptions): Session { return new Session(o); }
  private enqueue(fn: () => Promise<void>): void {
    this.serial = this.serial.then(async () => { if (!this.closed) await fn(); }).catch((e: unknown) => {
      if (!this.closed) { this.error = String(e instanceof Error ? e.message : e); this.invalidate(); this.changed(); }
    });
  }
  private changed(): void { if (!this.closed) this.onChange(this); }
  private connected(id: string | null): boolean { return !!id && (id === this.ch.id || this.status.peers.includes(id)); }
  private connectedIds(): string[] { return [...new Set([...(this.ch.id ? [this.ch.id] : []), ...this.status.peers])].sort(); }
  private send(message: Message): void {
    if (!this.closed && this.ch.id && this.baseline) this.ch.send(JSON.stringify({ v: 2, room: this.room, ...message }));
  }
  private snapshot(): Snapshot { return { turn: this.match.currentTurn(), digest: this.baseline }; }
  private hello(): Hello {
    return { ...this.snapshot(), seq: ++this.helloSeq, host: this.host, established: this.established,
      reserved: owners(this.seats).length > 0, group: this.group, entry: this.entry, connected: this.connectedIds(), epoch: this.epoch };
  }
  private announce(): void {
    if (!this.ch.id || !this.baseline || this.closed) return;
    this.send({ type: 'hello', value: this.hello() });
    if (this.host === this.ch.id) this.send({ type: 'lobby', value: this.lobby() });
  }
  private lobby(): Lobby { return { ...this.snapshot(), host: this.host!, epoch: this.epoch, seats: copySeats(this.seats), started: this.started }; }
  private statusChanged(status: ChannelStatus): void {
    if (this.closed) return;
    const before = this.status.peers;
    this.status = { ...status, peers: [...status.peers] };
    const lost = before.filter((id) => !status.peers.includes(id));
    for (const id of lost) this.adverts.delete(id);
    const affected = lost.some((id) => id === this.host || owners(this.seats).includes(id));
    if (affected || status.state === 'offline' || status.state === 'failed') this.invalidate();
    this.elect();
    if (this.host === this.ch.id && affected) {
      for (const c of ORDER) if (this.seats[c] && !this.connected(this.seats[c]!.owner)) delete this.seats[c];
      this.bumpLobby();
    }
    this.announce(); this.sendIntent(); this.changed();
  }
  private elect(): void {
    if (!this.ch.id || !this.baseline || this.error) return;
    const establishedHosts = new Set<string>();
    if (this.established && this.connected(this.host)) establishedHosts.add(this.host!);
    for (const a of this.adverts.values()) if (a.established && this.connected(a.host)) establishedHosts.add(a.host!);
    const reservedHosts = new Set<string>();
    if (owners(this.seats).length && this.connected(this.host)) reservedHosts.add(this.host!);
    for (const h of this.adverts.values()) if (h.reserved && this.connected(h.host)) reservedHosts.add(h.host!);
    let next: string | null = null;
    if (establishedHosts.size > 1) {
      const admitted = new Set(this.group.filter((id) => this.connected(id)));
      for (const a of this.adverts.values()) if (a.established) for (const id of a.group) if (this.connected(id)) admitted.add(id);
      for (const id of establishedHosts) admitted.add(id);
      next = [...admitted].sort()[0] ?? null;
    } else if (establishedHosts.size === 1) next = [...establishedHosts][0]!;
    else if (reservedHosts.size) next = [...reservedHosts].sort()[0]!;
    else if (this.connected(this.host)) next = this.host;
    else {
      const survivors = owners(this.seats).filter((id) => this.connected(id));
      if (survivors.length) next = survivors[0]!;
    }
    if (!next) {
      const candidates = [[this.ch.id, this.entry], ...[...this.adverts].map(([id, a]) => [id, a.entry])] as Array<[string, string]>;
      const creators = candidates.filter(([, entry]) => entry === 'create').map(([id]) => id).sort();
      const resumes = candidates.filter(([, entry]) => entry === 'resume').map(([id]) => id).sort();
      next = creators[0] ?? resumes[0] ?? null;
    }
    // Provisional founders converge; a fresh visitor never preempts established hosting.
    if (!this.established && establishedHosts.size === 0 && reservedHosts.size === 0) {
      const creators = [...this.adverts].filter(([, a]) => a.entry === 'create').map(([id]) => id);
      if (this.entry === 'create') creators.push(this.ch.id);
      const founders = [...this.adverts].filter(([, a]) => a.entry === 'resume').map(([id]) => id);
      if (this.entry === 'resume') founders.push(this.ch.id);
      next = creators.sort()[0] ?? founders.sort()[0] ?? next;
    }
    if (next === this.host) return;
    this.invalidate(); this.host = next; this.epoch = next === this.ch.id ? ++this.seenEpoch : 0;
    this.processed.clear();
    if (next === this.ch.id) {
      for (const c of ORDER) if (this.seats[c] && !this.connected(this.seats[c]!.owner)) delete this.seats[c];
    }
    this.announce(); this.sendIntent();
  }
  private invalidate(): void {
    this.generation++; this.operation++; this.active = null; this.proposal = null; this.proposing = false;
    this.acknowledgments.clear(); this.offered = null; this.early = []; this.resetTurn();
  }
  private resetTurn(): void {
    this.commitments.clear(); this.reveals.clear(); this.heldReveals.clear(); this.checkpoint.clear();
    this.mine = null; this.revealed = false; this.committing = false; this.revision = 0;
  }
  private mismatch(): void {
    this.error = 'Snapshots differ. Open the same shared resume link to continue.';
    this.invalidate(); this.changed();
  }
  private bumpLobby(): void {
    this.invalidate(); this.epoch = ++this.seenEpoch;
    this.announce(); this.enqueue(async () => { await this.maybePropose(); }); this.changed();
  }
  private sendIntent(): void {
    if (!this.host || !this.intent || !this.baseline || this.closed || this.error) return;
    const message = { ...this.intent, value: { ...this.intent.value, host: this.host } } as Message;
    if (this.host === this.ch.id) this.enqueue(async () => { await this.receive(message, this.ch.id!); });
    else this.send(message);
  }
  join(name: string): Result {
    if (this.closed || this.started || this.entry === 'resume') return no('Use an available historical seat.');
    if (this.proposal) return no('Wait for the game to start.');
    if (!validName(name)) return no('invalid name');
    if (this.error) return no(this.error);
    this.intent = { type: 'request', value: { seq: ++this.localSeq, name } };
    this.invalidate(); this.sendIntent(); this.changed(); return yes;
  }
  requestSeat(color: string): Result {
    if (!isColor(color) || !this.match.config().roster.includes(color)) return no('colour is not in this match');
    if (!this.started && this.entry !== 'resume') return no('Fresh games assign colours automatically.');
    if (this.closed || this.error) return no(this.error ?? 'Session closed.');
    if (this.seats[color] && this.connected(this.seats[color]!.owner)) return no('That seat is occupied.');
    if (this.color()) return no('You already have a seat.');
    this.resumeChoice = { color, name: this.names[color], digest: this.baseline, ready: false };
    this.intent = { type: 'request', value: { seq: ++this.localSeq, color } };
    this.sendIntent(); return yes;
  }
  ready(value = true): Result {
    const c = this.color(), seat = c ? this.seats[c] : null;
    if (!seat || this.closed || this.error || this.active || this.proposal || (seat.seq < this.localSeq && this.intent?.type !== 'consent')) return no('Wait for your confirmed lobby seat.');
    if (this.resumeChoice) this.resumeChoice.ready = value;
    this.intent = { type: 'consent', value: { seq: ++this.localSeq, token: seat.token, name: seat.name, ready: value } };
    this.invalidate(); this.sendIntent(); this.changed(); return yes;
  }
  color(): Color | null { return ORDER.find((c) => this.seats[c]?.owner === this.ch.id) ?? null; }
  private acceptedIntent(): void {
    const c = this.color();
    if (c && this.intent && this.seats[c]!.seq >= this.intent.value.seq) this.intent = null;
  }
  private restoreResumeChoice(): void {
    const choice = this.resumeChoice;
    if (!choice || this.active || this.error) return;
    const seat = this.seats[choice.color];
    if (choice.digest !== this.baseline || choice.name !== this.names[choice.color] || (seat && seat.owner !== this.ch.id)) {
      this.resumeChoice = null; this.intent = null; return;
    }
    if (!seat) {
      if (this.intent?.type !== 'request' || this.intent.value.color !== choice.color) {
        this.intent = { type: 'request', value: { seq: ++this.localSeq, color: choice.color } };
      }
    } else if (!this.intent && choice.ready && !seat.ready && seat.name === choice.name) {
      this.ready();
    }
  }
  private handleRequest(r: Request | Consent, sender: string): void {
    if (this.host !== this.ch.id || r.host !== this.host || this.error || !this.connected(sender)) return;
    const advertised = sender === this.ch.id ? this.snapshot() : this.adverts.get(sender);
    if (!advertised || advertised.turn !== this.match.currentTurn() || advertised.digest !== this.baseline) { this.announce(); return; }
    if ((this.processed.get(sender) ?? -1) >= r.seq) return;
    this.processed.set(sender, r.seq);
    const own = ORDER.find((c) => this.seats[c]?.owner === sender);
    if ('ready' in r) {
      const seat = own ? this.seats[own] : null;
      if (!seat || seat.token !== r.token || seat.name !== r.name || this.active) return;
      seat.ready = r.ready; seat.seq = r.seq;
    } else if (own) {
      if (this.started || !r.name || this.active) return;
      const seat = this.seats[own]!;
      if (seat.name !== r.name) { seat.name = r.name; seat.ready = false; seat.token = nonce(); }
      seat.seq = r.seq;
    } else {
      let color: Color | undefined;
      if (this.started) color = r.color;
      else if (sender === this.host && this.entry === 'create' && !this.seats.C) color = 'C';
      else color = ORDER.find((c) => this.match.config().roster.includes(c) && !this.seats[c] && !(c === 'C' && this.entry === 'create' && sender !== this.host));
      if (!color || !this.match.config().roster.includes(color) || this.seats[color]) { this.announce(); return; }
      const name = this.started ? this.names[color] : r.name;
      if (!validName(name)) return;
      this.seats[color] = { owner: sender, name, token: nonce(), ready: false, seq: r.seq };
    }
    this.acceptedIntent(); this.bumpLobby();
  }
  private validSeats(seats: Seats): boolean {
    return Object.keys(seats).every((c) => isColor(c) && this.match.config().roster.includes(c)) &&
      new Set(owners(seats)).size === owners(seats).length;
  }
  private async receive(message: Message, sender: string): Promise<void> {
    if (this.closed || this.error || !this.connected(sender) || !this.baseline) return;
    switch (message.type) {
      case 'hello': {
        const h = message.value, prev = this.adverts.get(sender);
        if (prev && h.seq <= prev.seq) return;
        this.adverts.set(sender, h); this.seenEpoch = Math.max(this.seenEpoch, h.epoch);
        const member = owners(this.seats).includes(sender);
        const competing = h.established && this.established && h.host !== this.host && !same(h.group, this.group);
        const freezing = this.proposal && h.turn === this.proposal.turn && h.digest === this.proposal.frozenDigest;
        if (!freezing && (competing || (member && !this.active && h.host === this.host && h.epoch >= this.epoch)) && (h.turn !== this.match.currentTurn() || h.digest !== this.baseline)) {
          this.mismatch(); return;
        }
        const conflictKey = JSON.stringify([h.host, h.group]);
        if (competing && !this.conflicts.has(conflictKey)) {
          this.conflicts.add(conflictKey); this.invalidate();
          if (this.host === this.ch.id) this.epoch = ++this.seenEpoch;
        }
        const beforeHost = this.host;
        this.elect();
        if (!prev || beforeHost !== this.host) { this.announce(); this.sendIntent(); }
        if (this.host === this.ch.id) { this.send({ type: 'lobby', value: this.lobby() }); await this.maybePropose(); }
        break;
      }
      case 'request': case 'consent': this.handleRequest(message.value, sender); break;
      case 'lobby': {
        const l = message.value;
        if (sender !== this.host || l.host !== sender || l.epoch < this.epoch || !this.validSeats(l.seats)) return;
        if (this.active && l.epoch === this.epoch) return;
        if (l.turn !== this.match.currentTurn() || l.digest !== this.baseline) {
          if (this.proposal && l.epoch === this.proposal.epoch && l.digest === this.proposal.frozenDigest && l.turn === this.proposal.turn) return;
          if (!this.active) { this.epoch = l.epoch; this.mismatch(); this.announce(); }
          return;
        }
        const changed = l.epoch > this.epoch || !same(l.seats, this.seats);
        if (changed) {
          const offered = this.offered; this.invalidate();
          if (offered && offered.proposal.epoch >= l.epoch && offered.sender === this.host) this.offered = offered;
        }
        this.epoch = l.epoch; this.seenEpoch = Math.max(this.seenEpoch, l.epoch);
        this.seats = copySeats(l.seats); this.started = l.started;
        if (this.established) this.group = owners(l.seats);
        this.acceptedIntent(); this.restoreResumeChoice();
        if (changed) this.announce();
        this.sendIntent();
        break;
      }
      case 'proposal':
        this.holdProposal(message.value, sender, false); break;
      case 'ack': {
        const p = this.proposal;
        if (this.host !== this.ch.id || !p || message.value.id !== p.id || message.value.digest !== p.frozenDigest || !owners(p.seats).includes(sender)) return;
        this.acknowledgments.add(sender); await this.maybeActivate(); break;
      }
      case 'activate': this.holdProposal(message.value, sender, true); break;
      case 'commit': case 'reveal': case 'checkpoint': await this.turnMessage(message, sender); break;
    }
    await this.processOffer(); this.changed();
  }
  private holdProposal(p: Proposal, sender: string, activate: boolean): void {
    if (this.active?.id === p.id || sender !== this.host || p.host !== sender || p.epoch < this.epoch || !this.validSeats(p.seats)) return;
    if (this.offered && this.offered.proposal.epoch > p.epoch) return;
    this.offered = { proposal: p, sender, activate: activate || (this.offered?.proposal.id === p.id && this.offered.activate) };
  }
  private async processOffer(): Promise<void> {
    const offered = this.offered;
    if (!offered) return;
    const { proposal: p, sender } = offered;
    if (this.proposal?.id !== p.id) await this.acceptProposal(p, sender);
    if (this.offered === offered && offered.activate && this.proposal?.id === p.id && same(this.proposal, p) && sender === this.host) await this.activate(p);
  }
  private localConsentMatches(p: Proposal): boolean {
    const c = ORDER.find((color) => p.seats[color]?.owner === this.ch.id);
    if (!c) return true;
    const local = this.seats[c], offered = p.seats[c]!;
    return !!local && local.owner === this.ch.id && local.token === offered.token && local.ready && offered.seq >= this.localSeq;
  }
  private membershipAgrees(seats: Seats): boolean {
    const required = [...new Set([...owners(seats), this.host!])].sort();
    return required.every((id) => this.connected(id) && (id === this.ch.id || (() => {
      const h = this.adverts.get(id);
      return !!h && h.host === this.host && h.epoch === this.epoch && required.every((peer) => h.connected.includes(peer));
    })()));
  }
  private async maybePropose(): Promise<void> {
    if (this.host !== this.ch.id || this.active || this.proposal || this.proposing || this.error || !this.baseline) return;
    if (!this.match.config().roster.every((c) => this.seats[c]?.ready) || !this.membershipAgrees(this.seats)) return;
    for (const owner of owners(this.seats)) {
      const h = owner === this.ch.id ? this.snapshot() : this.adverts.get(owner);
      if (!h || h.turn !== this.match.currentTurn() || h.digest !== this.baseline) { this.mismatch(); return; }
    }
    const names = { ...this.names };
    if (!this.started) for (const c of this.match.config().roster) names[c] = this.seats[c]!.name;
    const generation = this.generation; this.proposing = true;
    const frozenDigest = await hash(this.match.export(names));
    if (this.closed || generation !== this.generation) return;
    this.proposing = false;
    const p: Proposal = { ...this.lobby(), id: nonce(), names, frozenDigest };
    if (!this.localConsentMatches(p)) return;
    this.proposal = p; this.acknowledgments.clear();
    if (owners(p.seats).includes(this.ch.id!)) this.acknowledgments.add(this.ch.id!);
    this.send({ type: 'proposal', value: p }); await this.maybeActivate();
  }
  private async acceptProposal(p: Proposal, sender: string): Promise<void> {
    if (this.error || sender !== this.host || p.host !== sender || p.epoch < this.epoch || !this.validSeats(p.seats) ||
      !this.match.config().roster.every((c) => p.seats[c]?.ready) || !this.membershipAgrees(p.seats)) return;
    if (p.turn !== this.match.currentTurn() || p.digest !== this.baseline) { this.mismatch(); return; }
    const color = ORDER.find((c) => p.seats[c]?.owner === this.ch.id);
    if (color) {
      const local = this.seats[color], offered = p.seats[color]!;
      if (!local || local.owner !== this.ch.id || local.token !== offered.token || !local.ready || offered.seq < this.localSeq) return;
    }
    if (this.started && !same(p.names, this.names)) return;
    if (!this.started && !this.match.config().roster.every((c) => p.names[c] === p.seats[c]?.name)) return;
    const generation = this.generation, digest = await hash(this.match.export(p.names));
    if (this.closed || generation !== this.generation || sender !== this.host || p.epoch < this.epoch || !this.localConsentMatches(p)) return;
    if (digest !== p.frozenDigest) { this.mismatch(); return; }
    this.epoch = p.epoch; this.seenEpoch = Math.max(this.seenEpoch, p.epoch);
    this.seats = copySeats(p.seats); this.proposal = p;
    if (color) this.send({ type: 'ack', value: { id: p.id, digest } });
  }
  private async maybeActivate(): Promise<void> {
    const p = this.proposal;
    if (!p || !owners(p.seats).every((id) => this.acknowledgments.has(id))) return;
    this.send({ type: 'activate', value: p }); await this.activate(p);
  }
  private async activate(p: Proposal): Promise<void> {
    if (this.closed || this.error || this.proposal?.id !== p.id) return;
    const buffered = this.early;
    this.resumeChoice = null;
    this.resetTurn(); this.active = p; this.proposal = null; this.offered = null; this.early = [];
    this.names = { ...p.names }; this.baseline = p.frozenDigest; this.started = true;
    this.established = true; this.group = owners(p.seats); this.seats = copySeats(p.seats);
    for (const id of owners(p.seats)) this.checkpoint.set(id, this.snapshot());
    this.announce();
    for (const item of buffered) await this.turnMessage(item.message, item.sender);
    this.changed();
  }
  private checkpointAgrees(): boolean {
    return !!this.active && owners(this.active.seats).every((id) => {
      const s = this.checkpoint.get(id);
      return this.connected(id) && !!s && (s.turn === this.match.currentTurn() + 1 || (s.turn === this.match.currentTurn() && s.digest === this.baseline));
    });
  }
  private canCommit(): boolean {
    return !this.closed && !this.error && !!this.active && !!this.color() && this.checkpointAgrees() &&
      !this.mine && !this.committing && this.match.outcome().status === 'running';
  }
  async commit(action: string): Promise<Result> {
    if (!this.canCommit() || !isAction(action)) return no('Wait for all players and snapshot agreement.');
    const color = this.color()!, active = this.active!, generation = this.generation, op = ++this.operation;
    const reason = this.match.view(color).actions.find((offer) => offer.action === action)?.reason;
    if (reason) return no(reason);
    const value: Reveal = { id: active.id, turn: this.match.currentTurn(), baseline: this.baseline, color,
      revision: ++this.revision, action, nonce: nonce() };
    this.committing = true;
    const digest = await hash(preimage(value));
    if (this.closed || generation !== this.generation || op !== this.operation || this.active !== active) return no('The turn agreement changed.');
    this.committing = false; this.mine = value;
    // Only the hash belongs in a commitment; the action and nonce stay private.
    const sealed: Commitment = { id: value.id, turn: value.turn, baseline: value.baseline,
      color, revision: value.revision, digest };
    this.commitments.set(color, sealed); this.send({ type: 'commit', value: sealed });
    await this.maybeReveal(); this.changed(); return yes;
  }
  withdraw(): Result {
    if (this.closed || !this.active || this.revealed || (!this.mine && !this.committing)) return no('Your action cannot be changed now.');
    const color = this.color()!;
    this.operation++; this.committing = false; this.mine = null;
    const value: Commitment = { id: this.active.id, turn: this.match.currentTurn(), baseline: this.baseline,
      color, revision: ++this.revision, digest: null };
    this.commitments.set(color, value); this.send({ type: 'commit', value }); this.changed(); return yes;
  }
  private async maybeReveal(): Promise<void> {
    if (!this.mine || this.revealed || !this.active || !this.match.config().roster.every((c) => this.commitments.get(c)?.digest)) return;
    this.revealed = true; this.reveals.set(this.mine.color, this.mine);
    this.send({ type: 'reveal', value: this.mine }); await this.finishTurn();
  }
  private async turnMessage(message: Message, sender: string): Promise<void> {
    if (message.type !== 'commit' && message.type !== 'reveal' && message.type !== 'checkpoint') return;
    const v = message.value;
    if (this.error || this.closed) return;
    if (!this.active || v.id !== this.active.id) {
      const p = this.proposal;
      if (p?.id === v.id && owners(p.seats).includes(sender) && this.early.length < 64) this.early.push({ message, sender });
      return;
    }
    const active = this.active;
    if (message.type === 'checkpoint') {
      if (!owners(active.seats).includes(sender)) return;
      const s = message.value, previous = this.checkpoint.get(sender);
      if (s.turn < this.match.currentTurn() || s.turn > this.match.currentTurn() + 1 || (previous && s.turn < previous.turn)) return;
      this.checkpoint.set(sender, s);
      if (s.turn === this.match.currentTurn() && s.digest !== this.baseline) this.mismatch();
      else await this.drainEarly();
      return;
    }
    const value = message.value;
    if (active.seats[value.color]?.owner !== sender || value.turn !== this.match.currentTurn() || value.baseline !== this.baseline || !this.checkpointAgrees()) {
      // A next-turn commitment can precede the checkpoint that permits it locally.
      if (active.seats[value.color]?.owner === sender && (value.turn === this.match.currentTurn() + 1 || (value.turn === this.match.currentTurn() && value.baseline === this.baseline)) && this.early.length < 64) this.early.push({ message, sender });
      return;
    }
    if (message.type === 'commit') {
      const value = message.value, prev = this.commitments.get(value.color);
      if (prev && value.revision <= prev.revision) return;
      this.commitments.set(value.color, value);
      this.reveals.delete(value.color);
      const held = this.heldReveals.get(value.color);
      if (held?.revision === value.revision) await this.verifyReveal(held);
      await this.maybeReveal();
    } else {
      const value = message.value, prev = this.commitments.get(value.color);
      if (prev && value.revision < prev.revision) return;
      const held = this.heldReveals.get(value.color);
      if (!held || value.revision >= held.revision) this.heldReveals.set(value.color, value);
      await this.verifyReveal(value);
    }
  }
  private async drainEarly(): Promise<void> {
    if (!this.active || !this.checkpointAgrees() || this.error) return;
    const pending = this.early; this.early = [];
    for (const item of pending) await this.turnMessage(item.message, item.sender);
  }
  private async verifyReveal(value: Reveal): Promise<void> {
    const commitment = this.commitments.get(value.color);
    if (!commitment?.digest || commitment.revision !== value.revision) return;
    const generation = this.generation, active = this.active, digest = await hash(preimage(value));
    if (this.closed || generation !== this.generation || this.active !== active || this.commitments.get(value.color) !== commitment) return;
    if (digest !== commitment.digest) return;
    this.reveals.set(value.color, value); await this.finishTurn();
  }
  private async finishTurn(): Promise<void> {
    if (!this.active || !this.match.config().roster.every((c) => this.reveals.has(c))) return;
    const active = this.active, generation = this.generation, turn = this.match.currentTurn();
    const next = imported(this.export());
    for (const c of ORDER) if (next.config().roster.includes(c)) {
      const value = this.reveals.get(c)!;
      const r = next.submit({ turn, color: c, action: value.action, hash: this.match.stateHash() });
      if (!r.ok) { this.error = r.error; this.invalidate(); return; }
    }
    const digest = await hash(next.export(this.names));
    if (this.closed || generation !== this.generation || active !== this.active || this.match.currentTurn() !== turn) return;
    const reports = new Map(this.checkpoint);
    this.match = next; this.baseline = digest; this.operation++; this.resetTurn();
    this.checkpoint = reports; this.checkpoint.set(this.ch.id!, this.snapshot());
    for (const [id, s] of reports) if (owners(active.seats).includes(id) && s.turn === next.currentTurn() && s.digest !== digest) { this.mismatch(); return; }
    this.send({ type: 'checkpoint', value: { id: active.id, ...this.snapshot() } }); this.announce(); await this.drainEarly(); this.changed();
  }
  export(): string { return trimUnresolved(this.match.export(this.names)); }
  view(): SessionView {
    const color = this.color(), roster = this.match.config().roster;
    const v = this.match.view(color ?? roster[0]!);
    const seats = roster.map((c): SeatView => {
      const s = this.seats[c], local = !!s && s.owner === this.ch.id;
      return { color: c, name: s?.name ?? this.names[c] ?? null, ownerId: s?.owner ?? null,
        present: !!s && this.connected(s.owner), ready: !!s?.ready && (!local || s.seq >= this.localSeq),
        isLocal: local, isHost: !!s && s.owner === this.host, canClaim: this.started && !s && !color && !this.error };
    });
    const full = !color && roster.every((c) => !!this.seats[c]);
    const phase: SessionView['phase'] = this.error ? 'mismatch' : !this.ch.id || !this.baseline ? 'connecting' :
      !this.host ? 'electing' : full ? 'full' : this.active ?
        (v.outcome.status !== 'running' ? 'ended' : this.checkpointAgrees() ? 'playing' : 'paused') :
        this.proposal || this.proposing ? 'agreeing' : 'lobby';
    const names = { ...this.names };
    for (const seat of seats) if (seat.name) names[seat.color] = seat.name;
    const pending = roster.filter((c) => !this.commitments.get(c)?.digest);
    return { ...v, started: this.started, names, seats, pending, peers: [...this.status.peers], detail: this.status.detail,
      peersNeeded: seats.filter((s) => !s.present).length, status: this.status.state,
      uncommitted: v.outcome.status === 'running' ? pending : [],
      canChange: !this.closed && !!this.active && (!!this.mine || this.committing) && !this.revealed,
      error: this.error, notice: this.notice, phase, hostId: this.host, localId: this.ch.id, localColor: color,
      canEditName: !this.closed && !this.started && this.entry !== 'resume' && !this.error && !this.proposal,
      canReady: !this.closed && !!color && !this.active && !this.proposal && !this.error && this.seats[color]!.seq >= this.localSeq,
      canCommit: this.canCommit(), pauseReason: this.error ? 'snapshot' : !this.ch.id ? 'connection' : !this.host ? 'election' :
        this.active ? this.checkpointAgrees() ? null : 'checkpoint' : seats.some((s) => !s.present) ? 'seats' : 'agreement' };
  }
  close(): void {
    if (this.closed) return;
    this.closed = true; this.invalidate(); this.ch.onMessage = null; this.ch.onStatus = null; this.ch.close();
  }
}
