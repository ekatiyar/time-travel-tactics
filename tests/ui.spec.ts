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
  const info = await page.locator('#turnInfo').textContent();
  const hash = /state ([0-9a-f]{4})/.exec(info ?? '')?.[1];
  if (!hash) throw new Error(`no state hash in "${info}"`);
  return hash;
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

// Resolve one turn with a simulated opponent.
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
    await expect(page.locator('#turnInfo')).toContainText('turn 0 / 8');
    await expect(page.locator('#netInfo')).toHaveText('Connected · 1 other player');
    await expect(page.locator('#rdNote')).toHaveText('up to 2 turns of history');
    await expect(page.locator('#legend')).toContainText('Rook');
    await expect(page.locator('#log li')).toHaveText('No turns yet.');
    await expect(page.locator('#phasePick')).toBeVisible();
    await expect(page.locator('#phaseShare')).toBeHidden();
    await expect(page.locator('#phaseOver')).toBeHidden();
    await expect(page.locator('#outExport')).toHaveCount(0);
    await expect(page.getByText('Still choosing: You, Purple')).toBeVisible();
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
    // Spawn is inset from the corner now, so walk to (0,0) first.
    await resolveTurn(page, 0, 'A', 'H', 'Rival');
    await resolveTurn(page, 1, 'W', 'H');
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
    await expect(page.locator('#pending')).toHaveText('Still choosing: Purple');
    await expect(page.locator('#btnUndo')).toBeVisible();

    await page.locator('#btnUndo').click();
    await expect(page.locator('#phasePick')).toBeVisible();
    await expect(page.locator('#phaseShare')).toBeHidden();
    await expect(page.locator('#btnCommit')).toHaveText('Commit hold');
  });

  test('keeps the resume URL at the completed boundary during a partial turn', async ({ page }) => {
    await startMatch(page);
    const boundary = await page.evaluate(() => location.hash);
    await page.locator('#turnCard [data-act="D"]').click();
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
    await expect(page.getByText('Still choosing: You, Vale')).toBeVisible();

    const hash = await stateHash(page);
    const { nonce, commitment } = seal(0, 'P', 'H');
    await deliver(page, commitment);
    await expect(page.getByText('Still choosing: You')).toBeVisible();

    await page.locator('#turnCard [data-act="D"]').click();
    await page.locator('#btnCommit').click();
    await expect(page.getByText('All actions are in.')).toBeVisible();
    await deliver(page, revealOf(0, 'P', 'H', hash, nonce, 'Vale'));
  });

  test('Space commits only from general gameplay focus', async ({ page }) => {
    await startMatch(page);
    await page.locator('#legend').click();
    await page.keyboard.press('Space');
    await expect(page.locator('#phaseShare')).toBeVisible();
  });

  test('Space on an interactive control does not commit', async ({ page }) => {
    await startMatch(page);
    await page.locator('#turnCard [data-act="D"]').click();
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

    await page.locator('#turnCard [data-act="D"]').click();
    await page.locator('#btnCommit').click();
    await expect(page.locator('#phaseShare')).toBeVisible();
    await expect(page.locator('#pending')).toHaveText('All actions are in.');
    await expect(page.locator('#btnUndo')).toBeHidden();

    await deliver(page, revealOf(0, 'P', 'H', hash, nonce, 'Rival'));

    await expect(page.locator('#turnInfo')).toContainText('turn 1 / 8');
    await expect(page.locator('#youAt')).toHaveText('index 1 · t1 · forward · (2,1)');
    await expect(page.locator('#log li')).toHaveCount(2);
    await expect(page.locator('#log')).toContainText('Rook moved to (2,1) at t1');
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
    await expect(page.locator('#board .trail')).toHaveCount(0);
    await expect(page.locator('#board .tok').first()).toHaveAttribute('title', /world turn 0/);

    await page.locator('#sl').press('End');
    await expect(page.locator('#slo')).toHaveText('1');
    await expect(page.locator('#board .trail')).toHaveCount(2);
  });

  test('the history slider drops the trail', async ({ page }) => {
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
    await deliver(page, '!C~Thief@0-lower');

    await expect(page.locator('#setup')).toBeVisible();
    await expect(page.locator('#play')).toBeHidden();
    await expect(page.locator('#pickErr')).toContainText('Coral was claimed first by Thief');
  });

  test('priority names both seats, and the note under the pad explains the aim', async ({ page }) => {
    await startMatch(page);
    await expect(page.locator('#prioInfo')).toContainText('Rook');
    await expect(page.locator('#prioInfo')).toContainText('\u203a');
    await expect(page.locator('#pickWhy')).toContainText('This uses a world turn');
    await page.locator('#turnCard [data-act="I"]').click();
    await expect(page.locator('#pickWhy')).toContainText('Stay at t0');
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
      const cellBox = node.parentElement!.getBoundingClientRect();
      return {
        width: tokenBox.width, height: tokenBox.height,
        within: tokenBox.left >= cellBox.left && tokenBox.right <= cellBox.right
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
    const geometry = await cell.evaluate((node) => {
      const box = node.getBoundingClientRect();
      const token = node.querySelector('.tok')!.getBoundingClientRect();
      const trails = node.querySelector('.trail-cluster')!.getBoundingClientRect();
      const center = (r: DOMRect, axis: 'x' | 'y') => axis === 'x'
        ? r.left + r.width / 2 : r.top + r.height / 2;
      const overlap = !(token.right <= trails.left || trails.right <= token.left ||
        token.bottom <= trails.top || trails.bottom <= token.top);
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
    await expect(page.locator('#prioInfo')).toHaveText('match over');
    await expect(page.locator('#board .cell')).toHaveCount(25);
  });

  test('the history slider caps its range', async ({ page }) => {
    await open(page);
    await createMatch(page, { cap: '40' });
    await sitDown(page);
    await expect(page.locator('#rdNote')).toHaveText('up to 10 turns of history');
    await expect(page.locator('#rdo')).toHaveText('10');
    await expect(page.locator('#rd')).toHaveAttribute('max', '10');
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
    await expect(page.locator('#phaseOver h2')).toHaveText('You won');
    await expect(page.locator('#turnInfo')).toContainText('You won at turn 3');
    await expect(page.locator('#phasePick')).toBeHidden();
    await expect(page.locator('#phaseShare')).toBeHidden();
    await expect(page.locator('#prioInfo')).toHaveText('match over');
    await expect(page.locator('#turnCard [data-act="D"]')).toBeHidden();
    await expect(page.locator('#btnCommit')).toBeHidden();
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
    const cells = page.locator('#board .cell');
    const front = cells.nth(1 * 5 + 2).locator('.front-mark');
    await expect(front).toHaveCount(1);
    await expect(front).toHaveAttribute('title', title);
    await expect(page.locator('#board .front-mark')).toHaveCount(1);
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
