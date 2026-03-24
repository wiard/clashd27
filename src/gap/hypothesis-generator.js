'use strict';

function compactAxes(candidate) {
  return (candidate.axes || [])
    .map(axis => `${axis.what}/${axis.where}/${axis.time}`)
    .filter(Boolean)
    .join(' x ');
}

function buildHypothesis(candidate, scores) {
  const axesLabel = compactAxes(candidate) || 'cross-cell pattern';
  const claim = `Signals clustered in ${axesLabel} indicate an ungoverned capability or missing control surface worth formal proposal review.`;
  return {
    statement: claim,
    rationale: `Candidate ${candidate.id} shows novelty ${scores.novelty}, collision ${scores.collision}, residue ${scores.residue}, gravity ${scores.gravity}, evidence ${scores.evidence}, entropy ${scores.entropy}, and serendipity ${scores.serendipity}.`,
    mechanism: 'Repeated signals are converging across semantically adjacent or distant cube cells faster than existing governance language explains.',
    operatorValue: 'Escalating this as a proposal candidate gives Jeeves a legible decision object before any execution path is considered.'
  };
}

function buildVerificationPlan(candidate, scores) {
  return [
    {
      step: 'Confirm the signal bundle',
      objective: 'Verify that the supporting signals map deterministically into the stated cube cells and no ingestion anomaly created the pattern.',
      successMetric: `Cell signature remains stable for candidate ${candidate.id}.`,
      boundedBy: 'single replay over current signal bundle'
    },
    {
      step: 'Test competing explanations',
      objective: 'Check whether the candidate is better explained by a known cluster, corridor, or existing governance surface rather than a new gap.',
      successMetric: 'Alternative explanation is weaker than the current hypothesis.',
      boundedBy: 'current cube state and current emergence summary only'
    },
    {
      step: 'Draft bounded proposal',
      objective: 'Translate the candidate into an openclashd-v2 proposal with explicit scope, operator approval, and certification hooks.',
      successMetric: `Proposal payload preserves total score ${scores.total} and includes kill tests.`,
      boundedBy: 'proposal payload only, no execution side effects'
    }
  ];
}

function buildKillTests(candidate, scores) {
  return [
    {
      condition: 'Deterministic remapping changes the primary cube cell or axes signature.',
      reason: 'The candidate is not stable enough for governed intake if its semantic location is not reproducible.'
    },
    {
      condition: scores.evidence < 0.3,
      reason: 'Weak evidence should remain an observatory hint, not a proposal candidate.'
    },
    {
      condition: scores.collision < 0.25 && scores.gravity < 0.25,
      reason: 'Low interaction pressure means there is not enough structured pull to justify operator review yet.'
    },
    {
      condition: scores.entropy < 0.2 && scores.serendipity < 0.2,
      reason: 'If the pattern is neither informationally rich nor meaningfully cross-domain, it is probably routine noise.'
    }
  ];
}

function buildRecommendedAction(candidate, scores) {
  return {
    type: 'submit_gap_proposal',
    targetSystem: 'openclashd-v2',
    bounded: true,
    executes: false,
    requiresHumanApproval: true,
    rationale: `Candidate ${candidate.id} scored ${scores.total} and should stop at governed proposal intake.`,
    proposedIntent: 'proposal_intake_only'
  };
}

module.exports = {
  buildHypothesis,
  buildKillTests,
  buildRecommendedAction,
  buildVerificationPlan
};
