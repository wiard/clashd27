# CLASHD27 2.0 — Complete Implementation Prompt

## Context

You are working on CLASHD27, an autonomous cross-domain research gap finder running on a Hetzner VPS (Ubuntu, nginx, PM2, Node.js). The codebase lives in `~/clashd27/`. Current version is v0.11.1.

CLASHD27 runs 24/7 on a €5/month VPS. 4 AI agents move through a 3×3×3 cube of 27 research cells across 3 layers. Every 5 minutes a tick fires. When agents from different layers meet in the same cell, the system investigates cross-domain research gaps using a 10+ step pipeline including Semantic Scholar paper pre-fetch, PI-grade hypothesis generation, scoring rubric, red flag filters, GPT-4o adversarial review, and DOI verification.

### Existing core files you must preserve and extend:
- `bot.js` — main loop (tick every 5 min, tick lock, atomic writes, queue persistence, circuit breaker)
- `lib/researcher.js` — Claude API calls, PI-grade hypothesis generation, scoring, red flags
- `lib/semantic-scholar.js` — S2 API client (search, DOI verify, paper pre-fetch, 7-day cache, rate limiting)
- `lib/verifier.js` — GPT-4o adversarial review with error categorization
- `lib/saturation.js` — field density estimation
- `lib/validator.js` — dataset/trial/contact discovery
- `lib/deep-dive.js` — 3-step evaluation
- `lib/retrospective.js` — manual retrospective validation
- `data/state.json` — agents, tick counter, bonds, queues
- `data/findings.json` — all records (capped at 1000)
- `data/metrics.json` — recomputed from ground truth each boot
- `dashboard/index.html` — Three.js 3D cube visualization
- `dashboard/arena.html` — gap packet display + metrics
- `ecosystem.config.js` — PM2 config with dotenv

### APIs available:
- **Semantic Scholar** (free, 200M+ papers, rate limited) — `api.semanticscholar.org`
- **Anthropic Claude** (~$57 credits) — classification + hypothesis generation
- **OpenAI GPT-4o** (~$10 credits) — adversarial verification

### Current metrics:
- 155+ cell findings, 28 discovery attempts, 22 discoveries
- 2 NO GAP rejections, 2 HIGH-VALUE gaps (87/100)
- Only domain pack active: Cancer Research

---

## PART 1: THE ANOMALY MAGNET — New Cube Architecture

Replace the static domain pack system with a dynamic paper sampling and classification system. The 27 cells become defined by THREE AXES instead of hardcoded domains.

### The Three Axes

**X-axis — Method DNA (3 clusters: 0, 1, 2)**
Classify papers by HOW they do research, not what they study:
- `0` = imaging / spectroscopy / observation
- `1` = computational / simulation / modeling
- `2` = experimental / wet-lab / intervention

Detection: Use abstract keyword matching + OpenAlex concepts + PubMed MeSH terms + PapersWithCode method index (see Part 2 for data sources).

Keyword banks:
- imaging: microscopy, imaging, MRI, CT, spectroscopy, crystallography, observation, survey, epidemiological
- computational: simulation, model, algorithm, neural network, machine learning, in-silico, bioinformatics, computational
- experimental: in-vivo, in-vitro, wet-lab, assay, knockout, transfection, clinical trial, intervention, synthesis

**Y-axis — Surprise Index (3 levels: 0, 1, 2)**
- `0` = confirmatory — result confirms hypothesis
- `1` = deviation — unexpected side finding
- `2` = anomalous — result contradicts hypothesis or established knowledge

Detection via multiple signals:
- Abstract language: "unexpectedly", "contrary to", "surprisingly", "paradoxically", "challenges the assumption", "contradicts", "failed to replicate" → anomalous
- "additionally", "incidental finding", "serendipitously", "unanticipated" → deviation
- Default to confirmatory (0) if no markers
- Citation burst (citationCount/age > threshold)
- Retraction Watch cross-reference (see Part 2)
- Citation velocity spikes via OpenCitations (see Part 2)
- Terminated clinical trials

