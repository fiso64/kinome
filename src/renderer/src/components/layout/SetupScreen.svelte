<script lang="ts">
  import Icon from '@components/ui/Icon.svelte'
  import { onMount } from 'svelte'
  import { authStore } from '@lib/auth-store.svelte'
  import { api } from '@lib/api'
  import { fade } from 'svelte/transition'
  import { prefersReducedMotion } from 'svelte/motion'
  import { dialogStore } from '@lib/dialog-store'
  import { useQueryClient } from '@tanstack/svelte-query'
  import type { MediaSource } from '@shared/types'
  import MediaSourcesEditor from '@components/settings/MediaSourcesEditor.svelte'
  import FilesystemTreeBrowser from '../setup/FilesystemTreeBrowser.svelte'

  let { onComplete, onStatusUpdate }: { onComplete?: () => void; onStatusUpdate?: () => void } =
    $props()
  const queryClient = useQueryClient()

  let step: 'library' | 'media' = $state('library')
  let libraryLocation = $state('')
  let sources = $state<MediaSource[]>([{ id: crypto.randomUUID(), path: '', isRelative: false }])
  let resolvedPaths = $state<Record<string, { path: string; exists: boolean }>>({})
  let folderSettings = $state<Record<string, Record<string, any>>>({})
  let isSaving = $state(false)
  let error = $state('')
  let shadowSources = $state(false)
  let shadowMinDepth = $state(1)
  const canFinishSetup = $derived(authStore.can.editSettings && authStore.can.triggerLibraryScan)
  function isAbsolutePath(p: string): boolean {
    return (
      p.startsWith('/') || p.startsWith('\\') || /^[a-zA-Z]:/.test(p) || p.startsWith('http')
    )
  }

  onMount(async () => {
    if (!authStore.can.editSettings) return
    // Check current settings to see if we have a location but no DB
    try {
      const settings = await api.getSettings()
      if (settings.libraryLocation) {
        libraryLocation = settings.libraryLocation
        await checkStateAndNavigate(libraryLocation)
      }
    } catch (err) {
      // Ignore if settings fetch fails during setup
    }
  })

  async function checkStateAndNavigate(path: string) {
    isSaving = true
    try {
      const [result, existingSettings] = await Promise.all([
        api.getLibraryStatus(path),
        api.getSettings().catch(() => null)
      ])

      // If settings exist, always pre-fill them
      if (existingSettings?.mediaSources?.length) {
        sources = existingSettings.mediaSources.map((s) => ({ ...s }))
      }

      if (result.status === 'ready') {
        // Full library exists (JSON + DB)!
        if (step === 'library') {
          // If we are at the first step and everything is there, just save location and finish
          await api.saveSettings({ libraryLocation: path })
          onStatusUpdate?.()
          onComplete?.()
        }
      } else if (result.status === 'db_missing') {
        // Library settings exist but DB is missing (or JSON exists but no DB)
        // Proceed to Step 2 to (re)configure media source and scan
        step = 'media'
      } else {
        // Nothing exists at this path (no_settings or no_location)
        if (step === 'library') {
          step = 'media'
        }
      }
    } catch (err: any) {
      dialogStore.showError({ title: 'Error', message: err.message || 'Failed to check library location.' })
    } finally {
      isSaving = false
    }
  }

  async function handleLibraryContinue() {
    if (!authStore.can.editSettings) return
    if (!libraryLocation.trim()) {
      error = 'Library Location is required.'
      return
    }
    error = ''
    await checkStateAndNavigate(libraryLocation)
  }

  async function handleMediaSave() {
    if (!canFinishSetup) return
    if (sources.some((s) => !s.path.trim())) {
      error = 'All media source paths are required.'
      return
    }
    for (const source of sources) {
      const resolved = resolvedPaths[source.id]
      if (resolved && !source.isRelative && !isAbsolutePath(resolved.path)) {
        error = 'All media source paths must be absolute.'
        return
      }
    }

    error = ''
    isSaving = true
    try {
      await api.saveSettings({ libraryLocation, shadowSources, shadowMinDepth })

      for (const source of sources) {
        await api.saveSource(source)
      }
      await api.performScan(folderSettings)

      queryClient.invalidateQueries()
      if (onStatusUpdate) onStatusUpdate()

      onComplete?.()

      window.location.reload()
    } catch (err: any) {
      dialogStore.showError({ title: 'Error', message: err.message || 'Failed to save settings.' })
    } finally {
      isSaving = false
    }
  }
</script>

