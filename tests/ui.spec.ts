import { createHash, randomBytes } from 'node:crypto';
import { expect, test, type Page } from '@playwright/test';

declare global {
  interface Window {
    __tbtt: {
      peers: string[];
      sent: string[];
      action: { send: (text: string) => void; onMessage: ((text: string) => void) | null } | null;
    };
  }
}

// PeerChannel reaches the network exactly once, by dynamically importing
// Trystero. esbuild gives that import a chunk of its own, so serving the chunk
// is what keeps the suite off the network: the room it returns never opens a
// socket, and the test drives its peer list and its inbox directly.
const ROOM_STUB = `
export function joinRoom(config, roomId) {
  const hub = globalThis.__tbtt;
  return {
    onPeerJoin: null,
    onPeerLeave: null,
    getPeers() {
      const out = {};
      hub.peers.forEach((id) => { out[id] = {}; });
      return out;
    },
    makeAction() {
      hub.action = { send: (text) => hub.sent.push(String(text)), onMessage: null };
      return hub.action;
    },
    leave() {},
  };
}
`;

type Options = { peers?: string[]; offline?: boolean };

let errors: string[] = [];
let blocked: string[] = [];

test.beforeEach(({ page }) => {
  errors = [];
  blocked = [];
  page.on('pageerror', (e) => errors.push(e.message));
});

test.afterEach(() => {
  expect(errors).toEqual([]);
  expect(blocked).toEqual([]);
});

async function open(page: Page, opts: Options = {}) {
  const peers = opts.peers ?? ['stub-peer'];
  const server = test.info().project.use.baseURL ?? '';
  await page.addInitScript((ids) => {
    window.__tbtt = { peers: ids, sent: [], action: null };
  }, peers);

  // Registered first, so it only ever sees what the chunk handler below does
  // not. That handler is matched by a path, and a path is easy to outgrow. These
  // two name whatever went out instead, so the suite fails rather than dials a
  // relay.
  await page.route(/.*/, (route) => {
    const url = route.request().url();
    if (url.startsWith(server)) return route.continue();
    blocked.push(url);
    return route.abort();
  });
  await page.routeWebSocket(/.*/, (ws) => {
    blocked.push(ws.url());
    ws.close();
  });

  // Everything under dist/ except the entry is a lazily loaded chunk, and
  // Trystero's is the only one. Matched by position rather than by esbuild's
  // content hash, which moves on every change to the library.
  await page.route('**/dist/*.js', (route) => {
    if (route.request().url().endsWith('/main.js')) return route.continue();
    return opts.offline
      ? route.abort()
      : route.fulfill({ contentType: 'text/javascript', body: ROOM_STUB });
  });
  await page.goto('/index.html');
}

const MATCH = { w: '4', h: '4', wall: '0', seed: 'tst', cap: '8', roster: 'CP' };

async function createMatch(page: Page, cfg: Partial<typeof MATCH> = {}) {
  const c = { ...MATCH, ...cfg };
  await page.locator('#fW').fill(c.w);
  await page.locator('#fH').fill(c.h);
  await page.locator('#fWall').fill(c.wall);
  await page.locator('#fSeed').fill(c.seed);
  await page.locator('#fRoster').selectOption(c.roster);
  // Last, because editing the board size rewrites it.
  await page.locator('#fCap').fill(c.cap);
  await page.locator('#btnMake').click();
}

async function sitDown(page: Page, color = 'C', name = 'Rook') {
  const row = page.locator(`#pickRows .pickrow[data-color="${color}"]`);
  await row.click();
  await row.locator('input').fill(name);
  await expect(page.locator('#btnPlay')).toBeEnabled();
  await page.locator('#btnPlay').click();
  await expect(page.locator('#play')).toBeVisible();
}

async function startMatch(page: Page, opts: Options = {}) {
  await open(page, opts);
  await createMatch(page);
  await sitDown(page);
}

function deliver(page: Page, text: string) {
  return page.evaluate((t) => window.__tbtt.action?.onMessage?.(t), text);
}

async function stateHash(page: Page) {
  const info = await page.locator('#turnInfo').textContent();
  const hash = /state ([0-9a-f]{4})/.exec(info ?? '')?.[1];
  if (!hash) throw new Error(`no state hash in "${info}"`);
  return hash;
}

// The other player, played by hand: seal, then open. The preimage is pinned in
// turn-transport.md, so a change there breaks these tests rather than the seam.
function seal(turn: number, color: string, action: string) {
  const nonce = randomBytes(16).toString('hex');
  const digest = createHash('sha256')
    .update(`${turn}:${color}:${action}:${nonce}`)
    .digest('hex')
    .slice(0, 32);
  return { nonce, commitment: `#${turn}${color}:${digest}` };
}