Scoring: 0-10 surprise score → mapped to 0/1/2:
- +3 if retracted
- +2 if cites retracted paper
- +2 if citation velocity spike detected
- +1 per anomaly language marker
- +1 if related trial terminated/withdrawn
- 0-2 → confirmatory (Y=0), 3-5 → deviation (Y=1), 6+ → anomalous (Y=2)

**Z-axis — Semantic Orbit (3 clusters: 0, 1, 2, ROTATING)**
Cluster papers by semantic similarity. Every SHUFFLE_INTERVAL ticks (default: 50), resample and recluster. X and Y stay stable. Z shuffles. This is the serendipity engine.

Primary: OpenAlex primary_topic.field (19 root fields)
Secondary: TF-IDF on abstracts → k-means with k=3 (use `natural` + `ml-kmeans` npm packages)

### Cell addressing

Each cell is `[x, y, z]` where x=method, y=surprise, z=semantic_cluster.
Cell `[1, 2, 0]` = computational papers with anomalous results in semantic cluster 0.
Total: 3×3×3 = 27 cells, same cube geometry.

### Why this is explosive

A cell at `[1, 2, 0]` contains: computational papers with anomalous results in semantic cluster A. The adjacent cell `[2, 2, 0]` contains: wet-lab papers with anomalous results in the same semantic cluster. Two researchers used different methods. Both found something unexpected. They don't know about each other. THAT is the gap.

### The Golden Collision Rule

Highest-value gaps occur where:
- Method DNA differs (different tools)
- Surprise is high on both sides (both anomalous)
- Semantic distance is large (different fields)
- But a shared entity exists (protein, gene, molecule, mathematical pattern)

```javascript
function goldenCollisionScore(cell1, cell2) {
  const methodDistance = Math.abs(cell1[0] - cell2[0]) / 2;
  const surpriseProduct = (cell1[1] * cell2[1]) / 4;
  const semanticDistance = cell1[2] !== cell2[2] ? 1.0 : 0.3;
  return methodDistance * surpriseProduct * semanticDistance;
  // Range 0-1. Threshold for "golden": > 0.5
  // Add shared_entity_bonus (0.2) during hypothesis generation if shared entities detected
}
```

### The Shuffle as heartbeat

Z-axis rotates every 50 ticks. X (method) and Y (surprise) stay stable. The cube breathes. Each rotation brings papers together that have never been neighbors.

---

## PART 2: OPEN DATA PLATFORM INTEGRATION — 8 Free Sources

### 1. OpenAlex — THE PRIMARY SAMPLER (replaces random S2 sampling)
**What:** Open knowledge graph, 240M+ works, free REST API, CC0 license, no auth.
**Why:** Twice S2 coverage. Has topics, concepts, type, cited_by_count, semantic search, and primary_topic with field/subfield/domain.
**Feeds:** All three axes
**API:** `https://api.openalex.org/works`
**Rate limit:** 100K/day free (polite pool: add `mailto=` param)
**Key endpoints:**
```
GET /works?sample=100&per_page=100  → random sample
GET /works?filter=concepts.id:C86803240,publication_year:2020-2025  → by concept
GET /works?filter=cited_by_count:>50,publication_year:2024-2025  → high-impact recent
GET /works?search.semantic=CRISPR+unexpected+results  → semantic search
```
**Fields:** `id,doi,title,abstract_inverted_index,concepts,primary_topic,type,publication_year,cited_by_count,referenced_works_count,is_retracted`
**Note:** Abstracts come as inverted index — need reconstruction function.

### 2. Crossref + Retraction Watch — SURPRISE SIGNAL BOOSTER
**What:** 63K+ retracted papers with reasons, free API, updated daily.
**Why:** Retracted papers are pure anomaly signals. Feeds Y-axis directly.
**API:** `https://api.crossref.org/v1/works?filter=update-type:retraction`
**Full dataset:** `https://api.labs.crossref.org/data/retractionwatch?your@email.org` (CSV)
**Integration:** Download CSV once, cache locally, cross-reference during classification.

