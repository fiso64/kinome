console.log(`[${new Date().toISOString()}] [Renderer] Renderer process entry point.`)

import { webApi } from './lib/web-api'
// @ts-ignore
window.api = webApi

import { mount } from 'svelte'

import './assets/main.css'

console.log('[Renderer] Importing App.svelte...')
import App from './App.svelte'

console.log('[Renderer] Mounting App...')
let app
try {
  app = mount(App, {
    target: document.getElementById('app')!
  })
  console.log('[Renderer] App mounted successfully.')
} catch (e) {
  console.error('[Renderer] Failed to mount App:', e)
}

// Listen for management status messages from main process
window.api.onAppStatusUpdated((status) => {
  if (status.forceReloadForNewLibrary) {
    console.log('[Renderer] Received force-reload-for-new-library. Reloading window...')
    window.location.reload()
  }
})

// Expose a more user-friendly debug function to the console
window.debugSearch = async (query) => {
  let searchQuery: { text: string; tags: { key: string; value: string }[] }

  if (typeof query === 'string') {
    searchQuery = { text: query, tags: [] }
  } else if (typeof query === 'object' && query !== null) {
    searchQuery = {
      text: query.text ?? '',
      tags: query.tags ?? []
    }
  } else {
    console.error('Invalid query. Please provide a string or an object like { text, tags }.')
    return
  }

  try {
    console.log(`Performing debug search for:`, searchQuery)
    const results = await window.api.debugPerformSearch(searchQuery)
    console.log(`Found ${Object.keys(results).length} results:`)
    console.table(results)
  } catch (e) {
    console.error('Search failed:', e)
  }
}
console.log(
  'Debug function "debugSearch(\'your query\')" or "debugSearch({ text, tags })" is available on the window object.'
)

export default app
