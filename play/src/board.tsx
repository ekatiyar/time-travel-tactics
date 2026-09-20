import { useLayoutEffect, useRef } from 'preact/hooks';
import type { JSX } from 'preact';

import { COLORS } from './engine/index.js';
import type { Action, ActionOffer, Color, TurnEvent, ViewBody } from './engine/index.js';
import { describe, motionBetween, relativeDirection } from './scene.js';
import type { Motion, NamedView, Scene, SceneFront, Stack } from './scene.js';

const MOTION_MS = 1200;

const tile = (x: number, y: number): string => x + ',' + y;

function reducedMotion(): boolean {
  return typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
}

// The key mark animates on its own channel. Grabbing or losing a key while also moving or being
// blocked is the normal case, and one attribute per slot would let the first motion win and drop
// the key animation.
const channelOf = (kind: Motion['kind']): 'motion' | 'keyMotion' => (
  kind === 'grab' || kind === 'lost' ? 'keyMotion' : 'motion'
);

function reset(el: HTMLElement): void {
  delete el.dataset.motion;
  delete el.dataset.keyMotion;
}

// Land any running transition on its end position now, and leave transitions armed for the next
// commit. A requestAnimationFrame is too late: the input that ends a motion also drives a Preact
// re-render, which commits the next positions synchronously in the same task and lands them with
// transitions still off.
function settle(layer: HTMLElement): void {
  layer.classList.add('snap');
  void layer.offsetHeight;
  layer.classList.remove('snap');
  void layer.offsetHeight;
}

// Motion attributes land after the new positions are committed, so the slide is already under way.
function useMotions(
  root: { current: HTMLDivElement | null },
  scene: Scene, turn: number, events: readonly TurnEvent[]
): void {
  const prev = useRef<Scene | null>(null);
  const prevTurn = useRef(turn);
  const timer = useRef<number | null>(null);
  const until = useRef(0);

  useLayoutEffect(() => {
    const layer = root.current;
    const before = prev.current;
    // Events belong to the turn that just resolved; a scrub has none to read.
    const resolved = turn !== prevTurn.current ? events : [];
    prev.current = scene;
    prevTurn.current = turn;
    if (!layer) return;

    const slots = layer.querySelectorAll<HTMLElement>('.tokslot');
    // A resolved turn plays as mockup 07's sequence; a scrub is one motion and starts now.
    // Set before paint so the delays apply to the transitions this commit just started.
    const stage = (on: boolean): void => {
      for (const el of slots) reset(el);
      layer.classList.toggle('staged', on);
    };

    function detach(): void {
      if (timer.current !== null) { clearTimeout(timer.current); timer.current = null; }
      document.removeEventListener('keydown', clear, true);
      document.removeEventListener('pointerdown', clear, true);
    }
    function clear(): void {
      until.current = 0;
      for (const el of layer!.querySelectorAll<HTMLElement>('.tokslot')) reset(el);
      // Dropping the attribute ends the keyframes; the slide is a transition and needs a nudge.
      settle(layer!);
      detach();
    }
    // Any input skips to the end.
    function arm(ms: number): () => void {
      document.addEventListener('keydown', clear, true);
      document.addEventListener('pointerdown', clear, true);
      timer.current = window.setTimeout(clear, ms);
      // Teardown only detaches: clearing here would reflow the committed positions with
      // transitions off and kill the slide the next effect is about to start.
      return detach;
    }

    if (!before || reducedMotion()) { stage(resolved.length > 0); return; }

    // A jump of more than one world turn has no motion to read, so it snaps.
    if (Math.abs(scene.focusT - before.focusT) > 1) {
      until.current = 0;
      stage(false);
      settle(layer);
      return;
    }

    const motions = motionBetween(before, scene, resolved);
    // Nothing new to start: committing an action flips `choosing`, which rebuilds the scene
    // without moving anything, so resetting here would cut a running sequence off partway.
    const left = until.current - performance.now();
    if (!motions.length && left > 0) return arm(left);

    stage(resolved.length > 0);
    if (!motions.length) return;

    const byKey = new Map<string, HTMLElement>();
    for (const el of slots) {
      const k = el.dataset.key;
      if (k) byKey.set(k, el);
    }

    for (const m of motions) {
      const el = byKey.get(m.key);
      const channel = channelOf(m.kind);
      if (!el || el.dataset[channel]) continue;
      if (m.kind === 'bounce') {
        const at = el.dataset.tile!.split(',');
        el.style.setProperty('--dx', String(m.toward[0] - Number(at[0])));
        el.style.setProperty('--dy', String(m.toward[1] - Number(at[1])));
      } else if (m.kind === 'grab') {
        const at = el.dataset.tile!.split(',');
        el.style.setProperty('--kx', String(m.from[0] - Number(at[0])));
        el.style.setProperty('--ky', String(m.from[1] - Number(at[1])));
      }
      el.dataset[channel] = m.kind;
    }

    until.current = performance.now() + MOTION_MS;
    return arm(MOTION_MS);
  }, [scene, turn]);
}

type BoardProps = {
  view: NamedView;
  scene: Scene;
  turn: number;
  events: readonly TurnEvent[];
  picked: Action | null;
  onPick: ((a: Action) => void) | null;
};

