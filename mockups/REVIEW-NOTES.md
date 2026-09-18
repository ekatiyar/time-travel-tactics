# Review pass notes (reconstructed from the review agent's transcript, 2026-09-18)

The agent died on the spend limit before reporting. Edits below are on disk; all 19 pages load with no console errors.

## Checks done
- Shot all pages at 1400 and 1000 px. No console errors anywhere.
- Programmatic horizontal-overflow check at 1000, 1400, 760 px.
- Programmatic check for SVG text spilling outside figure frames.
- Light-theme screenshot helper written (/tmp/rv/shotlight.mjs) but the light pass was never run.

## Changes made
- 00-current: stopped the short capture figures stretching.
- 02-timeline: callouts were pixel-positioned over a scaling SVG and drifted; converted to percentages.
- 04-isometric: inline tags inside `.callouts li` became flex items and broke text (bug in mock.css usage); fixed markup; nudged overlapping badges.
- 06-key-and-fronts: separated colliding world-turn labels in figure 1. (Checked engine front/gap semantics first.)
- 07-animations: shortened labels that clipped at the frame edge.
- 08-input: rewrote hold/invert chip drawing (pill sizing, label legibility); fixed callout placement; removed a duplicated live body; added a missing radial-menu marker; fixed commit-bar and note callout markers.
- 09-inspector: same inline-markup fix in the callouts list.
- 13-lobby-setup: roster now in priority order.
- 14-onboarding: callout placement and list markup fixed.
- 15-replay-review: added a halo behind custody-chart front labels.

## Not done
- Light-theme pass (03, 05, 07, 10, 16).
- Gallery thumbnails in index.html (still placeholder boards).
- Nav link check.
- Prose sanity read against the design doc.
- Visual pass on 10, 11, 12, 16, 17 (shot, not inspected).

## Second pass (2026-09-18)

All 19 pages plus index.html still load with no console errors.

### Changes made
- `index.html`: gallery cards now show a real screenshot per page. `.thumb` holds
  `<img src="thumbs/NN.png">` with `object-fit:cover`; the MK.board placeholder loop is gone,
  and the `.thumb svg` rule became `.thumb img`.
- `thumbs/00.png` .. `thumbs/17.png`: new. 01 to 17 are the first `.fig .frame` shot at a 1280
  viewport with `deviceScaleFactor: 0.5`, so each is about 600px wide. 11 needed a 1700 viewport
  and the `.phones` selector so all three phones land in one row. 00 is a copy of
  `current/play-mid.png`. Largest file 125 KB.
- `10-threat-layer.html`: added `--cool-ink` (dark `#3FC9E8`, light `#0B7A96` under
  `html[data-theme="light"]`) and pointed the two cyan *text* marks at it: the board label
  "your 5 options · all clear" and the bold "Safety" cell in the palette table. Both measured
  1.78:1 against the light background. The cyan rings and dashed outlines keep `--cool`; they are
  large marks and stay legible. Nothing changes in dark theme.

### Checks done
- Read a full-page 1400px screenshot of 10, 11, 12, 16 and 17. No duplicated bodies, no broken
  figures, and every page carries the full skeleton (lede, meta chips, figures, callouts list,
  Trade-offs, What it answers, Cost). No edits were needed.
- Horizontal overflow at 1000 and 760 px on those five and on index.html: zero offending elements.
  Page 17 reports 78 SVG children outside each board, which is the page cropping a full 16x9 board
  to `viewBox="104 52 416 312"` on purpose, not a bug.
- Text clipping (`scrollWidth > clientWidth`) at 1400 and 1000: none.
- Callout markers against their `.callouts` lists: 10 has 6+4+4, 11 has 9, 12 has 5+4+3, 16 has 6,
  17 has 5. Every figure matches its list and no two markers overlap.
- Light theme on 03, 05, 07, 10 and 16: screenshot plus a computed-contrast sweep over every text
  node. Only page 10 needed the fix above.

### Still not done
- `.req` meta chips use `#85B7EB` and measure 1.92:1 against the light background on all 19 pages.
  The colour lives in `shared/mock.css`, which this pass was not allowed to modify. It wants a
  darker blue under `html[data-theme="light"]`.
- Light theme on the 14 pages outside 03, 05, 07, 10, 16.
- Nav link check.
- Prose sanity read against the design doc.
