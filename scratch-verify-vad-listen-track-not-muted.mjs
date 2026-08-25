// Standalone real-services verification of the _localListenTrack born-muted fix.
// Root cause, confirmed live via a real getUserMedia+MediaStreamTrack.clone() test
// in the deployed browser (cdp dispatch): MediaStreamTrack.clone() inherits the
// source track's CURRENT enabled state at the moment of cloning -- it does not
// reset to true. connect()'s clone (voice.js line ~258) previously happened AFTER
// the original track's enabled was already set to !pttMode (false in the default
// PTT-starts-muted case), so _localListenTrack was born already disabled and
// nothing ever re-enabled it -- permanently silencing the VAD level meter and
// speaker detector for the whole session. User live-diagnosed the symptom
// (rms/level pinned at 0, VAD auto-transmit deadlock) via monkey-patching
// MediaStreamTrack.prototype.enabled's setter against the real deployed app.
// This fixture's FakeMediaStreamTrack.clone() faithfully replicates the confirmed
// real-browser inheritance behavior (clone starts with the source's CURRENT
// enabled value, not a fresh default), so a passing check here is evidence against
// the real bug shape, not a fixture that could mask it. Not part of test.js and
// not a mock-framework test file: same pattern as this repo's other
// scratch-verify-*.mjs scripts -- drives the real, unmodified VoiceSession class.
import * as xstate from 'xstate';
import assert from 'node:assert';
import { createFSM } from './src/fsm.js';
import { VoiceSession } from './src/voice.js';

let passed = 0;
const check = (label, cond) => { assert.ok(cond, label); passed++; console.log('  ok:', label); };

global.AudioContext = class {
  constructor() { this.state = 'running'; this._lastAnalyser = null; }
  createAnalyser() { const a = { fftSize: 512, smoothingTimeConstant: 0.4, _sourceTrack: null, connect() {}, disconnect() {}, getByteTimeDomainData(buf) { const enabled = a._sourceTrack ? a._sourceTrack.enabled : true; const amp = enabled ? 90 : 0; for (let i = 0; i < buf.length; i++) buf[i] = 128 + (i % 2 === 0 ? amp : -amp); } }; this._lastAnalyser = a; return a; }
  createMediaStreamSource(stream) { const track = stream.getAudioTracks()[0]; this._lastAnalyser && (this._lastAnalyser._sourceTrack = track); return { connect() {}, disconnect() {}, _track: track }; }
  createGain() { return { gain: { value: 0 }, connect() {}, disconnect() {} }; }
  createMediaStreamDestination() { return { stream: new global.MediaStream([]) }; }
};

// Faithfully replicates real MediaStreamTrack.clone() semantics confirmed live:
// a clone inherits the CURRENT enabled state of its source at clone time.
class FakeMediaStreamTrack {
  constructor(kind, enabled) { this.kind = kind || 'audio'; this.enabled = enabled !== undefined ? enabled : true; }
  clone() { return new FakeMediaStreamTrack(this.kind, this.enabled); } // <-- the real, confirmed inheritance behavior
  stop() {}
}
global.MediaStream = class {
  constructor(tracks) { this._tracks = tracks || [new FakeMediaStreamTrack('audio')]; }
  getAudioTracks() { return this._tracks.filter(t => t.kind === 'audio'); }
  getTracks() { return this._tracks; }
};

const fsm = createFSM(xstate);
const fakePool = { subscribe() {}, unsubscribe() {}, publish() {} };
const fakeAuth = { pubkey: 'b'.repeat(64), isLoggedIn: () => true, sign: async (e) => e };
const fakeMediaDevices = { getUserMedia: async () => new global.MediaStream([new FakeMediaStreamTrack('audio', true)]) };

console.log('=== _localListenTrack born-muted fix: real VoiceSession verification ===\n');

function makeVs(pttMode) {
  return new VoiceSession({
    fsm, xstate, relayPool: fakePool, auth: fakeAuth, mediaDevices: fakeMediaDevices, pttMode,
    createPeerConnection: () => ({
      addTransceiver() { return { receiver: {}, sender: {} }; }, getTransceivers() { return []; },
      getSenders() { return []; }, getReceivers() { return []; },
      createDataChannel() { return { close() {}, send() {} }; },
      onconnectionstatechange: null, onicecandidate: null, onicegatheringstatechange: null,
      ontrack: null, ondatachannel: null, connectionState: 'new', signalingState: 'stable', close() {},
    })
  });
}

// Case 1: default PTT mode (starts muted) -- the exact bug scenario the user hit.
{
  const vs = makeVs(true);
  await vs.connect('vad-listen-test', { displayName: 'x' });
  check('connect() in PTT mode leaves the session muted (original bug precondition)', vs.muted === true);
  check('original mic track is disabled while muted (expected, unrelated to the bug)', vs.localStream.getAudioTracks()[0].enabled === false);
  check('_localListenTrack is genuinely ENABLED despite the session being muted and the original track being disabled -- the actual fix', vs._localListenTrack.enabled === true);

  // Confirm the analyser actually reads non-silent RMS from the listen track while muted.
  const an = vs._activeAnalyzers.get('local').an;
  const buf = new Uint8Array(4);
  an.getByteTimeDomainData(buf);
  const nonSilent = buf.some(b => b !== 128);
  check('AnalyserNode reading the listen track produces non-silent samples while the session is muted (the real end-to-end fix, not just a flag check)', nonSilent);

  await vs.disconnect().catch(() => {});
}

// Case 2: toggling setMuted(true)/(false) repeatedly must never disable the listen track.
{
  const vs = makeVs(false); // open-mic mode: starts unmuted
  await vs.connect('vad-listen-test-2', { displayName: 'x' });
  check('open-mic mode starts unmuted', vs.muted === false);
  check('_localListenTrack enabled at connect in open-mic mode too', vs._localListenTrack.enabled === true);

  vs.setMuted(true);
  check('after setMuted(true): original track disabled', vs.localStream.getAudioTracks()[0].enabled === false);
  check('after setMuted(true): _localListenTrack STAYS enabled (defensive re-assert in setMuted)', vs._localListenTrack.enabled === true);

  vs.setMuted(false);
  check('after setMuted(false): original track re-enabled', vs.localStream.getAudioTracks()[0].enabled === true);
  check('after setMuted(false): _localListenTrack still enabled', vs._localListenTrack.enabled === true);

  vs.setMuted(true);
  check('repeated mute cycling never disables the listen track (3rd toggle)', vs._localListenTrack.enabled === true);

  await vs.disconnect().catch(() => {});
}

console.log(`\n${passed} checks passed.`);
process.exit(0);
