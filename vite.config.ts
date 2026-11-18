import { defineConfig } from "vite";

// Config Vite adaptée à Tauri : port fixe, pas d'effacement de l'écran,
// build ciblant le WebKit de macOS 13 Ventura (pas de polyfills inutiles).
export default defineConfig({
  clearScreen: false,
  server: { port: 1420, strictPort: true, watch: { ignored: ["**/src-tauri/**"] } },
  build: { target: "safari16", sourcemap: false, cssCodeSplit: false },
});
