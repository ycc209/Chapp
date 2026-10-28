/**
 * Chapp in 3D without React: the stage, the intro and the stills as plain three.js. The app draws Chapp with the
 * R3F port in src/components/chapp/three (and lookdev.html renders the stills from that); this file stays as the
 * source of the design canvas's bundled copy (data/design/chapp/chapp-3d.js). The look itself (light, tone mapping,
 * the gel) comes from src/components/chapp/three/look.ts, so this file needs Vite or a bundler to load it.
 * The model, public/chapp/chapp.glb, is Chapp V4: the 24 subunits of Hsp16.5 (PDB 1SHS) rounded into a ball,
 * wearing a face. The faces are the model's expression clips; blinking and breathing happen here.
 */
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { LOOK, dressChapp, seeBehind } from '../../src/components/chapp/three/look.ts';

export const EXPRESSIONS = ['Neutral', 'Happy', 'Thinking', 'Excited', 'Surprised', 'Sad', 'Wink', 'Sleepy'];
const OPEN = new Set(['Neutral', 'Thinking', 'Excited', 'Surprised', 'Sad']); // the faces that blink
const FOV = 30;
const FILL = 0.78; // the body's share of the frame's height
const PITCH = 0.06; // the camera sits a little above
const YAW = -0.13; // and Chapp turns a little to one side

const clamp = (x, a, b) => Math.min(b, Math.max(a, x));
const smooth = (k) => k * k * (3 - 2 * k);
const outCubic = (k) => 1 - (1 - k) ** 3;
const inOutCubic = (k) => (k < 0.5 ? 4 * k * k * k : 1 - (-2 * k + 2) ** 3 / 2);
const outBack = (k) => 1 + 2.70158 * (k - 1) ** 3 + 1.70158 * (k - 1) ** 2;
const noise = (i, k) => {
  const x = Math.sin(i * 127.1 + k * 311.7) * 43758.5453;
  return x - Math.floor(x);
};

function script(src) {
  return new Promise((ok, no) => {
    const s = document.createElement('script');
    s.src = src;
    s.onload = ok;
    s.onerror = () => no(new Error(src));
    document.head.appendChild(s);
  });
}

// The model, loaded once per page. The design canvas serves no .glb, so there it comes as a script that
// carries the same bytes in base64 (chapp-model.js sets window.Chapp3DModel).
const files = new Map();
function load(url) {
  if (!files.has(url)) {
    const p = /\.js(\?|$)/.test(url)
      ? script(url).then(() => {
          const text = atob(window.Chapp3DModel);
          window.Chapp3DModel = null;
          const bytes = new Uint8Array(text.length);
          for (let i = 0; i < text.length; i++) bytes[i] = text.charCodeAt(i);
          return new GLTFLoader().parseAsync(bytes.buffer, '');
        })
      : new GLTFLoader().loadAsync(url);
    p.catch(() => files.delete(url));
    files.set(url, p);
  }
  return files.get(url);
}

// The last key of each expression clip: which face parts show, where, and how big.
function faceTable(gltf) {
  const table = {};
  for (const clip of gltf.animations) {
    if (!EXPRESSIONS.includes(clip.name)) continue;
    table[clip.name] = clip.tracks.map((t) => {
      const n = t.getValueSize();
      const dot = t.name.lastIndexOf('.');
      return { node: t.name.slice(0, dot), prop: t.name.slice(dot + 1), value: Array.from(t.values.slice(-n)) };
    });
  }
  return table;
}

