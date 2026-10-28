import { useLayoutEffect, useMemo, useRef } from 'react';
import { Canvas, useFrame, useThree } from '@react-three/fiber';
import {
  Box3,
  CanvasTexture,
  Color,
  Euler,
  Group,
  Quaternion,
  SRGBColorSpace,
  Vector2,
  Vector3,
  type BufferAttribute,
  type Mesh,
  type PointLight,
} from 'three';
import { ChappLight, Framing, canvasProps, preloadChappModel, useChappGLTF } from './ChappLook.tsx';
import { YAW, clamp, createRig, inOutCubic, noise, outBack, outCubic, smooth, type ChappRig } from './rig.ts';

/**
 * The opening, drawn over the whole screen; the R3F port of mountIntro in scripts/chapp-model/chapp3d.js.
 * Cards: 0 the deep sea, 1 one small protein in the heat, 2 the other 23 coming together, 3 Chapp opens its eyes as
 * the light comes up, 4 Chapp. The backdrop is painted in the scene as well, so the gel refracts what is behind it.
 */

preloadChappModel();

type Props = {
  card: number;
  /** When the card started (performance.now()); the 3D may arrive in the middle of one. */
  at: number;
  /** prefers-reduced-motion: each card shows where its motion ends. */
  calm: boolean;
  /** Where Chapp's middle sits, px from the top: 330 on the board, moved with the screen's top inset. */
  middle: number;
  /** Called once the model is on screen. */
  onReady: () => void;
};

export default function IntroCanvas(props: Props) {
  // What shows through the gel: the backdrop behind Chapp's middle, as the sea comes and goes.
  const behind = useMemo(() => new Color(), []);
  return (
    <Canvas {...canvasProps} onCreated={({ gl }) => gl.setClearColor(0x000000, 1)} aria-hidden="true">
      <ChappLight behind={behind} />
      <IntroScene {...props} behind={behind} />
    </Canvas>
  );
}

// The board is 874 px tall with Chapp's middle 330 px from the top (shifted up 107) and its body 0.37 of a full frame;
// on other screens the body keeps its size in px.
const BOARD_H = 874;
const FIT = 0.37;
const LIGHT = '#ffffff'; // the background it ends on
// The backdrop at Chapp's middle (makeBackdrop): the light with its glow, the sea, the heat.
const LIGHT_MIDDLE = new Color('#d7eafb');
const SEA_MIDDLE = new Color('#082440');
const HEAT = new Color('#ff8a3d');
const HERO = 1.8; // the lone piece, enlarged
const TURNED = new Euler(0.42, YAW + 2.4, 0); // card 1 and the start of card 2
const heroSpin = (t: number): [number, number, number] => [0.35 * Math.sin(t * 0.9), t * 0.55, 0.25 * Math.sin(t * 0.7)];

type Piece = { pivot: Group; c: Vector3; dir: Vector3; spin: number[]; order: number; from: Vector3 };

// The 24 pieces, each on a pivot at its own middle so it can tumble on the way in.
function assemble(rig: ChappRig) {
  const body = rig.body;
  const pieces: Piece[] = body.children.slice().map((child, i) => {
    const mesh = child as Mesh;
    const c = new Box3().setFromBufferAttribute(mesh.geometry.attributes.position as BufferAttribute).getCenter(new Vector3());
    const pivot = new Group();
    pivot.position.copy(c);
    body.add(pivot);
    pivot.add(mesh);
    mesh.position.copy(c).negate();
    return { pivot, c, dir: c.clone().normalize(), spin: [1, 2, 3].map(k => (noise(i, k) - 0.5) * 3), order: 0, from: new Vector3() };
  });
  // The one that starts alone faces the camera; the rest arrive nearest first, so the shell grows around it.
  const hero = pieces.reduce((a, b) => (b.c.z > a.c.z ? b : a));
  pieces
    .filter(p => p !== hero)
    .sort((a, b) => b.dir.dot(hero.dir) - a.dir.dot(hero.dir))
    .forEach((p, k) => (p.order = k));
  // Each piece flies in from the edge of the screen nearest its place, a little behind, never toward the camera.
  const startQ = new Quaternion().setFromEuler(TURNED);
  pieces.forEach((p, i) => {
    const w = p.c.clone().applyQuaternion(startQ);
    const xy = new Vector2(w.x, w.y);
    if (xy.lengthSq() < 1e-4) xy.set(1, 0);
    xy.normalize();
    p.from = new Vector3(xy.x * 2.7, xy.y * 2.7, -1.1 - noise(i, 4) * 1.2);
  });
  return { rig, pieces, hero };
}

