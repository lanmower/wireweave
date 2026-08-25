---
key: mem-c4adafd5e39f8bdd-1264
ns: default
created: 1787656514879
updated: 1787656514879
---

wireweave src/relay-pool.js RelayHealth detail: rank recomputed on EVERY signal including recordConnectAttempt() itself (bug fixed 2026-07-19: previously only incremented attempts without recomputing rank, freezing a never-connecting relay at neutral 50 forever). _maybeRotate() evaluated from ws.onclose on EVERY close not only the sustained branch (bug fixed same day: previously only evaluated in the sustained>5s-then-dropped branch, so a relay that never connects at all never triggered rotation). Rotation requires: urls.length > MIN_ACTIVE_RELAYS(2), worst active relay attempts>=2, fallback candidate attempts>0, rank gap >= ROTATE_GAP(20). Health persists via storage-injection, safeSetItem-guarded, key ww_relay_health, debounced 2s, RelayHealth.fromJSON on fresh pool load. Each RelayPool self-registers into debug.js registry Map (relayPool, relayPool2...) via debug.register/deregister exposing healthReport(); disconnect() deregisters, GC-only leaks the key. Test coverage in test.js against real ephemeral-relay.js relay + real unbound TCP port (genuine ECONNREFUSED): testRelayHealthScoring, testUnhealthyRelayLowerScore, testAutoRotateAwayFromUnhealthy, testNoRotateToUntestedCandidate, testHealthPersistsAcrossReload, testDebugPanelExposesHealth.
