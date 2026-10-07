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

// Keep the axis near a dozen labels however far the horizon reaches.
function tickStep(span: number): number {
  if (span <= 12) return 1;
  if (span <= 60) return 5;
  if (span <= 150) return 10;
  const target = span / 12;
  const scale = 10 ** Math.floor(Math.log10(target));
  return [1, 2, 5, 10].find((n) => n * scale >= target)! * scale;
}

export type InstrumentRow = PlayerLanes & {
  top: number;
  laneY: (lane: number) => number;
};

export type Instrument = {
  height: number;
  horizon: number;
  colW: number;
  x: (t: number) => number;
  ticks: number[];
  // Unexplored turns continue beyond the horizon while the match is running.
  fog: { x: number; w: number; from: number } | null;
  left: number;
  right: number;
  top: number;
  bottom: number;
  rows: InstrumentRow[];
};

export function instrumentAt(view: View, width: number): Instrument {
  const horizon = Math.max(0, view.me.horizon);
  const running = view.outcome.status === 'running';

  // Scale to the turns reached.
  const left = GUTTER;
  const right = width - RIGHT;
  const colW = (right - left - (running ? FOG_W : 0)) / (horizon + 1);
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
    horizon,
    colW,
    x,
    ticks,
    fog: running ? { x: fogX, w: Math.max(0, right - fogX), from: horizon + 1 } : null,
    left,
    right,
    top: 6,
    bottom: height - AXIS_H + 6,
    rows
  };
}