/** A renderer with Chapp in its light, framed so the body fills FILL × fit of the height. */
export async function createView({ url, width, height, dpr, fit = 1, shiftY = 0, ground = false, preserve = false }) {
  const gltf = await load(url);
  dressChapp(gltf);
  const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, preserveDrawingBuffer: preserve });
  renderer.setPixelRatio(dpr ?? Math.min(window.devicePixelRatio || 1, LOOK.dpr[1]));
  renderer.setSize(width, height);
  renderer.setClearColor(0x000000, 0);
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = LOOK.toneMapping;
  renderer.toneMappingExposure = LOOK.exposure;
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;

  // Chapp's light (LOOK): a soft room for the gloss, a warm key, a cool fill, lilac and mint rims.
  const scene = new THREE.Scene();
  const pmrem = new THREE.PMREMGenerator(renderer);
  const env = pmrem.fromScene(new RoomEnvironment(), 0.025);
  pmrem.dispose();
  scene.environment = env.texture;
  scene.environmentIntensity = LOOK.env.intensity;
  for (const { color, intensity, position, shadow } of LOOK.lights) {
    const light = new THREE.DirectionalLight(color, intensity);
    light.position.set(...position);
    if (shadow) {
      light.castShadow = true;
      light.shadow.mapSize.set(1024, 1024);
      Object.assign(light.shadow.camera, { left: -2, right: 2, top: 2, bottom: -2, near: 0.1, far: 18 });
      light.shadow.bias = -0.00012;
      light.shadow.normalBias = 0.012;
    }
    scene.add(light);
  }
  const { sky, ground: below, intensity } = LOOK.hemisphere;
  scene.add(new THREE.HemisphereLight(sky, below, intensity));

  const model = gltf.scene.clone(true);
  model.traverse((o) => {
    if (o.isMesh) {
      o.castShadow = true;
      o.receiveShadow = true;
      o.frustumCulled = false;
    }
  });
  const chapp = model.getObjectByName('Chapp');
  const body = model.getObjectByName('Body');
  const box = new THREE.Box3().setFromObject(body);
  const center = box.getCenter(new THREE.Vector3());
  const radius = Math.max(...box.getSize(new THREE.Vector3()).toArray()) / 2;
  // turn: what a finger turns. tilt: a pose's head tilt. Both pivot on the middle of the body.
  const tilt = new THREE.Group();
  const turn = new THREE.Group();
  model.position.copy(center).negate();
  tilt.add(model);
  turn.add(tilt);
  turn.position.copy(center);
  turn.rotation.y = YAW;
  scene.add(turn);

  let floor = null;
  if (ground) {
    const paper = document.createElement('canvas');
    paper.width = paper.height = 256;
    const g = paper.getContext('2d');
    const r = g.createRadialGradient(128, 128, 4, 128, 128, 125);
    r.addColorStop(0, 'rgba(43, 94, 128, 0.24)');
    r.addColorStop(0.45, 'rgba(61, 123, 153, 0.10)');
    r.addColorStop(1, 'rgba(55, 95, 143, 0)');
    g.fillStyle = r;
    g.fillRect(0, 0, 256, 256);
    const map = new THREE.CanvasTexture(paper);
    map.colorSpace = THREE.SRGBColorSpace;
    floor = new THREE.Mesh(new THREE.PlaneGeometry(radius * 2.7, radius * 2.7), new THREE.MeshBasicMaterial({ map, transparent: true, depthWrite: false, toneMapped: false }));
    floor.rotation.x = -Math.PI / 2;
    floor.position.set(center.x, box.min.y - 0.05, center.z);
    scene.add(floor);
  }

  const camera = new THREE.PerspectiveCamera(FOV, width / height, 0.1, 100);
  const dist = radius / FILL / Math.tan(THREE.MathUtils.degToRad(FOV / 2));
  camera.position.set(center.x, center.y + Math.sin(PITCH) * dist, center.z + Math.cos(PITCH) * dist);
  camera.lookAt(center);
  camera.zoom = fit;
  if (shiftY) camera.setViewOffset(width, height, 0, shiftY, width, height);
  camera.updateProjectionMatrix();

  // The face: every part the expression clips move, blended from one face to the next.
  const table = faceTable(gltf);
  const chans = (table.Neutral || [])
    .map(({ node, prop, value }) => ({ obj: model.getObjectByName(node), prop, cur: value.slice(), from: value.slice(), to: value.slice() }))
    .filter((c) => c.obj);
  const byName = new Map(chans.map((c) => [c.obj.name + '.' + c.prop, c]));
  const parts = [...new Set(chans.map((c) => c.obj))];
  const eyes = ['Eye_L', 'Eye_R'].map((n) => model.getObjectByName(n)).filter(Boolean);
  const eyeParts = new Set([...eyes, ...['Closed_L', 'Closed_R', 'Sleep_L', 'Sleep_R'].map((n) => model.getObjectByName(n))]);
  const glints = [];
  model.traverse((o) => /highlight/i.test(o.name) && glints.push(o));
  const qa = new THREE.Quaternion();
  const qb = new THREE.Quaternion();
  let faceAt = 0;
  let faceMs = 0;
  let blinkAt = 0;
  let nextBlink = 0;

  const view = {
    renderer, scene, camera, model, body, turn, tilt, center, radius, floor,
    canvas: renderer.domElement,
    behind: new THREE.Color(1, 1, 1), // what shows through the gel: the page, or the intro's sea
    face: 'Neutral',
    breathe: true, // the slow rise of the model's Idle clip
    blinking: true, // now and then, while the eyes are open
    closed: 0, // 0 open … 1 shut, for stills
    look: [0, 0], // the eyes nudged by this much
    pop: [1, 1], // the eyes, and the rest of the face: 0 not there … 1 there
    setFace(name, ms = 160) {
      if (!table[name]) return;
      for (const tr of table[name]) {
        const c = byName.get(tr.node + '.' + tr.prop);
        if (c) {
          c.from = c.cur.slice();
          c.to = tr.value;
        }
      }
      faceAt = performance.now();
      faceMs = ms;
      view.face = name;
    },
    blink() {
      blinkAt = performance.now();
    },
    update(now = performance.now()) {
      const e = smooth(faceMs ? clamp((now - faceAt) / faceMs, 0, 1) : 1);
      for (const c of chans) {
        if (c.prop === 'quaternion') {
          qa.fromArray(c.from).slerp(qb.fromArray(c.to), e);
          qa.toArray(c.cur);
          c.obj.quaternion.copy(qa);
        } else {
          for (let i = 0; i < c.cur.length; i++) c.cur[i] = c.from[i] + (c.to[i] - c.from[i]) * e;
          c.obj[c.prop].fromArray(c.cur);
        }
      }
      let open = 1 - 0.94 * view.closed;
      if (view.blinking && OPEN.has(view.face)) {
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
        eye.position.x += view.look[0];
        eye.position.y += view.look[1];
      }
      for (const g of glints) g.visible = open > 0.35;
      if (view.pop[0] !== 1 || view.pop[1] !== 1) {
        for (const o of parts) o.scale.multiplyScalar(Math.max(1e-5, eyeParts.has(o) ? view.pop[0] : view.pop[1]));
      }
      const s = view.breathe ? (1 - Math.cos((now / 4000) * Math.PI * 2)) / 2 : 0;
      chapp.position.y = 0.045 * s;
      chapp.scale.set(1 + 0.012 * s, 1 + 0.02 * s, 1 + 0.012 * s);
    },
    render(now = performance.now()) {
      view.update(now);
      seeBehind(view.behind);
      renderer.render(scene, camera);
    },
    dispose() {
      env.dispose();
      if (floor) {
        floor.geometry.dispose();
        floor.material.map.dispose();
        floor.material.dispose();
      }
      renderer.dispose();
      renderer.forceContextLoss();
      renderer.domElement.remove();
    },
  };
  return view;
}

