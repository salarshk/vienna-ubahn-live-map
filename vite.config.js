import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// Build-time date-stamp injected as a global constant so the running app can
// always report which build it is. Format: YYYY.MM.DD (UTC). Baked in at
// compile time — no manual version bump needed.
const buildDate = new Date().toISOString().slice(0, 10).replace(/-/g, '.');
const isGitHubPages = process.env.GITHUB_PAGES === 'true';

// https://vite.dev/config/
export default defineConfig({
  base: isGitHubPages ? '/vienna-ubahn-live-map/' : '/',
  define: {
    __APP_VERSION__: JSON.stringify(buildDate),
  },
  plugins: [react()],
  optimizeDeps: {
    exclude: ['maplibre-gl']
  },
  build: {
    // maplibre-gl alone is ~1 MB of ES modules (546K + 470K shared), and a
    // full-screen map cannot defer its map engine for any real gain. The
    // default 500 kB warning can therefore never be satisfied. The compact
    // annual S-Bahn timetable adds another ~1.5 MB uncompressed (~215 kB gzip),
    // so the limit is raised just above the combined bundle rather than
    // silenced; it still works as a ratchet if the app grows again.
    //
    // The only real reduction available was the line geometry, simplified by
    // scripts/simplify_line_geometry.cjs: 1,373 kB → 1,265 kB, essentially all
    // of it metro_lines.json. Line 4's geometry moving to public/ and the
    // react-map-gl removal were correctness and hygiene fixes — neither was in
    // the bundle to begin with, so neither saved a byte.
    //
    // Remaining option if this ever matters: lazy-load MapView so the sidebar
    // paints before the map engine arrives. It defers bytes rather than
    // removing them, which is why it was not done here.
    chunkSizeWarningLimit: 3100,
  },
  server: {
    // Relay Wiener Linien's monitor endpoint in development. The native app
    // calls the same keyless endpoint directly through CapacitorHttp.
    proxy: {
      '/api/vienna': {
        target: 'https://www.wienerlinien.at',
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/api\/vienna/, '/ogd_realtime'),
      }
    }
  }
})