// The backdrop, at half size: the app's light with its glow, the deep sea over it, the heat in the middle.
function makeBackdrop(width: number, height: number, middle: number) {
  const paper = document.createElement('canvas');
  paper.width = Math.round(width / 2);
  paper.height = Math.round(height / 2);
  const g = paper.getContext('2d')!;
  const tex = new CanvasTexture(paper);
  tex.colorSpace = SRGBColorSpace;
  const cy = middle / 2;
  let painted = '';
  const paint = (dark: number, heat: number) => {
    const key = dark.toFixed(3) + ' ' + heat.toFixed(3);
    if (key === painted) return;
    painted = key;
    const W = paper.width;
    const H = paper.height;
    g.globalAlpha = 1;
    g.fillStyle = LIGHT;
    g.fillRect(0, 0, W, H);
    let r = g.createRadialGradient(W / 2, cy, 0, W / 2, cy, 115);
    r.addColorStop(0, 'rgba(121, 185, 243, 0.30)');
    r.addColorStop(0.55, 'rgba(111, 211, 198, 0.10)');
    r.addColorStop(0.8, LIGHT + '00');
    r.addColorStop(1, LIGHT + '00');
    g.fillStyle = r;
    g.fillRect(0, 0, W, H);
    if (dark > 0) {
      g.globalAlpha = dark;
      const l = g.createLinearGradient(0, 0, 0, H);
      l.addColorStop(0, '#0d3150');
      l.addColorStop(0.38, '#082440');
      l.addColorStop(0.72, '#04152a');
      l.addColorStop(1, '#020b17');
      g.fillStyle = l;
      g.fillRect(0, 0, W, H);
      if (heat > 0) {
        g.globalAlpha = dark * heat;
        r = g.createRadialGradient(W / 2, cy, 0, W / 2, cy, 100);
        r.addColorStop(0, 'rgba(255, 138, 61, 0.22)');
        r.addColorStop(1, 'rgba(255, 138, 61, 0)');
        g.fillStyle = r;
        g.fillRect(0, 0, W, H);
      }
    }
    g.globalAlpha = 1;
    tex.needsUpdate = true;
  };
  paint(1, 0);
  return { tex, paint };
}

