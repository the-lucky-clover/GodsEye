import * as Cesium from 'cesium'
import { aircraftIcon, militaryIcon } from './icons.js'

/**
 * Aircraft tracking — powered by the /api/aircraft Worker.
 *
 * The Worker handles source selection (OpenSky Network primary, airplanes.live
 * fallback), caching, and Workers AI anomaly enrichment for emergency squawks.
 * This module only manages Cesium entity rendering and camera tracking.
 *
 * Normalised aircraft object shape (see functions/api/aircraft.js):
 *   icao24, callsign, lon, lat, altM, altFt, onGround,
 *   speedKts, heading, vertRate, squawk, type, desc, category,
 *   ai_flagged?, ai_assessment?
 */

const AIRCRAFT_API       = '/api/aircraft'
const UPDATE_INTERVAL_MS = 15_000
const MAX_RENDER         = 6000
const MAX_TRAIL_PTS      = 4

const aircraftMap     = new Map()   // icao24 → { entity }
const positionHistory = new Map()   // icao24 → Cartesian3[]

let updateTimer   = null
let godModeActive = false
let lastStates    = []
let isVisible     = true

// ── Helpers ───────────────────────────────────────────────────────────────────

function isMilitary(ac) {
  const cat = (ac.category || '').toUpperCase()
  const cs  = (ac.callsign  || '').toUpperCase()
  return (
    ac.squawk === '7777' ||
    cat === 'A5' ||
    /^(RCH|REACH|JAKE|DOOM|EVIL|GTMO|GHOST|REAPER|PREDATOR|GRIM|COBRA|VIPER|EAGLE|HAWK|FALCON)/.test(cs)
  )
}

function headingToRotation(deg) {
  return Cesium.Math.toRadians(-deg)
}

// ── Rendering ─────────────────────────────────────────────────────────────────

function updateAircraft(viewer, rawList) {
  const activeIds = new Set()
  const visible   = rawList.length > MAX_RENDER ? rawList.slice(0, MAX_RENDER) : rawList

  visible.forEach(s => {
    if (!s.lon || !s.lat) return

    const altM  = Math.max(s.altM, 150)
    const mil   = isMilitary(s)
    const icon  = mil ? militaryIcon(godModeActive) : aircraftIcon(godModeActive)
    const color = mil
      ? (godModeActive ? Cesium.Color.RED    : Cesium.Color.fromCssColorString('#ff7777'))
      : (godModeActive ? Cesium.Color.ORANGE : Cesium.Color.YELLOW)
    const cart  = Cesium.Cartesian3.fromDegrees(s.lon, s.lat, altM)

    activeIds.add(s.icao24)

    const hist = positionHistory.get(s.icao24) || []
    hist.push(cart)
    if (hist.length > MAX_TRAIL_PTS) hist.shift()
    positionHistory.set(s.icao24, hist)

    if (aircraftMap.has(s.icao24)) {
      const { entity } = aircraftMap.get(s.icao24)
      entity.position           = new Cesium.ConstantPositionProperty(cart)
      entity.billboard.image    = new Cesium.ConstantProperty(icon)
      entity.billboard.color    = new Cesium.ConstantProperty(color.withAlpha(0.95))
      entity.billboard.rotation = new Cesium.ConstantProperty(headingToRotation(s.heading))
      entity.label.show         = new Cesium.ConstantProperty(godModeActive)
    } else {
      const labelText = s.callsign + (mil ? ' ✈MIL' : '')
      const entity = viewer.entities.add({
        name: s.callsign || s.icao24,
        position: cart,
        billboard: {
          image:    icon,
          width:    mil ? 26 : 22,
          height:   mil ? 26 : 22,
          rotation: headingToRotation(s.heading),
          alignedAxis: Cesium.Cartesian3.ZERO,
          color:    color.withAlpha(0.95),
          scaleByDistance: new Cesium.NearFarScalar(2e5, 2.5, 1.5e7, 0.2),
          disableDepthTestDistance: 1.5e6,
        },
        label: {
          text:         labelText,
          font:         '9px Courier New',
          fillColor:    color,
          outlineColor: Cesium.Color.BLACK,
          outlineWidth: 2,
          style:        Cesium.LabelStyle.FILL_AND_OUTLINE,
          pixelOffset:  new Cesium.Cartesian2(14, -12),
          scaleByDistance: new Cesium.NearFarScalar(2e5, 1, 3e6, 0),
          show: godModeActive,
        },
        properties: {
          type:          mil ? 'military_aircraft' : 'aircraft',
          callsign:      s.callsign,
          aircraft:      s.desc || s.type || '--',
          altitude:      `${Math.round(s.altFt).toLocaleString()} ft (${Math.round(altM)} m)`,
          speed:         `${Math.round(s.speedKts)} kts`,
          heading:       `${Math.round(s.heading)}°`,
          vertRate:      `${s.vertRate.toFixed(1)} m/s`,
          squawk:        s.squawk || '--',
          icao24:        s.icao24,
          ...(s.ai_assessment ? { ai_assessment: s.ai_assessment } : {}),
        },
      })
      aircraftMap.set(s.icao24, { entity })
    }
  })

  for (const [id, { entity }] of aircraftMap) {
    if (!activeIds.has(id)) {
      viewer.entities.remove(entity)
      aircraftMap.delete(id)
      positionHistory.delete(id)
    }
  }
}

// ── Fetch ─────────────────────────────────────────────────────────────────────

async function fetchAllAircraft() {
  const res = await fetch(AIRCRAFT_API)
  if (!res.ok) throw new Error(`/api/aircraft HTTP ${res.status}`)
  return res.json()
}

// ── Init ──────────────────────────────────────────────────────────────────────

export async function initAircraft(viewer) {
  async function update() {
    if (!isVisible) return
    try {
      lastStates = await fetchAllAircraft()
      updateAircraft(viewer, lastStates)
    } catch (e) {
      console.warn('[Aircraft] Fetch failed:', e.message)
    }
  }

  await update()
  updateTimer = setInterval(update, UPDATE_INTERVAL_MS)

  return {
    getCount:   () => aircraftMap.size,
    getTrails:  () => positionHistory,
    /** Returns normalised aircraft array for the AI agent */
    getAircraft: () => lastStates,
    setVisible: (v) => {
      isVisible = v
      aircraftMap.forEach(({ entity }) => (entity.show = v))
    },
    setGodMode: (active) => {
      godModeActive = active
      if (lastStates.length) updateAircraft(viewer, lastStates)
    },
    destroy: () => {
      clearInterval(updateTimer)
      aircraftMap.forEach(({ entity }) => viewer.entities.remove(entity))
      aircraftMap.clear()
      positionHistory.clear()
    },
  }
}


