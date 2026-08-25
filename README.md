# wireweave

> probably emerging 🌀

serverless nostr + webrtc voice + binary-data SDK. the networking layer for 247420 projects.

- **voice** — perfect-negotiation mesh + SFU election (audio, video, recorded segments).
- **data** — peer-to-peer binary `RTCDataChannel` over the same nostr signaling. game frames, structured payloads, anything `Uint8Array`-shaped.

site: https://anentrypoint.github.io/wireweave/  
source: https://github.com/AnEntrypoint/wireweave

```
npm i github:AnEntrypoint/wireweave
```

## one-liner setup

```js
import { createWireweave } from 'wireweave';
import * as NostrTools from 'nostr-tools';
import * as XState from 'xstate';

const ww = createWireweave({ nostrTools: NostrTools, xstate: XState });
ww.pool.connect();
ww.auth.loadFromStorage() || ww.auth.generateKey();
ww.servers.init();
```

`ww` exposes: `pool`, `auth`, `fsm`, `message`, `bans`, `roles`, `settings`, `pages`, `media`, `channels`, `servers`, `chat`, `voice` (lazy via `ensureVoice()`), `dm` (lazy via `ensureDM()`), `setCurrentChannel()`, `currentChannelId`, `currentServerId`.

every submodule is an `EventTarget`. subscribe with `addEventListener('event', ...)`.

`message` is a standalone in-memory `MessageBus` (bounded ring + typed handler dispatch). It is provided for apps that want a local message store; no other wireweave module depends on it, so ignore it if you don't need it.

### node / non-browser environments

`createWireweave` and `NostrAuth`/`Servers` need a `storage` adapter outside the browser — pass `{ getItem, setItem, removeItem }`. Without it `createWireweave` throws `wireweave: storage required` up front (in the browser it defaults to `localStorage`). On-relay `d`-tags use a frozen `zellous-` prefix and storage keys use `zn_*`; these are published wire/storage contracts kept stable across the rename to wireweave — do not change them without a migration path.

## direct messages (encrypted)

```js
const dm = ww.ensureDM();              // lazy: needs nostr-tools built with nip44
dm.subscribe(({ peer, plaintext }) => console.log(peer, plaintext));
await dm.send(peerPubkey, 'hello');
```

**Caveat:** nip44 encryption derives a conversation key from your **private key**, so DM requires a privkey-backed signer (`generateKey`/`importKey`). It does **not** work with extension signing (NIP-07), which never exposes the privkey — `dm.send` throws `DM: privkey required` in that case.

## modules

```js
import {
  RelayPool, NostrAuth, VoiceSession, DataSession, Chat, Channels, Servers,
  Bans, Roles, Settings, Media, Pages, MessageBus, createFSM
} from 'wireweave';
```

each also exported via subpath: `wireweave/relay-pool`, `wireweave/voice`, `wireweave/data`, `wireweave/chat`, etc.

## data sessions (binary p2p)

`DataSession` mirrors `VoiceSession`'s perfect-negotiation peer setup but carries **only** an ordered binary `RTCDataChannel` — no media, no mic prompt, no SFU. Use it for game state, file sync, anything `ArrayBuffer`-friendly.

```js
import { createDataSession, createFSM, NostrAuth, RelayPool } from 'wireweave';
import * as NostrTools from 'nostr-tools';
import * as xstate from 'xstate';

const fsm = createFSM(xstate);
const auth = new NostrAuth({ nostrTools: NostrTools });
auth.loadFromStorage() || auth.generateKey();
const pool = new RelayPool({ verifyEvent: NostrTools.verifyEvent });
pool.connect();

const session = createDataSession({ fsm, xstate, relayPool: pool, auth, namespace: 'mygame' });
session.addEventListener('peer-open',  (e) => console.log('peer up', e.detail.peerPubkey));
session.addEventListener('data',       (e) => handleFrame(e.detail.peerPubkey, e.detail.data));
session.addEventListener('peer-close', (e) => console.log('peer down', e.detail.peerPubkey));

await session.connect('lobby-7'); // any room name; URL-hash works fine
session.broadcast(new Uint8Array(payload));     // → all open peers
session.send(somePeerPubkey, new Uint8Array(p)); // → one peer
```

Options: `dataChannelOptions` (default `{ ordered: true }`), `iceServers` (override the default STUN/TURN list for this session only), and `createPeerConnection` (see below). Construct multiple `DataSession`s in the same page to use distinct rooms / channel configurations.

`setIceServers(list)` / `getIceServers()` (also exported from `wireweave/data` and `wireweave/voice`) override the module-wide default ICE server list for every session created afterward — useful for pointing at your own TURN infrastructure once, instead of passing `iceServers` to each session.

## Node hosts behind NAT: `createPeerConnection`

Both `DataSession` and `VoiceSession` accept a `createPeerConnection(config)` option. It defaults to a plain `new RTCPeerConnection(config)` (browser-shaped, works as-is with any WebRTC-polyfilled `globalThis`) — wireweave itself never imports a Node-specific WebRTC binding. A Node host that is itself likely to sit behind a restrictive NAT (a CLI tool, a headless server) can instead construct its own natively-tuned peer and hand it back:

```js
import * as ndc from 'node-datachannel';
import { RTCPeerConnection as PolyfillRTCPeerConnection } from 'node-datachannel/polyfill';

const session = createDataSession({
  fsm, xstate, relayPool: pool, auth, namespace: 'mygame',
  createPeerConnection: (config) => {
    // node-datachannel's native RtcConfig is richer than the W3C shape:
    // enableIceUdpMux shares one UDP port across all peer connections
    // (fewer ports to traverse through a firewall); portRangeBegin/End
    // pins ICE to a fixed range you can port-forward; proxyServer routes
    // ICE through a SOCKS5/HTTP proxy on networks that block direct UDP/TCP.
    const nativePc = new ndc.PeerConnection('peer', {
      iceServers: config.iceServers.map(s => s.urls),
      enableIceUdpMux: true,
      // portRangeBegin: 50000, portRangeEnd: 51000,
      // proxyServer: { type: 'Socks5', ip: '127.0.0.1', port: 1080 }
    });
    return new PolyfillRTCPeerConnection({ peerConnection: nativePc });
  }
});
```

