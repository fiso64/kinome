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
      '@shared': path.resolve(__dirname, 'src/shared'),
      '@lib': path.resolve(__dirname, 'src/renderer/src/lib'),
      '@components': path.resolve(__dirname, 'src/renderer/src/components'),
      '@ui': path.resolve(__dirname, 'src/renderer/src/components/ui'),
      '@modals': path.resolve(__dirname, 'src/renderer/src/components/modals')
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
      },
      // Installer scripts and handler
      '/install-kinome-handler.ps1': {
        target: 'http://localhost:3001',
        changeOrigin: true
      },
      '/install-kinome-handler.sh': {
        target: 'http://localhost:3001',
        changeOrigin: true
      },
      '/kinome-handler.js': {
        target: 'http://localhost:3001',
        changeOrigin: true
      }
    },
    fs: {
      allow: ['../..']
    }
  }
})