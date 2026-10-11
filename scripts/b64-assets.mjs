// Writes a base64 text twin (name.ext.b64.txt) for every binary asset in a build
// folder and removes the raw file, for hosts that only serve web file types.
// usage: node scripts/b64-assets.mjs dist-preview
import { readFileSync, writeFileSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'
const dir = process.argv[2] || 'dist'
for (const f of ['models/starship-block3.glb', 'data/jezero_core.u16', 'data/jezero_far.u16', 'data/jezero_near.u16', 'data/stars_hyg_m72.bin']) {
  const p = join(dir, f)
  writeFileSync(p + '.b64.txt', readFileSync(p).toString('base64'))
  unlinkSync(p)
  console.log('encoded', f)
}
