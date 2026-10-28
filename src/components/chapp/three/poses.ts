import type { Expression } from '../../../../shared/ai.ts';

// No three.js in here: the home screen imports this to pick the picture that flies, and must stay free of WebGL code.

/** The model's expression clips (public/chapp/chapp.glb). */
export type Clip = 'Neutral' | 'Happy' | 'Thinking' | 'Excited' | 'Surprised' | 'Sad' | 'Wink' | 'Sleepy';

/** One face as the stills in public/chapp were drawn (scripts/chapp-model/lookdev.html), so the 3D can start from it. */
export type Pose = {
  clip: Clip;
  /** Head tilt, radians: Thinking and Sleepy lean toward their bubbles and Zs; listening leans the other way. */
  tilt: number;
  /** The eyes nudged by this much (listening looks up a little). */
  look: [number, number];
  /** Turn on top of the usual three-quarter view. */
  turn: number;
  /** The picture of this pose. */
  still: string;
  /**
   * Roomy stills are 720 px with the body the same 468 px as the 600 px ones, which leaves room for bubbles, Zs and
   * sparks; shown at the same box size, their body is 600/720 as big.
   */
  roomy: boolean;
};

const face = (clip: Clip, tilt = 0): Pose => ({
  clip,
  tilt,
  look: [0, 0],
  turn: 0,
  still: `/chapp/chapp-${clip.toLowerCase()}.webp`,
  roomy: true,
});

// listen has no clip of its own: it is the Neutral face with the head tilted and the eyes up, exactly how
// chapp-listen.webp was drawn.
const POSES: Record<Expression, Pose> = {
  neutral: { clip: 'Neutral', tilt: 0, look: [0, 0], turn: 0, still: '/chapp/chapp.webp', roomy: false },
  listen: { clip: 'Neutral', tilt: 0.12, look: [0.012, 0.05], turn: -0.05, still: '/chapp/chapp-listen.webp', roomy: false },
  happy: face('Happy'),
  thinking: face('Thinking', -0.3),
  excited: face('Excited'),
  surprised: face('Surprised'),
  sad: face('Sad'),
  wink: face('Wink'),
  sleepy: face('Sleepy', -0.3),
};

export function poseFor(expression: Expression): Pose {
  return POSES[expression] ?? POSES.neutral;
}

/** The body's share of a still's box, against the plain 600 px stills. */
export const bodyShare = (pose: Pose) => (pose.roomy ? 600 / 720 : 1);

/** prefers-reduced-motion: no flights, spins or hops; fades stay. */
export function prefersCalm() {
  return typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
}
