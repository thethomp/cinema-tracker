import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

/**
 * The web UI lives in `web/` and is built into `web/dist`, which the Hono
 * server serves statically. Dev proxies `/api` to the API process so the
 * browser only ever talks to one origin and there is no CORS layer to get
 * wrong.
 */
export default defineConfig({
  root: 'web',
  plugins: [react()],
  build: {
    outDir: 'dist',
    emptyOutDir: true,
  },
  server: {
    port: 5173,
    proxy: {
      '/api': {
        target: 'http://localhost:8787',
        changeOrigin: false,
      },
    },
  },
})
