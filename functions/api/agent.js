/**
 * /api/agent — Agentic AI OSINT coordinator using Workers AI tool calling.
 *
 * Implements a ReAct (Reason + Act) loop:
 *   1. Receive OSINT context from the browser (aircraft, ships, satellites,
 *      viewport) plus an optional natural-language query.
 *   2. AI reasons about what intelligence is needed and calls one or more
 *      "tools" that operate on the supplied context data.
 *   3. Tool results are fed back to the AI for synthesis.
 *   4. The loop repeats up to MAX_ITERATIONS times, then produces a final
 *      structured intelligence report.
 *
 * Tools available to the AI (all operate on data provided in the request
 * body — no additional network calls needed):
 *   filter_aircraft       — subset aircraft by region / type / altitude
 *   filter_vessels        — subset vessels by region / type
 *   get_satellite_coverage — satellites currently overhead a coordinate
 *   cross_cue             — find co-located aircraft + vessel activity
 *   detect_anomalies      — flag statistically unusual activity patterns
 *
 * Binding required (wrangler.toml):
 *   AI — Workers AI
 *
 * POST /api/agent
 * Body: {
 *   query?:    string,           // natural-language question (optional)
 *   aircraft:  Aircraft[],       // current aircraft array from /api/aircraft
 *   vessels:   Vessel[],         // current vessels array from /api/shipping
 *   satellites: string[],        // satellite names currently loaded
 *   viewport:  { lat, lon, alt_km, heading? }
 * }
 * Response: {
 *   report:        string,       // 3-5 sentence intelligence assessment
 *   actions_taken: string[],     // list of tool calls made
 *   entity_count:  { aircraft, vessels, satellites }
 * }
 */

const MAX_ITERATIONS = 3  // cap the ReAct loop to control neuron budget
const MODEL          = '@cf/meta/llama-3.1-8b-instruct'

// ── Tool definitions ─────────────────────────────────────────────────────────

const TOOLS = [
  {
    name: 'filter_aircraft',
    description:
      'Filter the aircraft dataset to a sub-region or category. ' +
      'Returns count and summary stats (altitude bands, speed distribution, military fraction).',
    parameters: {
      type: 'object',
      properties: {
        min_lat:       { type: 'number',  description: 'Southern bound (degrees)' },
        max_lat:       { type: 'number',  description: 'Northern bound (degrees)' },
        min_lon:       { type: 'number',  description: 'Western bound (degrees)'  },
        max_lon:       { type: 'number',  description: 'Eastern bound (degrees)'  },
        military_only: { type: 'boolean', description: 'Restrict to military squawks/types' },
        emergency_only:{ type: 'boolean', description: 'Restrict to emergency squawk codes 7500/7600/7700' },
        min_alt_ft:    { type: 'number',  description: 'Minimum altitude in feet'  },
        max_alt_ft:    { type: 'number',  description: 'Maximum altitude in feet'  },
      },
    },
  },
  {
    name: 'filter_vessels',
    description:
      'Filter the vessel dataset to a sub-region or vessel type. ' +
      'Returns count, vessel type breakdown, and any AI-flagged dark vessels.',
    parameters: {
      type: 'object',
      properties: {
        min_lat:     { type: 'number' },
        max_lat:     { type: 'number' },
        min_lon:     { type: 'number' },
        max_lon:     { type: 'number' },
        type_filter: { type: 'string',  description: 'e.g. "Military", "Tanker", "Container", "Cargo"' },
        dark_only:   { type: 'boolean', description: 'Only show vessels flagged as dark (ai_dark=true)' },
      },
    },
  },
  {
    name: 'get_satellite_coverage',
    description:
      'Return which satellites from the current tracking list are likely overhead ' +
      'a given geographic coordinate (rough check by name/orbital characteristics).',
    parameters: {
      type: 'object',
      required: ['lat', 'lon'],
      properties: {
        lat: { type: 'number', description: 'Latitude in degrees' },
        lon: { type: 'number', description: 'Longitude in degrees' },
      },
    },
  },
  {
    name: 'cross_cue',
    description:
      'Find geographic areas where aircraft AND vessel activity overlap ' +
      '(useful for detecting ship/aircraft rendezvous or surveillance patterns).',
    parameters: {
      type: 'object',
      properties: {
        radius_deg: { type: 'number', description: 'Proximity radius in degrees (default 2)' },
      },
    },
  },
  {
    name: 'detect_anomalies',
    description:
      'Run statistical anomaly detection across all modalities: unusual aircraft ' +
      'concentrations, emergency squawks, dark vessels, and satellite coverage gaps.',
    parameters: {
      type: 'object',
      properties: {
        focus: {
          type: 'string',
          enum: ['aircraft', 'vessels', 'satellites', 'all'],
          description: 'Which modality to focus on (default: all)',
        },
      },
    },
  },
]

