# CLASHD27.com — Site Plan

## Purpose

clashd27.com is the educational and research surface for the 3x3x3 semantic cube discovery engine. It explains the cube algorithm, visualizes discovery physics, and shares research findings.

It is not a governance surface. It does not approve or deny. It discovers and explains.

**Audience:** Researchers, developers, students, curious readers.

---

## Page Structure

### / — Homepage

**Purpose:** Interactive cube overview, current discovery activity, featured gap of the day, entry points to physics and research sections.

**Data sources:**
- `dashboard/server.js` → `GET /api/clashd27/state` (heatmap, top cells, gravity, momentum, topology)
- `public-site/server.js` → `GET /api/public/summary`, `GET /api/public/featured`

### /cube — Interactive Cube Explorer

**Purpose:** 3D visualization of the 27-cell semantic cube. Layer navigation (Floor/Current/Emerging), cell detail, real-time score updates.

**Engine source:**
- `lib/clashd27-cube-engine.js` (1200+ lines)
- `lib/cube.js` (199 lines — 3D geometry, `cell = z*9 + y*3 + x`)

**Cell structure:** Each of 27 cells tracks:
- `score` (composite residue, 0-1)
- `directScore`, `spilloverScore`, `evidenceScore` (components)
- `events` (signal count), `uniqueSources`, `uniqueSourceTypes`
- `formulaResidue` (interactive_count x peer_diversity x time_spread x entropySeed)
- `momentum` (velocity), `gravityMass` (score x (1 + |momentum|))

**Three layers:**
- Layer 0 (cells 0-8): THE FLOOR — historical data
- Layer 1 (cells 9-17): NO HATS ALLOWED — current analysis
- Layer 2 (cells 18-26): MOD 27 ZONE — emerging hypotheses

**Three axes:**
- WHAT (x): trust-model, surface, architecture
- WHERE (y): internal, external, engine
- TIME (z): historical, current, emerging

**Current API:** `GET /api/clashd27/state`

### /physics — Cube Physics Explained

**Purpose:** Full explanation of residue, decay, gravity, spillover, and momentum mechanics.

**Content derived from `lib/clashd27-cube-engine.js`:**

**Decay:** `factor = 0.995^dt` applied per tick. Direct and evidence scores decay at 0.995, spillover at 0.99 (faster decay).

**Gravity:** High-score cells pull from lower-score face neighbors (Manhattan distance = 1). `pull = (cellA.score - cellB.score) x 0.02`. Applied to directScore only.

**Spillover:** On signal ingestion, fraction spills to face neighbors. `spillAmount = scoreDelta x 0.08`. Excluded from collision detection.

**Momentum:** `velocity = currentScore - previousScore`. Stored as 54-tick history. `gravityMass = score x (1 + |momentum|)`.

**Signal ingestion scoring:**
- Base score: 0.3
- Source weight: paper-theory 1.5, github 1.2, skill 1.0, internal 0.7
- Evidence weight: `1.0 + log2(citationCount) x 0.1 + (corroboratedSources-1) x 0.1`
- Bonuses: +0.1 source change, +0.1 time-far-apart, +0.2 gap signal

### /collisions — Collision Detection

**Purpose:** How near-field and far-field collisions work, emergence scoring, threshold mechanics.

**Source:** `lib/discovery-candidates.js`, `lib/clashd27-cube-engine.js`

**Near-field (Manhattan ≤ 1):**
- Requires: ≥ 2 sources, combined score > 0.7, ≥ 3 ticks
- Emergence: `0.5 x density + 0.3 x sourceFactor + 0.2 x tickFactor`
- Threshold: > 0.72

**Far-field (Manhattan 2-3):**
- Requires: ≥ 3 sources, ≥ 2 source types, combined score > 1.2
- Emergence: `0.4 x density + 0.25 x sourceFactor + 0.15 x tickFactor + 0.2 x noveltyBonus`
- Cross-domain novelty bonus scaled by axis differences

### /emergence — Emergence & Phase Detection

**Purpose:** How the cube detects emergence patterns, phase transitions, topology classification.

**Source:** `lib/clashd27-cube-engine.js` (computeTopology)

**Topology metrics:**
- Total score, active cells (> 0.05), entropy (Shannon)
- Concentration: `1 - normalizedEntropy`
- Phase classification:
  - `dormant`: no active cells
  - `focused`: concentration > 0.7
  - `clustered`: concentration 0.4-0.7
  - `transitional`: concentration 0.2-0.4
  - `diffuse`: entropy > 0.8

**Phase history:** Last 108 entries (4 full cycles). Transition detection with from/to/duration.

**Gradient detection:** Monotonic score-increasing paths (3+ cells, min slope 0.05).
**Corridor detection:** Sustained strength paths through connected clusters.

**Current API:** `GET /api/clashd27/emergence`, `GET /api/clashd27/topology`

### /gravity — Research Gravity Map

**Purpose:** Gravity band visualization, hotspot priority, attention allocation.

**Source:** `lib/research-gravity.js`

**Gravity bands:**
- Red: gravityScore ≥ 6 (hot hotspot)
- Yellow: 3-6 (medium attention)
- Green: 0-3 (emerging)
- Blue: 0 (dormant)

