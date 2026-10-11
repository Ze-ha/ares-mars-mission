// same frame, same camera: render to a float target with one renderable hidden at a time; count black pixels in a region
import { chromium } from 'playwright-core'
const b = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome', args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] })
const p = await b.newPage({ viewport: { width: 640, height: 360 } })
await p.goto(`http://localhost:8766/index.html?t=${process.argv[2]}&paused=1&quality=high&debug${process.env.EXTRA ?? ''}`)
await p.waitForTimeout(40000)
const r = await p.evaluate((reg) => {
  const [x0, y0, x1, y1] = reg.split(',').map(Number)
  const st = window.__r3f(); const gl = st.gl; const cam = st.camera; const scene = st.scene
  const { WebGLRenderTarget, FloatType } = window.__RT
  const W = gl.domElement.width, H = gl.domElement.height, k = W / 640
  const rt = new WebGLRenderTarget(W, H, { type: FloatType })
  const rx = Math.round(x0 * k), ry = Math.round(H - y1 * k), rw = Math.round((x1 - x0) * k), rh = Math.round((y1 - y0) * k)
  const buf = new Float32Array(rw * rh * 4)
  const measure = () => { gl.setRenderTarget(rt); gl.clear(); gl.render(scene, cam); gl.readRenderTargetPixels(rt, rx, ry, rw, rh, buf); gl.setRenderTarget(null)
    let black = 0, sum = 0; const rows = []
    for (let y = 0; y < rh; y++) { let row = ''; for (let x = 0; x < rw; x++) { const i = (y * rw + x) * 4; const l = buf[i] + buf[i + 1] + buf[i + 2]; sum += l; if (l < 1e-5) black++; if (x % 2 === 0) row += l < 1e-5 ? '#' : l < 0.02 ? '.' : ' ' } if (y % 2 === 0) rows.unshift(row) }
    return { black, mean: sum / (rw * rh), rows } }
  const base = measure()
  const items = []
  const rover = []
  scene.traverse((o) => { if (!(o.isMesh || o.isPoints || o.isLine) || !o.visible) return; let v = true; let q = o.parent; while (q) { if (!q.visible) v = false; q = q.parent } if (!v) return
    if (o.material?.name) rover.push(o); else items.push(o) })
  const res = []
  const test = (label, objs) => { objs.forEach((o) => (o.visible = false)); const m = measure(); objs.forEach((o) => (o.visible = true)); res.push({ label, black: m.black, mean: m.mean.toFixed(4) }) }
  test('rover', rover)
  items.forEach((o, i) => test(`${i} ${o.type} ${o.material?.type} ${o.geometry?.type} v${o.geometry?.attributes?.position?.count} ro${o.renderOrder} ${o.isInstancedMesh ? 'inst' : ''} u:${o.material?.uniforms ? Object.keys(o.material.uniforms).slice(0, 4) : ''}`, [o]))
  return { W, H, base: { black: base.black, mean: base.mean.toFixed(4) }, map: base.rows.join('\n'), cam: cam.position.toArray().map((v) => +v.toFixed(1)), res }
}, process.env.REG || '440,220,640,300')
console.log(r.map); delete r.map
console.log(JSON.stringify(r, null, 1))
await b.close()