function IntroScene({ card, at, calm, middle, onReady, behind }: Props & { behind: Color }) {
  const gltf = useChappGLTF();
  // One memo for the copy and its pieces: assemble moves the copy's meshes, so it must never run twice on one copy.
  const { rig, pieces, hero } = useMemo(() => assemble(createRig(gltf)), [gltf]);
  const scene = useThree(s => s.scene);
  const width = useThree(s => s.size.width);
  const height = useThree(s => s.size.height);
  const backdrop = useMemo(() => makeBackdrop(width, height, middle), [width, height, middle]);
  const heat = useRef<PointLight>(null);
  const s = useRef({ card: -1, at: 0, done: {} as Record<string, boolean>, heroFrom: new Euler(), heroTo: 0, frames: 0 }).current;

  useLayoutEffect(() => {
    scene.background = backdrop.tex;
    return () => {
      if (scene.background === backdrop.tex) scene.background = null;
      backdrop.tex.dispose();
    };
  }, [scene, backdrop]);

  // A new card: what show(card, ms) did.
  useLayoutEffect(() => {
    if (s.card === 1 && card === 2) s.heroFrom.set(...heroSpin(calm ? 0 : (performance.now() - s.at) / 1000));
    else if (card === 2) s.heroFrom.set(0, 0, 0);
    s.heroTo = Math.round(s.heroFrom.y / (Math.PI * 2)) * Math.PI * 2;
    s.card = card;
    s.at = at;
    s.done = {};
    if (card >= 3) rig.setFace('Neutral', 0);
    if (card === 4) rig.pop = [1, 1];
  }, [card, at, calm, rig, s]);

  const qInv = useMemo(() => new Quaternion(), []);
  const off = useMemo(() => new Vector3(), []);

  useFrame(() => {
    const now = performance.now();
    const { card } = s;
    // Calm: the assembly is shown done; the light still comes up.
    const t = calm && card <= 2 ? 99 : (now - s.at) / 1000;
    let dark = 1;
    let warm = 0;
    rig.turn.visible = card >= 1;
    rig.breathe = card >= 3;
    rig.blinking = card >= 3;
    if (card < 3) rig.pop = [0, 0];
    if (card === 1) {
      warm = clamp(t / 1.2, 0, 1);
      for (const p of pieces) p.pivot.visible = p === hero;
      hero.pivot.position.copy(rig.center);
      hero.pivot.scale.setScalar(Math.max(1e-4, HERO * outBack(clamp(t / 1.1, 0, 1))));
      hero.pivot.rotation.set(...heroSpin(calm ? 0 : t));
      rig.turn.rotation.copy(TURNED);
    } else if (card === 2) {
      warm = 1 - clamp((t - 3.6) / 1.6, 0, 1);
      const turnK = inOutCubic(clamp(t / 5.4, 0, 1));
      rig.turn.rotation.set(TURNED.x * (1 - turnK), YAW + (TURNED.y - YAW) * (1 - turnK), 0);
      qInv.copy(rig.turn.quaternion).invert();
      for (const p of pieces) {
        p.pivot.visible = true;
        if (p === hero) {
          const k = inOutCubic(clamp(t / 1.5, 0, 1));
          const { heroFrom: f, heroTo } = s;
          p.pivot.position.lerpVectors(rig.center, p.c, k);
          p.pivot.scale.setScalar(HERO + (1 - HERO) * k);
          p.pivot.rotation.set(f.x * (1 - k), f.y + (heroTo - f.y) * k, f.z * (1 - k));
        } else {
          const k = outCubic(clamp((t - 0.35 - p.order * 0.07) / 1.25, 0, 1));
          off.copy(p.from).multiplyScalar(1 - k).applyQuaternion(qInv);
          p.pivot.position.copy(p.c).add(off);
          p.pivot.rotation.set(p.spin[0] * (1 - k), p.spin[1] * (1 - k), p.spin[2] * (1 - k));
          p.pivot.scale.setScalar(0.6 + 0.4 * k);
        }
      }
    } else if (card >= 3) {
      for (const p of pieces) {
        p.pivot.visible = true;
        p.pivot.position.copy(p.c);
        p.pivot.rotation.set(0, 0, 0);
        p.pivot.scale.setScalar(1);
      }
      if (card === 3) {
        dark = 1 - smooth(clamp(t / 1.4, 0, 1));
        rig.pop = [outBack(clamp((t - 0.5) / 0.5, 0, 1)), outBack(clamp((t - 0.78) / 0.45, 0, 1))];
        rig.turn.rotation.set(0, YAW, 0);
        const once = (name: string, after: number, act: () => void) => {
          if (t > after && !s.done[name]) {
            s.done[name] = true;
            act();
          }
        };
        once('blink', 1.8, () => rig.blink());
        once('happy', 2.6, () => rig.setFace('Happy', 200));
        once('back', 4.0, () => rig.setFace('Neutral', 240));
      } else {
        dark = 0;
        rig.pop = [1, 1];
        rig.turn.rotation.set(0, YAW + (calm ? 0 : 0.16 * Math.sin(t * 0.7)), 0);
      }
    }
    if (heat.current) heat.current.intensity = 5 * warm * dark * (0.85 + 0.15 * Math.sin(t * 5.3));
    backdrop.paint(dark, warm);
    behind.copy(LIGHT_MIDDLE).lerp(SEA_MIDDLE, dark).lerp(HEAT, 0.22 * dark * warm);
    rig.update(now);
    if (++s.frames === 2) onReady();
  });

  return (
    <>
      <primitive object={rig.turn} dispose={null} />
      <pointLight ref={heat} args={[0xff8a3d, 0, 7, 1.6]} position={[0, -1.4, 1.8]} />
      <Framing rig={rig} fit={(FIT * BOARD_H) / height} shiftY={height / 2 - middle} />
    </>
  );
}
