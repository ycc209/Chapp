import { useEffect, useLayoutEffect, useMemo, useRef } from 'react';
import { Canvas, useFrame, useThree } from '@react-three/fiber';
import type { Pose, Clip } from './poses.ts';
import { prefersCalm } from './poses.ts';
import { ChappLight, Floor, Framing, canvasProps, preloadChappModel, useChappGLTF } from './ChappLook.tsx';
import { YAW, clamp, createRig, outCubic } from './rig.ts';

/**
 * Chapp in the middle of the screen, the R3F port of mountStage in scripts/chapp-model/chapp3d.js. Drag to turn it;
 * it keeps turning a little after you let go and drifts back to face you when left alone. A tap changes the face;
 * three quick taps take it apart into its 24 subunits for a moment, to show what it is made of.
 * Loaded only when the stage opens (React.lazy in ChappStage), so the home screen ships no WebGL.
 */

preloadChappModel();

export type StageApi = {
  /** A turn of welcome once it has landed in the middle; a plain face also smiles for a moment. */
  arrive(): void;
};

type Props = {
  /** The face it comes with, so the first frame matches the picture that flew in. */
  pose: Pose;
  /** The picture's size over the canvas height, so the first frame matches it. */
  fit: number;
  /** Called once the model is on screen. */
  onReady: (api: StageApi) => void;
};

export default function StageCanvas(props: Props) {
  return (
    <Canvas {...canvasProps} aria-hidden="true">
      <ChappLight />
      <StageScene {...props} />
    </Canvas>
  );
}

// Taps go round all eight faces, starting after the one it came with.
const FACES: Clip[] = ['Happy', 'Excited', 'Wink', 'Surprised', 'Thinking', 'Sleepy', 'Sad', 'Neutral'];
// Taps this close together are one burst: the third comes apart.
const TAPS_MS = 450;