### 3. bioRxiv + medRxiv API — FRESH ANOMALY PIPELINE
**What:** Preprint servers for biology and health sciences. Free API.
**Why:** Preprints are where surprises appear FIRST — before peer review.
**API:** `https://api.biorxiv.org/details/biorxiv/{start_date}/{end_date}`
**Rate limit:** 100 results per page

### 4. arXiv API — CROSS-DISCIPLINE METHOD BRIDGE
**What:** 2.4M+ preprints across physics, math, CS, quantitative biology.
**Why:** Covers computational/mathematical side that bio databases miss.
**API:** `http://export.arxiv.org/api/query?search_query=all:{term}&max_results=100`
**Rate limit:** 1 request per 3 seconds (strict — arXiv blocks aggressive clients)
**Categories:** q-bio.*, stat.*, cs.AI, cs.LG, physics.bio-ph, physics.med-ph

### 5. PubMed / NCBI E-utilities — BIOMEDICAL METHOD DNA
**What:** 36M+ biomedical citations with MeSH terms.
**Why:** MeSH terms are gold standard for method classification.
**API:** `https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esearch.fcgi?db=pubmed&term={query}&retmode=json`
**Rate limit:** 3 req/sec without key, 10/sec with free NCBI API key
**MeSH method mapping:**
```
imaging: "Microscopy", "Magnetic Resonance Imaging", "Tomography", "Spectroscopy"
computational: "Computational Biology", "Computer Simulation", "Machine Learning", "Algorithms"
experimental: "Clinical Trial", "In Vitro Techniques", "Transfection", "Gene Knockout Techniques"
```

### 6. PapersWithCode Dataset (archived) — METHOD-BENCHMARK LINKS
**What:** Archived dataset: 575K papers with linked methods, datasets, benchmarks, code.
**Why:** Direct method-to-paper mapping for X-axis classification.
**Data:** `https://github.com/paperswithcode/paperswithcode-data` (JSON files)
**Integration:** Download once, build local method lookup index.

### 7. ClinicalTrials.gov API — REAL-WORLD VALIDATION BRIDGE
**What:** 500K+ clinical trials with status, interventions, outcomes.
**Why:** Active trials = validation. Terminated trials = anomaly signals.
**API:** `https://clinicaltrials.gov/api/v2/studies?query.term={term}&pageSize=10`
**No auth required.**

### 8. OpenCitations — CITATION GRAPH INTELLIGENCE
**What:** 1.6B+ citation links with REST API.
**Why:** Citation patterns reveal dormant gaps and anomalies.
**API:** `https://opencitations.net/index/api/v2/citations/{doi}`
**Also:** `https://opencitations.net/index/api/v2/references/{doi}`

---

## PART 3: NEW FILES TO CREATE

### `lib/openalex.js` — Primary sampler
```javascript
// The main paper source. Replaces random S2 sampling.
//
// async sampleRandom(count = 2700)
//   - Uses OpenAlex random sample + diverse field sampling
//   - Requests: id, doi, title, abstract_inverted_index, concepts, primary_topic,
//     type, publication_year, cited_by_count, referenced_works_count, is_retracted
//   - Reconstructs abstracts from inverted index format
//
// async sampleByAnomaly(count = 300)
//   - Targets retracted papers, high citation-count recent, overlooked connections
//
// async sampleFreshPreprints(count = 300)
//   - type=preprint, publication_year=current, sorted by date
//
// function reconstructAbstract(invertedIndex)
//   - OpenAlex stores as {"word": [position1, position2]} → reconstruct to text
//
// Caching: data/openalex-cache.json, 6-hour TTL
// Rate limiting: polite pool (mailto param), max 10 req/sec
// Error handling: retry with backoff, circuit breaker (follow bot.js pattern)
```

