// Headless verification: renders the experience at given mission times and saves screenshots.
// usage: node scripts/shots.mjs <outDir> <t1> <t2> ...   (use "idle" for the start screen)
import { chromium } from 'playwright-core'
const [out, ...times] = process.argv.slice(2)
const url = process.env.URL ?? 'http://localhost:8766/index.html'
const wait = Number(process.env.WAIT ?? 30000)
const b = await chromium.launch({
  executablePath: process.env.CHROME ?? '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
  args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'],
})
for (const t of times) {
  const p = await b.newPage({ viewport: { width: Number(process.env.VW ?? 960), height: Number(process.env.VH ?? 540) } })
  const errs = []
  p.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warning') errs.push(m.text().slice(0, 400)) })
  p.on('response', (r) => { if (r.status() >= 400) errs.push('HTTP ' + r.status() + ' ' + r.url()) })
  p.on('pageerror', (e) => errs.push('PAGEERR ' + e.message + ' @ ' + (e.stack||'').split('\n').slice(1,3).join(' | ')))
  const q = t === 'idle' ? '' : `?t=${t}&paused=1&quality=${process.env.Q ?? 'medium'}${process.env.EXTRA ?? ''}`
  await p.goto(url + q)
  await p.waitForTimeout(wait)
  await p.screenshot({ path: `${out}/s_${t}.png`, timeout: 240000 })
  console.log(t, [...new Set(errs)].slice(0, 5).join('\n   '))
  await p.close()
}
await b.close()
