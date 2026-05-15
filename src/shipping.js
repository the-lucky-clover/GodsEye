import * as Cesium from 'cesium'
import { shipIcon, warshipIcon } from './icons.js'

/**
 * Shipping layer — AIS vessel tracking via the /api/shipping Worker.
 *
 * The Worker proxies aisstream.io (free, requires AISSTREAM_KEY secret) and
 * falls back to a demo vessel set when no API key is configured.  Ships are
 * polled every 60 s; position history is maintained for a short wake trail.
 *
 * AIS vessel type codes of interest:
 *   35  Military    70-79  Cargo     80-89  Tanker
 *   60-69 Passenger  30-39 Fishing
 */

const SHIPPING_API      = '/api/shipping'
const UPDATE_INTERVAL_MS = 60_000   // ships move slowly
const MAX_RENDER         = 500      // cap to keep Cesium responsive
const MAX_TRAIL_PTS      = 3

// icon cache
const SHIP_ICON      = { normal: null, god: null }
const WARSHIP_ICON   = { normal: null, god: null }

function getShipIcon(military, god) {
  if (military) {
    if (!WARSHIP_ICON[god ? 'god' : 'normal']) WARSHIP_ICON[god ? 'god' : 'normal'] = warshipIcon(god)
    return WARSHIP_ICON[god ? 'god' : 'normal']
  }
  if (!SHIP_ICON[god ? 'god' : 'normal']) SHIP_ICON[god ? 'god' : 'normal'] = shipIcon(god)
  return SHIP_ICON[god ? 'god' : 'normal']
}

function isMilitaryVessel(vessel) {
  return (
    vessel.type === 35 ||
    /^(USS|HMS|HMAS|FS |FNS|HNLMS|RFS|CNS|INS|SAS|ROKS|JS )/i.test(vessel.name)
  )
}

function headingToRotation(deg) {
  return Cesium.Math.toRadians(-deg)
}

// mmsi → { entity, trail: Cartesian3[] }
const shipMap       = new Map()
const wakeHistory   = new Map()

let updateTimer   = null
let godModeActive = false
let isVisible     = true

// ── Rendering ─────────────────────────────────────────────────────────────────

function updateShips(viewer, vessels) {
  const seen = new Set()

  vessels.slice(0, MAX_RENDER).forEach(vessel => {
    if (vessel.lon == null || vessel.lat == null) return
    seen.add(vessel.mmsi)

    const pos      = Cesium.Cartesian3.fromDegrees(vessel.lon, vessel.lat, 2)
    const military = isMilitaryVessel(vessel)
    const dark     = vessel.ai_dark === true
    const icon     = getShipIcon(military, godModeActive)
    const label    = vessel.name || vessel.mmsi || 'UNKNOWN'

    // Maintain wake trail (short position history)
    const trail = wakeHistory.get(vessel.mmsi) || []
    trail.push(pos)
    if (trail.length > MAX_TRAIL_PTS) trail.shift()
    wakeHistory.set(vessel.mmsi, trail)

    if (shipMap.has(vessel.mmsi)) {
      // Update existing entity
      const { entity } = shipMap.get(vessel.mmsi)
      entity.position = pos
      entity.billboard.image   = icon
      entity.billboard.color   = dark
        ? Cesium.Color.fromCssColorString('#ff4444')
        : Cesium.Color.WHITE
      entity.billboard.rotation = headingToRotation(vessel.heading)
      entity.label.show = godModeActive
    } else {
      // Create new entity
      const props = new Cesium.PropertyBag({
        type:       'vessel',
        mmsi:       vessel.mmsi,
        name:       label,
        callsign:   vessel.callsign,
        speed_kts:  vessel.speedKts?.toFixed(1),
        heading:    vessel.heading?.toFixed(0) + '°',
        vessel_type: vessel.typeDesc,
        flag:       vessel.flag,
        length_m:   vessel.lengthM || 'N/A',
        nav_status: navStatusLabel(vessel.navStatus),
        ...(vessel.ai_assessment ? { ai_assessment: vessel.ai_assessment } : {}),
        ...(vessel.ai_dark       ? { ai_flag: 'DARK VESSEL DETECTED' }     : {}),
      })

      const entity = viewer.entities.add({
        id:       `vessel_${vessel.mmsi}`,
        name:     label,
        show:     isVisible,
        position: pos,
        billboard: {
          image:        icon,
          width:        22,
          height:       22,
          rotation:     headingToRotation(vessel.heading),
          alignedAxis:  Cesium.Cartesian3.UNIT_Z,
          color:        dark ? Cesium.Color.fromCssColorString('#ff4444') : Cesium.Color.WHITE,
          pixelOffset:  Cesium.Cartesian2.ZERO,
          disableDepthTestDistance: 5e6,
          scaleByDistance: new Cesium.NearFarScalar(1e4, 1.5, 2e7, 0.4),
        },
        label: {
          text:                  label,
          show:                  godModeActive,
          font:                  '9px Courier New',
          fillColor:             military ? Cesium.Color.fromCssColorString('#8888ff') : Cesium.Color.fromCssColorString('#00ccff'),
          outlineColor:          Cesium.Color.BLACK,
          outlineWidth:          2,
          style:                 Cesium.LabelStyle.FILL_AND_OUTLINE,
          pixelOffset:           new Cesium.Cartesian2(0, -20),
          disableDepthTestDistance: 5e6,
        },
        properties: props,
      })

      shipMap.set(vessel.mmsi, { entity })
    }
  })

  // Remove vessels that are no longer in the feed
  shipMap.forEach(({ entity }, mmsi) => {
    if (!seen.has(mmsi)) {
      viewer.entities.remove(entity)
      shipMap.delete(mmsi)
      wakeHistory.delete(mmsi)
    }
  })
}

