console.log(`[${new Date().toISOString()}] [Renderer] Renderer process entry point.`)

import { webApi } from './lib/web-api'
// @ts-ignore
window.api = webApi

// Browsers provide crypto.randomUUID only to secure origins, which excludes a
// server reached over plain HTTP on a LAN. getRandomValues is always available.
crypto.randomUUID ??= () => {
  const bytes = crypto.getRandomValues(new Uint8Array(16))
  bytes[6] = (bytes[6] & 0x0f) | 0x40
  bytes[8] = (bytes[8] & 0x3f) | 0x80
  const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}` as ReturnType<Crypto['randomUUID']>
}

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

// Listeners for management status and global behavior have been moved to App.svelte
// to better align with the Svelte lifecycle.

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
    const { items, total } = await window.api.performSearch({ ...searchQuery, includeTotal: true })
    console.log(total === null ? `Showing the first ${items.length} results` : `Found ${total} results`)
    console.table(items)
  } catch (e) {
    console.error('Search failed:', e)
  }
}
export default app
