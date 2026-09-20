import { randomBytes } from 'node:crypto';
import { expect, test, type Browser, type BrowserContext, type Page } from '@playwright/test';

declare global {
  interface Window {
    __wire: string[];
  }
}

const LIVE = 60_000;
const RESOLVE = 30_000;

const CLAIM = /^!/;
const COMMIT = /^#\d{1,4}[CPTA]:[0-9a-f]{32}$/;
const REVEAL = /\|[0-9a-f]{32}$/;

// Wrap the room in place because its callbacks are accessors.
function wireTap(file: string): string {
  return `
import { joinRoom as real } from './${file}?real';
export * from './${file}?real';

export function joinRoom(config, roomId) {
  const room = real(config, roomId);
  const make = room.makeAction.bind(room);
  room.makeAction = (ns, cfg) => {
    const action = make(ns, cfg);
    const send = action.send.bind(action);
    action.send = (data, ...rest) => {
      window.__wire.push(String(data));
      return send(data, ...rest);
    };
    return action;
  };
  return room;
}
`;
}

let contexts: BrowserContext[] = [];
let errors: string[] = [];

test.beforeEach(() => {
  contexts = [];
  errors = [];
});

test.afterEach(async () => {
  await Promise.all(contexts.map((c) => c.close()));
  contexts = [];
  expect(errors).toEqual([]);
});

async function open(browser: Browser, label: string, fragment = ''): Promise<Page> {
  const context = await browser.newContext();
  contexts.push(context);
  const page = await context.newPage();
  page.on('pageerror', (e) => errors.push(`page ${label}: ${e.message}`));
  await page.addInitScript(() => { window.__wire = []; });

  // Intercept the content-hashed lazy chunk but leave source maps and ?real alone.
  await page.route(/\/dist\/[^/?]+\.js(\?|$)/, (route) => {
    const url = new URL(route.request().url());
    if (url.pathname.endsWith('/main.js') || url.searchParams.has('real')) return route.continue();
    const file = url.pathname.split('/').pop() ?? '';
    return route.fulfill({ contentType: 'text/javascript', body: wireTap(file) });
  });
  await page.goto('/index.html' + (fragment ? '#' + fragment : ''));
  return page;
}

async function turnInfo(page: Page): Promise<string> {
  return (await page.locator('#turnInfo').textContent()) ?? '';
}

// The turn and the state hash sit in separate spans.
async function stateHash(page: Page): Promise<string> {
  const info = await page.locator('#hashInfo').textContent();
  const hash = /state ([0-9a-f]{4})/.exec(info ?? '')?.[1];
  if (!hash) throw new Error(`no state hash in "${info}"`);
  return hash;
}

// The dot row carries per-player commitment; its order follows this turn's priority.
function dotStates(page: Page): Promise<Record<string, string>> {
  return page.locator('#pending .pdot').evaluateAll(
    (els) => Object.fromEntries(els.map((e) => [e.dataset.color ?? '', e.dataset.state ?? '']))
  );
}

function wireOf(page: Page): Promise<string[]> {
  return page.evaluate(() => window.__wire);
}

async function sitDown(page: Page, label: string, color: string, name: string) {
  const row = page.locator(`#pickRows .pickrow[data-color="${color}"]`);
  await row.click();
  await page.locator('#pickName').fill(name);
  await expect(
    page.locator('#btnPlay'),
    `page ${label}: the channel never reported live, so the relays or the peer connection never came up`
  ).toBeEnabled({ timeout: LIVE });
  await page.locator('#btnPlay').click();
  await expect(page.locator('#play'), `page ${label}: never reached the play screen`).toBeVisible();
}

async function createMatch(page: Page, cfg: { mode: string; seed: string; cap: string }) {
  await page.locator('#fMode').selectOption(cfg.mode);
  await page.locator('#fW').fill('5');
  await page.locator('#fH').fill('5');
  await page.locator('#fWall').fill('0');
  await page.locator('#fSeed').fill(cfg.seed);
  await page.locator('#fRoster').selectOption('CP');
  await page.locator('#fCap').fill(cfg.cap);
  await page.locator('#btnMake').click();
  return `M1:${cfg.mode}:5x5:0:${cfg.seed}:${cfg.cap}:CP`;
}

// Both pages commit the given actions; the turn is done when both leave the share phase.
async function playActions(a: Page, b: Page, turn: number, actA: string, actB: string) {
  const before = await turnInfo(a);
  expect(before).toContain(`turn ${turn} / `);
  expect(await turnInfo(b), `turn ${turn}: the two pages did not open the same turn`).toBe(before);
  expect(await stateHash(b), `turn ${turn}: the two pages did not open the turn on the same state`)
    .toBe(await stateHash(a));
  await a.locator(`#moveRail [data-act="${actA}"]`).click();
  await a.locator('#btnCommit').click();
  await b.locator(`#moveRail [data-act="${actB}"]`).click();
  await b.locator('#btnCommit').click();
  for (const [label, page] of [['A', a], ['B', b]] as const) {
    await expect(page.locator('#turnInfo'), `turn ${turn}: page ${label} never resolved the turn`)
      .not.toHaveText(before, { timeout: RESOLVE });
    await expect(page.locator('#phaseShare')).toBeHidden();
  }
  // A finished match reads "You won" on one side, so only compare the turn while it is running.
  const after = await turnInfo(a);
  if (after.startsWith('turn ')) {
    expect(after, `turn ${turn}: the two pages disagree on the turn`).toBe(await turnInfo(b));
  }
  expect(await stateHash(a), `turn ${turn}: the two pages disagree on the state hash`)
    .toBe(await stateHash(b));
}

