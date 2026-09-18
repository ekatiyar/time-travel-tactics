import { useCallback, useEffect, useRef, useState } from 'preact/hooks';
import { Fragment } from 'preact';
import type { JSX } from 'preact';

import { COLORS, Match, Wire } from './engine/index.js';
import type { Action, ActionOffer, Color, ConfigInput, TurnEvent, Vec, View, ViewBody } from './engine/index.js';
import { Code, PeerChannel, Session, trimUnresolved } from './transport.js';
import type { RoomLoader, SessionView } from './transport.js';

type Names = Partial<Record<Color, string>>;

function plural(n: number, word: string): string {
  return n + ' ' + word + (n === 1 ? '' : 's');
}
function nameOf(view: SessionView, color: Color): string {
  return view.names[color] || COLORS[color].name;
}
function push<K, V>(m: Map<K, V[]>, k: K, v: V): void {
  const list = m.get(k);
  if (list) list.push(v);
  else m.set(k, [v]);
}

type RelativeDirection = 'matching' | 'opposing';

function relativeDirection(view: SessionView, b: ViewBody): RelativeDirection {
  return b.dir === view.me.dir ? 'matching' : 'opposing';
}

// Spread trail opacity across visible turns, not raw distance.
function shade(bodies: readonly ViewBody[], focusT: number, lookBack: number): Map<number, number> {
  const floor = parseFloat(getComputedStyle(document.documentElement)
    .getPropertyValue('--dot-floor')) || 0.14;
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

function describe(view: SessionView, b: ViewBody): string {
  const relation = relativeDirection(view, b) === 'matching'
    ? 'same direction as you' : 'opposite direction from you';
  return nameOf(view, b.color) + ', index ' + b.p + ', world turn ' + b.t +
    ', walking ' + (b.dir === 1 ? 'forward' : 'backward') + ', ' + relation +
    (b.live ? ', current' : '');
}

function eventText(view: SessionView, e: TurnEvent): string {
  const at = '(' + e.x + ',' + e.y + ')';
  if (e.kind === 'moved') return 'moved to ' + at + ' at t' + e.t;
  if (e.kind === 'held') return 'held ' + at;
  if (e.kind === 'inverted') {
    return 'turned around at ' + at + ', now walking ' +
      (e.dir === 1 ? 'forward' : 'backward');
  }
  if (e.kind === 'blocked') {
    return 'was blocked by ' + (e.by ? nameOf(view, e.by) : 'someone') + ' and stayed at ' + at;
  }
  if (e.kind === 'grab') {
    return e.by
      ? 'took the key from ' + nameOf(view, e.by) + ' at ' + at + ' t' + e.t
      : 'picked up the key at ' + at + ' t' + e.t;
  }
  if (e.kind === 'lost') {
    return 'lost the key' + (e.by ? ' to ' + nameOf(view, e.by) : '') + ' at ' + at + ' t' + e.t;
  }
  return 'was stuck';
}

type Front = View['fronts'][number];

function frontText(view: SessionView, f: Front): string {
  if (f.target === null) return 'key at the center';
  if (f.target === view.me.color) return 'reaches you in ' + plural(f.gap, 'turn');
  const who = nameOf(view, f.target) + "'s last visible body";
  return f.gap === 0 ? 'reached ' + who : 'reaches ' + who + ' in ' + plural(f.gap, 'turn');
}

function keyHolders(view: SessionView): Map<string, Vec> {
  const out = new Map<string, Vec>();
  for (const k of view.keys) out.set(k.color + ':' + k.p, k.side);
  return out;
}

function Swatch({ color }: { color: Color }) {
  return <i class="sw" style={{ background: COLORS[color].hex }} />;
}

type BoardProps = {
  view: SessionView;
  focusT: number;
  lookBack: number;
  picked: Action | null;
  onPick: ((a: Action) => void) | null;
};

function Board({ view, focusT, lookBack, picked, onPick }: BoardProps) {
  const lo = Math.max(0, focusT - lookBack);
  const walls = new Set(view.walls.map((p) => p[0] + ',' + p[1]));
  const op = shade(view.bodies, focusT, lookBack);
  const held = keyHolders(view);
  const centerKey = view.center[0] + ',' + view.center[1];
  const spawnAt = new Map<string, Color>();
  for (const c of view.roster) {
    const s = view.spawns[c];
    if (s) spawnAt.set(s[0] + ',' + s[1], c);
  }
  const keyAtCenter = view.keyAtCenter.some((t) => t === focusT);
  const fronts = new Map<string, Front[]>();
  for (const f of view.fronts) if (f.t >= lo && f.t <= focusT) push(fronts, f.x + ',' + f.y, f);

  const atFocus = new Map<string, ViewBody[]>();
  const history = new Map<string, ViewBody[]>();
  for (const b of view.bodies) {
    const k = b.x + ',' + b.y;
    if (b.t === focusT) push(atFocus, k, b);
    else if (b.t >= lo && b.t < focusT) push(history, k, b);
  }

  // Board clicks apply only at the current world turn.
  const targets = new Map<string, ActionOffer>();
  if (onPick && focusT === view.me.t) {
    for (const a of view.actions) if (a.action !== 'I') targets.set(a.x + ',' + a.y, a);
  }

  const cells = [];
  for (let y = 0; y < view.h; y++) {
    for (let x = 0; x < view.w; x++) {
      const k = x + ',' + y;
      cells.push(
        <Cell
          key={k}
          view={view}
          wall={walls.has(k)}
          target={targets.get(k)}
          picked={picked}
          onPick={onPick}
          here={atFocus.get(k)}
          past={history.get(k)}
          op={op}
          held={held}
          spawn={spawnAt.get(k)}
          keyHere={k === centerKey && keyAtCenter}
          fronts={fronts.get(k)}
        />
      );
    }
  }
  return <div id="board" style={`--bw:${view.w};--bh:${view.h};`}>{cells}</div>;
}

type CellProps = {
  view: SessionView;
  wall: boolean;
  target: ActionOffer | undefined;
  picked: Action | null;
  onPick: ((a: Action) => void) | null;
  here: ViewBody[] | undefined;
  past: ViewBody[] | undefined;
  op: Map<number, number>;
  held: Map<string, Vec>;
  spawn: Color | undefined;
  keyHere: boolean;
  fronts: Front[] | undefined;
};

function Cell({ view, wall, target, picked, onPick, here, past, op, held, spawn, keyHere, fronts }: CellProps) {
  let style: JSX.CSSProperties = { background: 'var(--surface-1)' };
  let title: string | undefined;
  let click: (() => void) | undefined;

  if (wall) {
    style = { background: 'var(--wall)', opacity: 0.38 };
  } else if (target && target.reason === null) {
    const on = picked === target.action;
    style = {
      background: 'var(--accent-bg)',
      cursor: 'pointer',
      outline: (on ? '2px' : '1.5px') + ' solid var(--accent-br)',
      outlineOffset: on ? '-2px' : '-1.5px',
      ...(on ? {} : { opacity: 0.75 })
    };
    title = target.action === 'H' ? 'hold' : 'move ' + target.action;
    const a = target.action;
    click = onPick ? () => { onPick(a); } : undefined;
  } else if (target) {
    style = { background: 'var(--wall)', opacity: 0.55 };
    title = 'Blocked by ' + target.reason;
  }

  const focused = wall ? undefined : here;
  const trail = wall ? undefined : past;
  const dots = trail
    ? [...trail].sort((a, b) => b.t - a.t).slice(0, focused ? 2 : 4)
    : [];
  const sides = new Map<string, Vec>();
  for (const b of focused ?? []) {
    const side = held.get(b.color + ':' + b.p);
    if (side) sides.set(side.join(','), side);
  }

  if (spawn) style = { ...style, border: '2px dashed ' + COLORS[spawn].hex };

  return (
    <div class="cell" style={style} title={title} onClick={click} data-spawn={spawn}>
      {focused && focused.length > 0 && <Token view={view} bodies={focused} />}
      {keyHere && !focused?.length && <i class="key-mark center" />}
      {[...sides.values()].map((side) => (
        <i key={side.join(',')} class="key-mark" data-side={side.join(',')} />
      ))}
      {fronts?.map((f, i) => (
        <i
          key={i}
          class="front-mark"
          style={{ '--front-color': COLORS[f.color].hex }}
          title={frontText(view, f)}
          aria-label={frontText(view, f)}
        />
      ))}
      {dots.length > 0 && (
        <div class={'trail-cluster' + (focused ? ' corner' : '')}>
          {dots.map((b) => (
            <div
              key={b.color + ':' + b.p}
              class="trail"
              data-direction={relativeDirection(view, b)}
              style={{ '--body-color': COLORS[b.color].hex, opacity: op.get(b.t) }}
              title={describe(view, b)}
              aria-label={describe(view, b)}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function Token({ view, bodies }: { view: SessionView; bodies: ViewBody[] }) {
  const sorted = [...bodies].sort((a, b) => a.p - b.p);
  const first = sorted[0];
  if (!first) return null;
  const c = COLORS[first.color];
  const many = sorted.length > 1;
  const description = sorted.map((b) => describe(view, b)).join('\n');
  const relative = new Set(sorted.map((b) => relativeDirection(view, b)));
  const direction = relative.size > 1 ? 'mixed' : relative.values().next().value ?? 'matching';
  const indices = sorted.length > 2
    ? sorted[0]!.p + ' … ' + sorted[sorted.length - 1]!.p
    : sorted.map((b) => b.p).join('·');
  return (
    <div
      class={'tok ' + (many ? 'tok-many' : 'tok-single')}
      data-direction={direction}
      style={{ '--body-color': c.hex, '--body-ink': c.ink }}
      title={description}
      aria-label={description}
    >
      <span class="tok-label">{indices}</span>
    </div>
  );
}

const FLEX_ROW = 'display:flex;gap:2px;';

function Strip({ view, focusT, lookBack }: { view: SessionView; focusT: number; lookBack: number }) {
  const lo = Math.max(0, focusT - lookBack);
  const span = Math.max(view.me.horizon + 1, 1);
  const heads = new Map<number, ViewBody[]>();
  for (const b of view.bodies) if (b.live) push(heads, b.t, b);
  const fronts = new Map<number, Front[]>();
  for (const f of view.fronts) push(fronts, f.t, f);

  const cols = [];
  for (let t = 0; t < span; t++) cols.push(t);
  const beyond = view.outcome.status === 'running' && view.me.horizon < view.cap;

  return (
    <div id="strip" style="margin-top:12px;">
      {fronts.size > 0 && (
        <div style={FLEX_ROW + 'margin-bottom:2px;'}>
          {cols.map((t) => (
            <div key={t} style="flex:1;min-width:3px;height:7px;text-align:center;line-height:0;">
              {(fronts.get(t) ?? []).map((f, i) => (
                <i
                  key={i}
                  class="front-tick"
                  style={{ '--front-color': COLORS[f.color].hex }}
                  title={frontText(view, f)}
                  aria-label={frontText(view, f)}
                />
              ))}
            </div>
          ))}
        </div>
      )}
      <div style={FLEX_ROW + 'margin-bottom:2px;'}>
        {cols.map((t) => (
          <div key={t} style="flex:1;min-width:3px;height:7px;text-align:center;line-height:0;">
            {(heads.get(t) ?? []).map((b) => (
              <i
                key={b.color}
                class="time-head"
                data-direction={relativeDirection(view, b)}
                style={{ '--body-color': COLORS[b.color].hex }}
                title={describe(view, b)}
                aria-label={describe(view, b)}
              />
            ))}
          </div>
        ))}
      </div>
      <div style={FLEX_ROW + 'margin-bottom:3px;'}>
        {cols.map((t) => {
          const inWin = t >= lo && t <= focusT;
          return (
            <div
              key={t}
              style={{
                flex: 1, minWidth: '3px', height: '9px', borderRadius: '2px',
                background: inWin ? 'var(--text-secondary)' : 'var(--surface-2)',
                opacity: t === focusT ? 1 : inWin ? 0.4 : 1
              }}
            />
          );
        })}
        {beyond && <div style="flex:2;min-width:14px;height:9px;border-radius:2px;border:1px dashed var(--border);" />}
      </div>
      <div style={FLEX_ROW}>
        {cols.map((t) => (
          <div
            key={t}
            style={{
              flex: 1, minWidth: '3px', textAlign: 'center', fontSize: '9.5px',
              fontFamily: 'var(--mono)',
              color: t === focusT ? 'var(--text-primary)' : 'var(--text-muted)'
            }}
          >
            {span <= 24 || t % 5 === 0 ? t : ''}
          </div>
        ))}
      </div>
      <div class="muted" style="font-size:11.5px;margin-top:4px;">
        explored through t{view.me.horizon}
        {beyond ? '. Dashed is unexplored.' : ''}
      </div>
    </div>
  );
}

function Legend({ view }: { view: SessionView }) {
  return (
    <div class="legend" id="legend">
      {view.roster.map((c) => (
        <span key={c}><Swatch color={c} />{nameOf(view, c)}</span>
      ))}
      <span>
        <i class="sw" style="width:6px;height:6px;background:var(--text-muted);opacity:.4" />
        earlier turns
      </span>
      <span><i class="direction-key matching" />your direction</span>
      <span><i class="direction-key opposing" />opposite direction</span>
      <span><i class="direction-key mixed" />mixed directions</span>
      <span>number is personal index</span>
      <span><i class="spawn-key" />spawn</span>
      {view.mode === 'bootstrap' && (
        <Fragment>
          <span><i class="key-key" />key</span>
          <span><i class="front-key" />front</span>
        </Fragment>
      )}
    </div>
  );
}

function Log({ view }: { view: SessionView }) {
  if (!view.events.length) {
    return <ul class="log" id="log"><li class="muted">No turns yet.</li></ul>;
  }
  const groups: { turn: number; rows: TurnEvent[] }[] = [];
  for (const e of view.events) {
    const last = groups[groups.length - 1];
    if (last && last.turn === e.turn) last.rows.push(e);
    else groups.push({ turn: e.turn, rows: [e] });
  }
  groups.reverse();

  return (
    <ul class="log" id="log">
      {groups.map((g, i) => (
        <Fragment key={g.turn}>
          {i > 0 && <li class="turnsep" />}
          {g.rows.map((e, j) => (
            <li key={e.color + ':' + j}>
              <span class="m">t{e.turn}</span>
              <Swatch color={e.color} />
              <span>
                <strong style="font-weight:500;color:var(--text-primary);">{nameOf(view, e.color)}</strong>
                {' '}{eventText(view, e)}
              </span>
            </li>
          ))}
        </Fragment>
      ))}
    </ul>
  );
}

export type Theme = 'dark' | 'light';
const THEME_KEY = 'tbtt-theme';

export function readTheme(): Theme {
  try {
    return localStorage.getItem(THEME_KEY) === 'light' ? 'light' : 'dark';
  } catch {
    return 'dark';
  }
}

export function applyTheme(t: Theme): void {
  document.documentElement.setAttribute('data-theme', t);
  try { localStorage.setItem(THEME_KEY, t); } catch { /* storage off */ }
}

function randomSeed(): string {
  return Math.floor(Math.random() * 0x100000000).toString(36).slice(0, 6);
}
function suggestCap(w: number, h: number): number {
  return Math.ceil(1.7 * (w + h));
}
function outcomeText(v: SessionView): string {
  const o = v.outcome;
  if (o.status === 'won') return (o.color === v.me.color ? 'You' : nameOf(v, o.color)) + ' won';
  return 'Draw';
}
function messageOf(e: unknown): string {
  return e instanceof Error && e.message ? e.message : String(e);
}

type Form = { mode: string; w: string; h: string; wallPct: string; seed: string; cap: string; roster: string };

function initialForm(): Form {
  return {
    mode: 'bootstrap', w: '16', h: '9', wallPct: '11',
    seed: randomSeed(), cap: String(suggestCap(16, 9)), roster: 'CPTA'
  };
}

function SetupCard({ onMatch, initialError }: { onMatch: (m: Match) => void; initialError: string }) {
  const [form, setForm] = useState<Form>(initialForm);
  const [error, setError] = useState(initialError);

  // Board size resets the suggested cap.
  const size = (key: 'w' | 'h') => (e: { currentTarget: HTMLInputElement }) => {
    const value = e.currentTarget.value;
    setForm((f) => {
      const next = { ...f, [key]: value };
      return { ...next, cap: String(suggestCap(+next.w || 16, +next.h || 9)) };
    });
  };
  const field = (key: keyof Form) => (e: { currentTarget: HTMLInputElement | HTMLSelectElement }) => {
    const value = e.currentTarget.value;
    setForm((f) => ({ ...f, [key]: value }));
  };

  function make() {
    const cfg: ConfigInput = {
      mode: form.mode, w: +form.w, h: +form.h, wallPct: +form.wallPct,
      seed: form.seed.trim(), cap: +form.cap, roster: form.roster.split('')
    };
    try {
      onMatch(Match.fromConfig(cfg));
      setError('');
    } catch (e) {
      setError(messageOf(e));
    }
  }

  return (
    <div class="card">
      <div id="paneNew">
        <h2>Set the board, then share the link.</h2>
        <div class="grid2">
          <div>
            <label class="f">Width <input id="fW" type="number" min="5" max="64" value={form.w} onInput={size('w')} /></label>
            <label class="f">Height <input id="fH" type="number" min="5" max="64" value={form.h} onInput={size('h')} /></label>
            <label class="f">Walls (%) <input id="fWall" type="number" min="0" max="45" value={form.wallPct} onInput={field('wallPct')} /></label>
          </div>
          <div>
            <label class="f">Mode
              <select id="fMode" value={form.mode} onChange={field('mode')}>
                <option value="bootstrap">Bootstrap: bring the key home</option>
                <option value="sandbox">Sandbox: no winner</option>
              </select>
            </label>
            <label class="f">Seed <input id="fSeed" type="text" value={form.seed} onInput={field('seed')} /></label>
            <label class="f">Turn cap <input id="fCap" type="number" min="2" max="400" value={form.cap} onInput={field('cap')} /></label>
            <label class="f">Players
              <select id="fRoster" value={form.roster} onChange={field('roster')}>
                <option value="CP">2: Coral, Purple</option>
                <option value="CPT">3: Coral, Purple, Teal</option>
                <option value="CPTA">4: Coral, Purple, Teal, Amber</option>
              </select>
            </label>
          </div>
        </div>
        <button id="btnMake" style="width:100%;margin-top:6px;" onClick={make}>Create match</button>
      </div>
      <div id="setupErr" class="err">{error}</div>
    </div>
  );
}

function CopyButton(
  { id, value, label, style }:
  { id: string; value: string; label: string; style?: string }
) {
  const [state, setState] = useState<'idle' | 'copied' | 'failed'>('idle');
  return (
    <>
      <button
        id={id}
        style={style}
        onClick={async () => {
          setState('idle');
          try {
            await navigator.clipboard.writeText(value);
            setState('copied');
            setTimeout(() => { setState('idle'); }, 1200);
          } catch {
            setState('failed');
          }
        }}
      >
        {state === 'copied' ? 'Copied' : state === 'failed' ? 'Copy failed' : label}
      </button>
      {state === 'failed' && (
        <div id="copyErr" class="err">Could not copy the link. Copy it from the address bar.</div>
      )}
    </>
  );
}

const NAME_RE = /^[A-Za-z0-9_-]{1,12}$/;

type PickerProps = {
  link: string;
  view: SessionView;
  name: string;
  setName: (name: string) => void;
  chosen: Color | null;
  setChosen: (c: Color) => void;
  onSit: () => void;
  onNew: () => void;
};

function PickCard(p: PickerProps) {
  const seatOf = (c: Color) => p.view.seats.find((seat) => seat.color === c)!;

  const chosenSeat = p.chosen ? seatOf(p.chosen) : null;
  const fixed = Boolean(chosenSeat && (chosenSeat.locked || chosenSeat.state === 'taken'));
  const fieldValue = fixed ? chosenSeat?.name ?? '' : p.name;
  const typed = fieldValue.trim();
  const badName = typed.length > 0 && !NAME_RE.test(typed);
  const live = p.view.status === 'live';
  const canPlay = Boolean(live && p.chosen && chosenSeat?.state !== 'taken' && typed && !badName);

  const waiting = live ? '' : p.view.status === 'failed'
    ? 'Could not connect. ' + (p.view.detail || 'The relays did not answer.')
    : 'Waiting for ' + plural(p.view.peersNeeded, 'player') + '.';

  function sit() {
    if (!canPlay || !p.chosen) return;
    p.onSit();
  }

  return (
    <div id="pickCard">
      <div class="card">
        <div class="lobby-head">
          <h2>Choose a color and a name.</h2>
          <div class="lobby-actions">
            <CopyButton id="btnCopyJoin" value={p.link} label="Copy join link" />
            <button id="btnNewLobby" onClick={p.onNew}>New match</button>
          </div>
        </div>
        <div id="pickRows">
          {p.view.roster.map((c) => {
            const seat = seatOf(c);
            const taken = seat.state === 'taken';
            return (
              <div
                key={c}
                class={'pickrow' + (p.chosen === c ? ' on' : '') + (taken ? ' taken' : '')}
                data-color={c}
                onClick={() => {
                  p.setChosen(c);
                }}
              >
                <Swatch color={c} />
                <span class="sec">{COLORS[c].name}</span>
              </div>
            );
          })}
        </div>
        <label class="pickname sec" for="pickName">
          Name
          <input
            id="pickName" type="text" maxLength={12} placeholder={p.chosen ? 'Name' : 'Choose a color first'}
            value={fieldValue} disabled={!p.chosen || fixed}
            onInput={(e) => { if (!fixed) p.setName(e.currentTarget.value); }}
            onKeyDown={(e) => { if (e.key === 'Enter') sit(); }}
          />
        </label>
        <div id="nameErr" class="err">
          {badName ? 'Use letters, digits, hyphens, or underscores. Max 12 characters.' : ''}
        </div>
        <div id="pickErr" class="err">{p.view.notice || p.view.error || ''}</div>
        <div id="pickWait" class="sec" style="margin-top:12px;">{waiting}</div>
        <button id="btnPlay" style="width:100%;margin-top:12px;" disabled={!canPlay} onClick={sit}>Play</button>
      </div>
    </div>
  );
}

const LABEL: Record<Action, string> = {
  W: 'up', A: 'left', S: 'down', D: 'right', H: 'hold', I: 'invert'
};
const KEYS: Record<string, Action> = {
  ArrowUp: 'W', ArrowDown: 'S', ArrowLeft: 'A', ArrowRight: 'D',
  w: 'W', a: 'A', s: 'S', d: 'D', W: 'W', A: 'A', S: 'S', D: 'D'
};
const NET_LABEL: Record<string, string> = {
  offline: 'Offline', connecting: 'Connecting', live: 'Connected',
  failed: 'Connection failed. Reload the match link to try again.'
};

function committed(v: SessionView): boolean {
  return !v.pending.includes(v.me.color);
}
function legalNow(v: SessionView, a: Action): boolean {
  const offer = v.actions.find((o) => o.action === a);
  return offer ? offer.reason === null : false;
}
function reasonsOf(v: SessionView): Partial<Record<Action, string | null>> {
  const out: Partial<Record<Action, string | null>> = {};
  for (const o of v.actions) out[o.action] = o.reason;
  return out;
}

function PlayScreen({ session, view, onNew }: { session: Session; view: SessionView; onNew: () => void }) {
  const v = view;

  const [pick, setPick] = useState<Action | null>(null);
  const [busy, setBusy] = useState(false);
  const [pickMsg, setPickMsg] = useState('');
  const [shareMsg, setShareMsg] = useState('');
  const [scrub, setScrub] = useState<{ turn: number; t: number } | null>(null);
  const maxBack = Math.max(1, Math.ceil(v.cap / 4));
  const [lookBack, setLookBack] = useState<number | null>(null);

  const back = lookBack ?? maxBack;
  const focusT = Math.min(scrub && scrub.turn === v.turn ? scrub.t : v.me.t, v.me.horizon);
  const done = committed(v);
  const over = v.outcome.status !== 'running';
  const reasons = reasonsOf(v);

  // Prefer hold, then invert, so Commit always names a legal action.
  const active: Action | null = over || done ? null
    : pick && legalNow(v, pick) ? pick
      : legalNow(v, 'H') ? 'H' : legalNow(v, 'I') ? 'I' : null;

  const aim = useCallback((a: Action) => {
    if (over || done || !legalNow(v, a)) return;
    setPick(a);
  }, [v, done]);

  const commit = useCallback(async () => {
    if (!active || busy) return;
    setBusy(true);
    const r = await session.commit(active);
    setBusy(false);
    if (!r.ok) { setPickMsg(r.error ?? 'commit failed'); return; }
    setPickMsg('');
    setShareMsg('');
    setPick(null);
  }, [session, active, busy]);

  const undo = useCallback(() => {
    const r = session.withdraw();
    setShareMsg(r.ok ? '' : r.error ?? 'could not take it back');
  }, [session]);

  // Invert has no shortcut because it reverses direction.
  useEffect(() => {
    function onKey(e: KeyboardEvent): void {
      const target = e.target;
      if (target instanceof HTMLElement && target.closest(
        'input, textarea, select, button, a, [contenteditable="true"], [role="button"], [role="slider"]'
      )) return;
      if (e.metaKey || e.ctrlKey || e.altKey) return;

      if (e.key === 'Enter' || e.key === ' ') {
        if (active && !busy) { void commit(); e.preventDefault(); }
        return;
      }
      if (e.key === 'Escape') {
        if (done) { if (v.canChange) undo(); } else setPick(null);
        e.preventDefault();
        return;
      }
      if (done || over) return;
      const k = KEYS[e.key];
      if (k) { aim(k); e.preventDefault(); }
    }
    document.addEventListener('keydown', onKey);
    return () => { document.removeEventListener('keydown', onKey); };
  }, [active, busy, done, v, aim, commit, undo]);

  const c = COLORS[v.me.color];
  const net = NET_LABEL[v.status] ?? v.status;

  function padButton(
    a: Action, face: string, sub: string | null, hint: string, id?: string, style?: string
  ) {
    const reason = reasons[a];
    return (
      <button
        id={id}
        data-act={a}
        style={style}
        disabled={reason !== null}
        title={reason || hint}
        class={active === a ? 'sel' : ''}
        onClick={() => { aim(a); }}
      >
        {face}{sub === null ? null : <small>{sub}</small>}
      </button>
    );
  }

  const why = active === 'I'
    ? 'Stay at t' + v.me.t + ' and walk ' + (v.me.dir === 1 ? 'backward' : 'forward') + '.'
    : active === 'H'
      ? 'Stay here. This uses a world turn, not an index.'
      : reasons.H ? 'Cannot hold here: ' + reasons.H + '.' : '';

  return (
    <div class="cols">
      <div>
        <button id="btnNewPlay" style="width:100%;margin-bottom:14px;" onClick={onNew}>New match</button>
        <div class="card">
          <h2>Log</h2>
          <Log view={v} />
        </div>
      </div>

      <div>
        <div class="card">
          <div style="display:flex;justify-content:space-between;align-items:baseline;gap:12px;flex-wrap:wrap;margin-bottom:12px;">
            <div>
              <strong id="youAre">
                <span class="pill" style={{ background: c.hex, color: c.ink }}>{nameOf(v, v.me.color)}</span>
              </strong>{' '}
              <span id="youAt" class="sec mono">
                index {v.me.p} · t{v.me.t} · {v.me.dir === 1 ? 'forward' : 'backward'} · ({v.me.x},{v.me.y})
              </span>
            </div>
            <div class="mono muted" id="turnInfo">
              {over ? outcomeText(v) + ' at turn ' + v.turn : 'turn ' + v.turn + ' / ' + v.cap + ' · state ' + v.hash}
            </div>
          </div>

          <div class="boardframe">
            <Board view={v} focusT={focusT} lookBack={back} picked={active} onPick={over || done ? null : aim} />
          </div>

          <div class="row">
            <label for="sl">World turn</label>
            <input
              type="range" id="sl" min={0} max={v.me.horizon} value={focusT} step={1} style="flex:1;"
              onInput={(e) => { setScrub({ turn: v.turn, t: +e.currentTarget.value }); }}
            />
            <span class="out" id="slo">{focusT}</span>
          </div>
          <div class="row">
            <label for="rd">History</label>
            <input
              type="range" id="rd" min={0} max={maxBack} value={back} step={1} style="flex:1;"
              onInput={(e) => { setLookBack(+e.currentTarget.value); }}
            />
            <span class="out" id="rdo">{back}</span>
          </div>
          <div class="muted" style="font-size:11.5px;margin-top:-2px;" id="rdNote">
            up to {maxBack} turns of history
          </div>
          <Strip view={v} focusT={focusT} lookBack={back} />
          <Legend view={v} />
        </div>
      </div>

      <div>
        <div class="card" id="turnCard">
          <div class="mono sec" id="netInfo" style="margin-bottom:10px;">
            {net
              + (v.peersNeeded ? ' · waiting for ' + plural(v.peersNeeded, 'player') : '')
              + (v.status === 'live' ? ' · ' + plural(v.peers.length, 'other player') : '')
              + (v.detail ? ' · ' + v.detail : '')}
          </div>
          <div class="err" id="netErr">{v.error || v.notice || ''}</div>
          {!over && (
            <div id="pending" class="mono muted" style="margin-bottom:10px;">
              {v.uncommitted.length
                ? 'Still choosing: ' + v.uncommitted.map((x) => x === v.me.color ? 'You' : nameOf(v, x)).join(', ')
                : 'All actions are in.'}
            </div>
          )}

          {v.mode === 'bootstrap' && !over && (
            <div class="muted" id="modeHint" style="font-size:12.5px;margin-bottom:10px;">
              Grab the key from beside the center. Win at t0 next to your spawn.
            </div>
          )}
          <div id="phasePick" class={over || done ? 'hide' : ''}>
            <h2>Your move</h2>
            <div class="dpad" id="dpad">
              <div class="blank" />
              {padButton('W', '↑', 'W', 'move up')}
              <div class="blank" />
              {padButton('A', '←', 'A', 'move left')}
              {padButton('H', '·', 'hold', 'hold this square')}
              {padButton('D', '→', 'D', 'move right')}
              <div class="blank" />
              {padButton('S', '↓', 'S', 'move down')}
              <div class="blank" />
            </div>
            {padButton('I', 'Turn around in time', null, 'Turn around in time', 'btnInvert', 'width:100%;')}
            <button id="btnCommit" style="width:100%;margin-top:10px;" disabled={!active || busy} onClick={() => { void commit(); }}>
              {active ? 'Commit ' + LABEL[active] : 'Commit'}
            </button>
            <div class="keyhint">Arrows or WASD: choose. Enter or Space: commit. Esc: clear. Turn around has no shortcut.</div>
            <div class="muted" style="font-size:12.5px;margin-top:8px;" id="pickWhy">{why}</div>
            <div id="pickMsg">{pickMsg && <div class="err">{pickMsg}</div>}</div>
          </div>

          <div id="phaseShare" class={over || !done ? 'hide' : ''}>
            <h2>Action locked in</h2>
            <div style="display:flex;gap:8px;margin:0 0 6px;">
              <button id="btnUndo" class={v.canChange ? '' : 'hide'} onClick={undo}>Change my action</button>
            </div>
            <div id="keyUndo" style="margin:0 0 14px;" class={v.canChange ? 'keyhint' : 'keyhint hide'}>Esc also changes it.</div>
            <div id="shareMsg">{shareMsg && <div class="err">{shareMsg}</div>}</div>
          </div>

          <div id="phaseOver" class={over ? '' : 'hide'}>
            <h2>{outcomeText(v)}</h2>
            <div class="muted" style="font-size:13px;">Use World turn to review the match.</div>
          </div>
        </div>

        <div class="card">
          <h2>Priority this turn</h2>
          <div class="mono sec" id="prioInfo">
            {over ? 'match over' : v.priority.map((x, i) => (
              <Fragment key={x}>
                {i > 0 && ' › '}
                <span style="display:inline-flex;align-items:center;gap:5px;"><Swatch color={x} />{nameOf(v, x)}</span>
              </Fragment>
            ))}
          </div>
          <div class="muted" style="font-size:12.5px;margin-top:6px;">Holders resolve before movers.</div>
        </div>
      </div>
    </div>
  );
}

type LinkKind = 'join' | 'resume';
type Live = {
  session: Session; link: string; resumeTurn: number | null;
};

type Startup = {
  match: Match | null;
  names: Names;
  kind: LinkKind | null;
  error: string;
};

function replaceLink(kind: LinkKind, payload: string): string {
  const url = new URL(window.location.href);
  url.hash = kind + '=' + encodeURIComponent(payload);
  history.replaceState(null, '', url.href);
  return url.href;
}

function clearLink(): void {
  const url = new URL(window.location.href);
  url.hash = '';
  history.replaceState(null, '', url.href);
}

function startupFromLink(): Startup {
  const raw = window.location.hash.slice(1);
  const kind: LinkKind | null = raw.startsWith('join=') ? 'join'
    : raw.startsWith('resume=') ? 'resume' : null;
  if (!kind) return { match: null, names: {}, kind: null, error: '' };

  let payload: string;
  try {
    payload = decodeURIComponent(raw.slice(kind.length + 1));
  } catch {
    return { match: null, names: {}, kind: null, error: 'The match link is malformed.' };
  }

  if (kind === 'join') {
    const decoded = Wire.decodeMatchCode(payload);
    if (!decoded.ok) return { match: null, names: {}, kind: null, error: decoded.error };
    try {
      return { match: Match.fromConfig(decoded.value), names: {}, kind, error: '' };
    } catch (e) {
      return { match: null, names: {}, kind: null, error: messageOf(e) };
    }
  }

  const imported = Match.fromExport(trimUnresolved(payload));
  if (!imported.ok) return { match: null, names: {}, kind: null, error: imported.error };
  return { match: imported.value.match, names: imported.value.names, kind, error: '' };
}

export function App({ loadRoom }: { loadRoom: RoomLoader }) {
  const [theme, setTheme] = useState<Theme>(readTheme);
  const [startup] = useState<Startup>(startupFromLink);
  const [setupError, setSetupError] = useState(startup.error);
  const [setupKey, setSetupKey] = useState(0);
  const [live, setLive] = useState<Live | null>(null);
  const liveRef = useRef<Live | null>(null);
  const [name, setName] = useState('');
  const [chosen, setChosen] = useState<Color | null>(null);
  const [playing, setPlaying] = useState(false);
  // Session mutates in place, so messages need an explicit redraw.
  const [, setTick] = useState(0);
  const redraw = useCallback(() => { setTick((n) => n + 1); }, []);

  const openMatch = useCallback((m: Match, imported: Names = {}, kind: LinkKind = 'join') => {
    const code = Wire.encodeMatchCode(m.config());
    if (liveRef.current) liveRef.current.session.close();
    const channel = PeerChannel(Code.roomId(code), loadRoom);
    const session = Session.open({ match: m, channel, names: imported, onChange: redraw });
    const payload = kind === 'join' ? code : trimUnresolved(session.export());
    const next = {
      session, link: replaceLink(kind, payload), resumeTurn: null
    };
    liveRef.current = next;
    setLive(next);
    setName('');
    setChosen(null);
    setPlaying(false);
    setSetupError('');
  }, [loadRoom, redraw]);

  useEffect(() => {
    if (startup.match && startup.kind) openMatch(startup.match, startup.names, startup.kind);
  }, [startup, openMatch]);

  const seated = live ? live.session.color() !== null : false;
  const showPlay = playing && seated;
  const view = live ? live.session.view() : null;
  useEffect(() => {
    if (playing && !seated) setPlaying(false);
  }, [playing, seated]);

  useEffect(() => {
    if (!showPlay || !live || !view || live.resumeTurn === view.turn) return;
    live.link = replaceLink('resume', trimUnresolved(live.session.export()));
    live.resumeTurn = view.turn;
  }, [showPlay, live, view?.turn]);

  function sit() {
    if (!live || !chosen) return;
    const r = live.session.claim(chosen, name.trim());
    if (!r.ok) { redraw(); return; }
    setPlaying(true);
  }

  function newMatch(): void {
    if (showPlay && !window.confirm('Start a new match? The current match will be left.')) return;
    liveRef.current?.session.close();
    liveRef.current = null;
    setLive(null);
    setName('');
    setChosen(null);
    setPlaying(false);
    setSetupError('');
    setSetupKey((n) => n + 1);
    clearLink();
  }

  return (
    <div class="wrap">
      <div style="display:flex;justify-content:space-between;align-items:flex-start;gap:16px;">
        <div>
          <h1>Time travel tactics</h1>
          <p class="sub">A multiplayer time-travel tactics prototype.</p>
        </div>
        <button
          id="btnTheme" title="Switch between dark and light"
          onClick={() => {
            const next: Theme = theme === 'light' ? 'dark' : 'light';
            applyTheme(next);
            setTheme(next);
          }}
        >
          {theme === 'light' ? 'Dark' : 'Light'}
        </button>
      </div>

      <div id="setup" class={showPlay ? 'narrow hide' : 'narrow'}>
        {!live && <SetupCard key={setupKey} initialError={setupError} onMatch={(m) => { openMatch(m); }} />}
        {live && view && !showPlay && (
          <PickCard
            link={live.link} view={view}
            name={name} setName={setName}
            chosen={chosen} setChosen={setChosen} onSit={sit} onNew={newMatch}
          />
        )}
      </div>

      <div id="play" class={showPlay ? '' : 'hide'}>
        {showPlay && live && view && <PlayScreen session={live.session} view={view} onNew={newMatch} />}
      </div>
    </div>
  );
}
