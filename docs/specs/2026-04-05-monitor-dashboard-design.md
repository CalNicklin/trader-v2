# Monitor Dashboard — Design Spec

**Date:** 2026-04-05
**Purpose:** Local monitoring dashboard for the trader-v2 VPS. Single `bun run monitor` command that shows live server logs, health status, and GitHub Actions deploy status.

## Architecture

```
monitor/
  server.ts          # Bun HTTP + WebSocket server
  src/
    App.tsx           # React SPA root
    components/       # shadcn/ui components
    lib/
      ws.ts           # WebSocket client hook for logs
      api.ts          # fetch helpers for health + deploys
  vite.config.ts
  package.json        # isolated deps (react, vite, shadcn, tailwind)
  tsconfig.json
```

### Server (`monitor/server.ts`)

Single Bun server that handles:

- **`GET /`** — serves the built React SPA
- **`GET /api/health`** — proxies `http://VPS_HOST:3847/health` with Basic auth (ADMIN_PASSWORD)
- **`GET /api/deploys`** — calls GitHub Actions API (`GET /repos/CalNicklin/trader-v2/actions/runs?per_page=5&workflow_id=deploy.yml`) using GITHUB_TOKEN
- **WebSocket `/ws/logs`** — spawns `ssh -t <vps> journalctl -u trader-v2 -f -n 200` as a child process, pipes stdout to connected WebSocket clients

### Config

Reads from project root `.env`:
- `VPS_HOST`, `VPS_USER`, `VPS_SSH_KEY` — SSH connection
- `GITHUB_TOKEN` — GitHub Actions API
- `ADMIN_PASSWORD` — health endpoint auth

### SSH Key Handling

Writes the SSH key from `.env` to a temporary file with `chmod 600`, same approach as `scripts/vps-ssh.sh`. Cleaned up on process exit.

## Layout

### Header Bar (fixed top)

- **Left:** App title + connection status indicator (green dot = SSH connected, red = disconnected)
- **Right:** Two compact cards side by side:
  - **Health card** — status badge (OK/degraded/error), uptime, active strategies count, daily P&L (GBp, color-coded), API spend today. Polls every 30s.
  - **Deploy card** — last deploy: short commit SHA (linked to GitHub), status icon (pass/fail), relative timestamp, duration. Expandable dropdown showing last 5 deploys. Polls every 60s.

### Main Area (fills remaining viewport)

- Full-width log viewer, monospace font
- Auto-scrolls to bottom; "jump to bottom" button appears when scrolled up
- Log line color coding: errors red, warnings amber, info default, timestamps dimmed
- Search/filter input at top of log area

## Data Flow

### Log Streaming
- Server spawns SSH on first WebSocket client connect
- Sends last 200 lines as initial backfill, then streams live
- Auto-reconnect after 3s if SSH drops, with visual indicator
- Client-side circular buffer: 5000 lines max

### Health Polling
- Every 30s via `/api/health`
- Shows "Unreachable" in red if VPS is down
- P&L in GBp with green/red coloring

### Deploy Polling
- Every 60s via `/api/deploys`
- Last 5 workflow runs from `deploy.yml`
- Commit SHA, status, relative time, duration

## Constraints

- **Read-only** — no pause/resume, no restart, no deploy triggers
- **Stateless** — no database, no persistent cache. In-memory only.
- **Local only** — runs on localhost, not exposed to the internet
- **Isolated deps** — `monitor/` has its own `package.json`, doesn't pollute the trading system

## Aesthetic

Dark theme, terminal-inspired but polished. Monospace log area contrasted with clean sans-serif UI chrome. shadcn/ui components with a refined ops console feel. Not a generic dashboard.
