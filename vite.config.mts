import { defineConfig } from 'vite'
import { svelte } from '@sveltejs/vite-plugin-svelte'
import path from 'path'

export default defineConfig({
  root: 'src/renderer',
  base: './',
  build: {
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
    port: 3000, // Frontend now owns port 3000
    proxy: {
      '/api': {
        target: 'http://localhost:3001', // Backend is moved here
        changeOrigin: true
      },
      '/ws': {
        target: 'ws://localhost:3001', // Backend is moved here
        ws: true
      }
    },
    fs: {
      allow: ['../..']
    }
  }
})