import { Suspense, useLayoutEffect, useMemo, useRef } from 'react';
import { createRoot } from 'react-dom/client';
import { Canvas, useFrame, useThree } from '@react-three/fiber';
import { ChappLight, Framing, canvasProps, useChappGLTF } from '../../src/components/chapp/three/ChappLook.tsx';
import { OPEN, YAW, createRig } from '../../src/components/chapp/three/rig.ts';
import { bodyShare, poseFor, type Pose } from '../../src/components/chapp/three/poses.ts';
import type { Expression } from '../../shared/ai.ts';

/**
 * The stills in public/chapp, drawn by the very scene the app shows (ChappLight, Framing, canvasProps, createRig), so
 * a picture and the first frame of the 3D Chapp it turns into look the same. stills.ts drives this page.
 */

// The body is 468 px in every still: 600 px for neutral and listen, 720 px for the faces that reach past the body.
const BODY_BOX = 600;
// Drawn at twice the size and scaled down: smoother edges and highlights than the canvas's own antialiasing alone.
const SUPERSAMPLE = 2;
const QUALITY = 0.92;

type Shot = { pose: Pose; closed: number };
type Shooter = (shot: Shot) => Promise<HTMLCanvasElement>;

// Every still: each face's picture, and a mid-blink one for the faces that blink.
const EXPRESSIONS: Expression[] = ['neutral', 'listen', 'happy', 'thinking', 'excited', 'surprised', 'sad', 'wink', 'sleepy'];
const STILLS = new Map<string, Shot>();
for (const e of EXPRESSIONS) {
  const pose = poseFor(e);
  const name = pose.still.split('/').pop()!;
  STILLS.set(name, { pose, closed: 0 });
  if (OPEN.has(pose.clip)) STILLS.set(name.replace('.webp', '-blink.webp'), { pose, closed: 1 });
}

const scenes: object[] = [];

function StillScene({ fit, onShooter }: { fit: number; onShooter: (s: Shooter) => void }) {
  const gltf = useChappGLTF();
  const rig = useMemo(() => createRig(gltf), [gltf]);
  const gl = useThree(s => s.gl);
  const scene = useThree(s => s.scene);
  const camera = useThree(s => s.camera);
  const size = useThree(s => s.size.width);
  const waiting = useRef<{ frames: number; done: () => void } | null>(null);

  useLayoutEffect(() => {
    rig.breathe = false;
    rig.blinking = false;
    // For trying a change in the console before it goes into the look: lookdev.scenes[i].scene, .gl, .gltf.
    scenes.push({ gl, scene, camera, gltf, rig });
    onShooter(({ pose, closed }) => {
      rig.setFace(pose.clip, 0);
      rig.closed = closed;
      rig.look = [...pose.look];
      rig.tilt.rotation.z = pose.tilt;
      rig.turn.rotation.set(0, YAW + pose.turn, 0);
      return new Promise<HTMLCanvasElement>(done => {
        waiting.current = {
          frames: 0,
          done: () => {
            const out = document.createElement('canvas');
            out.width = out.height = size;
            const g = out.getContext('2d')!;
            g.imageSmoothingQuality = 'high';
            g.drawImage(gl.domElement, 0, 0, size, size);
            done(out);
          },
        };
      });
    });
  }, [rig, gl, scene, camera, gltf, size, onShooter]);

  useFrame(() => {
    rig.update(performance.now());
    const w = waiting.current;
    // Read after the frame that drew the pose: this callback runs before the frame it belongs to.
    if (w && ++w.frames === 3) {
      waiting.current = null;
      setTimeout(w.done, 0);
    }
  });

  return (
    <>
      <primitive object={rig.turn} dispose={null} />
      <Framing rig={rig} fit={fit} />
    </>
  );
}

const shooters = new Map<number, Shooter>();
const ready = new Map<number, () => void>();
const sizes = [...new Set([...STILLS.values()].map(s => BODY_BOX / bodyShare(s.pose)))];
const allReady = Promise.all(sizes.map(size => new Promise<void>(ok => ready.set(size, ok))));

function Still({ size }: { size: number }) {
  return (
    <div style={{ width: size, height: size }}>
      <Canvas {...canvasProps} dpr={SUPERSAMPLE} gl={{ ...canvasProps.gl, preserveDrawingBuffer: true }}>
        <ChappLight />
        <Suspense fallback={null}>
          <StillScene
            fit={BODY_BOX / size}
            onShooter={s => {
              shooters.set(size, s);
              ready.get(size)?.();
            }}
          />
        </Suspense>
      </Canvas>
    </div>
  );
}

createRoot(document.body.appendChild(document.createElement('div'))).render(
  <div style={{ display: 'flex', gap: 12 }}>
    {sizes.map(size => (
      <Still key={size} size={size} />
    ))}
  </div>,
);

/** Draws one still; returns it as a webp data URL. */
async function render(name: string, quality = QUALITY) {
  const shot = STILLS.get(name);
  if (!shot) throw new Error('no still called ' + name);
  await allReady;
  const canvas = await shooters.get(BODY_BOX / bodyShare(shot.pose))!(shot);
  return canvas.toDataURL('image/webp', quality);
}

/** Draws one still as a lossless PNG data URL (for comparisons). */
async function renderPng(name: string) {
  const shot = STILLS.get(name);
  if (!shot) throw new Error('no still called ' + name);
  await allReady;
  return (await shooters.get(BODY_BOX / bodyShare(shot.pose))!(shot)).toDataURL('image/png');
}

Object.assign(window, { lookdev: { names: [...STILLS.keys()], render, renderPng, ready: allReady, scenes } });
