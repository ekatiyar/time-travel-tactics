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

### Where we were

The action letter travelled in plaintext. The UI did stop you pasting an opponent's action before
committing your own — `phaseShare` stayed hidden until `committed()` — but that only enforced
order *inside* the app. Nothing stopped someone reading the incoming string in their chat window
and then choosing. **Simultaneity was an honour system.**

Automating the transport made that worse rather than better: messages arrive the instant the
opponent commits, so whoever commits later gets a free look.

### Commit-reveal, as built

Two phases per turn, three message kinds sharing the one `send` and told apart by their first
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

The useful property turned out not to be secrecy. It is that **the reveal is the only message
anyone acts on.** A commitment discloses nothing, so publishing three of them for one turn costs
nobody anything, and whichever one you open is the one that counts. That is what makes changing
your action safe: withdraw drops your draft and your digest, and the replacement you publish next
is the one you will open. Every client converges in any arrival order, with no acks and no
authority.

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

### Arrival order

Nothing about the channel orders messages, so a reveal can overtake the commitment it opens. Such
a reveal is **held**, not dropped, and re-checked when a commitment for that turn and colour
arrives. Held reveals and commitments alike are pruned once the playhead passes their turn;
anything ahead of the playhead stays, because a commitment for the next turn arriving during this
one is ordinary rather than suspect. A reveal that never opens anything is simply never applied,
and is not an error: on a public room, noise is not the match's problem.

### The blind-simultaneity buffer

Incoming actions are still buffered and only fed to `submit` after you have committed. Under one
phase that was the whole mitigation. Under two it is a second lock on a door that is already
locked, and it stays because commit-reveal binds an honest client and this binds a client that
reveals early.

### What the blocker turned out to be

This section used to end by deferring commit-reveal, on the grounds that it "needs `crypto.subtle`,
which needs a secure context — GitHub Pages qualifies, `file://` does not", and that this would
force a local http server.

That is wrong, and measured wrong in both browsers: `isSecureContext` is true on a `file://` page
in stock Chromium and in stock Firefox 153, and `crypto.subtle.digest` works on both. No local
server and no hand-rolled hash. Recorded here rather than quietly deleted, because it is the only
thing that kept commit-reveal out of the first pass.

The one real consequence of the change is that **`Session.commit` is async**, since
`crypto.subtle.digest` returns a promise. That reaches every caller, including the Enter
keybinding.

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

**NAT is still untested.** Both probe peers were on one machine. One session with a real opponent settles it. *(Settled in the second pass, below: it works.)*

### The seam

§3 said the engine is transport-agnostic and any transport is a thin adapter over `submit` and `pendingColors`. That held. The transport block is two modules:

- **`Channel`** is the seam. Five members: `id`, `send(text)`, `onMessage`, `onStatus`, `close()`. Status carries `{state, peers, detail}` where state is one of `offline | connecting | live | failed | manual`. Three adapters satisfy it — `PeerChannel` over Trystero, `PasteChannel` over the existing textareas, and `LoopbackChannel` for tests. Three adapters is what makes the seam real rather than hypothetical; swapping in an MQTT adapter is a fourth. *(The second pass deleted `PasteChannel` and the `manual` state. Two adapters remain, one of them test-only.)*
- **`Session`** sits above it and owns both the `Match` and the `Channel`. The play screen talks only to `Session`. Its `view()` returns the engine's view object with `{status, peers, waiting, error}` merged in, so the four render functions were not touched at all.

`Session` hides §8's steps 2, 3 and 4. Incoming actions are buffered until you have committed, which preserves the blind simultaneity the paste flow had by accident. Colour claims are settled without an authority: the lower client id keeps a contested colour, every client computes the same answer, and exactly one player is bounced on every screen. Reconnect collapsed into the claim mechanism — when a peer appears, you send it your claim and your current-turn action, and that is the whole protocol. No timers, no heartbeats.

### Transport in the match code

*Deleted in the second pass along with `PasteChannel`: with one transport there is nothing to
choose, and codes are back to the plain six segments `time_travel` produces. Kept here because
the segment comes back if MQTT ever lands.*

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