function revealOf(turn: number, color: string, action: string, hash: string, nonce: string, name?: string) {
  const named = turn === 0 && name ? `~${name}` : '';
  return `${turn}${color}:${action}#${hash}${named}|${nonce}`;
}

// One whole turn, with the other seat played by hand: read the hash the turn
// opens on, seal against it, commit, then open. Leaves you on the next turn, or
// on the match-over panel if that was the cap.
async function resolveTurn(page: Page, turn: number, mine: string, theirs: string, name?: string) {
  const hash = await stateHash(page);
  const { nonce, commitment } = seal(turn, 'P', theirs);
  await deliver(page, commitment);
  await page.locator(`#turnCard [data-act="${mine}"]`).click();
  await page.locator('#btnCommit').click();
  await expect(page.locator('#phaseShare')).toBeVisible();
  await deliver(page, revealOf(turn, 'P', theirs, hash, nonce, name));
  await expect(page.locator('#phaseShare')).toBeHidden();
}

test.describe('setup screen', () => {
  test('loads and runs its module', async ({ page }) => {
    await open(page);
    await expect(page.getByRole('heading', { name: 'Time travel tactics — prototype' })).toBeVisible();
    await expect(page.locator('#setup')).toBeVisible();
    await expect(page.locator('#play')).toBeHidden();
    // The module ran if it filled the seed, which the markup leaves empty.
    await expect(page.locator('#fSeed')).not.toHaveValue('');
  });

  test('the tabs swap the panes', async ({ page }) => {
    await open(page);
    await page.locator('#tabJoin').click();
    await expect(page.locator('#paneJoin')).toBeVisible();
    await expect(page.locator('#paneNew')).toBeHidden();

    await page.locator('#tabImport').click();
    await expect(page.locator('#paneImport')).toBeVisible();
    await expect(page.locator('#paneJoin')).toBeHidden();

    await page.locator('#tabNew').click();
    await expect(page.locator('#paneNew')).toBeVisible();
  });

  test('the turn cap follows the board size', async ({ page }) => {
    await open(page);
    await page.locator('#fW').fill('20');
    await page.locator('#fH').fill('10');
    await expect(page.locator('#fCap')).toHaveValue('51');
  });

  test('the theme button toggles', async ({ page }) => {
    await open(page);
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
    await expect(page.locator('#btnTheme')).toHaveText('Light');

    await page.locator('#btnTheme').click();
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
    await expect(page.locator('#btnTheme')).toHaveText('Dark');
  });

  test('an oversized board is refused', async ({ page }) => {
    await open(page);
    await createMatch(page, { w: '999' });
    await expect(page.locator('#setupErr')).toHaveText('board must be between 2x2 and 64x64');
    await expect(page.locator('#pickCard')).toBeHidden();
  });

  test('a wall density over 45 is refused', async ({ page }) => {
    await open(page);
    await createMatch(page, { wall: '80' });
    await expect(page.locator('#setupErr')).toHaveText('wall density must be 0-45');
  });

  test('a seed with a space is refused', async ({ page }) => {
    await open(page);
    await createMatch(page, { seed: 'two words' });
    await expect(page.locator('#setupErr')).toHaveText('seed must be 1-24 letters, digits, - or _');
  });

  test('a turn cap over 400 is refused', async ({ page }) => {
    await open(page);
    await createMatch(page, { cap: '500' });
    await expect(page.locator('#setupErr')).toHaveText('turn cap must be 2-400');
  });

  test('a bad match code is refused', async ({ page }) => {
    await open(page);
    await page.locator('#tabJoin').click();
    await page.locator('#fCode').fill('nonsense');
    await page.locator('#btnJoin').click();
    await expect(page.locator('#setupErr')).toContainText('not a match code');
    await expect(page.locator('#pickCard')).toBeHidden();
  });

  test('a bad export is refused', async ({ page }) => {
    await open(page);
    await page.locator('#tabImport').click();
    await page.locator('#fExport').fill('M1:4x4:0:tst:8:CP');
    await page.locator('#btnImport').click();
    await expect(page.locator('#setupErr')).toContainText('it should start with X1:');
  });

  test('joining with a code opens the picker', async ({ page }) => {
    await open(page);
    await page.locator('#tabJoin').click();
    await page.locator('#fCode').fill('M1:4x4:0:tst:8:CPT');
    await page.locator('#btnJoin').click();
    await expect(page.locator('#setupErr')).toHaveText('');
    await expect(page.locator('#pickRows .pickrow')).toHaveCount(3);
  });

  test('a good export opens the picker with the names already filled in', async ({ page }) => {
    await open(page);
    await page.locator('#tabImport').click();
    await page.locator('#fExport').fill('X1:M1:4x4:0:tst:8:CP||C~Rook,P~Vale');
    await page.locator('#btnImport').click();
    await expect(page.locator('#pickRows .pickrow')).toHaveCount(2);
    await expect(page.locator('#pickRows .pickrow[data-color="C"] input')).toHaveValue('Rook');
    await expect(page.locator('#pickRows .pickrow[data-color="P"] input')).toHaveValue('Vale');
  });
});