This is opt-in and additive — omit `createPeerConnection` and Node hosts behave exactly as before (a plain polyfilled `RTCPeerConnection`).

## game / 3-mode usage pattern

For projects (e.g. multiplayer games) that need three transport flavours:

| mode | wireweave usage |
|---|---|
| singleplayer (in-page) | `VoiceSession` keyed by `location.hash` so people on the same URL voice-chat; game state stays in a Worker |
| webrtc host & join     | `DataSession` for game frames, `VoiceSession` for voice — both signaled through the same nostr relays |
| self-hosted server     | server runs its own transport for state; `DataSession` adds player↔player p2p (voice + side-channel data) over nostr |

`namespace` partitions rooms across deployments (e.g. `'spoint-prod'` vs `'spoint-dev'`).

## voice (webrtc mesh + sfu hub election)

```js
const voice = ww.ensureVoice({
  serverId: 'abc:xyz',
  displayName: 'you',
  onAudioTrack: ({ peer, stream }) => {
    const a = new Audio();
    a.srcObject = stream;
    a.autoplay = true;
    document.body.appendChild(a);
    peer.audioEl = a;
  },
  onVideoTrack: ({ peerPubkey, stream }) => { /* attach to <video> */ }
});
await voice.connect('general-voice', { displayName: 'you' });
voice.toggleMic();
voice.toggleDeafen();
voice.addEventListener('participants', e => console.log(e.detail.list));
```

Voice carries every empirically-discovered reliability pattern: perfect negotiation (RFC 8840), ICE restart on disconnect, track-stall detection, SFU hub election (mesh→star at 3+ peers), exponential-backoff reconnect.

### voice quality/input settings

`VoiceSession` (and `ensureVoice`) accepts real, constructor-configurable options for input mode, mic sensitivity, echo/noise handling, and Opus quality — every one of them threaded into an actual `getUserMedia`/`RTCRtpSender`/SDP call site, not just stored:

```js
const voice = ww.ensureVoice({
  serverId: 'abc:xyz',
  displayName: 'you',
  pttMode: true,              // push-to-talk (default) vs. open-mic/VAD mode
  micSensitivity: 0.045,      // RMS threshold the speaker-activity detector uses
  noiseSuppression: true,     // getUserMedia audio constraints — real MediaTrackConstraints
  echoCancellation: true,
  autoGainControl: true,
  audioQuality: 'high',       // Opus bitrate tier: 'low' (16kbps) | 'medium' (32kbps) | 'high' (48kbps) | 'max' (64kbps)
  dtx: true                   // discontinuous transmission (silence suppression), SDP fmtp usedtx=1
});
```

- **`pttMode`** (push-to-talk vs. voice-activity/open-mic): `true` (default) starts the session muted; the caller opens the mic via `setMuted(false)`/`requestTransmit()`. `false` starts unmuted — the mic stays live and the speaker-activity detector (RMS threshold) drives the `isSpeaking` UI flag instead of gating transmission. Live-togglable: `voice.setPttMode(false)`.
- **`micSensitivity`** — the RMS level (0–1) above which a stream counts as "speaking" in the speaker-activity poller. Live-togglable: `voice.setMicSensitivity(0.09)`.
- **`noiseSuppression` / `echoCancellation` / `autoGainControl`** — real [`MediaTrackConstraints`](https://developer.mozilla.org/en-US/docs/Web/API/MediaTrackConstraints) passed straight into the `getUserMedia({ audio: {...} })` call `connect()` makes.
- **`audioQuality`** — an Opus bitrate ladder tier (`low`/`medium`/`high`/`max`, mapping to 16/32/48/64 kbps) applied via the real `RTCRtpSender.setParameters()` call on every connected peer's audio sender. Live-togglable and re-applies immediately to every open connection: `voice.setAudioQuality('low')`.
- **`dtx`** — discontinuous transmission (silence suppression), negotiated per the real WebRTC spec via the Opus `a=fmtp` SDP line (`usedtx=1`), not an `RTCRtpEncodingParameters` field (that isn't where DTX lives in the real spec). Applied at every offer/answer/ICE-restart. Live-togglable: `voice.setDtx(false)` (takes effect on the next SDP exchange for already-open peers).
- **Per-room bandwidth shaping for large rooms** — this module is audio-only (no video sender exists anywhere in it), so real per-layer RTP simulcast (which is video-only in every browser implementation) doesn't apply. The honest, reachable analog is what's already built: SFU hub election (`_sfuElect`/`_sfuRankCandidates`) picks the highest-uplink participant as the hub and fans out audio to everyone via zero-copy `replaceTrack`, so bandwidth concentrates on whoever the room is actually routing through, combined with the per-connection Opus bitrate ladder above.

## node usage (relay + auth only)

```js
import WebSocket from 'ws';
import { RelayPool, NostrAuth } from 'wireweave';
import * as NostrTools from 'nostr-tools';

const pool = new RelayPool({ relays: ['wss://relay.damus.io'], verifyEvent: NostrTools.verifyEvent, WebSocketImpl: WebSocket });
const auth = new NostrAuth({ nostrTools: NostrTools });
```

## test

```
npm test
```

hits `wss://relay.damus.io` for a real publish → subscribe round-trip.

## license

MIT © AnEntrypoint — read the source.
