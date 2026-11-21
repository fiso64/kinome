<script lang="ts">
  import type { MediaSource } from '@shared/types'
  import MediaSourcesEditor from './MediaSourcesEditor.svelte'

  let {
    mediaSources = $bindable(),
    libraryLocation = $bindable(),
    shadowSources = $bindable(),
    shadowMinDepth = $bindable()
  }: {
    mediaSources: MediaSource[]
    libraryLocation: string
    shadowSources: boolean
    shadowMinDepth: number
  } = $props()
</script>

<div class="form-field">
  <label for="library-data-location">Library data location</label>
  <input id="library-data-location" type="text" bind:value={libraryLocation} placeholder="Path or URL" />
  <p class="form-hint">Stores the database, metadata, and artwork. Saving a new location switches libraries and reloads this page.</p>
</div>

<MediaSourcesEditor bind:sources={mediaSources} {libraryLocation} bind:shadowSources bind:shadowMinDepth />
