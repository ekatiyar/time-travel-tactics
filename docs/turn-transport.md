# Turn Transport

*Companion to `time-travel-tactics-design-doc.md`. Covers how turns get from one player to
another. Built, in `play/index.html`. No game mechanics change here.*

---

## 1. The problem it solves

The v0.2 prototype exchanged turns by copy-paste. Every meta-turn cost both players a copy, a
switch to a chat app, a paste, a switch back, and a paste in. On the default board that is 43
turns of clerical work between decisions.

The target: share a code once at the start, then never think about transport again. No links to
click, no separate chat channel, no per-turn clipboard work.

Two other sharing features are fine and stay untouched. The match code
(`M1:16x9:11:19f4:43:CPTA`) is a staple of browser games, and export/import (`X1:...`) is
genuinely useful in a game like this.

---

## 2. Constraints

On top of the hosting limits in [`hosting.md`](hosting.md):

| Constraint | Status |
|---|---|
| No infrastructure of our own to run | Decided |
| **No accounts or sign-ups for third-party services** | Decided |
| No links to click, no separate chat channel | Decided |
| Share a code once; minimal setup | Decided |
| Cheat resistance via hashing | Built (§5) |

The no-accounts constraint rules out more than it looks like it does. See §7.

---

## 3. What the engine gives the transport

The engine makes this much cheaper than it looks.

- **The engine is transport-agnostic.** `Match` has no DOM access. The whole integration point is
  `submit({turn, color, action, hash})` and `pendingColors()`. Any transport is a thin adapter
  over those two calls.
- **A turn message is tiny.** `Wire.encodeAction` produces about twelve bytes (`7C:N#a3f2`).
- **`submit` is effectively idempotent.** A duplicate returns *"has already acted this turn"*.
  At-least-once delivery with duplicates is safe.
- **Ordering does not matter.** `_derive` breaks out of its loop on the first incomplete turn, so
  actions can arrive in any order and the match advances when a turn fills up.
- **Divergence is already detected.** The 4-hex state hash in every action string rejects stale or
  forked messages before they can corrupt a match.

So the network layer needs no acks, no ordering guarantees and no retry logic. It can be dumb.

---

## 4. The transport

