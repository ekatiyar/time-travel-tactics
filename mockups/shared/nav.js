// Injects the shared nav and theme toggle. Page list is the single source of truth for index + nav.
window.MK_PAGES = [
  ['index.html', 'Gallery', ''],
  ['00-current.html', '00 Baseline', 'Current prototype, annotated'],
  ['01-board-first.html', '01 Board-first layout', 'Full-bleed board, HUD rails, timeline dock'],
  ['02-timeline-instrument.html', '02 Timeline instrument', 'Per-player rows, key band, fronts, drag scrub'],
  ['03-worldlines.html', '03 Worldlines on the board', 'Ribbon trails, onion skin, direction arrows'],
  ['04-isometric.html', '04 Isometric time stack', '2.5D tiles, past turns as slices beneath'],
  ['05-spacetime-cube.html', '05 Spacetime cube', 'World turns as a vertical axis, fronts as planes'],
  ['06-key-and-fronts.html', '06 Key & front language', 'Key chain, ownership ladder, front sweep, ETA rings'],
  ['07-animations.html', '07 Turn resolution animation', 'Simultaneous moves, bounce, grab, invert, front step'],
  ['08-input.html', '08 Action input', 'On-board ghost preview, radial menu, legality, commit'],
  ['09-inspector.html', '09 Body inspector', 'Click/tap a body: its timeline, keys, threats'],
  ['10-threat-layer.html', '10 Threat & urgency layer', 'Steal tiles, danger heat, countdown rings'],
  ['11-mobile.html', '11 Mobile portrait', 'Thumb-zone controls, drawers, bottom sheet'],
  ['12-split-present.html', '12 Split presents', 'Separate presents after inversion, present lens'],
  ['13-lobby-setup.html', '13 Setup & lobby', 'Seeded board preview, mode cards, seat on spawn'],
  ['14-onboarding.html', '14 Onboarding & rule hints', 'Coach marks, first-match guide, inline rule cards'],
  ['15-replay-review.html', '15 Replay & post-match', 'Chaptered scrub, key custody chart, share'],
  ['16-art-direction.html', '16 Art direction', 'Blueprint, pixel, neon, tabletop swatches'],
  ['17-index-ramp.html', '17 Index ramp & body glyphs', 'Personal-index ramp, glyph alphabet'],
];
(function () {
  const here = location.pathname.split('/').pop() || 'index.html';
  const cur = window.MK_PAGES.find((p) => p[0] === here);
  const nav = document.createElement('nav');
  nav.className = 'mk-nav';
  const idx = window.MK_PAGES.findIndex((p) => p[0] === here);
  const prev = window.MK_PAGES[idx - 1], next = window.MK_PAGES[idx + 1];
  nav.innerHTML =
    '<a href="index.html">' + (here === 'index.html' ? '<span class="cur">Gallery</span>' : '← Gallery') + '</a>' +
    (cur && here !== 'index.html' ? '<span class="cur">' + cur[1] + '</span><span class="tag">mockup, not implementation</span>' : '') +
    '<span class="spacer"></span>' +
    (prev && here !== 'index.html' ? '<a href="' + prev[0] + '">← ' + prev[1] + '</a>' : '') +
    (next ? '<a href="' + next[0] + '">' + next[1] + ' →</a>' : '');
  document.body.prepend(nav);
  const t = document.createElement('button');
  t.className = 'btn mk-toggle';
  const saved = localStorage.getItem('mk-theme') || 'dark';
  document.documentElement.setAttribute('data-theme', saved);
  t.textContent = saved === 'dark' ? 'Light' : 'Dark';
  t.onclick = () => {
    const n = document.documentElement.getAttribute('data-theme') === 'dark' ? 'light' : 'dark';
    document.documentElement.setAttribute('data-theme', n);
    localStorage.setItem('mk-theme', n);
    t.textContent = n === 'dark' ? 'Light' : 'Dark';
  };
  document.body.appendChild(t);
})();
