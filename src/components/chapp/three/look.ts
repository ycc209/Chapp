import {
  Box3,
  Color,
  MathUtils,
  NeutralToneMapping,
  SRGBColorSpace,
  Vector3,
  type BufferAttribute,
  type Material,
  type Mesh,
  type MeshPhysicalMaterial,
} from 'three';
import type { ChappGLTF } from './rig.ts';

/**
 * How Chapp looks, in one place: the renderer, the light and the gel. The stage, the intro and the stills in
 * public/chapp (scripts/chapp-model/lookdev.html) all draw with these, so a picture and the 3D Chapp it becomes match.
 *
 * The look follows the concept art (data/design/reference/chapp-original.png): a saturated blue → teal → lavender gel,
 * deep in the crevices, glowing from inside, with small sharp highlights. The V4 model first looked milky ("霧霧的")
 * for five reasons, each answered below: ACES tone mapping bleached it, the white room lit it evenly from every side,
 * the transmissive gel let the white page through (and refracted only white), its colours were flat pastels, and a 3×
 * phone drew it at 2×.
 */
export const LOOK = {
  /**
   * Khronos PBR Neutral keeps a base colour the colour it is; ACES (three's and R3F's default) bleached the pastel gel
   * towards grey-white and AgX greyed it further.
   */
  toneMapping: NeutralToneMapping,
  exposure: 1,
  /**
   * Up to the phone's own 3×: at 2× a 3× screen stretched every frame by 1.5 and softened every edge. Paid for by the
   * gel's light through (gel.through), which costs a fraction of three's transmission.
   */
  dpr: [1, 3] as [number, number],
  env: {
    /** The soft room's reflections: the gloss on every bump. */
    intensity: 1.5,
    /** How much of the room lights the gel from all sides (of intensity); at full strength it washed the colour out. */
    diffuse: 0.33,
  },
  /** A warm key, a cool fill, lilac and mint rims, and the sky above (colour, intensity, position). */
  lights: [
    { color: 0xfff7ed, intensity: 2, position: [-3, 5, 5], shadow: true },
    { color: 0xc8f6ff, intensity: 0.7, position: [4, 1, 3] },
    { color: 0xd7c5ff, intensity: 1.7, position: [2, 4, -3] },
    { color: 0xc5ffef, intensity: 1.15, position: [-4, 2, -1] },
  ] as { color: number; intensity: number; position: [number, number, number]; shadow?: boolean }[],
  hemisphere: { sky: 0xeaf9ff, ground: 0x8894ba, intensity: 0.45 },
  /** The body's material (glTF "Hydrated molecular gel"), on top of what the model sets. */
  gel: {
    /**
     * What is behind shows through this much of the gel, tinted by `thickness` of it (glTF volume: attenuation colour
     * and distance), so the light coming through is a deep blue glow, not the page's white. Drawn as three's
     * transmission would draw it against a plain backdrop (seeBehind), without its extra pass over the whole scene,
     * which made each frame 4 to 5 times slower.
     */
    through: { amount: 0.38, thickness: 0.6, colour: [0.35, 0.62, 1] as [number, number, number], distance: 0.7 },
    /** A wet top coat with small, sharp highlights. */
    clearcoat: 1,
    clearcoatRoughness: 0.07,
    /** The lights shining out through the gel's edges (see dressGel): how strong, how tight, how much the surface bends them. */
    glow: { strength: 1.5, power: 3, bend: 0.5 },
    /** The light inside (see dressGel): how strong, how much it keeps to the parts facing you, how pale. */
    inner: { strength: 0.2, power: 2, whiten: 0.5 },
  },
  /** The body's colours, from each subunit's own colour in the model. */
  colour: {
    /** More saturated than the model's pastels. */
    saturation: 1.3,
    /**
     * Distance from the middle over the body's radius: the hollow inside and the crevices (inner) are deeper, the
     * outer bumps lighter, by up to `amount` of lightness either way around `mid`.
     */
    inner: 0.6,
    outer: 0.98,
    mid: 0.7,
    amount: 0.3,
    /** A slow marbling across the ball: the hue drifts by up to this many degrees toward teal or lavender. */
    marble: 20,
    /**
     * Round the face (between the eyes, a little lower) the gel is paler, as in the concept art: the eyes and the
     * mouth stand out, even at the avatar's 96 px. Full within `inner` degrees of the middle of the face, gone by `outer`.
     */
    face: { lift: 0.06, soften: 0.1, inner: 14, outer: 34 },
  },
};

