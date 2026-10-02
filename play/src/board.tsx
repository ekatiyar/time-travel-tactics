import { useLayoutEffect, useRef } from 'preact/hooks';
import type { JSX } from 'preact';

import { COLORS } from './engine/index.js';
import type { Action, ActionOffer, Color, TurnEvent, Vec, ViewBody } from './engine/index.js';
import { describe, motionBetween, relativeDirection } from './scene.js';
import type { NamedView, Scene, SceneFront, Stack } from './scene.js';

const MOTION_MS = 1200;

const tile = (x: number, y: number): string => x + ',' + y;

const at = (n: number): string => 'calc(' + n + ' * 100% / var(--bw))';
const down = (n: number): string => 'calc(' + n + ' * 100% / var(--bh))';

function reducedMotion(): boolean {
  return typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
}

function reset(el: HTMLElement): void {
  delete el.dataset.motion;
  delete el.dataset.keyMotion;
}

// Re-arm transitions synchronously; the same input may commit new positions before the next frame.
function settle(layer: HTMLElement): void {
  layer.classList.add('snap');
  void layer.offsetHeight;
  layer.classList.remove('snap');
  void layer.offsetHeight;
}

type GhostKeeper = {
  remember(byKey: Map<string, HTMLElement>): void;
  revive(layer: HTMLElement, key: string, from: Vec, to: Vec): void;
  sweep(layer: HTMLElement): void;
};

// Preact unmounts a merging leg before the layout effect. Revive it for the animation,
// then sweep it before reading the next commit because Preact no longer owns it.
function ghostKeeper(): GhostKeeper {
  // remember runs before revive, so retain the previous commit too.
  let before = new Map<string, HTMLElement>();
  let now = new Map<string, HTMLElement>();
  let ghosts: HTMLElement[] = [];
  return {
    remember(byKey) { before = now; now = byKey; },
    revive(layer, key, from, to) {
      const el = before.get(key);
      // Still connected means the key was never unmounted, so a stale map is harmless.
      if (!el || el.isConnected) return;
      el.classList.add('ghost');
      el.setAttribute('aria-hidden', 'true');
      delete el.dataset.key;
      el.dataset.tile = tile(to[0], to[1]);
      el.style.left = at(to[0]);
      el.style.top = down(to[1]);
      el.style.setProperty('--px', String(from[0] - to[0]));
      el.style.setProperty('--py', String(from[1] - to[1]));
      el.dataset.motion = 'merge';
      layer.appendChild(el);
      ghosts.push(el);
    },
    sweep(layer) {
      for (const el of ghosts) if (el.parentNode === layer) layer.removeChild(el);
      ghosts = [];
    }
  };
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
  const ghosts = useRef<GhostKeeper | null>(null);
  ghosts.current ??= ghostKeeper();

  useLayoutEffect(() => {
    const layer = root.current;
    const before = prev.current;
    // Events belong to the turn that just resolved; a scrub has none to read.
    const resolved = turn !== prevTurn.current ? events : [];
    prev.current = scene;
    prevTurn.current = turn;
    if (!layer) return;

    const keeper = ghosts.current!;
    keeper.sweep(layer);
    const slots = layer.querySelectorAll<HTMLElement>('.tokslot');
    const byKey = new Map<string, HTMLElement>();
    for (const el of slots) {
      const k = el.dataset.key;
      if (k) byKey.set(k, el);
    }
    // Ahead of every early return: a held map that skipped a commit would revive the wrong node.
    keeper.remember(byKey);
    // Set delays before paint so they apply to this commit's transitions.
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
      keeper.sweep(layer!);
      for (const el of layer!.querySelectorAll<HTMLElement>('.tokslot')) reset(el);
      // Dropping the attribute ends the keyframes; the slide is a transition and needs a nudge.
      settle(layer!);
      detach();
    }
    function arm(ms: number): () => void {
      document.addEventListener('keydown', clear, true);
      document.addEventListener('pointerdown', clear, true);
      timer.current = window.setTimeout(clear, ms);
      // Clearing on teardown would disable the next commit's slide during reflow.
      return detach;
    }

    if (!before || reducedMotion()) { stage(resolved.length > 0); return; }

    if (Math.abs(scene.focusT - before.focusT) > 1) {
      until.current = 0;
      stage(false);
      settle(layer);
      return;
    }

    const motions = motionBetween(before, scene, resolved);
    // Committing an action rebuilds the scene without moving bodies; preserve any running animation.
    const left = until.current - performance.now();
    if (!motions.length && left > 0) return arm(left);

    stage(resolved.length > 0);
    if (!motions.length) return;

    for (const m of motions) {
      if (m.kind === 'merge') { keeper.revive(layer, m.key, m.from, m.to); continue; }
      const el = byKey.get(m.key);
      // Key changes can accompany movement, so they need a separate animation channel.
      const channel = m.kind === 'grab' || m.kind === 'lost' ? 'keyMotion' : 'motion';
      if (!el || el.dataset[channel]) continue;
      const own = el.dataset.tile!.split(',');
      if (m.kind === 'bounce') {
        el.style.setProperty('--dx', String(m.toward[0] - Number(own[0])));
        el.style.setProperty('--dy', String(m.toward[1] - Number(own[1])));
      } else if (m.kind === 'grab') {
        el.style.setProperty('--kx', String(m.from[0] - Number(own[0])));
        el.style.setProperty('--ky', String(m.from[1] - Number(own[1])));
      } else if (m.kind === 'split') {
        el.style.setProperty('--px', String(m.from[0] - Number(own[0])));
        el.style.setProperty('--py', String(m.from[1] - Number(own[1])));
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
      const target = scene.targets.get(k);
      cells.push(
        <Cell
          key={k}
          view={view}
          wall={walls.has(k)}
          target={target}
          nextIndex={nextIndex}
          picked={picked}
          onClick={click(target)}
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

function Slot(
  { view, stack, onClick }: { view: NamedView; stack: Stack; onClick: (() => void) | undefined }
) {
  const sides = new Map<string, number>();
  for (const t of stack.tokens) for (const held of t.keySides) {
    const side = held.side.join(',');
    sides.set(side, (sides.get(side) ?? 0) + held.count);
  }

  return (
    <div
      class="tokslot" data-key={stack.key} data-tile={tile(stack.x, stack.y)}
      style={{ left: at(stack.x), top: down(stack.y) }}
      onClick={onClick}
    >
      <Token view={view} stack={stack} />
      {[...sides].map(([side, count]) => (
        <i
          key={side} class="key-mark" data-side={side}
          data-count={count > 1 ? count : undefined}
          role="img" aria-label={count + (count === 1 ? ' key' : ' keys') + ' on side ' + side}
        />
      ))}
    </div>
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
