import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { viteSingleFile } from 'vite-plugin-singlefile'

// `npm run build`        -> normal multi-file production build (textures in /textures)
// `npm run build:single` -> JS + CSS + fonts inlined into one index.html (textures stay external)
export default defineConfig(({ mode }) => ({
  base: './',
  plugins: [react(), ...(mode === 'single' ? [viteSingleFile({ removeViteModuleLoader: true })] : [])],
  build: {
    target: 'es2022',
    chunkSizeWarningLimit: 4000,
    assetsInlineLimit: mode === 'single' ? 100_000_000 : 4096,
  },
}))
