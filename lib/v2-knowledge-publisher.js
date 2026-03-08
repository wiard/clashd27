/**
 * v2 Knowledge Publisher — publishes high-value discovery findings
 * to the openclashd-v2 gateway via HTTP POST.
 */

/**
 * Publish qualifying discoveries to the openclashd-v2 gateway.
 *
 * @param {Array} findings - Array of finding objects from the tick engine
 * @param {object} options
 * @param {string} options.gatewayUrl - Base URL of the openclashd-v2 gateway
 * @param {string} options.token - Authentication token
 * @returns {Promise<{published: number, failed: number}>}
 */
async function publishToV2(findings, { gatewayUrl, token }) {
  let published = 0;
  let failed = 0;

  // Filter to only high-value discoveries
  const qualifying = (findings || []).filter(f =>
    f.type === 'discovery' &&
    f.scores &&
    typeof f.scores.total === 'number' &&
    f.scores.total >= 50
  );

  if (qualifying.length === 0) {
    return { published, failed };
  }

  const url = `${gatewayUrl}/api/agents/propose?token=${token}`;

  for (const finding of qualifying) {
    try {
      const novelty = (finding.scores.novelty || 0) / 100;
      const evidenceDensity = Math.min(
        (finding.abc_chain || []).length / 5,
        1.0
      );

      const gptVerdict = finding.gpt_verdict || finding.verification || '';
      let sourceConfidence = 0.3;
      if (typeof gptVerdict === 'string') {
        const upper = gptVerdict.toUpperCase();
        if (upper === 'CONFIRMED') sourceConfidence = 0.9;
        else if (upper === 'WEAKENED') sourceConfidence = 0.6;
      }

      const title = finding.finding
        ? finding.finding.slice(0, 120)
        : finding.id;

      const body = {
        agentId: 'clashd27',
        title,
        intent: {
          key: 'intent.discovery.persist',
          payload: {
            discoveryId: finding.id,
            corridor: finding.corridor,
            novelty,
            evidenceDensity,
            crossDomain: true,
            crossDomainScore: 0.8,
            sourceConfidence,
            sources: (finding.supporting_sources || []).slice(0, 5),
            finding: finding.finding,
            scores: finding.scores,
            verdict: finding.verdict?.verdict
          },
          risk: 'green',
          requiresConsent: false
        }
      };

      const response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
      });

      if (response.ok) {
        published++;
      } else {
        const text = await response.text().catch(() => '');
        console.warn(`[clashd27] v2 publish HTTP ${response.status} for ${finding.id}: ${text}`);
        failed++;
      }
    } catch (err) {
      console.warn(`[clashd27] v2 publish error for ${finding.id}: ${err.message}`);
      failed++;
    }
  }

  if (published > 0) {
    const noun = published === 1 ? 'discovery' : 'discoveries';
    console.log(`[clashd27] published ${published} ${noun} to v2`);
  }

  return { published, failed };
}

module.exports = { publishToV2 };
