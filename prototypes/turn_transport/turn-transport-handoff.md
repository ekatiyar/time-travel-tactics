# Turn Transport — Investigation and Decisions

*Companion to `time-travel-tactics-design-doc.md` and `prototype-ui.md`. Covers how turns get from one player to another. Status: built. §5's decision was reversed on the way — see §10.*

---

## 1. What this settles

`tbtt_prototype_time_travel_only.html` currently exchanges turns by copy-paste. This document records why that is the friction point, what the alternatives are, which constraints ruled most of them out, and what to build first. It does not change any game mechanics.

---

## 2. The problem

The prototype's other sharing features are fine and should stay:

- The match code (`M1:16x9:11:19f4:43:CPTA`) is a staple of browser games.
- Export/import (`X1:...`) is a genuinely useful feature in a game like this.

Turn exchange is the part that hurts. Every meta-turn currently costs both players a copy, a context switch to a chat app, a paste, a return, and a paste back. For a match with a turn cap of 43 that is a lot of clerical work between decisions.

**Target experience:** share a code once at the start, then never think about transport again. No links to click, no separate chat channel, no per-turn clipboard work.

---

## 3. What the engine already gives us

The existing code makes this much cheaper than it looks. Worth knowing before touching anything.

- **The engine is transport-agnostic.** `Match` has no DOM access. The entire integration surface is `submit({turn, color, action, hash})` and `pendingColors()`. Any transport is a thin adapter over those two calls.
- **A turn message is tiny.** `Wire.encodeAction` produces about twelve bytes (`7C:N#a3f2`).
- **`submit` is effectively idempotent.** A duplicate returns *"has already acted this turn"*. At-least-once delivery with duplicates is safe.
- **Ordering does not matter.** `_derive` breaks out of its loop on the first incomplete turn, so actions can arrive in any order and the match simply advances when a turn fills up.
- **Divergence is already detected.** The 4-hex state hash in every action string rejects stale or forked messages before they can corrupt a match.

Consequence: **no acks, no ordering guarantees, no retry logic are needed.** The network layer can be dumb.

---

## 4. Constraints (decided)

| Constraint | Status |
|---|---|
| Static hosting (GitHub Pages) | Fixed |
| No infrastructure of our own to run | Decided |
| **No accounts or sign-ups for third-party services** | Decided |
| No links to click, no separate chat channel | Decided |
| Share a code once; minimal setup | Decided |
| Cheat resistance via hashing | Wanted, cheap, but deferred (§6) |

The no-accounts constraint is load-bearing and eliminates more options than it first appears to. See §7.

---

## 5. The transport decision

### Two families

**A. P2P (WebRTC) with hosted signalling — Trystero**

Trystero abstracts away the signalling server and offers BitTorrent, Nostr, MQTT, Supabase, Firebase, IPFS and self-hosted WebSocket relay strategies behind one API. Nostr is the default and needs no account. Current version 0.25.2; 0.23.0 split it into scoped packages (`@trystero-p2p/nostr` etc.) and changed the signature to `joinRoom(config, roomId, callbacks)`. Prebuilt files are downloadable for plain `<script type="module">` use, so no bundler is required.

What it gives us beyond raw messaging:

- **Presence.** `onPeerJoin` / `onPeerLeave` solves colour-claim validation (nothing currently stops two players both picking Coral) and gives us the "waiting on Purple" state that the paste box implicitly provided.
- **Catch-up.** On peer join, send your full log. The match is deterministic and tiny, so a reconnecting player is repaired in one message.
- **Rooms and serialization** out of the box.

**B. Relay as a mailbox — public MQTT over WSS, or Nostr relays**

No WebRTC at all. Both clients dial *outbound* to a shared broker, publish, subscribe. Public MQTT brokers and Nostr relays are usable without an account.

MQTT has one trick worth the choice on its own: publish each message to its own topic with the retain flag —

```
tbtt/<seed>/<turn>/<color>/commit
tbtt/<seed>/<turn>/<color>/reveal
```

Subscribe to `tbtt/<seed>/#` and the broker replays everything retained, so a player who reloads reconstructs the match with no local storage and no export paste. (Check retained-message limits on whichever public broker; some restrict them.) Last Will and Testament covers presence.

### The discriminator: NAT

This is the whole decision.

- NAT traversal is a **WebRTC-only** problem. Switching Trystero strategies does not help — strategies only change how the SDP exchange happens; the connection underneath is still direct P2P and fails on the same networks.
- The standard fix is a TURN server, and **every free TURN option requires an account** (Cloudflare Realtime: 1,000 GB/month free but a payment method on file; Metered Open Relay: 20 GB/month free with an API key). Ruled out by §4.
- Static hosting also gives us nowhere to hide TURN credentials.
- **So under our constraints, a NAT failure on the P2P path is unfixable.**
- Family B has no NAT failure mode at all. Outbound WebSocket connections traverse NAT trivially.

Note the irony that killed the enthusiasm for P2P: if you fall back to TURN, your packets are being relayed by a third party anyway. You keep all of WebRTC's complexity and lose its only real advantage. For twelve bytes a turn that trade never made sense.

