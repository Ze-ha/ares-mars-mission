# ARES — Earth to Mars

A cinematic, interactive, physically grounded visualization of a Starship-class mission: launch from Starbase, Texas, hot staging, Earth orbit, trans-Mars injection, a 186-day cruise with three trajectory-correction burns, Mars arrival, atmospheric entry, a powered landing and a final view in Jezero Crater, beside Perseverance's landing site.

Built with React, TypeScript, Vite, Three.js, React Three Fiber, drei and postprocessing.

**Live demo:** https://ze-ha.github.io/ares-mars-mission/

## Publish on GitHub Pages

The repository includes a GitHub Actions workflow (`.github/workflows/deploy.yml`) that builds the site and publishes it on every push to `main`. To turn it on once, open **Settings → Pages** in the repository and set **Source** to **GitHub Actions**. The site then lives at `https://<your-user>.github.io/<repo>/`.

## Run it

```bash
npm install
npm run dev            # http://localhost:5173
npm run build          # production build in dist/
npm run build:single   # JS/CSS inlined into one index.html (textures stay in textures/)
```

For hosts that only serve web file types, build with `VITE_HOSTED=1` and then run `node scripts/b64-assets.mjs <outDir>`. This turns the model, terrain and star files into base64 `.b64.txt` copies.

For the best image, run it locally in Chrome or Edge on a machine with a discrete GPU, with `?quality=high`.

URL options: `?quality=low|medium|high`, `?t=162&paused=1` (jump to a mission time), `&free=1` (free camera).

Controls: **Space** play/pause · **1–0** jump to a phase · **C** cinematic/free camera · **T** telemetry · **H** cinema mode · **R** restart · **− / =** speed. Dragging the view at any time hands you a free orbit camera while the mission keeps running.

## Real-world data

