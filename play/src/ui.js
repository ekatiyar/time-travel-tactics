import { Match, Wire, COLORS } from './engine.js';
import { Session, Code, PeerChannel, trimUnresolved } from './transport.js';

var $ = function (id) { return document.getElementById(id); };
function plural(n, word) { return n + ' ' + word + (n === 1 ? '' : 's'); }

// ---------- renderers: pure view -> DOM, no Match access ----------

// Rank the distinct world turns that actually have a visible dot, then spread
// opacity across the whole range. Fading by raw distance instead puts three dots
// at 1.00 / 0.92 / 0.83, which reads as one shade. On a busy board the two
// converge; this only bites when there is little to show.
function shade(bodies, focusT, lookBack) {
  var floor = parseFloat(getComputedStyle(document.documentElement)
    .getPropertyValue('--dot-floor')) || 0.14;
  var lo = Math.max(0, focusT - lookBack), seen = {};
  bodies.forEach(function (b) { if (b.t >= lo && b.t < focusT) seen[b.t] = 1; });
  var turns = Object.keys(seen).map(Number).sort(function (a, b) { return b - a; });
  var out = new Map();
  turns.forEach(function (t, i) {
    out.set(t, turns.length < 2 ? 1 : 1 - (1 - floor) * (i / (turns.length - 1)));
  });
  return out;
}

function nameOf(view, color) { return view.names[color] || COLORS[color].name; }

function renderBoard(el, view, focusT, lookBack, picked, onPick) {
  var lo = Math.max(0, focusT - lookBack);
  el.style.setProperty('--bw', view.w);
  el.style.setProperty('--bh', view.h);
  var wall = {};
  view.walls.forEach(function (p) { wall[p[0] + ',' + p[1]] = 1; });

  var op = shade(view.bodies, focusT, lookBack);
  var atFocus = {}, history = {};
  view.bodies.forEach(function (b) {
    var k = b.x + ',' + b.y;
    if (b.t === focusT) (atFocus[k] = atFocus[k] || []).push(b);
    else if (b.t >= lo && b.t < focusT) (history[k] = history[k] || []).push(b);
  });

  // Only offer actions while looking at the slice you actually act from. Invert
  // is left off the board. It lands on the tile you already stand on, which is
  // where hold goes, and hold is the one you mean when you click yourself.
  var targets = {};
  if (onPick && focusT === view.me.t) {
    view.actions.forEach(function (a) {
      if (a.action !== 'I') targets[a.x + ',' + a.y] = a;
    });
  }

  el.innerHTML = '';
  for (var y = 0; y < view.h; y++) {
    for (var x = 0; x < view.w; x++) {
      var k = x + ',' + y, cell = document.createElement('div');
      cell.className = 'cell';
      var tg = targets[k];

      if (wall[k]) cell.style.cssText += 'background:var(--wall);opacity:.38;';
      else if (tg && tg.reason === null) {
        cell.style.cssText += 'background:var(--accent-bg);cursor:pointer;' +
          (picked === tg.action
            ? 'outline:2px solid var(--accent-br);outline-offset:-2px;'
            : 'outline:1.5px solid var(--accent-br);outline-offset:-1.5px;opacity:.75;');
        cell.title = tg.action === 'H' ? 'hold' : 'move ' + tg.action;
        (function (a) { cell.onclick = function () { onPick(a); }; })(tg.action);
      } else if (tg) {
        cell.style.cssText += 'background:var(--wall);opacity:.55;';
        cell.title = 'blocked — ' + tg.reason;
      } else {
        cell.style.cssText += 'background:var(--surface-1);';
      }

      var foc = atFocus[k];
      if (foc && !wall[k]) {
        foc.sort(function (a, b) { return a.p - b.p; });
        var c = COLORS[foc[0].color], tok = document.createElement('div');
        tok.className = 'tok';
        tok.style.cssText = 'background:' + c.hex + ';color:' + c.ink + ';' +
          (foc.length > 1 ? 'padding:0 5%;border-radius:9999px;' : 'aspect-ratio:1;border-radius:50%;');
        tok.textContent = foc.map(function (b) { return b.p; }).join('·');
        tok.title = foc.map(function (b) { return describe(view, b); }).join('\n');
        cell.appendChild(tok);
      }
      var past = history[k];
      if (past && !wall[k]) {
        // A live token already eats most of the cell, so show fewer trail dots beside it.
        past.sort(function (a, b) { return b.t - a.t; }).slice(0, foc ? 2 : 4).forEach(function (b) {
          var d = document.createElement('div');
          d.className = 'trail';
          d.style.background = COLORS[b.color].hex;
          d.style.opacity = op.get(b.t);
          d.title = describe(view, b);
          cell.appendChild(d);
        });
      }
      el.appendChild(cell);
    }
  }
}

