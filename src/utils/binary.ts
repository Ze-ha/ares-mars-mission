import { FileLoader, Loader, type LoadingManager } from 'three'
import { GLTFLoader, type GLTF } from 'three/examples/jsm/loaders/GLTFLoader.js'

/**
 * Binary assets (model, terrain, star catalogue).
 *
 * Some static hosts only serve a fixed list of file types. A build made with
 * VITE_HOSTED=1 references a base64 text twin of each binary file
 * (`name.ext.b64.txt`, written by scripts/b64-assets.mjs); every other build
 * loads the raw file.
 */
export const HOSTED = import.meta.env.VITE_HOSTED === '1'
/** hosted twin: 16-bit grids as lossless PNG (R = high byte, G = low byte), other binaries as base64 text */
export const binUrl = (url: string) => (HOSTED ? (url.endsWith('.u16') ? `${url}.png` : `${url}.b64.txt`) : url)

/** Decode a `.u16.png` (R·256 + G, no colour management) back to little-endian uint16 bytes. */
async function decodeU16Png(url: string): Promise<ArrayBuffer> {
  const blob = await (await fetch(url)).blob()
  const bmp = await createImageBitmap(blob, { colorSpaceConversion: 'none', premultiplyAlpha: 'none' })
  const c = new OffscreenCanvas(bmp.width, bmp.height)
  const g = c.getContext('2d', { willReadFrequently: true })!
  g.drawImage(bmp, 0, 0)
  const px = g.getImageData(0, 0, bmp.width, bmp.height).data
  const out = new Uint16Array(bmp.width * bmp.height)
  for (let i = 0; i < out.length; i++) out[i] = (px[i * 4] << 8) | px[i * 4 + 1]
  return out.buffer
}

function decodeB64(s: string): ArrayBuffer {
  const U = Uint8Array as unknown as { fromBase64?: (s: string) => Uint8Array }
  if (U.fromBase64) return U.fromBase64(s.trim()).buffer as ArrayBuffer
  const bin = atob(s.trim())
  const out = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
  return out.buffer
}

/** Loads an ArrayBuffer from a raw file or its `.b64.txt` twin. */
export class BinaryLoader extends Loader<ArrayBuffer> {
  constructor(manager?: LoadingManager) {
    super(manager)
  }
  load(url: string, onLoad: (b: ArrayBuffer) => void, onProgress?: (e: ProgressEvent) => void, onError?: (e: unknown) => void) {
    if (url.endsWith('.u16.png')) {
      this.manager.itemStart(url)
      decodeU16Png(url)
        .then(onLoad, (e) => {
          onError?.(e)
          this.manager.itemError(url)
        })
        .finally(() => this.manager.itemEnd(url))
      return
    }
    const b64 = url.endsWith('.b64.txt')
    const fl = new FileLoader(this.manager)
    fl.setPath(this.path)
    fl.setResponseType(b64 ? 'text' : 'arraybuffer')
    fl.load(
      url,
      (d) => {
        try {
          onLoad(b64 ? decodeB64(d as string) : (d as ArrayBuffer))
        } catch (e) {
          onError?.(e)
        }
      },
      onProgress,
      onError,
    )
  }
}

/** GLTFLoader that also accepts a GLB delivered as a `.b64.txt` twin. */
export class AnyGLTFLoader extends GLTFLoader {
  load(url: string, onLoad: (g: GLTF) => void, onProgress?: (e: ProgressEvent) => void, onError?: (e: unknown) => void) {
    if (!url.endsWith('.b64.txt')) return super.load(url, onLoad, onProgress, onError)
    this.manager.itemStart(url)
    new BinaryLoader().load(
      url,
      (buf) =>
        this.parse(
          buf,
          '',
          (g) => {
            onLoad(g)
            this.manager.itemEnd(url)
          },
          (e) => {
            onError?.(e)
            this.manager.itemError(url)
            this.manager.itemEnd(url)
          },
        ),
      onProgress,
      (e) => {
        onError?.(e)
        this.manager.itemError(url)
        this.manager.itemEnd(url)
      },
    )
  }
}