WebRTC peer-to-peer, with signalling over nostr, via
[Trystero](https://github.com/dmotz/trystero). The match code becomes the room, so there is
nothing new for players to share.

The risk was NAT. NAT traversal is a WebRTC-only problem, and under §2's constraints it is
unfixable. The standard fix is a TURN server, and every free TURN option wants an account:
Cloudflare Realtime asks for a payment method, Metered Open Relay for an API key. Static
hosting gives us nowhere to put the credentials anyway.

Measured instead of designed around. Two machines on separate networks play a match in both
Chrome and Firefox. Stock Firefox 153 runs the real transport; a peer appears in about 4s in both
browsers, as it does in Chromium.

`file://` measurements, which the dev loop depends on:

| | Result |
|---|---|
| Remote ES module from esm.sh | works |
| A locally vendored `.js` module | blocked by CORS |
| Classic `<script src>` from a CDN | works |
| `crypto.subtle`, Chromium and Firefox | works, `isSecureContext` is true in both |

So the `file://` dev loop survives, and no local http server is needed. **Do not vendor the
library here**, because the local copy is the one the browser refuses. That is a property of
`file://` rather than of the hosting; served over http, a local module loads fine.

### The relay draw

Trystero shuffles its 47-relay pool by `appId` and takes the first five. A fixed appId therefore
draws the same five relays for every match ever played, dead ones included. Measured across eight
appIds, one browser context each so no relay sockets were shared:

| appId | alive of 5 |
|---|---|
| `tbtt` (a fixed one) | 3 |
| six per-match variants | 5, 4, 4, 4, 4, 3 |
| `tbtt-ffff` | 3 |

The appId is derived from the room id, which both peers already compute identically from the
match code. That averages 3.75 of 5 against a fixed 3. It does not silence the console. Roughly
one dead relay per match remains. What it removes is being locked to the same below-average five
forever.

Filtering the pool would go further and is deliberately **not** done. The only dead list we could
write is a single measurement from one network at one moment, and it contains `relay.damus.io`,
one of the largest relays on the network and far more likely to have been briefly unreachable
than actually gone.

### No fallback

Per-turn paste is gone. A connection that dies mid-match has no fallback. Recovery is export and
re-import, and the status line has to be honest about that. Export and import themselves are
untouched, because they live on the setup screen and are the rejoin path rather than per-turn
work.

### Trystero's API

0.23 moved to scoped packages and 0.25 changed what `makeAction` returns. What 0.25.2 wants:

```js
import {joinRoom} from 'https://esm.sh/@trystero-p2p/nostr@0.25.2?bundle';
const room   = joinRoom({appId: 'tbtt'}, roomId);
const action = room.makeAction('m');       // {send, onMessage, onReceiveProgress}
action.onMessage = (data, peerId) => {};   // assigned, not called
room.onPeerJoin = id => {};                // likewise: a property, not a subscribe call
room.onPeerLeave = id => {};
room.getPeers();                           // an object keyed by peer id
room.leave();
```

Pin the version, and keep that shape written down. Calling `room.onPeerJoin(fn)` throws. By then
`makeAction` has already wired the data channel, so the match keeps working while the status
line insists the connection failed. A transport that lies about being up is worse than one that
is down.

For the same reason, reaching the relays is not the same as having someone to talk to. A room with
nobody in it reports `connecting`, not `live`.

---

## 5. Commit-reveal

Without it, simultaneity is an honour system. The action letter travels in plaintext, so whoever
commits second gets a free look. Automating the transport makes that worse, since messages
arrive the instant the opponent commits.

Two phases per turn. Three message kinds share the one `send` and are told apart by their first
character:

```
!C~Rook@k3f9x2                    a colour claim
#7C:9f3a1c4e08b27d55a1e4...       a commitment: turn, colour, 128-bit digest
7C:D#a3f2|4b1e...                 a reveal: the engine's action string, then the nonce
```

You publish a commitment when you commit. Once every colour in the roster has published one for
that turn, every client publishes its reveal, with nobody asking and nobody acking. A reveal is
verified against a commitment that colour published for that turn, and only then handed to
`submit()`.

What matters is that **the reveal is the only message anyone acts on.** Secrecy is a side effect.
A commitment discloses nothing, so publishing three of them for one turn costs nobody anything,
and whichever one you open is the one that counts. That is what makes changing your action safe:
withdraw drops your draft and your digest, and the replacement you publish next is the one you
will open. Every client converges in any arrival order, with no acks and no authority.

The rule a player sees is **you can change your action until the other player commits.** Commit
last and you get no window, which is correct, because everything opens at once.

**The nonce is not optional.** With only six possible actions an unsalted hash is brute-forced in
six tries. The engine's `fnv1a` 4-hex hash is fine as a divergence check and useless as a
commitment.

### The preimage, pinned

Two clients disagreeing here would produce commitments that never open, which on screen looks
exactly like a diverged timeline and is not. So it is written down to the byte:

```
SHA-256(turn + ':' + color + ':' + action + ':' + nonce)
```

encoded UTF-8, where `turn` is the unpadded decimal turn number, `color` is one of `CPTA`,
`action` is the bare action letter, and `nonce` is 32 lowercase hex characters from
`crypto.getRandomValues`. The commitment is the **first 128 bits** of the digest, lowercase hex.
Turn and colour are in the preimage so a commitment cannot be lifted into another turn.

`crypto.subtle.digest` returns a promise, so **`Session.commit` is async**. That reaches every
caller, including the Enter keybinding.

### Arrival order

Nothing about the channel orders messages, so a reveal can overtake the commitment it opens. Such
a reveal is **held**, not dropped, and re-checked when a commitment for that turn and colour
arrives. Held reveals and commitments alike are pruned once the playhead passes their turn.
Anything ahead of the playhead stays, because a commitment for the next turn arriving during this
one is ordinary rather than suspect. A reveal that never opens anything is never applied,
and is not an error. On a public room, noise is not the match's problem.

A held reveal is one record per colour per turn, latest wins. A colour reveals once per turn, so
one slot is all an honest client needs, and it stays bounded against a stranger who sends more.
The trade: a junk reveal displaces a real one already held, and nobody resends it. A capped list
had the same hole in a different shape.

### The blind-simultaneity buffer

Incoming actions are still buffered and only fed to `submit` after you have committed.
Commit-reveal already covers this for an honest client. The buffer covers a client that reveals
early. Both stay.

---

## 6. The seam

§3's claim that any transport is a thin adapter over `submit` and `pendingColors` holds. The
transport block is two modules sitting between the engine and the screen.

**`Channel`** is the swap point. Five members: `id`, `send(text)`, `onMessage`, `onStatus`,
`close()`. Status carries `{state, peers, detail}` where state is one of
`offline | connecting | live | failed`. Two adapters satisfy it: `PeerChannel` over Trystero and
`LoopbackChannel` for tests. Assigning `onStatus` fires it immediately with the channel's current
state, because a callback that only reports changes leaves a freshly opened `Session` blind.

**`Session`** owns both the `Match` and the `Channel`. The play screen talks only to `Session`.
Its `view()` returns the engine's view object with `{status, peers, waiting, error}` merged in, so
nothing in the four render functions changed.

`Session` also handles claims and reconnection:

- **Live means every seat is connected.** Nothing opens until every roster colour commits, so one
  peer in a four-colour room resolves nothing. `view()` reports `connecting` until the room holds
  `roster.length - 1` peers; `peersNeeded` says how many are missing. Play stays disabled.
- **Colour claims settle without an authority.** The lower client id keeps a contested colour,
  every client computes the same answer, and exactly one player is bounced on every screen.
- **Reconnect is the claim mechanism.** When a peer appears, you send it your claim and your
  current-turn action. That is the whole protocol. No timers, no heartbeats.
- **An export is never broadcast.** `Match.export()` serialises partial turns, so broadcasting one
  would leak the current turn. A test enforces that nothing sends it over the channel.
- **An import drops the unfinished turn.** Import a partial export and you hold a draft you never
  saw a commitment for. Commit, and the turn resolves locally on the spot: your reveal never goes
  out and the other side waits forever. `trimUnresolved` cuts the export back to the last finished
  turn before `Match.fromExport` sees it. Nothing is lost, because your arrival is a peer join and
  the room announces its claims and commitments again.
- **Giving up a colour gives up what you played with it.** Losing the tiebreak, or switching seats
  by hand, withdraws the draft and forgets the commitment. The broadcast commitment cannot be taken
  back, so the colour's real owner counts as in one beat early. The turn still resolves and both
  sides agree; it costs one moment of simultaneity in a rare race.

---

## 7. Rejected

- **Our own relay** (Cloudflare Worker, Deno Deploy, Val Town). ~40 lines and the only option that
  could hold turn N's messages until all arrive, giving cheat resistance with one message per turn
  and no crypto. We do not want to run infrastructure.
- **Firebase / Supabase realtime.** NAT-free and reliable. Accounts.
- **TURN servers of any kind.** Accounts, plus nowhere to put credentials.
- **URL fragments / shareable links.** Players should not be clicking links per turn.
- **GitHub as the relay** (a gist per match). Needs a token in the client and hits rate limits
  fast.
- **PeerJS.** Simpler API than Trystero but a single public signalling server rather than a
  redundant network. Strictly worse.
- **Yjs / Automerge.** CRDTs resolve conflicting concurrent edits. Our log is append-only with
  strict validation and a divergence hash, so there is nothing to merge. Wrong tool.
- **GunDB.** Decentralized and persistent, but idiosyncratic and heavier than needed.
- **Pipelined commit-reveal.** Attaching turn N's reveal to turn N+1's commit requires choosing
  N+1 before seeing N's outcome. Here the playhead moves and legality is recomputed against the
  new board, so this would mean playing two turns blind. Plain two-phase only.

### Deferred, not rejected: the relay mailbox

No WebRTC at all. Both clients dial *outbound* to a shared broker, publish, subscribe. Public MQTT
brokers and nostr relays take no account, and outbound WebSocket connections cross NAT trivially,
so this family has no NAT failure mode.

MQTT's trick is one topic per message with the retain flag:

```
tbtt/<seed>/<turn>/<color>/commit
tbtt/<seed>/<turn>/<color>/reveal
```

Subscribe to `tbtt/<seed>/#` and the broker replays everything retained, so a player who reloads
reconstructs the match with no local storage and no export paste. Last Will and Testament covers
presence. Three public brokers (emqx, hivemq, mosquitto) each connected in 1-2s and delivered
retained messages.

Two things to know before building it. Brokers vary in reliability and retained-message policy, so
it needs a shortlist and a failover list rather than one hardcoded URL. And a public broker is
unauthenticated, so payloads should be encrypted with a key derived from the seed. That protects
against outsiders and not against your opponent, whose client receives your message the moment
you send it. Commit-reveal stays necessary either way.

This lost to WebRTC on one question: does a match have to survive both players being offline at
once? No. Export/import already covers a player who leaves and comes back. That was the only
argument holding the mailbox up. The remaining risk was NAT, and NAT you can measure instead of
designing around.

If NAT ever does bite, the fix is TURN, and TURN means a third party relays your packets
anyway. You keep all of WebRTC's complexity and lose its only advantage. For twelve bytes a
turn that trade never made sense. The mailbox is the better answer.

---

## 8. Still open

- **A seat nobody claims still never resolves.** Live means the room is full, so a four-colour
  match with two people no longer hangs on turn 0. What is left: a peer who joins and never picks
  a colour. The count is satisfied, the seat is not. It needs to read as "waiting for Purple"
  rather than as a hang.
- **Player count in practice.** 2 or up to 4. A WebRTC mesh cares: 4 players is 6 connections.
- **Nostr relay quality.** The probes logged `rate-limited: you note too much` from one relay and
  502s from two others. Trystero dials several in parallel and connects anyway, but the status
  line reports the state honestly rather than pretending.
- **An MQTT adapter.** Not built, and the argument for it is gone now that Firefox works and NAT
  is measured. §7 keeps the numbers in case.