// ── Tool executor ─────────────────────────────────────────────────────────────

function executeTool(name, args, context) {
  const { aircraft = [], vessels = [], satellites = [], viewport } = context

  switch (name) {
    case 'filter_aircraft': {
      let subset = aircraft
      if (args.min_lat != null) subset = subset.filter(a => a.lat >= args.min_lat)
      if (args.max_lat != null) subset = subset.filter(a => a.lat <= args.max_lat)
      if (args.min_lon != null) subset = subset.filter(a => a.lon >= args.min_lon)
      if (args.max_lon != null) subset = subset.filter(a => a.lon <= args.max_lon)
      if (args.military_only)   subset = subset.filter(a => a.ai_flagged || isMilitary(a))
      if (args.emergency_only)  subset = subset.filter(a => ['7500','7600','7700'].includes(a.squawk))
      if (args.min_alt_ft != null) subset = subset.filter(a => a.altFt >= args.min_alt_ft)
      if (args.max_alt_ft != null) subset = subset.filter(a => a.altFt <= args.max_alt_ft)

      const milCount  = subset.filter(isMilitary).length
      const emgCount  = subset.filter(a => ['7500','7600','7700'].includes(a.squawk)).length
      const avgAlt    = subset.length ? Math.round(subset.reduce((s, a) => s + a.altFt, 0) / subset.length) : 0
      const avgSpeed  = subset.length ? Math.round(subset.reduce((s, a) => s + a.speedKts, 0) / subset.length) : 0
      const flagged   = subset.filter(a => a.ai_flagged).map(a => ({ callsign: a.callsign, squawk: a.squawk, ai_assessment: a.ai_assessment }))

      return {
        count: subset.length,
        military_count: milCount,
        emergency_count: emgCount,
        avg_altitude_ft: avgAlt,
        avg_speed_kts: avgSpeed,
        ai_flagged_aircraft: flagged,
      }
    }

    case 'filter_vessels': {
      let subset = vessels
      if (args.min_lat != null)   subset = subset.filter(v => v.lat >= args.min_lat)
      if (args.max_lat != null)   subset = subset.filter(v => v.lat <= args.max_lat)
      if (args.min_lon != null)   subset = subset.filter(v => v.lon >= args.min_lon)
      if (args.max_lon != null)   subset = subset.filter(v => v.lon <= args.max_lon)
      if (args.type_filter)       subset = subset.filter(v => v.typeDesc === args.type_filter)
      if (args.dark_only)         subset = subset.filter(v => v.ai_dark)

      const typeCounts = {}
      subset.forEach(v => { typeCounts[v.typeDesc] = (typeCounts[v.typeDesc] || 0) + 1 })
      const darkVessels = subset.filter(v => v.ai_dark).map(v => ({ mmsi: v.mmsi, name: v.name, ai_assessment: v.ai_assessment }))

      return { count: subset.length, type_breakdown: typeCounts, dark_vessels: darkVessels }
    }

    case 'get_satellite_coverage': {
      const { lat, lon } = args
      // Heuristic: include ISS (low orbit, passes everywhere) and any satellite
      // with name suggesting ISR / surveillance capability
      const isrKeywords = /ISS|SENTINEL|WORLDVIEW|GEOEYE|SPOT|PLEIADE|RADARSAT|SAR|RECON|KH-|USA-|NRO|LACROSSE|ONYX|MISTY|TRUMPET|MENTOR|ADVANCED ORION|MERIDIAN|COSMOS|SICH|RESURS/i
      const overhead = satellites.filter(name => isrKeywords.test(name))
      return {
        coordinate: { lat: lat.toFixed(2), lon: lon.toFixed(2) },
        potential_isr_satellites: overhead.slice(0, 10),
        isr_satellite_count: overhead.length,
        total_tracked_satellites: satellites.length,
      }
    }

    case 'cross_cue': {
      const radiusDeg = args.radius_deg ?? 2
      const cues = []
      vessels.forEach(vessel => {
        const nearbyAir = aircraft.filter(ac =>
          Math.abs(ac.lat - vessel.lat) < radiusDeg &&
          Math.abs(ac.lon - vessel.lon) < radiusDeg
        )
        if (nearbyAir.length >= 2) {
          cues.push({
            vessel:          vessel.name || vessel.mmsi,
            vessel_type:     vessel.typeDesc,
            position:        `${vessel.lat.toFixed(2)},${vessel.lon.toFixed(2)}`,
            nearby_aircraft: nearbyAir.length,
            aircraft_sample: nearbyAir.slice(0, 3).map(a => a.callsign),
          })
        }
      })
      return { cue_count: cues.length, cues: cues.slice(0, 8) }
    }

    case 'detect_anomalies': {
      const focus = args.focus || 'all'
      const result = {}

      if (focus === 'aircraft' || focus === 'all') {
        const emergencies  = aircraft.filter(a => ['7500','7600','7700'].includes(a.squawk))
        const veryhigh     = aircraft.filter(a => a.altFt > 60000)
        const veryfast     = aircraft.filter(a => a.speedKts > 600)
        result.aircraft_anomalies = {
          emergency_squawks: emergencies.map(a => ({ callsign: a.callsign, squawk: a.squawk })),
          very_high_altitude: veryhigh.length,
          supersonic: veryfast.length,
          total_aircraft: aircraft.length,
        }
      }

      if (focus === 'vessels' || focus === 'all') {
        const dark      = vessels.filter(v => v.ai_dark)
        const military  = vessels.filter(v => v.type === 35)
        const anchored  = vessels.filter(v => v.navStatus === 1)
        result.vessel_anomalies = {
          dark_vessels: dark.map(v => ({ mmsi: v.mmsi, name: v.name, ai_assessment: v.ai_assessment })),
          military_vessels: military.map(v => v.name),
          unexpectedly_anchored: anchored.length,
          total_vessels: vessels.length,
        }
      }

      if (focus === 'satellites' || focus === 'all') {
        const isrCount = satellites.filter(n =>
          /SENTINEL|WORLDVIEW|RADARSAT|LACROSSE|KH-|USA-\d|MISTY|TRUMPET/i.test(n)
        ).length
        result.satellite_anomalies = {
          isr_capable_count: isrCount,
          total_tracked: satellites.length,
        }
      }

      if (viewport && (focus === 'all')) {
        result.viewport = {
          center: `${viewport.lat?.toFixed(2)},${viewport.lon?.toFixed(2)}`,
          altitude_km: viewport.alt_km?.toFixed(0),
        }
      }

      return result
    }

    default:
      return { error: `Unknown tool: ${name}` }
  }
}

