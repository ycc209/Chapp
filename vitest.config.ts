import { defineConfig, mergeConfig } from 'vitest/config';
import vite from './vite.config.ts';

// The app's Vite config, plus the demo BCA protocol for a clean checkout (tests/setup-demo.ts).
export default mergeConfig(vite, defineConfig({ test: { globalSetup: ['tests/setup-demo.ts'] } }));