test.describe('colour picker', () => {
  test('shows the code and one row per roster colour', async ({ page }) => {
    await open(page);
    await createMatch(page);
    await expect(page.locator('#outCode')).toHaveValue('M1:4x4:0:tst:8:CP');
    await expect(page.locator('#pickRows .pickrow')).toHaveCount(2);
    await expect(page.locator('#pickRows .pickrow[data-color="C"]')).toContainText('Coral');
    await expect(page.locator('#pickRows .pickrow[data-color="P"]')).toContainText('Purple');
    await expect(page.locator('#btnPlay')).toBeDisabled();
  });

  test('waits for a room short of players', async ({ page }) => {
    await open(page, { peers: ['one-peer'] });
    await createMatch(page, { roster: 'CPT' });
    await page.locator('#pickRows .pickrow[data-color="C"]').click();
    await page.locator('#pickRows .pickrow[data-color="C"] input').fill('Rook');
    await expect(page.locator('#pickWait')).toHaveText(
      'Waiting for 1 more player to open this match code.');
    await expect(page.locator('#btnPlay')).toBeDisabled();
  });

  test('reports a connection that never opened', async ({ page }) => {
    await open(page, { offline: true });
    await createMatch(page);
    await expect(page.locator('#pickWait')).toContainText('No connection:');
    await expect(page.locator('#btnPlay')).toBeDisabled();
  });

  test('greys out a colour someone else claimed', async ({ page }) => {
    await open(page);
    await createMatch(page);
    await expect(page.locator('#pickWait')).toHaveText('');
    await deliver(page, '!P~Rival@other-client');

    const taken = page.locator('#pickRows .pickrow[data-color="P"]');
    await expect(taken).toHaveClass(/taken/);
    await expect(taken).toHaveCSS('opacity', '0.45');
    await expect(taken.locator('.who')).toHaveText('Rival');
    await expect(page.locator('#pickRows .pickrow[data-color="C"]')).not.toHaveClass(/taken/);
  });

  test('refuses a name with a space', async ({ page }) => {
    await open(page);
    await createMatch(page);
    const row = page.locator('#pickRows .pickrow[data-color="C"]');
    await row.click();
    await row.locator('input').fill('my name');
    await expect(page.locator('#nameErr')).toHaveText(
      'A name can only use letters, digits, - and _, up to 12 characters.');
    await expect(page.locator('#btnPlay')).toBeDisabled();

    await row.locator('input').fill('Rook');
    await expect(page.locator('#nameErr')).toHaveText('');
    await expect(page.locator('#btnPlay')).toBeEnabled();
  });

  test('the copy button says Copied, then goes back to saying what it copies', async ({ page, context }) => {
    await context.grantPermissions(['clipboard-read', 'clipboard-write']);
    await open(page);
    await createMatch(page);
    await expect(page.locator('#btnCopyCode')).toHaveText('Copy match code');
    await page.locator('#btnCopyCode').click();
    await expect(page.locator('#btnCopyCode')).toHaveText('Copied');
    await expect(page.locator('#btnCopyCode')).toHaveText('Copy match code', { timeout: 3000 });
  });
});

