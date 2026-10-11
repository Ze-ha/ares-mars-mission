// debug: list every visible mesh the view ray through given screen points hits (?debug hook)
import { chromium } from 'playwright-core'
const b = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome', args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] })
const p = await b.newPage({ viewport: { width: 640, height: 360 } })
await p.goto(`http://localhost:8766/index.html?t=${process.argv[2]}&paused=1&quality=high&debug${process.env.EXTRA ?? ''}`)
await p.waitForTimeout(40000)
if (process.env.SHOT) await p.screenshot({ path: process.env.SHOT, timeout: 240000 })
const r = await p.evaluate((ptsJson) => {
  const st = window.__r3f()
  const cam = st.camera
  const out = {}
  const pts = JSON.parse(ptsJson)
  for (const [x, y] of pts) {
    const ray = new st.raycaster.ray.constructor()
    st.raycaster.setFromCamera({ x, y }, cam)
    const hits = st.raycaster.intersectObjects(st.scene.children, true).filter((h) => { let o = h.object; while (o) { if (!o.visible) return false; o = o.parent } return true })
    out[`${x},${y}`] = hits.slice(0, 8).map((h) => `${h.point.x.toFixed(0)},${h.point.y.toFixed(1)},${h.point.z.toFixed(0)} ${h.object.type}:${h.object.name || ''}:${h.object.geometry?.type}:${h.object.material?.type}:${Math.round(h.distance)}`)
  }
  return out
}, process.env.PTS || '[[0,0]]')
console.log(JSON.stringify(r, null, 1))
await b.close()
