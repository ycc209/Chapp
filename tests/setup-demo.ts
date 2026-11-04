import { seedDemo } from '../server/ai/protocols.ts';

// Run once before the tests (vitest.config.ts): a clean checkout gets the demo BCA protocol in data/protocols/, as the
// server gives it on its first start, so the tests that read it run without the hand-made one.
export default function setup() {
  seedDemo();
}