const GEL = 'Hydrated molecular gel';
const dressed = new WeakSet<object>();
const WHITE = new Color(1, 1, 1);

/** What is behind the gel, as the next frame draws it (linear colour). */
const behind = { value: new Color(1, 1, 1) };

/**
 * Sets what shows through the gel in the next frame: white for the stage and the stills (the page and the veil are
 * white), the deep sea in the intro. Call it every frame before the canvas draws.
 */
export function seeBehind(colour: Color = WHITE) {
  behind.value.copy(colour);
}

/**
 * Puts the look on the loaded model, once: the body's colours and its gel. The copies (createRig) share both.
 * again: put it on afresh from the model's own colours, after LOOK has changed (look-dev).
 */
export function dressChapp(gltf: ChappGLTF, again = false) {
  if (dressed.has(gltf) && !again) return;
  dressed.add(gltf);
  const meshes: Mesh[] = [];
  gltf.scene.traverse(o => {
    const mesh = o as Mesh;
    if (mesh.isMesh && (mesh.material as Material).name === GEL) meshes.push(mesh);
  });
  const box = new Box3();
  for (const m of meshes) {
    m.geometry.computeBoundingBox();
    box.union(m.geometry.boundingBox!);
  }
  const middle = box.getCenter(new Vector3());
  const radius = Math.max(...box.getSize(new Vector3()).toArray()) / 2;
  // Where the face looks out, from the middle: between the eyes, a little lower.
  gltf.scene.updateMatrixWorld(true);
  const eyes = ['Eye_L', 'Eye_R'].flatMap(n => gltf.scene.getObjectByName(n) ?? []);
  const face = new Vector3(0, 0, 1);
  if (eyes.length === 2) {
    face.set(0, 0, 0);
    for (const e of eyes) face.add(e.getWorldPosition(new Vector3()).sub(middle).multiplyScalar(0.5));
    face.y -= 0.1 * radius;
    face.normalize();
  }
  for (const { geometry } of meshes) {
    const colour = geometry.attributes.color as BufferAttribute | undefined;
    if (!colour) continue;
    geometry.userData.modelColour ??= colour.clone();
    recolour(geometry.userData.modelColour as BufferAttribute, colour, geometry.attributes.position as BufferAttribute, middle, radius, face);
  }
  for (const material of new Set(meshes.map(m => m.material as MeshPhysicalMaterial))) dressGel(material, middle, radius);
}

const c = new Color();
const hsl = { h: 0, s: 0, l: 0 };
const p = new Vector3();
const smooth = (a: number, b: number, x: number) => {
  const k = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return k * k * (3 - 2 * k);
};

function recolour(from: BufferAttribute, to: BufferAttribute, position: BufferAttribute, middle: Vector3, radius: number, face: Vector3) {
  const { saturation, inner, outer, mid, amount, marble } = LOOK.colour;
  const { lift, soften } = LOOK.colour.face;
  const near = Math.cos(MathUtils.degToRad(LOOK.colour.face.inner));
  const far = Math.cos(MathUtils.degToRad(LOOK.colour.face.outer));
  for (let i = 0; i < from.count; i++) {
    c.setRGB(from.getX(i), from.getY(i), from.getZ(i)); // glTF vertex colours are linear
    c.getHSL(hsl, SRGBColorSpace); // shifted as the eye sees it
    p.fromBufferAttribute(position, i).sub(middle);
    const depth = smooth(inner, outer, p.length() / radius);
    p.divideScalar(radius);
    const facing = smooth(far, near, p.dot(face) / p.length()) * depth;
    const swirl = Math.sin(1.9 * p.x + 2.3 * p.y + 0.4) * Math.sin(2.1 * p.z - 1.3 * p.x + 1.1) + 0.5 * Math.sin(3.1 * p.y - 2.2 * p.z);
    const h = hsl.h + (marble / 360) * swirl;
    c.setHSL(
      h - Math.floor(h),
      Math.min(1, hsl.s * saturation * (1 - soften * facing)),
      Math.min(0.97, Math.max(0.05, hsl.l + (depth - mid) * amount + lift * facing)),
      SRGBColorSpace,
    );
    to.setXYZ(i, c.r, c.g, c.b);
  }
  to.needsUpdate = true;
}

