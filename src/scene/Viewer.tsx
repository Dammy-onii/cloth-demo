import { ContactShadows, Environment, Lightformer, OrbitControls, SoftShadows } from '@react-three/drei'
import { Canvas, useFrame, useThree } from '@react-three/fiber'
import { useEffect, useMemo, useRef } from 'react'
import * as THREE from 'three'
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js'
import { GTAOPass } from 'three/examples/jsm/postprocessing/GTAOPass.js'
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js'
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js'
import type { Stage } from './stage'

/**
 * Ambient occlusion (GTAO) darkens creases, armpits, folds and where shoes meet the floor, as in a
 * photo; without it the studio render looked flat and CG. Returns the scene render + AO passes;
 * the caller adds tone mapping (OutputPass) to the screen or to an 8-bit target.
 */
function occludedRender(gl: THREE.WebGLRenderer, scene: THREE.Scene, camera: THREE.Camera, width: number, height: number) {
  const composer = new EffectComposer(gl)
  composer.setSize(width, height)
  composer.addPass(new RenderPass(scene, camera))
  const ao = new GTAOPass(scene, camera, width, height)
  // stronger and wider than first tuned: the guide renders have deep contact shadow in folds and
  // where a coat lies over a shirt, and at 1.2 our layers looked pasted on
  ao.updateGtaoMaterial({ radius: 0.24, distanceExponent: 1.5, thickness: 1, scale: 1.7, samples: 16 })
  ao.updatePdMaterial({ lumaPhi: 10, depthPhi: 2, normalPhi: 3, radius: 6, rings: 2, samples: 16 })
  composer.addPass(ao)
  return composer
}

/** Renders the frame through the AO composer instead of R3F's plain render. */
function StudioEffects() {
  const { gl, scene, camera, size } = useThree()
  const composer = useMemo(() => {
    const c = occludedRender(gl, scene, camera, size.width, size.height)
    c.addPass(new OutputPass())
    return c
  }, [gl, scene, camera]) // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => composer.setSize(size.width, size.height), [composer, size])
  useEffect(() => () => composer.dispose(), [composer])
  useFrame((_, dt) => composer.render(dt), 1)
  return null
}

/** Dev aid: `window.__snapshot(view)` renders a 900×1200 still from a fixed camera and returns a data URL. */
function SnapshotHook({ stage }: { stage: Stage }) {
  const { gl, scene } = useThree()
  useEffect(() => {
    if (!import.meta.env.DEV) return
    const views: Record<string, [number[], number[]]> = {
      top: [[0, 3.35, 0.14], [0, 1.05, 0]],
      bottom: [[0, -1.85, 0.35], [0, 0.68, 0]],
      inclineFrontL: [[2.05, 1.9, 2.7], [0, 0.95, 0]],
      inclineFrontR: [[-2.05, 1.9, 2.7], [0, 0.95, 0]],
      inclineBackL: [[2.05, 1.9, -2.7], [0, 0.95, 0]],
      inclineBackR: [[-2.05, 1.9, -2.7], [0, 0.95, 0]],
      front: [[0, 1.0, 3.2], [0, 0.95, 0]],
      side: [[3.2, 1.0, 0], [0, 0.95, 0]],
      head: [[0.25, 1.55, 0.9], [0, 1.5, 0]],
      headside: [[0.95, 1.55, 0.05], [0, 1.5, 0]],
      chest: [[0.35, 1.3, 0.85], [0, 1.22, 0]],
      chestside: [[0.95, 1.25, 0.05], [0, 1.22, 0]],
      feet: [[0.45, 0.3, 0.75], [0, 0.06, 0.03]],
      back: [[0, 1.0, -3.2], [0, 0.95, 0]],
      shoulders: [[0.0, 1.45, 1.4], [0, 1.3, 0]],
      sideR: [[-3.2, 1.0, 0], [0, 0.95, 0]],
      headhi: [[0.25, 1.7, 0.9], [0, 1.64, 0]],
      headsidehi: [[0.95, 1.7, 0.05], [0, 1.64, 0]],
      headback: [[-0.35, 1.66, -0.9], [0, 1.58, 0]],
      face: [[0.12, 1.53, 0.55], [0, 1.52, 0]],
      faceside: [[0.55, 1.53, -0.1], [0, 1.5, -0.03]],
      earback: [[0.45, 1.55, -0.5], [0.05, 1.52, -0.06]],
      earbackR: [[-0.45, 1.55, -0.5], [-0.05, 1.52, -0.06]],
      feetback: [[-0.35, 0.3, -0.8], [0, 0.06, -0.02]],
      thighs: [[0.05, 0.7, 1.3], [0, 0.65, 0]],
      thighsback: [[-0.05, 0.7, -1.3], [0, 0.65, 0]],
      eyes: [[0.03, 1.535, 0.32], [0, 1.53, 0]],
      eyesM: [[0.03, 1.665, 0.32], [0, 1.66, 0]],
      feetside: [[0.8, 0.18, 0.15], [0.1, 0.06, 0.02]],
      armR: [[-0.75, 1.3, 0.75], [-0.25, 1.18, 0]],
      handR: [[-0.5, 0.95, 0.45], [-0.2, 0.82, 0.03]],
    }
    ;(window as unknown as Record<string, unknown>).__stage = stage
    // a view is a name, or an explicit [eye, target] camera (the face correspondence frames each head straight on)
    ;(window as unknown as Record<string, unknown>).__snapshot = (view: string | [number[], number[]] = 'front', reduced = false) => {
      const width = reduced ? 540 : 900, height = reduced ? 720 : 1200
      // Finish any running morph / drape: rAF is paused while the page is in the background.
      for (let i = 0; i < 120 && !stage.idle; i++) stage.update(1 / 30)
      const [eye, target] = Array.isArray(view) ? view : views[view] ?? views.front
      return renderStill(gl, scene, eye, target, width, height, view === 'head' ? 30 : 35, view === 'bottom')
    }
  }, [gl, scene, stage])
  // the app's own renders (the head studio's views for Claude), in production too
  useEffect(() => {
    stage.renderView = (eye, target, width = 600, height = 800) => renderStill(gl, scene, eye, target, width, height, 30, false)
  }, [gl, scene, stage])
  return null
}

