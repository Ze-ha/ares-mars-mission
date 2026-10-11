import { chromium } from 'playwright-core'
import { PNG } from 'pngjs'
import fs from 'fs'
const t = process.argv[2] || '241'
const out = process.argv[3]
const [rx0, ry0, rx1, ry1] = (process.env.REG || '350,180,480,235').split(',').map(Number)
const b = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome', args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] })
const p = await b.newPage({ viewport: { width: 640, height: 360 } })
await p.goto(`http://localhost:8766/index.html?t=${t}&paused=1&quality=high&debug${process.env.EXTRA ?? ''}`)
await p.waitForTimeout(40000)
const shot = async (name) => { const buf = await p.screenshot({ path: `${out}/${name}.png`, timeout: 240000 }); const png = PNG.sync.read(buf); let dark = 0; for (let y = ry0; y < ry1; y++) for (let x = rx0; x < rx1; x++) { const i = (y * png.width + x) * 4; const l = png.data[i] + png.data[i + 1] + png.data[i + 2]; if (l < 12) dark++ } return dark }
console.log('base dark', await shot('base'))
const groups = await p.evaluate(() => {
  const st = window.__r3f(); const g = {}
  st.scene.traverse((o) => { if (!(o.isMesh || o.isPoints || o.isLine) ) return
    let vis = true; let q = o; while (q) { if (!q.visible) vis = false; q = q.parent }; if (!vis) return
    const m = o.material; const k = (o.type + '|' + (m?.type) + '|' + (m?.uniforms ? Object.keys(m.uniforms).slice(0, 5).join(',') : m?.name) + '|' + o.geometry?.type)
    ;(g[k] ||= []).push(o.uuid) })
  return Object.entries(g).map(([k, v]) => [k, v.length])
})
for (let i = 0; i < groups.length; i++) {
  const k = groups[i][0]
  await p.evaluate((k) => { const st = window.__r3f(); st.scene.traverse((o) => { const m = o.material; if (!m) return; const kk = (o.type + '|' + (m?.type) + '|' + (m?.uniforms ? Object.keys(m.uniforms).slice(0, 5).join(',') : m?.name) + '|' + o.geometry?.type); if (kk === k && o.visible) { o.userData.__h = 1; o.visible = false } }) }, k)
  await p.waitForTimeout(4000)
  console.log(i, groups[i][1], k, 'dark', await shot('h' + i))
  await p.evaluate(() => { const st = window.__r3f(); st.scene.traverse((o) => { if (o.userData.__h) { o.visible = true; delete o.userData.__h } }) })
}
await b.close()
