import { Suspense, useLayoutEffect, useMemo, useRef } from 'react';
import { createRoot } from 'react-dom/client';
import { Canvas, useFrame, useThree } from '@react-three/fiber';
import { Box3, Color, Group, MathUtils, Sphere, Vector3, type Object3D, type PerspectiveCamera } from 'three';
import { ChappLight, canvasProps, useChappGLTF } from '../../src/components/chapp/three/ChappLook.tsx';
import { FOV, PITCH, createRig } from '../../src/components/chapp/three/rig.ts';

/**
 * One subunit of Chapp's body (a monomer of Hsp16.5) on its own, turned any way, on a dark backdrop, drawn with the
 * same light and gel as the app: for choosing the app icon. unit.html; in the console:
 *   await unit.render({ unit: 0, yaw: 120, pitch: 0 })                     one view, a PNG data URL
 *   await unit.sheet([{ yaw: 0 }, { yaw: 30 }, …], 6)                      a contact sheet, labelled
 * yaw, pitch, roll in degrees: the piece turned round the vertical, tipped toward or away, then turned in the picture.
 * bg: the backdrop; behind: what shows through the gel (the backdrop unless given); fill: the piece's share of the frame.
 */

// unit.html?size=512 for bigger pictures.
const SIZE = Number(new URLSearchParams(location.search).get('size')) || 300;
const SUPERSAMPLE = 2;

/**
 * unit: one subunit by its place in the body, several (a dimer: [0, 2]) shown together, or 'all' (the whole cage,
 * no face). face: the whole Chapp, face and all, instead.
 */
export type View = { unit?: number | number[] | 'all'; face?: boolean; yaw?: number; pitch?: number; roll?: number; bg?: string; behind?: string; fill?: number };
type Shooter = (view: View) => Promise<HTMLCanvasElement>;

let shooter: Shooter | null = null;
let names: string[] = [];
/** Each subunit's middle, from the middle of the body (the frame yaw, pitch and roll turn). */
let middles: [number, number, number][] = [];
let setReady: () => void = () => {};
const ready = new Promise<void>(ok => (setReady = ok));

function UnitScene() {
  const gltf = useChappGLTF();
  const rig = useMemo(() => createRig(gltf), [gltf]);
  const gl = useThree(s => s.gl);
  const camera = useThree(s => s.camera) as PerspectiveCamera;
  const size = useThree(s => s.size.width);
  const pivot = useMemo(() => new Group(), []);
  const waiting = useRef<{ frames: number; done: () => void } | null>(null);

  useLayoutEffect(() => {
    rig.breathe = false;
    rig.blinking = false;
    rig.turn.rotation.y = 0;
    rig.turn.updateMatrixWorld(true);
    const units = rig.body.children.slice();
    names = units.map(o => o.name);
    middles = units.map(o => new Box3().setFromObject(o).getCenter(new Vector3()).sub(rig.center).toArray() as [number, number, number]);
    let shown: Object3D[] = [];
    const sphere = new Sphere();
    shooter = ({ unit = 0, face = false, yaw = 0, pitch = 0, roll = 0, bg = '#000000', behind: seen = bg, fill = 0.8 }) => {
      // Whatever was out goes back into the body first.
      pivot.rotation.set(0, 0, 0);
      pivot.updateMatrixWorld(true);
      rig.turn.rotation.set(0, 0, 0);
      rig.turn.updateMatrixWorld(true);
      for (const s of shown) rig.body.attach(s);
      shown = [];
      let radius: number;
      let at: Vector3;
      const angles = [MathUtils.degToRad(pitch), MathUtils.degToRad(yaw), MathUtils.degToRad(roll), 'ZXY'] as const;
      if (face) {
        // The whole Chapp, face and all, turned round the middle of its body.
        rig.turn.visible = true;
        pivot.visible = false;
        rig.turn.rotation.set(...angles);
        radius = rig.radius;
        at = rig.turn.position;
      } else {
        // The pieces alone, on a pivot at their joint middle.
        const chosen = unit === 'all' ? units.map((_, i) => i) : Array.isArray(unit) ? unit : [unit];
        const pieces = chosen.map(i => {
          if (!units[i]) throw new Error('no subunit ' + i);
          return units[i]!;
        });
        rig.turn.visible = false;
        pivot.visible = true;
        const box = new Box3();
        for (const p of pieces) box.expandByObject(p);
        box.getCenter(pivot.position);
        pivot.updateMatrixWorld(true);
        for (const p of pieces) pivot.attach(p);
        shown = pieces;
        // The whole cage is round: its own radius, not its box's.
        radius = unit === 'all' ? rig.radius : box.getBoundingSphere(sphere).radius;
        pivot.rotation.set(...angles);
        at = pivot.position;
      }
      const dist = radius / fill / Math.tan(MathUtils.degToRad(FOV / 2));
      camera.fov = FOV;
      camera.aspect = 1;
      camera.position.set(at.x, at.y + Math.sin(PITCH) * dist, at.z + Math.cos(PITCH) * dist);
      camera.lookAt(at);
      camera.updateProjectionMatrix();
      gl.setClearColor(new Color(bg), 1);
      behindColour.set(seen);
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
    };
    setReady();
  }, [rig, gl, camera, size, pivot]);

  useFrame(() => {
    rig.update(performance.now());
    const w = waiting.current;
    if (w && ++w.frames === 3) {
      waiting.current = null;
      setTimeout(w.done, 0);
    }
  });

  return (
    <>
      <primitive object={pivot} dispose={null} />
      <primitive object={rig.turn} visible={false} dispose={null} />
    </>
  );
}