export function Board({ view, scene, turn, events, picked, onPick }: BoardProps) {
  const layer = useRef<HTMLDivElement | null>(null);
  useMotions(layer, scene, turn, events);

  const walls = new Set(view.walls.map((p) => tile(p[0], p[1])));
  const spawnAt = new Map<string, Color>();
  for (const c of view.roster) {
    const s = view.spawns[c];
    if (s) spawnAt.set(tile(s[0], s[1]), c);
  }
  const centerKey = tile(view.center[0], view.center[1]);
  const nextIndex = view.me.p + 1;

  const click = (t: ActionOffer | undefined): (() => void) | undefined => (
    onPick && t && t.reason === null ? () => { onPick(t.action); } : undefined
  );

  const cells = [];
  for (let y = 0; y < view.h; y++) {
    for (let x = 0; x < view.w; x++) {
      const k = tile(x, y);
      cells.push(
        <Cell
          key={k}
          view={view}
          wall={walls.has(k)}
          target={scene.targets.get(k)}
          nextIndex={nextIndex}
          picked={picked}
          onClick={click(scene.targets.get(k))}
          past={scene.trails.get(k)}
          occupied={scene.byTile.has(k)}
          op={scene.shade}
          spawn={spawnAt.get(k)}
          keyHere={k === centerKey && scene.keyAtCenter}
        />
      );
    }
  }

  return (
    <div id="board" style={`--bw:${view.w};--bh:${view.h};`} class={reducedMotion() ? 'noanim' : ''}>
      {cells}
      <div class="bodies" ref={layer}>
        {scene.stacks.map((s) => (
          <Slot key={s.key} view={view} stack={s} onClick={click(scene.targets.get(tile(s.x, s.y)))} />
        ))}
        {scene.fronts.map((f) => <FrontMark key={f.key} front={f} />)}
      </div>
    </div>
  );
}

type CellProps = {
  view: NamedView;
  wall: boolean;
  target: ActionOffer | undefined;
  nextIndex: number;
  picked: Action | null;
  onClick: (() => void) | undefined;
  past: ViewBody[] | undefined;
  occupied: boolean;
  op: Map<number, number>;
  spawn: Color | undefined;
  keyHere: boolean;
};

function Cell(
  { view, wall, target, nextIndex, picked, onClick, past, occupied, op, spawn, keyHere }: CellProps
) {
  let style: JSX.CSSProperties = { background: 'var(--surface-1)' };
  let title: string | undefined;
  const open = Boolean(target && target.reason === null);
  const on = Boolean(target && picked === target.action);

  if (wall) {
    style = { background: 'var(--wall)', opacity: 0.38 };
  } else if (target && target.reason === null) {
    style = {
      background: 'var(--accent-bg)',
      cursor: 'pointer',
      outline: (on ? '2px' : '1.5px') + ' solid var(--accent-br)',
      outlineOffset: on ? '-2px' : '-1.5px',
      ...(on ? {} : { opacity: 0.75 })
    };
    title = 'move ' + target.action;
  } else if (target) {
    style = { background: 'var(--wall)', opacity: 0.55 };
    title = 'Blocked by ' + target.reason;
  }

  if (spawn) style = { ...style, border: '2px dashed ' + COLORS[spawn].hex };

  const dots = wall || !past ? [] : past.slice(0, occupied ? 2 : 4);

  return (
    <div
      class="cell" style={style} title={title} onClick={onClick}
      data-spawn={spawn} data-target={open ? target!.action : undefined}
    >
      {open && (
        <div class="tgt">
          <span class="tgt-p">{nextIndex}</span>
          <span class="tgt-t">t{target!.t}</span>
        </div>
      )}
      {keyHere && <i class={'key-mark center' + (occupied ? ' corner' : '')} />}
      {dots.length > 0 && (
        <div class={'trail-cluster' + (occupied ? ' corner' : '')}>
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

const at = (n: number): string => 'calc(' + n + ' * 100% / var(--bw))';
const down = (n: number): string => 'calc(' + n + ' * 100% / var(--bh))';

function Slot(
  { view, stack, onClick }: { view: NamedView; stack: Stack; onClick: (() => void) | undefined }
) {
  const sides = new Map<string, string>();
  for (const t of stack.tokens) if (t.keySide) sides.set(t.keySide.join(','), t.keySide.join(','));

  return (
    <div
      class="tokslot" data-key={stack.key} data-tile={tile(stack.x, stack.y)}
      style={{ left: at(stack.x), top: down(stack.y), '--body-color': COLORS[stack.color].hex }}
      onClick={onClick}
    >
      <Token view={view} stack={stack} />
      <TurnBack />
      {[...sides.values()].map((side) => (
        <i key={side} class="key-mark" data-side={side} />
      ))}
    </div>
  );
}

// The tile owns the turn-back arc rather than a token: an inversion leaves two co-located bodies
// and a mark on the tile does not have to pick one. CSS reveals it while the slot is inverting.
function TurnBack() {
  return (
    <svg class="turnback" viewBox="0 0 100 100" aria-hidden="true">
      <path class="tb-arc" d="M64 62A28 28 0 1 1 92 34" />
      <path class="tb-tip" d="M85 32H99L92 46z" />
    </svg>
  );
}

function Token({ view, stack }: { view: NamedView; stack: Stack }) {
  const sorted = stack.tokens;
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

function FrontMark({ front }: { front: SceneFront }) {
  return (
    <div class="tokslot frontslot" data-key={front.key} style={{ left: at(front.x), top: down(front.y) }}>
      <i
        class="front-mark"
        style={{ '--front-color': COLORS[front.color].hex, '--front-nth': front.nth }}
        title={front.text}
        aria-label={front.text}
      />
    </div>
  );
}
