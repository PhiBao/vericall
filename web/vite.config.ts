import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

const apiTarget = process.env.VERICALL_API ?? "http://localhost:8787";

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      // The verifier owns the chain reads and the SLA execution path, so the
      // dev server proxies to it rather than duplicating that logic here.
      "/api": {
        target: apiTarget,
        changeOrigin: true,
        // A proxy failure is not an API failure. Without this, a verifier that
        // is not running surfaces as "HTTP 500" from Vite, which reads like the
        // app broke instead of like the API is absent.
        configure: (proxy) => {
          proxy.on("error", (_error, _request, response) => {
            if (response && "writeHead" in response && !response.headersSent) {
              response.writeHead(502, { "content-type": "application/json" });
              response.end(
                JSON.stringify({
                  ok: false,
                  error: `the verifier at ${apiTarget} is not reachable — start it with \`cargo run\` in verifier/`,
                }),
              );
            }
          });
        },
      },
    },
  },
  build: {
    outDir: "dist",
    sourcemap: true,
    target: "es2022",
  },
});
