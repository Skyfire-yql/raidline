import vinext from "vinext";
import { defineConfig } from "vite";

// macOS Seatbelt blocks FSEvents, so Codex previews need polling for HMR.
const isCodexSeatbeltSandbox = process.env.CODEX_SANDBOX === "seatbelt";

export default defineConfig({
  // The persistent workspace may reuse a pnpm dependency directory through
  // a junction. Keep React on one module identity so SSR and hydration do not
  // create separate hook dispatchers in local previews.
  resolve: { dedupe: ["react", "react-dom", "react-server-dom-webpack"] },
  server: isCodexSeatbeltSandbox
    ? { watch: { useFsEvents: false, usePolling: true } }
    : undefined,
  plugins: [vinext()],
});
