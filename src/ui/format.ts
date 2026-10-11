const pad = (n: number, w = 2) => String(Math.floor(n)).padStart(w, '0')

/** Mission elapsed time → "T+ 00:02:38" or "T+ 186d 04:12:33". */
export function formatMET(met: number) {
  const sign = met < 0 ? '−' : '+'
  let s = Math.abs(met)
  const d = Math.floor(s / 86400)
  s -= d * 86400
  const h = Math.floor(s / 3600)
  s -= h * 3600
  const m = Math.floor(s / 60)
  s -= m * 60
  return `T${sign} ${d > 0 ? `${d}d ` : ''}${pad(h)}:${pad(m)}:${pad(s)}`
}

export function formatDistance(km: number) {
  if (km < 1) return { v: (km * 1000).toFixed(0), u: 'm' }
  if (km < 100) return { v: km.toFixed(1), u: 'km' }
  if (km < 1e6) return { v: Math.round(km).toLocaleString('en-US'), u: 'km' }
  return { v: (km / 1e6).toFixed(km < 1e7 ? 2 : 1), u: 'M km' }
}

export function formatSpeed(ms: number) {
  return { v: Math.round(ms * 3.6).toLocaleString('en-US'), u: 'km/h' }
}

const MONTHS = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC']
/** "27 NOV 2026 · 14:21:05 UTC" */
export function formatUTC(d: Date) {
  return `${pad(d.getUTCDate())} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()} · ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())} UTC`
}
