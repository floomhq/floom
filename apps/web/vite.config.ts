import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'node:path';
import { sentryVitePlugin } from '@sentry/vite-plugin';

// Sentry source-map upload: only wires when SENTRY_AUTH_TOKEN is set at build
// time. Without it, the plugin is a no-op. Source maps stay generated (see
// `build.sourcemap: true` below) so self-hosters who wire Sentry later still
// have readable stacks locally. With the token set, the plugin uploads maps
// to Sentry and deletes them from dist/ so the runtime image doesn't ship
// them.
const SENTRY_AUTH_TOKEN = process.env.SENTRY_AUTH_TOKEN;
const SENTRY_ORG = process.env.SENTRY_ORG;
const SENTRY_PROJECT = process.env.SENTRY_PROJECT;

const sentryPlugins = SENTRY_AUTH_TOKEN
  ? [
      sentryVitePlugin({
        authToken: SENTRY_AUTH_TOKEN,
        org: SENTRY_ORG,
        project: SENTRY_PROJECT,
        silent: true,
        sourcemaps: {
          filesToDeleteAfterUpload: ['**/*.map'],
        },
      }),
    ]
  : [];

export default defineConfig({
  plugins: [react(), ...sentryPlugins],
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
