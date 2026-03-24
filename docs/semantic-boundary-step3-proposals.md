# Step 3: CLASHD27 Boundary Fix Proposals

Scope:

- `lib/governance-kernel.js`
- `lib/knowledge-persistence.js`

Source of truth:

- [semantic-boundary.md](/Users/wiardvasen/clashd27/docs/semantic-boundary.md)

This document does not apply changes.
It records the violations found and proposes the architectural fix for each one.
The operator decides what to change.

## Boundary Rules Applied

- CLASHD27 may discover, explain, rank, and hand off.
- CLASHD27 must stop at proposal handoff to `openclashd-v2`.
- CLASHD27 must not present itself as the production execution or receipt authority.
- Forbidden production-code terms:
  - `execution`
  - `action`
  - `bounded_execution`
  - `receipt`
- Handoff rule:
  - CLASHD27 never says `execute`, `run`, `perform`, or `deploy` in production-boundary logic.

## File 1: `lib/governance-kernel.js`

### Summary

This file is the highest-risk semantic boundary violation in CLASHD27.
Even though it declares itself sandbox-only, it still speaks as if CLASHD27 owns decision, execution, and receipt semantics.

### Violations And Proposed Fixes

| Line | Current wording / object | Why this violates the boundary | Proposed architectural fix |
| --- | --- | --- | --- |
| 4-17 | `SANDBOX-MODE governance kernel` with lifecycle `submit -> rank -> decide -> execute -> receipt` | Even in sandbox framing, the file teaches the wrong production language inside the discovery repo. | Move sandbox-governance language behind an explicit `sandbox-only` compatibility note and define the production handoff as `submit -> rank -> proposal handoff`. Keep sandbox semantics clearly segregated from production vocabulary. |
| 11-13 | `openclashd-v2 is the canonical governance/action kernel` and `decision or execution path` | The comments correctly defer authority, but still normalize `action` and `execution` language inside CLASHD27 core code. | Reframe the comment around `proposal handoff`, `approval ownership`, and `bounded execution owned by openclashd-v2`. The production story should not require CLASHD27 to name execution stages at all. |
| 130 | `decision: null` on proposal record | This stores post-proposal approval state inside CLASHD27 production-facing logic. | Replace the local ownership model with a `handoffStatus` or `gatewayDisposition` concept for production paths. Sandbox approval state, if retained, should live in an explicitly isolated sandbox structure. |
| 146-158 | `decision`, `approved`, `denied`, `decideProposal(...)` | CLASHD27 is performing approval semantics rather than stopping at handoff. | Architecturally split this into two modes: `sandbox review` for local demos and `production handoff` for real operation. Production-facing callers should receive a handoff acknowledgment, not a local approval object. |
| 165-197 | `Attach action execution result to a proposal` and `actionResult` payload | This directly models post-approval execution ownership in CLASHD27. | Replace the production concept with `handoffOutcomeRef` or `governanceResultRef` that points outward to `openclashd-v2` artifacts. Any local sandbox result should be explicitly marked `sandboxOnly`. |
| 250-277 | `Action execution`, `Execute the action associated with an approved proposal`, `no-op action with minimal receipt` | This is direct production-boundary collapse: CLASHD27 is executing and emitting receipt semantics. | Remove production ownership from the architecture: production code path should emit `proposal handoff accepted` or `no downstream handler`. Sandbox execution, if retained, should be moved behind a sandbox adapter with non-production naming. |
| 280-298 | Create `decision` knowledge object with title `Decision:` and metadata `decision: 'approved'` | This turns CLASHD27 into a producer of approval artifacts. | In production architecture, CLASHD27 should at most persist a `proposal_handoff` or `discovery_context` object. Approval artifacts should be created only by `openclashd-v2` and linked back in later. |
| 300-317 | `Research task initiated from proposal ...` inside CLASHD27 | `Research task` implies execution ownership rather than discovery recommendation. | Reframe this object as `investigation recommendation` or `discovery follow-up context`. The actual task or bounded execution should be created downstream by the trust root. |
| 319-332 | Create `action_receipt` with title `Receipt:` and metadata `actionType` / `executedAtIso` | This is the clearest forbidden-term breach. CLASHD27 is naming and timestamping execution receipts. | Remove receipt creation from CLASHD27 production flow. Replace with an optional `downstreamReceiptRef` field that is populated only after `openclashd-v2` returns a receipt identifier. |
| 334-347 | Link chain `decision -> investigation_outcome -> action_receipt` and notes with `receipt(...)` | The knowledge graph encodes CLASHD27 as owner of the post-approval causal chain. | Redefine the graph boundary: CLASHD27 may link `discovery -> proposal_handoff -> investigation recommendation`. Downstream `approval_decision` and `execution_receipt` nodes must be imported from `openclashd-v2`, not authored here. |
| 353 | `attachActionResult(proposal.id, result)` | Finalizes execution ownership in the local proposal store. | Replace production linkage with `attachHandoffReference(proposal.id, downstreamRef)` semantics. Sandbox result attachment should remain isolated from production language. |