| What | Source | Licence |
|---|---|---|
| Starship Block 3 model (ship + Super Heavy) | "SpaceX Starship Block 3" by Clarence365, Sketchfab — https://sketchfab.com/3d-models/spacex-starship-block-3-6f6c6f88a3eb4b4d822fdca66733fbb2 (logos/serials removed) | CC BY 4.0 |
| Jezero Crater terrain | NASA/JPL-Caltech/UArizona HiRISE DTM + MOLA/HRSC, via https://github.com/enomis-dev/perseverance-traverse-3d (Cesium quantized-mesh tiles decoded to heightfields) | NASA public domain |
| Star catalogue | HYG v4.1 (Hipparcos/Yale/Gliese), 19,115 stars to mag 7.2 — https://github.com/astronexus/hyg-database | CC BY-SA 4.0 |
| Earth / Moon / Mars / Milky Way maps | NASA Blue Marble, LRO, Viking/MGS mosaics, NASA SVS Tycho sky map | NASA public domain |
| Jezero orbital imagery | Mars 2020 HiRISE (~1.2 m/px) and CTX (~20 m/px) orthomosaics, NASA/JPL/USGS, via https://github.com/saracen66/the-sol-explorers | NASA public domain |
| Perseverance rover model | NASA 3D Resources — https://github.com/nasa/NASA-3D-Resources | NASA media guidelines |
| Milky Way | ESA/Gaia/DPAC EDR3 all-sky map (via https://github.com/henrysky/milkyway_plot), reprojected to equatorial | CC BY-SA 3.0 IGO |
| 8K Earth clouds | Solar System Scope (via https://github.com/Siqister/files) | CC BY 4.0 |
| 8K Mars colour + MOLA normals | Viking MDIM 2.1 / MGS MOLA (NASA/USGS) | NASA public domain |
| Launch-site materials | ambientCG / Poly Haven (via https://github.com/MorePET/mat-vis) | CC0 |
| Sun, Moon, star-field orientation, Mars rotation | astronomy-engine — https://github.com/cosinekitty/astronomy | MIT |

The mission uses a real 2026 Mars window: launch 2026-11-27 14:21 UTC from Starbase (sun 16° above the horizon), landing 2027-06-02 06:20 UTC in Jezero (afternoon sun 27°). The sky, sun, Moon and Mars' spin are computed for those instants.

## Explore Mars

After touchdown, **Explore Mars** hands you NASA's Perseverance on the real HiRISE terrain of Jezero:
- **Driving:** arrow keys or WASD drive. The speed is the real rover's (about 4 cm/s), shown in 60× time-lapse.
- **Camera:** V switches between the chase camera and Mastcam-Z.
- **Night:** N sets the sun along its real path. The sky, stars, Milky Way and Earth are placed for the date. Earth is a bright evening point about −1.6 mag.
- **Sound:** the rover's motor and wheel sounds plus the thin Martian breeze, quiet from the chase camera and close up from the mast.
- **Direct link:** `?explore` opens the traverse directly, and `?explore&night` opens it at night.

## Render film

The **Film** button renders the mission, or any single phase, to an MP4 file (WebM if H.264 isn't available) on your own GPU. Every frame is rendered exactly, with true motion blur from up to 16 sub-frames and a 180° shutter, at 1080p, 1440p or 4K and 24 or 30 fps. Use a current Chrome or Edge.

## Concept

The experience plays like a documentary: long-lens tracking sites on the ground, vehicle-mounted engineering cameras, and slow, heavy observational moves in space. Realism comes first: real NASA imagery, a physically based atmosphere shared by every view of each planet, true planetary scale, and physically motivated effects.

## Architecture

```
mission clock ─► sampleMission(t) ─► runtime.state ─┬─► world controllers (Earth pad / space / Mars site)
   (pure, deterministic function of time)            ├─► camera director (shot list + blends + free orbit)
                                                     ├─► effects (plumes, particles, plasma, post)
                                                     └─► HUD (rAF → DOM, no React re-renders)
```

- The mission state is a pure function of time. Scrubbing, pausing and replaying are exact.
- There are three worlds with their own units: the launch site in metres, space in kilometres around a floating origin centred on the ship, and the Mars site in metres. All three are mounted up front and their shaders are precompiled, so switching worlds never stutters.
- One fixed light rig is shared by all worlds, so switching worlds never triggers a shader recompile.
- Particles are GPU-driven and deterministic: each particle's position is computed from its spawn time, and trajectory-dependent emitters query the mission function directly.

## Folder structure

```
src/
  mission/     phases, trajectory tracks, store, constants, shared lighting
  scene/       Experience root, world controllers (Earth / Space / Mars), light rig refs
  camera/      shot list, director (blending, shake, free orbit follow)
  assets/
    vehicle/   parametric geometry, PBR materials, engines, Starship & Super Heavy
    launchsite/ tower, chopsticks, mount, tank farm, ground/ocean, cloud deck
    planets/   Earth, Mars, starfield + Milky Way, sun, sky domes
    mars/      landing-site terrain, rock fields
  shaders/     atmosphere (Rayleigh/Mie/ozone), planets, sky, effects, noise
  effects/     particle system, emitters, post-processing (haze, bloom, grade)
  ui/          HUD, loader, formatting
  utils/       math (monotone-cubic tracks), procedural textures
public/textures/  NASA-derived planetary maps
scripts/shots.mjs  headless screenshot verification at any mission time
```

## Asset and modelling plan

| Asset | Approach | Status |
|---|---|---|
| Ship and booster | Starship Block 3 GLB, split into stages, with hinged flaps, heated Raptor nozzles and cryogenic frost. The procedural model is kept for `?quality=low` | Production |
| Steel and heat-shield tiles | Procedural canvas textures: weld rings, brushed grain, hex tiles with tone variation; animated cryogenic frost | Production |
| Tower, mount, pad | Instanced lattice beams, chopsticks, quick-disconnect arm, procedural ground with tidal flats and ocean | Production procedural. Buildings are simple volumes (placeholder-grade) |
| Earth | NASA Blue Marble with bathymetry (4K), night lights, relief normals, 4K cloud map, ray-marched atmosphere with ozone | Production. An 8K+ source would improve very low-altitude views |
| Mars from space | NASA global mosaic plus MOLA relief, procedural craters and detail at close range, dusty atmosphere | Production. A higher-resolution MDIM/CTX mosaic would improve close approach |
| Mars surface | Real Jezero heightfield (40 m core, 400 m surround) with procedural micro-relief, bedrock plates, rock fields and ripples; Perseverance-grounded palette | Production |
| Sky | HYG catalogue stars with true colours at their real positions for the launch/landing date; Milky Way glow from the NASA Tycho map | Production |
| Effects | Shader plumes with Mach diamonds and altitude expansion, deterministic particles, windward entry plasma streaming along the airflow, heat haze | Production |

## Mission stages

Pre-launch → Ignition → Liftoff → Ascent → Stage separation → Earth orbit → Trans-Mars injection → Cruise (three trajectory-correction manoeuvres) → Mars approach (full-planet reveal) → Entry, descent and landing (belly-flop, flip, landing burn) → Landed.

Each phase has a start time in `mission/phases.ts`. Motion comes from monotone-cubic tracks in `mission/trajectory.ts`: altitude, velocity, attitude, throttles, distances and the elapsed mission clock. Distances are interpolated in log space, so Earth and Mars shrink and grow at believable rates.

## Placeholders and next steps

- Real Starbase surroundings from Google Photorealistic 3D Tiles (needs your own API key; run locally).
- Use higher-resolution imagery streamed as KTX2 textures:
  - Earth: an 8K Blue Marble and a cloud time series.
  - Mars: an MDIM/CTX mosaic, and HiRISE patches near the landing site.
- Add volumetric clouds for the ascent, and screen-space soft particles.
- Use a proper orbital-mechanics path (patched conics) instead of the art-directed tracks.
- Add audio: engine rumble with distance delay, and silence in space.