async function playTurn(a: Page, b: Page, turn: number) {
  const before = await turnInfo(a);
  expect(before).toContain(`turn ${turn} / `);
  expect(await turnInfo(b), `turn ${turn}: the two pages did not open the same turn`).toBe(before);
  expect(await stateHash(b), `turn ${turn}: the two pages did not open the turn on the same state`)
    .toBe(await stateHash(a));

  await a.locator('#moveRail [data-act="D"]').click();
  await a.locator('#btnCommit').click();
  await expect(a.locator('#phaseShare'), `turn ${turn}: page A's commitment did not go in`)
    .toBeVisible();
  await expect
    .poll(() => dotStates(a), { message: `turn ${turn}: page A does not show page B still choosing` })
    .toEqual({ C: 'done', P: 'choosing' });
  await expect(a.locator('#pending'), `turn ${turn}: page A never learned page B's name`)
    .toHaveAttribute('title', /Still choosing: Vale\./);

  const held = await wireOf(a);
  expect(held.filter((t) => COMMIT.test(t)).some((t) => t.startsWith(`#${turn}C:`)),
    `turn ${turn}: page A's commitment never went out`).toBe(true);
  expect(held.filter((t) => REVEAL.test(t)).length,
    `turn ${turn}: page A revealed before page B had committed anything`).toBe(turn);

  expect(await turnInfo(b), `turn ${turn}: page B advanced on page A's commitment alone`)
    .toBe(before);
  await expect(b.locator('#phaseShare')).toBeHidden();

  await b.locator('#moveRail [data-act="A"]').click();
  await b.locator('#btnCommit').click();

  for (const [label, page] of [['A', a], ['B', b]] as const) {
    await expect(
      page.locator('#turnInfo'),
      `turn ${turn}: page ${label} never resolved the turn`
    ).toContainText(`turn ${turn + 1} / `, { timeout: RESOLVE });
    await expect(page.locator('#phaseShare')).toBeHidden();
  }
  expect(await turnInfo(a), `turn ${turn}: the two pages disagree on the turn`)
    .toBe(await turnInfo(b));
  expect(await stateHash(a), `turn ${turn}: the two pages disagree on the state hash`)
    .toBe(await stateHash(b));
}

test('two players resolve two turns over real relays', async ({ browser }) => {
  const seed = randomBytes(6).toString('hex');
  const a = await open(browser, 'A');

  const code = await createMatch(a, { mode: 'bootstrap', seed, cap: '8' });
  const b = await open(browser, 'B', 'join=' + encodeURIComponent(code));
  await expect(b.locator('#pickRows .pickrow')).toHaveCount(2);

  await Promise.all([sitDown(a, 'A', 'C', 'Rook'), sitDown(b, 'B', 'P', 'Vale')]);

  await playTurn(a, b, 0);
  await playTurn(a, b, 1);

  const wireA = await wireOf(a);
  const wireB = await wireOf(b);

  const bad = [...wireA, ...wireB].filter(
    (t) => !(CLAIM.test(t) || COMMIT.test(t) || REVEAL.test(t))
  );
  expect(bad, 'a page sent something that is neither a claim, a commitment nor a reveal')
    .toEqual([]);

  for (const [label, wire] of [['A', wireA], ['B', wireB]] as const) {
    expect(wire.filter((t) => CLAIM.test(t)).length, `page ${label} sent no claim`)
      .toBeGreaterThanOrEqual(1);
    expect(wire.filter((t) => COMMIT.test(t)).length, `page ${label} sent under two commitments`)
      .toBeGreaterThanOrEqual(2);
    expect(wire.filter((t) => REVEAL.test(t)).length, `page ${label} sent under two reveals`)
      .toBeGreaterThanOrEqual(2);
  }
});

test('a bootstrap win is reported on both sides over real relays', async ({ browser }) => {
  const seed = randomBytes(6).toString('hex');
  const a = await open(browser, 'A');
  const code = await createMatch(a, { mode: 'bootstrap', seed, cap: '12' });
  const b = await open(browser, 'B', 'join=' + encodeURIComponent(code));
  await expect(b.locator('#pickRows .pickrow')).toHaveCount(2);

  await Promise.all([sitDown(a, 'A', 'C', 'Rook'), sitDown(b, 'B', 'P', 'Vale')]);

  // Coral steps beside the center, picks up the key, turns around, and holds home at t0.
  await playActions(a, b, 0, 'D', 'H');
  await expect(a.locator('#log')).toContainText('Rook picked up the key at (2,1) t1');
  await playActions(a, b, 1, 'I', 'H');
  await playActions(a, b, 2, 'H', 'H');

  await expect(a.locator('#phaseOver'), 'page A never saw the match end').toBeVisible({ timeout: RESOLVE });
  await expect(a.locator('#phaseOver h3')).toHaveText('You won');
  await expect(b.locator('#phaseOver'), 'page B never saw the match end').toBeVisible({ timeout: RESOLVE });
  await expect(b.locator('#phaseOver h3')).toHaveText('Rook won');
});
