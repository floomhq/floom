import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'node:path';

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
      '@spec': path.resolve(__dirname, '../../spec'),
    },
  },
  server: {
    port: 5173,
    proxy: {
      '/api': 'http://localhost:3051',
      '/mcp': 'http://localhost:3051',
    },
  },
  build: {
    outDir: 'dist',
    sourcemap: true,
    chunkSizeWarningLimit: 600,
  },
});
