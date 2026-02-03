// vite.config.mts
import { defineConfig } from 'vite'
import { svelte } from '@sveltejs/vite-plugin-svelte'
import path from 'path'

export default defineConfig({
  root: 'src/renderer',
  base: './', // Ensures relative paths for assets in production
  build: {
    // Output to the folder your server.ts expects
    outDir: path.resolve(__dirname, 'out/renderer'),
    emptyOutDir: true
  },
  plugins: [
    svelte({
      onwarn: (warning, handler) => {
        if (warning.code.startsWith('a11y_')) return
        if (handler) handler(warning)
      }
    })
  ],
  resolve: {
    alias: {
      '@renderer': path.resolve(__dirname, 'src/renderer/src'),
      '@shared': path.resolve(__dirname, 'src/shared')
    }
  },
  server: {
    port: 5173,
    proxy: {
      '/api': {
        target: 'http://localhost:3000',
        changeOrigin: true
      },
      '/ws': {
        target: 'ws://localhost:3000',
        ws: true
      }
    },
    fs: {
      allow: ['../..']
    }
  }
})