/**
 * /api/aircraft — Aircraft position proxy with Workers Cache API caching.
 *
 * Request flow:
 *   1. Workers Cache API — serve from edge cache if entry is younger than 15 s
 *                          (no KV cost; shared across all requests to the same
 *                          edge location so the upstream is called at most once
 *                          every 15 s per PoP regardless of user count)
 *   2. OpenSky Network  — primary global ADS-B feed (anonymous rate limit:
 *                          1 req / 10 s; Worker caching ensures we stay safe)
 *   3. airplanes.live   — regional fallback on HTTP 429 or any OpenSky error;
 *                          three parallel regional fetches are round-robin
 *                          interleaved so no continent dominates the list
 *
 * Optional bindings (configured in wrangler.toml):
 *   OPENSKY_USERNAME / OPENSKY_PASSWORD  — Workers secrets; when present they
 *                                          are sent as HTTP Basic credentials to
 *                                          unlock higher rate limits on OpenSky
 *
 * Returns a JSON array of normalised aircraft objects (same shape on both
 * primary and fallback paths) so the browser client needs no parser logic.
 */

const OPENSKY_URL  = 'https://opensky-network.org/api/states/all'
const ALT_BASE     = 'https://api.airplanes.live/v2/point'
const ALT_REGIONS  = [
  { lat: 35,  lon: -90,  r: 3000 },  // Americas
  { lat: 48,  lon: 15,   r: 3000 },  // Europe + Africa
  { lat: 20,  lon: 115,  r: 3000 },  // Asia-Pacific
]
const FT_TO_M      = 0.3048
const CACHE_TTL    = 15   // seconds — matches the browser poll interval

// ── Parsers ───────────────────────────────────────────────────────────────────

function parseOpenSky(st) {
  const altM = st[13] ?? st[7] ?? 0
  return {
    icao24:   st[0] || '',
    callsign: (st[1] || st[0] || '').trim(),
    lon:      st[5],
    lat:      st[6],
    altM,
    altFt:    altM * 3.28084,
    onGround: st[8] === true,
    speedKts: (st[9] || 0) * 1.944,
    heading:  st[10] || 0,
    vertRate: st[11] || 0,
    squawk:   (st[14] || '').toString(),
    type: '', desc: '', category: '',
  }
}

function parseAL(ac) {
  const altFt = ac.alt_geom ?? ac.alt_baro ?? 0
  return {
    icao24:   ac.hex || '',
    callsign: (ac.flight || ac.hex || '').trim(),
    lon:      ac.lon,
    lat:      ac.lat,
    altFt,
    altM:     altFt * FT_TO_M,
    onGround: (ac.alt_baro != null && ac.alt_baro < 50),
    speedKts: ac.gs  || 0,
    heading:  ac.track || 0,
    vertRate: ((ac.geom_rate || 0) * FT_TO_M) / 60,
    squawk:   ac.squawk   || '',
    type:     ac.t        || '',
    desc:     ac.desc     || '',
    category: ac.category || '',
  }
}

// ── Fetchers ──────────────────────────────────────────────────────────────────

async function fetchOpenSky(env) {
  const headers = { Accept: 'application/json' }
  if (env.OPENSKY_USERNAME && env.OPENSKY_PASSWORD) {
    headers.Authorization = 'Basic ' + btoa(`${env.OPENSKY_USERNAME}:${env.OPENSKY_PASSWORD}`)
  }
  const res = await fetch(OPENSKY_URL, { headers })
  if (res.status === 429) throw Object.assign(new Error('Rate limited'), { code: 429 })
  if (!res.ok)            throw new Error(`OpenSky HTTP ${res.status}`)
  const data = await res.json()
  return (data.states || [])
    .map(parseOpenSky)
    .filter(ac => ac.lon != null && ac.lat != null && !ac.onGround && ac.altM > 30)
}

