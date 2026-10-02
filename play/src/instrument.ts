import { MAX_LANES, lanesOf } from './lanes.js';
import type { PlayerLanes } from './lanes.js';
import type { View } from './engine/index.js';

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
  colW: number;
  x: (t: number) => number;
  ticks: number[];
  // Turns `from` … `to` are past the viewer's horizon. Null once the horizon reaches the cap.
  fog: { x: number; w: number; from: number; to: number } | null;
  left: number;
  right: number;
  top: number;
  bottom: number;
  rows: InstrumentRow[];
};

export function instrumentAt(view: View, width: number): Instrument {
  const cap = Math.max(0, Math.floor(view.cap));
  const horizon = Math.min(Math.max(0, view.me.horizon), cap);

  // Scale to the horizon so a distant cap does not squeeze the played turns.
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

  const fogX = x(horizon) + colW / 2;

  return {
    height,
    cap,
    colW,
    x,
    ticks,
    fog: horizon < cap ? { x: fogX, w: Math.max(0, right - fogX), from: horizon + 1, to: cap } : null,
    left,
    right,
    top: 6,
    bottom: height - AXIS_H + 6,
    rows
  };
}