test.describe('play screen', () => {
  test('draws the board and names the seat', async ({ page }) => {
    await startMatch(page);
    await expect(page.locator('#setup')).toBeHidden();
    await expect(page.locator('#board .cell')).toHaveCount(16);
    await expect(page.locator('#youAre')).toHaveText('Rook');
    await expect(page.locator('#youAt')).toHaveText('index 0 · t0 · forward · (0,0)');
    await expect(page.locator('#turnInfo')).toContainText('turn 0 / 8');
    await expect(page.locator('#netInfo')).toHaveText('turns move: live · 1 peer');
    await expect(page.locator('#rdNote')).toHaveText('look back caps at 2 — a quarter of the 8-turn cap');
    await expect(page.locator('#legend')).toContainText('Rook');
    await expect(page.locator('#log li')).toHaveText('Nothing yet.');
    await expect(page.locator('#phasePick')).toBeVisible();
    await expect(page.locator('#phaseShare')).toBeHidden();
    await expect(page.locator('#phaseOver')).toBeHidden();
  });

  test('preselects hold and follows the pad', async ({ page }) => {
    await startMatch(page);
    await expect(page.locator('#btnCommit')).toHaveText('Commit hold');
    await expect(page.locator('#turnCard [data-act="H"]')).toHaveClass(/sel/);

    await page.locator('#turnCard [data-act="D"]').click();
    await expect(page.locator('#btnCommit')).toHaveText('Commit right');
    await expect(page.locator('#turnCard [data-act="D"]')).toHaveClass(/sel/);
    await expect(page.locator('#turnCard [data-act="H"]')).not.toHaveClass(/sel/);
  });

  test('disables a move off the board', async ({ page }) => {
    await startMatch(page);
    // Coral spawns at (0,0), so up and left leave the board.
    await expect(page.locator('#turnCard [data-act="W"]')).toBeDisabled();
    await expect(page.locator('#turnCard [data-act="A"]')).toBeDisabled();
    await expect(page.locator('#turnCard [data-act="D"]')).toBeEnabled();
  });

  test('committing offers the action back until someone seals against it', async ({ page }) => {
    await startMatch(page);
    await page.locator('#turnCard [data-act="D"]').click();
    await page.locator('#btnCommit').click();

    await expect(page.locator('#phaseShare')).toBeVisible();
    await expect(page.locator('#phasePick')).toBeHidden();
    await expect(page.locator('#pending')).toHaveText('still waiting on: Purple');
    await expect(page.locator('#btnUndo')).toBeVisible();

    await page.locator('#btnUndo').click();
    await expect(page.locator('#phasePick')).toBeVisible();
    await expect(page.locator('#phaseShare')).toBeHidden();
    await expect(page.locator('#btnCommit')).toHaveText('Commit hold');
  });

  test('a resolved turn moves the board, the log and the status line', async ({ page }) => {
    await startMatch(page);
    const hash = await stateHash(page);
    const { nonce, commitment } = seal(0, 'P', 'H');
    await deliver(page, commitment);

    await page.locator('#turnCard [data-act="D"]').click();
    await page.locator('#btnCommit').click();
    await expect(page.locator('#phaseShare')).toBeVisible();
    // Everyone sealed, so there is nothing left to take back.
    await expect(page.locator('#pending')).toHaveText('everyone is in, opening');
    await expect(page.locator('#btnUndo')).toBeHidden();

    await deliver(page, revealOf(0, 'P', 'H', hash, nonce, 'Rival'));

    await expect(page.locator('#turnInfo')).toContainText('turn 1 / 8');
    await expect(page.locator('#youAt')).toHaveText('index 1 · t1 · forward · (1,0)');
    await expect(page.locator('#log li')).toHaveCount(2);
    await expect(page.locator('#log')).toContainText('Rook moved to (1,0) at t1');
    await expect(page.locator('#log')).toContainText('Rival held (3,3)');
    await expect(page.locator('#legend')).toContainText('Rival');
    await expect(page.locator('#phasePick')).toBeVisible();
    await expect(page.locator('#slo')).toHaveText('1');
  });

  test('the world turn slider scrubs the playhead back', async ({ page }) => {
    await startMatch(page);
    const hash = await stateHash(page);
    const { nonce, commitment } = seal(0, 'P', 'H');
    await deliver(page, commitment);
    await page.locator('#turnCard [data-act="D"]').click();
    await page.locator('#btnCommit').click();
    await expect(page.locator('#phaseShare')).toBeVisible();
    await deliver(page, revealOf(0, 'P', 'H', hash, nonce));
    await expect(page.locator('#slo')).toHaveText('1');

    await expect(page.locator('#board .tok')).toHaveCount(2);
    await expect(page.locator('#board .trail')).toHaveCount(2);

    await page.locator('#sl').press('Home');
    await expect(page.locator('#slo')).toHaveText('0');
    await expect(page.locator('#board .tok')).toHaveCount(2);
    // Nothing sits before t0, so the trail empties.
    await expect(page.locator('#board .trail')).toHaveCount(0);
    await expect(page.locator('#board .tok').first()).toHaveAttribute('title', /world turn 0/);

    await page.locator('#sl').press('End');
    await expect(page.locator('#slo')).toHaveText('1');
    await expect(page.locator('#board .trail')).toHaveCount(2);
  });

  test('the look back slider drops the trail', async ({ page }) => {
    await startMatch(page);
    const hash = await stateHash(page);
    const { nonce, commitment } = seal(0, 'P', 'H');
    await deliver(page, commitment);
    await page.locator('#turnCard [data-act="D"]').click();
    await page.locator('#btnCommit').click();
    await expect(page.locator('#phaseShare')).toBeVisible();
    await deliver(page, revealOf(0, 'P', 'H', hash, nonce));
    await expect(page.locator('#board .trail')).toHaveCount(2);

    await expect(page.locator('#rdo')).toHaveText('2');
    await page.locator('#rd').press('Home');
    await expect(page.locator('#rdo')).toHaveText('0');
    await expect(page.locator('#board .trail')).toHaveCount(0);
    await expect(page.locator('#board .tok')).toHaveCount(2);
  });

  test('losing the seat sends you back to the picker', async ({ page }) => {
    await startMatch(page);
    // PeerChannel ids start with "p-", so a claim from "0-" outranks ours.
    await deliver(page, '!C~Thief@0-lower');

    await expect(page.locator('#setup')).toBeVisible();
    await expect(page.locator('#play')).toBeHidden();
    await expect(page.locator('#pickErr')).toContainText('Coral was claimed first by Thief');
  });

  test('the export box carries the match', async ({ page }) => {
    await startMatch(page);
    await expect(page.locator('#outExport')).toHaveValue('X1:M1:4x4:0:tst:8:CP||C~Rook');
  });

  test('priority names both seats, and the note under the pad explains the aim', async ({ page }) => {
    await startMatch(page);
    await expect(page.locator('#prioInfo')).toContainText('Rook');
    await expect(page.locator('#prioInfo')).toContainText('\u203a');
    await expect(page.locator('#pickWhy')).toContainText('Holding costs a world turn');
    await page.locator('#turnCard [data-act="I"]').click();
    await expect(page.locator('#pickWhy')).toContainText('Inverting keeps your world turn');
  });

  test('a claim names the other seat before a single turn resolves', async ({ page }) => {
    await startMatch(page);
    await expect(page.locator('#prioInfo')).toContainText('Purple');
    await deliver(page, '!P~Rival@other-client');
    await expect(page.locator('#prioInfo')).toContainText('Rival');
    await expect(page.locator('#prioInfo')).not.toContainText('Purple');
  });

  test('the log rules off between turns', async ({ page }) => {
    await startMatch(page);
    await resolveTurn(page, 0, 'H', 'H', 'Rival');
    await expect(page.locator('#log li.turnsep')).toHaveCount(0);
    await resolveTurn(page, 1, 'H', 'H');
    // Two turns, two rows each, and one rule between them.
    await expect(page.locator('#log li.turnsep')).toHaveCount(1);
    await expect(page.locator('#log li')).toHaveCount(5);
  });

  test('switching theme redraws the trail at the new floor', async ({ page }) => {
    // --dot-floor is 0.22 dark and 0.14 light, and shade() reads it off computed
    // style. Three turns, so there are two history turns and the older one sits
    // on the floor rather than on a flat 1.
    await startMatch(page);
    await resolveTurn(page, 0, 'H', 'H', 'Rival');
    await resolveTurn(page, 1, 'H', 'H');
    await resolveTurn(page, 2, 'H', 'H');
    const faded = page.locator('#board .trail').last();
    await expect(faded).toHaveAttribute('style', /opacity: 0\.22/);

    await page.locator('#btnTheme').click();
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
    await expect(faded).toHaveAttribute('style', /opacity: 0\.14/);
  });

  test('the turn cap freezes the match', async ({ page }) => {
    await open(page);
    await createMatch(page, { cap: '2' });
    await sitDown(page);
    await resolveTurn(page, 0, 'H', 'H', 'Rival');
    await resolveTurn(page, 1, 'H', 'H');

    await expect(page.locator('#phaseOver')).toBeVisible();
    await expect(page.locator('#phasePick')).toBeHidden();
    await expect(page.locator('#phaseShare')).toBeHidden();
    await expect(page.locator('#turnInfo')).toHaveText('match over at turn 2');
    await expect(page.locator('#prioInfo')).toHaveText('the match is over');
    // Still scrubbable, which is the whole point of freezing rather than leaving.
    await expect(page.locator('#board .cell')).toHaveCount(16);
  });

  test('the look back slider caps at a quarter of the turn cap', async ({ page }) => {
    await open(page);
    await createMatch(page, { cap: '40' });
    await sitDown(page);
    await expect(page.locator('#rdNote')).toHaveText('look back caps at 10 \u2014 a quarter of the 40-turn cap');
    await expect(page.locator('#rdo')).toHaveText('10');
    await expect(page.locator('#rd')).toHaveAttribute('max', '10');
  });
});