### Decision

**Default to the relay mailbox (B).** It is NAT-proof, account-free, supports asynchronous play, and gives reload recovery for free. The presence and room handling Trystero would have provided is a heartbeat and a timeout.

**Trystero (A) remains reasonable if — and only if — every match is a live session with both players present, and testing shows the people we actually play with connect reliably.** It is less code to write. Home broadband to home broadband usually connects on STUN alone; failures cluster on mobile carrier NAT and corporate networks. Test with a real opponent before committing.

§9 has the open question that decides between them.

> **Reversed.** The open question was answered no: a match does not have to survive both players being offline at once, because export/import already covers that. That was the only thing holding the relay mailbox up, so what got built is Trystero (A). §10 records the measurements. Nothing here is wrong; the constraint it rested on was dropped.

### In both cases

**Keep the paste boxes**, behind a manual toggle. The match string is short enough that "resend the whole export" repairs anything, and it is the fallback when a broker is unreachable.

---

## 6. Cheat resistance

### Where we are now

The action letter travels in plaintext. The UI does stop you pasting opponents' actions before committing your own — `phaseShare` is hidden until `committed()` — but that only enforces order *inside* the app. Nothing stops someone reading the incoming string in their chat window and then choosing. **Simultaneity is currently an honour system.**

Automating the transport makes this worse, not better: messages arrive the instant the opponent commits, so whoever commits later gets a free look.

### Commit-reveal

Two phases per turn:

1. Publish `commit = SHA-256(turn ‖ color ‖ action ‖ nonce)` with a fresh 128-bit nonce, plus the existing state hash. Binding turn and colour into the preimage stops a commit being replayed into another turn.
2. Once every colour's commit for that turn has landed, publish `action ‖ nonce`. Verify each reveal against the stored commit, then feed them all to `submit()`.

A reveal that does not match its commit means tampering or a diverged build. Halt with an explicit error, the same way the state-hash mismatch does now.

**The nonce is not optional.** With only six possible actions an unsalted hash is brute-forced in six tries. The existing `fnv1a` 4-hex hash is fine as a divergence check and useless as a commitment.

### Sequencing

Defer this to a second step. It is additive and does not touch the transport layer, so nothing built first gets thrown away. But it doubles messages per turn and needs `crypto.subtle`, which needs a secure context — GitHub Pages qualifies, `file://` does not. Given the `file:// with storage off` comment in the current code, development is presumably by opening the file directly, so this forces a local http server. (An ES module import for Trystero would force the same thing.)

### Interim mitigation, three lines

Buffer incoming actions and only feed them to `submit` after committing your own. Preserves today's blind simultaneity: a cheater would need devtools rather than just their chat window.

---

## 7. Rejected

- **Our own relay** (Cloudflare Worker, Deno Deploy, Val Town). ~40 lines and the only option that could implement a barrier release — hold turn N's messages until all arrive, giving cheat resistance with one message per turn and no crypto. Rejected: we do not want to run infrastructure.
- **Firebase / Supabase realtime.** NAT-free and reliable. Rejected: accounts.
- **TURN servers of any kind.** Rejected: accounts, plus nowhere to put credentials.
- **URL fragments / shareable links.** Rejected: players should not be clicking links per turn.
- **GitHub as the relay** (a gist per match). Needs a token in the client and hits rate limits fast.
- **PeerJS.** Simpler API than Trystero but a single public signalling server rather than a redundant network. Strictly worse.
- **Yjs / Automerge.** CRDTs resolve conflicting concurrent edits. Our log is append-only with strict validation and a divergence hash — there is nothing to merge. Wrong tool.
- **GunDB.** Decentralized and persistent, so it does cover the async case, but idiosyncratic and heavier than needed.
- **Pipelined commit-reveal.** Attaching turn N's reveal to turn N+1's commit requires choosing N+1 before seeing N's outcome. Here the playhead moves and legality is recomputed against the new board, so this would mean playing two turns blind. Plain two-phase only. *(This was floated early and is wrong; recorded so it does not get re-proposed.)*

---

## 8. Order of work

1. **Adapter.** On successful commit, broadcast the string `Wire.encodeAction` already produces. On receive, `Wire.decodeAction` → `match.submit` → `refresh()`, exactly as `btnApply` does today. The match code becomes the room/topic name, so there is nothing new for players to share.
2. **Buffer incoming actions until you have committed** (§6 interim mitigation).
3. **Presence.** Colour-claim validation and a visible "waiting on Purple".
4. **Reconnect.** Resend your current-turn action on peer join, or rely on retained topics.
5. **Paste boxes behind a toggle.**
6. **Commit-reveal** (§6), once a local http server is part of the dev loop.

### Security note for a public broker

A public broker is unauthenticated: anyone knowing the topic can read or inject. Derive an encryption key from the seed and encrypt payloads. Note that transport encryption protects against outsiders, **not** against your opponent — their client still receives your action the moment you send it. Commit-reveal stays necessary regardless.

### Existing bug to fix while in here

