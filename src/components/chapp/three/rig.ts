import { Box3, Group, MathUtils, Quaternion, Vector3, type AnimationClip, type Mesh, type Object3D } from 'three';
import type { Clip } from './poses.ts';

/**
 * Chapp's model, posed: the R3F port of createView in scripts/chapp-model/chapp3d.js. The stills in public/chapp are
 * drawn from this same rig (scripts/chapp-model/lookdev.html), with the light and the gel of look.ts, so the 3D Chapp
 * and the pictures match.
 */

export const MODEL_URL = '/chapp/chapp.glb';
export const CLIPS: Clip[] = ['Neutral', 'Happy', 'Thinking', 'Excited', 'Surprised', 'Sad', 'Wink', 'Sleepy'];
export const OPEN = new Set<Clip>(['Neutral', 'Thinking', 'Excited', 'Surprised', 'Sad']); // the faces that blink
export const FOV = 30;
export const FILL = 0.78; // the body's share of the frame's height
export const PITCH = 0.06; // the camera sits a little above
export const YAW = -0.13; // and Chapp turns a little to one side

export const clamp = (x: number, a: number, b: number) => Math.min(b, Math.max(a, x));
export const smooth = (k: number) => k * k * (3 - 2 * k);
export const outCubic = (k: number) => 1 - (1 - k) ** 3;
export const inOutCubic = (k: number) => (k < 0.5 ? 4 * k * k * k : 1 - (-2 * k + 2) ** 3 / 2);
export const outBack = (k: number) => 1 + 2.70158 * (k - 1) ** 3 + 1.70158 * (k - 1) ** 2;
/** Coming apart (ms from the start): out by `out`, held, back from `back`, together again by `end`. */
export const SCATTER = { out: 450, back: 1250, end: 1900 };
export const noise = (i: number, k: number) => {
  const x = Math.sin(i * 127.1 + k * 311.7) * 43758.5453;
  return x - Math.floor(x);
};

export type ChappGLTF = { scene: Object3D; animations: AnimationClip[] };

type Key = { node: string; prop: string; value: number[] };
type Channel = { obj: Object3D; prop: string; cur: number[]; from: number[]; to: number[] };

// The last key of each expression clip: which face parts show, where, and how big.
function faceTable(gltf: ChappGLTF) {
  const table: Partial<Record<Clip, Key[]>> = {};
  for (const clip of gltf.animations) {
    if (!CLIPS.includes(clip.name as Clip)) continue;
    table[clip.name as Clip] = clip.tracks.map(t => {
      const n = t.getValueSize();
      const dot = t.name.lastIndexOf('.');
      return { node: t.name.slice(0, dot), prop: t.name.slice(dot + 1), value: Array.from(t.values.slice(-n)) };
    });
  }
  return table;
}

export type ChappRig = ReturnType<typeof createRig>;

/**
 * A copy of the model on two pivots at the middle of the body: `turn` (what a finger turns) holds `tilt` (a pose's
 * head tilt). Add `turn` to the scene and call update(now) once a frame before it is drawn.
 */
