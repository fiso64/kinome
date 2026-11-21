import { defineConfig } from 'vite'
import { svelte } from '@sveltejs/vite-plugin-svelte'
import path from 'path'
import { readFile, writeFile } from 'node:fs/promises'
import { gzipSync } from 'node:zlib'

export default defineConfig({
  root: 'src/renderer',
  base: './',
  optimizeDeps: {
    // Vite's dependency cache does not preserve the subtitle packages' worker/WASM paths.
    entries: ['index.html', 'src/components/player/WebPlayer.svelte'],
    exclude: ['jassub', 'libbitsub'],
    include: [
      'jassub > throughput', 'jassub > rvfc-polyfill',
      '@videojs/html/ui/slider-preview', '@videojs/html/ui/slider-value'
    ]
  },
  worker: { format: 'es' },
  build: {
    outDir: path.resolve(__dirname, 'out/renderer'),
    emptyOutDir: true
  },
  plugins: [
    {
      name: 'gzip-assets',
      apply: 'build',
      async writeBundle({ dir }, bundle) {
        if (!dir) return
        for (const name of Object.keys(bundle)) {
          if (!/\.(?:js|css|wasm)$/.test(name)) continue
          const file = path.join(dir, name)
          await writeFile(file + '.gz', gzipSync(await readFile(file)))
        }
      }
    },
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
      }
    },
    fs: {
      allow: ['../..']
    }
  }
})