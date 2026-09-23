import { createHash, randomBytes } from 'node:crypto';
import { expect, test, type Page } from '@playwright/test';

declare global {
  interface Window {
    __tbtt: {
      peers: string[];
      sent: string[];
      action: {
        send: (text: string) => void;
        onMessage: ((text: string, context: { peerId: string }) => void) | null;
      } | null;
    };
    __historyCalls?: Array<{ state: unknown; title: string; url: string | null }>;
  }
}

// Stub Trystero's lazy chunk to keep UI tests off the network.
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

type Options = { peers?: string[]; offline?: boolean; fragment?: string };

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

  // Block every request outside the test server.
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

  // The lazy Trystero chunk has a content-hashed name.
  await page.route('**/dist/*.js', (route) => {
    if (route.request().url().endsWith('/main.js')) return route.continue();
    return opts.offline
      ? route.abort()
      : route.fulfill({ contentType: 'text/javascript', body: ROOM_STUB });
  });
  await page.goto('/index.html' + (opts.fragment ? '#' + opts.fragment : ''));
}

const MATCH = { mode: 'sandbox', w: '5', h: '5', wall: '0', seed: 'tst', cap: '8', roster: 'CP' };

async function createMatch(page: Page, cfg: Partial<typeof MATCH> = {}) {
  const c = { ...MATCH, ...cfg };
  await page.locator('#fMode').selectOption(c.mode);
  await page.locator('#fW').fill(c.w);
  await page.locator('#fH').fill(c.h);
  await page.locator('#fWall').fill(c.wall);
  await page.locator('#fSeed').fill(c.seed);
  await page.locator('#fRoster').selectOption(c.roster);
  await page.locator('#fCap').fill(c.cap);
  await page.locator('#btnMake').click();
}

async function sitDown(page: Page, color = 'C', name = 'Rook') {
  const row = page.locator(`#pickRows .pickrow[data-color="${color}"]`);
  await row.click();
  await page.locator('#pickName').fill(name);
  await expect(page.locator('#btnPlay')).toBeEnabled();
  await page.locator('#btnPlay').click();
  await expect(page.locator('#play')).toBeVisible();
}

async function startMatch(page: Page, opts: Options = {}) {
  await open(page, opts);
  await createMatch(page);
  await sitDown(page);
}

function deliver(page: Page, text: string, peerId = 'stub-peer') {
  return page.evaluate(
    ([t, id]) => window.__tbtt.action?.onMessage?.(t, { peerId: id }),
    [text, peerId] as const,
  );
}

async function stateHash(page: Page) {
  const info = await page.locator('#hashInfo').textContent();
  const hash = /state ([0-9a-f]{4})/.exec(info ?? '')?.[1];
  if (!hash) throw new Error(`no state hash in "${info}"`);
  return hash;
}

// The dot row carries priority order and per-player commitment.
function dots(page: Page) {
  return page.locator('#pending .pdot');
}
function dotOrder(page: Page) {
  return dots(page).evaluateAll((els) => els.map((e) => e.getAttribute('data-color')));
}
function dotStates(page: Page) {
  return dots(page).evaluateAll((els) => els.map((e) => e.getAttribute('data-state')));
}

// Simulate the other player's commit.
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

// Commit one turn and hand back the opponent's reveal, so a probe can straddle the resolution.
async function commitTurn(page: Page, turn: number, mine: string, theirs: string, name?: string) {
  const hash = await stateHash(page);
  const { nonce, commitment } = seal(turn, 'P', theirs);
  await deliver(page, commitment);
  await page.locator(`#moveRail [data-act="${mine}"]`).click();
  await page.locator('#btnCommit').click();
  await expect(page.locator('#phaseShare')).toBeVisible();
  return () => deliver(page, revealOf(turn, 'P', theirs, hash, nonce, name));
}

// Resolve one turn with a simulated opponent.
async function resolveTurn(page: Page, turn: number, mine: string, theirs: string, name?: string) {
  const reveal = await commitTurn(page, turn, mine, theirs, name);
  await reveal();
  await expect(page.locator('#phaseShare')).toBeHidden();
}

