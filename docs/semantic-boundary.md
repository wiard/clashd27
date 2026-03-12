# CLASHD27 Semantic Boundary

CLASHD27 is the discovery radar.
It may discover, cluster, score, explain, and hand off.
It must not present itself as the production execution or receipt authority.

## Allowed Terms In CLASHD27

- `signal`
- `hypothesis`
- `candidate`
- `proposal`
- `collision`
- `discovery_context`
- `residue`
- `gravity`
- `emergence`

These are discovery-layer terms.
They are safe because they stop before production governance and bounded execution.

## Forbidden Terms In CLASHD27 (production code)

- `execution`
- `action`
- `bounded_execution`
- `receipt`

These belong to `openclashd-v2` as canonical production governance / execution objects.

## Handoff Rule

- CLASHD27 stops at: `proposal` handoff to `openclashd-v2`
- CLASHD27 never says: `execute` / `run` / `perform` / `deploy`
- CLASHD27 may recommend investigation or proposal intake
- CLASHD27 may not imply production execution ownership

## Current Boundary Violations Found

The list below covers repo-owned files with meaningful semantic drift.
Dependency noise (`node_modules`), vendored licenses, and cached corpora were excluded because they are not actionable product language.

### Production Code

- `lib/governance-kernel.js`
  - Uses `execute`, `action`, `receipt`, and `action_receipt`
  - Highest-risk boundary violation because it makes CLASHD27 sound like a production governance/execution kernel
- `lib/knowledge-persistence.js`
  - Uses `receipt`, `Decision`, `Action receipt`, and `action_receipt`
  - Boundary violation because persistence objects are named as if CLASHD27 owns post-approval execution proof
- `lib/proposal-metadata.js`
  - Uses `recommended action kind` and `action layer consumption`
  - Should shift toward proposal / handoff wording
- `lib/v2-knowledge-publisher.js`
  - Uses `action creation` and `recommendedActionKind`
  - Should stop at proposal handoff wording
- `lib/validator.js`
  - Uses `Build action summary`
  - Summary language should align with proposal / handoff semantics
- `lib/deep-dive.js`
  - Uses repeated `action` terminology in relevance and actionability scoring
  - Needs review to decide whether this is harmless research language or production-boundary drift
- `src/gap/hypothesis-generator.js`
  - Uses `execution path` and `execution side effects`
  - Mostly defensive wording, but still names execution inside discovery code
- `src/gap/gap-packet.js`
  - Uses `No execution permitted from CLASHD27` and `forbid execution`
  - Defensive but still boundary-relevant, because the forbidden term appears in production discovery code
- `public/observatory.html`
  - Uses `approved extension action`
  - Public research surface should avoid sounding like an execution surface

### Documentation And Public Research Surfaces

- `README.md`
  - Says `canonical governance and action kernel`
  - Shows `decisions -> execution <- consent -> receipts`
- `GAP_DISCOVERY.md`
  - Uses `execute`, `recommended action`, and `execution`
  - Good intent, but still too much execution vocabulary for the discovery repo
- `CLASHD-27-PROTOCOL.md`
  - Says `L2 and L3 are action`
  - Too close to execution semantics for the canonical discovery boundary
- `docs/AI_MASTER_PROMPT.md`
  - Uses `Action -> Receipt`
- `docs/AI_NEXT_PHASE_PROMPT.md`
  - Uses `Receipt`
- `docs/CLASHD27_SITE_PLAN.md`
  - Uses `recommended action kinds`
- `docs/PUBLIC_API_MAP.md`
  - Refers to `kernel execution APIs`
- `docs/RESEARCH_SITE_MAP.md`
  - Refers to `execution or approval surface`

### Tests And Sandbox Artifacts

- `scripts/test-governance-kernel.js`
  - Repeated `action result`, `receipt`, and `action_receipt`
- `tests/gap-pipeline.test.js`
  - Uses `bounded recommended action` and `direct execution`
- `scripts/find-agent-framework-gaps.js`
  - Uses `execution loop attack`, `execute`, and `Deploy`

These can remain temporarily for test coverage, but they should not define the production vocabulary of CLASHD27.

## Immediate Guidance

- In production-facing CLASHD27 code, prefer:
  - `candidate`
  - `proposal handoff`
  - `discovery packet`
  - `investigation recommendation`
- Avoid:
  - `action`
  - `execution`
  - `receipt`
  - `deploy`

The human decides.
CLASHD27 discovers and hands off.
`openclashd-v2` remains the trust root and the only production execution authority.