<div class="setup-screen">
  <section class="setup-container glass-surface" aria-labelledby="setup-title">
    <header>
      <span class="setup-icon" aria-hidden="true"><Icon name="brand" size={24} /></span>
      <div>
        <h1 id="setup-title">Set up your library</h1>
        <ol class="steps" aria-label="Setup progress">
          <li aria-current={step === 'library' ? 'step' : undefined}>Library data</li>
          <li aria-current={step === 'media' ? 'step' : undefined}>Media sources</li>
        </ol>
      </div>
    </header>

    {#if !authStore.can.editSettings}
      <p class="form-hint">An administrator must set up the library before you can browse it.</p>
    {/if}
    {#if step === 'library'}
      <form class="setup-content" in:fade={{ duration: prefersReducedMotion.current ? 0 : 130 }}
        onsubmit={(event) => { event.preventDefault(); void handleLibraryContinue() }}>
        <div class="form-field">
          <label for="library-data-location">Library Data Location</label>
          <input
            type="text"
            id="library-data-location"
            bind:value={libraryLocation}
            placeholder="Path or URL"
            {...authStore.control('editSettings')}
            autofocus
          />
          <p class="form-hint">
            The local directory (or server URL) where metadata, images, and the database are stored.
          </p>
        </div>

        {#if error}
          <p class="error-message" role="alert">{error}</p>
        {/if}

        <div class="actions">
          {#if !authStore.can.editSettings}
            <button class="secondary" type="button" onclick={() => authStore.logout()}>Sign out</button>
          {/if}
          <button
            class="primary"
            type="submit"
            {...authStore.control('editSettings')}
            disabled={!authStore.can.editSettings || isSaving || !libraryLocation.trim()}
          >
            {#if isSaving}Checking...{:else}Continue{/if}
          </button>
        </div>
      </form>
    {:else}
      <form class="setup-content" in:fade={{ duration: prefersReducedMotion.current ? 0 : 130 }}
        onsubmit={(event) => { event.preventDefault(); void handleMediaSave() }}>
        <fieldset class="media-settings" disabled={!canFinishSetup}>
          <MediaSourcesEditor disabled={!canFinishSetup} bind:sources {libraryLocation} bind:resolvedPaths bind:shadowSources bind:shadowMinDepth
            onRemove={(id) => delete folderSettings[id]}>
            {#snippet rootOptions(source, resolvedPath)}
              {#if isAbsolutePath(resolvedPath)}
                <section class="form-field">
                  <span class="field-label">Folder metadata</span>
                  <FilesystemTreeBrowser rootPath={resolvedPath}
                    onSettingsChange={(settings) => (folderSettings = { ...folderSettings, [source.id]: settings })} />
                </section>
              {/if}
            {/snippet}
          </MediaSourcesEditor>
        </fieldset>

        {#if error}
          <p class="error-message" role="alert">{error}</p>
        {/if}

        <div class="actions">
          <button class="secondary" type="button" onclick={() => (step = 'library')} disabled={isSaving}>
            Change Data Location
          </button>
          <button
            class="primary"
            type="submit"
            title={authStore.control('triggerLibraryScan').title}
            disabled={!canFinishSetup || isSaving || sources.some((s) => !s.path.trim())}
          >
            {#if isSaving}Saving...{:else}Save & Scan{/if}
          </button>
        </div>
      </form>
    {/if}
  </section>
</div>

<style>
  .setup-screen {
    display: grid;
    place-items: start center;
    min-height: 100%;
    padding: clamp(.85rem, 4vw, 3.4rem) .85rem 2rem;
    background: radial-gradient(ellipse at 50% 0%, #231d17, transparent 65%), var(--color-background);
  }
  .setup-container { width: min(100%, 48rem); padding: clamp(.95rem, 3.8vw, 1.85rem); border-radius: var(--radius-window); }
  header {
    display: flex;
    gap: .75rem;
    align-items: start;
    padding-bottom: 1rem;
    margin-bottom: 1rem;
    background: var(--section-rule) 0 100% / 100% 1px no-repeat;
  }
  header h1 { font-size: clamp(1.25rem, 4vw, 2rem); font-weight: 700; letter-spacing: -.04em; }
  .setup-icon {
    display: grid;
    place-items: center;
    color: var(--color-primary-soft);
    background: var(--accent-surface);
    border: 1px solid var(--accent-border);
    border-radius: var(--radius-field);
    width: 42px;
    height: 42px;
    flex: none;
  }
  .steps { list-style: none; display: flex; flex-wrap: wrap; gap: .35rem .7rem; padding: 0; color: var(--color-text-soft); font-size: .82rem; }
  .steps [aria-current] { color: var(--color-primary-soft); font-weight: 650; }
  .setup-content { display: grid; min-width: 0; gap: .75rem; }
  .media-settings { margin: 0; padding: 0; border: 0; min-width: 0; }
  .actions { display: flex; flex-wrap: wrap; justify-content: end; gap: .5rem; margin-top: .35rem; }
  .error-message { padding: .55rem; border: 1px solid #9a414580; background: #67383655; color: var(--color-danger-soft);
    border-radius: var(--radius-field); font-size: .85rem; }
</style>