### `lib/retraction-enricher.js` — Retraction/correction signal layer
```javascript
// Downloads/caches Retraction Watch CSV from Crossref Labs
// Cross-references during classification to boost Surprise Index
//
// async init() — download CSV if not cached or >7 days old, parse to Map<DOI, {reason, date}>
// function isRetracted(doi) → boolean
// function getRetractionReason(doi) → string | null
// function citesRetractedPaper(referencedDois) → { count, retracted_dois }
// function getRetractionsByField(field) → array
//
// Cache: data/retraction-cache.json, 7-day TTL
```

### `lib/preprint-monitor.js` — bioRxiv/medRxiv/arXiv fresh feed
```javascript
// async fetchBioRxiv(startDate, endDate, category = null)
// async fetchMedRxiv(startDate, endDate)
// async fetchArxiv(categories, maxResults = 100)
//   - Parse Atom XML response. Rate limit: 1 req per 3 sec!
//   - Categories: q-bio.*, stat.ML, cs.AI, cs.LG, physics.bio-ph
// async getFreshAnomalies(daysBack = 7)
//   - Combines all sources, filters for anomaly language
//
// Cache: data/preprint-cache.json, 24-hour TTL
```

### `lib/mesh-enricher.js` — PubMed MeSH method classification
```javascript
// async getMeshTerms(pmid) → string[]
// async searchByMesh(meshTerm, maxResults = 50)
// async enrichWithMethodDNA(papers)
//   - Fetch MeSH terms, map to Method DNA cluster (0/1/2)
//   - MeSH tree: E01-E07 (Diagnosis) → 0, L01 (Info Science) → 1, E02-E05 (Therapeutics) → 2
//
// Rate limit: 3 req/sec without key, 10/sec with NCBI_API_KEY in .env
```

### `lib/citation-intelligence.js` — OpenCitations cross-citation analysis
```javascript
// async getCitations(doi) → [{citing_doi, date}]
// async getReferences(doi) → [{cited_doi, date}]
// async findSharedReferences(doi1, doi2) — shared refs = shared knowledge
// async citationVelocity(doi) — spike >3x baseline = anomaly
// async dormantGapDetector(paperSetA, paperSetB)
//   - Cross-citation rate between sets
//   - Rate=0 but shared refs exist = dormant gap (highest value)
//   - Returns { crossCitationRate, sharedRefCount, dormantScore }
//
// Cache: data/citation-cache.json, 30-day TTL
```

### `lib/classifier.js` — Multi-source paper classification
```javascript
// X-AXIS: Method DNA — 4 signal sources with weighted voting:
//   MeSH > PapersWithCode > OpenAlex concepts > keywords
//   Non-biomedical: PwC > OpenAlex > keywords
//
// Y-AXIS: Surprise Index — 5 signal sources:
//   Abstract markers + is_retracted + Retraction Watch + citation velocity + terminated trials
//   Score 0-10 → mapped to 0/1/2
//
// Z-AXIS: Semantic Orbit — OpenAlex topics + TF-IDF/k-means clustering
//
// function classifyMethod(paper) → 0|1|2
// function classifySurprise(paper) → 0|1|2
// function clusterSemantic(papers) → array of 0|1|2
// function classifyAll(papers) → papers with .cell = [x, y, z]
```

### `lib/shuffler.js` — Cube population and rotation
```javascript
const SHUFFLE_INTERVAL = 50; // ticks between Z-axis rotation
const PAPERS_PER_CELL = 100; // target

// async shouldShuffle(tickCount)
// async populateCube(classifiedPapers) → write to data/cube.json
// async shuffle(tickCount) → sample → classify → populate → bump generation
```

### `lib/sampler.js` — Multi-source sampling orchestration
```javascript
// async sampleForCube(totalPapers = 2700) {
//   60% OpenAlex random (1620 papers)
//   15% bioRxiv/medRxiv fresh preprints (405)
//   10% arXiv computational/physics (270)
//   10% OpenAlex targeted anomaly sampling (270)
//   5%  retraction ecosystem (135)
//   Deduplicate by DOI
// }
```

