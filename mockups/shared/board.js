// Shared SVG board renderer in the current prototype's visual language.
// Pages call MK.board(el, opts) to get a baseline board, then decorate the returned api.
// Everything here is mockup scaffolding, not game code.
(function () {
  const F = window.FIX, C = window.COLORS;
  const NS = 'http://www.w3.org/2000/svg';

  function el(tag, attrs, children) {
    const n = document.createElementNS(NS, tag);
    for (const k in attrs || {}) {
      if (k === 'text') n.textContent = attrs[k];
      else if (k === 'title') { const t = document.createElementNS(NS, 'title'); t.textContent = attrs[k]; n.appendChild(t); }
      else n.setAttribute(k, attrs[k]);
    }
    for (const c of children || []) n.appendChild(c);
    return n;
  }

  const key = (x, y) => x + ',' + y;

  function bodiesAt(t, x, y) {
    return F.bodies.filter((b) => b.t === t && b.x === x && b.y === y);
  }
  function path(color) {
    return F.bodies.filter((b) => b.color === color).sort((a, b) => a.p - b.p);
  }
  function live(color) {
    return F.bodies.find((b) => b.color === color && b.live);
  }
  function heldBy(b) {
    return F.keys.find((k) => k.color === b.color && k.p === b.p);
  }

  // opts: { focusT, lookBack, cell (px), trails, keys, fronts, spawns, labels, ghosts, dimHistory, showWalls, hideBodies, onCell }
  function board(container, opts) {
    const o = Object.assign({
      focusT: F.me.t, lookBack: 4, cell: 44, trails: true, keys: true, fronts: true,
      spawns: true, labels: true, showWalls: true, hideBodies: false, ghosts: false, gap: 2
    }, opts || {});
    const s = o.cell, W = F.w * s, H = F.h * s;
    const svg = el('svg', { viewBox: `0 0 ${W} ${H}`, width: '100%', class: 'mk-board', style: 'display:block;max-width:100%;height:auto' });
    const layers = {};
    for (const name of ['tiles', 'spawns', 'trails', 'targets', 'bodies', 'keys', 'fronts', 'overlay', 'top']) {
      layers[name] = el('g', { 'data-layer': name });
      svg.appendChild(layers[name]);
    }
    const walls = new Set(F.walls.map((p) => key(p[0], p[1])));
    const cx = (x) => x * s + s / 2, cy = (y) => y * s + s / 2;

    // Tiles
    for (let y = 0; y < F.h; y++) for (let x = 0; x < F.w; x++) {
      const isWall = walls.has(key(x, y));
      const r = el('rect', {
        x: x * s + o.gap / 2, y: y * s + o.gap / 2, width: s - o.gap, height: s - o.gap, rx: 3,
        fill: isWall && o.showWalls ? 'var(--wall)' : 'var(--surface-1)',
        opacity: isWall && o.showWalls ? 0.38 : 1, 'data-x': x, 'data-y': y, class: 'mk-tile' + (isWall ? ' wall' : '')
      });
      if (o.onCell) o.onCell(r, x, y, isWall);
      layers.tiles.appendChild(r);
    }
    // Spawns
    if (o.spawns) for (const c of F.roster) {
      const sp = F.spawns[c];
      layers.spawns.appendChild(el('rect', {
        x: sp[0] * s + 2, y: sp[1] * s + 2, width: s - 4, height: s - 4, rx: 3, fill: 'none',
        stroke: C[c].hex, 'stroke-width': 2, 'stroke-dasharray': '5 4'
      }));
    }
    // Center key when unheld at focus
    if (o.keys && F.keyAtCenter.includes(o.focusT) && !o.hideBodies) {
      layers.keys.appendChild(el('rect', { x: cx(F.center[0]) - s * 0.15, y: cy(F.center[1]) - s * 0.15, width: s * 0.3, height: s * 0.3, rx: 2, fill: 'var(--key)', stroke: 'var(--surface-0)' }));
    }
    const lo = Math.max(0, o.focusT - o.lookBack);
    // Trails: history dots in a corner cluster per tile
    if (o.trails && !o.hideBodies) {
      const byTile = new Map();
      for (const b of F.bodies) if (b.t >= lo && b.t < o.focusT) {
        const k = key(b.x, b.y); if (!byTile.has(k)) byTile.set(k, []); byTile.get(k).push(b);
      }
      for (const [k, list] of byTile) {
        list.sort((a, b) => b.t - a.t);
        const hasFocus = bodiesAt(o.focusT, list[0].x, list[0].y).length > 0;
        const dots = list.slice(0, hasFocus ? 2 : 4);
        dots.forEach((b, i) => {
          const age = (o.focusT - b.t) / Math.max(1, o.lookBack);
          const op = 1 - (1 - 0.22) * Math.min(1, age);
          const r = s * 0.06;
          const px = hasFocus ? b.x * s + s - r - 3 - i * (r * 2 + 2) : cx(b.x) - ((dots.length - 1) * (r * 2 + 3)) / 2 + i * (r * 2 + 3);
          const py = hasFocus ? b.y * s + r + 3 : cy(b.y);
          layers.trails.appendChild(el('circle', {
            cx: px, cy: py, r, fill: b.dir === F.me.dir ? C[b.color].hex : 'transparent', stroke: C[b.color].hex, 'stroke-width': 1.2, opacity: op,
            title: `${F.names[b.color]} · index ${b.p} · t${b.t} · ${b.dir === 1 ? 'forward' : 'backward'}`
          }));
        });
      }
    }
    // Bodies at focus
    if (!o.hideBodies) {
      const byTile = new Map();
      for (const b of F.bodies) if (b.t === o.focusT) {
        const k = key(b.x, b.y); if (!byTile.has(k)) byTile.set(k, []); byTile.get(k).push(b);
      }
      for (const [, list] of byTile) {
        list.sort((a, b) => a.p - b.p);
        const b0 = list[0], col = C[b0.color];
        const dirs = new Set(list.map((b) => b.dir === F.me.dir ? 'm' : 'o'));
        const fill = dirs.size > 1 ? `url(#mixed-${b0.color})` : dirs.has('m') ? col.hex : 'transparent';
        const many = list.length > 1;
        const w = many ? s * 0.88 : s * 0.7, h = s * 0.7;
        const g = el('g', { class: 'mk-body', 'data-color': b0.color, 'data-p': list.map((b) => b.p).join(','), title: list.map((b) => `${F.names[b.color]} · index ${b.p} · t${b.t}${b.live ? ' · current' : ''}`).join('\n') });
        g.appendChild(el('rect', { x: cx(b0.x) - w / 2, y: cy(b0.y) - h / 2, width: w, height: h, rx: h / 2, fill, stroke: col.hex, 'stroke-width': s * 0.06 }));
        if (o.labels) {
          const lab = list.length > 2 ? `${list[0].p}…${list[list.length - 1].p}` : list.map((b) => b.p).join('·');
          g.appendChild(el('text', { x: cx(b0.x), y: cy(b0.y) + s * 0.09, 'text-anchor': 'middle', 'font-family': 'var(--mono)', 'font-size': s * 0.26, 'font-weight': 500, fill: dirs.has('m') && dirs.size === 1 ? col.ink : 'var(--text-primary)', text: lab }));
        }
        if (dirs.size > 1) {
          const defs = el('defs', {}, [el('linearGradient', { id: `mixed-${b0.color}` }, [
            el('stop', { offset: '50%', 'stop-color': col.hex }), el('stop', { offset: '50%', 'stop-color': 'transparent' })])]);
          svg.appendChild(defs);
        }
        layers.bodies.appendChild(g);
        // Key marks
        if (o.keys) for (const b of list) {
          const k = heldBy(b);
          if (!k) continue;
          const m = s * 0.16, pad = s * 0.04;
          const kx = k.side[0] === 1 ? b.x * s + s - pad - m : k.side[0] === -1 ? b.x * s + pad : cx(b.x) - m / 2;
          const ky = k.side[1] === 1 ? b.y * s + s - pad - m : k.side[1] === -1 ? b.y * s + pad : cy(b.y) - m / 2;
          layers.keys.appendChild(el('rect', { x: kx, y: ky, width: m, height: m, rx: 2, fill: 'var(--key)', stroke: 'var(--surface-0)', title: `key held by ${F.names[b.color]} ${b.p}` }));
        }
      }
    }
    // Fronts as triangles
    if (o.fronts && !o.hideBodies) for (const f of F.fronts) if (f.t >= lo && f.t <= o.focusT) {
      const x0 = f.x * s + s * 0.06, y0 = f.y * s + s * 0.94, w = s * 0.14, h = s * 0.12;
      layers.fronts.appendChild(el('path', { d: `M${x0},${y0} l${w},0 l${-w / 2},${-h} z`, fill: C[f.color].hex, title: `front · reaches you in ${f.gap} turns` }));
    }
    container.innerHTML = '';
    container.appendChild(svg);
    return { svg, layers, s, cx, cy, el, opts: o };
  }

  // Timeline strip in the current style, returns svg
  function strip(container, opts) {
    const o = Object.assign({ focusT: F.me.t, lookBack: 4, width: 700 }, opts || {});
    const span = F.me.horizon + 1, colW = o.width / (span + 2);
    const svg = el('svg', { viewBox: `0 0 ${o.width} 46`, width: '100%', style: 'display:block' });
    const lo = Math.max(0, o.focusT - o.lookBack);
    for (let t = 0; t < span; t++) {
      const x = t * colW;
      const inWin = t >= lo && t <= o.focusT;
      svg.appendChild(el('rect', { x: x + 1, y: 18, width: colW - 2, height: 9, rx: 2, fill: inWin ? 'var(--text-secondary)' : 'var(--surface-2)', opacity: t === o.focusT ? 1 : inWin ? 0.4 : 1 }));
      svg.appendChild(el('text', { x: x + colW / 2, y: 40, 'text-anchor': 'middle', 'font-size': 9.5, 'font-family': 'var(--mono)', fill: t === o.focusT ? 'var(--text-primary)' : 'var(--text-muted)', text: t }));
      const heads = F.bodies.filter((b) => b.live && b.t === t);
      heads.forEach((b, i) => svg.appendChild(el('circle', { cx: x + colW / 2 + (i - (heads.length - 1) / 2) * 7, cy: 12, r: 2.5, fill: b.dir === F.me.dir ? C[b.color].hex : 'transparent', stroke: C[b.color].hex })));
      for (const f of F.fronts) if (f.t === t) svg.appendChild(el('path', { d: `M${x + colW / 2 - 4},6 l8,0 l-4,-6 z`, fill: C[f.color].hex }));
    }
    svg.appendChild(el('rect', { x: span * colW + 2, y: 18, width: colW * 2 - 4, height: 9, rx: 2, fill: 'none', stroke: 'var(--border)', 'stroke-dasharray': '3 3' }));
    container.innerHTML = '';
    container.appendChild(svg);
    return svg;
  }

  window.MK = { el, board, strip, bodiesAt, path, live, heldBy, key, F, C };
})();
