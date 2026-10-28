import { useEffect, useLayoutEffect, useMemo } from 'react';
import { useFrame, useThree } from '@react-three/fiber';
import { useGLTF } from '@react-three/drei';
import { CanvasTexture, MathUtils, PMREMGenerator, SRGBColorSpace, type Color, type PerspectiveCamera } from 'three';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';
import { LOOK, dressChapp, seeBehind } from './look.ts';
import { FILL, FOV, MODEL_URL, PITCH, type ChappGLTF, type ChappRig } from './rig.ts';

// The pieces every 3D Chapp shares: the model, its light, the camera framing and the shadow it stands on.

// chapp.glb uses neither Draco nor meshopt (plain buffers, 4.4 MB), so neither decoder is set up or fetched.
const DRACO = false;
const MESHOPT = false;

/** The loaded model in Chapp's look, shared: each scene makes its own rig from it with createRig. Suspends while it loads. */
export function useChappGLTF(): ChappGLTF {
  const gltf = useGLTF(MODEL_URL, DRACO, MESHOPT);
  dressChapp(gltf);
  return gltf;
}

/** Starts the model download before any scene asks for it. */
export function preloadChappModel() {
  useGLTF.preload(MODEL_URL, DRACO, MESHOPT);
}

/** Canvas props every Chapp canvas uses. */
export const canvasProps = {
  shadows: 'soft', // PCFSoftShadowMap
  dpr: LOOK.dpr,
  gl: {
    antialias: true,
    alpha: true,
    toneMapping: LOOK.toneMapping,
    toneMappingExposure: LOOK.exposure,
  },
  camera: { fov: FOV, near: 0.1, far: 100 },
  // The phone frame may be scaled down on a desktop: size the canvas by layout pixels, not the scaled box.
  resize: { offsetSize: true },
} as const;

/**
 * Chapp's light (LOOK): a soft room for the gloss, a warm key, a cool fill, lilac and mint rims. behind: what shows
 * through the gel, kept up to date by the scene (the intro's sea); white when not given.
 */
export function ChappLight({ behind }: { behind?: Color }) {
  const gl = useThree(s => s.gl);
  const scene = useThree(s => s.scene);
  // Every frame: the stage and the intro may both be drawing for a moment, and they share the gel.
  useFrame(() => seeBehind(behind));
  useLayoutEffect(() => {
    const pmrem = new PMREMGenerator(gl);
    const room = new RoomEnvironment();
    const env = pmrem.fromScene(room, 0.025);
    pmrem.dispose();
    room.dispose();
    scene.environment = env.texture;
    scene.environmentIntensity = LOOK.env.intensity;
    return () => {
      if (scene.environment === env.texture) scene.environment = null;
      env.dispose();
    };
  }, [gl, scene]);
  return (
    <>
      {LOOK.lights.map(({ color, intensity, position, shadow }, i) =>
        shadow ? (
          <directionalLight
            key={i}
            color={color}
            intensity={intensity}
            position={position}
            castShadow
            shadow-mapSize={[1024, 1024]}
            shadow-camera-left={-2}
            shadow-camera-right={2}
            shadow-camera-top={2}
            shadow-camera-bottom={-2}
            shadow-camera-near={0.1}
            shadow-camera-far={18}
            shadow-bias={-0.00012}
            shadow-normalBias={0.012}
          />
        ) : (
          <directionalLight key={i} color={color} intensity={intensity} position={position} />
        ),
      )}
      <hemisphereLight args={[LOOK.hemisphere.sky, LOOK.hemisphere.ground, LOOK.hemisphere.intensity]} />
    </>
  );
}

/**
 * The camera, framed so the body fills FILL × fit of the canvas height, seen from a little above. shiftY moves the
 * picture up by that many pixels (the intro keeps Chapp above its text).
 */
export function Framing({ rig, fit = 1, shiftY = 0 }: { rig: ChappRig; fit?: number; shiftY?: number }) {
  const camera = useThree(s => s.camera) as PerspectiveCamera;
  const width = useThree(s => s.size.width);
  const height = useThree(s => s.size.height);
  useLayoutEffect(() => {
    const { center } = rig;
    const dist = rig.radius / FILL / Math.tan(MathUtils.degToRad(FOV / 2));
    camera.fov = FOV;
    camera.near = 0.1;
    camera.far = 100;
    camera.aspect = width / height;
    camera.position.set(center.x, center.y + Math.sin(PITCH) * dist, center.z + Math.cos(PITCH) * dist);
    camera.lookAt(center);
    camera.zoom = fit;
    if (shiftY) camera.setViewOffset(width, height, 0, shiftY, width, height);
    else camera.clearViewOffset();
    camera.updateProjectionMatrix();
  }, [camera, rig, fit, shiftY, width, height]);
  return null;
}

/** The soft blue shadow under Chapp on the stage, painted rather than cast so it stays soft as Chapp turns. */
export function Floor({ rig }: { rig: ChappRig }) {
  const map = useMemo(() => {
    const paper = document.createElement('canvas');
    paper.width = paper.height = 256;
    const g = paper.getContext('2d')!;
    const r = g.createRadialGradient(128, 128, 4, 128, 128, 125);
    r.addColorStop(0, 'rgba(43, 94, 128, 0.24)');
    r.addColorStop(0.45, 'rgba(61, 123, 153, 0.10)');
    r.addColorStop(1, 'rgba(55, 95, 143, 0)');
    g.fillStyle = r;
    g.fillRect(0, 0, 256, 256);
    const tex = new CanvasTexture(paper);
    tex.colorSpace = SRGBColorSpace;
    return tex;
  }, []);
  useEffect(() => () => map.dispose(), [map]);
  const size = rig.radius * 2.7;
  return (
    <mesh rotation-x={-Math.PI / 2} position={[rig.center.x, rig.box.min.y - 0.05, rig.center.z]}>
      <planeGeometry args={[size, size]} />
      <meshBasicMaterial map={map} transparent depthWrite={false} toneMapped={false} />
    </mesh>
  );
}
