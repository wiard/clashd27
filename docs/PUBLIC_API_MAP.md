# CLASHD27 Public API Map

## Purpose

This document separates CLASHD27 APIs into:

- public research APIs
- public site summary APIs
- internal or sandbox-only APIs

The goal is to keep `clashd27.com` educational and research-focused while preserving the rule that governance lives in `openclashd-v2`.

## Public Research APIs

Defined in or evidenced by [dashboard/server.js](/Users/wiardvasen/clashd27/dashboard/server.js) and the repository README.

### Cube State And Navigation

- `GET /api/state`
- `GET /api/pack`
- `GET /api/packs`
- `GET /api/cell/:id`

Use for:

- cube explorer
- pack selection
- cell detail
- current agent/cell occupancy

### Discovery And Findings

- `GET /api/discoveries`
- `GET /api/discoveries/high-novelty`
- `GET /api/discoveries/stats`
- `GET /api/discoveries/agent/:name`

Use for:

- discovery feed
- novelty ranking
- finding statistics
- agent-linked discoveries

### Agent Research APIs

- `GET /api/agent/:name`
- `GET /api/agent/:name/history`
- `GET /api/agent/:name/insights`
- `GET /api/agent/:name/findings`
- `GET /api/agent/:name/keywords`

Use for:

- agent profiles
- agent histories
- keyword surfaces
- finding attribution

### Research Feed APIs

- `GET /api/research/today`
- `GET /api/insights`
- `GET /api/insights/:cell`

Use for:

- research paper/activity pages
- daily briefings
- cell-specific research activity

### Semantic Cube Physics APIs

- `GET /api/clashd27/state`
- `GET /api/clashd27/emergence`
- `GET /api/clashd27/gravity`
- `GET /api/clashd27/topology`
- `GET /api/clashd27/sources`
- `GET /api/clashd27/routes/:cellId`

Use for:

- cube physics
- emergence pages
- gravity pages
- route visualizations
- source scoring

## Public Site Summary APIs

Defined in [public-site/server.js](/Users/wiardvasen/clashd27/public-site/server.js).

- `GET /api/public/summary`
- `GET /api/public/latest`
- `GET /api/public/featured`
- `GET /api/public/leaderboard`
- `GET /api/gaps`
- `GET /api/gaps/:id`
- `GET /api/stats`

Use for:

- home page summaries
- featured gap
- latest public gap stream
- public leaderboard
- public gap detail pages

## Internal Or Sandbox-Only APIs

These must not define the public identity of `clashd27.com`.

### Sandbox Governance APIs

Available only in sandbox mode according to the repo README and [dashboard/server.js](/Users/wiardvasen/clashd27/dashboard/server.js):

- `POST /api/agents/propose`
- `GET /api/agents/proposals`
- `GET /api/agents/proposals/ranked`
- `GET /api/agents/proposals/decided`
- `GET /api/agents/proposals/:id`
- `POST /api/agents/proposals/:id/decide`

Rule:

- these are for standalone development and demos
- they are not the canonical governance path
- in production, governance routes to `openclashd-v2`

### Pack Mutation

- `POST /api/pack/load`

Rule:

- operational or development control
- not a public educational endpoint

## Recommended Public Classification

### Public Read-Only

- all `GET` research and summary APIs listed above

### Operator / Internal

- pack mutation
- any future non-read-only research controls

### Sandbox Only

- all `/api/agents/proposals*` and `/api/agents/propose` routes in CLASHD27

## Ecosystem Boundary

CLASHD27 public APIs may:

- show discovery
- show research activity
- show cube physics
- publish findings

CLASHD27 public APIs may not become:

- approval APIs
- kernel execution APIs
- trust-root financial APIs

Those remain in:

- Jeeves for operator approval UX
- `openclashd-v2` for governance and execution
- `safeclash` for trust and transaction evidence
