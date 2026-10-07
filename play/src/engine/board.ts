import { DIRS, MOVES, isColor, isModeId } from './types.js';
import type { Color, Config, ConfigInput, Vec, WorldTurn } from './types.js';
import { fnv1a, mulberry32 } from './hash.js';

export function tileKey(x: number, y: number): string { return x + ',' + y; }
export function cellKey(t: WorldTurn, x: number, y: number): string { return t + ',' + x + ',' + y; }
export function unkey(k: string): Vec {
  const i = k.indexOf(',');
  return [Number(k.slice(0, i)), Number(k.slice(i + 1))];
}

// One tile in from the corner so every spawn has four neighbours.
export function spawnFor(color: Color, w: number, h: number): Vec {
  if (color === 'C') return [1, 1];
  if (color === 'P') return [w - 2, h - 2];
  if (color === 'T') return [w - 2, 1];
  return [1, h - 2];
}

export function centerOf(w: number, h: number): Vec {
  return [Math.floor(w / 2), Math.floor(h / 2)];
}

export type BoardPreviewData = {
  w: number; h: number; roster: Color[]; walls: Vec[];
  spawns: Partial<Record<Color, Vec>>; center: Vec; keyAtCenter: boolean;
};

export function previewBoard(input: ConfigInput): BoardPreviewData {
  const cfg = normalizeConfig(input);
  const spawns: Partial<Record<Color, Vec>> = {};
  for (const color of cfg.roster) spawns[color] = spawnFor(color, cfg.w, cfg.h);
  return {
    w: cfg.w, h: cfg.h, roster: cfg.roster, walls: [...genWalls(cfg)].map(unkey).sort((a, b) => a[1] - b[1] || a[0] - b[0]),
    spawns, center: centerOf(cfg.w, cfg.h), keyAtCenter: cfg.mode === 'bootstrap'
  };
}

export function protectedTiles(cfg: Config): Set<string> {
  const out = new Set<string>();
  for (const c of cfg.roster) {
    const s = spawnFor(c, cfg.w, cfg.h);
    out.add(tileKey(s[0], s[1]));
    for (const m of MOVES) out.add(tileKey(s[0] + DIRS[m][0], s[1] + DIRS[m][1]));
  }
  const ctr = centerOf(cfg.w, cfg.h);
  out.add(tileKey(ctr[0], ctr[1]));
  return out;
}

export function normalizeConfig(c: ConfigInput): Config {
  const asked = c.roster.slice();
  const w = Math.floor(c.w), h = Math.floor(c.h), wallPct = Math.floor(c.wallPct);
  const seed = String(c.seed), mode = c.mode;
  if (!isModeId(mode)) throw new Error('unknown mode ' + mode);
  // 5x5 keeps the center off every spawn; 64 keeps rendering bounded.
  if (!(w >= 5 && w <= 64 && h >= 5 && h <= 64)) throw new Error('board must be between 5x5 and 64x64');
  if (!(wallPct >= 0 && wallPct <= 45)) throw new Error('wall density must be 0-45');
  if (!/^[A-Za-z0-9_-]{1,24}$/.test(seed)) throw new Error('seed must be 1-24 letters, digits, - or _');
  if (!asked.length || asked.length > 4) throw new Error('need 1-4 players');

  const roster: Color[] = [];
  for (const col of asked) {
    if (!isColor(col)) throw new Error('unknown colour ' + col);
    if (roster.includes(col)) throw new Error('duplicate colour ' + col);
    roster.push(col);
  }
  return { mode, w, h, wallPct, seed, roster };
}

// Carve walls until every spawn and the center are reachable.
export function genWalls(cfg: Config): Set<string> {
  const w = cfg.w, h = cfg.h;
  const spawns = cfg.roster.map((c) => spawnFor(c, w, h));
  const first = spawns[0];
  if (!first) throw new Error('need 1-4 players');
  const must = [...spawns, centerOf(w, h)];
  const safe = protectedTiles(cfg);

  const rnd = mulberry32(fnv1a('walls:' + cfg.seed));
  const wall = new Set<string>();
  const target = Math.floor(w * h * cfg.wallPct / 100);
  for (let guard = 0; wall.size < target && guard < w * h * 40; guard++) {
    const k = tileKey(Math.floor(rnd() * w), Math.floor(rnd() * h));
    if (!safe.has(k)) wall.add(k);
  }

  function reachable(): Set<string> {
    const seen = new Set([tileKey(first![0], first![1])]);
    const st: Vec[] = [first!];
    while (st.length) {
      const p = st.pop()!;
      for (const m of MOVES) {
        const v = DIRS[m], nx = p[0] + v[0], ny = p[1] + v[1], nk = tileKey(nx, ny);
        if (nx < 0 || ny < 0 || nx >= w || ny >= h || wall.has(nk) || seen.has(nk)) continue;
        seen.add(nk); st.push([nx, ny]);
      }
    }
    return seen;
  }
  for (let pass = 0; pass < w * h; pass++) {
    const seen = reachable();
    if (must.every((s) => seen.has(tileKey(s[0], s[1])))) break;
    let removed = false;
    for (let y = 0; y < h && !removed; y++) {
      for (let x = 0; x < w && !removed; x++) {
        const key = tileKey(x, y);
        if (!wall.has(key)) continue;
        for (const m of MOVES) {
          const mv = DIRS[m];
          if (seen.has(tileKey(x + mv[0], y + mv[1]))) { wall.delete(key); removed = true; break; }
        }
      }
    }
    if (!removed) break;
  }
  return wall;
}
