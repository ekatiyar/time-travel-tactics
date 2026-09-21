import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'preact/hooks';
import { Fragment } from 'preact';

import { COLORS, Match, Wire } from './engine/index.js';
import type { Action, Color, ConfigInput, TurnEvent, ViewBody } from './engine/index.js';
import { Board } from './board.js';
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
// Every row carries the unexplored slot, explored or not, so one column width serves all four.
// Without it the bars compress and the numbers below drift out of line.
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
            {/* The dash rides on a child: a border on the flex item itself lands outside its
                basis and pushes this row's last column 2px wide of the others. */}
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

// Below this the chart is unreadable whatever we do, so it draws nothing.
const MIN_IW = 320;

function TimelineInstrument({ view, focusT, lookBack }: {
  view: SessionView; focusT: number; lookBack: number;
}) {
  const box = useRef<HTMLDivElement | null>(null);
  const [width, setWidth] = useState(0);

  // The chart draws in CSS pixels so its type keeps one size however many lanes the rows need,
  // which means it has to be told how wide it is.
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
  const { height: H, cap, colW, x, ticks, fog, capX, left, right, top, bottom, rows } =
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
      <line x1={capX} x2={capX} y1={top} y2={bottom}
        stroke="var(--bad-br)" stroke-width="2" />
      <text x={capX - 4} y={H - 8} text-anchor="end"
        style={TICK + 'fill:var(--text-secondary)'}>cap {cap}</text>

      {rows.map((r, i) => {
        const hex = COLORS[r.color].hex;
        const rowTop = r.top;
        const laneY = r.laneY;
        const lastLeg = r.legs[r.legs.length - 1];
        // Past your horizon a player has no live body, so the newest one you can see stands in.
        const newest = r.live ?? lastLeg?.bodies[lastLeg.bodies.length - 1] ?? null;
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
                // No live body means the index and the direction are both last-seen, so one fade
                // marks the whole readout stale.
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
                    // The two legs meet at an inversion past your horizon, not here. Fray the
                    // visible ends toward the hatch and draw no fold. The previous leg may have
                    // scrolled off; this one frays either way.
                    <g stroke={hex} stroke-width="2.5" stroke-dasharray="3 4"
                      stroke-linecap="round" opacity={Math.min(fade, 0.7)}>
                      {prevLast && (
                        <line x1={x(prevLast.t) + 4} x2={x(prevLast.t) + 4 + stub}
                          y1={from} y2={from} />
                      )}
                      <line x1={x(first.t) + 4} x2={x(first.t) + 4 + stub} y1={ly} y2={ly} />
                    </g>
                  ) : prev ? (
                    // An inversion lands on the world turn it left from, so without this the two
                    // legs are loose dots in one column. The arc folds away from the new heading.
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

            {r.live && (() => {
              const b = r.live;
              const lane = r.legs.find((l) => l.bodies.includes(b))?.lane ?? 0;
              const matching = relativeDirection(view, b) === 'matching';
              return (
                <g>
                  <circle cx={x(b.t)} cy={laneY(lane)} r="7"
                    fill={matching ? hex : 'var(--surface-1)'} stroke={hex} stroke-width="2.5">
                    <title>{describe(view, b)}</title>
                  </circle>
                  <text x={x(b.t)} y={laneY(lane) + 3.5} text-anchor="middle"
                    style={TICK + 'font-size:8.5px;font-weight:600;fill:'
                      + (matching ? COLORS[r.color].ink : 'var(--text-primary)')}>
                    {b.p}
                  </text>
                </g>
              );
            })()}
          </g>
        );
      })}
    </svg>
  );
}

type PlayProps = {
  session: Session; view: SessionView; onNew: () => void;
  theme: Theme; onTheme: () => void;
};

function PlayScreen({ session, view, onNew, theme, onTheme }: PlayProps) {
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
  const choosing = !over && !done;
  const showLog = logOpen && !narrow;
  const showMove = moveOpen && !narrow;

  // The play screen owns the viewport, so the page shell's padding comes off.
  useEffect(() => {
    document.body.classList.add('playing');
    return () => { document.body.classList.remove('playing'); };
  }, []);

  useEffect(() => {
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
  const sceneKey = v.hash + '|' + v.me.color + '|' + focusT + '|' + back + '|' + choosing + '|' + theme + '|' + names;
  const scene = useMemo(
    () => sceneAt(v, focusT, back, choosing, dotFloor()),
    [sceneKey]
  );
  const resolved = useMemo(
    () => v.events.filter((e) => e.turn === v.turn - 1),
    [v.hash, v.turn]
  );

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
        disabled={reason !== null}
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
        <h3>Your move</h3>
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

  function toggleTheme(): void {
    const next: Theme = theme === 'light' ? 'dark' : 'light';
    applyTheme(next);
    setTheme(next);
  }

  if (showPlay && live && view) {
    return (
      <PlayScreen
        session={live.session} view={view} onNew={newMatch}
        theme={theme} onTheme={toggleTheme}
      />
    );
  }

  return (
    <div class="wrap">
      <div style="display:flex;justify-content:space-between;align-items:flex-start;gap:16px;">
        <div>
          <h1>Time travel tactics</h1>
          <p class="sub">A multiplayer time-travel tactics prototype.</p>
        </div>
        <button id="btnTheme" title="Switch between dark and light" onClick={toggleTheme}>
          {theme === 'light' ? 'Dark' : 'Light'}
        </button>
      </div>

      <div id="setup" class="narrow">
        {!live && <SetupCard key={setupKey} initialError={setupError} onMatch={(m) => { openMatch(m); }} />}
        {live && view && (
          <PickCard
            link={live.link} view={view}
            name={name} setName={setName}
            chosen={chosen} setChosen={setChosen} onSit={sit} onNew={newMatch}
          />
        )}
      </div>
    </div>
  );
}
