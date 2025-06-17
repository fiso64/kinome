/// <reference types="svelte" />
/// <reference types="vite/client" />

interface Window {
  debugSearch: (
    query:
      | string
      | {
          text?: string
          tags?: { key: string; value: string }[]
        }
  ) => void
}
