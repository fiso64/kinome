console.log(`[${new Date().toISOString()}] [Renderer] Renderer process entry point.`)

import { mount } from 'svelte'

import './assets/main.css'

import App from './App.svelte'

const app = mount(App, {
  target: document.getElementById('app')!
})

// Listen for force reload message from main process
window.api.onForceReloadForNewLibrary(() => {
  console.log('[Renderer] Received force-reload-for-new-library. Reloading window...')
  window.location.reload()
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
