# Wholesale agent system

Agents that research and build wholesale real estate lists. Research only:
nothing here sends mail, texts or email.

## Agent HQ
`agent-hq/index.html` is the dashboard, published at
https://claude.ai/artifact/QepbSE6iPZJiB37kgPEa1y. It has two tabs:

- **Agents** lists the agents that exist (today only El Paso Lead Scout), their
  guardrails, and the daily run time. You can change the time there.
- **Lists** shows the scored lead table, with filters, a "New today" badge, the
  last-run note and Refresh, and an expandable lead sheet with comps.

The page reads `data/el-paso-leads.json` and `data/agents.json`, which are
published from `data/lists/el-paso-leads.json` and `data/agents.json` here. The
run-time setting lives in the page's own database (`settings/el-paso-lead-scout`).

## El Paso Lead Scout
- Runbook: `agents/el-paso-lead-scout/RUN.md`
- Script: `scripts/lead_scout.py` (`candidates`, `comps`, `contacts`, `merge`, `recheck`)
- City limits: `data/geo/el-paso-city-limits.geojson` (Census TIGER place 4824000)
  and the simplified search polygon `data/geo/search-polygon.json`
- Runs daily through Routine `trig_016j9EgDtisSuYa6CsXYcw3R`, with an approved
  budget of 260 DealMachine credits per run.
