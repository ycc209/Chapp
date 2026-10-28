import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import basicSsl from '@vitejs/plugin-basic-ssl';

// The Node server (npm start) owns /api; Vite forwards to it during development.
// HTTPS=1 serves the app over HTTPS with a self-signed certificate: phones only open the microphone and camera on HTTPS.
// On the tailnet, `tailscale serve` gives it a real certificate at https://lab-mac.example.ts.net:8444, so Vite
// has to accept that host name.
export default defineConfig({
  plugins: [react(), tailwindcss(), ...(process.env.HTTPS ? [basicSsl()] : [])],
  server: {
    port: 5175,
    allowedHosts: ['.ts.net'],
    proxy: { '/api': `http://127.0.0.1:${process.env.API_PORT || 3003}` },
  },
});
