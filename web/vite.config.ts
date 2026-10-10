import react from "@vitejs/plugin-react";
import { readFileSync } from "node:fs";
import { defineConfig } from "vite";
import svgr from "vite-plugin-svgr";

const pkg = JSON.parse(readFileSync(new URL("./package.json", import.meta.url), "utf8")) as { version: string };

// The API is proxied under the same origin in development, exactly as the ingress does in a cell.
export default defineConfig({
  resolve: {
    alias: {
      "@": "/src",
    },
  },
  plugins: [
    react(),
    svgr({
      svgrOptions: {
        icon: true,
        exportType: "named",
        namedExport: "ReactComponent",
      },
    }),
  ],
  define: {
    __APP_VERSION__: JSON.stringify(pkg.version),
  },
  server: {
    allowedHosts: ["host.docker.internal"],
    port: 5173,
    proxy: {
      "/api": { target: process.env.API_URL ?? "http://localhost:3000", changeOrigin: true },
    },
  },
  build: { outDir: "dist", sourcemap: false },
});