function describe(view, b) {
  return nameOf(view, b.color) + ' · index ' + b.p + ' · world turn ' + b.t + (b.live ? ' · live' : '');
}

function renderStrip(el, view, focusT, lookBack) {
  var lo = Math.max(0, focusT - lookBack);
  var span = Math.max(view.me.horizon + 1, 1);
  var heads = {};
  view.bodies.forEach(function (b) { if (b.live) (heads[b.t] = heads[b.t] || []).push(b.color); });

  var bar = '<div style="display:flex;gap:2px;margin-bottom:3px;">';
  var num = '<div style="display:flex;gap:2px;">';
  var head = '<div style="display:flex;gap:2px;margin-bottom:2px;">';
  for (var t = 0; t < span; t++) {
    var inWin = t >= lo && t <= focusT;
    bar += '<div style="flex:1;min-width:3px;height:9px;border-radius:2px;background:' +
      (inWin ? 'var(--text-secondary)' : 'var(--surface-2)') +
      ';opacity:' + (t === focusT ? 1 : inWin ? 0.4 : 1) + ';"></div>';
    var hs = (heads[t] || []).map(function (c) {
      return '<i style="display:inline-block;width:5px;height:5px;border-radius:50%;background:' + COLORS[c].hex + ';"></i>';
    }).join('');
    head += '<div style="flex:1;min-width:3px;height:7px;text-align:center;line-height:0;">' + hs + '</div>';
    num += '<div style="flex:1;min-width:3px;text-align:center;font-size:9.5px;font-family:var(--mono);color:' +
      (t === focusT ? 'var(--text-primary)' : 'var(--text-muted)') + ';">' +
      (span <= 24 || t % 5 === 0 ? t : '') + '</div>';
  }
  // Beyond your horizon, dashed and unreadable.
  var beyond = '';
  if (!view.over && view.me.horizon < view.cap) {
    beyond = '<div style="flex:2;min-width:14px;height:9px;border-radius:2px;border:1px dashed var(--border);"></div>';
  }
  el.innerHTML = head + '</div>' + bar + beyond + '</div>' + num + '</div>' +
    '<div class="muted" style="font-size:11.5px;margin-top:4px;">your horizon is t' + view.me.horizon +
    (beyond ? ' — dashed means you have not been there' : '') + '</div>';
}

function renderLegend(el, view) {
  el.innerHTML = view.roster.map(function (c) {
    return '<span><i class="sw" style="background:' + COLORS[c].hex + '"></i>' + nameOf(view, c) + '</span>';
  }).join('') +
    '<span><i class="sw" style="width:6px;height:6px;background:var(--text-muted);opacity:.4"></i>earlier turns</span>' +
    '<span>number = personal index</span>';
}

// Every turn so far, newest first, with a rule between meta turns.
function renderLog(el, view) {
  if (!view.events.length) { el.innerHTML = '<li class="muted">Nothing yet.</li>'; return; }
  var byTurn = [];
  view.events.forEach(function (e) {
    if (!byTurn.length || byTurn[byTurn.length - 1].turn !== e.turn) {
      byTurn.push({ turn: e.turn, rows: [] });
    }
    byTurn[byTurn.length - 1].rows.push(e);
  });
  byTurn.reverse();
  el.innerHTML = byTurn.map(function (g, i) {
    return (i ? '<li class="turnsep"></li>' : '') + g.rows.map(function (e) {
      return '<li><span class="m">t' + e.turn + '</span>' +
        '<i class="sw" style="background:' + COLORS[e.color].hex + '"></i>' +
        '<span><strong style="font-weight:500;color:var(--text-primary);">' +
        nameOf(view, e.color) + '</strong> ' + eventText(view, e) + '</span></li>';
    }).join('');
  }).join('');
}