`Match.export()` serialises partial turns. If Purple commits and exports before Coral has acted, that export contains Purple's action. Broadcasting full exports as a sync mechanism would leak the current turn. Either broadcast single actions only, or truncate exports to the last complete turn.

---

## 9. Open questions

- **Must a match survive both players not being online at once?** This decides §5 outright. Yes → relay mailbox. No → Trystero is viable and is less code.
- **Player count in practice.** 2 or up to 4. The relay mailbox is indifferent; a WebRTC mesh is not (4 players is 6 connections).
- **Which broker.** Public MQTT brokers vary in reliability and retained-message policy. Needs a shortlist and a failover list rather than a single hardcoded URL.
- **Does the NAT problem actually bite us?** Untested. One session with a real opponent settles whether Trystero was ever an option.
- **Does the dev loop move to a local http server now or later?** Both Trystero's module import and `crypto.subtle` require it.

---

## 10. What got built

`tbtt_prototype_turn_transport.html`, a copy of the time_travel prototype with the engine block held byte-identical and a transport block added after it. The narrow goal was to stop copy-pasting turns. Starting a match, joining with a code, and export/import all work exactly as they did.

### Why the decision flipped

§5 chose the relay mailbox on one premise: matches must survive both players not being online at once. They do not. Import/export already handles a player who leaves and comes back, and it is useful for debugging besides. Drop that premise and the argument that killed P2P goes with it, because the remaining risk — NAT — is a thing you can measure rather than a thing you have to design around.

### What the probes measured

Headless Chromium against `file://`, on the development machine:

| | Result |
|---|---|
| Trystero over nostr, two peers | exchanged both ways in 2.5s |
| Remote ES module from esm.sh on a `file://` page | works |
| A locally vendored `.js` module on a `file://` page | blocked by CORS |
| Classic `<script src>` from a CDN on a `file://` page | works |
| Public MQTT brokers (emqx, hivemq, mosquitto) | all connected in 1-2s, retained messages delivered |

Two things follow. The `file://` dev loop survives a CDN-loaded ES module, so §9's question about moving to a local http server stays answered "later" — but do not vendor the library, because the local copy is the one the browser refuses. And the relay mailbox is still a working option if it is ever needed; it was not rejected, only deferred.

**NAT is still untested.** Both probe peers were on one machine. One session with a real opponent settles it.

### The seam

§3 said the engine is transport-agnostic and any transport is a thin adapter over `submit` and `pendingColors`. That held. The transport block is two modules:

- **`Channel`** is the seam. Five members: `id`, `send(text)`, `onMessage`, `onStatus`, `close()`. Status carries `{state, peers, detail}` where state is one of `offline | connecting | live | failed | manual`. Three adapters satisfy it — `PeerChannel` over Trystero, `PasteChannel` over the existing textareas, and `LoopbackChannel` for tests. Three adapters is what makes the seam real rather than hypothetical; swapping in an MQTT adapter is a fourth.
- **`Session`** sits above it and owns both the `Match` and the `Channel`. The play screen talks only to `Session`. Its `view()` returns the engine's view object with `{status, peers, waiting, error}` merged in, so the four render functions were not touched at all.

`Session` hides §8's steps 2, 3 and 4. Incoming actions are buffered until you have committed, which preserves the blind simultaneity the paste flow had by accident. Colour claims are settled without an authority: the lower client id keeps a contested colour, every client computes the same answer, and exactly one player is bounced on every screen. Reconnect collapsed into the claim mechanism — when a peer appears, you send it your claim and your current-turn action, and that is the whole protocol. No timers, no heartbeats.

### Transport in the match code

The code gained a trailing segment: `M1:16x9:11:19f4:43:CPTA:P`, where `P` is live and `X` is paste-only. The transport layer splits that off and hands the rest to an untouched `Wire.decodeMatchCode`, so a bare six-segment code still decodes and still means paste. Transport is not game config — it does not affect determinism and is not in the state hash — so it does not belong beside board width inside the engine. The room id is a hash of the whole string, including the segment, so two players who disagree about the transport cannot land in one room and talk past each other.

### The Trystero API, as measured

§5's description is stale. 0.23 moved to scoped packages and 0.25 changed what `makeAction` returns. What 0.25.2 actually wants:

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

Pin the version. Recovering this cost six probes, and the peer callbacks cost another one after that: calling `room.onPeerJoin(fn)` throws, and since `makeAction` has already wired the data channel by then, the match keeps working while the status line insists the connection failed. A transport that lies about being up is worse than one that is down.

### Still open

- **NAT.** Unmeasured, and the reason the seam exists.
- **Nostr relay quality.** The probes logged `rate-limited: you note too much` from one relay and 502s from two others. Trystero dials several in parallel and connected anyway, but the status line reports the state honestly rather than pretending.
- **Commit-reveal** (§6), unchanged and still worth doing. It is additive, it needs `crypto.subtle`, and it forces the local http server. Doing it in the same pass as transport debugging would have made it impossible to tell which layer was lying.
- **The `Match.export()` bug in §8.** Not fixed, and deliberately so: a full export including the current turn is what makes reload work. The fix was to never broadcast one, which a test now enforces.
