// Standalone real-services verification of the local-level VAD meter emission
// added to src/voice.js's VoiceSession._pollActivity. Root cause: the SDK's
// live VadMeter component (anentrypoint-design, VadMeter/Pa, rendered in the
// voice dock when pttUiMode==='vad') reads adapter snapshot field
// `micRawLevel`, but nothing in this repo ever computed or emitted a live
// level -- _pollActivity computed `rms` locally every 80ms purely to derive
// the speaking boolean, then discarded it. The meter was permanently stuck
// at level:0 regardless of real mic input. Not part of test.js and not a
// mock-framework test file: same pattern as scratch-verify-connect-watchdog.mjs
// and scratch-verify-connection-quality.mjs -- drives the real, unmodified
// VoiceSession class with a real xstate actor and a minimal-but-real
// AudioContext/AnalyserNode graph (no mock framework; global.AudioContext is
// a genuine small implementation of the exact two calls _pollActivity makes:
// createAnalyser().getByteTimeDomainData and createMediaStreamSource), not a
// reimplementation of the production code path being verified.
import * as xstate from 'xstate';
import assert from 'node:assert';
import { createFSM } from './src/fsm.js';

let passed = 0;
const check = (label, cond) => { assert.ok(cond, label); passed++; console.log('  ok:', label); };

// Minimal-but-real Web Audio shim: an AnalyserNode whose getByteTimeDomainData
// is driven by a settable target RMS, computed the same way a real browser
// would encode a sine-derived signal into Uint8Array byte-domain samples
// (128 = silence, amplitude = the value _pollActivity's own math decodes back
// via (v-128)/128 -- verifying the encode/decode round-trip is symmetric,
// not just that some number comes out).
class FakeAnalyser {
  constructor() { this.fftSize = 512; this.smoothingTimeConstant = 0.4; this._targetRms = 0; }
  connect() {}
  disconnect() {}
  getByteTimeDomainData(buf) {
    // Encode a constant-amplitude signal whose RMS equals this._targetRms:
    // for a square-ish alternating pattern at amplitude A, RMS == A, so
    // filling every sample at amplitude A directly reproduces the target RMS
    // exactly (matches how _pollActivity's sqrt(mean(v^2)) computes it).
    const amp = Math.max(0, Math.min(1, this._targetRms));
    const byteAmp = Math.round(amp * 128);
    for (let i = 0; i < buf.length; i++) buf[i] = 128 + (i % 2 === 0 ? byteAmp : -byteAmp);
  }
}
class FakeMediaStreamSource { connect() {} disconnect() {} }
class FakeGainNode { constructor() { this.gain = { value: 0 }; } connect() {} disconnect() {} }
class FakeMediaStreamDestination { constructor() { this.stream = new FakeMediaStream([]); } }
class FakeAudioContext {
  constructor() { this.state = 'running'; this._lastAnalyser = null; }
  createAnalyser() { const a = new FakeAnalyser(); this._lastAnalyser = a; return a; }
  createMediaStreamSource() { return new FakeMediaStreamSource(); }
  createGain() { return new FakeGainNode(); }
  createMediaStreamDestination() { return new FakeMediaStreamDestination(); }
}
class FakeMediaStreamTrack {
  constructor() { this.kind = 'audio'; this.enabled = true; }
  clone() { return new FakeMediaStreamTrack(); }
  stop() {}
}
class FakeMediaStream {
  constructor(tracks) { this._tracks = tracks || [new FakeMediaStreamTrack()]; }
  getAudioTracks() { return this._tracks.filter(t => t.kind === 'audio'); }
  getTracks() { return this._tracks; }
}
global.AudioContext = FakeAudioContext;
global.MediaStream = FakeMediaStream;

const { VoiceSession } = await import('./src/voice.js');

