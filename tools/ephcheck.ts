import * as A from 'astronomy-engine'
import { EPHEMERIS_SUMMARY, LAUNCH_DATE, SUN_AT_LAUNCH, SKY_QUAT_EARTH, LANDING_DATE } from '../src/mission/ephemeris'
import { Vector3 } from 'three'
console.log(EPHEMERIS_SUMMARY)
const obs = new A.Observer(25.9972, -97.1566, 5)
const t = A.MakeTime(LAUNCH_DATE)
const eq = A.Equator(A.Body.Sun, t, obs, true, true)
const h = A.Horizon(t, obs, eq.ra, eq.dec, 'normal')
console.log('library sun alt/az', h.altitude.toFixed(3), h.azimuth.toFixed(3), ' mine el', (Math.asin(SUN_AT_LAUNCH.y)*180/Math.PI).toFixed(3))
// check a star: Polaris (RA 37.95, Dec 89.26) should sit at altitude ≈ site latitude, due north
const a=37.95*Math.PI/180, d=89.26*Math.PI/180
const sky = new Vector3(Math.cos(d)*Math.cos(a), Math.sin(d), -Math.cos(d)*Math.sin(a)).applyQuaternion(SKY_QUAT_EARTH)
console.log('Polaris el', (Math.asin(sky.y)*180/Math.PI).toFixed(2), 'az', ((Math.atan2(sky.x, -sky.z)*180/Math.PI+360)%360).toFixed(1))
console.log('landing', LANDING_DATE.toISOString())