/**
 * A square still, posed and drawn once; lookdev.html saves these into public/chapp.
 * fit < 1 leaves room round the body for the faces that reach past it (thought bubbles, Zs, sparks).
 */
export async function createStill({ url, size = 600, fit = 1 } = {}) {
  const view = await createView({ url, width: size, height: size, dpr: 1, fit, preserve: true });
  view.breathe = false;
  view.blinking = false;
  return {
    canvas: view.canvas,
    pose({ face = 'Neutral', closed = 0, tilt = 0, look = [0, 0], turn = 0 } = {}) {
      view.setFace(face, 0);
      view.closed = closed;
      view.look = look;
      view.tilt.rotation.z = tilt;
      view.turn.rotation.set(0, YAW + turn, 0);
      view.render();
    },
  };
}

/**
 * Chapp in the middle of the screen. Drag to turn it; it drifts back to face you when left alone.
 * A tap changes the face. fit: the still's size over the element's, so the first frame matches the still;
 * face and tilt: how it looks on the board it came from; the lean goes once you tap it for another face.
 */
export async function mountStage(el, { url, fit = 1, face = 'Neutral', tilt = 0 } = {}) {
  const view = await createView({ url, width: el.clientWidth || 402, height: el.clientHeight || 402, fit, ground: true });
  view.setFace(face, 0);
  view.tilt.rotation.z = tilt;
  let lean = tilt;
  const canvas = view.canvas;
  canvas.style.display = 'block';
  canvas.style.touchAction = 'none';
  canvas.style.cursor = 'grab';
  canvas.setAttribute('aria-hidden', 'true');
  el.appendChild(canvas);
  const calm = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
  // Taps go round all eight faces, starting after the one it came with.
  const faces = ['Happy', 'Excited', 'Wink', 'Surprised', 'Thinking', 'Sleepy', 'Sad', 'Neutral'];
  let yaw = 0, pitch = 0, vy = 0, vp = 0, drag = null, still = performance.now(), spin = 0, hop = 0;
  let n = faces.indexOf(face);
  let tapped = false;
  let raf = 0, alive = true;
  // The board may be shown smaller than it is (a zoomed-out canvas); turn by the board's pixels.
  const zoom = () => canvas.getBoundingClientRect().width / (canvas.clientWidth || 1) || 1;
  canvas.addEventListener('pointerdown', (e) => {
    e.stopPropagation();
    canvas.setPointerCapture?.(e.pointerId);
    canvas.style.cursor = 'grabbing';
    drag = { x: e.clientX, y: e.clientY, moved: 0, at: performance.now() };
    vy = vp = 0;
    spin = 0;
  });
  canvas.addEventListener('pointermove', (e) => {
    if (!drag) return;
    const z = zoom();
    const dx = (e.clientX - drag.x) / z;
    const dy = (e.clientY - drag.y) / z;
    drag.x = e.clientX;
    drag.y = e.clientY;
    drag.moved += Math.abs(dx) + Math.abs(dy);
    vy = dx * 0.011;
    vp = dy * 0.008;
    yaw += vy;
    pitch = clamp(pitch + vp, -0.8, 0.8);
    still = performance.now();
  });
  const up = (e) => {
    if (!drag) return;
    e.stopPropagation();
    const tap = drag.moved < 8 && performance.now() - drag.at < 400;
    drag = null;
    canvas.style.cursor = 'grab';
    still = performance.now();
    if (tap) {
      vy = vp = 0;
      tapped = true;
      lean = 0;
      n = (n + 1) % faces.length;
      view.setFace(faces[n]);
      if (!calm) hop = performance.now();
    }
  };
  canvas.addEventListener('pointerup', up);
  canvas.addEventListener('pointercancel', up);
  canvas.addEventListener('click', (e) => e.stopPropagation());

  const frame = (now) => {
    if (!alive) return;
    if (!drag) {
      yaw += vy;
      pitch = clamp(pitch + vp, -0.8, 0.8);
      vy *= 0.93;
      vp *= 0.9;
      if (Math.abs(vy) + Math.abs(vp) < 0.0005 && now - still > 2600) {
        const front = Math.round(yaw / (Math.PI * 2)) * Math.PI * 2;
        yaw += (front - yaw) * 0.045;
        pitch -= pitch * 0.045;
      }
    }
    let off = 0;
    let lift = 0;
    if (spin) {
      const k = clamp((now - spin) / 1300, 0, 1);
      off = (1 - outCubic(k)) * -Math.PI * 2;
      if (k >= 1) spin = 0;
    }
    if (hop) {
      const k = clamp((now - hop) / 420, 0, 1);
      lift = Math.sin(Math.PI * k) * 0.14;
      if (k >= 1) hop = 0;
    }
    view.turn.rotation.set(pitch, YAW + yaw + off, 0);
    view.turn.position.y = view.center.y + lift;
    view.tilt.rotation.z += (lean - view.tilt.rotation.z) * 0.1;
    view.render(now);
    raf = requestAnimationFrame(frame);
  };
  view.render();
  raf = requestAnimationFrame(frame);
  return {
    // A turn of welcome once it has landed in the middle; a plain face also smiles for a moment.
    arrive() {
      if (!calm) spin = performance.now();
      if (face !== 'Neutral') return;
      setTimeout(() => alive && !tapped && view.setFace('Happy', 200), 1000);
      setTimeout(() => alive && !tapped && view.setFace('Neutral', 240), 2400);
    },
    dispose() {
      alive = false;
      cancelAnimationFrame(raf);
      view.dispose();
    },
  };
}

