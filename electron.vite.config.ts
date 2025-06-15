import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import { svelte } from '@sveltejs/vite-plugin-svelte'

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()]
  },
  preload: {
    plugins: [externalizeDepsPlugin()]
  },
  renderer: {
    plugins: [
      svelte({
        onwarn: (warning, handler) => {
          // Suppress all accessibility warnings
          if (warning.code.startsWith('a11y_')) {
            return
          }
          // Let Vite handle all other warnings
          if (handler) {
            handler(warning)
          }
        }
      })
    ]
  }
})
