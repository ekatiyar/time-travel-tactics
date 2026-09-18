import type { MetaTurn } from './types.js';

export type TimelineEvent<V> = {
  origin: number; value: V; front: number; counts: boolean; turn: MetaTurn;
};
export type Reading<V> = { event: TimelineEvent<V>; offset: number };

// One entity's tape: events whose fronts sweep forward from their origin,
// breaking any counting event whose origin they pass.
export class Timeline<V> {
  private _events: TimelineEvent<V>[] = [];
  private _show: (v: V) => string;

  constructor(show: (v: V) => string) { this._show = show; }

  record(origin: number, value: V, turn: MetaTurn): TimelineEvent<V> {
    const e: TimelineEvent<V> = { origin, value, front: origin, counts: true, turn };
    this._events.push(e);
    return e;
  }

  advance(step: number, cap: number): TimelineEvent<V>[] {
    const broken: TimelineEvent<V>[] = [];
    for (const e of this._events) {
      if (!e.counts) continue;
      const from = e.front;
      e.front = Math.min(from + step, cap);
      for (const other of this._events) {
        if (other === e || !other.counts) continue;
        if (other.origin > from && other.origin <= e.front) { other.counts = false; broken.push(other); }
      }
    }
    return broken;
  }

  at(i: number): Reading<V> | null {
    let fallback: TimelineEvent<V> | null = null;
    for (let k = this._events.length - 1; k >= 0; k--) {
      const e = this._events[k]!;
      if (i < e.origin || i > e.front) continue;
      if (e.counts) return { event: e, offset: i - e.origin };
      if (!fallback) fallback = e;
    }
    return fallback ? { event: fallback, offset: i - fallback.origin } : null;
  }

  events(): readonly TimelineEvent<V>[] { return this._events.slice(); }

  digest(): string {
    return this._events
      .map((e) => e.origin + ':' + e.front + ':' + (e.counts ? 1 : 0) + ':' + e.turn + ':' + this._show(e.value))
      .join(';');
  }
}
