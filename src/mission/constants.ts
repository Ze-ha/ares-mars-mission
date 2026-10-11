import { JEZERO, LAUNCH_SITE_GEO, SUN_AT_JEZERO, SUN_AT_LAUNCH } from './ephemeris'

/**
 * Units:
 *  - Earth launch world & Mars landing world: metres, +Y up, +X = downrange (east), +Z = south.
 *  - Space world: kilometres, floating origin centred on the ship.
 */

export const EARTH_RADIUS_KM = 6371
export const MARS_RADIUS_KM = 3389.5
export const EARTH_ATMO_KM = 100
export const MARS_ATMO_KM = 70

/** Launch site (Starbase, South Texas) and landing site (Jezero Crater, next to Perseverance). */
export const LAUNCH_SITE = { lat: LAUNCH_SITE_GEO.lat, lon: LAUNCH_SITE_GEO.lon }
export const LANDING_SITE = { lat: JEZERO.lat, lon: JEZERO.lon }

/** Height of the launch mount deck the booster sits on (m). */
export const MOUNT_HEIGHT = 20

/** Vehicle dimensions (metres) — Starship-class two-stage system. */
export const VEHICLE = {
  radius: 4.5,
  boosterLength: 71,
  shipBodyLength: 34,
  shipNoseLength: 16.3,
  get shipLength() {
    return this.shipBodyLength + this.shipNoseLength
  },
  get stackLength() {
    return this.boosterLength + this.shipLength
  },
  /** ship foot pads sit this far below the ship origin (engine exit plane) when legs are deployed */
  legReach: 2.6,
}

/** Real sun direction at Starbase at launch (2026-11-27, computed from ephemerides). */
export const SUN_LAUNCH = SUN_AT_LAUNCH.clone()
/** Real sun direction at Jezero at landing (2027-06-02, Martian afternoon). */
export const SUN_MARS_SURFACE = SUN_AT_JEZERO.clone()