**Contributors:**
- Collision weight x 2.0
- Cluster weight x 1.5
- Gradient weight x 1.2 (endpoints), 0.3 (mid-path)
- Corridor weight x 0.8
- Residue pressure: `score x (1 + peerDiversity/4) x (1 + timeSpread/8 x 0.5)`

**Current API:** `GET /api/clashd27/gravity`

### /discoveries — Discovery Feed

**Purpose:** Latest discoveries with evidence chains, verification status, novelty scores.

**Source:** `dashboard/server.js`

**Discovery ranking (V2):**
```
0.35 x emergenceScore
+ 0.25 x gravityScore
+ 0.20 x domainDistance
+ 0.10 x evidenceDensity
+ 0.10 x sourceConfidence
```

**Three strategies:**
1. Collision pairs — high-emergence collisions
2. Cluster peaks — strongest cell in emergence cluster
3. Gradient ascents — endpoints of score-increasing paths

**Current APIs:** `GET /api/discoveries`, `GET /api/discoveries/high-novelty`, `GET /api/discoveries/stats`

### /agents — Tick Engine Agents

**Purpose:** 27 agents in the tick engine. Energy, bonds, death/revive mechanics.

**Source:** `lib/tick-engine.js` (25K+ lines), `lib/state.js`

**Tick mechanics:**
- One tick = one active cell (0-26 cycling)
- Resonance: agents at active cell get +15% energy
- Clash: neighbor agents get +12% (face), +8% (edge), +5% (corner)
- Idle drain: -2% energy per tick
- Bonds: 2+ agents at same cell → form bond (+5%, cross-layer +8%)
- Death at energy ≤ 0, revive at 50% if conditions met

**Current API:** `GET /api/state`, `GET /api/agent/:name`

### /gaps — Public Gap Index

**Purpose:** Searchable gap index with domain, method, surprise, source filters.

**Source:** `public-site/server.js`

**Current APIs:**
- `GET /api/gaps` (searchable, filterable)
- `GET /api/gaps/:id` (full gap detail)
- `GET /api/stats` (aggregated statistics)
- `GET /api/public/latest` (paginated latest)
- `GET /api/public/leaderboard` (top repos by gap density)

### /papers — Paper Discovery Feed

**Purpose:** Paper ingestion feed, source scoring, emergence linkage.

**Source:** `lib/source-scorer.js`, `dashboard/server.js`

**Source weights:** paper-theory 1.5, github 1.2, skill 1.0, internal 0.7

**Current API:** `GET /api/clashd27/sources`, `GET /api/clashd27/discovery-feed`

### /method — Research Method

**Purpose:** Explain Don Swanson's literature-based discovery approach and how the system automates it.

**Content:** Static educational content explaining:
- Cross-domain connection detection
- Why the 3x3x3 structure forces dimensional collision
- How residue accumulation reveals hidden relationships
- The role of adversarial verification (GPT-4o via `lib/verifier.js`)
- Pre-experiment validation (NIH funding, feasibility via `lib/validator.js`)

### /api — Public API Documentation

**Purpose:** Document the public read-only endpoints.

**Dashboard endpoints (port 3027):** 40+ endpoints including:
- `/api/clashd27/state`, `/api/clashd27/emergence`, `/api/clashd27/gravity`, `/api/clashd27/topology`
- `/api/clashd27/sources`, `/api/clashd27/routes/:cellId`, `/api/clashd27/discovery-feed`
- `/api/discoveries`, `/api/findings`, `/api/deep-dives`, `/api/verifications`, `/api/validations`
- `/api/state`, `/api/cell/:id`, `/api/agent/:name`, `/api/metrics`

**Public site endpoints (port 3028):** 7 read-only endpoints:
- `/api/public/summary`, `/api/public/latest`, `/api/public/featured`
- `/api/public/leaderboard`, `/api/gaps`, `/api/gaps/:id`, `/api/stats`

---

## Relationship to openclashd-v2

clashd27 publishes discoveries to openclashd-v2 via `lib/v2-knowledge-publisher.js`:
- Extension proposals when discovery scores exceed thresholds (0.72 default)
- Payload includes recommended action kinds: governance_review, deep_investigation, evidence_synthesis, standard_review
- Destination: `POST {OPENCLASHD_V2_URL}/api/agents/propose`
- Deduplication key: `extension:{candidateId}`

Signal-to-cell mapping parity enforced by `lib/mapping-parity.js`:
- Text + source + timestamp → resolved axes → cellIndex (0-26)
- Tests: `scripts/test-parity-with-openclashd-v2.js`
- Must match openclashd-v2's `src/knowledge/types.ts` (CubeAxes: wat/waar/wanneer)

Governance modes:
- Sandbox (`GOVERNANCE_MODE=sandbox`): local proposals in `lib/governance-kernel.js`
- Production (`GOVERNANCE_MODE=production`): route to openclashd-v2, local endpoints return 403

---

## Relationship to Jeeves

Jeeves currently shows full radar visualization (`CLASHD27RadarView.swift`) and cube detail (`CubeCellDetailView.swift`, `ClusterDetailView.swift`). This should be replaced with:
- A summary card in Pulse: "Radar: 12 collisions, 3 emergence events"
- A deep-link: "Explore on clashd27.com"

Jeeves should NOT carry:
- 3D cube visualization
- Cell-level residue exploration
- Physics explanation
- Discovery feed browsing
- Agent simulation viewing

These belong on clashd27.com.
