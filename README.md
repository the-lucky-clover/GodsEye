# God's Eye — Spatial Intelligence Simulator

A browser-based OSINT surveillance platform fusing live aircraft, maritime vessel, and satellite data onto a photorealistic 3D globe — backed by a Cloudflare Workers AI agentic intelligence layer.

> "It stops feeling like a demo. It starts feeling magical." — Bilawal Sidhu

## OSINT Data Layers

| Layer | Source | Worker Endpoint | Description |
|-------|--------|-----------------|-------------|
| **3D World** | Google Photorealistic 3D Tiles | — | Volumetric city models |
| **Satellites** | CelesTrak TLE + SGP4 | `/api/tle` | 180+ real satellites in true orbital paths |
| **Aircraft** | OpenSky Network + airplanes.live | `/api/aircraft` | 7,000+ live ADS-B transponder positions |
| **Vessels** | aisstream.io AIS | `/api/shipping` | Global merchant, naval & fishing fleet |
| **Vehicles** | OpenStreetMap (simulated) | — | Traffic flow particle system |
| **CCTV** | Austin TX public cameras | — | Real traffic camera feeds geo-located in 3D |

## AI Agent

Click **⬡ AI AGENT ANALYZE** to dispatch the agentic intelligence coordinator (`/api/agent`).

