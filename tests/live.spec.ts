import { randomBytes } from 'node:crypto';
import { expect, test, type Browser, type BrowserContext, type Page } from '@playwright/test';

declare global {
  interface Window {
    __wire: string[];
  }
}

// Relay discovery and the WebRTC handshake, not the app. The turn itself only
// has to cross an open data channel.
const LIVE = 60_000;
const RESOLVE = 30_000;

const CLAIM = /^!/;
const COMMIT = /^#\d{1,4}[CPTA]:[0-9a-f]{32}$/;
const REVEAL = /\|[0-9a-f]{32}$/;

// Nothing here stubs the network. The wrapper calls the real Trystero under the
// same URL with a query on it, and only stands in front of the room's message
// action, because the app exposes no global to wrap.
//
// The room and the action are mutated in place rather than copied: onPeerJoin,
// onPeerLeave and onMessage are accessors, and a copy would drop their setters.
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

async function open(browser: Browser, label: string): Promise<Page> {
  const context = await browser.newContext();
  contexts.push(context);
  const page = await context.newPage();
  page.on('pageerror', (e) => errors.push(`page ${label}: ${e.message}`));
  await page.addInitScript(() => { window.__wire = []; });

  // Everything under dist/ except the entry is a lazily loaded chunk, and
  // Trystero's is the only one. Matched by position rather than by esbuild's
  // content hash, which moves on every change to the library. The trailing
  // group keeps the sourcemaps out and lets the ?real fetch through.
  await page.route(/\/dist\/[^/?]+\.js(\?|$)/, (route) => {
    const url = new URL(route.request().url());
    if (url.pathname.endsWith('/main.js') || url.searchParams.has('real')) return route.continue();
    const file = url.pathname.split('/').pop() ?? '';
    return route.fulfill({ contentType: 'text/javascript', body: wireTap(file) });
  });
  await page.goto('/index.html');
  return page;
}

async function turnInfo(page: Page): Promise<string> {
  return (await page.locator('#turnInfo').textContent()) ?? '';
}

function wireOf(page: Page): Promise<string[]> {
  return page.evaluate(() => window.__wire);
}

async function sitDown(page: Page, label: string, color: string, name: string) {
  const row = page.locator(`#pickRows .pickrow[data-color="${color}"]`);
  await row.click();
  await row.locator('input').fill(name);
  // Play only enables once the channel reports live, so this wait is the relay
  // and the peer connection.
  await expect(
    page.locator('#btnPlay'),
    `page ${label}: the channel never reported live, so the relays or the peer connection never came up`
  ).toBeEnabled({ timeout: LIVE });
  await page.locator('#btnPlay').click();
  await expect(page.locator('#play'), `page ${label}: never reached the play screen`).toBeVisible();
}

// Coral spawns at (0,0) and Purple at (3,3), so right stays legal for Coral and
// left for Purple across the two turns this plays.
async function playTurn(a: Page, b: Page, turn: number) {
  const before = await turnInfo(a);
  expect(before).toContain(`turn ${turn} / `);
  expect(await turnInfo(b), `turn ${turn}: the two pages did not open the turn on the same state`)
    .toBe(before);

  await a.locator('#turnCard [data-act="D"]').click();
  await a.locator('#btnCommit').click();
  await expect(a.locator('#phaseShare'), `turn ${turn}: page A's commitment did not go in`)
    .toBeVisible();
  await expect(a.locator('#pending')).toHaveText('still waiting on: Vale');

  // One commitment opens nothing, and page A's own wire is where that shows.
  // A seals its action and sends only the digest, then holds the reveal until
  // every commitment is in, so this turn owes a commitment and no reveal yet.
  const held = await wireOf(a);
  expect(held.filter((t) => COMMIT.test(t)).some((t) => t.startsWith(`#${turn}C:`)),
    `turn ${turn}: page A's commitment never went out`).toBe(true);
  expect(held.filter((t) => REVEAL.test(t)).length,
    `turn ${turn}: page A revealed before page B had committed anything`).toBe(turn);

  // Page B has nothing rendered that says A's commitment landed, because the
  // waiting list only draws inside the share phase. So this is the weaker half:
  // B is still picking on the turn it started.
  expect(await turnInfo(b), `turn ${turn}: page B advanced on page A's commitment alone`)
    .toBe(before);
  await expect(b.locator('#phaseShare')).toBeHidden();

  await b.locator('#turnCard [data-act="A"]').click();
  await b.locator('#btnCommit').click();

  for (const [label, page] of [['A', a], ['B', b]] as const) {
    await expect(
      page.locator('#turnInfo'),
      `turn ${turn}: page ${label} never resolved the turn`
    ).toContainText(`turn ${turn + 1} / `, { timeout: RESOLVE });
    await expect(page.locator('#phaseShare')).toBeHidden();
  }
  expect(await turnInfo(a), `turn ${turn}: the two pages disagree on the state hash`)
    .toBe(await turnInfo(b));
}

test('two players resolve two turns over real relays', async ({ browser }) => {
  // Code.roomId hashes the whole match code, so a random seed is a room nobody
  // else is in.
  const seed = randomBytes(6).toString('hex');
  const a = await open(browser, 'A');
  const b = await open(browser, 'B');

  await a.locator('#fW').fill('4');
  await a.locator('#fH').fill('4');
  await a.locator('#fWall').fill('0');
  await a.locator('#fSeed').fill(seed);
  await a.locator('#fRoster').selectOption('CP');
  // Last, because editing the board size rewrites it.
  await a.locator('#fCap').fill('8');
  await a.locator('#btnMake').click();

  const code = await a.locator('#outCode').inputValue();
  expect(code).toBe(`M1:4x4:0:${seed}:8:CP`);

  await b.locator('#tabJoin').click();
  await b.locator('#fCode').fill(code);
  await b.locator('#btnJoin').click();

  // In parallel, because each side waits out the same relay discovery.
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

  // The check above passes on an empty array, which is also what a tap that
  // never got into the send path would leave. Count what two turns owe.
  for (const [label, wire] of [['A', wireA], ['B', wireB]] as const) {
    expect(wire.filter((t) => CLAIM.test(t)).length, `page ${label} sent no claim`)
      .toBeGreaterThanOrEqual(1);
    expect(wire.filter((t) => COMMIT.test(t)).length, `page ${label} sent under two commitments`)
      .toBeGreaterThanOrEqual(2);
    expect(wire.filter((t) => REVEAL.test(t)).length, `page ${label} sent under two reveals`)
      .toBeGreaterThanOrEqual(2);
  }
});
