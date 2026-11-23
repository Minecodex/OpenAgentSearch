import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwind from "@tailwindcss/vite";
export default defineConfig({
  plugins: [react(), tailwind()],
  server: {
    proxy: {
      "/admin": "http://127.0.0.1:8080",
      "/v1": "http://127.0.0.1:8080",
      "/health": "http://127.0.0.1:8080",
    },
  },
  build: {
    target: "es2022",
    sourcemap: false,
    rollupOptions: { output: { manualChunks(id) {
      if (id.includes('node_modules')) {
        if (/node_modules\/(react|react-dom|scheduler)\//.test(id)) return 'react';
      }
    }}}
  },
});
