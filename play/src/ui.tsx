import { useCallback, useEffect, useRef, useState } from 'preact/hooks';
import { Fragment } from 'preact';
import type { JSX } from 'preact';

import { COLORS, Match, Wire } from './engine.js';
import type { Action, ActionOffer, Color, ConfigInput, TurnEvent, ViewBody } from './engine.js';
import { Code, PeerChannel, Session, trimUnresolved } from './transport.js';
import type { Channel, RoomLoader, SessionView } from './transport.js';

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
  return nameOf(view, b.color) + ', index ' + b.p + ', world turn ' + b.t + (b.live ? ', current' : '');
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
  return 'was stuck';
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
};

function Cell({ view, wall, target, picked, onPick, here, past, op }: CellProps) {
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

  return (
    <div class="cell" style={style} title={title} onClick={click}>
      {focused && focused.length > 0 && <Token view={view} bodies={focused} />}
      {dots.length > 0 && (
        <div class={'trail-cluster' + (focused ? ' corner' : '')}>
          {dots.map((b) => (
            <div
              key={b.color + ':' + b.p}
              class="trail"
              style={{ background: COLORS[b.color].hex, opacity: op.get(b.t) }}
              title={describe(view, b)}
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
  return (
    <div
      class={'tok ' + (many ? 'tok-many' : 'tok-single')}
      style={{ background: c.hex, color: c.ink }}
      title={description}
      aria-label={description}
    >
      {sorted.map((b) => b.p).join('·')}
    </div>
  );
}

const FLEX_ROW = 'display:flex;gap:2px;';

function Strip({ view, focusT, lookBack }: { view: SessionView; focusT: number; lookBack: number }) {
  const lo = Math.max(0, focusT - lookBack);
  const span = Math.max(view.me.horizon + 1, 1);
  const heads = new Map<number, Color[]>();
  for (const b of view.bodies) if (b.live) push(heads, b.t, b.color);

  const cols = [];
  for (let t = 0; t < span; t++) cols.push(t);
  const beyond = !view.over && view.me.horizon < view.cap;

  return (
    <div id="strip" style="margin-top:12px;">
      <div style={FLEX_ROW + 'margin-bottom:2px;'}>
        {cols.map((t) => (
          <div key={t} style="flex:1;min-width:3px;height:7px;text-align:center;line-height:0;">
            {(heads.get(t) ?? []).map((c) => (
              <i
                key={c}
                style={{
                  display: 'inline-block', width: '5px', height: '5px',
                  borderRadius: '50%', background: COLORS[c].hex
                }}
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
      <span>number is personal index</span>
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
function messageOf(e: unknown): string {
  return e instanceof Error && e.message ? e.message : String(e);
}

type Tab = 'new' | 'join' | 'import';
type Form = { w: string; h: string; wallPct: string; seed: string; cap: string; roster: string };

function initialForm(): Form {
  return {
    w: '16', h: '9', wallPct: '11',
    seed: randomSeed(), cap: String(suggestCap(16, 9)), roster: 'CPTA'
  };
}

function SetupCard({ onMatch }: { onMatch: (m: Match, names?: Names) => void }) {
  const [tab, setTab] = useState<Tab>('new');
  const [form, setForm] = useState<Form>(initialForm);
  const [joinCode, setJoinCode] = useState('');
  const [exported, setExported] = useState('');
  const [error, setError] = useState('');

  const pick = (t: Tab) => () => { setTab(t); setError(''); };

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
      w: +form.w, h: +form.h, wallPct: +form.wallPct,
      seed: form.seed.trim(), cap: +form.cap, roster: form.roster.split('')
    };
    try {
      onMatch(Match.fromConfig(cfg));
      setError('');
    } catch (e) {
      setError(messageOf(e));
    }
  }

  function join() {
    const r = Wire.decodeMatchCode(joinCode);
    if (!r.ok) { setError(r.error); return; }
    try {
      onMatch(Match.fromConfig(r.value));
      setError('');
    } catch (e) {
      setError(messageOf(e));
    }
  }

  function load() {
    const r = Match.fromExport(trimUnresolved(exported));
    if (!r.ok) { setError(r.error); return; }
    onMatch(r.value.match, r.value.names);
    setError('');
  }

  return (
    <div class="card">
      <div class="tabs">
        <button id="tabNew" class={tab === 'new' ? 'on' : ''} onClick={pick('new')}>New match</button>
        <button id="tabJoin" class={tab === 'join' ? 'on' : ''} onClick={pick('join')}>Join with a code</button>
        <button id="tabImport" class={tab === 'import' ? 'on' : ''} onClick={pick('import')}>Import a match</button>
      </div>

      <div id="paneNew" class={tab === 'new' ? '' : 'hide'}>
        <h2>Set the board, then share the code.</h2>
        <div class="grid2">
          <div>
            <label class="f">Width <input id="fW" type="number" min="2" max="64" value={form.w} onInput={size('w')} /></label>
            <label class="f">Height <input id="fH" type="number" min="2" max="64" value={form.h} onInput={size('h')} /></label>
            <label class="f">Walls (%) <input id="fWall" type="number" min="0" max="45" value={form.wallPct} onInput={field('wallPct')} /></label>
          </div>
          <div>
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

      <div id="paneJoin" class={tab === 'join' ? '' : 'hide'}>
        <h2>Paste a match code.</h2>
        <textarea
          id="fCode" rows={2} placeholder="M1:16x9:11:19f4:43:CPTA"
          value={joinCode} onInput={(e) => { setJoinCode(e.currentTarget.value); }}
        />
        <button id="btnJoin" style="width:100%;margin-top:8px;" onClick={join}>Join</button>
      </div>

      <div id="paneImport" class={tab === 'import' ? '' : 'hide'}>
        <h2>Paste an export to resume a match.</h2>
        <textarea
          id="fExport" rows={4} placeholder="X1:M1:16x9:11:19f4:43:CPTA|CDPATWAD,...|C~Rook,P~Vale"
          value={exported} onInput={(e) => { setExported(e.currentTarget.value); }}
        />
        <button id="btnImport" style="width:100%;margin-top:8px;" onClick={load}>Import</button>
      </div>

      <div id="setupErr" class="err">{error}</div>
    </div>
  );
}

function CopyButton(
  { id, area, label, style }:
  { id: string; area: { current: HTMLTextAreaElement | null }; label: string; style?: string }
) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      id={id}
      style={style}
      onClick={() => {
        const el = area.current;
        if (!el) return;
        el.select();
        navigator.clipboard.writeText(el.value).catch(() => { document.execCommand('copy'); });
        setCopied(true);
        setTimeout(() => { setCopied(false); }, 1200);
      }}
    >
      {copied ? 'Copied' : label}
    </button>
  );
}

const NAME_RE = /^[A-Za-z0-9_-]{1,12}$/;

type PickerProps = {
  code: string;
  view: SessionView;
  names: Names;
  setNames: (f: (n: Names) => Names) => void;
  chosen: Color | null;
  setChosen: (c: Color) => void;
  onSit: () => void;
};

function PickCard(p: PickerProps) {
  const codeArea = useRef<HTMLTextAreaElement>(null);
  const seatOf = (c: Color) => p.view.seats.find((seat) => seat.color === c)!;

  // Trim pasted whitespace before validation.
  const chosenSeat = p.chosen ? seatOf(p.chosen) : null;
  const typed = (p.chosen
    ? chosenSeat?.locked ? chosenSeat.name ?? '' : p.names[p.chosen] ?? ''
    : '').trim();
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
        <h2>Share this code with every player.</h2>
        <textarea id="outCode" rows={2} readOnly ref={codeArea} value={p.code} />
        <CopyButton id="btnCopyCode" area={codeArea} label="Copy match code" style="margin-top:8px;" />
      </div>

      <div class="card">
        <h2>Choose a color and a name.</h2>
        <div id="pickRows">
          {p.view.roster.map((c) => {
            const seat = seatOf(c);
            const taken = seat.state === 'taken';
            const fixed = seat.locked || taken;
            const value = fixed ? seat.name ?? '' : p.names[c] ?? '';
            return (
              <div
                key={c}
                class={'pickrow' + (p.chosen === c ? ' on' : '') + (taken ? ' taken' : '')}
                data-color={c}
                onClick={(e) => {
                  p.setChosen(c);
                  e.currentTarget.querySelector('input')?.focus();
                }}
              >
                <Swatch color={c} />
                <span class="sec" style="width:56px;flex:none;">{COLORS[c].name}</span>
                <input
                  type="text" maxLength={12} placeholder="Name"
                  value={value}
                  readOnly={fixed}
                  onInput={(e) => {
                    if (fixed) return;
                    const value = e.currentTarget.value;
                    p.setNames((n) => ({ ...n, [c]: value }));
                  }}
                  onKeyDown={(e) => { if (e.key === 'Enter') sit(); }}
                />
              </div>
            );
          })}
        </div>
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
  failed: 'Connection failed. Use an export to rejoin.'
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

function PlayScreen({ session, view }: { session: Session; view: SessionView }) {
  const v = view;
  const exportArea = useRef<HTMLTextAreaElement>(null);

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
  const reasons = reasonsOf(v);

  // Prefer hold, then invert, so Commit always names a legal action.
  const active: Action | null = v.over || done ? null
    : pick && legalNow(v, pick) ? pick
      : legalNow(v, 'H') ? 'H' : legalNow(v, 'I') ? 'I' : null;

  const aim = useCallback((a: Action) => {
    if (v.over || done || !legalNow(v, a)) return;
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
      if (target instanceof HTMLElement && /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName)) return;
      if (e.metaKey || e.ctrlKey || e.altKey) return;

      if (e.key === 'Enter') {
        if (active && !busy) { void commit(); e.preventDefault(); }
        return;
      }
      if (e.key === 'Escape') {
        if (done) { if (v.canChange) undo(); } else setPick(null);
        e.preventDefault();
        return;
      }
      if (done || v.over) return;
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
        <div class="card">
          <h2>Log</h2>
          <Log view={v} />
        </div>
        <div class="card">
          <h2>Export</h2>
          <div class="muted" style="font-size:12.5px;margin-bottom:8px;">Matches are not saved. Copy this before reloading or if a player drops.</div>
          <textarea id="outExport" rows={3} readOnly ref={exportArea} value={session.export()} />
          <CopyButton id="btnCopyExport" area={exportArea} label="Copy export" style="margin-top:8px;" />
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
              {v.over ? 'match over at turn ' + v.cap : 'turn ' + v.turn + ' / ' + v.cap + ' · state ' + v.hash}
            </div>
          </div>

          <div class="boardframe">
            <Board view={v} focusT={focusT} lookBack={back} picked={active} onPick={v.over || done ? null : aim} />
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

          <div id="phasePick" class={v.over || done ? 'hide' : ''}>
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
            <div class="keyhint">Arrows or WASD: choose. Enter: commit. Esc: clear. Turn around has no shortcut.</div>
            <div class="muted" style="font-size:12.5px;margin-top:8px;" id="pickWhy">{why}</div>
            <div id="pickMsg">{pickMsg && <div class="err">{pickMsg}</div>}</div>
          </div>

          <div id="phaseShare" class={v.over || !done ? 'hide' : ''}>
            <h2>Action locked in</h2>
            <div id="pending" class="mono muted" style="margin-bottom:8px;">
              {v.waiting.length
                ? 'Waiting for ' + v.waiting.map((x) => nameOf(v, x)).join(', ')
                : 'All actions are in.'}
            </div>
            <div style="display:flex;gap:8px;margin:0 0 6px;">
              <button id="btnUndo" class={v.canChange ? '' : 'hide'} onClick={undo}>Change my action</button>
            </div>
            <div id="keyUndo" style="margin:0 0 14px;" class={v.canChange ? 'keyhint' : 'keyhint hide'}>Esc also changes it.</div>
            <div id="shareMsg">{shareMsg && <div class="err">{shareMsg}</div>}</div>
          </div>

          <div id="phaseOver" class={v.over ? '' : 'hide'}>
            <h2>Match over</h2>
            <div class="muted" style="font-size:13px;">Use World turn to review the match.</div>
          </div>
        </div>

        <div class="card">
          <h2>Priority this turn</h2>
          <div class="mono sec" id="prioInfo">
            {v.over ? 'match over' : v.priority.map((x, i) => (
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

type Live = { match: Match; session: Session; channel: Channel; code: string };

export function App({ loadRoom }: { loadRoom: RoomLoader }) {
  const [theme, setTheme] = useState<Theme>(readTheme);
  const [live, setLive] = useState<Live | null>(null);
  const [names, setNames] = useState<Names>({});
  const [chosen, setChosen] = useState<Color | null>(null);
  const [playing, setPlaying] = useState(false);
  // Session mutates in place, so messages need an explicit redraw.
  const [, setTick] = useState(0);
  const redraw = useCallback(() => { setTick((n) => n + 1); }, []);

  const openMatch = useCallback((m: Match, imported?: Names) => {
    const code = Wire.encodeMatchCode(m.config());
    if (live) live.session.close();
    const channel = PeerChannel(Code.roomId(code), loadRoom);
    const session = Session.open({ match: m, channel, names: imported, onChange: redraw });
    setLive({ match: m, channel, code, session });
    setNames(imported ?? {});
    setChosen(null);
    setPlaying(false);
  }, [live, loadRoom, redraw]);

  const seated = live ? live.session.color() !== null : false;
  const showPlay = playing && seated;
  const view = live ? live.session.view() : null;
  useEffect(() => {
    if (playing && !seated) { setPlaying(false); setChosen(null); }
  }, [playing, seated]);

  function sit() {
    if (!live || !chosen) return;
    const r = live.session.claim(chosen, (names[chosen] ?? '').trim());
    if (!r.ok) { redraw(); return; }
    setPlaying(true);
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
        <SetupCard onMatch={openMatch} />
        {live && view && !showPlay && (
          <PickCard
            code={live.code} view={view}
            names={names} setNames={setNames}
            chosen={chosen} setChosen={setChosen} onSit={sit}
          />
        )}
      </div>

      <div id="play" class={showPlay ? '' : 'hide'}>
        {showPlay && live && view && <PlayScreen session={live.session} view={view} />}
      </div>
    </div>
  );
}
