// Standalone Playwright script that screenshots the current tbtt prototype UI.
// Not part of the test suite; run with `node mockups/current/capture.mjs`.
import { createHash, randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';
import { mkdir } from 'node:fs/promises';
import { statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..', '..');
const OUT_DIR = __dirname;
const PORT = 5173;
const BASE_URL = `http://127.0.0.1:${PORT}`;

// --- Copied from tests/ui.spec.ts: stub Trystero's lazy chunk to keep the UI off the network. ---
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

async function open(page, opts = {}) {
  const peers = opts.peers ?? ['stub-peer'];
  await page.addInitScript((ids) => {
    window.__tbtt = { peers: ids, sent: [], action: null };
  }, peers);

  await page.route(/.*/, (route) => {
    const url = route.request().url();
    if (url.startsWith(BASE_URL)) return route.continue();
    console.warn('blocked external request:', url);
    return route.abort();
  });
  await page.routeWebSocket(/.*/, (ws) => {
    console.warn('blocked websocket:', ws.url());
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

async function createMatch(page, cfg) {
  await page.locator('#fMode').selectOption(cfg.mode);
  await page.locator('#fW').fill(cfg.w);
  await page.locator('#fH').fill(cfg.h);
  await page.locator('#fWall').fill(cfg.wall);
  await page.locator('#fSeed').fill(cfg.seed);
  await page.locator('#fRoster').selectOption(cfg.roster);
  await page.locator('#fCap').fill(cfg.cap);
  await page.locator('#btnMake').click();
}

async function sitDown(page, color, name) {
  const row = page.locator(`#pickRows .pickrow[data-color="${color}"]`);
  await row.click();
  await page.locator('#pickName').fill(name);
  await page.locator('#btnPlay').waitFor({ state: 'visible' });
  await waitEnabled(page.locator('#btnPlay'));
  await page.locator('#btnPlay').click();
  await page.locator('#play').waitFor({ state: 'visible' });
}

function deliver(page, text, peerId = 'stub-peer') {
  return page.evaluate(
    ([t, id]) => window.__tbtt.action?.onMessage?.(t, { peerId: id }),
    [text, peerId],
  );
}

async function stateHash(page) {
  const info = await page.locator('#turnInfo').textContent();
  const hash = /state ([0-9a-f]{4})/.exec(info ?? '')?.[1];
  if (!hash) throw new Error(`no state hash in "${info}"`);
  return hash;
}

// Simulate the other player's commit.
function seal(turn, color, action) {
  const nonce = randomBytes(16).toString('hex');
  const digest = createHash('sha256')
    .update(`${turn}:${color}:${action}:${nonce}`)
    .digest('hex')
    .slice(0, 32);
  return { nonce, commitment: `#${turn}${color}:${digest}` };
}

function revealOf(turn, color, action, hash, nonce, name) {
  const named = turn === 0 && name ? `~${name}` : '';
  return `${turn}${color}:${action}#${hash}${named}|${nonce}`;
}

async function waitEnabled(locator, timeout = 10000) {
  await locator.evaluate((el) => !el.disabled, { timeout }).catch(() => {});
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (await locator.isEnabled()) return;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error('element never became enabled');
}

// Resolve one turn with a simulated Purple opponent. `minePreference` is tried
// in order; the first data-act button that is enabled is clicked. Returns the
// action that was actually used for Coral.
async function resolveTurnPick(page, turn, minePreference, theirs, nameOfP) {
  const hash = await stateHash(page);
  const { nonce, commitment } = seal(turn, 'P', theirs);
  await deliver(page, commitment);

  let chosen = null;
  for (const act of minePreference) {
    const btn = page.locator(`#turnCard [data-act="${act}"]`);
    if ((await btn.count()) === 0) continue;
    if (await btn.isEnabled()) {
      await btn.click();
      chosen = act;
      break;
    }
  }
  if (!chosen) throw new Error(`no legal action among ${minePreference} at turn ${turn}`);

  await waitEnabled(page.locator('#btnCommit'));
  await page.locator('#btnCommit').click();
  await page.locator('#phaseShare').waitFor({ state: 'visible', timeout: 10000 });
  await deliver(page, revealOf(turn, 'P', theirs, hash, nonce, nameOfP));
  try {
    await page.locator('#phaseShare').waitFor({ state: 'hidden', timeout: 10000 });
  } catch (e) {
    console.log(`[t${turn}] netErr=`, await page.locator('#netErr').textContent());
    console.log(`[t${turn}] pending=`, await page.locator('#pending').textContent());
    throw e;
  }
  return chosen;
}

const BOOTSTRAP_CFG = { mode: 'bootstrap', w: '16', h: '9', wall: '11', seed: 'demo', roster: 'CP', cap: '43' };

// Plan of Coral actions to try, in priority order per turn, aimed roughly at
// the center of a 16x9 board (Coral spawns near the top-left corner). One
// entry deliberately prefers 'I' so an invert actually happens.
// Purple always holds: every action (including hold) advances its personal
// world-turn by its facing direction, so a hold-only opponent never inverts
// and its time index only ever increases, which keeps every submitted action
// legal without having to replicate the engine's legality rules here.
const TURN_PLAN = [
  { mine: ['D', 'S', 'H'], theirs: 'H' },
  { mine: ['S', 'D', 'H'], theirs: 'H' },
  { mine: ['D', 'S', 'H'], theirs: 'H' },
  { mine: ['S', 'D', 'H'], theirs: 'H' },
  { mine: ['I', 'D', 'S', 'H'], theirs: 'H' },
  { mine: ['D', 'S', 'H'], theirs: 'H' },
  { mine: ['S', 'D', 'H'], theirs: 'H' },
  { mine: ['D', 'S', 'H'], theirs: 'H' },
];

async function runToMidGame(page) {
  await open(page);
  await createMatch(page, BOOTSTRAP_CFG);
  await page.locator('#pickCard').waitFor({ state: 'visible', timeout: 10000 });
  await sitDown(page, 'C', 'Coral');

  const used = [];
  let invertedOnce = false;
  for (let turn = 0; turn < TURN_PLAN.length; turn++) {
    const over = await page.locator('#phaseOver').isVisible().catch(() => false);
    if (over) break;
    const plan = TURN_PLAN[turn];
    const nameOfP = turn === 0 ? 'Vale' : undefined;
    const chosen = await resolveTurnPick(page, turn, plan.mine, plan.theirs, nameOfP);
    used.push(chosen);
    if (chosen === 'I') invertedOnce = true;
  }
  return { used, invertedOnce };
}

async function fileSize(p) {
  try {
    return statSync(p).size;
  } catch {
    return -1;
  }
}

async function waitForServer(timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${BASE_URL}/index.html`);
      if (res.ok) return true;
    } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 200));
  }
  return false;
}

async function serverAlreadyUp() {
  try {
    const res = await fetch(`${BASE_URL}/index.html`);
    return res.ok;
  } catch {
    return false;
  }
}

function run(cmd, args, opts = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { cwd: ROOT, stdio: 'inherit', ...opts });
    child.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`${cmd} ${args.join(' ')} exited ${code}`))));
    child.on('error', reject);
  });
}

async function main() {
  await mkdir(OUT_DIR, { recursive: true });

  let startedServer = null;
  const reused = await serverAlreadyUp();
  if (reused) {
    console.log('reusing already-running server at', BASE_URL);
  } else {
    console.log('building...');
    await run('npm', ['run', 'build']);
    console.log('starting server...');
    startedServer = spawn('node', ['tools/serve.mjs', 'play', String(PORT)], {
      cwd: ROOT,
      stdio: 'inherit',
    });
    const up = await waitForServer();
    if (!up) throw new Error('server did not come up in time');
  }

  const browser = await chromium.launch();
  const shots = [];

  try {
    // --- Desktop flow ---
    const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, baseURL: BASE_URL });
    const page = await ctx.newPage();
    page.on('pageerror', (e) => console.warn('page error:', e.message));

    await open(page);
    const setupPng = path.join(OUT_DIR, 'setup.png');
    await page.screenshot({ path: setupPng });
    shots.push(setupPng);

    await createMatch(page, BOOTSTRAP_CFG);
    await page.locator('#pickCard').waitFor({ state: 'visible', timeout: 10000 });
    const lobbyPng = path.join(OUT_DIR, 'lobby.png');
    await page.screenshot({ path: lobbyPng });
    shots.push(lobbyPng);

    await sitDown(page, 'C', 'Coral');
    const playStartPng = path.join(OUT_DIR, 'play-start.png');
    await page.screenshot({ path: playStartPng });
    shots.push(playStartPng);

    const used = [];
    let invertedOnce = false;
    for (let turn = 0; turn < TURN_PLAN.length; turn++) {
      const over = await page.locator('#phaseOver').isVisible().catch(() => false);
      if (over) break;
      const plan = TURN_PLAN[turn];
      const nameOfP = turn === 0 ? 'Vale' : undefined;
      const chosen = await resolveTurnPick(page, turn, plan.mine, plan.theirs, nameOfP);
      used.push(chosen);
      if (chosen === 'I') invertedOnce = true;
    }
    console.log('desktop turns used for Coral:', used.join(','), 'inverted:', invertedOnce);

    const keyPickedUp = await page.locator('#log').textContent().then((t) => /picked up the key/.test(t ?? ''));
    const wonOrOver = await page.locator('#phaseOver').isVisible().catch(() => false);
    console.log('key picked up during desktop run:', keyPickedUp, 'match over:', wonOrOver);

    const playMidPng = path.join(OUT_DIR, 'play-mid.png');
    await page.screenshot({ path: playMidPng });
    shots.push(playMidPng);

    await page.locator('#btnTheme').click();
    await page.locator('html').waitFor({ state: 'attached' });
    const playMidLightPng = path.join(OUT_DIR, 'play-mid-light.png');
    await page.screenshot({ path: playMidLightPng });
    shots.push(playMidLightPng);

    // Switch back to dark before element screenshots so they match the rest.
    await page.locator('#btnTheme').click();

    const boardOnlyPng = path.join(OUT_DIR, 'board-only.png');
    await page.locator('.boardframe').screenshot({ path: boardOnlyPng });
    shots.push(boardOnlyPng);

    const stripOnlyPng = path.join(OUT_DIR, 'strip-only.png');
    await page.locator('#strip').screenshot({ path: stripOnlyPng });
    shots.push(stripOnlyPng);

    const turnCardOnlyPng = path.join(OUT_DIR, 'turncard-only.png');
    await page.locator('#turnCard').screenshot({ path: turnCardOnlyPng });
    shots.push(turnCardOnlyPng);

    await ctx.close();

    // --- Mobile flow: re-run to the same mid-game state at a phone viewport ---
    const mctx = await browser.newContext({ viewport: { width: 390, height: 844 }, baseURL: BASE_URL });
    const mpage = await mctx.newPage();
    mpage.on('pageerror', (e) => console.warn('mobile page error:', e.message));
    const mResult = await runToMidGame(mpage);
    console.log('mobile turns used for Coral:', mResult.used.join(','), 'inverted:', mResult.invertedOnce);

    const mobilePng = path.join(OUT_DIR, 'mobile.png');
    await mpage.screenshot({ path: mobilePng, fullPage: true });
    shots.push(mobilePng);

    await mctx.close();
  } finally {
    await browser.close();
    if (startedServer) {
      startedServer.kill();
    }
  }

  console.log('\nCaptured files:');
  for (const s of shots) {
    console.log(` ${s} (${await fileSize(s)} bytes)`);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
