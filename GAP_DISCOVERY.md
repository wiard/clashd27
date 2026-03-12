# Gap Discovery

## Role

CLASHD27 is the transparent floating computation cube above the governed system.

It is:

- discovery only
- deterministic
- auditable
- calm in output structure
- strict about stopping at proposal handoff

It does not:

- execute
- govern
- approve
- mutate trusted system state outside discovery data

It does:

- ingest and normalize signals
- map them into the 3x3x3 semantic cube
- compare tensions, absences, collisions, residue, entropy, and evidence
- generate falsifiable hypotheses
- generate bounded verification plans
- generate sharp kill tests
- recommend a governed next step
- emit `GapPacket` and `GapProposalHandoff`

## Insertion Points

- [`/Users/wiardvasen/clashd27/lib/clashd27-cube-engine.js`](/Users/wiardvasen/clashd27/lib/clashd27-cube-engine.js)
  Canonical signal normalization, cube semantics, and emergence state.
- [`/Users/wiardvasen/clashd27/lib/discovery-candidates.js`](/Users/wiardvasen/clashd27/lib/discovery-candidates.js)
  Existing structured discovery candidates that the gap layer refines.
- [`/Users/wiardvasen/clashd27/lib/event-emitter.js`](/Users/wiardvasen/clashd27/lib/event-emitter.js)
  Existing observatory seam where gap outputs are exposed to Jeeves and `openclashd-v2`.

## Module Surface

- [`/Users/wiardvasen/clashd27/src/gap/cube-mapper.js`](/Users/wiardvasen/clashd27/src/gap/cube-mapper.js)
  Deterministic signal normalization summary and cube mapping.
- [`/Users/wiardvasen/clashd27/src/gap/gap-scorer.js`](/Users/wiardvasen/clashd27/src/gap/gap-scorer.js)
  Explainable scoring formulas.
- [`/Users/wiardvasen/clashd27/src/gap/hypothesis-generator.js`](/Users/wiardvasen/clashd27/src/gap/hypothesis-generator.js)
  Hypothesis, verification plan, kill tests, and bounded recommended action.
- [`/Users/wiardvasen/clashd27/src/gap/gap-packet.js`](/Users/wiardvasen/clashd27/src/gap/gap-packet.js)
  Canonical `GapPacket` and `GapProposalHandoff`.
- [`/Users/wiardvasen/clashd27/src/gap/gap-pipeline.js`](/Users/wiardvasen/clashd27/src/gap/gap-pipeline.js)
  End-to-end discovery pipeline from raw signals or discovery candidates to governed handoff.

## Canonical GapPacket

Each packet is:

- deterministic
- inspectable
- renderable in Jeeves
- certifiable in SafeClash

Core fields:

- `kind = "gap_packet"`
- `version = "clashd27.gap.v1"`
- `candidate`
- `cube`
- `normalization`
- `scores`
- `hypothesis`
- `verificationPlan`
- `killTests`
- `recommendedAction`
- `lifecycle`
- `gapProposalHandoff`

## Scoring

Scores are normalized to `0..1`.

- `novelty`
  Emerging/current/historical weighting plus low saturation and domain distance.
- `collision`
  Related emergence collisions plus domain distance and far-field bonus.
- `residue`
  Local score pressure plus formula residue and persistence.
- `gravity`
  Local gravity relative to the strongest current gravity well.
- `evidence`
  Evidence score plus source diversity and temporal spread.
- `entropy`
  Entropy seed plus source dispersion and time dispersion.
- `serendipity`
  Domain distance plus far-field contact plus source/time mixing.

Total score:

`0.16N + 0.18C + 0.16R + 0.16G + 0.14E + 0.10H + 0.10S`

Every formula is recorded in `scoringTrace`.

## Verification Discipline

Every candidate must produce:

- a falsifiable hypothesis
- a bounded verification plan
- kill tests sharp enough to stop weak candidates quickly
- a recommended action that ends at proposal intake

Recommended action is always:

- bounded
- non-executing
- human-approval dependent
- targeted to `openclashd-v2`

## GapProposalHandoff

The governed handoff object is:

- `type = "gap_proposal_handoff"`
- `destinationSystem = "openclashd-v2"`
- `executionMode = "forbidden"`
- `directExecutionAllowed = false`
- `proposalIntakeKind = "proposal_intake"`

It contains:

- normalized score breakdown
- hypothesis
- verification plan
- kill tests
- recommended action
- lifecycle state
- normalization summary
- evidence references

## Lifecycle Boundary

Lifecycle is explicit and ends inside CLASHD27 at handoff readiness.

Stages:

- `signal_normalized`
- `cube_mapped`
- `candidate_scored`
- `hypothesis_generated`
- `verification_plan_built`
- `kill_tests_defined`
- `handoff_ready`

Authority boundary:

- `clashd27_stops_at_proposal`

Next stage after CLASHD27:

- `openclashd-v2_proposal_intake`

## Why This Prevents Discovery From Becoming Execution

- No packet includes executable actions.
- Recommended action is proposal-only.
- Handoff metadata explicitly forbids direct execution.
- Lifecycle boundary states that CLASHD27 authority ends at handoff.
- `event-emitter` only surfaces packets and handoffs; it does not call governance or action code.

## Verification

Run:

```bash
npm test:gap
```

Or:

```bash
npm test
```
