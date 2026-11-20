import { defineConfig } from "vite";

// Config Vite adaptée à Tauri : port fixe, pas d'effacement de l'écran,
// build ciblant le WebKit de macOS 13 Ventura (pas de polyfills inutiles).
export default defineConfig({
  clearScreen: false,
  server: { port: 1420, strictPort: true, watch: { ignored: ["**/src-tauri/**"] } },
  // No modulepreload polyfill: WebKit 16 (Ventura) lacks modulepreload, so the polyfill
  // fetch()es each chunk, which the CSP's connect-src refuses ("TypeError: Load failed"
  // as an unhandled rejection). The preload is only a hint; the imports load fine without it.
  build: { target: "safari16", sourcemap: false, cssCodeSplit: false, modulePreload: { polyfill: false } },
});