### Architectural Direction For This File

Do not rename blindly.
The correct architectural fix is to separate three concepts:

1. Discovery-owned objects in CLASHD27
   - `candidate`
   - `proposal`
   - `discovery_context`
   - `investigation_recommendation`

2. Sandbox-only demo objects
   - kept only if clearly fenced behind explicit sandbox mode and naming

3. Trust-root-owned production objects in `openclashd-v2`
   - `approval_decision`
   - `execution_receipt`
   - bounded execution state

The production path should stop after proposal handoff and wait for downstream references.

## File 2: `lib/knowledge-persistence.js`

### Summary

This file is safer than `lib/governance-kernel.js` because it is already a knowledge store, but it still persists post-approval chain objects as if CLASHD27 owns decision and receipt semantics.

### Violations And Proposed Fixes

| Line | Current wording / object | Why this violates the boundary | Proposed architectural fix |
| --- | --- | --- | --- |
| 256-264 | `Persist a full decision chain (decision -> investigation_outcome -> action_receipt)` and return `{ decision, investigation, receipt }` | This defines a post-approval causal chain inside CLASHD27 production code. | Replace the production persistence model with a `discovery chain` or `proposal handoff chain`. Approval and execution receipt nodes should be linked in later from `openclashd-v2`, not created here. |
| 272-283 | Persist `kind: 'decision'`, title `Decision: ...`, metadata `decision: 'approved'` | CLASHD27 is authoring approval artifacts. | Persist a `proposal_handoff` or `review_request` object instead. Approval state should come from the kernel when available. |
| 285-301 | `Investigation: ...` summary `Research task initiated from proposal ...` | `Research task initiated` implies downstream execution has already happened in the discovery repo. | Recast this as `investigation recommendation prepared from proposal ...` or `discovery follow-up context assembled ...`. |
| 303-313 | Persist `kind: 'action_receipt'`, title `Receipt: ...`, summary `Action receipt ...`, metadata `actionType`, `executedAtIso` | This is direct receipt authorship in the discovery repo. | Remove receipt persistence from CLASHD27 production flow. Introduce a placeholder reference field such as `kernelReceiptRef` or `downstreamExecutionRef` to be linked after governance execution completes in `openclashd-v2`. |
| 315-323 | Link chain `decision -> investigation -> receipt` and return `receipt` in the API | The knowledge API exposes CLASHD27 as owner of the full governed chain. | Change the architecture so the API returns discovery-side objects only, plus optional downstream references. If a full graph is needed, hydrate it from imported kernel-owned nodes rather than persisting them locally. |

### Architectural Direction For This File

The right fix is not a superficial rename.
The right fix is to redraw the ownership boundary of the persisted graph:

- CLASHD27 persists:
  - discovery findings
  - candidate context
  - proposal handoff context
  - investigation recommendations

- `openclashd-v2` persists:
  - approvals
  - bounded action state
  - execution receipts
  - downstream knowledge derived from approved execution

- CLASHD27 may later import and display downstream references, but it should not author them.

## Recommended Operator Decision Sequence

1. Approve a boundary-only design pass for these two files.
2. Split sandbox semantics from production semantics explicitly.
3. Replace local approval / execution / receipt authorship with proposal-handoff and downstream-reference concepts.
4. Only after that, decide whether any code rename is still necessary.

## Files Reviewed

- [governance-kernel.js](/Users/wiardvasen/clashd27/lib/governance-kernel.js)
- [knowledge-persistence.js](/Users/wiardvasen/clashd27/lib/knowledge-persistence.js)
