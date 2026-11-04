import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import basicSsl from '@vitejs/plugin-basic-ssl';

// The Node server (npm start) owns /api; Vite forwards to it during development.
// HTTPS=1 serves the app over HTTPS with a self-signed certificate: phones only open the microphone and camera on HTTPS.
// On the tailnet, `tailscale serve` gives it a real certificate at https://<machine>.<tailnet>.ts.net:8444, so Vite
// has to accept that host name.
export default defineConfig({
  plugins: [react(), tailwindcss(), ...(process.env.HTTPS ? [basicSsl()] : [])],
  server: {
    port: 5175,
    allowedHosts: ['.ts.net'],
    // ws: live speech is a WebSocket (/api/voice/live).
    proxy: {
      '/api': {
        target: `http://127.0.0.1:${process.env.API_PORT || 3003}`,
        ws: true,
        // A phone that gives up on an answer (or a start made on words that did not become the turn) must reach the
        // API server, so that its model calls stop: on its own the proxy keeps the server's side open after the phone
        // has gone (measured 2026-10-31: a request cancelled at 0.6 s still ran its model call to the end).
        configure: proxy => {
          proxy.on('proxyReq', (proxyReq, _req, res) => {
            // Over HTTP/2 the phone's response reports itself finished when the phone cancels, so the upstream's own
            // end is what tells a completed answer from an abandoned one.
            let upstreamEnded = false;
            proxyReq.on('response', upstream => upstream.on('end', () => { upstreamEnded = true; }));
            res.on('close', () => {
              if (!upstreamEnded) proxyReq.destroy();
            });
          });
        },
      },
    },
  },
});