function navStatusLabel(code) {
  const labels = {
    0: 'Underway (engine)', 1: 'At anchor', 2: 'Not under command',
    3: 'Restricted maneuverability', 5: 'Moored', 6: 'Aground',
    8: 'Underway (sailing)', 15: 'Undefined',
  }
  return labels[code] ?? 'Unknown'
}

// ── Fetch ─────────────────────────────────────────────────────────────────────

async function fetchVessels() {
  const res = await fetch(SHIPPING_API)
  if (!res.ok) throw new Error(`/api/shipping HTTP ${res.status}`)
  const data = await res.json()
  return data.vessels || []
}

// ── Public API ────────────────────────────────────────────────────────────────

export async function initShipping(viewer) {
  async function tick() {
    try {
      const vessels = await fetchVessels()
      updateShips(viewer, vessels)
      console.log(`[Shipping] ${vessels.length} vessels`)
    } catch (e) {
      console.warn('[Shipping] fetch failed:', e.message)
    }
  }

  await tick()
  updateTimer = setInterval(tick, UPDATE_INTERVAL_MS)

  return {
    getCount: ()     => shipMap.size,
    setVisible: (v)  => {
      isVisible = v
      shipMap.forEach(({ entity }) => { entity.show = v })
    },
    setGodMode: (g) => {
      godModeActive = g
      // Refresh icons and labels for all existing entities
      shipMap.forEach(({ entity }, mmsi) => {
        const vessel = { mmsi, heading: 0 } // heading stored in entity rotation
        const military = /^(USS|HMS|HMAS)/i.test(entity.name)
        entity.billboard.image = getShipIcon(military, g)
        entity.label.show      = g
      })
    },
    /** Returns current vessel data for the AI agent */
    getVessels: () => {
      const vessels = []
      shipMap.forEach(({ entity }, mmsi) => {
        const props = entity.properties
        vessels.push({
          mmsi,
          name:       entity.name,
          callsign:   props.callsign?.getValue()  || '',
          lon:        entity.position?.getValue(Cesium.JulianDate.now())
            ? Cesium.Cartographic.fromCartesian(entity.position.getValue(Cesium.JulianDate.now())).longitude * Cesium.Math.DEGREES_PER_RADIAN
            : 0,
          lat:        entity.position?.getValue(Cesium.JulianDate.now())
            ? Cesium.Cartographic.fromCartesian(entity.position.getValue(Cesium.JulianDate.now())).latitude * Cesium.Math.DEGREES_PER_RADIAN
            : 0,
          altM:       0,
          speedKts:   parseFloat(props.speed_kts?.getValue()) || 0,
          typeDesc:   props.vessel_type?.getValue() || '',
          flag:       props.flag?.getValue() || '',
          ai_dark:    props.ai_flag?.getValue()?.includes('DARK') || false,
          ai_assessment: props.ai_assessment?.getValue() || '',
        })
      })
      return vessels
    },
  }
}
