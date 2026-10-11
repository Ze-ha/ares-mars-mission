// Explore-mode smoke test: open the rover traverse, drive forward and turn, screenshot.
import { chromium } from 'playwright-core'
const out = process.argv[2]
const b = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome', args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] })
const p = await b.newPage({ viewport: { width: 960, height: 540 } })
const errs = []
p.on('pageerror', (e) => errs.push(e.message))
await p.goto(`${process.env.URL ?? 'http://localhost:8766/index.html'}?t=240&quality=high&explore`)
await p.waitForTimeout(40000)
await p.keyboard.down('ArrowUp')
await p.waitForTimeout(60000)
await p.keyboard.down('ArrowLeft')
await p.waitForTimeout(10000)
await p.keyboard.up('ArrowLeft')
await p.screenshot({ path: `${out}/drive.png`, timeout: 240000 })
await p.keyboard.press('KeyV')
await p.waitForTimeout(8000)
await p.screenshot({ path: `${out}/mast.png`, timeout: 240000 })
console.log('errors:', errs.slice(0, 5))
await b.close()