function eventText(view, e) {
  var at = '(' + e.x + ',' + e.y + ')';
  if (e.kind === 'moved') return 'moved to ' + at + ' at t' + e.t;
  if (e.kind === 'held') return 'held ' + at + ' — cost a world turn, not a step';
  if (e.kind === 'inverted') {
    return 'inverted at ' + at + ' — still t' + e.t + ', now walking ' +
      (e.dir === 1 ? 'forward' : 'backward');
  }
  if (e.kind === 'blocked') return 'was blocked by ' + nameOf(view, e.by) + ' and stayed at ' + at;
  return 'was stuck — turn skipped';
}

// ---------- app state ----------

var match = null, pick = null, focusT = 0, lookBack = 999, shownTurn = -1;
var session = null, channel = null;

// One source of truth for which seat is yours. A claim that arrives late
// outranks yours, so the session can take the seat away, and the app has to notice.
function me() { return session ? session.color() : null; }

// Theme is a display preference, so it persists even though match state never does.
var THEME_KEY = 'tbtt-theme';
function setTheme(t) {
  document.documentElement.setAttribute('data-theme', t);
  $('btnTheme').textContent = t === 'light' ? 'Dark' : 'Light';
  try { localStorage.setItem(THEME_KEY, t); } catch (e) { /* storage off */ }
  if (match && me()) refresh();
}
var saved = null;
try { saved = localStorage.getItem(THEME_KEY); } catch (e) { /* storage off */ }
setTheme(saved === 'light' ? 'light' : 'dark');
$('btnTheme').onclick = function () {
  setTheme(document.documentElement.getAttribute('data-theme') === 'light' ? 'dark' : 'light');
};

function randomSeed() {
  return Math.floor(Math.random() * 0x100000000).toString(36).slice(0, 6);
}
function suggestCap(w, h) { return Math.ceil(1.7 * (w + h)); }

// ---------- setup screen ----------

$('fSeed').value = randomSeed();
function syncCap() { $('fCap').value = suggestCap(+$('fW').value || 16, +$('fH').value || 9); }
$('fW').oninput = syncCap; $('fH').oninput = syncCap; syncCap();

var panes = { tabNew: 'paneNew', tabJoin: 'paneJoin', tabImport: 'paneImport' };
Object.keys(panes).forEach(function (tab) {
  $(tab).onclick = function () {
    Object.keys(panes).forEach(function (o) {
      $(o).classList.toggle('on', o === tab);
      $(panes[o]).classList.toggle('hide', o !== tab);
    });
    $('setupErr').textContent = '';
  };
});

var chosen = null;