function StageScene({ pose, fit, onReady }: Props) {
  const gltf = useChappGLTF();
  const rig = useMemo(() => createRig(gltf), [gltf]);
  const canvas = useThree(s => s.gl.domElement);
  const calm = useMemo(prefersCalm, []);
  // Everything the finger and the clock change, kept out of React: it moves every frame.
  const m = useRef({
    yaw: pose.turn,
    pitch: 0,
    vy: 0,
    vp: 0,
    drag: null as null | { x: number; y: number; moved: number; at: number },
    still: performance.now(),
    spin: 0,
    hop: 0,
    n: FACES.indexOf(pose.clip),
    tapped: false,
    lean: pose.tilt,
    look: pose.look,
    frames: 0,
    lastTap: 0,
    burst: 0,
  }).current;
  const timers = useRef<number[]>([]);
  useEffect(() => () => timers.current.forEach(clearTimeout), []);

  useLayoutEffect(() => {
    rig.setFace(pose.clip, 0);
    rig.tilt.rotation.z = pose.tilt;
    rig.look = [...pose.look];
    // Only on arrival: after that the face and the lean are the taps' to change.
  }, [rig]);

  useEffect(() => {
    // The board may be shown smaller than it is (a scaled phone frame on a desktop); turn by its own pixels.
    const zoom = () => canvas.getBoundingClientRect().width / (canvas.clientWidth || 1) || 1;
    canvas.style.touchAction = 'none';
    canvas.style.cursor = 'grab';
    const down = (e: PointerEvent) => {
      e.stopPropagation();
      canvas.setPointerCapture?.(e.pointerId);
      canvas.style.cursor = 'grabbing';
      m.drag = { x: e.clientX, y: e.clientY, moved: 0, at: performance.now() };
      m.vy = m.vp = 0;
      m.spin = 0;
    };
    const move = (e: PointerEvent) => {
      const d = m.drag;
      if (!d) return;
      const z = zoom();
      const dx = (e.clientX - d.x) / z;
      const dy = (e.clientY - d.y) / z;
      d.x = e.clientX;
      d.y = e.clientY;
      d.moved += Math.abs(dx) + Math.abs(dy);
      m.vy = dx * 0.011;
      m.vp = dy * 0.008;
      m.yaw += m.vy;
      m.pitch = clamp(m.pitch + m.vp, -0.8, 0.8);
      m.still = performance.now();
    };
    const up = (e: PointerEvent) => {
      const d = m.drag;
      if (!d) return;
      e.stopPropagation();
      const tap = d.moved < 8 && performance.now() - d.at < 400;
      m.drag = null;
      canvas.style.cursor = 'grab';
      m.still = performance.now();
      if (tap) {
        const now = performance.now();
        // The first tap of a burst changes the face as any tap does; the second waits for a third.
        const quick = now - m.lastTap < TAPS_MS;
        m.lastTap = now;
        m.burst = quick ? m.burst + 1 : 1;
        if (rig.scattering() || (quick && m.burst < 3)) return;
        m.vy = m.vp = 0;
        m.tapped = true;
        m.lean = 0;
        m.look = [0, 0];
        if (m.burst === 3) {
          // Apart, surprised, and back together happy.
          m.burst = 0;
          const ms = rig.scatter(calm);
          rig.setFace('Surprised', 120);
          m.n = FACES.indexOf('Happy');
          timers.current.push(window.setTimeout(() => rig.setFace('Happy', 240), ms - 450));
          return;
        }
        m.n = (m.n + 1) % FACES.length;
        rig.setFace(FACES[m.n]);
        if (!calm) m.hop = performance.now();
      }
    };
    const click = (e: MouseEvent) => e.stopPropagation();
    canvas.addEventListener('pointerdown', down);
    canvas.addEventListener('pointermove', move);
    canvas.addEventListener('pointerup', up);
    canvas.addEventListener('pointercancel', up);
    canvas.addEventListener('click', click);
    return () => {
      canvas.removeEventListener('pointerdown', down);
      canvas.removeEventListener('pointermove', move);
      canvas.removeEventListener('pointerup', up);
      canvas.removeEventListener('pointercancel', up);
      canvas.removeEventListener('click', click);
    };
  }, [canvas, rig, calm, m]);

  const api = useMemo<StageApi>(
    () => ({
      arrive() {
        if (!calm) m.spin = performance.now();
        if (pose.clip !== 'Neutral') return;
        const say = (face: Clip, ms: number) => () => !m.tapped && rig.setFace(face, ms);
        timers.current.push(window.setTimeout(say('Happy', 200), 1000), window.setTimeout(say('Neutral', 240), 2400));
      },
    }),
    [rig, calm, m, pose.clip],
  );

  useFrame(() => {
    const now = performance.now();
    // Per frame, as chapp3d.js does: phones draw at 60 Hz, which is what these rates were tuned at.
    if (!m.drag) {
      m.yaw += m.vy;
      m.pitch = clamp(m.pitch + m.vp, -0.8, 0.8);
      m.vy *= 0.93;
      m.vp *= 0.9;
      if (Math.abs(m.vy) + Math.abs(m.vp) < 0.0005 && now - m.still > 2600) {
        const front = Math.round(m.yaw / (Math.PI * 2)) * Math.PI * 2;
        m.yaw += (front - m.yaw) * 0.045;
        m.pitch -= m.pitch * 0.045;
      }
    }
    let off = 0;
    let lift = 0;
    if (m.spin) {
      const k = clamp((now - m.spin) / 1300, 0, 1);
      off = (1 - outCubic(k)) * -Math.PI * 2;
      if (k >= 1) m.spin = 0;
    }
    if (m.hop) {
      const k = clamp((now - m.hop) / 420, 0, 1);
      lift = Math.sin(Math.PI * k) * 0.14;
      if (k >= 1) m.hop = 0;
    }
    rig.turn.rotation.set(m.pitch, YAW + m.yaw + off, 0);
    rig.turn.position.y = rig.center.y + lift;
    rig.tilt.rotation.z += (m.lean - rig.tilt.rotation.z) * 0.1;
    rig.look[0] += (m.look[0] - rig.look[0]) * 0.1;
    rig.look[1] += (m.look[1] - rig.look[1]) * 0.1;
    rig.update(now);
    // Ready once a frame has been drawn: this callback runs before the frame it belongs to.
    if (++m.frames === 2) onReady(api);
  });

  return (
    <>
      <primitive object={rig.turn} dispose={null} />
      <Floor rig={rig} />
      <Framing rig={rig} fit={fit} />
    </>
  );
}
