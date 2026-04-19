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
      '/auth': 'http://localhost:3051',
      '/renderer': 'http://localhost:3051',
      '/og': 'http://localhost:3051',
      '/openapi.json': 'http://localhost:3051',
    },
  },
  build: {
    outDir: 'dist',
    sourcemap: true,
    chunkSizeWarningLimit: 600,
    // Split React/vendor into its own long-cached chunk so navigating
    // between routes (which each become their own lazy chunk) doesn't
    // redownload React. Landing TTI drops; cross-route navigation gets
    // warm-cache vendor immediately.
    rollupOptions: {
      output: {
        manualChunks: {
          'react-vendor': ['react', 'react-dom', 'react-router-dom'],
        },
      },
    },
  },
});