function isMilitary(ac) {
  const cat = (ac.category || '').toUpperCase()
  const cs  = (ac.callsign  || '').toUpperCase()
  return (
    ac.squawk === '7777' ||
    cat === 'A5' ||
    /^(RCH|REACH|JAKE|DOOM|EVIL|GTMO|GHOST|REAPER|PREDATOR|GRIM|COBRA|VIPER|EAGLE|HAWK|FALCON)/.test(cs)
  )
}

// ── ReAct loop ────────────────────────────────────────────────────────────────

async function runAgentLoop(ai, messages, context) {
  const actionsTaken = []

  for (let i = 0; i < MAX_ITERATIONS; i++) {
    const response = await ai.run(MODEL, { messages, tools: TOOLS, max_tokens: 600 })

    // No tool calls — AI has produced its final answer
    if (!response.tool_calls || response.tool_calls.length === 0) {
      return { finalResponse: response.response || '', actionsTaken }
    }

    // Record the assistant's tool-call turn
    messages.push({
      role:       'assistant',
      content:    response.response || '',
      tool_calls: response.tool_calls,
    })

    // Execute each tool and collect results
    for (const call of response.tool_calls) {
      const args   = typeof call.arguments === 'string' ? JSON.parse(call.arguments) : (call.arguments || {})
      const result = executeTool(call.name, args, context)
      actionsTaken.push(`${call.name}(${JSON.stringify(args)})`)

      messages.push({
        role:         'tool',
        content:      JSON.stringify(result),
        tool_call_id: call.id || call.name,
        name:         call.name,
      })
    }
  }

  // Max iterations reached — request a final synthesis without tool calls
  messages.push({
    role: 'user',
    content: 'Based on the intelligence gathered, provide your final 3-sentence assessment now. Do not call any more tools.',
  })
  const finalResp = await ai.run(MODEL, { messages, max_tokens: 300 })
  return { finalResponse: finalResp.response || 'Analysis complete.', actionsTaken }
}

