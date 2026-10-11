#!/usr/bin/env python3
"""Prepare a build folder for hosts that only serve web file types.
- 16-bit terrain grids (.u16) -> lossless PNG twins (R = high byte, G = low byte)
- other binaries -> base64 text twins (.b64.txt)
- large maps recompressed to fit the host's per-version budget
usage: python3 scripts/pack-hosted.py dist-preview"""
import base64, json, os, sys
import numpy as np
from PIL import Image
Image.MAX_IMAGE_PIXELS = None
d = sys.argv[1] if len(sys.argv) > 1 else 'dist'
meta = json.load(open(os.path.join(d, 'data/jezero_meta.json')))
for key in ('core', 'far', 'near'):
    p = os.path.join(d, f'data/jezero_{key}.u16')
    a = np.fromfile(p, dtype='<u2').reshape(meta[key]['n'], meta[key]['n'])
    rgb = np.dstack([(a >> 8).astype(np.uint8), (a & 255).astype(np.uint8), np.zeros_like(a, dtype=np.uint8)])
    Image.fromarray(rgb, 'RGB').save(p + '.png', optimize=True)
    os.remove(p)
    print('png', key, os.path.getsize(p + '.png'))
for f in ('models/starship-block3.glb', 'models/perseverance.glb', 'data/stars_hyg_m72.bin'):
    p = os.path.join(d, f)
    open(p + '.b64.txt', 'w').write(base64.b64encode(open(p, 'rb').read()).decode())
    os.remove(p)
    print('b64', f)
for f, q in (('earth_clouds_8k.jpg', 72), ('mars_color_8k.jpg', 82), ('earth_day_8k.jpg', 84), ('mars_normal_4k.jpg', 85), ('milkyway_gaia.jpg', 84)):
    p = os.path.join(d, 'textures', f)
    if os.path.exists(p):
        Image.open(p).save(p, quality=q, optimize=True)
total = sum(os.path.getsize(os.path.join(r, f)) for r, _, fs in os.walk(d) for f in fs)
print('total MB', total / 1e6)
