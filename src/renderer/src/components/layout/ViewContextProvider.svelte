<script lang="ts">
  import { initViewContext, extendViewContext } from '@lib/view-state-store.svelte'

  /**
   * ViewContextProvider
   *
   * Manages the hierarchical key context for the ViewStateStore.
   * Wrap parts of the UI with this to "namespace" their state.
   */
  let {
    id,
    extend = false,
    children
  }: {
    id: string
    extend?: boolean
    children: any
  } = $props()

  // Svelte 5 context must be set during component initialization
  if (extend) {
    extendViewContext(id)
  } else {
    initViewContext(id)
  }
</script>

{@render children()}
