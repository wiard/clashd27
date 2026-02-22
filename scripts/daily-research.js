/**
 * CLASHD27 — Daily Research Crawler
 * Fetches real research using Claude with web search for the active pack
 * Run daily via PM2 cron or manually: node scripts/daily-research.js [pack-id]
 */

const fs = require('fs');
const path = require('path');

const API_URL = 'http://localhost:3027/api/weigh';
const PACKS_DIR = path.join(__dirname, '..', 'packs');
const OUTPUT_FILE = path.join(__dirname, '..', 'data', 'daily-research.json');

function loadPack(packId) {
  const packPath = path.join(PACKS_DIR, packId + '.json');
  const raw = fs.readFileSync(packPath, 'utf8');
  return JSON.parse(raw);
}

async function searchResearch(cellLabel, packName) {
  const prompt = `Search for the most recent research developments (last 7 days) related to "${cellLabel}" in ${packName}. Find real papers, real news, real breakthroughs. Return a JSON array of 3 items, each with: title, source, date, summary (2 sentences), relevance_to_cell (1 sentence). Only include real, verifiable sources. No invented references. Return ONLY the JSON array, no other text.`;

  try {
    const response = await fetch(API_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 1500,
        tools: [{ type: 'web_search_20250305', name: 'web_search' }],
        messages: [{ role: 'user', content: prompt }]
      })
    });

    if (!response.ok) {
      console.error(`  API error: ${response.status}`);
      return null;
    }

    const data = await response.json();

    // Extract text from response - may be in different formats
    let text = '';
    if (data.content) {
      for (const block of data.content) {
        if (block.type === 'text') {
          text += block.text;
        }
      }
    }

    // Parse JSON from response
    const jsonMatch = text.match(/\[[\s\S]*\]/);
    if (jsonMatch) {
      try {
        const articles = JSON.parse(jsonMatch[0]);
        return articles.slice(0, 3).map(a => ({
          title: a.title || 'Untitled',
          source: a.source || 'Unknown',
          date: a.date || new Date().toISOString().split('T')[0],
          summary: a.summary || '',
          relevance: a.relevance_to_cell || a.relevance || ''
        }));
      } catch (e) {
        console.error(`  JSON parse error: ${e.message}`);
        return null;
      }
    }

    console.error('  No JSON found in response');
    return null;
  } catch (err) {
    console.error(`  Fetch error: ${err.message}`);
    return null;
  }
}

async function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function main() {
  const packId = process.argv[2] || 'cancer-research';
  console.log(`[RESEARCH] Starting daily crawl for pack: ${packId}`);
  console.log(`[RESEARCH] Date: ${new Date().toISOString().split('T')[0]}`);

  const pack = loadPack(packId);
  const today = new Date().toISOString().split('T')[0];

  const briefings = [];

  // Select 3 cells per layer (9 cells total for cost efficiency)
  // Layer 0: cells 0-8, Layer 1: cells 9-17, Layer 2: cells 18-26
  const cellsToFetch = [];

  // Pick 3 random cells from each layer
  for (let layer = 0; layer < 3; layer++) {
    const layerStart = layer * 9;
    const layerCells = [];
    for (let i = 0; i < 9; i++) {
      layerCells.push(layerStart + i);
    }
    // Shuffle and pick 3
    for (let i = layerCells.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [layerCells[i], layerCells[j]] = [layerCells[j], layerCells[i]];
    }
    cellsToFetch.push(...layerCells.slice(0, 3));
  }

  console.log(`[RESEARCH] Fetching research for ${cellsToFetch.length} cells: ${cellsToFetch.join(', ')}`);

  for (const cellId of cellsToFetch) {
    const cell = pack.cells[String(cellId)];
    if (!cell) continue;

    console.log(`  [Cell ${cellId}] ${cell.label}...`);

    const articles = await searchResearch(cell.label, pack.name);

    if (articles && articles.length > 0) {
      briefings.push({
        cell: cellId,
        cellLabel: cell.label,
        layer: cell.layer,
        articles
      });
      console.log(`    Found ${articles.length} articles`);
    } else {
      console.log(`    No articles found`);
    }

    // Rate limit: wait 2 seconds between API calls
    await sleep(2000);
  }

  // Save results
  const output = {
    date: today,
    pack: packId,
    packName: pack.name,
    fetchedAt: new Date().toISOString(),
    cellsSearched: cellsToFetch.length,
    briefings
  };

  const dataDir = path.dirname(OUTPUT_FILE);
  if (!fs.existsSync(dataDir)) {
    fs.mkdirSync(dataDir, { recursive: true });
  }
  fs.writeFileSync(OUTPUT_FILE, JSON.stringify(output, null, 2));

  console.log(`[RESEARCH] Done! Saved ${briefings.length} briefings to ${OUTPUT_FILE}`);
}

main().catch(e => {
  console.error('[RESEARCH] Fatal error:', e);
  process.exit(1);
});