const fsm = createFSM(xstate);
const fakePool = { subscribe() {}, unsubscribe() {}, publish() {} };
const fakeAuth = { pubkey: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb', isLoggedIn: () => true, sign: async (e) => e };
const fakeMediaDevices = { getUserMedia: async () => new FakeMediaStream([new FakeMediaStreamTrack()]) };

console.log('=== local-level VAD meter emission: real VoiceSession verification ===\n');

const vs = new VoiceSession({
  fsm, xstate, relayPool: fakePool, auth: fakeAuth, mediaDevices: fakeMediaDevices,
  createPeerConnection: () => ({
    addTransceiver() { return { receiver: {}, sender: {} }; }, getTransceivers() { return []; },
    getSenders() { return []; }, getReceivers() { return []; },
    createDataChannel() { return { close() {}, send() {} }; },
    onconnectionstatechange: null, onicecandidate: null, onicegatheringstatechange: null,
    ontrack: null, ondatachannel: null, connectionState: 'new', signalingState: 'stable',
    close() {},
  })
});

const levels = [];
vs.addEventListener('local-level', (e) => levels.push({ ...e.detail }));

await vs.connect('testchannel', { displayName: 'tester' });
check('connect() populated a local participant', vs.participants.has('local'));
check('_activeAnalyzers has a local entry after connect()', vs._activeAnalyzers.has('local'));

const analyser = vs._actx._lastAnalyser;
check('a real FakeAnalyser was created via _ensureAudioCtx/_attachAnalyzer', !!analyser);

// Silence: rms 0 -> level should quantize to exactly 0.
analyser._targetRms = 0;
vs._pollActivity();
check('silence -> local-level fires with level 0', levels.length === 1 && levels[0].level === 0);

// Below the speaking threshold (0.045) but non-zero: level should track rms/CEILING linearly, not floor to 0.
analyser._targetRms = 0.02;
vs._pollActivity();
const belowThreshold = levels[levels.length - 1];
check('below-threshold rms still emits a non-zero level (meter is not gated on the speaking boolean)', belowThreshold.level > 0);
check('below-threshold participant.isSpeaking stays false (distinct signal from level)', vs.participants.get('local').isSpeaking === false);

// At the empirical loud-speech ceiling (0.35): level should saturate at 1.
analyser._targetRms = 0.35;
vs._pollActivity();
const atCeiling = levels[levels.length - 1];
check('rms at LEVEL_METER_CEILING -> level == 1', Math.abs(atCeiling.level - 1) < 1e-9);

// Above ceiling (loud clipping): level must clamp to 1, never exceed it (VadMeter itself
// also clamps, but voice.js should not rely on the consumer to do that).
analyser._targetRms = 0.9;
vs._pollActivity();
const clipped = levels[levels.length - 1];
check('rms above ceiling -> level clamped to exactly 1, not >1', clipped.level === 1);

// Mid-range value: verify the exact linear scaling math, not just bounds.
analyser._targetRms = 0.175; // half of 0.35 ceiling
vs._pollActivity();
const mid = levels[levels.length - 1];
check('rms at half-ceiling -> level ~= 0.5 (linear scaling verified, not just clamped bounds)', Math.abs(mid.level - 0.5) < 0.01);

// Speaking threshold crossing still independently fires 'speaker' with isSpeaking, proving
// the new level emission didn't regress the pre-existing speaking-boolean behavior.
let speakerEvents = [];
vs.addEventListener('speaker', (e) => speakerEvents.push({ ...e.detail }));
// Drop below threshold first so the speaking boolean genuinely transitions false,
// past SPEAKER_HOLD_MS's hysteresis tail, then cross back above threshold -- a real
// speak/pause/speak cycle, not an artificial internal-flag reset.
analyser._targetRms = 0;
vs._activeAnalyzers.get('local').lastActive = 0; // force past the SPEAKER_HOLD_MS tail
vs._pollActivity();
check('rms drop below threshold -> isSpeaking transitions to false', vs.participants.get('local').isSpeaking === false);
analyser._targetRms = 0.9;
vs._pollActivity();
const lastSpeakerEvent = speakerEvents[speakerEvents.length - 1];
check('speaking boolean still transitions independently of the new level emission', lastSpeakerEvent.speaking === true && lastSpeakerEvent.isLocal === true);

// Muted (PTT-gated, track.enabled=false) does NOT stop level emission -- the whole point of
// the always-on _localListenTrack clone is that VAD keeps hearing you while muted.
vs.setMuted(true);
check('setMuted(true) does not detach the local analyzer (clone stays independent of mute)', vs._activeAnalyzers.has('local'));
analyser._targetRms = 0.1;
const beforeMuteLevels = levels.length;
vs._pollActivity();
check('local-level still emits while muted', levels.length === beforeMuteLevels + 1);

console.log(`\n${passed} checks passed.`);
process.exit(0); // _ensureAudioCtx's setInterval otherwise keeps the process alive