// ── Handler ───────────────────────────────────────────────────────────────────

export async function onRequest(ctx) {
  if (ctx.request.method !== 'POST') {
    return new Response('Method Not Allowed', { status: 405 })
  }

  if (!ctx.env.AI) {
    return Response.json(
      { report: 'AI analysis unavailable — the Workers AI binding (AI) is not configured in wrangler.toml.', actions_taken: [] },
      { status: 503 }
    )
  }

  let body
  try {
    body = await ctx.request.json()
  } catch {
    return new Response('Invalid JSON body', { status: 400 })
  }

  const {
    query     = 'Provide a comprehensive OSINT intelligence assessment of the current global situation.',
    aircraft  = [],
    vessels   = [],
    satellites= [],
    viewport  = {},
  } = body

  const context = { aircraft, vessels, satellites, viewport }

  // System briefing — establishes the AI's role and data awareness
  const systemPrompt =
    'You are an expert OSINT (Open Source Intelligence) analyst operating a global surveillance system called God\'s Eye. ' +
    'You have real-time access to three sensor modalities: ' +
    `(1) Aircraft tracking — ${aircraft.length} aircraft currently visible; ` +
    `(2) Maritime AIS — ${vessels.length} vessels currently tracked; ` +
    `(3) Satellite constellation — ${satellites.length} satellites in the tracking database. ` +
    'Use the available tools to gather specific intelligence before writing your assessment. ' +
    'Be precise, analytical, and professional. Use military/intelligence reporting style. ' +
    'Identify threats, anomalies, and patterns of interest. ' +
    'Your final report should be 3 sentences maximum.'

  const messages = [
    { role: 'system', content: systemPrompt },
    { role: 'user',   content: query },
  ]

  try {
    const { finalResponse, actionsTaken } = await runAgentLoop(ctx.env.AI, messages, context)

    return Response.json({
      report:       finalResponse,
      actions_taken: actionsTaken,
      entity_count: {
        aircraft:   aircraft.length,
        vessels:    vessels.length,
        satellites: satellites.length,
      },
    })
  } catch (e) {
    console.error('[Agent] Error:', e.message)
    return Response.json(
      { report: `Agent error: ${e.message}`, actions_taken: [] },
      { status: 502 }
    )
  }
}
