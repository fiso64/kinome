<script lang="ts">
  import { api } from '@lib/api'

  let {
    mediaSourcePath = $bindable(),
    mediaSourcePathIsRelative = $bindable(),
    libraryLocation = $bindable()
  }: {
    mediaSourcePath: string
    mediaSourcePathIsRelative: boolean
    libraryLocation: string
  } = $props()

  let resolvedMediaPath = $state('Resolving...')

  $effect(() => {
    const path = mediaSourcePath
    const isRelative = mediaSourcePathIsRelative
    const libLoc = libraryLocation

    if (!path.trim()) {
      resolvedMediaPath = 'Not set'
      return
    }

    const timeout = setTimeout(async () => {
      try {
        const resolved = await api.resolveMediaSourcePath({
          path,
          isRelative,
          libraryLocation: libLoc
        })
        resolvedMediaPath = resolved
      } catch (e) {
        resolvedMediaPath = 'Error resolving path'
      }
    }, 100)

    return () => clearTimeout(timeout)
  })
</script>

<div class="form-section">
  <div class="form-group">
    <label for="media-source-path">Media Source Path</label>
    <input
      type="text"
      id="media-source-path"
      bind:value={mediaSourcePath}
      placeholder="Enter local path (e.g., C:/Movies)"
    />
    <p class="help-text">
      The root directory where your media files are stored.
      {#if resolvedMediaPath && resolvedMediaPath !== 'Not set'}
        Current resolved path: <code>{resolvedMediaPath}</code>
      {/if}
    </p>
  </div>
  <div class="form-group checkbox-group">
    <label class="checkbox-label" for="path-is-relative">
      <input type="checkbox" id="path-is-relative" bind:checked={mediaSourcePathIsRelative} />
      <span>Path is relative to library data location</span>
    </label>
    <p class="help-text">
      Enable this if your media files are stored inside your library data directory.
    </p>
  </div>
  <div class="form-group">
    <label for="library-data-location">Library Data Location</label>
    <input
      type="text"
      id="library-data-location"
      bind:value={libraryLocation}
      placeholder="Path or URL"
    />
    <p class="help-text">
      The local directory (or server URL) where metadata, images, and the database are stored.
      Changing this requires an app restart.
    </p>
  </div>
</div>

<style>
  .form-section {
    display: flex;
    flex-direction: column;
    gap: 1.5rem;
  }

  .form-group {
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
  }

  .form-group label {
    font-weight: 600;
    font-size: 0.9rem;
  }

  .checkbox-group {
    gap: 1rem;
  }

  .checkbox-label {
    display: flex;
    align-items: center;
    gap: 0.75rem;
    cursor: pointer;
  }

  input[type='text'] {
    padding: 0.75rem;
    background-color: var(--color-background-mute);
    border: 1px solid var(--color-border);
    border-radius: 6px;
    color: var(--color-text);
    font-size: 1rem;
  }

  .help-text {
    font-size: 0.85rem;
    color: var(--color-text-dim);
    margin: 0;
  }

  code {
    background-color: var(--color-background-soft);
    padding: 0.2rem 0.4rem;
    border-radius: 4px;
    font-size: 0.9em;
  }
</style>
