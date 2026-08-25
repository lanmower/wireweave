// Standalone real-services-free verification of the MTU-aware binary
// framing shipped in src/frame.js and wired into src/data.js's
// sendUnreliable/broadcastUnreliable + the unreliable-channel branch of
// _wireDataChannel. Not part of test.js (per the task's explicit ask for a
// separate standalone script) and not a mock-framework test file — this is
// a real Node script exercising the real exported fragment()/Reassembler
// code from frame.js, the exact functions DataSession.sendUnreliable and
// the peer.dcUnreliable.onmessage handler call.
//
// xstate is not installed in this environment (AGENTS.md: "compose/data
// tests skip when xstate is absent — not installed in CI"), so a full
// DataSession instantiation (which requires fsm.dataMachine/peerMachine)
// isn't available here. This script instead drives the real frame.js
// primitives directly with a simulated lossy/unordered RTCDataChannel pair,
// which is the exact same code DataSession's unreliable channel path calls
// — see src/data.js's sendUnreliable() (calls fragment()) and
// _wireDataChannel's unreliable onmessage branch (calls reassembler.feed()).

import { fragment, Reassembler, MTU_DEFAULT, maxPayloadBytes } from './src/frame.js';
import crypto from 'node:crypto';
import assert from 'node:assert';

let passed = 0;
const check = (label, cond) => {
  assert.ok(cond, label);
  passed++;
  console.log('  ok:', label);
};

console.log('=== MTU-aware binary framing: real round-trip verification ===\n');

// --- Test 1: payload well over MTU, unordered/shuffled delivery, exact reassembly ---
console.log('[1] large payload, shuffled (unordered) delivery');
{
  const payload = crypto.randomBytes(250000); // ~250KB, well over the 16KB practical MTU
  const messageId = 101;
  const frames = fragment(payload, { messageId, mtu: MTU_DEFAULT });
  check('fragmented into >1 wire fragment', frames.length > 1);
  console.log('  fragments:', frames.length, 'payload bytes:', payload.length);

  // Simulate an unordered/unreliable channel: deliver every fragment, but
  // in random order (real {ordered:false} semantics never guarantee order).
  const shuffled = [...frames].sort(() => Math.random() - 0.5);
  const reassembler = new Reassembler({ staleMs: 10000 });
  let reassembled = null;
  for (const f of shuffled) {
    const out = reassembler.feed(f);
    if (out) reassembled = out;
  }
  check('reassembled once all fragments arrived (any order)', reassembled !== null);
  check('reassembled length matches original', reassembled.length === payload.length);
  check('reassembled bytes are byte-identical to original', Buffer.from(reassembled).equals(payload));
  check('no leftover in-flight sets after a full completion', reassembler.pendingCount() === 0);
}

// --- Test 2: a deliberately dropped fragment leaves an incomplete, later-evicted set ---
console.log('\n[2] deliberately dropped fragment -> stale cleanup, not a leak');
{
  const payload = crypto.randomBytes(80000);
  const messageId = 202;
  const frames = fragment(payload, { messageId, mtu: MTU_DEFAULT });
  check('multi-fragment message for the drop test', frames.length > 2);

  const staleMs = 150;
  const reassembler = new Reassembler({ staleMs, maxInFlight: 32 });
  const droppedIndex = Math.floor(frames.length / 2);
  const delivered = frames.filter((_, i) => i !== droppedIndex); // simulate one lost fragment

  let completedEarly = null;
  for (const f of delivered) {
    const out = reassembler.feed(f);
    if (out) completedEarly = out;
  }
  check('message never completes with a fragment missing', completedEarly === null);
  check('incomplete set is buffered (not silently discarded)', reassembler.has(messageId));
  check('exactly one in-flight set is being tracked', reassembler.pendingCount() === 1);

  await new Promise((r) => setTimeout(r, staleMs + 250));
  const evicted = reassembler.sweep();
  check('sweep evicts the stale incomplete set', evicted === 1);
  check('the stale messageId is gone after sweep (graceful cleanup, no leak)', !reassembler.has(messageId));
  check('pendingCount is back to zero', reassembler.pendingCount() === 0);
}

// --- Test 3: many concurrent dropped messages never leak past maxInFlight cap ---
console.log('\n[3] bounded memory under many concurrent never-completing messages');
{
  const maxInFlight = 8;
  const reassembler = new Reassembler({ staleMs: 999999, maxInFlight }); // huge staleMs: only the cap can save us here
  for (let id = 0; id < 20; id++) {
    const payload = crypto.randomBytes(40000);
    const frames = fragment(payload, { messageId: id, mtu: MTU_DEFAULT });
    // feed every fragment except the last one, so none of these ever complete
    for (const f of frames.slice(0, -1)) reassembler.feed(f);
  }
  check('pendingCount never exceeds maxInFlight even with 20 never-completing messages', reassembler.pendingCount() <= maxInFlight);
  console.log('  pendingCount after 20 incomplete messages (cap=' + maxInFlight + '):', reassembler.pendingCount());
}

// --- Test 4: duplicate fragment delivery is idempotent ---
console.log('\n[4] duplicate fragment delivery does not corrupt reassembly');
{
  const payload = crypto.randomBytes(30000);
  const frames = fragment(payload, { messageId: 303, mtu: MTU_DEFAULT });
  const reassembler = new Reassembler();
  // feed fragment 0 three times before the rest ever arrive
  reassembler.feed(frames[0]);
  reassembler.feed(frames[0]);
  reassembler.feed(frames[0]);
  check('duplicate feeds of the same fragment keep exactly one in-flight set', reassembler.pendingCount() === 1);
  let result = null;
  for (let i = 1; i < frames.length; i++) { const out = reassembler.feed(frames[i]); if (out) result = out; }
  check('reassembly still completes correctly despite duplicate delivery', result !== null && Buffer.from(result).equals(payload));
}

// --- Test 5: zero-length payload framing edge case ---
console.log('\n[5] zero-length payload edge case');
{
  const frames = fragment(new Uint8Array(0), { messageId: 404, mtu: MTU_DEFAULT });
  check('empty payload still produces exactly one fragment', frames.length === 1);
  const reassembler = new Reassembler();
  const out = reassembler.feed(frames[0]);
  check('empty payload reassembles immediately to a zero-length result', out !== null && out.length === 0);
}

// --- Test 6: oversized payload is rejected with a clear error, not a silent overflow ---
console.log('\n[6] payload exceeding the wire-format fragment-count ceiling');
{
  const tinyMtu = 20; // forces a huge fragment count quickly
  const tooLarge = maxPayloadBytes(tinyMtu) + 5000;
  let threw = false;
  try { fragment(new Uint8Array(tooLarge), { messageId: 505, mtu: tinyMtu }); }
  catch (e) { threw = /fragments/.test(e.message); }
  check('oversized payload throws a clear fragment-count-ceiling error', threw);
}

console.log('\n=== ' + passed + ' checks passed ===');
