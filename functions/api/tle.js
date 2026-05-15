/**
 * /api/tle — TLE data proxy with KV caching and D1 persistence.
 *
 * Request flow:
 *   1. KV fast-path  — serve from edge cache if entry is younger than 1 h
 *   2. D1 fallback   — serve fresh D1 rows if available (avoids unnecessary
 *                      upstream fetch when KV expired but D1 is still fresh)
 *   3. CelesTrak     — fetch live TLE data, persist to D1, refresh KV
 *   4. Stale D1      — if CelesTrak is down, serve the most recent D1 rows
 *                      regardless of age so the app keeps working
 *
 * Bindings (configured in wrangler.toml):
 *   TLE_CACHE  — Workers KV namespace
 *   DB         — D1 database (godseye-db)
 *
 * Both bindings are optional: if absent the Worker acts as a simple proxy
 * (useful during local development with `wrangler pages dev`).
 */

const CELESTRAK_URL = 'https://celestrak.org/pub/TLE/active.tle'
const KV_KEY        = 'active_tle'
const CACHE_TTL     = 3600          // 1 hour in seconds
const D1_BATCH_SIZE = 100           // D1 batch() statement limit
const D1_MAX_SATS   = 5000          // cap inserts to stay within D1 write budget
const D1_HISTORY_S  = CACHE_TTL * 24 // keep up to 24 h of records in D1

export async function onRequest(ctx) {
  const { TLE_CACHE, DB } = ctx.env

  // ── 1. KV fast-path ──────────────────────────────────────────────────────
  if (TLE_CACHE) {
    try {
      const cached = await TLE_CACHE.get(KV_KEY, { type: 'text' })
      if (cached) return tleResponse(cached)
    } catch (e) {
      console.warn('[TLE] KV read failed:', e.message)
    }
  }

  // ── 2. D1 fresh-data path ────────────────────────────────────────────────
  if (DB) {
    try {
      const freshCutoff = Math.floor(Date.now() / 1000) - CACHE_TTL
      const { results } = await DB
        .prepare('SELECT name, line1, line2 FROM tle_cache WHERE fetched_at > ? ORDER BY name')
        .bind(freshCutoff)
        .all()
      if (results && results.length > 0) {
        const text = results.map(r => `${r.name}\n${r.line1}\n${r.line2}`).join('\n')
        // Refresh KV so the next request is served instantly from the edge
        if (TLE_CACHE) {
          ctx.waitUntil(TLE_CACHE.put(KV_KEY, text, { expirationTtl: CACHE_TTL }))
        }
        return tleResponse(text)
      }
    } catch (e) {
      console.warn('[TLE] D1 fresh-read failed:', e.message)
    }
  }

  // ── 3. Fetch from CelesTrak ──────────────────────────────────────────────
  let text
  try {
    const res = await fetch(CELESTRAK_URL)
    if (!res.ok) throw new Error(`CelesTrak HTTP ${res.status}`)
    text = await res.text()
  } catch (fetchErr) {
    // ── 4. CelesTrak is down — serve stale D1 data ──────────────────────
    if (DB) {
      try {
        const { results } = await DB
          .prepare('SELECT name, line1, line2 FROM tle_cache ORDER BY name')
          .all()
        if (results && results.length > 0) {
          const staleText = results.map(r => `${r.name}\n${r.line1}\n${r.line2}`).join('\n')
          console.warn('[TLE] Serving stale D1 data — CelesTrak unavailable')
          return tleResponse(staleText, true)
        }
      } catch (e) {
        console.warn('[TLE] D1 stale-read failed:', e.message)
      }
    }
    return new Response(`CelesTrak unavailable: ${fetchErr.message}`, { status: 503 })
  }

  // ── Persist to D1 in the background ─────────────────────────────────────
  if (DB) {
    ctx.waitUntil(persistToD1(DB, text))
  }

  // ── Refresh KV ───────────────────────────────────────────────────────────
  if (TLE_CACHE) {
    ctx.waitUntil(TLE_CACHE.put(KV_KEY, text, { expirationTtl: CACHE_TTL }))
  }

  return tleResponse(text)
}

/**
 * Parse TLE text and bulk-insert records into D1 in batches of 100.
 * Prunes records older than D1_HISTORY_S seconds before inserting.
 */
async function persistToD1(db, text) {
  try {
    const now  = Math.floor(Date.now() / 1000)
    const lines = text.split('\n').map(l => l.trim()).filter(Boolean)
    const records = []
    for (let i = 0; i + 2 < lines.length; i += 3) {
      if (lines[i + 1].startsWith('1 ') && lines[i + 2].startsWith('2 ')) {
        records.push({ name: lines[i], line1: lines[i + 1], line2: lines[i + 2] })
      }
    }
    if (records.length === 0) return

    // Prune old records
    await db.prepare('DELETE FROM tle_cache WHERE fetched_at < ?')
      .bind(now - D1_HISTORY_S)
      .run()

    // Insert fresh records in chunks (respect D1 batch limit)
    const capped = records.slice(0, D1_MAX_SATS)
    for (let i = 0; i < capped.length; i += D1_BATCH_SIZE) {
      const chunk = capped.slice(i, i + D1_BATCH_SIZE)
      await db.batch(
        chunk.map(r =>
          db.prepare('INSERT OR REPLACE INTO tle_cache (name, line1, line2, fetched_at) VALUES (?, ?, ?, ?)')
            .bind(r.name, r.line1, r.line2, now)
        )
      )
    }
    console.log(`[TLE] D1: persisted ${capped.length} records`)
  } catch (e) {
    console.warn('[TLE] D1 persist failed:', e.message)
  }
}

function tleResponse(text, stale = false) {
  return new Response(text, {
    headers: {
      'Content-Type':                'text/plain; charset=utf-8',
      'Cache-Control':               `public, max-age=${stale ? 0 : CACHE_TTL}`,
      'Access-Control-Allow-Origin': '*',
      ...(stale && { 'X-Cache-Status': 'STALE' }),
    },
  })
}