/** A still from a fixed camera, as a JPEG data URL. */
function renderStill(gl: THREE.WebGLRenderer, scene: THREE.Scene, eye: number[], target: number[], width: number, height: number, fov: number, fromBelow: boolean) {
  {
    {
      const cam = new THREE.PerspectiveCamera(fov, width / height, 0.05, 20)
      cam.position.fromArray(eye)
      cam.lookAt(new THREE.Vector3().fromArray(target))
      // plain (linear) target: the OutputPass already writes sRGB, and an sRGB target would encode it twice
      const rt = new THREE.WebGLRenderTarget(width, height, { samples: width < 600 ? 0 : 4 })
      const composer = occludedRender(gl, scene, cam, width, height)
      composer.renderToScreen = false
      const hidden = fromBelow ? ['studio-ground', 'studio-contact-shadow']
        .map(name => scene.getObjectByName(name)).filter(object => object?.visible) : []
      for (const object of hidden) if (object) object.visible = false
      try { composer.render() }
      finally { for (const object of hidden) if (object) object.visible = true }
      // tone map into the 8-bit target that is read back
      const output = new OutputPass()
      output.render(gl, rt, composer.readBuffer, 0, false)
      output.dispose()
      for (const pass of composer.passes) pass.dispose()
      composer.dispose()
      const px = new Uint8Array(width * height * 4)
      gl.readRenderTargetPixels(rt, 0, 0, width, height, px)
      gl.setRenderTarget(null)
      rt.dispose()
      const c = document.createElement('canvas')
      c.width = width
      c.height = height
      const img = c.getContext('2d')!.createImageData(width, height)
      for (let y = 0; y < height; y++) img.data.set(px.subarray((height - 1 - y) * width * 4, (height - y) * width * 4), y * width * 4)
      c.getContext('2d')!.putImageData(img, 0, 0)
      return c.toDataURL('image/jpeg', 0.85)
    }
  }
}

const STUDIO_GREY = '#cfcfcf'

function StageMeshes({ stage, garmentVisible }: { stage: Stage; garmentVisible: boolean }) {
  const shoes = useRef<THREE.Mesh>(null), cloth = useRef<THREE.Group>(null)
  useFrame((_, dt) => {
    stage.update(dt)
    // the head studio shows the head alone
    if (shoes.current) shoes.current.visible = !stage.studio
    if (cloth.current) cloth.current.visible = garmentVisible && !stage.studio
  })
  return (
    <>
      <mesh geometry={stage.bodyGeometry} material={stage.skin} castShadow receiveShadow />
      <mesh ref={shoes} geometry={stage.shoeGeometry} material={stage.shoe} castShadow receiveShadow />
      <mesh geometry={stage.hairGeometry} material={stage.hair} castShadow receiveShadow />
      <mesh geometry={stage.strandGeometry} material={stage.strands} receiveShadow frustumCulled={false} />
      <mesh geometry={stage.eyeGeometry} material={stage.eyeMat} />
      <group ref={cloth}>
        {Object.entries(stage.layers).map(([name, layer]) => (
          <mesh key={name} geometry={layer.geometry} material={[layer.front, layer.back]} castShadow receiveShadow />
        ))}
      </group>
    </>
  )
}

