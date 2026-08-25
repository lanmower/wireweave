# AGENTS.md

Non-obvious caveats for agents working in this repo.

## Main-only, no branches

Always work directly on `main`. Never create or leave work on a feature
branch. If a non-main work branch is ever found, merge its content into
`main` then delete the branch (`gh-pages` is the sole exception -- it is a
deploy artifact branch, not a work branch, and stays). If the default branch
is ever named `master`, rename it to `main`. This repo is consumed as a git
submodule by spoint (`client/vendor/wireweave`) and edited in place from
there -- commit and push directly to `main` in both repos, same as any other
change here.

## createWireweave requires explicit storage in non-browser envs

`createWireweave({ storage })` MUST receive a storage instance in Node/test
environments. If storage is missing, the failure surfaces deep in the Servers
constructor as a cryptic `Servers: deps required` error, not at the
createWireweave call site. An upfront guard in `src/wireweave.js` now throws
`wireweave: storage required ...` early — keep it there.

## Tests must use multiple relays, not a single hardcoded one

`test.js` uses a `RELAYS` array (damus + nos.lol + primal + nostr.band) so
`RelayPool`'s multi-relay fallback masks the inevitable flake of any one public
relay. Do not collapse this back to a single `wss://relay.damus.io` — the
auth/data/dm/round-trip phases will go red intermittently.

## ws close on CONNECTING socket emits post-close error

Calling `ws.close()` while readyState is CONNECTING (0) makes the Node `ws`
package emit an EventEmitter `'error'` event AFTER close with message
"WebSocket was closed before the connection was established". Unhandled, this
crashes the process. DOM-style handlers (`ws.onerror = null` etc.) are a
separate channel and do NOT remove EventEmitter listeners. Before closing a
connecting socket: clear DOM handlers, call `ws.removeAllListeners()`, then
attach a noop `ws.on('error', () => {})` to absorb the trailing error. See
`src/relay-pool.js` disconnect() (commit 18d45b2). Only reproduces with a
multi-relay pool where some sockets are still connecting at disconnect time.

## RelayPool reconnect lifecycle must not resurrect after disconnect

`RelayPool` tracks a `_closed` flag and a `_reconnectTimers` Map. `disconnect()`
sets `_closed = true` and clears every tracked reconnect timer; `_open()` and the
`onclose` handler early-return when `_closed`. This is load-bearing: `onclose`
schedules `setTimeout(_open, ...)`, so without the flag a teardown leaves an
in-flight timer that resurrects the relay. `connect()` resets `_closed = false`
(`heal()` only re-opens dead sockets and is a no-op while `_closed`). Reconnect
backoff is jittered +-25% via `jitter(ms)` to avoid lockstep thundering-herd
reconnects. The offline publish queue (`this.pending`) stores `{event, ts}`,
caps at `PENDING_MAX` (500, drop-oldest), and drops entries older than
`PENDING_TTL_MS` (120s) on drain — never let it grow unbounded or replay stale
events. Covered by `testRelayReconnectCancel` + `testRelayPendingCapTtl` (fake-WS).

## RelayPool publish-ack and pending dedupe

`publish(event)` is still fire-and-forget (returns a `sent` boolean). For
delivery confidence use `publishAndWait(event, { timeoutMs = 8000 })`: it sends
then resolves `true` on the first relay `OK <id> true`, `false` on a relay
reject (`OK <id> false`), and `false` on timeout. It keys pending ack records
by `event.id` in `this._acks` (a `{resolve, timer}` Map); `_settleAck` resolves
and `disconnect()` flushes every outstanding ack to `false` so no promise hangs.
The `_handle` OK branch now emits both an `ok` and a `reject` event (previously
only `reject`) and settles the ack. An event with no `id` cannot be acked, so
`publishAndWait` falls back to resolving the `sent` boolean.

The offline queue is deduped by `event.id` via `this._pendingIds` (a Set kept in
lockstep with `this.pending`): `_queuePending` skips an id already queued, the
cap-drop path removes the dropped id from the Set, and `_drainPending` clears the
Set before re-publishing. This prevents a reconnect drain from double-publishing
the same event. Covered by `testRelayPendingDedupe` + `testRelayPublishAck`
(fake-WS, offline).

