import { chromium } from 'playwright-core'
const t = process.argv[2] || '212'
const out = process.argv[3]
const b = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome', args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] })
const p = await b.newPage({ viewport: { width: 640, height: 360 } })
await p.goto(`http://localhost:8766/index.html?t=${t}&paused=1&quality=high&debug${process.env.EXTRA ?? ''}`)
await p.waitForTimeout(35000)
await p.screenshot({ path: `${out}/a_all.png`, timeout: 240000 })
const list = await p.evaluate(() => {
  const st = window.__r3f()
  const res = []
  st.scene.traverse((o) => {
    if (!o.isMesh || !o.visible) return
    let vis = true; let q = o; while (q) { if (!q.visible) vis = false; q = q.parent }
    if (!vis) return
    const m = o.material
    const add = m && m.blending === 2
    if (add || (m && m.transparent)) res.push({ uuid: o.uuid, name: o.name, mat: m.type, add, ro: o.renderOrder, geo: o.geometry?.type, uni: m.uniforms ? Object.keys(m.uniforms).slice(0, 8).join(',') : '' })
  })
  return res
})
console.log(JSON.stringify(list, null, 0))
// hide groups one by one
const groups = [...new Set(list.map((x) => x.uni))]
for (let i = 0; i < groups.length; i++) {
  await p.evaluate((g) => {
    const st = window.__r3f()
    st.scene.traverse((o) => { if (o.isMesh && o.material && o.material.uniforms && Object.keys(o.material.uniforms).slice(0, 8).join(',') === g) o.userData.__h = o.visible, o.visible = false })
    st.gl.render(st.scene, st.camera)
  }, groups[i])
  await p.waitForTimeout(3000)
  await p.screenshot({ path: `${out}/h_${i}.png`, timeout: 240000 })
  console.log('hidden group', i, groups[i])
  await p.evaluate((g) => {
    const st = window.__r3f()
    st.scene.traverse((o) => { if (o.userData.__h !== undefined) { o.visible = o.userData.__h; delete o.userData.__h } })
  }, groups[i])
}
await b.close()