export function Viewer({
  stage,
  turntable,
  garmentVisible,
  focus = 'body',
  onCanvas,
}: {
  stage: Stage
  turntable: boolean
  garmentVisible: boolean
  /** 'head': frame the head close up (the head studio) */
  focus?: 'body' | 'head'
  onCanvas: (c: HTMLCanvasElement) => void
}) {
  return (
    <Canvas
      shadows
      dpr={[1, 1.75]}
      camera={{ position: [0, 1.15, 3.1], fov: 35 }}
      gl={{ preserveDrawingBuffer: true, antialias: true, toneMapping: THREE.ACESFilmicToneMapping }}
      onCreated={({ gl }) => {
        gl.localClippingEnabled = true
        // Reading each shader's error log blocks until it has compiled: new outfit materials stalled
        // a frame for seconds. Keep the check for development only.
        gl.debug.checkShaderErrors = import.meta.env.DEV
        onCanvas(gl.domElement)
      }}
    >
      {/* Photo studio: grey seamless backdrop (the floor fades into it through the fog), a soft
          key light with soft-edged shadows, a dim fill and a rim light from behind */}
      <color attach="background" args={[STUDIO_GREY]} />
      <fog attach="fog" args={[STUDIO_GREY, 6, 14]} />
      <SoftShadows size={40} samples={16} focus={0.4} />
      <hemisphereLight args={['#ffffff', '#b8b8b8', 0.45]} />
      <directionalLight position={[2.2, 4.2, 3]} intensity={2.0} castShadow shadow-mapSize={[2048, 2048]} shadow-bias={-0.0004}>
        <orthographicCamera attach="shadow-camera" args={[-1.4, 1.4, 2.3, -0.3, 0.1, 10]} />
      </directionalLight>
      <directionalLight position={[-3, 2, 2]} intensity={0.55} />
      <directionalLight position={[-1.5, 3, -3.5]} intensity={1.2} />
      <group name="studio-ground">
      <mesh rotation-x={-Math.PI / 2} receiveShadow>
        <circleGeometry args={[14, 64]} />
        <meshStandardMaterial color="#a9a9a9" roughness={0.95} />
      </mesh>
      </group>
      {/* Studio softboxes built locally — no HDR download needed */}
      <Environment resolution={256}>
        <Lightformer form="rect" intensity={2} position={[0, 3, 2]} scale={[4, 2, 1]} />
        <Lightformer form="rect" intensity={1} position={[-3, 1.5, 0]} rotation-y={Math.PI / 2} scale={[3, 2, 1]} />
        <Lightformer form="rect" intensity={1.4} position={[1, 2.5, -3]} rotation-y={Math.PI} scale={[3, 2, 1]} />
      </Environment>
      <StageMeshes stage={stage} garmentVisible={garmentVisible} />
      <SnapshotHook stage={stage} />
      <group name="studio-contact-shadow"><ContactShadows position={[0, 0.002, 0]} scale={3} blur={3} opacity={0.3} far={1.2} /></group>
      <StudioEffects />
      <OrbitControls makeDefault target={[0, 1.0, 0]} autoRotate={turntable} autoRotateSpeed={1.6} minDistance={focus === 'head' ? 0.25 : 1.2} maxDistance={6} enableDamping />
      <CameraFocus stage={stage} focus={focus} />
    </Canvas>
  )
}

/** Frame the whole figure, or the head close up (the head studio), when the focus changes. */
function CameraFocus({ stage, focus }: { stage: Stage; focus: 'body' | 'head' }) {
  const { camera, controls } = useThree() as unknown as { camera: THREE.PerspectiveCamera; controls: { target: THREE.Vector3; update(): void } | null }
  useEffect(() => {
    if (!controls) return
    if (focus === 'head') {
      const [x, y, z] = stage.headCentre()
      controls.target.set(x, y, z)
      camera.position.set(x + 0.12, y + 0.02, z + 0.62)
    } else {
      controls.target.set(0, 1.0, 0)
      camera.position.set(0, 1.15, 3.1)
    }
    controls.update()
  }, [focus, controls, camera, stage])
  return null
}