### `data/cube.json` (new data file)
```json
{
  "cells": { "0,0,0": [papers], "0,0,1": [papers] },
  "shuffleGeneration": 0,
  "lastShuffleAt": 0,
  "paperCount": 0,
  "distribution": { "0,0,0": 0 }
}
```

---

## PART 4: MODIFICATIONS TO EXISTING FILES

### `bot.js` — Main loop changes
```javascript
// In tick function, BEFORE agent movement:
// 1. Check shuffler.shouldShuffle(tickCount)
// 2. If yes, run shuffle (async, try/catch + circuit breaker)
//
// On boot: initialize all data sources:
//   openalex → retraction-enricher → preprint-monitor → mesh-enricher → citation-intelligence
//   If any source fails init: log warning, continue (graceful degradation)
//   OpenAlex alone = minimum viable source
//
// When agents collide:
// OLD: { domain1: "Oncology", domain2: "Immunology" }
// NEW: {
//   cell1: { method: "computational", surprise: "anomalous", papers: [...top 5] },
//   cell2: { method: "experimental", surprise: "deviation", papers: [...top 5] }
// }
```

### `lib/researcher.js` — New collision prompt
```
You are examining a collision between two research clusters:

CLUSTER A (cell [x1,y1,z1]):
- Method profile: {computational/imaging/experimental}
- Surprise level: {confirmatory/deviation/anomalous}
- Representative papers:
  1. "{title}" ({year}) — {one-line summary}
  ...

CLUSTER B (cell [x2,y2,z2]):
- Method profile: ...
- Surprise level: ...
- Representative papers: ...

SHARED KNOWLEDGE BASE: Papers in both clusters cite {N} common references: ...
DORMANT GAP SCORE: {score} — {crossCitationRate}% cross-citation rate
ACTIVE TRIALS: {N} clinical trials relate to this intersection: ...

TASK: Identify a cross-domain research gap. Look for:
- Shared entities studied with DIFFERENT methods
- Anomalous results in one cluster explained by findings in the other
- Methodological bridges: technique from A never applied to subject of B

{existing PI-grade format, scoring rubric, red flags, speculation index, etc.}
```

### `dashboard/index.html` — Visual update
- Color by method DNA (X): red=imaging, blue=computational, green=experimental
- Brightness by surprise (Y): dim=confirmatory, medium=deviation, bright=anomalous
- Cell size proportional to paper count
- Hover: top paper titles, paper count per source, MeSH terms, retraction count
- Shuffle animation when Z-axis rotates

### `dashboard/arena.html` — Gap packet enrichment
- Golden Collision score display
- Dormant gap score visualization
- Retraction citations in gap packet
- Clinical trial links
- Source indicators per paper

### `data/state.json` — Add cube metadata
```json
{
  "cubeGeneration": 0,
  "lastShuffleAtTick": 0,
  "shuffleInterval": 50,
  "totalPapersSampled": 0,
  "cellDistribution": {}
}
```

### `ecosystem.config.js` — Environment variables
Add to `.env`:
```
OPENALEX_MAILTO=your@email.com
NCBI_API_KEY=your_key_here          # optional, 10 req/sec instead of 3
CROSSREF_MAILTO=your@email.com
```

---

## PART 5: IMPLEMENTATION ORDER

