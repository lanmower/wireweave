// Standalone real-services verification of connectionQuality state transitions
// added to src/voice.js's VoiceSession (participants.connectionQuality was
// previously set once to 'connecting' on presence and never updated again --
// diagnosed live against a deployed app where a stuck remote tile stayed
// "connecting" forever regardless of actual connection outcome). Not part of
// test.js and not a mock-framework test file: same pattern as
// scratch-verify-connect-watchdog.mjs -- drives the real, unmodified
// VoiceSession class end to end with a real xstate actor and a controllable
// fake RTCPeerConnection, exercising the actual production code paths
// (_setConnectionQuality, onconnectionstatechange, _doIceRestart,
// _scheduleReconnect's give-up branch), not a reimplementation of them.
import * as xstate from 'xstate';
import assert from 'node:assert';
import { createFSM } from './src/fsm.js';
import { VoiceSession } from './src/voice.js';

let passed = 0;
const check = (label, cond) => { assert.ok(cond, label); passed++; console.log('  ok:', label); };

const fsm = createFSM(xstate);

function makeFakePc() {
  const pc = {
    connectionState: 'new',
    iceConnectionState: 'new',
    iceGatheringState: 'new',
    signalingState: 'stable',
    calls: { restartIce: 0, createOffer: 0, close: 0 },
    onconnectionstatechange: null, onicecandidate: null, onicegatheringstatechange: null,
    ontrack: null, ondatachannel: null,
    addTransceiver() { return { receiver: {}, sender: {} }; },
    getTransceivers() { return []; },
    getSenders() { return []; },
    getReceivers() { return []; },
    createDataChannel() { return { close() {}, send() {} }; },
    restartIce() { pc.calls.restartIce++; },
    createOffer() { pc.calls.createOffer++; return Promise.resolve({ sdp: 'v=0\r\n' }); },
    setLocalDescription() { return Promise.resolve(); },
    close() { pc.calls.close++; },
  };
  return pc;
}

const fakePool = { subscribe() {}, unsubscribe() {}, publish() {} };
const fakeAuth = { pubkey: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb', isLoggedIn: () => true, sign: async (e) => e };
const fakeMediaDevices = { getUserMedia: async () => { throw new Error('no mic in test env'); } };

console.log('=== connectionQuality state transitions: real VoiceSession verification ===\n');

const lowerPeer = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'; // < our pubkey -> we are offerer
const shortId = 'nostr-' + lowerPeer.slice(0, 12);

function makeVs() {
  let createdPc;
  const vs = new VoiceSession({
    fsm, xstate, relayPool: fakePool, auth: fakeAuth, mediaDevices: fakeMediaDevices,
    createPeerConnection: (cfg) => { createdPc = makeFakePc(); return createdPc; }
  });
  vs.roomId = 'testroom';
  return { vs, getPc: () => createdPc };
}

// --- Test 1: presence sets connectionQuality:'connecting' (baseline, pre-fix behavior) ---
{
  const { vs } = makeVs();
  vs.participants.set(shortId, { identity: 'peer', isSpeaking: false, isMuted: false, isLocal: false, hasVideo: false, connectionQuality: 'connecting' });
  check('baseline: participant starts at connecting', vs.participants.get(shortId).connectionQuality === 'connecting');
}

// --- Test 2: reaching 'connected' transitions quality to 'good' ---
{
  const { vs, getPc } = makeVs();
  vs.participants.set(shortId, { identity: 'peer', isSpeaking: false, isMuted: false, isLocal: false, hasVideo: false, connectionQuality: 'connecting' });
  vs._maybeConnect(lowerPeer);
  const pc = getPc();
  pc.connectionState = 'connected';
  pc.onconnectionstatechange();
  check('connected -> quality becomes good', vs.participants.get(shortId).connectionQuality === 'good');
  vs._closePeer(lowerPeer);
}

// --- Test 3: 'disconnected' transitions quality to 'poor' immediately (not stuck at connecting) ---
{
  const { vs, getPc } = makeVs();
  vs.participants.set(shortId, { identity: 'peer', isSpeaking: false, isMuted: false, isLocal: false, hasVideo: false, connectionQuality: 'connecting' });
  vs._maybeConnect(lowerPeer);
  const pc = getPc();
  pc.connectionState = 'disconnected';
  pc.onconnectionstatechange();
  check('disconnected -> quality becomes poor (immediate, not waiting for DISCONNECT_GRACE)', vs.participants.get(shortId).connectionQuality === 'poor');
  vs._closePeer(lowerPeer);
}

// --- Test 4: _doIceRestart (watchdog/ICE-restart path) also marks quality poor ---
{
  const { vs, getPc } = makeVs();
  vs.participants.set(shortId, { identity: 'peer', isSpeaking: false, isMuted: false, isLocal: false, hasVideo: false, connectionQuality: 'connecting' });
  vs._maybeConnect(lowerPeer);
  const peer = vs.peers.get(lowerPeer);
  clearTimeout(peer.connectTimer);
  vs._doIceRestart(peer, lowerPeer, peer.fsm);
  check('CONNECT_TIMEOUT-triggered ICE restart -> quality becomes poor', vs.participants.get(shortId).connectionQuality === 'poor');
  vs._closePeer(lowerPeer);
}

// --- Test 5: exhausted retries (6 attempts) -> quality becomes 'failed' AND peer-connect-failed fires exactly once ---
{
  const { vs } = makeVs();
  vs.participants.set(shortId, { identity: 'peer', isSpeaking: false, isMuted: false, isLocal: false, hasVideo: false, connectionQuality: 'connecting' });
  let failedEvents = 0;
  let closedEvents = 0;
  vs.addEventListener('peer-connect-failed', (e) => { failedEvents++; check('peer-connect-failed carries correct peerPubkey', e.detail.peerPubkey === lowerPeer); check('peer-connect-failed carries attempts>=6', e.detail.attempts >= 6); });
  vs.addEventListener('peer-closed', () => { closedEvents++; });
  vs._scheduleReconnect(lowerPeer, 6);
  check('exactly one peer-connect-failed event fired on retry exhaustion', failedEvents === 1);
  check('peer-closed did NOT fire for retry-exhaustion (distinct from a clean leave)', closedEvents === 0);
  check('quality becomes failed on retry exhaustion', vs.participants.get(shortId).connectionQuality === 'failed');
}

// --- Test 6: a normal clean leave still fires peer-closed, NOT peer-connect-failed ---
{
  const { vs } = makeVs();
  vs.participants.set(shortId, { identity: 'peer', isSpeaking: false, isMuted: false, isLocal: false, hasVideo: false, connectionQuality: 'good' });
  vs._maybeConnect(lowerPeer);
  let failedEvents = 0;
  let closedEvents = 0;
  vs.addEventListener('peer-connect-failed', () => { failedEvents++; });
  vs.addEventListener('peer-closed', () => { closedEvents++; });
  vs._closePeer(lowerPeer);
  check('clean _closePeer fires peer-closed', closedEvents === 1);
  check('clean _closePeer does NOT fire peer-connect-failed', failedEvents === 0);
}

// --- Test 7: _setConnectionQuality is a no-op for an unknown/already-left participant (no throw, no spurious event) ---
{
  const { vs } = makeVs();
  let emitted = 0;
  vs.addEventListener('participants', () => { emitted++; });
  vs._setConnectionQuality('c'.repeat(64), 'good'); // never added to participants
  check('no-op on unknown participant: zero participants events fired', emitted === 0);
}

console.log(`\n${passed} checks passed.`);
process.exit(0);
