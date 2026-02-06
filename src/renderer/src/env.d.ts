/// <reference types="svelte" />
/// <reference types="vite/client" />

import type { ApiClient } from './lib/api'

declare global {
  interface Window {
    api: ApiClient
    debugSearch: (
      query:
        | string
        | {
            text?: string
            tags?: { key: string; value: string }[]
          }
    ) => void
  }
}
