// Standalone real-services verification of the setForceRelay() TURN-availability
// warning added to src/voice.js's VoiceSession. Root cause: commit 07e18e6f6a
// removed every TURN entry from DEFAULT_ICE_SERVERS (STUN-only), but setForceRelay()
// -- the live-settable backing for the "Force TURN" privacy toggle exposed all the
// way through docs/js/nostr-adapter.js's forceTurnEnabled signal -- still
// unconditionally set iceTransportPolicy:'relay' on every future RTCPeerConnection
// with no check that a TURN server actually exists. Per WebRTC spec, relay-only ICE
// gathers ONLY TURN-sourced candidates; with zero TURN servers configured this is a
// silent, permanent, unrecoverable connection failure for anyone with the setting on
// -- found by an independent adversarial review agent, not by this session's own
// implementation work. Not part of test.js and not a mock-framework test file: same
// pattern as scratch-verify-connect-watchdog.mjs -- drives the real, unmodified
// VoiceSession class with a real xstate actor and a controllable fake RTCPeerConnection.
import * as xstate from 'xstate';
import assert from 'node:assert';
import { createFSM } from './src/fsm.js';
import { VoiceSession, setIceServers, getIceServers } from './src/voice.js';

let passed = 0;
const check = (label, cond) => { assert.ok(cond, label); passed++; console.log('  ok:', label); };

const fsm = createFSM(xstate);
const fakePool = { subscribe() {}, unsubscribe() {}, publish() {} };
const fakeAuth = { pubkey: 'b'.repeat(64), isLoggedIn: () => true, sign: async (e) => e };
const fakeMediaDevices = { getUserMedia: async () => { throw new Error('no mic in test env'); } };

console.log('=== setForceRelay() TURN-availability warning: real VoiceSession verification ===\n');

const originalIceServers = getIceServers();
check('default ICE_SERVERS (module state as shipped) has zero TURN entries -- reproduces the exact bug condition', originalIceServers.every(s => !String(s.urls).startsWith('turn')));

function makeVs() {
  return new VoiceSession({
    fsm, xstate, relayPool: fakePool, auth: fakeAuth, mediaDevices: fakeMediaDevices,
    createPeerConnection: () => ({
      addTransceiver() { return { receiver: {}, sender: {} }; }, getTransceivers() { return []; },
      getSenders() { return []; }, getReceivers() { return []; },
      createDataChannel() { return { close() {}, send() {} }; },
      onconnectionstatechange: null, onicecandidate: null, onicegatheringstatechange: null,
      ontrack: null, ondatachannel: null, connectionState: 'new', signalingState: 'stable', close() {},
    })
  });
}

// Case 1: enabling forceRelay with the real, current STUN-only ICE_SERVERS must warn.
{
  const vs = makeVs();
  const warnings = [];
  vs.addEventListener('media-warning', e => warnings.push(e.detail.message));
  vs.setForceRelay(true);
  check('setForceRelay(true) with no TURN configured emits exactly one media-warning', warnings.length === 1);
  check('warning message names the actual problem (Force TURN + no TURN server)', /Force TURN/.test(warnings[0]) && /TURN server/.test(warnings[0]));
  check('this.forceRelay is still set to true (the setting itself is not silently overridden, only warned about)', vs.forceRelay === true);
}

// Case 2: disabling forceRelay must never warn (nothing to warn about).
{
  const vs = makeVs();
  const warnings = [];
  vs.addEventListener('media-warning', e => warnings.push(e.detail.message));
  vs.setForceRelay(false);
  check('setForceRelay(false) never warns', warnings.length === 0);
}

// Case 3: if a real TURN server IS configured (via the existing setIceServers override
// API), enabling forceRelay must NOT warn -- the check is genuinely conditional on
// TURN availability, not a blanket regression that disables the feature outright.
{
  setIceServers([
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'turn:example-turn-provider.test:3478', username: 'u', credential: 'p' },
  ]);
  const vs = makeVs();
  const warnings = [];
  vs.addEventListener('media-warning', e => warnings.push(e.detail.message));
  vs.setForceRelay(true);
  check('setForceRelay(true) with a real TURN entry present does NOT warn', warnings.length === 0);
  check('forceRelay is still correctly set to true', vs.forceRelay === true);
}

// Case 4: a turns: (TLS) URL scheme must also count as TURN-capable, not just turn:.
{
  setIceServers([{ urls: 'turns:example-turn-provider.test:5349?transport=tcp', username: 'u', credential: 'p' }]);
  const vs = makeVs();
  const warnings = [];
  vs.addEventListener('media-warning', e => warnings.push(e.detail.message));
  vs.setForceRelay(true);
  check('turns: (TLS TURN) URL scheme is correctly recognized as TURN-capable', warnings.length === 0);
}

// Case 5: an ICE server entry with urls as an ARRAY (valid RTCIceServer shape, used
// elsewhere in real-world configs) must also be checked correctly, not just a bare string.
{
  setIceServers([{ urls: ['stun:stun.l.google.com:19302', 'turn:example-turn-provider.test:3478'], username: 'u', credential: 'p' }]);
  const vs = makeVs();
  const warnings = [];
  vs.addEventListener('media-warning', e => warnings.push(e.detail.message));
  vs.setForceRelay(true);
  check('array-shaped urls field with a TURN entry inside it is correctly recognized', warnings.length === 0);
}

// Restore the real module state so this script has no side effect on any process
// that might import voice.js again afterward in the same run (defensive cleanup).
setIceServers(originalIceServers);
check('restored ICE_SERVERS back to the real production STUN-only default after test', getIceServers().length === originalIceServers.length && getIceServers().every((s,i) => s.urls === originalIceServers[i].urls));

console.log(`\n${passed} checks passed.`);
process.exit(0);
