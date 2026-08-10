import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

const __dirname = fileURLToPath(new URL(".", import.meta.url));

export default defineConfig({
  root: "client",
  plugins: [react()],
  server: {
    proxy: {
      "/api": "http://localhost:3000",
    },
    fs: {
      allow: [
        resolve(__dirname, "client"),
        resolve(__dirname, "genoffice/apps/docs/src/renderer"),
        resolve(__dirname, "genoffice/node_modules"),
        resolve(__dirname, "genoffice/packages"),
      ],
    },
  },
  build: {
    outDir: "dist",
    rollupOptions: {
      input: {
        chat: resolve(__dirname, "client/chat.html"),
        document: resolve(__dirname, "client/document.html"),
      },
    },
  },
});
