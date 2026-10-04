import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'preact/hooks';
import { Fragment } from 'preact';

import { COLORS, Match, Wire, previewBoard } from './engine/index.js';
import type { Action, BoardPreviewData, Color, ConfigInput, TurnEvent, ViewBody } from './engine/index.js';
import { Board, BoardPreview } from './board.js';
import { instrumentAt, maxLookBack } from './instrument.js';
import { describe, frontText, nameOf, plural, relativeDirection, sceneAt } from './scene.js';
import type { Front } from './scene.js';
import { Code, PeerChannel, Session, trimUnresolved } from './transport.js';
import type { RoomLoader, SessionView } from './transport.js';

type Names = Partial<Record<Color, string>>;

function push<K, V>(m: Map<K, V[]>, k: K, v: V): void {
  const list = m.get(k);
  if (list) list.push(v);
  else m.set(k, [v]);
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

function Swatch({ color }: { color: Color }) {
  return <i class="sw" style={{ background: COLORS[color].hex }} />;
}

const FLEX_ROW = 'display:flex;gap:2px;';
// Reserve the same unexplored width in each row to keep columns aligned.
const TAIL = 'flex:2;min-width:14px;';

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
  const tail = () => beyond ? <div style={TAIL} /> : null;

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
          {tail()}
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
        {tail()}
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
        {beyond && (
          <div style={TAIL} title={'unexplored · t' + (view.me.horizon + 1) + ' … t' + view.cap}>
            {/* A border on the flex item would misalign this row by 2px. */}
            <div style="height:9px;border-radius:2px;border:1px dashed var(--border);" />
          </div>
        )}
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
        {tail()}
      </div>
    </div>
  );
}

