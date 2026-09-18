import { ORDER, isAction, isColor, isModeId, metaTurn, validName } from './types.js';
import type {
  Action, Color, Config, DecodedAction, DecodedExport, LogEntry, MetaTurn, Result
} from './types.js';

function group(m: RegExpExecArray, i: number): string {
  const v = m[i];
  if (v === undefined) throw new Error('pattern group ' + i + ' did not match');
  return v;
}

export const Wire = {
  encodeAction: function (a: {
    turn: MetaTurn; color: Color; action: Action; hash: string; name?: string | null
  }): string {
    let s = '' + a.turn + a.color + ':' + a.action + '#' + a.hash;
    if (a.turn === 0 && validName(a.name)) s += '~' + a.name;
    return s;
  },
  decodeAction: function (s: unknown): Result<DecodedAction> {
    const m = /^(\d{1,4})([CPTA]):([WASDHI])#([0-9a-f]{4})(?:~([A-Za-z0-9_-]{1,12}))?$/
      .exec(String(s == null ? '' : s).trim());
    if (!m) return { ok: false, error: 'not an action string (expected something like 7C:D#a3f2)' };
    const color = group(m, 2), action = group(m, 3);
    if (!isColor(color) || !isAction(action)) throw new Error('pattern and alphabet disagree');
    return {
      ok: true,
      value: {
        turn: metaTurn(+group(m, 1)), color: color, action: action, hash: group(m, 4),
        name: m[5] ?? null
      }
    };
  },

  encodeMatchCode: function (c: Config): string {
    return 'M1:' + c.mode + ':' + c.w + 'x' + c.h + ':' + c.wallPct + ':' + c.seed + ':' + c.cap + ':' + c.roster.join('');
  },
  decodeMatchCode: function (s: unknown): Result<Config> {
    const m = /^M1:([a-z]{1,16}):(\d{1,3})x(\d{1,3}):(\d{1,2}):([A-Za-z0-9_-]{1,24}):(\d{1,4}):([CPTA]{1,4})$/
      .exec(String(s == null ? '' : s).trim());
    if (!m) return { ok: false, error: 'not a match code (expected something like M1:bootstrap:16x9:11:19f4:43:CPTA)' };
    const mode = group(m, 1);
    if (!isModeId(mode)) return { ok: false, error: 'match code names an unknown mode ' + mode };
    const roster = group(m, 7).split('').filter(isColor);
    if (new Set(roster).size !== roster.length) return { ok: false, error: 'match code repeats a colour' };
    return {
      ok: true,
      value: {
        mode: mode, w: +group(m, 2), h: +group(m, 3), wallPct: +group(m, 4),
        seed: group(m, 5), cap: +group(m, 6), roster: roster
      }
    };
  },

  encodeExport: function (
    config: Config, log: readonly LogEntry[], names: Readonly<Partial<Record<Color, string>>> | null
  ): string {
    const byTurn: string[][] = [];
    for (const e of log) {
      let g = byTurn[e.turn];
      if (!g) { g = []; byTurn[e.turn] = g; }
      g.push(e.color + e.action);
    }
    const groups: string[] = [];
    for (let i = 0; i < byTurn.length; i++) groups.push((byTurn[i] ?? []).join(''));
    const nm = ORDER.filter((c) => validName((names ?? {})[c]))
      .sort().map((c) => c + '~' + (names ?? {})[c]);
    return 'X1:' + Wire.encodeMatchCode(config) + '|' + groups.join(',') + '|' + nm.join(',');
  },
  decodeExport: function (raw: unknown): Result<DecodedExport> {
    const s = String(raw == null ? '' : raw).trim();
    if (s.slice(0, 3) !== 'X1:') return { ok: false, error: 'not an export string (it should start with X1:)' };
    const parts = s.slice(3).split('|');
    if (parts.length < 2 || parts.length > 3) {
      return { ok: false, error: 'export string is missing its action section' };
    }
    const mc = Wire.decodeMatchCode(parts[0]);
    if (!mc.ok) return { ok: false, error: 'export carries a bad match code: ' + mc.error };

    const names: Partial<Record<Color, string>> = {};
    const nameParts = (parts[2] ?? '').length ? parts[2]!.split(',') : [];
    for (const part of nameParts) {
      const nm = /^([CPTA])~([A-Za-z0-9_-]{1,12})$/.exec(part);
      if (!nm) return { ok: false, error: 'bad name entry "' + part + '" in export' };
      const c = group(nm, 1);
      if (!isColor(c)) throw new Error('pattern and alphabet disagree');
      names[c] = group(nm, 2);
    }

    const rest = parts[1]!, log: LogEntry[] = [];
    const groups = rest.length ? rest.split(',') : [];
    for (let turn = 0; turn < groups.length; turn++) {
      const g = groups[turn]!;
      if (g.length % 2) return { ok: false, error: 'malformed action group at turn ' + turn };
      for (let i = 0; i < g.length; i += 2) {
        const color = g[i]!, action = g[i + 1]!;
        if (!isColor(color) || !isAction(action)) {
          return { ok: false, error: 'bad action "' + g.slice(i, i + 2) + '" at turn ' + turn };
        }
        log.push({ turn: metaTurn(turn), color: color, action: action });
      }
    }
    return { ok: true, value: { config: mc.value, log: log, names: names } };
  }
};