## MTU-aware unreliable/unordered data channel (src/frame.js + src/data.js)

`DataSession` opens TWO parallel `RTCDataChannel`s per peer, not one:
`DC_LABEL` (`{ordered:true}`, the pre-existing reliable/ordered default) and
`DC_LABEL_UNRELIABLE` (`{ordered:false, maxRetransmits:0}`, real WebRTC
UDP-like semantics — no retransmit, no ordering guarantee). Large binary
payloads (game snapshots etc) belong on the unreliable channel via
`sendUnreliable`/`broadcastUnreliable`, not the reliable one — a lost snapshot
should be superseded by the next one, not retransmitted/head-of-line-blocked.

A real RTCDataChannel message has a practical ~16KB limit before
cross-browser internal fragmentation gets inconsistent, so `src/frame.js`
fragments any payload into MTU-sized pieces (`MTU_DEFAULT = 16000`,
configurable via `DataSession`'s `mtu` option) each carrying an 11-byte
header (magic, messageId uint16, fragmentIndex uint16, fragmentCount uint16,
totalPayloadLength uint32). `fragmentCount` is a hard uint16 wire-format
ceiling (65535) — `fragment()` throws rather than silently overflowing that
field on an oversized payload; use `maxPayloadBytes(mtu)` to check first.

Both data channels MUST be created before `createOffer()` on the offerer
side (`_wirePeer` in `src/data.js`) — a channel created after the offer is
negotiated never makes it into that offer's SDP, so the answerer never sees
it. The answerer's `ondatachannel` routes by `ev.channel.label` to either
`peer.dc` or `peer.dcUnreliable`.

Each peer gets its own `Reassembler` (keyed by messageId, since fragments
can arrive in ANY order on an unordered channel). A fragment that's
permanently dropped (real risk with `maxRetransmits:0`) leaves an
incomplete, buffered set — `Reassembler.sweep()` (run lazily on every
`feed()`, or externally on an interval) evicts any incomplete set older than
`staleMs` (`DataSession`'s `fragmentStaleMs`, default 10s), and a
`maxInFlight` cap (default 256) evicts the oldest set if a misbehaving
sender never completes enough messages to trigger the staleMs path. Neither
mechanism is optional — an unreliable channel without both would leak a
buffer per dropped fragment forever. Verified via a real standalone script,
`scratch-verify-mtu-framing.mjs` (not part of `test.js` — xstate isn't
installed in this environment so a full `DataSession` can't be instantiated
here; the script drives the real `frame.js` primitives directly, the exact
functions `sendUnreliable`/the unreliable `onmessage` handler call).

## Voice peer connect-timeout watchdog (src/voice.js)

A peer whose `RTCPeerConnection` never leaves `connectionState` `'new'`/`'connecting'`
(offer sent but the answer or the answerer's ICE candidates never arrive back over
the Nostr relay) fires zero `onconnectionstatechange` events, so `_doIceRestart`/
`_checkStall`/`_scheduleReconnect` — every one of them gated on that event firing —
never engage and the peer hangs forever; `heal()` doesn't cover it either (it only
handles `disconnected`/`failed`/`closed`). `peer.connectTimer` (`CONNECT_TIMEOUT`,
8000ms, matches `DISCONNECT_GRACE`) is armed in `_maybeConnect` right after `pc`
creation and calls `_doIceRestart` if still not connected when it fires. It MUST be
cleared on both the `'connected'` AND `'disconnected'` branches of
`onconnectionstatechange` — clearing only on `'connected'` (as a naive version once
did) leaves a `pc` that goes straight `new` -> `disconnected` with both `connectTimer`
and the `DISCONNECT_GRACE` `disconnectTimer` independently calling `_doIceRestart`,
double-incrementing `failCount` and double-sending ICE-restart offers. It re-arms only
inside `_doIceRestart`'s offerer-retry branch (`peer.failCount <= 1 && isOfferer`) —
the answerer branch closes the peer immediately via `_closePeer` (which clears every
per-peer timer including `connectTimer`), so there is no live peer left to re-arm
against. Verified live via `scratch-verify-connect-watchdog.mjs` (real `VoiceSession`
+ real xstate actor, controllable fake `RTCPeerConnection` driving the actual
production `onconnectionstatechange`/`_doIceRestart`/`_closePeer` code).

## RelayPool publish budget (rate/abuse backstop)

`RelayPool.publish()` is gated by a shared token bucket (`publishBudget`
constructor option, default burstCap=30/refillPerSec=3 — pass `false` for
the old unbounded behavior). This is the single choke point every module's
writes go through (chat, dm, bans, roles, settings, servers, data-channel
signaling all call `pool.publish()`), so one bucket per `RelayPool` instance
budgets abuse across ALL of them at once — `chat.js`'s own 5-per-10s limiter
stays as-is, that's an app-level UX throttle for a chat input box, this is
the lower-level protocol-wide backstop underneath it. A budget-rejected
`publish()` is queued exactly like a disconnected-relay event (same
`this.pending` array/TTL/cap), not dropped — a self-scheduling timer
(`_scheduleBudgetDrain`, only runs while a real backlog exists, never a
standing interval) retries the drain once tokens should have refilled, so a
caller publishing faster than the budget allows still gets eventual
delivery. `pool.budgetStatus()` exposes live tokens/retryAfterMs for a
caller that wants to back off proactively instead of eating the queue path.

## Portable identity: profiles (src/profile.js) vs chat.js's own cache

`chat.js` already has a read-only, per-`Chat`-instance kind:0 profile cache
(`_fetchProfile`/`resolveProfile`) purely for showing names in a chat UI.
`src/profile.js`'s `Profile` class is the general-purpose, `relayPool`-level
primitive: publish-your-own (`publish(fields)`, shallow-merges onto your own
cached profile so updating one field never clobbers the rest — kind:0 is a
NIP-01 replaceable event, the relay keeps only the newest per-pubkey copy),
`fetchOnce(pubkey)` (one-shot, EOSE-driven, TTL-cached), a standing
`subscribe(pubkey, onUpdate)`, and real NIP-05 verification
(`verifyNip05(identifier, expectedPubkey)` — a genuine HTTPS round-trip to
`https://<domain>/.well-known/nostr.json`, since a profile's `nip05` field
is just a claimed string; per spec this HTTP fetch is the ONLY real trust
anchor, never derivable from the nostr event alone). This is what makes an
identity portable across ANY wireweave-based app, not just the app that
created it — any relay-connected client already knows how to read kind:0.

## Moderation depth (src/bans.js: unban, channel mute, audit log)

`ban()` had no reverse — `unban()` publishes a SEPARATE 'unban' d-tag
namespace event (not a delete of the ban event; nostr relays aren't
guaranteed to honor NIP-09 deletion, and a ban is itself an
addressable/replaceable event with no built-in revocation). Because ban and
unban are two different d-tag namespaces for the same (server, pubkey), a
relay won't naturally collapse them into "one latest wins" the way a single
namespace's replaceable event does — `subscribe()`'s handler tracks a
per-pubkey `_banTs` (newest-seen `created_at`) explicitly, so an
out-of-order-delivered OLDER ban event can never resurrect a NEWER unban
(covered by `testBansModerationDepth` in test.js: a stale ban replayed after
a newer unban is asserted to stay reversed). `mute(serverId, channelId,
pubkey)`/`unmute(...)` add channel-scoped silencing (mod-level permission,
distinct from a server-wide ban/timeout which needs admin). `getAuditLog
(serverId?)` returns every moderation action seen via `subscribe()`,
most-recent-first, capped at 200 — derived purely from the same real
relay-published events the ban/timeout/kick/unban/mute state already comes
from, so the log can never drift from the actually-enforced state (no
separate write path). A relay-delivered event without a valid `created_at`
(malformed, or a hand-built test fixture) defaults to "now" rather than
silently failing the `0 <= undefined` comparison — 0 <= undefined is false
in JS, which would otherwise drop a legitimate action.

## Offline-first message store (src/message.js)

`MessageBus` was purely in-memory (an array, gone on reload). `storage`
(any localStorage/IndexedDB-shaped sync getItem/setItem/removeItem — same
duck-typed contract `safe-storage.js`/`RelayPool`'s health persistence
already use) plus `roomKey` makes the message list survive a reload,
debounced-persisted (`PERSIST_DEBOUNCE_MS=500`) so a burst of adds doesn't
thrash storage. `sendFn` + `isOnline()` add a real outbox: `add()` calls
`sendFn` immediately when online, but queues (persisted) into
`this.outbox` when offline or when `sendFn` returns `false`/throws — the
message still appears locally immediately either way (`msg.pending: true`
while queued), never blocked on network state. `flushOutbox()` retries
every queued message through `sendFn` in original order once connectivity
is restored (call it from a `RelayPool` `'relay-status':'connected'`
handler); a message that still fails stays queued for the next flush.

## Ephemeral in-process relay for deterministic tests (src/ephemeral-relay.js)

`EphemeralRelay` is a real (not mocked) minimal NIP-01 relay on `port:0`,
used by `testEphemeralRelay()`/`testRelayPublishBudget()` for a
deterministic, CI-uptime-independent witness that stays real-services-only.
Detail: recall memory (drain fired this session; if not yet landed, re-fire
via `memorize-fire` and check `.gm/memories/`).

## Relay health scoring, auto-rotation, persistence (src/relay-pool.js)

`RelayHealth` tracks a 0-100 EWMA-blended `rank` per relay URL and drives
`_maybeRotate()` auto-rotation away from unhealthy relays, persisted via
storage-injection (key `ww_relay_health`) and exposed through `debug.js`'s
registry. Two real bugs fixed 2026-07-19 here (rank not recomputed on a
never-connecting relay's `recordConnectAttempt`; rotation only evaluated on
the `sustained`-disconnect branch, never the never-connected branch) are the
non-obvious load-bearing detail. Full mechanism + rotation thresholds +
test coverage: recall memory (drain fired this session; if not yet landed,
re-fire via `memorize-fire` and check `.gm/memories/`).

## No npm publishing — GitHub-only distribution

There is no npm-publish workflow in this repo (removed 2026-08-25 — was
`.github/workflows/publish.yml`, auto version-bumping and `npm publish`ing
on every push to `main`). wireweave is installed directly from GitHub
(`npm i github:AnEntrypoint/wireweave`), matching how spoint already
consumes it as a git submodule. Do not re-add npm-publish CI, an
`NPM_TOKEN` secret reference, or restore `publishConfig`/`files` to
`package.json` — those were deliberately removed, not an oversight.

## CI

`.github/workflows/ci.yml` runs `node --check src/*.js` then installs `ws` +
`nostr-tools` (`--no-save`) and runs `node test.js` on every push/PR. The
real-relay phases tolerate single-relay flake via the multi-relay `RELAYS`
array; `compose`/`data` tests skip when `xstate` is absent (not installed in
CI) — that is expected, not a failure.

## HiddenSpawn malware was committed to history (removed, but scan periodically)

A HiddenSpawn-class malware dropper (obfuscated `_0x`-hex payload appended
after a file's real content) was found in `flatspace.config.mjs` on
2026-08-25 — NOT sitting untracked, it was smuggled directly into commit
`087de8d` (2026-08-11) alongside a genuine, small `channels.js` fix, plus a
full-file `.gitignore` rewrite that silently dropped `.env`/`.env.*` from
the ignore list (a credential-exfiltration setup). A normal `git log`/PR
skim shows a plausible commit message and file list; only reading the full
diff content (or `scan_deps`) surfaces the payload. Removed via `git rebase
-i` (edit stop at the bad commit, clean replacement content, legitimate
changes preserved) + `git push --force-with-lease`, after a local backup
branch and full test-suite re-run. Full incident detail: recall memory. Run
`scan_deps` (gm skill Section 1a) periodically on this repo, not only on a
fresh `npm install` — and never trust a commit's stated subject as evidence
of its actual full diff.

## test.js size cap

The single integration witness (`test.js`) grows as coverage expands. The previous <=200 line cap is superseded: the file may grow freely as long as it remains a single file at repo root, mock-free for network tests, and real-services only for the relay round-trip. Current size: ~1220 lines (32+ tests, including the relay-health-scoring suite). Do not split into a `test/` directory.

@.gm/next-step.md
