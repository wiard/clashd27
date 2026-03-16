# Stream Ingestion

CLASHD27 keeps discovery deterministic by separating scaling from semantics.

## Boundary

- `raw-signals`
  Kafka-style transport topic for untrusted inbound signals
- `normalized-signals`
  Flink-style normalization boundary for deduplicated, weighted, time-windowed signals
- cube ingest
  Existing deterministic `cubeEngine.ingestSignal()` path

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

It may not:

- alter cube scoring
- alter discovery candidates
- alter gap scoring
- alter hypothesis generation
- alter governed handoff semantics

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