1. **Phase 1: `lib/openalex.js`** — Primary sampler. Test API, abstract reconstruction, caching. This alone enables 2.0.
2. **Phase 2: `lib/classifier.js`** — Pure functions with keyword matching + OpenAlex concepts. Write unit tests.
3. **Phase 3: `lib/sampler.js`** — Multi-source orchestration, extend existing S2 integration.
4. **Phase 4: `lib/shuffler.js`** — Cube population, cube.json management, rotation logic.
5. **Phase 5: `lib/retraction-enricher.js`** — Retraction Watch CSV, surprise boost integration.
6. **Phase 6: `lib/preprint-monitor.js`** — bioRxiv + arXiv feeds for fresh anomalies.
7. **Phase 7: Modify `bot.js`** — Integrate shuffle into tick loop, update collision context.
8. **Phase 8: Modify `lib/researcher.js`** — New collision prompt format with enriched context.
9. **Phase 9: `lib/mesh-enricher.js`** — PubMed MeSH for precise method DNA (optional, needs NCBI key).
10. **Phase 10: `lib/citation-intelligence.js`** — OpenCitations dormant gap detection + velocity.
11. **Phase 11: ClinicalTrials.gov** — Extend `lib/validator.js` for trial validation.
12. **Phase 12: Dashboard update** — Visual refresh, source indicators, Golden Collision display.
13. **Phase 13: Golden Collision scoring** — Implement formula, log to findings.json, display in arena.html.

---

## PART 6: DEPENDENCIES AND COST

### New npm dependencies
```bash
npm install natural ml-kmeans csv-parse xml2js
```
- `natural` — NLP/TF-IDF for semantic clustering
- `ml-kmeans` — k-means clustering
- `csv-parse` — Retraction Watch CSV parsing
- `xml2js` — arXiv Atom XML parsing

### Cost per shuffle cycle

| Source | Cost | Auth |
|--------|------|------|
| OpenAlex | $0.00 | No (mailto for polite pool) |
| Retraction Watch | $0.00 | No |
| bioRxiv/medRxiv | $0.00 | No |
| arXiv | $0.00 | No |
| PubMed | $0.00 | Optional free key |
| OpenCitations | $0.00 | No |
| ClinicalTrials.gov | $0.00 | No |
| PapersWithCode | $0.00 | Local JSON |
| Claude (classification) | ~$0.30 | Yes (existing) |
| Claude (hypothesis gen) | ~$0.20/collision | Yes (existing) |
| **Total per shuffle** | **~$0.50** | |

---

## PART 7: CONSTRAINTS

- **DO NOT break existing v0.11.1 functionality.** Current pipeline must keep running during migration.
- **ALL file writes atomic** (write to .tmp, then rename) — follow existing bot.js pattern.
- **Respect ALL rate limits.** arXiv: 1 req/3sec. OpenAlex: 10 req/sec polite pool. PubMed: 3 req/sec.
- **Keep Claude API usage minimal** for classification — use keyword matching + API data, not LLM calls. Only Claude for hypothesis generation.
- **Graceful degradation:** if any source fails, system continues with remaining sources. OpenAlex alone = minimum viable.
- **Cache aggressively.** Retraction Watch: 7-day TTL. Citations: 30-day TTL. Papers: 6-hour TTL. Preprints: 24-hour TTL.
- **Log everything.** Every shuffle, classification distribution, Golden Collision score, API call with source/response time/status.
- **Total data dir under 500MB.** Cap caches, rotate old samples.
- **Total added cost per shuffle < $0.50.**
- **VPS has 4GB RAM.** Keep memory usage lean. No heavy in-memory operations.

---

## PART 8: TESTING

Before deploying, verify:
1. `openalex.js` returns papers with reconstructed abstracts
2. `classifier.js` correctly assigns 10 test papers with expected classifications
3. `sampler.js` respects rate limits and returns valid papers from multiple sources
4. `shuffler.js` produces balanced distribution (no cell < 5% of papers)
5. `retraction-enricher.js` loads CSV and finds known retracted DOIs
6. `preprint-monitor.js` fetches bioRxiv papers and parses arXiv XML
7. Collision context format change doesn't break researcher.js output
8. `cube.json` survives PM2 restart
9. System survives loss of any single data source (graceful degradation)
10. Rate limits never exceeded under normal operation
11. Dashboard renders with new color scheme
12. Golden Collision score logged in findings.json

---

## Git

DO NOT push. Wiard handles all git operations. Work in feature branch `v2.0-anomaly-magnet`.
