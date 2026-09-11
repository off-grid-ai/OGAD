import { useEffect, useRef, useState } from 'react'
import * as THREE from 'three'
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js'
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js'
import aresModelUrl from '../../../../resources/god-twin/ares.glb?url'

type GodTwinState = 'idle' | 'walking' | 'running' | 'fighting' | 'resting'
type ResizeEdge = 'n' | 'ne' | 'e' | 'se' | 's' | 'sw' | 'w' | 'nw'

const RESIZE_HANDLES: ReadonlyArray<{ edge: ResizeEdge; className: string }> = [
  { edge: 'ne', className: 'right-0 top-0 cursor-ne-resize' },
  { edge: 'se', className: 'right-0 bottom-0 cursor-se-resize' },
  { edge: 'sw', className: 'left-0 bottom-0 cursor-sw-resize' },
  { edge: 'nw', className: 'left-0 top-0 cursor-nw-resize' }
]

const ACTIONS: ReadonlyArray<{ label: string; symbol: string; state: GodTwinState }> = [
  { label: 'Run', symbol: '»', state: 'running' },
  { label: 'Walk', symbol: '›', state: 'walking' },
  { label: 'Fight', symbol: '⚔', state: 'fighting' },
  { label: 'Rest', symbol: 'Ⅱ', state: 'resting' }
]

function disposeMaterial(material: THREE.Material): void {
  for (const value of Object.values(material as unknown as Record<string, unknown>)) {
    if ((value as THREE.Texture | undefined)?.isTexture) (value as THREE.Texture).dispose()
  }
  material.dispose()
}

