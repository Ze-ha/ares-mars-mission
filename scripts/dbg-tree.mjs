import { chromium } from 'playwright-core'
const b = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome', args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] })
const p = await b.newPage({ viewport: { width: 640, height: 360 } })
await p.goto(`http://localhost:8766/index.html?t=${process.argv[2]}&paused=1&quality=high&debug${process.env.EXTRA ?? ''}`)
await p.waitForTimeout(40000)
const r = await p.evaluate(() => {
  const st = window.__r3f(); const out = []
  const walk = (o, d) => { if (d < 4 || o.isMesh || o.isPoints) out.push(' '.repeat(d) + `${o.type}${o.visible ? '' : '(hidden)'} ${o.name} ${o.material?.type ?? ''} ${o.geometry?.type ?? ''} n=${o.children.length} ro=${o.renderOrder} ${o.isInstancedMesh ? 'inst' + o.count : ''} ${o.geometry?.attributes?.position?.count ?? ''}`)
    if (d < 6 && o.visible) o.children.forEach((c) => walk(c, d + 1)) }
  walk(st.scene, 0)
  const c = st.camera; out.push('cam ' + c.position.toArray().map((v) => v.toFixed(1)) + ' near ' + c.near + ' far ' + c.far)
  return out.filter((l) => !/mars_2020|aluminum|gunmetal|brass|bronze|paint_white|glass|blades|grey_brushed/.test(l)).slice(0, 150)
})
console.log(r.join('\n'))
await b.close()