- **NAT.** Unmeasured, and the reason the seam exists. *(Measured in the second pass. It works.)*
- **Nostr relay quality.** The probes logged `rate-limited: you note too much` from one relay and 502s from two others. Trystero dials several in parallel and connected anyway, but the status line reports the state honestly rather than pretending.
- **Commit-reveal** (§6), unchanged and still worth doing. It is additive, it needs `crypto.subtle`, and it forces the local http server. Doing it in the same pass as transport debugging would have made it impossible to tell which layer was lying. *(Built in the second pass. It does not need a local server; see §6.)*
- **The `Match.export()` bug in §8.** Not fixed, and deliberately so: a full export including the current turn is what makes reload work. The fix was to never broadcast one, which a test now enforces.

---

## 11. The second pass

A review found eight defects and playing the thing found two more. Two of them meant the first
build only worked as a demo: changing your action silently forked the match, and losing a colour
tiebreak handed you someone else's board under your own name. The pass fixed all ten, deleted the
per-turn paste transport outright, and made turns two-phase. §6 has the protocol.

### What the second round of probes measured

Run against the real page, on the development machine unless noted.

| | Result |
|---|---|
| `crypto.subtle` on a `file://` page, **Chromium and Firefox** | **works** — `isSecureContext` is true in both |
| Stock Firefox 153, raw WebRTC, `file://` and localhost | connects, message delivered |
| Stock Firefox 153, `PeerChannel` over Trystero | peer in 4.0s, message delivered |
| Chromium, same | peer in 4.0s, message delivered |
| **Two machines across NAT, Chrome and Firefox** | **connects and plays** |
| Trystero relay pool | 37 of 47 reachable |
| The 5 relays `appId: 'tbtt'` draws | 2 dead (`strfry.openhoofd.nl`, `relay.agorist.space`) |

Two conclusions, and both close questions §9 left open.

**The transport is sound.** Stock Firefox runs the real transport, and two machines on separate
networks play a match in both browsers. The `ICE failed` report the first pass recorded belonged
to one browser profile, not to our code. Part of what made it believable was a lie on our side:
`PeerChannel` reported `live` the moment `joinRoom` returned, before any peer existed, so a
channel that had reached the relays and found nobody looked like a channel that was up. It now
stays `connecting` until a peer actually joins.

**Commit-reveal had no blocker.** See §6.

### The relay draw

Trystero shuffles its 47-relay pool by `appId` and takes the first five, so a fixed
`appId: 'tbtt'` draws the same five relays for every match ever played, and two of ours are down.
Measured across eight appIds, one browser context each so no relay sockets were shared:

| appId | alive of 5 |
|---|---|
| `tbtt` (the old fixed one) | 3 |
| six per-match variants | 5, 4, 4, 4, 4, 3 |
| `tbtt-ffff` | 3 |

Deriving the appId from the room id, which both peers already compute identically from the match
code, averages 3.75 of 5 against a fixed 3. It does not silence the console — roughly one dead
relay per match remains — but it removes the structural problem, which is being locked to one
below-average hand forever.

Filtering the pool would go further and is deliberately **not** done. The only dead list anyone
here could write is a single measurement from one network at one moment, and it contains
`relay.damus.io`, one of the largest relays on the network and far more likely to have been
transiently unreachable than actually gone.

### What deleting paste cost

Per-turn copy-paste is gone: `PasteChannel`, the toggle, both textareas, Apply, Copy-my-action.
Export and import stay untouched, because they live on the setup screen and are the rejoin path
rather than per-turn work.

The consequence worth stating plainly is that **a connection that dies mid-match now has no
fallback.** Recovery is export and re-import, and the status line has to be honest about that.

### Still open after the second pass

- **A roster colour nobody claims never resolves.** Two phases need a commitment from every colour
  before anything opens, so an unclaimed seat stalls the turn. That was already true of `submit`,
  but the stall now happens a phase earlier and needs to read as "waiting for Purple" rather than
  as a hang.
- **An MQTT adapter.** Not built, and the argument for it is gone now that Firefox works and NAT is
  measured. The broker numbers in §10 stay in case it is ever needed.
