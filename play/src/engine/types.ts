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
export type EventKind = 'moved' | 'held' | 'inverted' | 'blocked' | 'stuck' | 'grab' | 'lost';
export type Vec = [number, number];
export type ModeId = 'sandbox' | 'bootstrap';

export type Failure = { ok: false; value?: undefined; error: string };
export type Result<T> = { ok: true; value: T; error?: undefined } | Failure;
export type Ack = { ok: true; error?: undefined } | Failure;

export const ORDER: Color[] = ['C', 'P', 'T', 'A'];
export const COLORS: Record<Color, { name: string; hex: string; ink: string }> = {
  C: { name: 'Coral',  hex: '#D85A30', ink: '#FBEDE7' },
  P: { name: 'Purple', hex: '#7F77DD', ink: '#EDECFB' },
  T: { name: 'Teal',   hex: '#2E9E8F', ink: '#E7F5F2' },
  A: { name: 'Amber',  hex: '#C98F12', ink: '#FBF2DF' }
};
export const DIRS: Record<Move, Vec> = { W: [0, -1], A: [-1, 0], S: [0, 1], D: [1, 0] };
export const MOVES: Move[] = ['W', 'A', 'S', 'D'];
export const ACTIONS: Action[] = ['W', 'A', 'S', 'D', 'H', 'I'];
export const MODE_IDS: ModeId[] = ['sandbox', 'bootstrap'];

export function isColor(c: unknown): c is Color {
  return typeof c === 'string' && (ORDER as string[]).includes(c);
}
export function isAction(a: unknown): a is Action {
  return typeof a === 'string' && (ACTIONS as string[]).includes(a);
}
export function isModeId(m: unknown): m is ModeId {
  return typeof m === 'string' && (MODE_IDS as string[]).includes(m);
}

const NAME_RE = /^[A-Za-z0-9_-]{1,12}$/;
export function validName(s: unknown): s is string {
  return typeof s === 'string' && NAME_RE.test(s);
}

export type Config = {
  mode: ModeId; w: number; h: number; wallPct: number; seed: string; cap: number; roster: Color[];
};
// Unvalidated configuration from forms, codes, and exports.
export type ConfigInput = {
  mode: string; w: number; h: number; wallPct: number; seed: string; cap: number;
  roster: readonly string[];
};
export type LogEntry = { turn: MetaTurn; color: Color; action: Action };

export type Player = {
  color: Color; dir: Dir; t: WorldTurn; p: PersonalIndex;
  x: number; y: number; horizon: WorldTurn; stuck: boolean;
};
export type Players = Partial<Record<Color, Player>>;

export type Body = {
  color: Color; p: PersonalIndex; t: WorldTurn; x: number; y: number; dir: Dir;
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
export type Outcome =
  | { status: 'running' }
  | { status: 'won'; color: Color }
  | { status: 'draw' };

export type ModeView = {
  keys: { color: Color; p: PersonalIndex; side: Vec }[];
  keyAtCenter: WorldTurn[];
  fronts: { color: Color; t: WorldTurn; x: number; y: number; target: Color | null; gap: number }[];
};

export type View = ModeView & {
  mode: ModeId;
  w: number; h: number; cap: number; seed: string;
  turn: MetaTurn; outcome: Outcome; hash: string;
  roster: Color[]; priority: Color[]; pending: Color[];
  walls: Vec[];
  spawns: Partial<Record<Color, Vec>>;
  center: Vec;
  me: {
    color: Color; p: PersonalIndex; t: WorldTurn; x: number; y: number;
    dir: Dir; horizon: WorldTurn; stuck: boolean;
  };
  bodies: ViewBody[];
  events: TurnEvent[];
  actions: ActionOffer[];
};

// What the core hands a mode after movement resolves.
export type TurnContext = {
  cfg: Config;
  turn: MetaTurn;
  prio: readonly Color[];
  players: Players;
  bodies: readonly Body[];
  bodiesAt(t: WorldTurn, x: number, y: number): readonly Body[];
  actors: readonly Body[];
  spawns: Partial<Record<Color, Vec>>;
  center: Vec;
  events: TurnEvent[];
};

export type Mode<S> = {
  id: ModeId;
  init(cfg: Config): S;
  afterTurn(s: S, turn: TurnContext): void;
  outcome(s: S, turn: TurnContext): Outcome;
  digest(s: S): string;
  view(s: S, turn: TurnContext, horizon: WorldTurn): ModeView;
};

export type DecodedAction = {
  turn: MetaTurn; color: Color; action: Action; hash: string; name: string | null;
};
export type DecodedExport = {
  config: Config; log: LogEntry[]; names: Partial<Record<Color, string>>;
};
