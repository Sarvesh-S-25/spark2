import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  root: 'ui',
  plugins: [react()],
  server: {
    port: 5173,
    strictPort: false,
    proxy: {
      '/api': { target: 'http://localhost:5178', changeOrigin: true },
    },
  },
  build: {
    outDir: '../dist-ui',
    emptyOutDir: true,
  },
});