const f = (x: number) => x.toFixed(4);

function dressGel(material: MeshPhysicalMaterial, middle: Vector3, radius: number) {
  const { through, glow, inner, ...rest } = LOOK.gel;
  const { inner: from, outer: to } = LOOK.colour;
  Object.assign(material, rest);
  // three's transmission off: the gel's own light through (below) instead.
  material.transmission = 0;
  const tint = through.colour.map(k => f(k ** (through.thickness / through.distance))).join(', ');
  const key = [LOOK.env.diffuse, through.amount, glow.strength, glow.power, glow.bend, inner.strength, inner.power, inner.whiten, from, to]
    .map(f)
    .join(' ');
  material.onBeforeCompile = shader => {
    shader.uniforms.chappBehind = behind;
    // How far out from the middle this point of the body is: 0 in the hollow and the crevices … 1 on the outer bumps.
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nvarying float vChappOut;')
      .replace(
        '#include <begin_vertex>',
        `#include <begin_vertex>
	vChappOut = smoothstep( ${f(from)}, ${f(to)}, length( position - vec3( ${[middle.x, middle.y, middle.z].map(f).join(', ')} ) ) / ${f(radius)} );`,
      );
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>\nvarying float vChappOut;\nuniform vec3 chappBehind;')
      // The light inside: the outer gel facing you glows a paler version of its colour.
      .replace(
        '#include <emissivemap_fragment>',
        `#include <emissivemap_fragment>
	totalEmissiveRadiance += mix( diffuseColor.rgb, vec3( 1.0 ), ${f(inner.whiten)} ) * ${f(inner.strength)} * vChappOut * pow( saturate( dot( normal, normalize( vViewPosition ) ) ), ${f(inner.power)} );`,
      )
      // Light through the gel: each light also shines out of the side of the gel away from it, most where it comes
      // from behind toward the eye, tinted by the gel; the rims glow (a cheap stand-in for subsurface scattering).
      .replace(
        '#include <lights_physical_pars_fragment>',
        `#include <lights_physical_pars_fragment>
void RE_Direct_Gel( const in IncidentLight directLight, const in vec3 geometryPosition, const in vec3 geometryNormal, const in vec3 geometryViewDir, const in vec3 geometryClearcoatNormal, const in PhysicalMaterial material, inout ReflectedLight reflectedLight ) {
	RE_Direct_Physical( directLight, geometryPosition, geometryNormal, geometryViewDir, geometryClearcoatNormal, material, reflectedLight );
	vec3 through = normalize( directLight.direction + geometryNormal * ${f(glow.bend)} );
	float k = pow( saturate( dot( geometryViewDir, - through ) ), ${f(glow.power)} ) * ${f(glow.strength)};
	reflectedLight.directDiffuse += k * directLight.color * material.diffuseColor;
}
#undef RE_Direct
#define RE_Direct RE_Direct_Gel`,
      )
      // Less of the room's light from all sides; its reflections stay.
      .replace('#include <lights_fragment_maps>', `#include <lights_fragment_maps>\n\tiblIrradiance *= ${f(LOOK.env.diffuse)};`)
      // What is behind, seen through the gel and tinted by it: three's transmission against a plain backdrop. The gel
      // stays solid (three's own let the page show through a transparent canvas).
      .replace(
        '#include <transmission_fragment>',
        `vec3 seen = ( 1.0 - EnvironmentBRDF( normal, normalize( vViewPosition ), material.specularColor, material.specularF90, material.roughness ) )
		* material.diffuseColor * vec3( ${tint} ) * chappBehind;
	totalDiffuse = mix( totalDiffuse, seen, ${f(through.amount)} );`,
      );
  };
  material.customProgramCacheKey = () => `chapp-gel ${key} ${tint}`;
  material.needsUpdate = true;
}
