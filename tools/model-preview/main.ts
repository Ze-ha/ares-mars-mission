import * as THREE from 'three'
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js'
import { MeshoptDecoder } from 'three/examples/jsm/libs/meshopt_decoder.module.js'
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js'
const r = new THREE.WebGLRenderer({ antialias: true }); r.setSize(innerWidth, innerHeight); document.body.appendChild(r.domElement)
r.toneMapping = THREE.ACESFilmicToneMapping
const scene = new THREE.Scene(); scene.background = new THREE.Color(0x303236)
scene.environment = new THREE.PMREMGenerator(r).fromScene(new RoomEnvironment(), 0.04).texture
const sun = new THREE.DirectionalLight(0xffffff, 2.5); sun.position.set(5, 8, 6); scene.add(sun)
const cam = new THREE.PerspectiveCamera(30, innerWidth / innerHeight, 0.1, 10000)
const params = new URLSearchParams(location.search)
new GLTFLoader().setMeshoptDecoder(MeshoptDecoder).load('./starship-block3.glb', (g) => {
  const root = g.scene; scene.add(root); root.updateMatrixWorld(true)
  const box = new THREE.Box3().setFromObject(root); const size = box.getSize(new THREE.Vector3()); const c = box.getCenter(new THREE.Vector3())
  const info: string[] = [`size ${size.toArray().map(v=>v.toFixed(2))} center ${c.toArray().map(v=>v.toFixed(2))}`]
  root.traverse((o) => { if (o.name && !o.name.startsWith('Object_')) { const b = new THREE.Box3().setFromObject(o); const s=b.getSize(new THREE.Vector3()); const cc=b.getCenter(new THREE.Vector3()); info.push(`${o.name}: size ${s.toArray().map(v=>v.toFixed(2))} c ${cc.toArray().map(v=>v.toFixed(2))}`) } })
  ;(window as any).__info = info.join('\n')
  const view = params.get('v') ?? 'full'
  const L = Math.max(size.x, size.y, size.z)
  if (view === 'full') { cam.position.set(c.x + L * 0.9, c.y + L * 0.1, c.z + L * 0.9); cam.lookAt(c) }
  else if (view === 'top') { const t = new THREE.Vector3(c.x, box.max.y - size.y*0.2, c.z); cam.position.copy(t).add(new THREE.Vector3(size.x*1.2, 2, size.z*2.5)); cam.lookAt(t) }
  else if (view === 'aft') { const t = new THREE.Vector3(c.x, box.min.y + size.y*0.03, c.z); cam.position.copy(t).add(new THREE.Vector3(size.x*1.5, -size.x*0.8, size.x*1.5)); cam.lookAt(t) }
  cam.near = L / 1000; cam.far = L * 10; cam.updateProjectionMatrix()
  r.render(scene, cam); (window as any).__done = true
})
