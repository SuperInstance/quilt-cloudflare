# SUGGESTIONS — vessel fit (F/V EILEEN, Kodiak)

*From the 2026-08-26 vessel-fit playtest. The boat brain runs offline 60 mi offshore; this repo's seat is **shoreside, tier 2** — the "delayed cloud when in range" end of the escalation path. Companion: `quilt-rust/docs/VESSEL-FIT.md`.*

## What this repo is good for on this problem

- **Season archive.** The helm box journals a hash-chained cell ledger to SD card (ledger → JSONL, quilt-rust suggestion #2). When EILEEN comes into cell range, replay the journal into D1. The field-edge/ledger-bridge identity (`quilt-rust/docs/field-edge-ledger-bridge.md`: `imbalance = ‖Δ‖₂` at cell grain) means every archived transition arrives as un-gameable, hash-sealed surprise data — exactly what a "hundred boats" fleet wants pooled later.
- **Dissent ledger aggregation.** quilt-esp32 already writes dissent JSONL (metal vs. reference disagreements). A Worker endpoint that accepts these files when in range turns per-boat critic disagreements into a fleet-wide training corpus for the next gate revision. Zero real-time requirement — days-late sync is fine and honest.

## Suggestions (ranked)

1. **Add a `POST /journal-replay` style endpoint** (Worker + D1): accept a journaled ledger file, verify the hash chain server-side before storing, store raw + the `imbalance` projection. Verification-before-trust is the whole point of the seal.
2. **Vectorize only the escalated edges.** Don't embed every cell transition — embed only rows where `imbalance` exceeded threshold (the surprise loop's output). That's a few KB per day per boat, and it's the only data the shore actually learns from.
3. **Skip anything realtime.** No WebSocket fan-out, no edge "control" of the vessel. The boat is authoritative; the shore is a mirror and an archive. Anything that tempts the fleet to depend on cloud availability contradicts the doctrine.

**Not for the vessel, by design:** everything else in this repo (Pages dashboards are a shoreside convenience only — fine to have, never a dependency).
