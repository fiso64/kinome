import { defineConfig } from 'vite'
import { svelte } from '@sveltejs/vite-plugin-svelte'
import path from 'path'

export default defineConfig({
  root: 'src/renderer',
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
    fs: {
      allow: ['../..']
    }
  }
})