function Legend({ view }: { view: SessionView }) {
  return (
    <div class="legend" id="legend">
      <div>
        {view.roster.map((c) => (
          <span key={c}><Swatch color={c} />{nameOf(view, c)}</span>
        ))}
        <span><i class="direction-key matching" />your direction</span>
        <span><i class="direction-key opposing" />opposite direction</span>
        <span><i class="direction-key mixed" />mixed directions</span>
      </div>
      <div>
        {view.mode === 'bootstrap' && (
          <Fragment>
            <span><i class="key-key" />key</span>
            <span><i class="front-key" />front</span>
          </Fragment>
        )}
        <span><i class="spawn-key" />spawn</span>
        <span>
          <i class="sw" style="width:6px;height:6px;background:var(--text-muted);opacity:.4" />
          earlier turns
        </span>
        <span>number on a body is its personal index</span>
        <span>a stack shows its first and last index</span>
      </div>
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
const SIZES = [{ name: 'Small', w: 9, h: 7 }, { name: 'Standard', w: 16, h: 9 }, { name: 'Large', w: 24, h: 13 }];

function SetupCard({ onMatch, initialError }: { onMatch: (m: Match) => void; initialError: string }) {
  const [seeds, setSeeds] = useState(() => [randomSeed(), randomSeed(), randomSeed()]);
  const [selected, setSelected] = useState(0);
  const [form, setForm] = useState<Form>(() => ({
    mode: 'bootstrap', w: '16', h: '9', wallPct: '11', seed: seeds[0]!, cap: String(suggestCap(16, 9)), roster: 'CP'
  }));
  const [customCap, setCustomCap] = useState(false);
  const [error, setError] = useState(initialError);
  const layout = useMemo(() => {
    try {
      for (const key of ['w', 'h', 'wallPct', 'cap'] as const) {
        if (!/^\d+$/.test(form[key])) throw new Error('Use whole numbers for dimensions, walls, and turn cap.');
      }
      const config: ConfigInput = { mode: form.mode, w: +form.w, h: +form.h, wallPct: +form.wallPct,
        seed: form.seed.trim(), cap: +form.cap, roster: form.roster.split('') };
      const board = previewBoard(config);
      const candidates = seeds.map((seed, i) => {
        if (i === selected) return board;
        try { return previewBoard({ ...config, seed }); } catch { return null; }
      });
      return { config, board, candidates, error: '' };
    } catch (e) { return { config: null, board: null, candidates: [], error: messageOf(e) }; }
  }, [form, seeds, selected]);

  function update(key: keyof Form, value: string) {
    setError('');
    if (key === 'cap') setCustomCap(true);
    if (key === 'seed') setSeeds((old) => old.map((seed, i) => i === selected ? value : seed));
    setForm((f) => {
      const next = { ...f, [key]: value };
      if ((key === 'w' || key === 'h') && !customCap) next.cap = String(suggestCap(+next.w || 16, +next.h || 9));
      return next;
    });
  }
  function chooseSize(w: number, h: number) {
    setError(''); setForm((f) => ({ ...f, w: String(w), h: String(h), cap: customCap ? f.cap : String(suggestCap(w, h)) }));
  }
  function chooseSeed(i: number) { setSelected(i); setError(''); setForm((f) => ({ ...f, seed: seeds[i]! })); }
  function reroll() {
    const next = [randomSeed(), randomSeed(), randomSeed()];
    setSeeds(next); setSelected(0); setError(''); setForm((f) => ({ ...f, seed: next[0]! }));
  }
  const preset = SIZES.find((s) => s.w === +form.w && s.h === +form.h);
  const input = (key: keyof Form) => (e: { currentTarget: HTMLInputElement }) => update(key, e.currentTarget.value);
  return (
    <div id="paneNew" class="intro-grid">
      <div class="setup-controls">
        <section class="card">
          <h2>Choose a mode</h2>
          <div class="mode-cards" role="group" aria-label="Mode">
            <button data-mode="bootstrap" aria-pressed={form.mode === 'bootstrap'} class="mode-card" onClick={() => update('mode', 'bootstrap')}>
              <strong>Bootstrap</strong><span>Grab the key, then return to t0 beside your own spawn to win.</span>
            </button>
            <button data-mode="sandbox" aria-pressed={form.mode === 'sandbox'} class="mode-card" onClick={() => update('mode', 'sandbox')}>
              <strong>Sandbox</strong><span>Explore movement, inversion, and history. No key or winner.</span>
            </button>
          </div>
        </section>
        <section class="card">
          <h2>Board size {!preset && <span class="mono">· Custom</span>}</h2>
          <div class="preset-buttons" role="group" aria-label="Board size">
            {SIZES.map((s) => <button key={s.name} data-size={s.name} aria-pressed={preset?.name === s.name}
              onClick={() => chooseSize(s.w, s.h)}>{s.name}<small>{s.w} × {s.h}</small></button>)}
          </div>
          <h2 class="players-heading">Players</h2>
          <div class="player-buttons" role="group" aria-label="Players">
            {['CP', 'CPT', 'CPTA'].map((roster) => <button key={roster} data-roster={roster}
              aria-pressed={form.roster === roster} onClick={() => update('roster', roster)}>{roster.length} players</button>)}
          </div>
          <details class="advanced">
            <summary>Advanced</summary>
            <div class="grid2">
              <div>
                <label class="f">Width <input id="fW" type="number" min="5" max="64" step="1" value={form.w} onInput={input('w')} /></label>
                <label class="f">Height <input id="fH" type="number" min="5" max="64" step="1" value={form.h} onInput={input('h')} /></label>
                <label class="f">Walls (%) <input id="fWall" type="number" min="0" max="45" step="1" value={form.wallPct} onInput={input('wallPct')} /></label>
              </div>
              <div>
                <label class="f">Turn cap <input id="fCap" type="number" min="2" max="400" step="1" value={form.cap} onInput={input('cap')} /></label>
                <label class="f">Seed <input id="fSeed" type="text" maxLength={24} value={form.seed} onInput={input('seed')} /></label>
              </div>
            </div>
          </details>
        </section>
      </div>
      <section class="card preview-panel">
        <div class="preview-head"><h2>Board preview</h2><span class="mono">{form.w} × {form.h}</span></div>
        {layout.board ? <BoardPreview board={layout.board} /> : <div class="preview-invalid">Enter valid settings to preview the board.</div>}
        <div class="seed-options" role="group" aria-label="Seed candidates">
          {seeds.map((seed, i) => <button key={i} class="seed-option" aria-label={'Select seed ' + (i + 1)}
            aria-pressed={selected === i} onClick={() => chooseSeed(i)}>
            {layout.candidates[i] && <BoardPreview board={layout.candidates[i]!} label={'Seed ' + (i + 1) + ' preview'} />}
            <span>{seed || 'Empty seed'}</span>
          </button>)}
          <button id="btnReroll" onClick={reroll}>Reroll</button>
        </div>
        {layout.board && <p class="preview-summary">{form.w} × {form.h} · {form.roster.length} players · {layout.board.walls.length} walls<br />
          <span class="mono">seed {form.seed}</span> · {form.cap} turns</p>}
        <p id="setupErr" class="err" role="alert">{layout.error || error}</p>
        <button id="btnMake" class="primary create-match" disabled={!layout.config} onClick={() => {
          if (layout.config) onMatch(Match.fromConfig(layout.config));
        }}>Create match</button>
      </section>
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

function lobbyStatus(v: SessionView): string {
  if (v.status === 'failed' || v.status === 'offline') return 'Could not connect. Reopen the match link to try again.';
  if (v.phase === 'connecting') return 'Connecting…';
  if (v.phase === 'electing') return 'Choosing a host…';
  if (v.phase === 'mismatch') return 'Snapshots differ. Everyone needs to open the same chosen resume link.';
  if (v.phase === 'full') return 'Match full. All seats are occupied.';
  if (v.phase === 'agreeing') return 'Confirming the roster and saved game…';
  const missing = v.seats.filter((s) => !s.present).length;
  if (missing) return 'Waiting for ' + plural(missing, 'player') + '. Share the link to fill the remaining seats.';
  return 'Waiting for everyone to be ready.';
}

function Lobby({ session, view, link, onNew, name, setName }: {
  session: Session; view: SessionView; link: string; onNew: () => void;
  name: string | null; setName: (name: string) => void;
}) {
  const [notice, setNotice] = useState('');
  const v = view, local = v.seats.find((s) => s.isLocal);
  const historical = v.started;
  const typed = name ?? local?.name ?? '';
  const badName = !historical && !NAME_RE.test(typed.trim());
  const preview: BoardPreviewData = { w: v.w, h: v.h, roster: v.roster, walls: v.walls, spawns: v.spawns,
    center: v.center, keyAtCenter: v.mode === 'bootstrap' };
  return <section id="pickCard" class="card lobby-card">
    <div class="lobby-head">
      <div><h2>{historical ? 'Resume the match' : 'Your lobby'}</h2>
        <p class="sec">{historical ? 'Choose an available historical seat, then ready up.' : 'Your colour and spawn are assigned. Set your name, then ready up.'}</p></div>
      <div class="lobby-actions">
        <CopyButton id={v.phase === 'mismatch' ? 'btnCopyResume' : 'btnCopyJoin'} value={link}
          label={v.phase === 'mismatch' ? 'Copy my resume link' : historical ? 'Copy resume link' : 'Copy join link'} />
        <button id="btnNewLobby" onClick={onNew}>New match</button>
      </div>
    </div>
    <div class="lobby-grid">
      <div class="lobby-preview"><BoardPreview board={preview} label="Board layout and fixed spawns" />
        <p class="preview-summary">{v.w} × {v.h} · {v.walls.length} walls · <span class="mono">seed {v.seed}</span><br />
          {historical ? 'Saved turn ' + v.turn : 'Colours start at the marked corners.'}</p>
      </div>
      <div>
        <ul id="pickRows" class="lobby-roster" aria-label="Players">
          {v.seats.map((seat) => <li key={seat.color} data-color={seat.color} class={'lobby-seat' + (seat.isLocal ? ' local' : '')}>
            <div class="seat-heading"><Swatch color={seat.color} /><strong>{COLORS[seat.color].name}</strong>
              <span class="seat-tags">{[seat.isLocal ? 'you' : '', seat.isHost ? 'host' : ''].filter(Boolean).join(' · ')}</span></div>
            <div class="seat-spawn mono">spawn ({v.spawns[seat.color]?.join(', ')})</div>
            {seat.isLocal && !historical ? <label class="seat-name" for="pickName">Name
              <input id="pickName" maxLength={12} disabled={!v.canEditName} value={typed} aria-invalid={badName} aria-describedby="nameErr"
                onInput={(e) => {
                  const text = e.currentTarget.value; setName(text); setNotice('');
                  if (NAME_RE.test(text.trim())) {
                    const result = session.join(text.trim()); if (!result.ok) setNotice(result.error ?? 'Could not update name.');
                  } else session.ready(false);
                }} />
            </label> : <div class="seat-name">{seat.name || 'Waiting for a player'}</div>}
            <div class={'seat-status' + (seat.ready ? ' ready' : '')}>{seat.present ? seat.ready ? 'Ready' : 'Not ready' : historical ? 'Disconnected · seat available' : 'Open seat'}</div>
            {seat.canClaim && <button class="claim-seat" onClick={() => {
              const r = session.requestSeat(seat.color); setNotice(r.error ?? '');
            }}>Claim {COLORS[seat.color].name}</button>}
          </li>)}
        </ul>
        {local && !historical && <p id="nameErr" class="err" role="alert">{badName ? 'Use 1–12 letters, digits, hyphens, or underscores.' : ''}</p>}
        <p id="pickWait" class="lobby-status" role="status">{lobbyStatus(v)}</p>
        <p id="pickErr" class="err" role="alert">{notice || v.error || v.notice || v.detail || ''}</p>
        {local && v.phase !== 'mismatch' && <button id="btnReady" class="primary ready-button" disabled={!v.canReady || badName}
          aria-pressed={local.ready} onClick={() => { const r = session.ready(!local.ready); setNotice(r.error ?? ''); }}>
          {local.ready ? 'Not ready' : 'Ready'}
        </button>}
        {v.hostId === v.localId && !local && <p class="sec">You are hosting. You can choose any available seat.</p>}
      </div>
    </div>
  </section>;
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

function netState(v: SessionView): 'good' | 'warn' | 'bad' {
  if (v.status === 'offline' || v.status === 'failed') return 'bad';
  if (v.status !== 'live' || v.peersNeeded) return 'warn';
  return 'good';
}

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

const NARROW = '(max-width:1120px)';
const HISTORY_PRESETS = [0, 2, 4];

// Below this width the rails cannot fit beside the board, so they stay folded.
function useNarrow(): boolean {
  const [narrow, setNarrow] = useState(
    () => typeof matchMedia === 'function' && matchMedia(NARROW).matches
  );
  useEffect(() => {
    if (typeof matchMedia !== 'function') return;
    const q = matchMedia(NARROW);
    const on = (): void => { setNarrow(q.matches); };
    q.addEventListener('change', on);
    on();
    return () => { q.removeEventListener('change', on); };
  }, []);
  return narrow;
}

function dotFloor(): number {
  return parseFloat(getComputedStyle(document.documentElement)
    .getPropertyValue('--dot-floor')) || 0.14;
}

function Dots({ view }: { view: SessionView }) {
  const order = view.priority.length ? view.priority : view.roster;
  const still = view.uncommitted.map((c) => c === view.me.color ? 'You' : nameOf(view, c));
  const text = 'Priority this turn: ' + order.map((c) => nameOf(view, c)).join(' › ') + '.'
    + (still.length ? ' Still choosing: ' + still.join(', ') + '.' : ' All actions are in.');
  return (
    <div id="pending" class="dots" title={text} aria-label={text}>
      {order.map((c) => (
        <i
          key={c} class="pdot" data-color={c}
          data-state={view.uncommitted.includes(c) ? 'choosing' : 'done'}
          style={{ background: COLORS[c].hex }}
        />
      ))}
    </div>
  );
}

function Toasts({ view }: { view: SessionView }) {
  const recent = view.events.slice(-3).reverse();
  if (!recent.length) return null;
  return (
    <div class="toasts" id="toasts">
      {recent.map((e, i) => (
        <div
          key={e.turn + ':' + e.color + ':' + i}
          class={'toast' + (i ? ' a' + (i + 1) : '')}
          style={{ borderLeftColor: COLORS[e.color].hex }}
        >
          <span class="m">t{e.turn}</span>
          <span><strong>{nameOf(view, e.color)}</strong> {eventText(view, e)}</span>
        </div>
      ))}
    </div>
  );
}

function LegendPopover({ view }: { view: SessionView }) {
  return (
    <div class="legwrap">
      <button class="legbtn" id="btnLegend" title="Legend" aria-label="Legend">?</button>
      <div class="legpop" id="legpop">
        <div class="legtitle">Legend</div>
        <Legend view={view} />
        <div class="keyhint">
          Arrows or WASD: choose. Enter or Space: commit. Esc: clear. Turn around has no shortcut.
        </div>
      </div>
    </div>
  );
}

const MIN_IW = 320;

function TimelineInstrument({ view, focusT, lookBack }: {
  view: SessionView; focusT: number; lookBack: number;
}) {
  const box = useRef<HTMLDivElement | null>(null);
  const [width, setWidth] = useState(0);

  // Measure CSS pixels to keep chart text at a fixed size.
  useLayoutEffect(() => {
    const el = box.current;
    if (!el) return;
    setWidth(el.clientWidth);
    const ro = new ResizeObserver(() => { setWidth(el.clientWidth); });
    ro.observe(el);
    return () => { ro.disconnect(); };
  }, []);

  return (
    <div id="instrument" ref={box}>
      {width >= MIN_IW && (
        <InstrumentSvg view={view} focusT={focusT} lookBack={lookBack} width={width} />
      )}
    </div>
  );
}

const TICK = 'font-family:var(--mono);font-size:10px;pointer-events:none;';
const ROW_LABEL = 'font-size:11px;fill:var(--text-primary);pointer-events:none;';
const ROW_SUB = 'font-family:var(--mono);font-size:9.5px;fill:var(--text-muted);pointer-events:none;';

function InstrumentSvg({ view, focusT, lookBack, width }: {
  view: SessionView; focusT: number; lookBack: number; width: number;
}) {
  const { height: H, cap, colW, x, ticks, fog, left, right, top, bottom, rows } =
    instrumentAt(view, width);
  const focus = Math.min(Math.max(0, focusT), cap);
  const lo = Math.max(0, focus - Math.max(0, lookBack));

  return (
    <svg width={width} height={H} viewBox={`0 0 ${width} ${H}`} role="img"
      aria-label={"Every player's bodies across world turns t0 to t" + cap}>
      <defs>
        <pattern id="tl-fog" width="8" height="8" patternUnits="userSpaceOnUse"
          patternTransform="rotate(45)">
          <rect width="8" height="8" fill="var(--surface-1)" />
          <rect width="1.5" height="8" fill="var(--border)" />
        </pattern>
        {/* Names are player-supplied, so the label block is clipped to its gutter. */}
        <clipPath id="tl-gutter">
          <rect x="0" y="0" width={left - 5} height={H} />
        </clipPath>
      </defs>

      <rect x={x(lo) - colW / 2} y={top} width={colW * (focus - lo + 1)} height={bottom - top}
        fill="var(--text-secondary)" opacity="0.07" />
      <rect x={x(focus) - colW / 2} y={top} width={Math.max(colW, 2)} height={bottom - top}
        fill="var(--accent-br)" opacity="0.16" />
      {fog && (
        <rect x={fog.x} y={top} width={fog.w} height={bottom - top} rx="3" fill="url(#tl-fog)">
          <title>{'unexplored · t' + fog.from + ' … t' + fog.to}</title>
        </rect>
      )}

      {ticks.map((t) => (
        <g key={t}>
          <line x1={x(t)} x2={x(t)} y1={top} y2={bottom} stroke="var(--border)" opacity="0.5" />
          <text x={x(t)} y={H - 8} text-anchor="middle"
            style={TICK + 'fill:' + (t === focus ? 'var(--text-primary)' : 'var(--text-muted)')}>
            t{t}
          </text>
        </g>
      ))}
      <line x1={right} x2={right} y1={top} y2={bottom}
        stroke="var(--bad-br)" stroke-width="2" />
      <text x={right - 4} y={H - 8} text-anchor="end"
        style={TICK + 'fill:var(--text-secondary)'}>cap {cap}</text>

      {rows.map((r, i) => {
        const hex = COLORS[r.color].hex;
        const rowTop = r.top;
        const laneY = r.laneY;
        const lastLeg = r.legs[r.legs.length - 1];
        // Past your horizon a player has no live body, so the newest one you can see stands in.
        const newest = r.live ?? lastLeg?.bodies[lastLeg.bodies.length - 1] ?? null;
        const live = r.live;
        const liveY = laneY(r.legs.find((leg) => live && leg.bodies.includes(live))?.lane ?? 0);
        const matching = live?.dir === view.me.dir;
        return (
          <g key={r.color}>
            {i > 0 && (
              <line x1={left} x2={right} y1={rowTop - 3} y2={rowTop - 3}
                stroke="var(--border)" />
            )}
            <g clip-path="url(#tl-gutter)">
              <circle cx="8" cy={laneY(0) - 4} r="4.5" fill={hex} />
              <text x="18" y={laneY(0)}
                style={ROW_LABEL + (r.color === view.me.color ? 'font-weight:600;' : '')}>
                {nameOf(view, r.color)}
              </text>
              {newest && (
                <text x="3" y={laneY(0) + 14} style={ROW_SUB + (r.live ? '' : 'opacity:.45;')}>
                  {'p' + newest.p + ' · ' + (newest.dir === 1 ? 'fwd' : 'back')}
                  <title>{describe(view, newest)}</title>
                </text>
              )}
              {r.scrolledOff > 0 && (
                <text x="3" y={laneY(0) + 26} style={ROW_SUB + 'fill:var(--text-secondary);'}>
                  {'+' + r.scrolledOff + ' earlier'}
                  <title>
                    {nameOf(view, r.color) + ': '
                      + plural(r.scrolledOff, 'earlier leg') + ' above this window'}
                  </title>
                </text>
              )}
            </g>

            {r.legs.map((leg, j) => {
              const ly = laneY(leg.lane);
              const first = leg.bodies[0]!;
              const last = leg.bodies[leg.bodies.length - 1]!;
              const back = last.t < first.t ? -1 : 1;
              const mx = x((first.t + last.t) / 2);
              const fade = j === r.legs.length - 1 ? 1 : 0.55;
              const prev = j > 0 ? r.legs[j - 1]! : null;
              const from = prev ? laneY(prev.lane) : ly;
              const prevLast = prev?.bodies[prev.bodies.length - 1];
              const stub = Math.min(26, colW * 0.5);
              return (
                <g key={j}>
                  {leg.bodies.length > 1 ? (
                    <polyline
                      points={leg.bodies.map((b) => x(b.t) + ',' + ly).join(' ')}
                      fill="none" stroke={hex} stroke-width="2.5"
                      stroke-linejoin="round" stroke-linecap="round" opacity={fade}
                    />
                  ) : (
                    <line x1={x(first.t) - 7} x2={x(first.t) + 7} y1={ly} y2={ly}
                      stroke={hex} stroke-width="2.5" stroke-linecap="round" opacity={fade} />
                  )}
                  {leg.brokenBefore ? (
                    // The unseen inversion joins these legs beyond the hatch.
                    <g stroke={hex} stroke-width="2.5" stroke-dasharray="3 4"
                      stroke-linecap="round" opacity={Math.min(fade, 0.7)}>
                      {prevLast && (
                        <line x1={x(prevLast.t) + 4} x2={x(prevLast.t) + 4 + stub}
                          y1={from} y2={from} />
                      )}
                      <line x1={x(first.t) + 4} x2={x(first.t) + 4 + stub} y1={ly} y2={ly} />
                    </g>
                  ) : prev ? (
                    // Fold away from the new heading to join bodies at the same world turn.
                    <path
                      d={`M${x(first.t) + (first.dir === 1 ? -6 : 6)},${from}`
                        + `a6,${(ly - from) / 2} 0 0 1 0,${ly - from}`}
                      fill="none" stroke={hex} stroke-width="2.5" opacity={fade}
                    />
                  ) : null}
                  {leg.bodies.length > 1 && (
                    <path d={`M${mx - 4 * back},${ly - 4} l${4 * back},4 l${-4 * back},4`}
                      fill="none" stroke={hex} stroke-width="2" />
                  )}
                  {leg.bodies.map((b) => {
                    const fill = relativeDirection(view, b) === 'matching' ? hex : 'var(--surface-1)';
                    if (b.live) return null;
                    return (
                      <g key={b.p}>
                        <circle cx={x(b.t)} cy={ly} r="3.5" fill={fill} stroke={hex} stroke-width="1.5">
                          <title>{describe(view, b)}</title>
                        </circle>
                        {b.p % 4 === 0 && (
                          <text x={x(b.t)} y={ly - 7} text-anchor="middle"
                            style={TICK + 'font-size:8px;fill:var(--text-muted)'}>{b.p}</text>
                        )}
                      </g>
                    );
                  })}
                </g>
              );
            })}

            {live && (
              <g>
                <circle cx={x(live.t)} cy={liveY} r="7"
                  fill={matching ? hex : 'var(--surface-1)'} stroke={hex} stroke-width="2.5">
                  <title>{describe(view, live)}</title>
                </circle>
                <text x={x(live.t)} y={liveY + 3.5} text-anchor="middle"
                  style={TICK + 'font-size:8.5px;font-weight:600;fill:'
                    + (matching ? COLORS[r.color].ink : 'var(--text-primary)')}>
                  {live.p}
                </text>
              </g>
            )}
          </g>
        );
      })}
    </svg>
  );
}

type PlayProps = {
  session: Session; view: SessionView; link: string; onNew: () => void;
  theme: Theme; onTheme: () => void;
};

function PlayScreen({ session, view, link, onNew, theme, onTheme }: PlayProps) {
  const v = view;

  const [pick, setPick] = useState<Action | null>(null);
  const [busy, setBusy] = useState(false);
  const [pickMsg, setPickMsg] = useState('');
  const [shareMsg, setShareMsg] = useState('');
  const [scrub, setScrub] = useState<{ turn: number; t: number } | null>(null);
  const maxBack = maxLookBack(v.cap);
  const [lookBack, setLookBack] = useState<number | null>(null);
  const [logOpen, setLogOpen] = useState(true);
  const [moveOpen, setMoveOpen] = useState(true);
  const [raised, setRaised] = useState(false);
  const narrow = useNarrow();

  const back = Math.min(lookBack ?? maxBack, maxBack);
  const focusT = Math.min(scrub && scrub.turn === v.turn ? scrub.t : v.me.t, v.me.horizon);
  const done = committed(v);
  const over = v.outcome.status !== 'running';
  const reasons = reasonsOf(v);
  const choosing = v.canCommit && !over && !done;
  const showLog = logOpen && !narrow;
  const showMove = moveOpen && !narrow;

  // The play screen owns the viewport, so the page shell's padding comes off.
  useEffect(() => {
    document.body.classList.add('playing');
    return () => { document.body.classList.remove('playing'); };
  }, []);

  useLayoutEffect(() => {
    if (!raised) return;
    const drop = (): void => { setRaised(false); };
    window.addEventListener('pointerup', drop);
    window.addEventListener('pointercancel', drop);
    return () => {
      window.removeEventListener('pointerup', drop);
      window.removeEventListener('pointercancel', drop);
    };
  }, [raised]);

  const names = v.roster.map((c) => v.names[c] ?? '').join(',');
  const scene = useMemo(
    () => sceneAt(v, focusT, back, choosing, dotFloor()),
    [v.hash, v.me.color, focusT, back, choosing, theme, names]
  );
  const resolved = useMemo(
    () => v.events.filter((e) => e.turn === v.turn - 1),
    [v.hash, v.turn]
  );

  // Prefer hold, then invert, so Commit always names a legal action.
  const active: Action | null = !choosing ? null
    : pick && legalNow(v, pick) ? pick
      : legalNow(v, 'H') ? 'H' : legalNow(v, 'I') ? 'I' : null;

  const aim = useCallback((a: Action) => {
    if (!v.canCommit || over || done || !legalNow(v, a)) return;
    setPick(a);
  }, [v, done]);

  const commit = useCallback(async () => {
    if (!v.canCommit || !active || busy) return;
    setBusy(true);
    const r = await session.commit(active);
    setBusy(false);
    if (!r.ok) { setPickMsg(r.error ?? 'commit failed'); return; }
    setPickMsg('');
    setShareMsg('');
    setPick(null);
  }, [session, active, busy, v.canCommit]);

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
  const threat = v.fronts.find((f) => f.target === v.me.color);
  const presets = [...new Set([...HISTORY_PRESETS, maxBack].filter((n) => n <= maxBack))]
    .sort((a, b) => a - b);

  function padButton(
    a: Action, face: string, sub: string | null, hint: string, id?: string, style?: string
  ) {
    const reason = reasons[a];
    return (
      <button
        id={id}
        data-act={a}
        style={style}
        disabled={!v.canCommit || reason !== null}
        title={reason || hint}
        class={active === a ? 'sel' : ''}
        onClick={() => { aim(a); }}
      >
        {face}{sub === null ? null : <small>{sub}</small>}
      </button>
    );
  }

  const movePanel = (
    <Fragment>
      <div id="phasePick" class={over || done ? 'hide' : ''}>
        <h3>{v.pauseReason === 'checkpoint' ? 'Confirming the completed turn…' : 'Your move'}</h3>
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
        <button id="btnCommit" class="primary" style="width:100%;margin-top:10px;" disabled={!active || busy} onClick={() => { void commit(); }}>
          {active ? 'Commit ' + LABEL[active] : 'Commit'}
        </button>
        <div id="pickMsg">{pickMsg && <div class="err">{pickMsg}</div>}</div>
      </div>

      <div id="phaseShare" class={over || !done ? 'hide' : ''}>
        <h3>Action locked in</h3>
        <button id="btnUndo" class={v.canChange ? '' : 'hide'} onClick={undo}>Change my action</button>
        <div id="keyUndo" class={v.canChange ? 'keyhint' : 'keyhint hide'}>Esc also changes it.</div>
        <div id="shareMsg">{shareMsg && <div class="err">{shareMsg}</div>}</div>
      </div>

      <div id="phaseOver" class={over ? '' : 'hide'}>
        <h3>{outcomeText(v)}</h3>
        <div class="hint">Use World turn to review the match.</div>
      </div>

      {!over && <Dots view={v} />}
      <CopyButton id="btnCopyPlay" value={link} label="Copy resume link" />
      <div class="err" id="netErr">{v.error || v.notice || ''}</div>
    </Fragment>
  );

  return (
    <div id="play" class="play">
      <div class="hud">
        <strong id="youAre">
          <span class="pill" style={{ background: c.hex, color: c.ink }}>{nameOf(v, v.me.color)}</span>
        </strong>
        <span id="youAt" class="mono">
          index {v.me.p} · t{v.me.t} · {v.me.dir === 1 ? 'forward' : 'backward'} · ({v.me.x},{v.me.y})
        </span>
        {threat && (
          <span class="warnchip" id="frontChip" title={frontText(v, threat)}>
            <i class="tri" style={{ '--front-color': COLORS[threat.color].hex }} />
            {frontText(v, threat)}
          </span>
        )}
        <span class="spacer" />
        <span class="mono" id="turnInfo">
          {over ? outcomeText(v) + ' at turn ' + v.turn : 'turn ' + v.turn + ' / ' + v.cap}
        </span>
        <span class="mono" id="netInfo">
          <i class="dot" data-state={netState(v)} />
          {net
            + (v.peersNeeded ? ' · waiting for ' + plural(v.peersNeeded, 'player') : '')
            + (v.status === 'live' ? ' · ' + plural(v.peers.length, 'other player') : '')
            + (v.detail ? ' · ' + v.detail : '')}
        </span>
        <span class="mono" id="hashInfo">state {v.hash}</span>
        <button id="btnTheme" title="Switch between dark and light" onClick={onTheme}>
          {theme === 'light' ? 'Dark' : 'Light'}
        </button>
        <button id="btnNewPlay" onClick={onNew}>New match</button>
      </div>

      <div
        class="band"
        style={{ gridTemplateColumns: (showLog ? '232px' : '52px') + ' 1fr ' + (showMove ? '296px' : '52px') }}
      >
        {showLog ? (
          <div class="lrail" id="logRail">
            <div class="railhead">
              <span class="grow">Log</span>
              <button class="icobtn" id="btnLogFold" title="Fold the log" onClick={() => { setLogOpen(false); }}>&#8592;</button>
            </div>
            <Log view={v} />
          </div>
        ) : (
          <div class="icostrip" id="logStrip">
            <button
              class="icobtn" id="btnLogOpen" title="Open the log" disabled={narrow}
              onClick={() => { setLogOpen(true); }}
            >&#8594;</button>
            <span class="vlabel">{'LOG · ' + plural(v.events.length, 'event')}</span>
          </div>
        )}

        <div class="stagearea">
          {!showLog && <Toasts view={v} />}
          <div class="boardframe">
            <Board
              view={v} scene={scene} turn={v.turn} events={resolved}
              picked={active} onPick={choosing ? aim : null}
            />
          </div>
        </div>

        {showMove ? (
          <div class="rrail" id="moveRail">
            <div class="railhead">
              <span class="grow">Actions</span>
              <button class="icobtn" id="btnMoveFold" title="Fold the actions" onClick={() => { setMoveOpen(false); }}>&#8594;</button>
            </div>
            <div class="railbody">{movePanel}</div>
          </div>
        ) : (
          <div class="icostrip right" id="moveStrip">
            <button
              class="icobtn" id="btnMoveOpen" title="Open the actions" disabled={narrow}
              onClick={() => { setMoveOpen(true); }}
            >&#8592;</button>
            <button
              class="icobtn" id="btnUndoStrip" disabled={over || !done || !v.canChange}
              title="Change my action" onClick={undo}
            >&#8635;</button>
            <button
              class="icobtn primary" id="btnCommitStrip" disabled={!active || busy || over || done}
              title={active ? 'Commit ' + LABEL[active] : 'Commit'}
              onClick={() => { void commit(); }}
            >&#10003;</button>
            {!over && <Dots view={v} />}
            {!over && (
              <span class="vlabel">
                {v.uncommitted.length ? v.uncommitted.length + ' still choosing' : 'all actions in'}
              </span>
            )}
          </div>
        )}

        {raised && <div class="scrim" id="scrim" />}
      </div>

      <div class="dock">
        {raised && <TimelineInstrument view={v} focusT={focusT} lookBack={back} />}
        <Strip view={v} focusT={focusT} lookBack={back} />
        <div class="dockrow">
          <LegendPopover view={v} />
          <label class="docklabel" for="sl">world turn</label>
          <input
            type="range" id="sl" min={0} max={v.me.horizon} value={focusT} step={1}
            style={{ flex: 1, '--fill': (v.me.horizon ? focusT * 100 / v.me.horizon : 0) + '%' }}
            onPointerDown={() => { setRaised(true); }}
            onInput={(e) => { setScrub({ turn: v.turn, t: +e.currentTarget.value }); }}
          />
          <span class="docklabel" id="slo" style="color:var(--text-primary);">t{focusT}</span>
          <span class="docklabel">history</span>
          <div class="seg" id="rd">
            {presets.map((n) => (
              <button
                key={n} data-back={n} class={n === back ? 'on' : ''}
                aria-pressed={n === back}
                onClick={() => { setLookBack(n); }}
              >{n}</button>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

type LinkKind = 'join' | 'resume';
type Live = {
  session: Session; code: string;
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
  const [name, setName] = useState<string | null>(null);
  const [, setTick] = useState(0);
  const redraw = useCallback(() => { setTick((n) => n + 1); }, []);

  const openMatch = useCallback((m: Match, imported: Names = {}, entry: 'create' | LinkKind = 'create') => {
    const code = Wire.encodeMatchCode(m.config());
    liveRef.current?.session.close();
    replaceLink(entry === 'resume' ? 'resume' : 'join', entry === 'resume' ? trimUnresolved(m.export(imported)) : code);
    const channel = PeerChannel(Code.roomId(code), loadRoom);
    const session = Session.open({ match: m, channel, names: imported, entry, onChange: redraw });
    const next = { session, code };
    liveRef.current = next; setLive(next); setName(null); setSetupError('');
    if (entry !== 'resume') session.join('Player');
  }, [loadRoom, redraw]);

  useEffect(() => {
    if (startup.match && startup.kind) openMatch(startup.match, startup.names, startup.kind);
  }, [startup, openMatch]);
  useEffect(() => () => { liveRef.current?.session.close(); }, []);

  const view = live?.session.view() ?? null;
  useLayoutEffect(() => {
    if (live && view?.localColor && !view.started && name === null) {
      const initialName = COLORS[view.localColor].name;
      setName(initialName); live.session.join(initialName);
    }
  }, [live, view?.localColor, view?.started, name]);
  const showPlay = !!view?.localColor && ['playing', 'paused', 'ended'].includes(view.phase);
  const linkKind: LinkKind = view?.started || view?.phase === 'mismatch' ? 'resume' : 'join';
  const payload = live ? linkKind === 'resume' ? live.session.export() : live.code : '';
  const url = new URL(window.location.href);
  if (live) url.hash = linkKind + '=' + encodeURIComponent(payload);
  const link = url.href;
  useEffect(() => { if (live && window.location.href !== link) replaceLink(linkKind, payload); }, [live, linkKind, payload, link]);

  function newMatch(): void {
    if (view?.started && !window.confirm('Start a new match? The current match will be left.')) return;
    liveRef.current?.session.close(); liveRef.current = null; setLive(null);
    setName(null); setSetupError(''); setSetupKey((n) => n + 1); clearLink();
  }
  function toggleTheme(): void {
    const next: Theme = theme === 'light' ? 'dark' : 'light'; applyTheme(next); setTheme(next);
  }
  if (showPlay && live && view) return <PlayScreen session={live.session} view={view} link={link}
    onNew={newMatch} theme={theme} onTheme={toggleTheme} />;

  return <div class="wrap intro-wrap">
    <header class="intro-header"><div><h1>Time travel tactics</h1><p class="sub">Every move leaves a history.</p></div>
      <button id="btnTheme" title="Switch between dark and light" onClick={toggleTheme}>{theme === 'light' ? 'Dark' : 'Light'}</button></header>
    <main id="setup">
      {!live && <SetupCard key={setupKey} initialError={setupError} onMatch={(m) => openMatch(m)} />}
      {live && view && <Lobby session={live.session} view={view} link={link} onNew={newMatch} name={name} setName={setName} />}
    </main>
  </div>;
}
