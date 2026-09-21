// Lays out the timeline instrument: one column per world turn, one row per player, lanes within
// a row. Pure so the arithmetic can be tested without a DOM.

import { MAX_LANES, lanesOf } from './lanes.js';
import type { PlayerLanes } from './lanes.js';
import type { NamedView } from './scene.js';

const GUTTER = 78;
const RIGHT = 16;
const LANE_H = 14;
const ROW_TOP = 18;
const ROW_H = MAX_LANES * LANE_H + 12;
const AXIS_H = 26;
// The unexplored hatch gets a fixed slice. Columns take everything else, however few there are.
const FOG_W = 80;

// How far back the history scrub reaches.
export function maxLookBack(cap: number): number {
  return Math.max(1, Math.ceil(cap / 4));
}

// Keep the axis near a dozen labels however far the horizon reaches.
function tickStep(span: number): number {
  if (span <= 12) return 1;
  if (span <= 60) return 5;
  if (span <= 150) return 10;
  return 25;
}

export type InstrumentRow = PlayerLanes & {
  top: number;
  laneY: (lane: number) => number;
};

export type Instrument = {
  height: number;
  cap: number;
  // The furthest world turn the viewer has reached, and the last column drawn.
  horizon: number;
  colW: number;
  x: (t: number) => number;
  ticks: number[];
  // Turns `from` … `to` are past the viewer's horizon. Null once the horizon reaches the cap.
  fog: { x: number; w: number; from: number; to: number } | null;
  capX: number;
  left: number;
  right: number;
  top: number;
  bottom: number;
  rows: InstrumentRow[];
};

export function instrumentAt(view: NamedView, width: number): Instrument {
  const cap = Math.max(0, Math.floor(view.cap));
  const horizon = Math.min(Math.max(0, view.me.horizon), cap);

  // Columns cover the turns reached and nothing else. Most matches never approach the cap, so
  // scaling to it would squeeze every played turn into a sliver.
  const left = GUTTER;
  const right = width - RIGHT;
  const colW = (right - left - (horizon < cap ? FOG_W : 0)) / (horizon + 1);
  const x = (t: number): number => left + t * colW + colW / 2;

  const lanes = lanesOf(view);
  const height = ROW_TOP + lanes.length * ROW_H + AXIS_H;
  const rows = lanes.map((row, i) => {
    const top = ROW_TOP + i * ROW_H;
    return { ...row, top, laneY: (lane: number): number => top + 14 + lane * LANE_H };
  });

  const step = tickStep(horizon);
  const ticks: number[] = [];
  for (let t = 0; t <= horizon; t += step) ticks.push(t);
  if (!ticks.length) ticks.push(0);

  const fogX = x(horizon) + colW / 2;

  return {
    height,
    cap,
    horizon,
    colW,
    x,
    ticks,
    fog: horizon < cap ? { x: fogX, w: Math.max(0, right - fogX), from: horizon + 1, to: cap } : null,
    capX: horizon < cap ? right : fogX,
    left,
    right,
    top: 6,
    bottom: height - AXIS_H + 6,
    rows
  };
}
