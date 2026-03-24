# Stream Ingestion

CLASHD27 keeps discovery deterministic by separating scaling from semantics.

## Boundary

- `raw-signals`
  Kafka-style transport topic for untrusted inbound signals
- `normalized-signals`
  Flink-style normalization boundary for deduplicated, weighted, time-windowed signals
- cube ingest
  Existing deterministic `cubeEngine.ingestSignal()` path

## Hybrid deployment split

- **MacBook / CLASHD27**
  owns paper ingestion, local queues, normalized signal generation, deterministic cube discovery, and the full append-only gap library
- **VPS / Redpanda sidecar**
  optional lightweight transport broker only
- **VPS / Flink (future)**
  reserved for stream normalization and windowing only
- **VPS / OpenClashd**
  canonical governance surface, `/api/gaps`, operator APIs, and website state

The permanent library stays local to the MacBook:

- `data/gap-library.jsonl`
- `data/domains/*/gaps.jsonl`
- `data/library-runs/`

Only governed handoffs cross the boundary to OpenClashd. The full library, paper corpus, and run artifacts do not.

## Responsibilities

### Ingestion layer

Lives in:

- [src/orchestration/discovery-stream-orchestrator.js](/Users/wiardvasen/clashd27/src/orchestration/discovery-stream-orchestrator.js)
- [src/queue/signal-normalizer.js](/Users/wiardvasen/clashd27/src/queue/signal-normalizer.js)
- [src/sources/](/Users/wiardvasen/clashd27/src/sources/arxiv-source.js)

It may:

- fetch papers from `arXiv`, `Semantic Scholar`, `OpenAlex`, and `Crossref`
- ingest GitHub and internal runtime signals
- normalize signal contracts
- assign source weights
- deduplicate repeated inputs
- batch signals into deterministic hour windows
- optionally publish stream copies into a VPS-side broker later without moving the source of truth away from the MacBook

It may not:

- alter cube scoring
- alter discovery candidates
- alter gap scoring
- alter hypothesis generation
- alter governed handoff semantics
- turn the VPS into the permanent gap library host
- couple future Flink jobs to OpenClashd governance storage

### Discovery layer

Lives in:

- [lib/clashd27-cube-engine.js](/Users/wiardvasen/clashd27/lib/clashd27-cube-engine.js)
- [src/gap/gap-pipeline.js](/Users/wiardvasen/clashd27/src/gap/gap-pipeline.js)

This layer stays unchanged and deterministic.

## Normalized Signal Contract

```json
{
  "type": "paper-theory",
  "domain": "ai-governance",
  "title": "Trust Corridor for AI Governance",
  "content": "trimmed abstract content",
  "score": 0.82,
  "sourceWeight": 1.5,
  "timestamp": "2026-03-16T09:00:00.000Z",
  "windowStartIso": "2026-03-16T09:00:00.000Z"
}
```

## Source Weights

- `paper-theory` → `1.5`
- `github-repo` → `1.2`
- `internal-system` → `0.7`

Additional paper facets use bounded weights close to the paper-theory baseline so the stream layer can emit richer signals without changing the discovery core.

## Verification

```bash
npm run test:ingestion
```

For the hybrid deployment, also verify:

```bash
node bin/library-stats.js
node bin/nightly-reader.js --domain ai-governance
```

Those runs should continue to write the library locally while governed handoffs publish to `OPENCLASHD_GATEWAY_URL` over HTTP.