The agent implements a **ReAct (Reason + Act) loop** powered by [Workers AI](https://developers.cloudflare.com/workers-ai/) (`@cf/meta/llama-3.1-8b-instruct`):

1. Receives current state: all tracked aircraft, vessels, satellites, and viewport
2. Calls tools to gather specific intelligence:
   - `filter_aircraft` — isolate activity by region, altitude, or military status
   - `filter_vessels` — find vessels by ocean region or type
   - `get_satellite_coverage` — identify ISR satellites overhead a coordinate
   - `cross_cue` — detect aircraft/vessel co-location patterns
   - `detect_anomalies` — flag emergency squawks, dark vessels, unusual patterns
3. Synthesizes a 3-sentence tactical intelligence report

Workers AI also runs continuously in edge functions:
- **`/api/aircraft`**: AI enrichment fires when emergency squawk codes (7500/7600/7700) are detected — provides a tactical assessment for each flagged aircraft
- **`/api/shipping`**: AI dark-vessel detection — flags ships that were underway but stopped transmitting AIS

## Vision Modes

- **NORMAL** — standard CesiumJS rendering
- **NVG** — Night Vision Goggles: green phosphor + film grain + tube vignette
- **FLIR** — Forward-Looking Infrared thermal palette + heat scale legend
- **CRT** — CRT monitor: scanlines + flicker + barrel vignette + timestamp burn-in
- **ANIME** — Studio Ghibli cel-shading: high saturation + warm vignette

## Architecture

```
Browser
  │
  ├── Static assets ──────────► Cloudflare Pages (Vite dist/, ~2 MB)
  │
  ├── /api/tle         ────────► Pages Function ──► KV cache ──► D1 ──► CelesTrak
  ├── /api/aircraft    ────────► Pages Function ──► Workers Cache ──► OpenSky / airplanes.live
  │                                                 └─► Workers AI (emergency squawk enrichment)
  ├── /api/shipping    ────────► Pages Function ──► KV cache ──► aisstream.io WebSocket
  │                                                 └─► Workers AI (dark vessel detection)
  ├── /api/agent       ────────► Pages Function ──► Workers AI ReAct loop (tool calling)
  │
  └── Cesium assets   ─────────► Cesium CDN (cesium.com/downloads/cesiumjs)
```

```
src/
├── main.js       — entry point, wires all modules
├── viewer.js     — CesiumJS viewer + Google 3D Tiles init
├── satellites.js — CelesTrak TLE → SGP4 propagation → Cesium entities
├── aircraft.js   — /api/aircraft → live aircraft positions + AI flags
├── shipping.js   — /api/shipping → AIS vessel positions + dark-vessel markers
├── cctv.js       — Austin traffic camera feeds → billboards
├── shaders.js    — Canvas2D post-processing: NVG, FLIR, CRT, Anime
├── hud.js        — DOM controls, layer toggles, agentic AI panel
└── style.css     — Military HUD aesthetic (green-on-black, monospace, glow)

functions/api/
├── tle.js        — TLE proxy: KV → D1 → CelesTrak
├── aircraft.js   — Aircraft proxy: Workers Cache → OpenSky → fallback + AI enrichment
├── shipping.js   — AIS proxy: KV cache → aisstream.io WebSocket + AI dark vessel
├── agent.js      — Agentic AI coordinator (ReAct loop, tool calling)
└── analyze.js    — Simple one-shot AI analysis endpoint
```

## Local Development

```bash
git clone https://github.com/the-lucky-clover/GodsEye.git
cd GodsEye
npm install
cp .env.example .env
# Edit .env with your API keys (see below)
npm run dev
```

Open `http://localhost:3000`

For local Worker testing (requires Cloudflare account):
```bash
npx wrangler pages dev dist --local
```

## API Keys

### Required for full functionality

#### Google Maps — Photorealistic 3D Tiles
1. Go to [console.cloud.google.com](https://console.cloud.google.com/apis/credentials)
2. Create a project → "Create Credentials" → "API Key"
3. Enable **Map Tiles API** in the API Library
4. Restrict the key to your domain (e.g. `*.pages.dev`)
5. Set as `VITE_GOOGLE_MAPS_KEY` in `.env` / CF Pages env vars

Without this key: falls back to NASA Blue Marble imagery — still functional.

#### Cesium Ion — World Terrain (free tier)
1. Sign up (free) at [ion.cesium.com](https://ion.cesium.com/)
2. Go to [ion.cesium.com/tokens](https://ion.cesium.com/tokens) → "Create token"
3. Set as `VITE_CESIUM_TOKEN` in `.env` / CF Pages env vars

### OSINT data sources (Workers secrets)

#### aisstream.io — Live AIS shipping data ⭐ FREE
1. Sign up (free) at [aisstream.io](https://aisstream.io/)
2. Log in → click your avatar → **"API Key"**
3. Copy the key and set as a Worker secret:
   ```bash
   wrangler secret put AISSTREAM_KEY
   ```
Without this key: `/api/shipping` serves demo vessel data (the toggle still works).

#### OpenSky Network — Aircraft (optional, raises rate limit)
1. Register (free) at [opensky-network.org](https://opensky-network.org/index.php?option=com_users&view=registration)
2. Verify your email
3. Set credentials as Worker secrets:
   ```bash
   wrangler secret put OPENSKY_USERNAME
   wrangler secret put OPENSKY_PASSWORD
   ```
Without credentials: anonymous access (1 req / 10 s, shared across all users of the Worker). The Worker caches for 15 s so this is sufficient for most use cases.

### No API key needed
- **CelesTrak** (satellites) — fully public
- **airplanes.live** (aircraft fallback) — fully public
- **Austin CCTV** — fully public  
- **Workers AI** — activated by the `[ai]` binding in `wrangler.toml`, no separate key

## Cloudflare Pages Deployment

### First-time setup

```bash
# 1. Create the Pages project
wrangler pages project create godseye

# 2. Create D1 database and get its ID
wrangler d1 create godseye-db
# → copy the database_id into wrangler.toml [[d1_databases]]

# 3. Apply schema
wrangler d1 execute godseye-db --file schema.sql --remote

# 4. Create KV namespaces
wrangler kv:namespace create TLE_CACHE
wrangler kv:namespace create CONFIG
# → copy the namespace IDs into wrangler.toml [[kv_namespaces]]

# 5. Create R2 bucket (optional — for self-hosted Cesium assets)
wrangler r2 bucket create godseye-assets

# 6. Set runtime secrets
wrangler secret put AISSTREAM_KEY
wrangler secret put OPENSKY_USERNAME   # optional
wrangler secret put OPENSKY_PASSWORD   # optional

# 7. Build and deploy
npm run build
wrangler pages deploy dist --project-name=godseye
```

### GitHub Actions CI (auto-deploy on push to main)

Add these secrets to GitHub → Settings → Secrets and variables → Actions:

| Secret | Where to find |
|--------|--------------|
| `CF_API_TOKEN` | [dash.cloudflare.com/profile/api-tokens](https://dash.cloudflare.com/profile/api-tokens) — use "Edit Cloudflare Pages" template |
| `CF_ACCOUNT_ID` | [dash.cloudflare.com](https://dash.cloudflare.com/) — right sidebar |
| `VITE_GOOGLE_MAPS_KEY` | See above |
| `VITE_CESIUM_TOKEN` | See above |

## Tech Stack

- **[CesiumJS](https://cesium.com/platform/cesiumjs/)** — WebGL globe rendering engine
- **[satellite.js](https://github.com/shashwatak/satellite-js)** — SGP4 orbital mechanics
- **[Vite 7](https://vite.dev)** — build tool + dev server
- **[Cloudflare Pages](https://pages.cloudflare.com/)** — static hosting + Functions (Workers)
- **[Workers AI](https://developers.cloudflare.com/workers-ai/)** — `@cf/meta/llama-3.1-8b-instruct` for agentic OSINT
- **[aisstream.io](https://aisstream.io/)** — free AIS shipping data WebSocket API
- **[OpenSky Network](https://opensky-network.org/)** — community ADS-B aircraft network

## Inspiration

Built as an extension of [WorldView](https://www.spatialintelligence.ai/p/i-built-a-spy-satellite-simulator) by Bilawal Sidhu (ex-Google Maps PM), demonstrating that military-grade surveillance aesthetics — now with AI-powered intelligence analysis — can be assembled entirely from public data streams.

> The data was never the moat. The accessibility is.

## What It Does

God's Eye fuses multiple live public data streams onto a photorealistic 3D globe:

| Layer | Source | Description |
|-------|--------|-------------|
| **3D World** | Google Photorealistic 3D Tiles | Volumetric city models from aerial photogrammetry |
| **Satellites** | CelesTrak TLE + SGP4 | 180+ real satellites tracked in true orbital paths |
| **Aircraft** | OpenSky Network | 7,000+ live ADS-B transponder positions |
| **Vehicles** | OpenStreetMap (simulated) | Traffic flow particle system on street grid |
| **CCTV** | Austin TX public cameras | Real traffic camera feeds geo-located in 3D |

## Vision Modes

Switch between intelligence analyst display modes:

- **NORMAL** — standard CesiumJS rendering
- **NVG** — Night Vision Goggles: green phosphor + film grain + tube vignette
- **FLIR** — Forward-Looking Infrared thermal palette + heat scale legend
- **CRT** — CRT monitor: scanlines + flicker + barrel vignette + timestamp burn-in
- **ANIME** — Studio Ghibli cel-shading: high saturation + warm vignette

## God Mode

Activates **PANOPTIC MODE** — all entities become highlighted with targeting overlays, labels appear on every satellite and aircraft, and a red detection border frames the scene.

## Architecture

```
src/
├── main.js       — entry point, wires all modules
├── viewer.js     — CesiumJS viewer + Google 3D Tiles initialization
├── satellites.js — CelesTrak TLE fetch → SGP4 propagation → Cesium entities
├── aircraft.js   — OpenSky Network REST API → live aircraft positions
├── cctv.js       — Austin traffic camera feeds → billboards + plane projections
├── shaders.js    — Canvas2D post-processing: NVG, FLIR, CRT, Anime
├── hud.js        — DOM controls: vision modes, layer toggles, info panel, stats
└── style.css     — Military HUD aesthetic (green-on-black, monospace, glow)
```

## Setup

```bash
git clone https://github.com/noaRoblesLevy/GodsEye.git
cd GodsEye
npm install
cp .env.example .env
# Edit .env with your API keys (see below)
npm run dev
```

Open `http://localhost:3000`

## API Keys

### Google Maps (Photorealistic 3D Tiles) — optional but recommended
1. Go to [Google Cloud Console](https://console.cloud.google.com/)
2. Enable **Map Tiles API**
3. Create an API key → paste into `VITE_GOOGLE_MAPS_KEY`

Without this key the app falls back to NASA Blue Marble imagery — still fully functional.

### Cesium Ion (World Terrain) — free tier
1. Sign up at [ion.cesium.com](https://ion.cesium.com/)
2. Copy your default access token → paste into `VITE_CESIUM_TOKEN`

### OpenSky Network — no key needed
Anonymous access provides ~10 second refresh rate. [Register](https://opensky-network.org/) for higher rate limits.

## Data Sources

- **CelesTrak** — `celestrak.org/pub/TLE/active.tle` — public domain orbital data
- **OpenSky Network** — `opensky-network.org/api/states/all` — community ADS-B network
- **Austin Traffic Cameras** — `cctv.austinmobility.io` — City of Austin open data
- **Google Photorealistic 3D Tiles** — [Tile Map Service API](https://developers.google.com/maps/documentation/tile)

## Tech Stack

- **[CesiumJS](https://cesium.com/platform/cesiumjs/)** — WebGL globe rendering engine
- **[satellite.js](https://github.com/shashwatak/satellite-js)** — SGP4 orbital mechanics
- **[Vite](https://vite.dev)** — build tool + dev server
- **[vite-plugin-cesium](https://github.com/nshen/vite-plugin-cesium)** — handles Cesium's static asset bundling

## Inspiration

Built as a faithful recreation of [WorldView](https://www.spatialintelligence.ai/p/i-built-a-spy-satellite-simulator) by Bilawal Sidhu (ex-Google Maps PM), demonstrating that military-grade surveillance aesthetics can be assembled entirely from public data streams.

The key insight: **the data was never the moat. The accessibility is.**