export function GodTwinCompanion(): React.ReactElement {
  const hostRef = useRef<HTMLDivElement>(null)
  const spinRef = useRef(false)
  const playStateRef = useRef<((state: GodTwinState) => void) | null>(null)
  const [, setReady] = useState(false)
  const [selectedState, setSelectedState] = useState<GodTwinState>('idle')
  const [spinning, setSpinning] = useState(false)
  const [listening, setListening] = useState(false)

  useEffect(() => {
    const host = hostRef.current
    if (!host) return
    console.log('[god-twin] renderer mounted', { model: aresModelUrl })

    const scene = new THREE.Scene()
    const camera = new THREE.PerspectiveCamera(30, 1, 0.01, 1000)
    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true })
    renderer.outputColorSpace = THREE.SRGBColorSpace
    renderer.toneMapping = THREE.NoToneMapping
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2))
    renderer.setClearColor(0x000000, 0)
    renderer.domElement.className = 'h-full w-full'
    host.appendChild(renderer.domElement)
    const orbit = new OrbitControls(camera, renderer.domElement)
    orbit.enableDamping = true
    orbit.enablePan = false
    orbit.enableZoom = true
    orbit.minPolarAngle = Math.PI * 0.45
    orbit.maxPolarAngle = Math.PI * 0.55

    let pointerStart: { x: number; y: number } | null = null
    let pointerMoved = false
    const pointerDown = (event: PointerEvent): void => {
      pointerStart = { x: event.clientX, y: event.clientY }
      pointerMoved = false
    }
    const pointerMove = (event: PointerEvent): void => {
      if (!pointerStart) return
      if (Math.hypot(event.clientX - pointerStart.x, event.clientY - pointerStart.y) > 4) {
        pointerMoved = true
      }
    }
    const pointerUp = (): void => {
      if (pointerStart && !pointerMoved) void window.api.godTwin?.wake()
      pointerStart = null
    }
    const pointerCancel = (): void => {
      pointerStart = null
    }
    renderer.domElement.addEventListener('pointerdown', pointerDown)
    renderer.domElement.addEventListener('pointermove', pointerMove)
    renderer.domElement.addEventListener('pointerup', pointerUp)
    renderer.domElement.addEventListener('pointercancel', pointerCancel)

    scene.add(new THREE.HemisphereLight(0xffffff, 0x1e1e1e, 2.2))
    const keyLight = new THREE.DirectionalLight(0xffffff, 3.5)
    keyLight.position.set(4, 6, 5)
    scene.add(keyLight)
    const rimLight = new THREE.DirectionalLight(0x34d399, 1.5)
    rimLight.position.set(-4, 3, -4)
    scene.add(rimLight)

    let mixer: THREE.AnimationMixer | null = null
    let currentAction: THREE.AnimationAction | null = null
    let desiredState: GodTwinState = 'idle'
    const actions = new Map<GodTwinState, THREE.AnimationAction>()
    let loadedRoot: THREE.Object3D | null = null
    let animationFrame = 0
    let disposed = false
    const clock = new THREE.Clock()

    const makeInPlace = (clip: THREE.AnimationClip): THREE.AnimationClip => {
      const prepared = clip.clone()
      for (const track of prepared.tracks) {
        if (!track.name.endsWith('Hips.position')) continue
        const values = track.values
        const itemSize = track.getValueSize()
        const startX = values[0] ?? 0
        const startZ = values[2] ?? 0
        for (let index = 0; index < values.length; index += itemSize) {
          values[index] = startX
          if (itemSize >= 3) values[index + 2] = startZ
        }
      }
      prepared.optimize()
      return prepared
    }

    const resize = (): void => {
      const width = Math.max(host.clientWidth, 1)
      const height = Math.max(host.clientHeight, 1)
      renderer.setSize(width, height, false)
      camera.aspect = width / height
      camera.updateProjectionMatrix()
    }
    const resizeObserver = new ResizeObserver(resize)
    resizeObserver.observe(host)
    resize()

    const playState = (state: GodTwinState): void => {
      console.log(`[god-twin] state ${state}`)
      desiredState = state
      const next = actions.get(state) ?? actions.get('resting') ?? actions.get('running')
      if (!next || next === currentAction) return
      next.reset().setLoop(THREE.LoopRepeat, Infinity).fadeIn(0.35).play()
      currentAction?.fadeOut(0.35)
      currentAction = next
    }
    playStateRef.current = playState
    const offState = window.api.godTwin?.onState(playState)
    const offListening = window.api.godTwin?.onListening(setListening)
    void window.api.godTwin?.getPreferences().then((saved) => {
      if (disposed) return
      spinRef.current = saved.spinning
      setSpinning(saved.spinning)
      setSelectedState(saved.state)
      playState(saved.state)
    })

    new GLTFLoader().load(
      aresModelUrl,
      (gltf) => {
        if (disposed) return
        console.log(
          `[god-twin] Ares loaded ${JSON.stringify({
            animations: gltf.animations.map((clip) => clip.name),
            children: gltf.scene.children.length
          })}`
        )
        loadedRoot = gltf.scene
        gltf.scene.traverse((object) => {
          if (!(object instanceof THREE.Mesh)) return
          const materialWasArray = Array.isArray(object.material)
          const materials = materialWasArray ? object.material : [object.material]
          console.log(
            `[god-twin] mesh ${object.name} materials ${JSON.stringify(
              materials.map((material) => ({
                name: material.name,
                hasMap: Boolean((material as THREE.MeshStandardMaterial).map),
                opacity: material.opacity
              }))
            )}`
          )
          const displayMaterials = materials.map((material) => {
            const source = material as THREE.MeshStandardMaterial
            if (source.map) {
              source.map.colorSpace = THREE.SRGBColorSpace
              source.map.needsUpdate = true
            }
            return new THREE.MeshBasicMaterial({
              map: source.map ?? null,
              color: source.color,
              transparent: source.transparent,
              opacity: source.opacity,
              side: source.side,
              toneMapped: false
            })
          })
          object.material = materialWasArray ? displayMaterials : displayMaterials[0]!
        })
        scene.add(gltf.scene)
        const bounds = new THREE.Box3().setFromObject(gltf.scene)
        const size = bounds.getSize(new THREE.Vector3())
        const center = bounds.getCenter(new THREE.Vector3())
        const distance = Math.max(size.x, size.y, size.z) / (2 * Math.tan((30 * Math.PI) / 360))
        camera.near = Math.max(distance / 100, 0.01)
        camera.far = distance * 100
        camera.position.set(center.x, center.y + size.y * 0.02, center.z + distance * 1.08)
        camera.lookAt(center)
        orbit.target.copy(center)
        orbit.update()
        camera.updateProjectionMatrix()
        mixer = new THREE.AnimationMixer(gltf.scene)
        const findClip = (...terms: string[]): THREE.AnimationClip | undefined =>
          gltf.animations.find((clip) => {
            const name = clip.name.toLowerCase()
            return terms.some((term) => name.includes(term))
          })
        const addAction = (state: GodTwinState, clip?: THREE.AnimationClip): void => {
          if (clip && mixer) actions.set(state, mixer.clipAction(makeInPlace(clip)))
        }
        addAction('running', findClip('running', 'run'))
        addAction('walking', findClip('walking', 'walk'))
        addAction('fighting', findClip('attack', 'fight', 'combat'))
        addAction('idle', findClip('cautious crouch', 'hide', 'crouch'))
        addAction('resting', findClip('restpose', 'rest', 'idle'))
        playState(desiredState)
        setReady(true)
      },
      (event) => {
        if (event.total > 0 && event.loaded === event.total) {
          console.log('[god-twin] Ares download complete', { bytes: event.loaded })
        }
      },
      (error) => {
        console.error('[god-twin] failed to load Ares', error)
        if (!disposed) setReady(false)
      }
    )

    const render = (): void => {
      animationFrame = window.requestAnimationFrame(render)
      mixer?.update(clock.getDelta())
      orbit.autoRotate = spinRef.current
      orbit.autoRotateSpeed = 1
      orbit.update()
      renderer.render(scene, camera)
    }
    render()

    return () => {
      disposed = true
      window.cancelAnimationFrame(animationFrame)
      resizeObserver.disconnect()
      offState?.()
      offListening?.()
      playStateRef.current = null
      orbit.dispose()
      renderer.domElement.removeEventListener('pointerdown', pointerDown)
      renderer.domElement.removeEventListener('pointermove', pointerMove)
      renderer.domElement.removeEventListener('pointerup', pointerUp)
      renderer.domElement.removeEventListener('pointercancel', pointerCancel)
      mixer?.stopAllAction()
      loadedRoot?.traverse((object) => {
        if (!(object instanceof THREE.Mesh)) return
        object.geometry.dispose()
        const materials = Array.isArray(object.material) ? object.material : [object.material]
        materials.forEach(disposeMaterial)
      })
      renderer.dispose()
      renderer.domElement.remove()
    }
  }, [])

  const beginResize = (edge: ResizeEdge, event: React.PointerEvent<HTMLDivElement>): void => {
    event.preventDefault()
    event.stopPropagation()
    const target = event.currentTarget
    let lastX = event.screenX
    let lastY = event.screenY
    target.setPointerCapture(event.pointerId)
    const move = (next: PointerEvent): void => {
      window.api.godTwin?.resize(edge, next.screenX - lastX, next.screenY - lastY)
      lastX = next.screenX
      lastY = next.screenY
    }
    const stop = (): void => {
      target.removeEventListener('pointermove', move)
      target.removeEventListener('pointerup', stop)
      target.removeEventListener('pointercancel', stop)
    }
    target.addEventListener('pointermove', move)
    target.addEventListener('pointerup', stop)
    target.addEventListener('pointercancel', stop)
  }

  return (
    <main className="relative h-screen w-screen overflow-hidden bg-transparent font-mono">
      <div className="god-twin-drag absolute inset-x-0 top-0 z-10 h-8" />
      <div ref={hostRef} className="absolute inset-x-0 top-0 bottom-8 cursor-grab active:cursor-grabbing" />
      <div className="god-twin-controls god-twin-no-drag absolute inset-x-0 bottom-0 z-10 flex h-7 w-full items-center justify-between gap-0.5 rounded-md bg-white/90 p-0.5 shadow-sm backdrop-blur">
        <div
          className="god-twin-drag flex h-6 min-w-0 flex-1 cursor-move items-center justify-center text-[11px] text-neutral-500"
          title="Move Ares"
          aria-label="Move Ares"
        >
          ⠿
        </div>
        <button
          type="button"
          className={`god-twin-no-drag flex h-6 min-w-0 flex-1 items-center justify-center rounded text-[10px] font-medium text-white ${listening ? 'bg-emerald-400' : 'bg-emerald-600'}`}
          title={listening ? 'Listening' : 'Listen'}
          aria-label={listening ? 'Listening' : 'Listen'}
          aria-pressed={listening}
          onClick={() => void window.api.godTwin?.wake()}
        >
          {listening ? '◉' : '●'}
        </button>
        <button
          type="button"
          className="god-twin-no-drag flex h-6 min-w-0 flex-1 items-center justify-center rounded text-[11px] text-neutral-700 hover:bg-black/5"
          title="Hide Ares"
          aria-label="Hide Ares"
          onClick={() => void window.api.godTwin?.setEnabled(false)}
        >
          ◒
        </button>
        {ACTIONS.map(({ label, symbol, state }) => (
          <button
            key={state}
            type="button"
            className={`god-twin-no-drag flex h-6 min-w-0 flex-1 items-center justify-center rounded text-[11px] text-neutral-700 hover:bg-black/5 ${selectedState === state ? 'bg-black/5' : ''}`}
            title={label}
            aria-label={label}
            onClick={() => {
              setSelectedState(state)
              playStateRef.current?.(state)
              void window.api.godTwin?.setPreferences({ state })
            }}
          >
            {symbol}
          </button>
        ))}
        <label
          className={`god-twin-no-drag flex h-6 min-w-0 flex-1 cursor-pointer items-center justify-center rounded text-[12px] hover:bg-black/5 ${spinning ? 'bg-emerald-100 text-emerald-800' : 'text-neutral-700'}`}
          title="Spin Ares gently"
        >
          <input
            type="checkbox"
            checked={spinning}
            className="sr-only"
            onChange={(event) => {
              spinRef.current = event.target.checked
              setSpinning(event.target.checked)
              void window.api.godTwin?.setPreferences({ spinning: event.target.checked })
            }}
          />
          ↻
        </label>
      </div>
      {RESIZE_HANDLES.map(({ edge, className }) => (
        <div
          key={edge}
          className={`god-twin-no-drag absolute z-20 h-5 w-5 ${className}`}
          onPointerDown={(event) => beginResize(edge, event)}
        />
      ))}
    </main>
  )
}
