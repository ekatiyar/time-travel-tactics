# Mockup page brief (read fully before writing a page)

Goal: static HTML mockups exploring UI directions for the time-travel tactics prototype. Mockups only.
No implementation in play/. Never edit files in mockups/shared/ or anything outside mockups/.

## Read first
- docs/time-travel-tactics-design-doc.md (rules; "UI requirements" section especially)
- docs/playing.md (current player-facing behaviour), docs/open-questions.md (UI section)
- play/src/ui.tsx + play/style.css (what exists today; skim)
- mockups/shared/fixture.js (the scenario every page must use) and mockups/shared/board.js (renderer API)
- mockups/current/*.png if present (screenshots of today's UI)

## The fixture scenario (window.FIX, viewer is Coral = "Rook")
16x9 board, center (8,4), spawns C(1,1) P(14,7) T(14,1) A(1,7). Meta-turn 17, cap 43.
Coral: index 17, at t8, (8,2), walking backward (dir -1), horizon t12. Holds the key on its right side
(key on indices 14..17). Coral picked the key up at t11 on meta-turn 13, then inverted at t12.
Amber ("Juno"): live at t7 (7,3) walking forward, holds the key on indices 16..17 (grabbed at t6 on meta-turn 15).
Amber's front is at t11 (7,4), target Coral, gap 4 turns: it will break Coral's grab and Coral loses the key.
Teal ("Ash"): live at t7 (14,0) forward; it inverted three times at t9 (stack 8..13 at (14,1)).
Purple ("Mira"): live at t2 (12,5) backward; inverted at t6 and again at t0 and t2.
Names: C Rook, P Mira, T Ash, A Juno. Colours: window.COLORS[c].hex/.ink.
Fields: FIX.bodies[{color,p,t,x,y,dir,live}], FIX.keys[{color,p,side}], FIX.fronts[{color,t,x,y,target,gap}],
FIX.keyAtCenter[t...], FIX.walls[[x,y]], FIX.events[{turn,color,kind,t,x,y,by,dir}], FIX.me, FIX.priority, FIX.actions.

## Page skeleton
```html
<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>NN Name · tbtt mockups</title><link rel="stylesheet" href="shared/mock.css"><style>/* page css */</style></head>
<body><main class="mk-page">
 <h1>Name</h1><p class="mk-lede">One or two sentences: what this direction is and why.</p>
 <div class="mk-meta"><span class="req">UI req: timeline strip with playheads</span><span>Open question: touch inspection</span></div>
 <!-- 2 to 4 <figure class="fig"> mockups, each with <div class="frame"> content, numbered <i class="callout" style="left:..;top:..">1</i> markers, and <figcaption> -->
 <!-- <ul class="callouts"> explaining each numbered marker -->
 <!-- optional <div class="variants"> with smaller alternative figures -->
 <h2>Trade-offs</h2><div class="mk-pc"><div class="pro"><h3>Pros</h3><ul>..</ul></div><div class="con"><h3>Cons</h3><ul>..</ul></div></div>
 <h2>What it answers</h2> <div class="mk-prose">which UI requirements / open questions it addresses, and what it leaves open</div>
 <h2>Cost</h2> <div class="mk-prose">rough build effort (S/M/L) and what changes in ui.tsx / style.css only, vs needs engine view changes</div>
</main>
<script src="shared/fixture.js"></script><script src="shared/board.js"></script><script src="shared/nav.js"></script>
<script>/* page js: MK.board(el,{focusT,lookBack,cell,...}) returns {svg,layers,s,cx,cy,el} to decorate */</script>
</body></html>
```
Renderer opts: focusT, lookBack, cell(px), trails, keys, fronts, spawns, labels, showWalls, hideBodies, onCell(rect,x,y,isWall).
Helpers: MK.el(tag, attrs, children) (attrs.text/title supported), MK.bodiesAt(t,x,y), MK.path(color), MK.live(color), MK.heldBy(body).

## Rules
- Plain language, state numbers. Every figure shows the fixture scenario so pages are comparable.
- Draw with SVG/HTML/CSS. No libraries, no fetch, no external fonts/images. Must work from file://.
- CSS animation is welcome where it explains the idea. Light JS for toggles is fine.
- Dark theme first (the nav has a theme toggle; do not break light theme badly, but do not spend long on it).
- Keep a page to roughly 1 screen of prose. Mockups carry the weight.
- Verify: `node mockups/shared/shot.mjs file:///ABS/PATH/page.html /tmp/NN.png 1400 900` prints console errors; then
  view the PNG (Read tool) and fix layout problems. Do at least one look-and-fix pass per page.
- Do not restyle the shared nav or add global CSS that leaks (scope page CSS under a page class or ids).