test.describe('setup screen', () => {
  test('loads and runs its module', async ({ page }) => {
    await open(page);
    await expect(page.getByRole('heading', { name: 'Time travel tactics' })).toBeVisible();
    await expect(page.locator('#setup')).toBeVisible();
    await expect(page.locator('#play')).toBeHidden();
    await expect(page.locator('#fSeed')).not.toHaveValue('');
  });

  test('shows only the new match form initially', async ({ page }) => {
    await open(page);
    await expect(page.locator('#paneNew')).toBeVisible();
    await expect(page.locator('#paneJoin')).toHaveCount(0);
    await expect(page.locator('#paneImport')).toHaveCount(0);
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
    await expect(page.locator('#setupErr')).toHaveText('board must be between 5x5 and 64x64');
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

  test('opens a valid join deep link directly in the picker', async ({ page }) => {
    await open(page, { fragment: 'join=' + encodeURIComponent('M1:sandbox:5x5:0:tst:8:CP') });
    await expect(page.locator('#pickRows .pickrow')).toHaveCount(2);
    await expect(page.locator('#setupErr')).toHaveCount(0);
    await expect(page.locator('#paneJoin')).toHaveCount(0);
  });

  test('opens a valid resume deep link with saved names', async ({ page }) => {
    const exported = 'X1:M1:sandbox:5x5:0:tst:8:CP||C~Rook,P~Vale';
    await open(page, { fragment: 'resume=' + encodeURIComponent(exported) });
    await expect(page.locator('#pickRows .pickrow')).toHaveCount(2);
    await page.locator('#pickRows .pickrow[data-color="C"]').click();
    await expect(page.locator('#pickName')).toHaveValue('Rook');
    await expect(page.locator('#pickName')).toBeDisabled();
    await expect(page.locator('#paneImport')).toHaveCount(0);
  });

  test('returns malformed recognized deep links to New match with an error', async ({ page }) => {
    await open(page, { fragment: 'join=' + encodeURIComponent('not-a-match') });
    await expect(page.locator('#paneNew')).toBeVisible();
    await expect(page.locator('#pickCard')).toHaveCount(0);
    await expect(page.locator('#setupErr')).toContainText('not a match code');
  });

  test('replaces the join URL on create, play, and completed turns', async ({ page }) => {
    await page.addInitScript(() => {
      window.__historyCalls = [];
      const replace = history.replaceState.bind(history);
      history.replaceState = (state, title, url) => {
        window.__historyCalls!.push({ state, title, url: url == null ? null : String(url) });
        replace(state, title, url);
      };
    });
    await open(page);
    const historyLength = await page.evaluate(() => history.length);
    await createMatch(page);
    await expect.poll(() => page.evaluate(() => location.hash))
      .toBe('#join=' + encodeURIComponent('M1:sandbox:5x5:0:tst:8:CP'));
    await expect.poll(() => page.evaluate(() => window.__historyCalls?.length ?? 0)).toBe(1);

    await sitDown(page);
    await expect.poll(() => page.evaluate(() => location.hash)).toMatch(/^#resume=/);
    await expect.poll(() => page.evaluate(() => window.__historyCalls?.length ?? 0)).toBe(2);
    expect(await page.evaluate(() => history.length)).toBe(historyLength);

    await resolveTurn(page, 0, 'H', 'H', 'Vale');
    await expect.poll(() => page.evaluate(() => window.__historyCalls?.length ?? 0)).toBe(3);
    await expect.poll(() => page.evaluate(() => decodeURIComponent(location.hash.slice('#resume='.length))))
      .toBe('X1:M1:sandbox:5x5:0:tst:8:CP|CHPH|C~Rook,P~Vale');
    expect(await page.evaluate(() => history.length)).toBe(historyLength);
  });

  test('New match resets the lobby and clears the fragment', async ({ page }) => {
    await open(page);
    const oldSeed = await page.locator('#fSeed').inputValue();
    await createMatch(page);
    await page.getByRole('button', { name: 'New match' }).click();
    await expect(page.locator('#pickCard')).toHaveCount(0);
    await expect(page.locator('#paneNew')).toBeVisible();
    await expect.poll(() => page.evaluate(() => location.hash)).toBe('');
    await expect(page.locator('#fSeed')).not.toHaveValue(oldSeed);
  });

  test('New match during play confirms before closing the session', async ({ page }) => {
    await startMatch(page);
    let prompt = '';
    page.once('dialog', async (dialog) => {
      prompt = dialog.message();
      await dialog.accept();
    });
    await page.getByRole('button', { name: 'New match' }).click();
    expect(prompt).toMatch(/new match/i);
    await expect(page.locator('#play')).toBeHidden();
    await expect(page.locator('#setup')).toBeVisible();
    await expect.poll(() => page.evaluate(() => location.hash)).toBe('');
  });

  test('cancelling New match keeps the active session and resume fragment', async ({ page }) => {
    await startMatch(page);
    const fragment = await page.evaluate(() => location.hash);
    page.once('dialog', async (dialog) => { await dialog.dismiss(); });
    await page.getByRole('button', { name: 'New match' }).click();
    await expect(page.locator('#play')).toBeVisible();
    await expect(page.locator('#setup')).toBeHidden();
    await expect.poll(() => page.evaluate(() => location.hash)).toBe(fragment);
  });

  test('rejects malformed resume links without replacing their fragment', async ({ page }) => {
    const fragment = 'resume=' + encodeURIComponent('not-an-export');
    await open(page, { fragment });
    await expect(page.locator('#paneNew')).toBeVisible();
    await expect(page.locator('#setupErr')).toContainText('not an export');
    await expect.poll(() => page.evaluate(() => location.hash)).toBe('#' + fragment);
  });

  test('rejects invalid percent encoding without replacing the fragment', async ({ page }) => {
    const fragment = 'resume=%E0%A4%A';
    await open(page, { fragment });
    await expect(page.locator('#paneNew')).toBeVisible();
    await expect(page.locator('#setupErr')).toContainText('malformed');
    await expect.poll(() => page.evaluate(() => location.hash)).toBe('#' + fragment);
  });
});

test.describe('colour picker', () => {
  test('shows join-link controls and one row per roster colour', async ({ page }) => {
    await open(page);
    await createMatch(page);
    await expect(page.locator('#btnCopyJoin')).toHaveText('Copy join link');
    await expect(page.locator('#pickRows .pickrow')).toHaveCount(2);
    await expect(page.locator('#pickRows .pickrow[data-color="C"]')).toContainText('Coral');
    await expect(page.locator('#pickRows .pickrow[data-color="P"]')).toContainText('Purple');
    await expect(page.locator('#btnPlay')).toBeDisabled();
  });

  test('waits for a room short of players', async ({ page }) => {
    await open(page, { peers: ['one-peer'] });
    await createMatch(page, { roster: 'CPT' });
    await page.locator('#pickRows .pickrow[data-color="C"]').click();
    await page.locator('#pickName').fill('Rook');
    await expect(page.locator('#pickWait')).toHaveText(
      'Waiting for 1 player.');
    await expect(page.locator('#btnPlay')).toBeDisabled();
  });

  test('reports a connection that never opened', async ({ page }) => {
    await open(page, { offline: true });
    await createMatch(page);
    await expect(page.locator('#pickWait')).toContainText('Could not connect.');
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
    await taken.click();
    await expect(page.locator('#pickName')).toHaveValue('Rival');
    await expect(page.locator('#pickName')).toBeDisabled();
    await expect(page.locator('#pickRows .pickrow[data-color="C"]')).not.toHaveClass(/taken/);
  });

  test('keeps the shared name draft when switching among free colours', async ({ page }) => {
    await open(page);
    await createMatch(page);
    const coral = page.locator('#pickRows .pickrow[data-color="C"]');
    const purple = page.locator('#pickRows .pickrow[data-color="P"]');
    await coral.click();
    await page.locator('#pickName').fill('Rook');
    await purple.click();
    await expect(page.locator('#pickName')).toHaveValue('Rook');

    await deliver(page, '!P~Rival@other-client');
    await expect(page.locator('#pickName')).toHaveValue('Rival');
    await expect(page.locator('#pickName')).toBeDisabled();
    await coral.click();
    await expect(page.locator('#pickName')).toHaveValue('Rook');
    await expect(page.locator('#pickName')).toBeEnabled();
  });

  test('lets occupied colours be inspected and shows their disabled name', async ({ page }) => {
    await open(page);
    await createMatch(page);
    await deliver(page, '!P~Rival@other-client');
    const taken = page.locator('#pickRows .pickrow[data-color="P"]');
    await taken.click();
    await expect(page.locator('#pickName')).toHaveValue('Rival');
    await expect(page.locator('#pickName')).toBeDisabled();
    await expect(taken).toHaveClass(/taken/);
  });

  test('a collision loser returns to the lobby with the contested colour selected', async ({ page }) => {
    await startMatch(page);
    await deliver(page, '!C~Thief@0-lower');
    const contested = page.locator('#pickRows .pickrow[data-color="C"]');
    await expect(contested).toHaveClass(/on/);
    await expect(page.locator('#pickName')).toHaveValue('Thief');
    await expect(page.locator('#pickName')).toBeDisabled();
    await expect(page.locator('#btnPlay')).toBeDisabled();
    await expect(page.locator('#pickErr')).toContainText('Coral was claimed first by Thief');
  });

  test('refuses a name with a space', async ({ page }) => {
    await open(page);
    await createMatch(page);
    const row = page.locator('#pickRows .pickrow[data-color="C"]');
    await row.click();
    await page.locator('#pickName').fill('my name');
    await expect(page.locator('#nameErr')).toHaveText(
      'Use letters, digits, hyphens, or underscores. Max 12 characters.');
    await expect(page.locator('#btnPlay')).toBeDisabled();

    await page.locator('#pickName').fill('Rook');
    await expect(page.locator('#nameErr')).toHaveText('');
    await expect(page.locator('#btnPlay')).toBeEnabled();
  });

  test('copies the join link', async ({ page, context }) => {
    await context.grantPermissions(['clipboard-read', 'clipboard-write']);
    await open(page);
    await createMatch(page);
    await expect(page.locator('#btnCopyJoin')).toHaveText('Copy join link');
    await page.locator('#btnCopyJoin').click();
    await expect(page.locator('#btnCopyJoin')).toHaveText('Copied');
    await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toMatch(/#join=/);
  });

  test('does not report Copied when the clipboard rejects', async ({ page }) => {
    await page.addInitScript(() => {
      Object.defineProperty(navigator, 'clipboard', {
        configurable: true,
        value: { writeText: async () => { throw new Error('clipboard denied'); } }
      });
    });
    await open(page);
    await createMatch(page);
    await page.locator('#btnCopyJoin').click();
    expect(await page.locator('#btnCopyJoin').textContent()).not.toBe('Copied');
    await expect(page.locator('#copyErr')).toContainText(/copy|clipboard/i);
  });
});

test.describe('play screen', () => {
  test('draws the board and names the seat', async ({ page }) => {
    await startMatch(page);
    await expect(page.locator('#setup')).toBeHidden();
    await expect(page.locator('#board .cell')).toHaveCount(25);
    await expect(page.locator('#youAre')).toHaveText('Rook');
    await expect(page.locator('#youAt')).toHaveText('index 0 · t0 · forward · (1,1)');
    await expect(page.locator('#turnInfo')).toHaveText('turn 0 / 8');
    await expect(page.locator('#hashInfo')).toHaveText(/^state [0-9a-f]{4}$/);
    await expect(page.locator('#netInfo')).toHaveText('Connected · 1 other player');
    await expect(page.locator('#legend')).toContainText('Rook');
    await expect(page.locator('#log li')).toHaveText('No turns yet.');
    await expect(page.locator('#phasePick')).toBeVisible();
    await expect(page.locator('#phaseShare')).toBeHidden();
    await expect(page.locator('#phaseOver')).toBeHidden();
    await expect(page.locator('#outExport')).toHaveCount(0);
    await expect(page.locator('#pending')).toHaveAttribute(
      'title', 'Priority this turn: Rook › Purple. Still choosing: You, Purple.');
  });

  test('preselects hold and follows the pad', async ({ page }) => {
    await startMatch(page);
    await expect(page.locator('#btnCommit')).toHaveText('Commit hold');
    await expect(page.locator('#moveRail [data-act="H"]')).toHaveClass(/sel/);

    await page.locator('#moveRail [data-act="D"]').click();
    await expect(page.locator('#btnCommit')).toHaveText('Commit right');
    await expect(page.locator('#moveRail [data-act="D"]')).toHaveClass(/sel/);
    await expect(page.locator('#moveRail [data-act="H"]')).not.toHaveClass(/sel/);
  });

  test('disables a move off the board', async ({ page }) => {
    await startMatch(page);
    // Spawn is inset from the corner now, so walk to (0,0) first.
    await resolveTurn(page, 0, 'A', 'H', 'Rival');
    await resolveTurn(page, 1, 'W', 'H');
    await expect(page.locator('#moveRail [data-act="W"]')).toBeDisabled();
    await expect(page.locator('#moveRail [data-act="A"]')).toBeDisabled();
    await expect(page.locator('#moveRail [data-act="D"]')).toBeEnabled();
  });

  test('committing offers the action back until someone seals against it', async ({ page }) => {
    await startMatch(page);
    await page.locator('#moveRail [data-act="D"]').click();
    await page.locator('#btnCommit').click();

    await expect(page.locator('#phaseShare')).toBeVisible();
    await expect(page.locator('#phasePick')).toBeHidden();
    await expect(page.locator('#pending')).toHaveAttribute('title', /Still choosing: Purple\./);
    await expect.poll(() => dotStates(page)).toEqual(['done', 'choosing']);
    await expect(page.locator('#btnUndo')).toBeVisible();

    await page.locator('#btnUndo').click();
    await expect(page.locator('#phasePick')).toBeVisible();
    await expect(page.locator('#phaseShare')).toBeHidden();
    await expect(page.locator('#btnCommit')).toHaveText('Commit hold');
  });

  test('keeps the resume URL at the completed boundary during a partial turn', async ({ page }) => {
    await startMatch(page);
    const boundary = await page.evaluate(() => location.hash);
    await page.locator('#moveRail [data-act="D"]').click();
    await page.locator('#btnCommit').click();
    await expect(page.locator('#phaseShare')).toBeVisible();
    await expect.poll(() => page.evaluate(() => location.hash)).toBe(boundary);

    await page.reload();
    await expect(page.locator('#pickCard')).toBeVisible();
    await expect(page.locator('#pickErr')).toHaveText('');
    await expect.poll(() => page.evaluate(() => location.hash)).toBe(boundary);
  });

  test('shows commitment status throughout the turn, including the local player', async ({ page }) => {
    await startMatch(page);
    await deliver(page, '!P~Vale@other-client');
    await expect(page.locator('#pending')).toHaveAttribute('title', /Still choosing: You, Vale\./);
    await expect.poll(() => dotStates(page)).toEqual(['choosing', 'choosing']);

    const hash = await stateHash(page);
    const { nonce, commitment } = seal(0, 'P', 'H');
    await deliver(page, commitment);
    await expect(page.locator('#pending')).toHaveAttribute('title', /Still choosing: You\./);
    await expect.poll(() => dotStates(page)).toEqual(['choosing', 'done']);

    await page.locator('#moveRail [data-act="D"]').click();
    await page.locator('#btnCommit').click();
    await expect(page.locator('#pending')).toHaveAttribute('title', /All actions are in\.$/);
    await expect.poll(() => dotStates(page)).toEqual(['done', 'done']);
    await deliver(page, revealOf(0, 'P', 'H', hash, nonce, 'Vale'));
  });

  test('Space commits only from general gameplay focus', async ({ page }) => {
    await startMatch(page);
    await page.locator('#youAt').click();
    await page.keyboard.press('Space');
    await expect(page.locator('#phaseShare')).toBeVisible();
  });

  test('Space on an interactive control does not commit', async ({ page }) => {
    await startMatch(page);
    await page.locator('#moveRail [data-act="D"]').click();
    await page.keyboard.press('Space');
    await page.locator('#sl').focus();
    await page.keyboard.press('Space');
    await expect(page.locator('#phasePick')).toBeVisible();
    await expect(page.locator('#phaseShare')).toBeHidden();
  });

  test('a resolved turn moves the board, the log and the status line', async ({ page }) => {
    await startMatch(page);
    const hash = await stateHash(page);
    const { nonce, commitment } = seal(0, 'P', 'H');
    await deliver(page, commitment);

    await page.locator('#moveRail [data-act="D"]').click();
    await page.locator('#btnCommit').click();
    await expect(page.locator('#phaseShare')).toBeVisible();
    await expect.poll(() => dotStates(page)).toEqual(['done', 'done']);
    await expect(page.locator('#btnUndo')).toBeHidden();

    await deliver(page, revealOf(0, 'P', 'H', hash, nonce, 'Rival'));

    await expect(page.locator('#turnInfo')).toContainText('turn 1 / 8');
    await expect(page.locator('#youAt')).toHaveText('index 1 · t1 · forward · (2,1)');
    await expect(page.locator('#log li')).toHaveCount(2);
    await expect(page.locator('#log')).toContainText('Rook moved to (2,1) at t1');
    await expect(page.locator('#log')).toContainText('Rival held (3,3)');
    await expect(page.locator('#legend')).toContainText('Rival');
    await expect(page.locator('#phasePick')).toBeVisible();
    await expect(page.locator('#slo')).toHaveText('t1');
  });

  test('the world turn slider scrubs the playhead back', async ({ page }) => {
    await startMatch(page);
    const hash = await stateHash(page);
    const { nonce, commitment } = seal(0, 'P', 'H');
    await deliver(page, commitment);
    await page.locator('#moveRail [data-act="D"]').click();
    await page.locator('#btnCommit').click();
    await expect(page.locator('#phaseShare')).toBeVisible();
    await deliver(page, revealOf(0, 'P', 'H', hash, nonce));
    await expect(page.locator('#slo')).toHaveText('t1');

    await expect(page.locator('#board .tok')).toHaveCount(2);
    await expect(page.locator('#board .trail')).toHaveCount(2);

    await page.locator('#sl').press('Home');
    await expect(page.locator('#slo')).toHaveText('t0');
    await expect(page.locator('#board .tok')).toHaveCount(2);
    await expect(page.locator('#board .trail')).toHaveCount(0);
    await expect(page.locator('#board .tok').first()).toHaveAttribute('title', /world turn 0/);

    await page.locator('#sl').press('End');
    await expect(page.locator('#slo')).toHaveText('t1');
    await expect(page.locator('#board .trail')).toHaveCount(2);
  });

  test('the history control drops the trail', async ({ page }) => {
    await startMatch(page);
    const hash = await stateHash(page);
    const { nonce, commitment } = seal(0, 'P', 'H');
    await deliver(page, commitment);
    await page.locator('#moveRail [data-act="D"]').click();
    await page.locator('#btnCommit').click();
    await expect(page.locator('#phaseShare')).toBeVisible();
    await deliver(page, revealOf(0, 'P', 'H', hash, nonce));
    await expect(page.locator('#board .trail')).toHaveCount(2);

    await expect(page.locator('#rd button.on')).toHaveText('2');
    await page.locator('#rd button[data-back="0"]').click();
    await expect(page.locator('#rd button.on')).toHaveText('0');
    await expect(page.locator('#rd button[data-back="0"]')).toHaveAttribute('aria-pressed', 'true');
    await expect(page.locator('#board .trail')).toHaveCount(0);
    await expect(page.locator('#board .tok')).toHaveCount(2);
  });

  test('losing the seat sends you back to the picker', async ({ page }) => {
    await startMatch(page);
    await deliver(page, '!C~Thief@0-lower');

    await expect(page.locator('#setup')).toBeVisible();
    await expect(page.locator('#play')).toBeHidden();
    await expect(page.locator('#pickErr')).toContainText('Coral was claimed first by Thief');
  });

  test('the dot row names both seats in priority order', async ({ page }) => {
    await startMatch(page);
    await expect(dots(page)).toHaveCount(2);
    await expect.poll(() => dotOrder(page)).toEqual(['C', 'P']);
    await expect(page.locator('#pending')).toHaveAttribute('title', /Priority this turn: Rook \u203a Purple\./);
  });

  test('a claim names the other seat before a single turn resolves', async ({ page }) => {
    await startMatch(page);
    await expect(page.locator('#pending')).toHaveAttribute('title', /Purple/);
    await deliver(page, '!P~Rival@other-client');
    await expect(page.locator('#pending')).toHaveAttribute('title', /Rival/);
    await expect(page.locator('#pending')).not.toHaveAttribute('title', /Purple/);
  });

  test('the log rules off between turns', async ({ page }) => {
    await startMatch(page);
    await resolveTurn(page, 0, 'H', 'H', 'Rival');
    await expect(page.locator('#log li.turnsep')).toHaveCount(0);
    await resolveTurn(page, 1, 'H', 'H');
    await expect(page.locator('#log li.turnsep')).toHaveCount(1);
    await expect(page.locator('#log li')).toHaveCount(5);
  });

  test('switching theme redraws the trail at the new floor', async ({ page }) => {
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

  test('keeps a repeated-inversion token inside a fixed oval', async ({ page }) => {
    await open(page, { fragment: 'resume=' + encodeURIComponent(
      'X1:M1:sandbox:5x5:0:tst:8:CP|CIPH,CIPH,CIPH,CIPH|C~Rook,P~Vale'
    ) });
    await page.locator('#pickRows .pickrow[data-color="C"]').click();
    await page.locator('#btnPlay').click();

    const token = page.locator('#board .tok-many');
    await expect(token).toHaveCount(1);
    await expect(token).toHaveText('0 … 4');
    await expect(token).toHaveAttribute('title', /index 0/);
    await expect(token).toHaveAttribute('title', /index 4/);
    await expect(token).toHaveAttribute('aria-label', /index 0/);
    await expect(token).toHaveAttribute('aria-label', /index 4/);
    await expect(token).toHaveCSS('text-overflow', 'ellipsis');
    const geometry = await token.evaluate((node) => {
      const tokenBox = node.getBoundingClientRect();
      const slotBox = node.parentElement!.getBoundingClientRect();
      return {
        width: tokenBox.width, height: tokenBox.height,
        within: tokenBox.left >= slotBox.left && tokenBox.right <= slotBox.right
      };
    });
    expect(geometry.width).toBeGreaterThan(geometry.height);
    expect(geometry.within).toBe(true);
  });

  test('marks matching, opposing, and mixed relative directions', async ({ page }) => {
    await open(page, { fragment: 'resume=' + encodeURIComponent(
      'X1:M1:sandbox:5x5:0:tst:8:CP|CDPH,CIPH|C~Rook,P~Vale'
    ) });
    await page.locator('#pickRows .pickrow[data-color="C"]').click();
    await page.locator('#btnPlay').click();

    const opposing = page.locator('#board .tok[data-direction="opposing"]');
    const mixed = page.locator('#board .tok[data-direction="mixed"]');
    await expect(opposing).toHaveCount(1);
    await expect(mixed).toHaveCount(1);
    await expect(opposing).toHaveAttribute('aria-label', /forward/);
    await expect(opposing).toHaveAttribute('aria-label', /opposite/);
    await expect(mixed).toHaveAttribute('aria-label', /backward/);
    await expect(mixed).toHaveAttribute('aria-label', /same direction|opposite direction/);

    const trail = page.locator('#board .trail[data-direction="opposing"]');
    await expect(trail).toHaveCount(2);
    await expect(trail.first()).toHaveAttribute('title', /forward/);
    await expect(trail.first()).toHaveAttribute('title', /opposite/);
    await expect(page.locator('#strip [data-direction="matching"]')).toHaveCount(1);

    const matching = page.locator('#board .tok[data-direction="mixed"]');
    const dark = await opposing.evaluate((node) => {
      const style = getComputedStyle(node);
      return { background: style.backgroundColor, border: style.borderStyle };
    });
    expect(dark.background).toMatch(/rgba?\(0, 0, 0(?:, 0)?\)/);
    expect(dark.border).toBe('solid');
    const darkMixed = await matching.evaluate((node) => {
      const style = getComputedStyle(node);
      return { background: style.backgroundImage, border: style.borderStyle };
    });
    expect(darkMixed.background).toContain('gradient');
    expect(darkMixed.border).toBe('solid');
    await page.locator('#btnTheme').click();
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
    await expect(opposing).toHaveAttribute('data-direction', 'opposing');
    const light = await opposing.evaluate((node) => {
      const style = getComputedStyle(node);
      return { background: style.backgroundColor, border: style.borderStyle };
    });
    expect(light.background).toMatch(/rgba?\(0, 0, 0(?:, 0)?\)/);
    expect(light.border).toBe('solid');
    const lightMixed = await matching.evaluate((node) => {
      const style = getComputedStyle(node);
      return { background: style.backgroundImage, border: style.borderStyle };
    });
    expect(lightMixed.background).toContain('gradient');
    expect(lightMixed.border).toBe('solid');
  });

  test('shows both indices in a two-body label', async ({ page }) => {
    await open(page, { fragment: 'resume=' + encodeURIComponent(
      'X1:M1:sandbox:5x5:0:tst:8:CP|CIPH|C~Rook,P~Vale'
    ) });
    await page.locator('#pickRows .pickrow[data-color="C"]').click();
    await page.locator('#btnPlay').click();
    const token = page.locator('#board .tok-many');
    await expect(token).toHaveText('0·1');
    await expect(token).toHaveAttribute('title', /index 0/);
    await expect(token).toHaveAttribute('title', /index 1/);
    await expect(token).toHaveAttribute('aria-label', /index 0/);
    await expect(token).toHaveAttribute('aria-label', /index 1/);
  });

  test('marks opposing timeline dots', async ({ page }) => {
    await startMatch(page);
    await resolveTurn(page, 0, 'H', 'I', 'Vale');
    await expect(page.locator('#strip .time-head[data-direction="opposing"]')).toHaveCount(1);
  });

  test('reclassifies relative directions after viewer inversion', async ({ page }) => {
    await startMatch(page);
    await expect(page.locator('#board .tok[data-direction="matching"]')).toHaveCount(2);
    await resolveTurn(page, 0, 'I', 'H', 'Vale');
    await expect(page.locator('#board .tok[data-direction="mixed"]')).toHaveCount(1);
    await expect(page.locator('#board .tok[data-direction="opposing"]')).toHaveCount(1);
  });

  test('keeps every index in the full token descriptions', async ({ page }) => {
    await open(page, { fragment: 'resume=' + encodeURIComponent(
      'X1:M1:sandbox:5x5:0:tst:8:CP|CIPH,CIPH,CIPH,CIPH|C~Rook,P~Vale'
    ) });
    await page.locator('#pickRows .pickrow[data-color="C"]').click();
    await page.locator('#btnPlay').click();
    const token = page.locator('#board .tok-many');
    for (const index of [0, 1, 2, 3, 4]) {
      await expect(token).toHaveAttribute('title', new RegExp('index ' + index + '\\b'));
      await expect(token).toHaveAttribute('aria-label', new RegExp('index ' + index + '\\b'));
    }
  });

  test('uses filled markers when bodies share the viewer direction', async ({ page }) => {
    await startMatch(page);
    const matching = page.locator('#board .tok[data-direction="matching"]');
    await expect(matching).toHaveCount(2);
    await expect(matching.first()).toHaveAttribute('aria-label', /forward/);
    await expect(matching.first()).toHaveAttribute('aria-label', /same direction/);
    const dark = await matching.first().evaluate((node) => {
      const style = getComputedStyle(node);
      return { background: style.backgroundColor, border: style.borderStyle };
    });
    expect(dark.background).not.toMatch(/rgba?\(0, 0, 0(?:, 0)?\)/);
    expect(dark.border).toBe('solid');
    await page.locator('#btnTheme').click();
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
    const light = await matching.first().evaluate((node) => {
      const style = getComputedStyle(node);
      return { background: style.backgroundColor, border: style.borderStyle };
    });
    expect(light.background).not.toMatch(/rgba?\(0, 0, 0(?:, 0)?\)/);
    expect(light.border).toBe('solid');
  });

  test('pins trails in the corner without offsetting a focused token', async ({ page }) => {
    // Coral's spawn is inset from the corner now, so walk it to (0,0) first
    // (left, then up) before holding to leave a trail there.
    await open(page, { fragment: 'resume=' + encodeURIComponent(
      'X1:M1:sandbox:5x5:0:tst:8:CP|CAPH,CWPH,CHPH|C~Rook,P~Vale'
    ) });
    await page.locator('#pickRows .pickrow[data-color="C"]').click();
    await page.locator('#btnPlay').click();

    const cell = page.locator('#board .cell').first();
    await expect(cell.locator('.trail-cluster.corner')).toHaveCount(1);
    // The token sits in the bodies layer now, so measure it against the cell it covers.
    const geometry = await page.locator('#board').evaluate((node) => {
      const cellNode = node.querySelector('.cell')!;
      const box = cellNode.getBoundingClientRect();
      const token = node.querySelector('.tokslot[data-tile="0,0"] .tok')!.getBoundingClientRect();
      const trails = cellNode.querySelector('.trail-cluster')!.getBoundingClientRect();
      const center = (r: DOMRect, axis: 'x' | 'y') => axis === 'x'
        ? r.left + r.width / 2 : r.top + r.height / 2;
      // The token is a circle, so box overlap says nothing: measure the corner it leaves free.
      const cx = center(token, 'x'), cy = center(token, 'y'), r = token.width / 2;
      const near = (lo: number, hi: number, v: number) => Math.max(lo, Math.min(hi, v));
      const px = near(trails.left, trails.right, cx), py = near(trails.top, trails.bottom, cy);
      const overlap = Math.hypot(px - cx, py - cy) < r;
      return {
        dx: Math.abs(center(token, 'x') - center(box, 'x')),
        dy: Math.abs(center(token, 'y') - center(box, 'y')),
        corner: center(trails, 'x') > center(box, 'x') && center(trails, 'y') < center(box, 'y'),
        overlap
      };
    });
    expect(geometry.dx).toBeLessThan(1);
    expect(geometry.dy).toBeLessThan(1);
    expect(geometry.corner).toBe(true);
    expect(geometry.overlap).toBe(false);
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
    await expect(page.locator('#turnInfo')).toHaveText('Draw at turn 2');
    await expect(page.locator('#pending')).toHaveCount(0);
    await expect(page.locator('#board .cell')).toHaveCount(25);
  });

  test('the history presets stop at the cap', async ({ page }) => {
    await open(page);
    await createMatch(page, { cap: '40' });
    await sitDown(page);
    await expect(page.locator('#rd button')).toHaveText(['0', '2', '4', '10']);
    await expect(page.locator('#rd button.on')).toHaveText('10');
    await expect(page.locator('#rd button[data-back="10"]')).toHaveAttribute('aria-pressed', 'true');
  });

  test('a small cap drops the presets above it', async ({ page }) => {
    await startMatch(page);
    await expect(page.locator('#rd button')).toHaveText(['0', '2']);
    await expect(page.locator('#rd button.on')).toHaveText('2');
  });

  test('the state hash moves with the match', async ({ page }) => {
    await startMatch(page);
    const before = await stateHash(page);
    await expect(page.locator('#hashInfo')).toHaveText('state ' + before);
    await resolveTurn(page, 0, 'D', 'H', 'Vale');
    const after = await stateHash(page);
    expect(after).not.toBe(before);
    await expect(page.locator('#hashInfo')).toHaveText('state ' + after);
  });
});

// (2,1) after a D from the spawn; (1,1) holds Coral's t0 body.
const INVERTED = 'X1:M1:sandbox:5x5:0:tst:8:CP|CDPH,CIPH|C~Rook,P~Vale';

// Open a 5x5 match straight into play from a resume link.
async function resume(page: Page, log: string) {
  await open(page, { fragment: 'resume=' + encodeURIComponent(log) });
  await page.locator('#pickRows .pickrow[data-color="C"]').click();
  await page.locator('#btnPlay').click();
  await expect(page.locator('#play')).toBeVisible();
}

const at = (page: Page, x: number, y: number) => page.locator('#board .cell').nth(y * 5 + x);

test.describe('board targets', () => {
  test('paints one target per legal move with its index and world turn', async ({ page }) => {
    await startMatch(page);
    const targets = page.locator('#board .cell[data-target]');
    await expect(targets).toHaveCount(4);
    await expect.poll(
      () => targets.evaluateAll((els) => els.map((e) => e.getAttribute('data-target')).sort())
    ).toEqual(['A', 'D', 'S', 'W']);
    await expect(targets.locator('.tgt-p')).toHaveText(['1', '1', '1', '1']);
    await expect(targets.locator('.tgt-t')).toHaveText(['t1', 't1', 't1', 't1']);
    await expect(at(page, 2, 1)).toHaveAttribute('data-target', 'D');
  });

  test('hold and invert paint nothing', async ({ page }) => {
    await startMatch(page);
    await expect(page.locator('#board .cell[data-target="H"]')).toHaveCount(0);
    await expect(page.locator('#board .cell[data-target="I"]')).toHaveCount(0);
    await expect(at(page, 1, 1)).not.toHaveAttribute('data-target', /./);
    await expect(at(page, 1, 1).locator('.tgt')).toHaveCount(0);
  });

  test('clicking a target selects that action', async ({ page }) => {
    await startMatch(page);
    await at(page, 2, 1).click();
    await expect(page.locator('#btnCommit')).toHaveText('Commit right');
    await expect(page.locator('#moveRail [data-act="D"]')).toHaveClass(/sel/);
  });

  test('an occupied tile greys out with its reason and no readout', async ({ page }) => {
    await resume(page, INVERTED);
    const blocked = at(page, 1, 1);
    await expect(blocked).toHaveAttribute('title', 'Blocked by occupied');
    await expect(blocked).not.toHaveAttribute('data-target', /./);
    await expect(blocked.locator('.tgt')).toHaveCount(0);
    await expect(blocked).toHaveCSS('opacity', '0.55');
    await expect(page.locator('#board .cell[data-target]')).toHaveCount(3);
  });

  test('a wall behind a move stays a wall and offers nothing', async ({ page }) => {
    await open(page);
    await createMatch(page, { seed: 'w0', wall: '20' });
    await sitDown(page);
    await resolveTurn(page, 0, 'S', 'H', 'Vale');

    const wall = at(page, 1, 3);
    await expect(wall).not.toHaveAttribute('data-target', /./);
    await expect(wall.locator('.tgt')).toHaveCount(0);
    await expect(wall).toHaveCSS('opacity', '0.38');
    await expect(page.locator('#board .cell[data-target]')).toHaveCount(3);
  });
});

test.describe('priority dots', () => {
  test('the order follows this turn, not the roster', async ({ page }) => {
    await resume(page, INVERTED);
    await expect.poll(() => dotOrder(page)).toEqual(['P', 'C']);
    await expect(page.locator('#pending')).toHaveAttribute(
      'title', /^Priority this turn: Vale › Rook\./);
  });

  test('a dot flips to done when its player commits', async ({ page }) => {
    await startMatch(page);
    await expect.poll(() => dotStates(page)).toEqual(['choosing', 'choosing']);
    await page.locator('#btnCommit').click();
    await expect.poll(() => dotStates(page)).toEqual(['done', 'choosing']);
    await expect(dots(page).first()).toHaveAttribute('data-color', 'C');
  });
});

test.describe('rails', () => {
  test('both rails fold and reopen', async ({ page }) => {
    await startMatch(page);
    await expect(page.locator('#logRail')).toBeVisible();
    await expect(page.locator('#moveRail')).toBeVisible();
    await expect(page.locator('#logStrip')).toHaveCount(0);
    await expect(page.locator('#moveStrip')).toHaveCount(0);

    await page.locator('#btnLogFold').click();
    await expect(page.locator('#logRail')).toHaveCount(0);
    await expect(page.locator('#log')).toHaveCount(0);
    await expect(page.locator('#logStrip .vlabel')).toHaveText('LOG · 0 events');
    await expect(page.locator('#btnLogOpen')).toBeEnabled();

    await page.locator('#btnMoveFold').click();
    await expect(page.locator('#moveRail')).toHaveCount(0);
    await expect(page.locator('#phasePick')).toHaveCount(0);
    await expect(page.locator('#moveStrip #pending')).toBeVisible();
    await expect(page.locator('#btnCommitStrip')).toBeVisible();

    await page.locator('#btnLogOpen').click();
    await expect(page.locator('#log li')).toHaveText('No turns yet.');
    await page.locator('#btnMoveOpen').click();
    await expect(page.locator('#moveStrip')).toHaveCount(0);
    await expect(page.locator('#phasePick')).toBeVisible();
  });

  test('toasts stand in for the folded log, newest first', async ({ page }) => {
    await startMatch(page);
    await resolveTurn(page, 0, 'H', 'H', 'Vale');
    await resolveTurn(page, 1, 'D', 'H');
    await expect(page.locator('#toasts')).toHaveCount(0);

    await page.locator('#btnLogFold').click();
    const toasts = page.locator('#toasts .toast');
    await expect(toasts).toHaveCount(3);
    await expect(toasts.first()).toContainText('t1');
    await expect(toasts.last()).toContainText('t0');
    await expect(page.locator('#toasts .toast.a2')).toHaveCount(1);
    await expect(page.locator('#toasts .toast.a3')).toHaveCount(1);

    await page.locator('#btnLogOpen').click();
    await expect(page.locator('#toasts')).toHaveCount(0);
  });

  test('a narrow viewport folds both rails and locks them shut', async ({ page }) => {
    await startMatch(page);
    await page.setViewportSize({ width: 1000, height: 800 });
    await expect(page.locator('#logStrip')).toBeVisible();
    await expect(page.locator('#moveStrip')).toBeVisible();
    await expect(page.locator('#btnLogOpen')).toBeDisabled();
    await expect(page.locator('#btnMoveOpen')).toBeDisabled();
  });

  test('the folded strip commits', async ({ page }) => {
    await startMatch(page);
    await page.locator('#btnMoveFold').click();
    await expect(page.locator('#btnCommitStrip')).toBeEnabled();
    await page.locator('#btnCommitStrip').click();
    await expect(page.locator('#btnCommitStrip')).toBeDisabled();
    await expect.poll(() => dotStates(page)).toEqual(['done', 'choosing']);

    await page.locator('#btnMoveOpen').click();
    await expect(page.locator('#phaseShare')).toBeVisible();
  });
});

test.describe('dock', () => {
  test('pressing the world turn raises the instrument', async ({ page }) => {
    await startMatch(page);
    await expect(page.locator('#instrument')).toHaveCount(0);
    await expect(page.locator('#scrim')).toHaveCount(0);

    await page.locator('#sl').hover();
    await page.mouse.down();
    await expect(page.locator('#instrument')).toBeVisible();
    await expect(page.locator('#scrim')).toBeVisible();
    await expect(page.locator('#instrument svg')).toHaveAttribute('aria-label', /world turns t0 to t8/);

    await page.mouse.up();
    await expect(page.locator('#instrument')).toHaveCount(0);
    await expect(page.locator('#scrim')).toHaveCount(0);
  });

  test('the instrument keeps its scale and its row height as lanes appear', async ({ page }) => {
    await open(page);
    await createMatch(page, { w: '7', h: '7', cap: '12' });
    await sitDown(page);

    const raise = async () => {
      await page.locator('#sl').hover();
      await page.mouse.down();
      await expect(page.locator('#instrument')).toBeVisible();
    };
    // The SVG draws in CSS pixels, so a tick label is 10px whatever the viewBox would have scaled it to.
    const metrics = async () => {
      await raise();
      const out = {
        tick: await page.locator('#instrument text').first().evaluate(
          (el) => getComputedStyle(el).fontSize),
        rows: await page.locator('#instrument svg').evaluate((el) => Number(el.getAttribute('height')))
      };
      await page.mouse.up();
      return out;
    };

    const before = await metrics();
    // Two inversions put Rook on three lanes.
    const mine = ['D', 'H', 'I', 'S', 'I', 'H'];
    for (let turn = 0; turn < mine.length; turn++) {
      await resolveTurn(page, turn, mine[turn]!, 'H', turn === 0 ? 'Bishop' : undefined);
    }
    await expect(page.locator('#board .tokslot')).toHaveCount(3);

    const after = await metrics();
    expect(after.tick).toBe('10px');
    expect(after).toEqual(before);

    await raise();
    // One column per world turn this seat has reached, not one per turn of the cap. This script
    // tops out at t2, so three columns, not thirteen. The focus band is exactly one of them.
    const geom = await page.locator('#instrument svg').evaluate((svg) => {
      const ticks = [...svg.querySelectorAll('text')]
        .filter((t) => /^t\d+$/.test(t.textContent ?? ''));
      return {
        columns: ticks.length,
        pitch: Number(ticks[1]!.getAttribute('x')) - Number(ticks[0]!.getAttribute('x')),
        focus: svg.querySelector('rect[fill="var(--accent-br)"]')!.getBoundingClientRect().width
      };
    });
    expect(geom.columns).toBe(3);
    expect(geom.focus).toBeCloseTo(geom.pitch, 1);
    await page.mouse.up();
  });

  test('a fully explored chart carries no hatching', async ({ page }) => {
    await open(page);
    await createMatch(page, { cap: '4' });
    await sitDown(page);
    for (let turn = 0; turn < 4; turn++) {
      await resolveTurn(page, turn, 'H', 'H', turn === 0 ? 'Vale' : undefined);
    }
    await page.locator('#sl').hover();
    await page.mouse.down();
    await expect(page.locator('#instrument')).toBeVisible();

    await expect(page.locator('#instrument rect[fill="url(#tl-fog)"]')).toHaveCount(0);
    // Nothing is unexplored, so the cap line is the right edge of the last turn's column
    // rather than the right edge of the chart.
    const geom = await page.locator('#instrument svg').evaluate((svg) => {
      const at = [...svg.querySelectorAll('text')]
        .filter((t) => /^t\d+$/.test(t.textContent ?? ''))
        .map((t) => Number(t.getAttribute('x')));
      return {
        cap: Number(svg.querySelector('line[stroke="var(--bad-br)"]')!.getAttribute('x1')),
        bandEnd: at[at.length - 1]! + (at[1]! - at[0]!) / 2,
        width: Number(svg.getAttribute('width'))
      };
    });
    expect(geom.cap).toBe(geom.bandEnd);
    expect(geom.cap).toBeLessThan(geom.width - 16);
    await page.mouse.up();
  });

  test('the legend waits for a hover', async ({ page }) => {
    await startMatch(page);
    await expect(page.locator('#legpop')).toBeHidden();
    await page.locator('.legwrap').hover();
    await expect(page.locator('#legpop')).toBeVisible();
    await expect(page.locator('#legpop #legend')).toBeVisible();
    await expect(page.locator('#legpop .keyhint')).toContainText(
      'Arrows or WASD: choose. Enter or Space: commit. Esc: clear.');
  });
});

test.describe('layout', () => {
  test('every strip row shares one column grid', async ({ page }) => {
    await startMatch(page);
    await resolveTurn(page, 0, 'D', 'H', 'Vale');
    await resolveTurn(page, 1, 'D', 'H');

    // The unexplored block used to hang off the bar row alone, compressing its columns while the
    // heads and numbers above and below it kept the full width.
    const rows = await page.locator('#strip > div').evaluateAll(
      (els) => els.map((el) => [...el.children].map((c) => Math.round(c.getBoundingClientRect().left))));
    expect(rows.length).toBeGreaterThan(1);
    for (const row of rows) expect(row).toEqual(rows[0]);
  });

  test('the folded commit button stays legible under the pointer', async ({ page }) => {
    await startMatch(page);
    await page.locator('#btnMoveFold').click();
    const paint = () => page.locator('#btnCommitStrip').evaluate(
      (el) => [getComputedStyle(el).backgroundColor, getComputedStyle(el).color].join(' '));

    const rest = await paint();
    await page.locator('#btnCommitStrip').hover();
    // The generic button:hover rule used to win and flip the fill dark under a dark tick.
    expect(await paint()).not.toBe(rest);
    expect(await paint()).not.toContain('rgb(43, 42, 47)');
  });

  test('the connection dot follows the channel', async ({ page }) => {
    await startMatch(page);
    await expect(page.locator('#netInfo .dot')).toHaveAttribute('data-state', 'good');
    await expect(page.locator('#netInfo')).toHaveText('Connected · 1 other player');
  });
});

test.describe('turn animation', () => {
  test('a resolved move slides its token until the next input', async ({ page }) => {
    await startMatch(page);
    await resolveTurn(page, 0, 'D', 'H', 'Vale');
    await expect(page.locator('#board .tokslot[data-motion="slide"]')).toHaveCount(1);

    await page.keyboard.press('Escape');
    await expect(page.locator('#board .tokslot[data-motion]')).toHaveCount(0);
  });

  test('reduced motion sets no motion at all', async ({ page }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await startMatch(page);
    await expect(page.locator('#board')).toHaveClass(/noanim/);
    await resolveTurn(page, 0, 'D', 'H', 'Vale');
    await expect(page.locator('#youAt')).toHaveText('index 1 · t1 · forward · (2,1)');
    await expect(page.locator('#board .tokslot[data-motion]')).toHaveCount(0);
  });

  type Flight = { key: string | null; tile: string | null; moving: boolean; snapped: boolean };

  // data-motion survives a teleport, so watch the live rect between the two tiles instead.
  function flight(page: Page, from: readonly [number, number], to: readonly [number, number], ms: number) {
    return page.evaluate(([f, t, span]) => new Promise<Flight>((done) => {
      const board = document.querySelector('#board')!;
      const cells = board.querySelectorAll('.cell');
      const w = Number(getComputedStyle(board).getPropertyValue('--bw'));
      const leftOf = (p: readonly number[]) => cells[p[1]! * w + p[0]!]!.getBoundingClientRect().left;
      const lo = Math.min(leftOf(f), leftOf(t));
      const hi = Math.max(leftOf(f), leftOf(t));
      const out: Flight = { key: null, tile: null, moving: false, snapped: false };
      const until = performance.now() + span;
      const step = (): void => {
        const slot = board.querySelector<HTMLElement>('.tokslot[data-motion="slide"]');
        if (slot) {
          out.key = slot.dataset.key ?? null;
          out.tile = slot.dataset.tile ?? null;
          const left = slot.getBoundingClientRect().left;
          if (left > lo + 1 && left < hi - 1) out.moving = true;
          if (board.querySelector('.bodies')!.classList.contains('snap')) out.snapped = true;
        }
        if (performance.now() < until) requestAnimationFrame(step);
        else done(out);
      };
      requestAnimationFrame(step);
    }), [from, to, ms] as const);
  }

  // Latest moment any staged transition or keyframe finishes, as delay + duration.
  function motionEnd(page: Page) {
    return page.locator('#board .bodies.staged').evaluate((bodies) => {
      const ms = (v: string) => v.split(',').map((part) => {
        const n = parseFloat(part) || 0;
        return part.trim().endsWith('ms') ? n : n * 1000;
      });
      let worst = 0;
      let where = '';
      const bid = (name: string, end: number, el: Element, pseudo: string | null) => {
        if (end <= worst) return;
        worst = end;
        const cls = typeof el.className === 'string' ? el.className : (el as SVGElement).className.baseVal;
        where = '.' + cls.trim().split(/\s+/).join('.') + (pseudo ?? '') + ' ' + name;
      };
      const look = (el: Element, pseudo: string | null) => {
        const st = getComputedStyle(el, pseudo ?? undefined);
        if (st.animationName !== 'none') {
          const delay = ms(st.animationDelay);
          const dur = ms(st.animationDuration);
          st.animationName.split(',').forEach((name, i) => {
            bid(name.trim(), (delay[i % delay.length] ?? 0) + (dur[i % dur.length] ?? 0), el, pseudo);
          });
        }
        if (!pseudo && el.classList.contains('tokslot') && st.transitionProperty !== 'none') {
          const delay = ms(st.transitionDelay);
          const dur = ms(st.transitionDuration);
          st.transitionProperty.split(',').forEach((name, i) => {
            bid(name.trim(), (delay[i % delay.length] ?? 0) + (dur[i % dur.length] ?? 0), el, pseudo);
          });
        }
      };
      for (const el of bodies.querySelectorAll('*')) {
        look(el, null);
        look(el, '::before');
        look(el, '::after');
      }
      return { worst, where };
    });
  }

  function slidKeys(page: Page) {
    return page.locator('#board .tokslot[data-motion="slide"]')
      .evaluateAll((els) => els.map((e) => e.dataset.key).sort());
  }

  function delayOf(page: Page, key: string) {
    return page.locator(`#board .tokslot[data-key="${key}"]`)
      .evaluate((el) => getComputedStyle(el).transitionDelay);
  }

  test('a one-notch scrub slides', async ({ page }) => {
    await startMatch(page);
    await resolveTurn(page, 0, 'D', 'H', 'Vale');
    await resolveTurn(page, 1, 'D', 'H');
    await page.keyboard.press('Escape');
    await expect(page.locator('#board .tokslot[data-motion]')).toHaveCount(0);

    await page.locator('#sl').press('ArrowLeft');
    await expect(page.locator('#slo')).toHaveText('t1');
    await expect.poll(() => slidKeys(page)).toEqual(['C/0']);
  });

  test('a second scrub inside the motion window still slides', async ({ page }) => {
    await startMatch(page);
    await resolveTurn(page, 0, 'D', 'H', 'Vale');
    await resolveTurn(page, 1, 'D', 'H');
    await resolveTurn(page, 2, 'D', 'H');
    await page.keyboard.press('Escape');

    // Coral walks t1..t3 along row 1, so each notch back slides it from (3,1) to (2,1).
    await page.locator('#sl').press('ArrowLeft');
    await page.waitForTimeout(300); // a real gap: the second press has to land inside MOTION_MS
    await page.locator('#sl').press('ArrowLeft');
    expect(await flight(page, [3, 1], [2, 1], 300))
      .toEqual({ key: 'C/0', tile: '2,1', moving: true, snapped: false });
  });

  test('a resolved turn slides its token instead of teleporting', async ({ page }) => {
    await startMatch(page);
    await resolveTurn(page, 0, 'D', 'H', 'Vale');
    await page.keyboard.press('Escape');
    await expect(page.locator('#board .tokslot[data-motion]')).toHaveCount(0);

    // Priority rotates each turn, so the scene's slot order flips under Coral here.
    const reveal = await commitTurn(page, 1, 'D', 'H');
    await reveal();
    // .25s of stagger in front of the .4s slide, so the window covers both.
    expect(await flight(page, [2, 1], [3, 1], 750))
      .toEqual({ key: 'C/0', tile: '3,1', moving: true, snapped: false });
  });

  test('both legs of a split colour slide', async ({ page }) => {
    await open(page);
    await createMatch(page, { w: '7', h: '7' });
    await sitDown(page);
    // Coral inverts on (3,1) and walks back down; the second S is the first turn both legs step.
    const mine = ['D', 'D', 'I', 'S', 'S'];
    for (let turn = 0; turn < mine.length; turn++) {
      await resolveTurn(page, turn, mine[turn]!, 'H', turn === 0 ? 'Vale' : undefined);
    }

    await expect(page.locator('#slo')).toHaveText('t0');
    await expect.poll(() => slidKeys(page)).toEqual(['C/0', 'C/1']);
  });

  // Coral inverts on (3,1) at t2, so t2 holds both legs on one tile. The S after it is the turn
  // they part: t1 carries p1 on (2,1) and p4 on (3,2).
  async function playToTheSplit(page: Page) {
    await open(page);
    await createMatch(page, { w: '7', h: '7' });
    await sitDown(page);
    const mine = ['D', 'D', 'I', 'S'];
    for (let turn = 0; turn < mine.length; turn++) {
      await resolveTurn(page, turn, mine[turn]!, 'H', turn === 0 ? 'Vale' : undefined);
    }
  }

  test('the leg parting from the inversion tile travels off it', async ({ page }) => {
    await playToTheSplit(page);

    const split = page.locator('#board .tokslot[data-motion="split"]');
    await expect(split).toHaveCount(1);
    await expect(split).toHaveAttribute('data-key', 'C/1');
    await expect(split).toHaveAttribute('data-tile', '3,2');
    // One tile up from (3,2) is the (3,1) it shared, and it rides the .25s move beat.
    expect(await split.evaluate((el) => [
      getComputedStyle(el).animationName,
      getComputedStyle(el).animationDelay,
      el.style.getPropertyValue('--px'),
      el.style.getPropertyValue('--py')
    ])).toEqual(['slot-split', '0.25s', '0', '-1']);

    await page.keyboard.press('Escape');
    await expect(page.locator('#board .tokslot[data-motion]')).toHaveCount(0);
  });

  test('a leg rejoining the inversion tile travels onto it and leaves nothing behind', async ({ page }) => {
    await playToTheSplit(page);
    await page.keyboard.press('Escape');
    await expect(page.locator('#board .tokslot[data-motion]')).toHaveCount(0);

    // Scrubbing forward onto the inversion turn merges the two legs back onto one tile. Preact
    // drops the newer leg's element, so the motion plays on a held copy.
    await page.locator('#sl').press('ArrowRight');
    await expect(page.locator('#slo')).toHaveText('t2');
    const ghost = page.locator('#board .tokslot.ghost');
    await expect(ghost).toHaveCount(1);
    await expect(ghost).toHaveAttribute('data-motion', 'merge');
    await expect(ghost).toHaveAttribute('aria-hidden', 'true');
    expect(await ghost.evaluate((el) => [
      getComputedStyle(el).animationName,
      el.style.getPropertyValue('--px'),
      el.style.getPropertyValue('--py')
    ])).toEqual(['slot-merge', '0', '1']);

    await page.keyboard.press('Escape');
    await expect(page.locator('#board .tokslot.ghost')).toHaveCount(0);
  });

  test('a staged split finishes inside the animation window', async ({ page }) => {
    await playToTheSplit(page);
    await expect(page.locator('#board .tokslot[data-motion="split"]')).toHaveCount(1);
    const last = await motionEnd(page);
    expect(last.worst, last.where).toBeLessThanOrEqual(1200);
  });

  test('a resolved turn stages its motions and a scrub does not', async ({ page }) => {
    await startMatch(page);
    await resolveTurn(page, 0, 'D', 'H', 'Vale');
    const bodies = page.locator('#board .bodies');
    await expect(bodies).toHaveClass(/staged/);
    await expect.poll(() => slidKeys(page)).toEqual(['C/0']);
    expect(await delayOf(page, 'C/0')).toBe('0.25s');

    await resolveTurn(page, 1, 'I', 'H');
    const inverting = page.locator('#board .tokslot[data-motion="invert"] .tok');
    await expect(inverting).toHaveCount(1);
    // Moves at .25s, inversions at .65s: the sequence is the delays, not the wall clock.
    expect(await inverting.evaluate((el) => getComputedStyle(el).animationDelay)).toBe('0.65s');

    await page.locator('#sl').press('ArrowLeft');
    await expect(page.locator('#slo')).toHaveText('t0');
    await expect(bodies).not.toHaveClass(/staged/);
    // Unstaged, the shorthand's two transitions each report their own delay.
    expect(await delayOf(page, 'C/0')).toBe('0s, 0s');
  });

  test('an inversion settles the pill open and draws nothing over it', async ({ page }) => {
    await startMatch(page);
    await resolveTurn(page, 0, 'D', 'H', 'Vale');
    await resolveTurn(page, 1, 'I', 'H');

    await expect(page.locator('#board .tokslot[data-motion="invert"]')).toHaveCount(1);
    // Hold the slot by key, not by motion: the last assertion runs after the motion clears.
    const slot = page.locator('#board .tokslot[data-key="C/0"]');
    const tok = slot.locator('.tok');
    await expect(tok).toHaveClass(/tok-many/);
    await expect(tok).toHaveAttribute('data-direction', 'mixed');
    expect(await tok.evaluate((el) => getComputedStyle(el).animationName)).toBe('tok-settle');
    await expect(page.locator('#board .turnback')).toHaveCount(0);

    // The settle ends on what the renderer already draws, so nothing jumps when the motion clears.
    const ended = await tok.evaluate((el) => {
      for (const a of el.getAnimations()) a.finish();
      return getComputedStyle(el).width;
    });
    await page.keyboard.press('Escape');
    await expect(page.locator('#board .tokslot[data-motion]')).toHaveCount(0);
    expect(await tok.evaluate((el) => getComputedStyle(el).width)).toBe(ended);
  });

  async function startBootstrap(page: Page) {
    await open(page);
    await createMatch(page, { mode: 'bootstrap', cap: '12' });
    await sitDown(page);
  }

  test('losing the key while blocked plays the bounce and the fade together', async ({ page }) => {
    await startBootstrap(page);
    // Rook grabs the key and inverts; on the last turn it walks into Bishop, who wins the tile
    // and takes the key, so one slot owes both a bounce and a fade.
    const mine = ['D', 'A', 'D', 'I', 'H', 'S'];
    const theirs = ['H', 'H', 'H', 'I', 'A', 'W'];
    for (let turn = 0; turn < mine.length; turn++) {
      await resolveTurn(page, turn, mine[turn]!, theirs[turn]!, turn === 0 ? 'Bishop' : undefined);
    }

    const blocked = page.locator('#board .tokslot[data-key="C/0"]');
    await expect(blocked).toHaveAttribute('data-motion', 'bounce');
    await expect(blocked).toHaveAttribute('data-key-motion', 'lost');
    const thief = page.locator('#board .tokslot[data-key="P/1"]');
    await expect(thief).toHaveAttribute('data-key-motion', 'grab');
    await expect(thief).toHaveAttribute('data-motion', 'slide');
  });

  test('a front keeps its element as the world turn advances', async ({ page }) => {
    await startBootstrap(page);
    const mine = ['D', 'H', 'H', 'H', 'H', 'H'];
    const theirs = ['H', 'H', 'H', 'I', 'A', 'W'];
    for (let turn = 0; turn < mine.length; turn++) {
      await resolveTurn(page, turn, mine[turn]!, theirs[turn]!, turn === 0 ? 'Bishop' : undefined);
    }

    const front = page.locator('#board .frontslot');
    await expect(front).toHaveAttribute('data-key', 'P#0');
    // Tag the node: keyed by world turn the front remounts here and the tag goes with it.
    await front.evaluate((el) => { (el as HTMLElement & { tag?: number }).tag = 7; });

    await resolveTurn(page, 6, 'D', 'H');
    await expect(front).toHaveAttribute('data-key', 'P#0');
    expect(await front.evaluate((el) => (el as HTMLElement & { tag?: number }).tag)).toBe(7);
  });

  test('every staged motion finishes inside the animation window', async ({ page }) => {
    await startBootstrap(page);
    // Bishop steals from a recorded Rook, so this turn stages a slide, a grab, a loss and a front.
    const mine = ['D', 'H', 'H', 'H', 'H', 'H'];
    const theirs = ['H', 'H', 'H', 'I', 'A', 'W'];
    for (let turn = 0; turn < mine.length; turn++) {
      await resolveTurn(page, turn, mine[turn]!, theirs[turn]!, turn === 0 ? 'Bishop' : undefined);
    }
    await expect(page.locator('#board .frontslot')).toHaveCount(1);
    // clear() cancels everything at MOTION_MS, so anything landing later loses its tail.
    const last = await motionEnd(page);
    expect(last.worst, last.where).toBeLessThanOrEqual(1200);
  });

  test('a staged inversion finishes inside the animation window', async ({ page }) => {
    await startMatch(page);
    await resolveTurn(page, 0, 'D', 'H', 'Vale');
    await resolveTurn(page, 1, 'I', 'H');
    await expect(page.locator('#board .tokslot[data-motion="invert"]')).toHaveCount(1);
    const last = await motionEnd(page);
    expect(last.worst, last.where).toBeLessThanOrEqual(1200);
  });

  test('a scene rebuild mid-animation leaves the running sequence alone', async ({ page }) => {
    await startMatch(page);
    await resolveTurn(page, 0, 'D', 'H', 'Vale');
    const slot = page.locator('#board .tokslot[data-key="C/0"]');
    await expect(slot).toHaveAttribute('data-motion', 'slide');

    // Committing flips `choosing`, which is a real input to sceneAt, so the scene is rebuilt
    // while the slide is still running. Dispatched rather than clicked: a real pointerdown is
    // the deliberate skip-to-the-end, and that is not what this test is about.
    await deliver(page, seal(1, 'P', 'H').commitment);
    await page.locator('#moveRail [data-act="D"]').dispatchEvent('click');
    await page.locator('#btnCommit').dispatchEvent('click');
    await expect(page.locator('#phaseShare')).toBeVisible();

    await expect(slot).toHaveAttribute('data-motion', 'slide');
    await expect(page.locator('#board .bodies')).toHaveClass(/staged/);
  });

  test('the key mark holds its start frame until its turn in the sequence', async ({ page }) => {
    await startBootstrap(page);
    await resolveTurn(page, 0, 'D', 'H', 'Bishop');
    const slot = page.locator('#board .tokslot[data-key-motion="grab"]');
    await expect(slot).toHaveCount(1);
    // Without a fill mode the mark sits at the destination for the .65s of stagger, then
    // jumps back to the source tile to start its slide.
    expect(await slot.locator('.key-mark').evaluate(
      (el) => getComputedStyle(el).animationFillMode)).toBe('both');
    expect(await slot.evaluate(
      (el) => getComputedStyle(el, '::before').animationFillMode)).toBe('both');
  });
});

test.describe('bootstrap', () => {
  async function startBootstrap(page: Page) {
    await open(page);
    await createMatch(page, { mode: 'bootstrap', cap: '12' });
    await sitDown(page);
  }

  test('a key carried home at t0 wins the match', async ({ page }) => {
    await startBootstrap(page);
    await resolveTurn(page, 0, 'D', 'H', 'Bishop');
    await expect(page.locator('#log')).toContainText('Rook picked up the key at (2,1) t1');
    const keyMark = page.locator('#board .key-mark');
    await expect(keyMark).toHaveCount(1);
    await expect(keyMark).toHaveAttribute('data-side', '0,1');

    await resolveTurn(page, 1, 'I', 'H');
    await resolveTurn(page, 2, 'H', 'H');

    await expect(page.locator('#phaseOver')).toBeVisible();
    await expect(page.locator('#phaseOver h3')).toHaveText('You won');
    await expect(page.locator('#turnInfo')).toHaveText('You won at turn 3');
    await expect(page.locator('#phasePick')).toBeHidden();
    await expect(page.locator('#phaseShare')).toBeHidden();
    await expect(page.locator('#pending')).toHaveCount(0);
    await expect(page.locator('#moveRail [data-act="D"]')).toBeHidden();
    await expect(page.locator('#btnCommit')).toBeHidden();
  });

  test('shows the number of key incarnations on each side', async ({ page }) => {
    await resume(page,
      'X1:M1:bootstrap:7x7:0:test:40:CP|CDPH,CSPH,CSPH,CIPH,CDPH,CAPH|C~Rook,P~Vale');

    const mark = page.locator('#board .key-mark[data-side="1,0"]');
    await expect(mark).toHaveCount(1);
    await expect(mark).toHaveAttribute('data-count', '2');
    await expect(mark).toHaveAttribute('aria-label', '2 keys on side 1,0');
  });

  test('a steal from a recorded body shows a front until it reaches the holder', async ({ page }) => {
    await startBootstrap(page);
    const mine = ['D', 'H', 'H', 'H', 'H', 'H'];
    const theirs = ['H', 'H', 'H', 'I', 'A', 'W'];
    for (let turn = 0; turn < mine.length; turn++) {
      await resolveTurn(page, turn, mine[turn]!, theirs[turn]!, turn === 0 ? 'Bishop' : undefined);
    }

    await expect(page.locator('#log')).toContainText('Bishop took the key from Rook at (2,2) t1');
    const title = 'reaches you in 3 turns';
    const front = page.locator('#board .frontslot');
    await expect(front).toHaveCount(1);
    await expect(front.locator('.front-mark')).toHaveAttribute('title', title);
    await expect(page.locator('#board .front-mark')).toHaveCount(1);
    // Fronts sit in the bodies layer, so check the slot covers (2,1).
    const offset = await page.locator('#board').evaluate((node) => {
      const slot = node.querySelector('.frontslot')!.getBoundingClientRect();
      const cell = node.querySelectorAll('.cell')[1 * 5 + 2]!.getBoundingClientRect();
      return { dx: Math.abs(slot.left - cell.left), dy: Math.abs(slot.top - cell.top) };
    });
    expect(offset.dx).toBeLessThan(2);
    expect(offset.dy).toBeLessThan(2);
    const tick = page.locator('#strip .front-tick');
    await expect(tick).toHaveCount(1);
    await expect(tick).toHaveAttribute('title', title);
    const purple = await page.evaluate(() => getComputedStyle(document.querySelector('#strip .front-tick')!).borderBottomColor);
    const rook = await page.evaluate(() => getComputedStyle(document.querySelector('#board .tok')!).borderColor);
    expect(purple).not.toBe(rook);

    const keyMark = page.locator('#board .key-mark');
    await expect(keyMark).toHaveCount(1);
    await expect(keyMark).toHaveAttribute('data-side', '0,1');
  });

  test('the legend lists the key and fronts only in bootstrap', async ({ page }) => {
    await startBootstrap(page);
    const legend = page.locator('#legend');
    await expect(legend.locator('.key-key')).toHaveCount(1);
    await expect(legend.locator('.front-key')).toHaveCount(1);
    await expect(legend.locator('.spawn-key')).toHaveCount(1);
  });

  test('the sandbox legend has no key entry', async ({ page }) => {
    await startMatch(page);
    await expect(page.locator('#legend .key-key')).toHaveCount(0);
    await expect(page.locator('#legend .spawn-key')).toHaveCount(1);
    await expect(page.locator('#board .key-mark')).toHaveCount(0);
  });

  test('outlines each spawn in its colour and shows the key at the center', async ({ page }) => {
    await startBootstrap(page);
    const cells = page.locator('#board .cell');
    const at = (x: number, y: number) => cells.nth(y * 5 + x);
    await expect(at(2, 2).locator('.key-mark.center')).toHaveCount(1);
    await expect(at(1, 1)).toHaveAttribute('data-spawn', 'C');
    await expect(at(3, 3)).toHaveAttribute('data-spawn', 'P');
    await expect(page.locator('#board .cell[data-spawn]')).toHaveCount(2);
  });
});