async function fetchAirplanesLive() {
  const results = await Promise.allSettled(
    ALT_REGIONS.map(({ lat, lon, r }) =>
      fetch(`${ALT_BASE}/${lat}/${lon}/${r}`, { headers: { Accept: 'application/json' } })
        .then(res => res.ok ? res.json() : Promise.reject(new Error(`AL ${res.status}`)))
        .then(d => (d.ac || []).map(parseAL))
    )
  )
  // Round-robin interleave so no single region dominates the result set
  const arrs   = results.filter(r => r.status === 'fulfilled').map(r => r.value)
  const seen   = new Set()
  const all    = []
  const maxLen = Math.max(...arrs.map(a => a.length), 0)
  for (let i = 0; i < maxLen; i++) {
    for (const arr of arrs) {
      if (i >= arr.length) continue
      const ac = arr[i]
      if (!seen.has(ac.icao24)) { seen.add(ac.icao24); all.push(ac) }
    }
  }
  return all.filter(ac => ac.lon != null && ac.lat != null && !ac.onGround)
}

// ── Handler ───────────────────────────────────────────────────────────────────

export async function onRequest(ctx) {
  // Workers Cache API: shared per PoP, TTL = CACHE_TTL seconds.
  // Using caches.default avoids KV write costs for high-frequency data.
  const cache    = caches.default
  const cacheKey = new Request(ctx.request.url)

  const cached = await cache.match(cacheKey)
  if (cached) return cached

  let aircraft  // eslint-disable-line prefer-const — reassigned by AI enrichment below
  try {
    aircraft = await fetchOpenSky(ctx.env)
    console.log(`[Aircraft] OpenSky: ${aircraft.length} aircraft`)
  } catch (e) {
    console.warn('[Aircraft] OpenSky unavailable, falling back to airplanes.live:', e.message)
    aircraft = await fetchAirplanesLive()
    console.log(`[Aircraft] airplanes.live: ${aircraft.length} aircraft`)
  }

  // ── Workers AI anomaly enrichment ────────────────────────────────────────
  // Only triggered when emergency squawk codes are present (7500 hijack,
  // 7600 comms failure, 7700 general emergency) to stay within free-tier
  // AI neuron budget. Runs after data fetch, before caching.
  const emergencies = aircraft.filter(ac => ['7500', '7600', '7700'].includes(ac.squawk))
  if (emergencies.length > 0 && ctx.env.AI) {
    try {
      const aiResult = await ctx.env.AI.run('@cf/meta/llama-3.1-8b-instruct', {
        messages: [
          {
            role: 'system',
            content: 'You are an air traffic intelligence system. Respond with only valid JSON.',
          },
          {
            role: 'user',
            content:
              'Aircraft with emergency transponder codes detected. For each provide an 8-word tactical assessment. ' +
              'Input: ' + JSON.stringify(
                emergencies.map(a => ({
                  callsign: a.callsign, squawk: a.squawk,
                  alt_ft: Math.round(a.altFt), speed_kts: Math.round(a.speedKts),
                }))
              ) + '. ' +
              'Respond ONLY with a JSON array: [{"callsign":"...","ai_assessment":"..."}]',
          },
        ],
        max_tokens: 200,
      })
      try {
        const parsed = JSON.parse(aiResult.response.match(/\[[\s\S]*\]/)?.[0] || '[]')
        const assessMap = new Map(parsed.map(a => [a.callsign, a.ai_assessment]))
        aircraft = aircraft.map(ac =>
          assessMap.has(ac.callsign)
            ? { ...ac, ai_assessment: assessMap.get(ac.callsign), ai_flagged: true }
            : ac
        )
      } catch { /* ignore JSON parse errors — enrichment is non-critical */ }
    } catch (e) {
      console.warn('[Aircraft] AI enrichment failed:', e.message)
    }
  }

  const response = new Response(JSON.stringify(aircraft), {
    headers: {
      'Content-Type':                'application/json',
      'Cache-Control':               `public, max-age=${CACHE_TTL}`,
      'Access-Control-Allow-Origin': '*',
    },
  })

  ctx.waitUntil(cache.put(cacheKey, response.clone()))
  return response
}