export function createRig(gltf: ChappGLTF) {
  const model = gltf.scene.clone(true);
  model.traverse(o => {
    if ((o as Mesh).isMesh) {
      o.castShadow = true;
      o.receiveShadow = true;
      o.frustumCulled = false;
    }
  });
  const chapp = model.getObjectByName('Chapp')!;
  const body = model.getObjectByName('Body')!;
  const box = new Box3().setFromObject(body);
  const center = box.getCenter(new Vector3());
  const radius = Math.max(...box.getSize(new Vector3()).toArray()) / 2;
  // The 24 subunits, for coming apart: each flies out along its own line from the middle, a little smaller, turning
  // round its own middle, and back. None flies across the face (+Z): a piece in front fans out to the side instead,
  // so the eyes stay in sight between them.
  const FAN = Math.cos(MathUtils.degToRad(55));
  const pieces = body.children.map((o, i) => {
    const mid = new Box3().setFromObject(o).getCenter(new Vector3());
    const dir = mid.clone().sub(center).normalize();
    if (dir.z > FAN) {
      const side = new Vector3(dir.x, dir.y, 0);
      if (side.lengthSq() < 1e-4) side.set(noise(i, 6) - 0.5, noise(i, 7) - 0.5, 0);
      side.normalize().multiplyScalar(Math.sqrt(1 - FAN * FAN));
      dir.set(side.x, side.y, FAN);
    }
    return {
      o,
      mid,
      dir,
      far: (0.4 + 0.2 * noise(i, 4)) * radius,
      axis: new Vector3(noise(i, 1) - 0.5, noise(i, 2) - 0.5, noise(i, 3) - 0.5).normalize(),
      spin: (noise(i, 5) - 0.5) * 1.6,
    };
  });
  const turned = new Vector3();
  let scatterAt = 0;
  let scatterSize = 1;
  const tilt = new Group();
  const turn = new Group();
  model.position.copy(center).negate();
  tilt.add(model);
  turn.add(tilt);
  turn.position.copy(center);
  turn.rotation.y = YAW;

  // The face: every part the expression clips move, blended from one face to the next.
  const table = faceTable(gltf);
  const chans: Channel[] = (table.Neutral ?? []).flatMap(({ node, prop, value }) => {
    const obj = model.getObjectByName(node);
    return obj ? [{ obj, prop, cur: value.slice(), from: value.slice(), to: value.slice() }] : [];
  });
  const byName = new Map(chans.map(c => [c.obj.name + '.' + c.prop, c]));
  const parts = [...new Set(chans.map(c => c.obj))];
  const eyes = ['Eye_L', 'Eye_R'].flatMap(n => model.getObjectByName(n) ?? []);
  const eyeParts = new Set<Object3D | undefined>([...eyes, ...['Closed_L', 'Closed_R', 'Sleep_L', 'Sleep_R'].map(n => model.getObjectByName(n))]);
  const glints: Object3D[] = [];
  model.traverse(o => {
    if (/highlight/i.test(o.name)) glints.push(o);
  });
  const qa = new Quaternion();
  const qb = new Quaternion();
  let faceAt = 0;
  let faceMs = 0;
  let blinkAt = 0;
  let nextBlink = 0;

  const rig = {
    model,
    body,
    turn,
    tilt,
    box,
    center,
    radius,
    face: 'Neutral' as Clip,
    breathe: true, // the slow rise of the model's Idle clip
    blinking: true, // now and then, while the eyes are open
    closed: 0, // 0 open … 1 shut, for stills
    look: [0, 0] as [number, number], // the eyes nudged by this much
    pop: [1, 1] as [number, number], // the eyes, and the rest of the face: 0 not there … 1 there
    setFace(name: Clip, ms = 160) {
      const keys = table[name];
      if (!keys) return;
      for (const tr of keys) {
        const c = byName.get(tr.node + '.' + tr.prop);
        if (c) {
          c.from = c.cur.slice();
          c.to = tr.value;
        }
      }
      faceAt = performance.now();
      faceMs = ms;
      rig.face = name;
    },
    blink() {
      blinkAt = performance.now();
    },
    /** Comes apart into its 24 subunits and back (gently: a little way, no turning). Returns how long it takes (ms). */
    scatter(gently = false) {
      scatterAt = performance.now();
      scatterSize = gently ? 0.35 : 1;
      return SCATTER.end;
    },
    scattering: () => scatterAt !== 0,
    update(now = performance.now()) {
      const e = smooth(faceMs ? clamp((now - faceAt) / faceMs, 0, 1) : 1);
      for (const c of chans) {
        if (c.prop === 'quaternion') {
          qa.fromArray(c.from).slerp(qb.fromArray(c.to), e);
          qa.toArray(c.cur);
          c.obj.quaternion.copy(qa);
        } else {
          for (let i = 0; i < c.cur.length; i++) c.cur[i] = c.from[i] + (c.to[i] - c.from[i]) * e;
          (c.obj[c.prop as 'position' | 'scale']).fromArray(c.cur);
        }
      }
      let open = 1 - 0.94 * rig.closed;
      if (rig.blinking && OPEN.has(rig.face)) {
        if (!nextBlink) nextBlink = now + 1800 + Math.random() * 2400;
        if (now >= nextBlink) {
          blinkAt = now;
          nextBlink = now + 2600 + Math.random() * 3200;
        }
      }
      if (blinkAt) {
        const d = now - blinkAt;
        open = Math.min(open, d < 80 ? 1 - 0.94 * (d / 80) : d < 160 ? 0.06 : d < 250 ? 0.06 + 0.94 * ((d - 160) / 90) : 1);
        if (d >= 250) blinkAt = 0;
      }
      for (const eye of eyes) {
        eye.scale.y *= open;
        eye.position.x += rig.look[0];
        eye.position.y += rig.look[1];
      }
      for (const g of glints) g.visible = open > 0.35;
      if (rig.pop[0] !== 1 || rig.pop[1] !== 1) {
        for (const o of parts) o.scale.multiplyScalar(Math.max(1e-5, eyeParts.has(o) ? rig.pop[0] : rig.pop[1]));
      }
      if (scatterAt) {
        const t = now - scatterAt;
        // Out fast, a moment apart, then back with a little snap past where they belong.
        const k = t < SCATTER.out ? outCubic(t / SCATTER.out) : t < SCATTER.back ? 1 : 1 - outBack(clamp((t - SCATTER.back) / (SCATTER.end - SCATTER.back), 0, 1));
        const done = t >= SCATTER.end;
        for (const p of pieces) {
          const out = done ? 0 : k;
          const size = 1 - 0.18 * scatterSize * out;
          p.o.quaternion.setFromAxisAngle(p.axis, scatterSize < 1 ? 0 : p.spin * out);
          p.o.scale.setScalar(size);
          // Turned and shrunk round its own middle, then moved out.
          turned.copy(p.mid).multiplyScalar(size).applyQuaternion(p.o.quaternion);
          p.o.position.copy(p.dir).multiplyScalar(p.far * scatterSize * out).add(p.mid).sub(turned);
        }
        if (done) scatterAt = 0;
      }
      const s = rig.breathe ? (1 - Math.cos((now / 4000) * Math.PI * 2)) / 2 : 0;
      chapp.position.y = 0.045 * s;
      chapp.scale.set(1 + 0.012 * s, 1 + 0.02 * s, 1 + 0.012 * s);
    },
  };
  return rig;
}
