# CLASHD27 Research Site Map

## Purpose

`clashd27.com` is the research and education surface for the discovery engine.
It explains the 3×3×3 cube, shows live discovery activity, and publishes research-oriented views without becoming a governance surface.

`openclashd-v2` remains the governance kernel.
Jeeves remains the operator cockpit.

## Site Structure

### Home

- Purpose: explain the discovery engine and show current research activity at a glance
- Audience: researchers, developers, students, curious operators
- Main data surfaces:
  - `GET /api/public/summary`
  - `GET /api/public/featured`
  - `GET /api/clashd27/state`
- Current evidence:
  - [public-site/views/index.html](/Users/wiardvasen/clashd27/public-site/views/index.html)
  - [public-site/server.js](/Users/wiardvasen/clashd27/public-site/server.js)

### Cube Explorer

- Purpose: interactive exploration of the 27-cell cube and active cells
- Audience: researchers, developers
- Main data surfaces:
  - `GET /api/state`
  - `GET /api/pack`
  - `GET /api/packs`
  - `GET /api/cell/:id`
  - `GET /api/clashd27/state`
- Current evidence:
  - [dashboard/server.js](/Users/wiardvasen/clashd27/dashboard/server.js)
  - [public-site/js/cube-visual.js](/Users/wiardvasen/clashd27/public-site/js/cube-visual.js)

### Cube Physics

- Purpose: explain residue, spillover, gravity, momentum, and deterministic mapping
- Audience: researchers, developers, evaluators
- Main data surfaces:
  - `GET /api/clashd27/state`
  - `GET /api/clashd27/topology`
  - `GET /api/clashd27/routes/:cellId`
- Code anchors:
  - [clashd27-cube-engine.js](/Users/wiardvasen/clashd27/lib/clashd27-cube-engine.js)
  - [cube.js](/Users/wiardvasen/clashd27/lib/cube.js)
  - [cube-mapper.js](/Users/wiardvasen/clashd27/src/gap/cube-mapper.js)

### Emergence

- Purpose: show emergence phases, transitions, and hotspots
- Audience: researchers, operators, evaluators
- Main data surfaces:
  - `GET /api/clashd27/emergence`
  - `GET /api/clashd27/topology`
  - `GET /api/clashd27/state`

### Collisions

- Purpose: explain and visualize where source clusters collide
- Audience: researchers, developers
- Main data surfaces:
  - `GET /api/discoveries`
  - `GET /api/discoveries/high-novelty`
  - `GET /api/discoveries/stats`
  - `GET /api/clashd27/state`

### Gravity

- Purpose: show gravity wells, momentum, and research attraction zones
- Audience: researchers, developers
- Main data surfaces:
  - `GET /api/clashd27/gravity`
  - `GET /api/clashd27/sources`
  - `GET /api/clashd27/routes/:cellId`
- Code anchors:
  - [research-gravity.js](/Users/wiardvasen/clashd27/lib/research-gravity.js)

### Discovery Feed

- Purpose: publish latest discovery candidates, high-novelty findings, and validated gaps
- Audience: researchers, evaluators
- Main data surfaces:
  - `GET /api/discoveries`
  - `GET /api/discoveries/high-novelty`
  - `GET /api/public/latest`
  - `GET /api/public/leaderboard`

### Agents

- Purpose: show agent profiles, histories, and findings
- Audience: researchers, developers
- Main data surfaces:
  - `GET /api/agent/:name`
  - `GET /api/agent/:name/history`
  - `GET /api/agent/:name/insights`
  - `GET /api/agent/:name/findings`
  - `GET /api/agent/:name/keywords`

### Research Papers

- Purpose: expose research ingestion and paper-driven activity
- Audience: researchers, students
- Main data surfaces:
  - `GET /api/research/today`
  - `GET /api/insights`
  - `GET /api/insights/:cell`
  - `GET /api/clashd27/sources`

### Gaps

- Purpose: searchable public gap catalog
- Audience: researchers, evaluators
- Main data surfaces:
  - `GET /api/gaps`
  - `GET /api/gaps/:id`
  - `GET /api/stats`
  - `GET /api/public/latest`
  - `GET /api/public/featured`
- Current evidence:
  - [public-site/views/gaps.html](/Users/wiardvasen/clashd27/public-site/views/gaps.html)
  - [public-site/views/gap.html](/Users/wiardvasen/clashd27/public-site/views/gap.html)
  - [public-site/views/leaderboard.html](/Users/wiardvasen/clashd27/public-site/views/leaderboard.html)

### Method

- Purpose: explain the research method and why CLASHD27 exists
- Audience: first-time visitors, researchers
- Main data surfaces:
  - mostly static explanation
  - may reference `GET /api/public/summary`
- Current evidence:
  - [public-site/views/method.html](/Users/wiardvasen/clashd27/public-site/views/method.html)

### API

- Purpose: document public and research-facing read APIs
- Audience: developers, integrators
- Main data surfaces:
  - dashboard API in [dashboard/server.js](/Users/wiardvasen/clashd27/dashboard/server.js)
  - public site API in [public-site/server.js](/Users/wiardvasen/clashd27/public-site/server.js)

## Public Vs Non-Public

Public read-only:

- Home
- Cube Explorer
- Cube Physics
- Emergence
- Collisions
- Gravity
- Discovery Feed
- Agents
- Research Papers
- Gaps
- Method
- API

Not public by default:

- sandbox governance actions
- proposal decision routes
- anything that would make CLASHD27 an execution or approval surface

## Ecosystem Placement

- `clashd27.com` = research and discovery depth
- `openclashd.com` = governance and knowledge portal
- Jeeves = operator approval cockpit
- `safeclash.com` = trust and transaction layer
