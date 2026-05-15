/**
 * /api/shipping — AIS vessel position proxy with KV caching and Workers AI
 *                 dark-vessel detection.
 *
 * Primary source: aisstream.io (free tier, requires API key)
 *   Sign up at https://aisstream.io/ → "API Key" section of your dashboard
 *   Set the secret: wrangler secret put AISSTREAM_KEY
 *
 * The Worker connects to the aisstream.io WebSocket, collects position
 * reports for up to MAX_COLLECT_MS ms or MAX_VESSELS vessels, then closes
 * and caches the result.  The stale-while-revalidate pattern means the
 * browser client never blocks on the WebSocket handshake after the first
 * load.
 *
 * Workers AI enrichment: when dark vessels are detected (ships that
 * recently disappeared from AIS but were last seen in a known area), the AI
 * produces a brief tactical note for each.  This fires only when KV holds a
 * previous snapshot to compare against, so the first fetch is always fast.
 *
 * Bindings (wrangler.toml):
 *   TLE_CACHE       — reuse same KV namespace for shipping key
 *   AI              — Workers AI
 *   AISSTREAM_KEY   — secret (wrangler secret put AISSTREAM_KEY)
 */

const AISSTREAM_WS    = 'wss://stream.aisstream.io/v0/stream'
const KV_SHIP_KEY     = 'shipping_data'
const KV_PREV_KEY     = 'shipping_data_prev'
const CACHE_TTL       = 120   // 2 minutes — ships move slowly
const MAX_COLLECT_MS  = 5000  // how long to hold the WebSocket open
const MAX_VESSELS     = 800   // collect up to this many unique MMSI positions

// ── Demo data — used when no API key is configured ───────────────────────────
// Positions are real ocean shipping lanes; names are plausible vessel types.
const DEMO_VESSELS = [
  { mmsi: '636015803', name: 'ATLANTIC CONVEYOR', callsign: 'A8GX3', lon: -30.1, lat: 48.3, speedKts: 18.2, heading: 285, altM: 0, type: 70, typeDesc: 'Cargo', flag: 'LR', lengthM: 294 },
  { mmsi: '538006318', name: 'EVER GIVEN',        callsign: 'V7A2591', lon: 32.5, lat: 30.1, speedKts: 12.4, heading: 150, altM: 0, type: 71, typeDesc: 'Container', flag: 'MH', lengthM: 400 },
  { mmsi: '477307900', name: 'COSCO SHIPPING',    callsign: 'VROZ5',  lon: 110.2, lat: 22.8, speedKts: 14.1, heading: 72,  altM: 0, type: 71, typeDesc: 'Container', flag: 'HK', lengthM: 365 },
  { mmsi: '209172000', name: 'MAERSK EINDHOVEN',  callsign: '5BFN3',  lon: -5.3,  lat: 36.1, speedKts: 16.8, heading: 210, altM: 0, type: 71, typeDesc: 'Container', flag: 'CY', lengthM: 347 },
  { mmsi: '311000232', name: 'OLYMPIC GLORY',     callsign: 'C6SB7',  lon: -76.3, lat: 24.5, speedKts: 10.2, heading: 180, altM: 0, type: 80, typeDesc: 'Tanker',    flag: 'BS', lengthM: 243 },
  { mmsi: '219017371', name: 'MAERSK DENVER',     callsign: 'OUMH2',  lon: -62.1, lat: 10.8, speedKts: 13.5, heading: 320, altM: 0, type: 71, typeDesc: 'Container', flag: 'DK', lengthM: 299 },
  { mmsi: '352003042', name: 'NORDIC HAWK',       callsign: '3FBX6',  lon: -87.4, lat: 28.7, speedKts:  8.3, heading: 355, altM: 0, type: 82, typeDesc: 'Tanker',    flag: 'PA', lengthM: 183 },
  { mmsi: '566901000', name: 'PIL MALAYSIA',      callsign: '9V9780', lon: 103.8, lat:  1.3, speedKts: 11.6, heading: 95,  altM: 0, type: 71, typeDesc: 'Container', flag: 'SG', lengthM: 286 },
  { mmsi: '248369000', name: 'BOSPORUS BRIDGE',   callsign: '9HA4027',lon: 28.9,  lat: 41.0, speedKts:  6.1, heading: 5,   altM: 0, type: 80, typeDesc: 'Tanker',    flag: 'MT', lengthM: 247 },
  { mmsi: '303503000', name: 'ALASKA ENDEAVOR',   callsign: 'WDB3849', lon:-152.4, lat: 57.9, speedKts: 13.1, heading: 220, altM: 0, type: 70, typeDesc: 'Cargo',    flag: 'US', lengthM: 175 },
  { mmsi: '413123456', name: 'HAI YANG 1',        callsign: 'BSJA',   lon: 122.4, lat: 31.2, speedKts:  4.0, heading: 10,  altM: 0, type: 90, typeDesc: 'Other',     flag: 'CN', lengthM: 108 },
  { mmsi: '636091874', name: 'STELLAR BANNER',    callsign: 'A8TZ2',  lon: -35.8, lat: -5.2, speedKts: 12.7, heading: 175, altM: 0, type: 70, typeDesc: 'Cargo',    flag: 'LR', lengthM: 291 },
]