const behindColour = new Color(0, 0, 0);

createRoot(document.body.appendChild(document.createElement('div'))).render(
  <div style={{ width: SIZE, height: SIZE }}>
    <Canvas {...canvasProps} dpr={SUPERSAMPLE} gl={{ ...canvasProps.gl, preserveDrawingBuffer: true }}>
      <ChappLight behind={behindColour} />
      <Suspense fallback={null}>
        <UnitScene />
      </Suspense>
    </Canvas>
  </div>,
);

async function shoot(view: View) {
  await ready;
  return shooter!(view);
}

/** One view as a PNG data URL. */
async function render(view: View = {}) {
  return (await shoot(view)).toDataURL('image/png');
}

/** The views side by side, `columns` to a row, each labelled with its yaw, pitch and roll; a PNG data URL. */
async function sheet(views: View[], columns = 6, label = true) {
  const rows = Math.ceil(views.length / columns);
  const out = document.createElement('canvas');
  out.width = columns * SIZE;
  out.height = rows * SIZE;
  const g = out.getContext('2d')!;
  g.fillStyle = views[0]?.bg ?? '#000000';
  g.fillRect(0, 0, out.width, out.height);
  for (let i = 0; i < views.length; i++) {
    const v = views[i]!;
    const cell = await shoot(v);
    const x = (i % columns) * SIZE;
    const y = Math.floor(i / columns) * SIZE;
    g.drawImage(cell, x, y);
    if (label) {
      g.font = '13px -apple-system, Helvetica, sans-serif';
      g.fillStyle = 'rgba(255,255,255,0.75)';
      const what = v.face ? 'chapp' : v.unit === 'all' ? 'cage' : `unit ${[v.unit ?? 0].flat().join('+')}`;
      const text = [what, `yaw ${v.yaw ?? 0}`, `pitch ${v.pitch ?? 0}`, v.roll ? `roll ${v.roll}` : ''].filter(Boolean).join('  ');
      g.fillText(text, x + 8, y + SIZE - 10);
    }
    g.strokeStyle = 'rgba(255,255,255,0.12)';
    g.strokeRect(x + 0.5, y + 0.5, SIZE - 1, SIZE - 1);
  }
  return out.toDataURL('image/png');
}

Object.assign(window, { unit: { get names() { return names; }, get middles() { return middles; }, render, sheet, ready } });