function offerColours(m) {
  match = m;
  chosen = null;
  var code = Wire.encodeMatchCode(m.config());
  $('outCode').value = code;
  if (session) session.close();
  channel = PeerChannel(Code.roomId(code));
  session = Session.open({ match: m, channel: channel, onChange: onSessionChange });
  $('pickCard').classList.remove('hide');
  var known = m.view(m.config().roster[0]).names;
  $('pickRows').innerHTML = m.config().roster.map(function (c) {
    return '<div class="pickrow" data-color="' + c + '">' +
      '<i class="sw" style="background:' + COLORS[c].hex + '"></i>' +
      '<span class="sec" style="width:56px;flex:none;">' + COLORS[c].name + '</span>' +
      '<input type="text" maxlength="12" placeholder="your name" value="' +
      (known[c] || '').replace(/"/g, '&quot;') + '" />' +
      '<span class="sec who" style="flex:none;"></span></div>';
  }).join('');
  var rows = document.querySelectorAll('#pickRows .pickrow');
  Array.prototype.forEach.call(rows, function (row) {
    row.onclick = function () {
      Array.prototype.forEach.call(rows, function (o) { o.classList.toggle('on', o === row); });
      chosen = row.getAttribute('data-color');
      row.querySelector('input').focus();
      syncPlay();
    };
    row.querySelector('input').oninput = syncPlay;
    row.querySelector('input').onkeydown = function (e) {
      if (e.key === 'Enter' && !$('btnPlay').disabled) $('btnPlay').click();
    };
  });
  syncClaims();
}

function onSessionChange() {
  // Losing the seat mid-play is not a message to read on someone else's board.
  // Back to the picker, where the reason and the free colours already live.
  if (!$('play').classList.contains('hide') && !me()) toPicker();
  if ($('play').classList.contains('hide')) syncClaims(); else refresh();
}

function toPicker() {
  $('play').classList.add('hide');
  $('setup').classList.remove('hide');
  pick = null;
  shownTurn = -1;
  Array.prototype.forEach.call(document.querySelectorAll('#pickRows .pickrow'), function (row) {
    row.classList.remove('on');
  });
  chosen = null;
}

// Claimed colours grey out. The rows are never rebuilt, so a name someone is
// half-way through typing survives another player claiming a different colour.
function syncClaims() {
  if (!session) return;
  var claims = session.claims();
  Array.prototype.forEach.call(document.querySelectorAll('#pickRows .pickrow'), function (row) {
    var held = claims[row.getAttribute('data-color')];
    var theirs = held && held.clientId !== channel.id;
    row.classList.toggle('taken', !!theirs);
    row.querySelector('.who').textContent = theirs ? held.name : '';
  });
  var v = session.view();
  $('pickErr').textContent = v.notice || v.error || '';
  syncPlay();
}

// A name is refused rather than stripped, so nobody types a tilde and quietly
// ends up called something else.
function syncPlay() {
  var on = document.querySelector('#pickRows .pickrow.on');
  // Trimmed before checking. A space is not a legal name character, so a stray
  // one off a paste would otherwise dead-end the Play button.
  var raw = (on ? on.querySelector('input').value : '').trim();
  var bad = raw.length && !/^[A-Za-z0-9_-]{1,12}$/.test(raw);
  $('nameErr').textContent = bad
    ? 'A name can only use letters, digits, - and _, up to 12 characters.' : '';
  // A turn needs everyone in before anything opens, so an empty room is not a
  // match you can start playing. Waiting here beats walking into one and hanging.
  var v = session ? session.view() : { status: 'offline', peersNeeded: 1 };
  var live = v.status === 'live';
  $('pickWait').textContent = live ? '' : (v.status === 'failed'
    ? 'No connection: ' + (v.detail || 'the relays did not answer.')
    : 'Waiting for ' + plural(v.peersNeeded, 'more player') + ' to open this match code.');
  $('btnPlay').disabled = !(live && on && !on.classList.contains('taken') && raw && !bad);
}

$('btnPlay').onclick = function () {
  var on = document.querySelector('#pickRows .pickrow.on');
  if (!on) return;
  var name = on.querySelector('input').value.trim();
  var r = session.claim(chosen, name);
  if (!r.ok) { syncClaims(); return; }   // the refusal is already a notice
  start();
};

$('btnMake').onclick = function () {
  try {
    var cfg = {
      w: +$('fW').value, h: +$('fH').value, wallPct: +$('fWall').value,
      seed: $('fSeed').value.trim(), cap: +$('fCap').value,
      roster: $('fRoster').value.split('')
    };
    offerColours(Match.fromConfig(cfg));
    $('setupErr').textContent = '';
  } catch (e) {
    $('setupErr').textContent = String(e.message || e);
  }
};

$('btnJoin').onclick = function () {
  var r = Wire.decodeMatchCode($('fCode').value);
  if (!r.ok) { $('setupErr').textContent = r.error; return; }
  try {
    offerColours(Match.fromConfig(r.value));
    $('setupErr').textContent = '';
  } catch (e) { $('setupErr').textContent = String(e.message || e); }
};

$('btnImport').onclick = function () {
  var r = Match.fromExport(trimUnresolved($('fExport').value));
  if (!r.ok) { $('setupErr').textContent = r.error; return; }
  offerColours(r.value);
  $('setupErr').textContent = '';
};

$('btnCopyCode').onclick = function () { copy($('outCode'), this, 'Copy match code'); };

// ---------- play screen ----------

function start() {
  $('setup').classList.add('hide');
  $('play').classList.remove('hide');
  var v = session.view();
  // A quarter of the turn cap is as far back as the window ever reaches. At the
  // full cap every dot ever recorded lands in one cell.
  var maxBack = Math.max(1, Math.ceil(v.cap / 4));
  $('rd').max = maxBack; $('rd').value = maxBack;
  $('rdNote').textContent = 'look back caps at ' + maxBack +
    ' — a quarter of the ' + v.cap + '-turn cap';
  refresh();
}

function refresh() {
  if (!me()) return;
  var v = session.view();
  var c = COLORS[v.me.color];

  // A resolved turn moves your playhead, and the world turn follows it. Keyed on
  // the turn number rather than on who resolved it, so committing, receiving and
  // importing all get the same behaviour and the slider still scrubs freely.
  if (v.turn !== shownTurn) { shownTurn = v.turn; focusT = v.me.t; }
  if (focusT > v.me.horizon) focusT = v.me.horizon;
  $('sl').max = v.me.horizon;
  $('sl').value = focusT;
  $('slo').textContent = focusT;
  lookBack = +$('rd').value;
  $('rdo').textContent = lookBack;

  // Hold first, then invert. An inverted player at t0 can do nothing else, and
  // leaving Commit dead there points at nothing.
  if (pick && !legalNow(v, pick)) pick = null;
  if (!pick && !v.over && !committed(v)) {
    pick = legalNow(v, 'H') ? 'H' : legalNow(v, 'I') ? 'I' : null;
  }

  $('youAre').innerHTML = '<span class="pill" style="background:' + c.hex + ';color:' + c.ink + '">' +
    nameOf(v, v.me.color) + '</span>';
  $('youAt').textContent = 'index ' + v.me.p + ' · t' + v.me.t + ' · ' +
    (v.me.dir === 1 ? 'forward' : 'inverted') + ' · (' + v.me.x + ',' + v.me.y + ')';
  $('turnInfo').textContent = v.over ? 'match over at turn ' + v.cap
    : 'turn ' + v.turn + ' / ' + v.cap + ' · state ' + v.hash;
  $('prioInfo').innerHTML = v.over ? 'the match is over' : v.priority.map(function (x) {
    return '<span style="display:inline-flex;align-items:center;gap:5px;">' +
      '<i class="sw" style="background:' + COLORS[x].hex + '"></i>' + nameOf(v, x) + '</span>';
  }).join(' &rsaquo; ');

  // Once committed the pick panel is hidden, so a board click could only arm a
  // move invisibly and fire it on the next turn. Kill the handler instead.
  renderBoard($('board'), v, focusT, lookBack, pick,
    v.over || committed(v) ? null : setPick);
  renderStrip($('strip'), v, focusT, lookBack);
  renderLegend($('legend'), v);
  renderLog($('log'), v);
  $('outExport').value = session.export();

  var lbl = { offline: 'not connected', connecting: 'connecting\u2026', live: 'live',
    failed: 'connection failed, export to rejoin' }[v.status] || v.status;
  $('netInfo').textContent = 'turns move: ' + lbl +
    (v.peersNeeded ? ' \u00b7 waiting for ' + plural(v.peersNeeded, 'more player') : '') +
    (v.status === 'live' ? ' \u00b7 ' + plural(v.peers.length, 'peer') : '') +
    (v.detail ? ' \u00b7 ' + v.detail : '');
  $('netErr').textContent = v.error || v.notice || '';

  $('phaseOver').classList.toggle('hide', !v.over);
  $('phasePick').classList.toggle('hide', v.over || committed(v));
  $('phaseShare').classList.toggle('hide', v.over || !committed(v));

  if (!v.over && !committed(v)) renderPad(v);
  if (!v.over && committed(v)) {
    $('pending').textContent = v.waiting.length
      ? 'still waiting on: ' + v.waiting.map(function (x) { return nameOf(v, x); }).join(', ')
      : 'everyone is in, opening';
    // Your action is out in the open the moment the last commitment lands, so
    // there is nothing left to take back and the button says so by leaving.
    $('btnUndo').classList.toggle('hide', !v.canChange);
    $('keyUndo').classList.toggle('hide', !v.canChange);
  }
}

function committed(v) { return v.pending.indexOf(v.me.color) < 0; }

function legalNow(v, a) {
  for (var i = 0; i < v.actions.length; i++) {
    if (v.actions[i].action === a) return v.actions[i].reason === null;
  }
  return false;
}

var LABEL = { W: 'up', A: 'left', S: 'down', D: 'right', H: 'hold', I: 'invert' };

function setPick(action) {
  var v = session.view();
  if (v.over || committed(v) || !legalNow(v, action)) return;
  pick = action;
  renderPad(v);
  renderBoard($('board'), v, focusT, lookBack, pick, setPick);
}

// Hold is preselected whenever it is legal, so Commit always says what Enter
// will do rather than sitting disabled with no explanation.
function renderPad(v) {
  var reasons = {};
  v.actions.forEach(function (a) { reasons[a.action] = a.reason; });
  Array.prototype.forEach.call(document.querySelectorAll('#turnCard [data-act]'), function (b) {
    var a = b.getAttribute('data-act');
    b.disabled = reasons[a] !== null;
    b.title = reasons[a] || (a === 'H' ? 'hold this square' : a === 'I' ? 'turn around in time' : 'move ' + LABEL[a]);
    b.classList.toggle('sel', pick === a);
  });
  $('btnCommit').disabled = !pick;
  $('btnCommit').textContent = pick ? 'Commit ' + LABEL[pick] : 'Commit';
  $('pickWhy').textContent = pick === 'I'
    ? 'Inverting keeps your world turn. You stay on this tile at t' + v.me.t +
      ' and start walking ' + (v.me.dir === 1 ? 'back' : 'forward') + '.'
    : pick === 'H'
      ? 'Holding costs a world turn but not a step. Nobody can take this tile off you.'
      : reasons.H !== null ? 'Holding is blocked here — ' + reasons.H + '.' : '';
}

// commit hashes before it sends, so this is async and the button has to stay
// down for the whole round trip or Enter twice commits twice.
$('btnCommit').onclick = function () {
  if (!pick || $('btnCommit').disabled) return;
  var chosen = pick;
  $('btnCommit').disabled = true;
  session.commit(chosen).then(function (r) {
    // The share phase is still hidden here, so a failed commit has to report
    // into the pick phase or it reports nowhere.
    if (!r.ok) {
      $('pickMsg').innerHTML = '<div class="err">' + r.error + '</div>';
      refresh();
      return;
    }
    $('pickMsg').innerHTML = '';
    $('shareMsg').innerHTML = '';
    pick = null;
    $('btnCommit').textContent = 'Commit';
    refresh();
  });
};

Array.prototype.forEach.call(document.querySelectorAll('#turnCard [data-act]'), function (b) {
  b.onclick = function () { setPick(b.getAttribute('data-act')); };
});

// Arrows and WASD aim, Enter commits, Escape goes back to the default. Invert is
// deliberately keyless. It flips your direction, which should not sit one
// keystroke from a movement key.
document.addEventListener('keydown', function (e) {
  if (!match || !me() || $('play').classList.contains('hide')) return;
  if (/^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName)) return;
  if (e.metaKey || e.ctrlKey || e.altKey) return;
  var v = session.view();

  if (e.key === 'Enter') {
    var btn = $('btnCommit');
    if (!btn.disabled && !btn.closest('.hide')) { btn.click(); e.preventDefault(); }
    return;
  }
  // Escape means "undo the last step of this turn" in both phases. Take the
  // action back if it is committed, otherwise drop the aim.
  if (e.key === 'Escape') {
    if (committed(v)) { if (v.canChange) undo(); } else { pick = null; refresh(); }
    e.preventDefault();
    return;
  }
  if (committed(v) || v.over) return;
  var k = { ArrowUp: 'W', ArrowDown: 'S', ArrowLeft: 'A', ArrowRight: 'D',
    w: 'W', a: 'A', s: 'S', d: 'D', W: 'W', A: 'A', S: 'S', D: 'D' }[e.key];
  if (k) { setPick(k); e.preventDefault(); }
});

function undo() {
  var r = session.withdraw();
  if (!r.ok) { $('shareMsg').innerHTML = '<div class="err">' + r.error + '</div>'; return; }
  $('shareMsg').innerHTML = '';
  refresh();
}

$('btnUndo').onclick = undo;

$('btnCopyExport').onclick = function () { copy($('outExport'), this, 'Copy export'); };

$('sl').oninput = function () { focusT = +this.value; refresh(); };
$('rd').oninput = function () { refresh(); };

function copy(area, btn, restore) {
  area.select();
  navigator.clipboard.writeText(area.value).catch(function () { document.execCommand('copy'); });
  btn.textContent = 'Copied';
  setTimeout(function () { btn.textContent = restore; }, 1200);
}