// ── AIS message parser ────────────────────────────────────────────────────────

function parseAISMessage(msg) {
  const meta = msg.MetaData || {}
  const pos  = (
    msg.Message?.PositionReport ||
    msg.Message?.StandardClassBPositionReport ||
    msg.Message?.ExtendedClassBPositionReport ||
    {}
  )
  const ship = msg.Message?.ShipStaticData || {}

  const lon = pos.Longitude ?? meta.Longitude
  const lat = pos.Latitude  ?? meta.Latitude
  if (lon == null || lat == null) return null
  if (Math.abs(lon) > 180 || Math.abs(lat) > 90) return null

  return {
    mmsi:      String(meta.MMSI || pos.UserID || ''),
    name:      (meta.ShipName || ship.Name || '').trim(),
    callsign:  (ship.CallSign || '').trim(),
    lon,
    lat,
    altM:      0,
    speedKts:  (pos.SpeedOverGround || 0),
    heading:   pos.TrueHeading ?? pos.CourseOverGround ?? 0,
    type:      ship.Type ?? 0,
    typeDesc:  shipTypeLabel(ship.Type ?? 0),
    flag:      ship.Flag || '',
    lengthM:   ship.Dimension?.A != null ? (ship.Dimension.A + ship.Dimension.B) : 0,
    navStatus: pos.NavigationalStatus ?? 0,
  }
}

function shipTypeLabel(t) {
  if (t >= 20 && t < 30) return 'WIG'
  if (t >= 30 && t < 40) return 'Fishing'
  if (t >= 40 && t < 50) return 'Tug/Pilot'
  if (t >= 60 && t < 70) return 'Passenger'
  if (t >= 70 && t < 80) return 'Cargo'
  if (t >= 80 && t < 90) return 'Tanker'
  if (t === 35)           return 'Military'
  if (t >= 90)            return 'Other'
  return 'Unknown'
}

// ── WebSocket collector ───────────────────────────────────────────────────────

async function collectFromAISStream(apiKey) {
  return new Promise((resolve) => {
    const vessels = new Map()  // mmsi → vessel object
    let settled   = false

    const done = () => {
      if (settled) return
      settled = true
      try { ws.close() } catch { /* ignore */ }
      resolve([...vessels.values()])
    }

    const timeout = setTimeout(done, MAX_COLLECT_MS)

    const ws = new WebSocket(AISSTREAM_WS)

    ws.addEventListener('open', () => {
      ws.send(JSON.stringify({
        APIKey:       apiKey,
        BoundingBoxes: [[[-90, -180], [90, 180]]],  // global coverage
        FiltersShipMMSI: [],
        FilterMessageTypes: ['PositionReport', 'StandardClassBPositionReport'],
      }))
    })

    ws.addEventListener('message', (evt) => {
      try {
        const vessel = parseAISMessage(JSON.parse(evt.data))
        if (vessel && vessel.mmsi) {
          vessels.set(vessel.mmsi, vessel)
          if (vessels.size >= MAX_VESSELS) {
            clearTimeout(timeout)
            done()
          }
        }
      } catch (e) {
        console.debug('[Shipping] Skipping malformed AIS message:', e.message)
      }
    })

    ws.addEventListener('error', () => {
      clearTimeout(timeout)
      done()
    })

    ws.addEventListener('close', () => {
      clearTimeout(timeout)
      done()
    })
  })
}

// ── Dark vessel detection (Workers AI) ───────────────────────────────────────

