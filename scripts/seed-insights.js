/**
 * CLASHD27 — Seed Insights Script
 * Pre-populates the insights database with initial research content
 *
 * Usage: node scripts/seed-insights.js [pack-id]
 * Default pack: cancer-research
 */

const fs = require('fs');
const path = require('path');

const INSIGHTS_FILE = path.join(__dirname, '..', 'data', 'insights.json');
const PACKS_DIR = path.join(__dirname, '..', 'packs');
const API_URL = 'http://localhost:3027/api/weigh';

// Agent names for variety
const AGENT_NAMES = [
  'ResearchBot-7', 'DataMiner-X', 'HypothesisHunter', 'CrossRef-9',
  'PatternSeeker', 'InsightEngine', 'AnalysisCore', 'Discovery-AI',
  'SynthAgent-3', 'PathwayFinder', 'BioLens', 'QuantumMed'
];

function getRandomAgent() {
  return AGENT_NAMES[Math.floor(Math.random() * AGENT_NAMES.length)];
}

function loadPack(packId) {
  const packPath = path.join(PACKS_DIR, packId + '.json');
  const raw = fs.readFileSync(packPath, 'utf8');
  return JSON.parse(raw);
}

function loadInsights() {
  try {
    if (fs.existsSync(INSIGHTS_FILE)) {
      const data = JSON.parse(fs.readFileSync(INSIGHTS_FILE, 'utf8'));
      return data.insights || [];
    }
  } catch (e) {}
  return [];
}

function saveInsights(insights) {
  fs.writeFileSync(INSIGHTS_FILE, JSON.stringify({ insights }, null, 2));
}

async function generateInsight(prompt) {
  const response = await fetch(API_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 200,
      messages: [{ role: 'user', content: prompt }]
    })
  });

  const data = await response.json();
  if (data.content && data.content[0] && data.content[0].text) {
    return data.content[0].text.trim();
  }
  throw new Error('Invalid API response: ' + JSON.stringify(data));
}

async function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function main() {
  const packId = process.argv[2] || 'cancer-research';
  console.log(`[SEED] Loading pack: ${packId}`);

  const pack = loadPack(packId);
  const existingInsights = loadInsights();
  const newInsights = [...existingInsights];

  let baseTick = 100; // Start from a reasonable tick number

  console.log(`[SEED] Generating CELL_INSIGHTS for all 27 cells...`);

  // Generate 1 CELL_INSIGHT per cell
  for (let cellId = 0; cellId < 27; cellId++) {
    const cell = pack.cells[String(cellId)];
    if (!cell) continue;

    const prompt = `You are a research AI agent exploring ${cell.label} in the context of ${pack.name}.
Generate a brief, specific research insight (2-3 sentences max) about ${cell.description}.
Be concrete and scientific. No preamble, just the insight.`;

    console.log(`  [${cellId}/27] ${cell.label}...`);

    try {
      const content = await generateInsight(prompt);
      newInsights.push({
        type: 'CELL_INSIGHT',
        tick: baseTick + cellId,
        cell: cellId,
        cellLabel: cell.label,
        agentName: getRandomAgent(),
        content,
        timestamp: new Date().toISOString()
      });
      await sleep(500); // Rate limit
    } catch (e) {
      console.error(`    Error: ${e.message}`);
    }
  }

  console.log(`[SEED] Generating 5 BOND_INSIGHTS...`);

  // Generate 5 BOND_INSIGHTS
  const bondPairs = [
    [0, 9],   // Genomics + Drug Interactions
    [5, 10],  // Pharmacology + Immune Response
    [2, 14],  // Clinical Trials + Treatment Sequencing
    [7, 24],  // Microbiome + Microbiome Therapy
    [1, 11]   // Proteomics + Biomarker Correlation
  ];

  for (let i = 0; i < bondPairs.length; i++) {
    const [cell1, cell2] = bondPairs[i];
    const c1 = pack.cells[String(cell1)];
    const c2 = pack.cells[String(cell2)];

    const prompt = `You are a research AI that discovered a connection between "${c1.label}" and "${c2.label}" in ${pack.name}.
Generate a brief insight (2-3 sentences) about what happens when these two domains connect.
Be specific and scientific. No preamble.`;

    console.log(`  [${i + 1}/5] ${c1.label} + ${c2.label}...`);

    try {
      const content = await generateInsight(prompt);
      newInsights.push({
        type: 'BOND_INSIGHT',
        tick: baseTick + 30 + i,
        cell: cell1,
        cellLabel: c1.label,
        bondCell: cell2,
        bondCellLabel: c2.label,
        agentName: getRandomAgent(),
        content,
        timestamp: new Date().toISOString()
      });
      await sleep(500);
    } catch (e) {
      console.error(`    Error: ${e.message}`);
    }
  }

  console.log(`[SEED] Generating 3 DISCOVERY insights...`);

  // Generate 3 DISCOVERY insights (cross-layer)
  const discoveryPairs = [
    [3, 20],  // Imaging & Pathology + Unexplored Pathways
    [0, 26],  // Genomics + Emergent Insights
    [8, 18]   // Environmental Factors + Novel Combinations
  ];

  for (let i = 0; i < discoveryPairs.length; i++) {
    const [cell1, cell2] = discoveryPairs[i];
    const c1 = pack.cells[String(cell1)];
    const c2 = pack.cells[String(cell2)];

    const prompt = `You are a research AI that made a major DISCOVERY by connecting "${c1.label}" (Layer ${c1.layer}) with "${c2.label}" (Layer ${c2.layer}) in ${pack.name}.
This is a cross-layer discovery - rare and valuable.
Generate a breakthrough insight (2-3 sentences) about this unexpected connection.
Be bold and specific. No preamble.`;

    console.log(`  [${i + 1}/3] ${c1.label} + ${c2.label}...`);

    try {
      const content = await generateInsight(prompt);
      newInsights.push({
        type: 'DISCOVERY',
        tick: baseTick + 40 + i,
        cell: cell2,
        cellLabel: c2.label,
        bondCell: cell1,
        bondCellLabel: c1.label,
        agentName: getRandomAgent(),
        content,
        crossLayer: true,
        timestamp: new Date().toISOString()
      });
      await sleep(500);
    } catch (e) {
      console.error(`    Error: ${e.message}`);
    }
  }

  // Save all insights
  saveInsights(newInsights);
  console.log(`[SEED] Done! Total insights: ${newInsights.length}`);
}

main().catch(e => {
  console.error('[SEED] Fatal error:', e);
  process.exit(1);
});