/**
 * The opening, drawn over the whole screen: 0 the deep sea, 1 one small protein in the heat, 2 the other 23
 * coming together, 3 Chapp opens its eyes as the light comes up, 4 Chapp. The backdrop is painted here as well,
 * so the gel refracts what is behind it; light is the background it ends on (6-digit hex). show(card, ms) starts
 * a card, ms into it.
 */
export async function mountIntro(el, { url, fit = 0.37, shiftY = 107, light = '#ffffff' } = {}) {
  const w = el.clientWidth || 402;
  const h = el.clientHeight || 874;
  const view = await createView({ url, width: w, height: h, fit, shiftY });
  view.renderer.setClearColor(0x000000, 1);
  const canvas = view.canvas;
  canvas.style.display = 'block';
  canvas.setAttribute('aria-hidden', 'true');
  el.appendChild(canvas);

  // The backdrop, at half size: the app's light with its glow, the deep sea over it, the heat in the middle.
  const paper = document.createElement('canvas');
  paper.width = Math.round(w / 2);
  paper.height = Math.round(h / 2);
  const g = paper.getContext('2d');
  const tex = new THREE.CanvasTexture(paper);
  tex.colorSpace = THREE.SRGBColorSpace;
  view.scene.background = tex;
  const cy = (h / 2 - shiftY) / 2;
  let painted = '';
  const paint = (dark, heat) => {
    const key = dark.toFixed(3) + ' ' + heat.toFixed(3);
    if (key === painted) return;
    painted = key;
    const W = paper.width;
    const H = paper.height;
    g.globalAlpha = 1;
    g.fillStyle = light;
    g.fillRect(0, 0, W, H);
    let r = g.createRadialGradient(W / 2, cy, 0, W / 2, cy, 115);
    r.addColorStop(0, 'rgba(121, 185, 243, 0.30)');
    r.addColorStop(0.55, 'rgba(111, 211, 198, 0.10)');
    r.addColorStop(0.8, light + '00');
    r.addColorStop(1, light + '00');
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

  // The 24 pieces, each on a pivot at its own middle so it can tumble on the way in.
  const body = view.body;
  const pieces = body.children.slice().map((mesh, i) => {
    const c = new THREE.Box3().setFromBufferAttribute(mesh.geometry.attributes.position).getCenter(new THREE.Vector3());
    const pivot = new THREE.Group();
    pivot.position.copy(c);
    body.add(pivot);
    pivot.add(mesh);
    mesh.position.copy(c).negate();
    return { pivot, c, dir: c.clone().normalize(), spin: [1, 2, 3].map((k) => (noise(i, k) - 0.5) * 3) };
  });
  // The one that starts alone faces the camera; the rest arrive nearest first, so the shell grows around it.
  const hero = pieces.reduce((a, b) => (b.c.z > a.c.z ? b : a));
  pieces.filter((p) => p !== hero).sort((a, b) => b.dir.dot(hero.dir) - a.dir.dot(hero.dir)).forEach((p, k) => (p.order = k));
  const heat = new THREE.PointLight(0xff8a3d, 0, 7, 1.6);
  heat.position.set(0, -1.4, 1.8);
  view.scene.add(heat);
  const turned = new THREE.Euler(0.42, YAW + 2.4, 0); // card 1 and the start of card 2
  const heroFrom = new THREE.Euler();
  let heroTo = 0; // the whole turn nearest to where the lone piece had spun
  const HERO = 1.8; // the lone piece, enlarged
  // Each piece flies in from the edge of the screen nearest its place, a little behind, never toward the camera.
  const startQ = new THREE.Quaternion().setFromEuler(turned);
  pieces.forEach((p, i) => {
    const w = p.c.clone().applyQuaternion(startQ);
    const xy = new THREE.Vector2(w.x, w.y);
    if (xy.lengthSq() < 1e-4) xy.set(1, 0);
    xy.normalize();
    p.from = new THREE.Vector3(xy.x * 2.7, xy.y * 2.7, -1.1 - noise(i, 4) * 1.2);
  });
  const qInv = new THREE.Quaternion();
  const off = new THREE.Vector3();
  // The backdrop at Chapp's middle, which shows through the gel: the light with its glow, the sea, the heat.
  const lightMiddle = new THREE.Color(light).lerp(new THREE.Color('#79b9f3'), 0.3);
  const seaMiddle = new THREE.Color('#082440');
  const heatColour = new THREE.Color('#ff8a3d');

  let card = -1;
  let at = 0;
  let done = {};
  let raf = 0;
  let alive = true;
  let seen = true;
  const io = typeof IntersectionObserver === 'function' ? new IntersectionObserver((es) => (seen = es.some((e) => e.isIntersecting))) : null;
  io?.observe(el);

  const heroSpin = (t) => [0.35 * Math.sin(t * 0.9), t * 0.55, 0.25 * Math.sin(t * 0.7)];
  const frame = (now) => {
    if (!alive) return;
    raf = requestAnimationFrame(frame);
    if (!seen) return;
    const t = (now - at) / 1000;
    let dark = 1;
    let warm = 0;
    view.turn.visible = card >= 1;
    view.breathe = card >= 3;
    view.blinking = card >= 3;
    view.pop = card >= 3 ? view.pop : [0, 0];
    if (card === 1) {
      warm = clamp(t / 1.2, 0, 1);
      for (const p of pieces) p.pivot.visible = p === hero;
      hero.pivot.position.copy(view.center);
      hero.pivot.scale.setScalar(Math.max(1e-4, HERO * outBack(clamp(t / 1.1, 0, 1))));
      hero.pivot.rotation.set(...heroSpin(t));
      view.turn.rotation.copy(turned);
    } else if (card === 2) {
      warm = 1 - clamp((t - 3.6) / 1.6, 0, 1);
      const turnK = inOutCubic(clamp(t / 5.4, 0, 1));
      view.turn.rotation.set(turned.x * (1 - turnK), YAW + (turned.y - YAW) * (1 - turnK), 0);
      qInv.copy(view.turn.quaternion).invert();
      for (const p of pieces) {
        p.pivot.visible = true;
        if (p === hero) {
          const k = inOutCubic(clamp(t / 1.5, 0, 1));
          p.pivot.position.lerpVectors(view.center, p.c, k);
          p.pivot.scale.setScalar(HERO + (1 - HERO) * k);
          p.pivot.rotation.set(heroFrom.x * (1 - k), heroFrom.y + (heroTo - heroFrom.y) * k, heroFrom.z * (1 - k));
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
        view.pop = [outBack(clamp((t - 0.5) / 0.5, 0, 1)), outBack(clamp((t - 0.78) / 0.45, 0, 1))];
        view.turn.rotation.set(0, YAW, 0);
        if (t > 1.8 && !done.blink) (done.blink = true), view.blink();
        if (t > 2.6 && !done.happy) (done.happy = true), view.setFace('Happy', 200);
        if (t > 4.0 && !done.back) (done.back = true), view.setFace('Neutral', 240);
      } else {
        dark = 0;
        view.pop = [1, 1];
        view.turn.rotation.set(0, YAW + 0.16 * Math.sin(t * 0.7), 0);
      }
    }
    heat.intensity = 5 * warm * dark * (0.85 + 0.15 * Math.sin(t * 5.3));
    paint(dark, warm);
    view.behind.copy(lightMiddle).lerp(seaMiddle, dark).lerp(heatColour, 0.22 * dark * warm);
    view.render(now);
  };
  paint(1, 0);
  view.render();
  raf = requestAnimationFrame(frame);
  return {
    canvas,
    show(n, ms = 0) {
      if (card === 1 && n === 2) heroFrom.set(...heroSpin((performance.now() - at) / 1000));
      else if (n === 2) heroFrom.set(0, 0, 0);
      heroTo = Math.round(heroFrom.y / (Math.PI * 2)) * Math.PI * 2;
      card = n;
      at = performance.now() - ms;
      done = {};
      if (n >= 3) view.setFace('Neutral', 0);
      if (n === 4) view.pop = [1, 1];
    },
    dispose() {
      alive = false;
      cancelAnimationFrame(raf);
      io?.disconnect();
      tex.dispose();
      view.dispose();
    },
  };
}