async function detectDarkVessels(currentVessels, prevVessels, ai) {
  if (!ai || !prevVessels || prevVessels.length === 0) return []

  const currentMMSIs = new Set(currentVessels.map(v => v.mmsi))
  const disappeared  = prevVessels.filter(v =>
    !currentMMSIs.has(v.mmsi) &&
    v.speedKts > 3 &&  // was underway, not at anchor
    (v.type >= 70 || v.type === 35)  // cargo, tanker, or military
  ).slice(0, 10)  // limit to avoid burning too many AI neurons

  if (disappeared.length === 0) return []

  try {
    const result = await ai.run('@cf/meta/llama-3.1-8b-instruct', {
      messages: [
        {
          role: 'system',
          content: 'You are a maritime intelligence analyst. Respond only with valid JSON.',
        },
        {
          role: 'user',
          content:
            'These vessels were transmitting AIS and have now gone dark (stopped broadcasting). ' +
            'For each, provide a 10-word tactical assessment. ' +
            'Input: ' + JSON.stringify(
              disappeared.map(v => ({ mmsi: v.mmsi, name: v.name, type: v.typeDesc, last_speed: v.speedKts, last_pos: `${v.lat.toFixed(1)},${v.lon.toFixed(1)}` }))
            ) + '. ' +
            'Respond ONLY with JSON array: [{"mmsi":"...","ai_assessment":"..."}]',
        },
      ],
      max_tokens: 300,
    })
    return JSON.parse(result.response.match(/\[[\s\S]*\]/)?.[0] || '[]')
  } catch (e) {
    console.warn('[Shipping] Dark vessel AI analysis failed:', e.message)
    return []
  }
}

// ── Handler ───────────────────────────────────────────────────────────────────

export async function onRequest(ctx) {
  const { TLE_CACHE: kv, AI, AISSTREAM_KEY } = ctx.env

  // ── KV fast-path (stale-while-revalidate) ────────────────────────────────
  if (kv) {
    try {
      const raw = await kv.get(KV_SHIP_KEY, { type: 'text' })
      if (raw) {
        const age     = JSON.parse(raw)._fetched_at
        const staleMs = Date.now() - (age || 0)
        if (staleMs < CACHE_TTL * 1000) {
          // Fresh enough — return immediately
          return shipResponse(raw)
        }
        // Stale — return old data AND trigger background refresh
        ctx.waitUntil(refreshShipData(kv, AI, AISSTREAM_KEY))
        return shipResponse(raw, true)
      }
    } catch (e) {
      console.warn('[Shipping] KV read failed:', e.message)
    }
  }

  // ── No KV data — first load or KV unavailable ────────────────────────────
  if (!AISSTREAM_KEY) {
    // No API key configured: return demo vessels immediately
    const demo = { vessels: DEMO_VESSELS, _fetched_at: Date.now(), _demo: true }
    const body = JSON.stringify(demo)
    if (kv) ctx.waitUntil(kv.put(KV_SHIP_KEY, body, { expirationTtl: CACHE_TTL }))
    return shipResponse(body)
  }

  // Synchronous first-load fetch
  const vessels    = await collectFromAISStream(AISSTREAM_KEY)
  const payload    = { vessels, _fetched_at: Date.now(), _demo: false }
  const body       = JSON.stringify(payload)
  if (kv) ctx.waitUntil(kv.put(KV_SHIP_KEY, body, { expirationTtl: CACHE_TTL * 2 }))
  return shipResponse(body)
}

async function refreshShipData(kv, ai, apiKey) {
  if (!apiKey) return
  try {
    const vessels    = await collectFromAISStream(apiKey)

    // Dark vessel detection using previous snapshot
    let darkAssessments = []
    try {
      const prevRaw = await kv.get(KV_PREV_KEY, { type: 'json' })
      darkAssessments = await detectDarkVessels(vessels, prevRaw?.vessels || [], ai)
    } catch { /* non-critical */ }

    // Annotate dark vessels
    if (darkAssessments.length > 0) {
      const darkMap = new Map(darkAssessments.map(d => [d.mmsi, d.ai_assessment]))
      const prevRaw = await kv.get(KV_PREV_KEY, { type: 'json' })
      if (prevRaw?.vessels) {
        const darkVessels = prevRaw.vessels
          .filter(v => darkMap.has(v.mmsi))
          .map(v => ({ ...v, ai_dark: true, ai_assessment: darkMap.get(v.mmsi) }))
        vessels.push(...darkVessels)
      }
    }

    // Rotate snapshots: current → prev, new → current
    const currentRaw = await kv.get(KV_SHIP_KEY, { type: 'text' })
    if (currentRaw) await kv.put(KV_PREV_KEY, currentRaw, { expirationTtl: CACHE_TTL * 4 })

    const payload = JSON.stringify({ vessels, _fetched_at: Date.now(), _demo: false })
    await kv.put(KV_SHIP_KEY, payload, { expirationTtl: CACHE_TTL * 2 })
    console.log(`[Shipping] Refreshed: ${vessels.length} vessels`)
  } catch (e) {
    console.warn('[Shipping] Background refresh failed:', e.message)
  }
}

function shipResponse(body, stale = false) {
  return new Response(body, {
    headers: {
      'Content-Type':                'application/json',
      'Cache-Control':               stale ? 'public, max-age=0' : `public, max-age=${CACHE_TTL}`,
      'Access-Control-Allow-Origin': '*',
      ...(stale && { 'X-Cache-Status': 'STALE' }),
    },
  })
}
