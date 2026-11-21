<script lang="ts">
  import {
    VIDEO_QUALITIES, VIDEO_BITRATE_TARGETS, availablePlaybackQualities, qualityLabel,
    type PlaybackConversion, type PlaybackEncodingPreferences, type PlaybackQuality,
    type PlaybackVideoBackend, type PlaybackWorkerHealth, type PlaybackWorkerStatus, type VideoQuality
  } from '@shared/playback-quality'
  import { clientSettingsStore } from '@lib/client-settings-store.svelte'
  import { webQualityChoices, webQualityLabel, type WebQualityChoice } from '@shared/web-playback'
  import { api } from '@lib/api'

  let {
    conversionAvailable,
    conversion = $bindable(),
    defaultQuality = $bindable(),
    qualities = $bindable(),
    encoding = $bindable(),
    onManagePlayers
  }: {
    conversionAvailable: boolean
    conversion: PlaybackConversion
    defaultQuality: PlaybackQuality
    qualities: VideoQuality[]
    encoding: PlaybackEncodingPreferences
    onManagePlayers: () => void
  } = $props()

  const statusLabels: Record<PlaybackWorkerStatus, string> = {
    ready: 'Ready', unconfigured: 'Off', unreachable: 'Unreachable', unready: 'Not ready'
  }
  const backendLabels: Record<PlaybackVideoBackend, string> = {
    vaapi: 'VA-API', 'vaapi-upload': 'VA-API with CPU decoding', software: 'Software (CPU)'
  }
  const qualityChoices = $derived(availablePlaybackQualities({
    playbackConversionAvailable: conversionAvailable, playbackConversion: conversion, playbackQualities: qualities
  }))
  const transcodingEnabled = $derived(conversionAvailable && conversion === 'full')
  let worker = $state<PlaybackWorkerHealth | null>(null)
  let checking = $state(true)

  async function checkEngine(): Promise<void> {
    checking = true
    try {
      worker = await api.getPlaybackWorkerHealth()
    } catch {
      worker = null
    } finally {
      checking = false
    }
  }

  $effect(() => { void checkEngine() })
</script>

<div class="playback-settings">
  <section aria-labelledby="players-heading" class="settings-panel">
    <div class="setting-row">
      <h3 id="players-heading">Players</h3>
      <button class="primary" onclick={onManagePlayers}>Manage players</button>
    </div>

    <section aria-labelledby="browser-playback-heading" class="player-preferences">
      <div>
        <h4 id="browser-playback-heading">Web player</h4>
        <p>Preferences for this browser</p>
      </div>
      <div class="encoding-grid">
        <div class="field">
          <label for="browser-quality">Default playback mode</label>
          <select id="browser-quality" value={clientSettingsStore.settings.webQuality}
            onchange={(event) => clientSettingsStore.update({ webQuality: event.currentTarget.value as WebQualityChoice })}>
            {#each webQualityChoices as quality (quality)}
              <option value={quality}>{webQualityLabel(quality)}</option>
            {/each}
          </select>
        </div>
        <div class="field">
          <label for="browser-subtitles">Subtitles</label>
          <select id="browser-subtitles" value={clientSettingsStore.settings.subtitles}
            onchange={(event) => clientSettingsStore.update({ subtitles: event.currentTarget.value as 'default' | 'forced' | 'off' })}>
            <option value="default">Preferred language or default track</option>
            <option value="forced">Forced tracks only</option>
            <option value="off">Off</option>
          </select>
        </div>
        <div class="field">
          <label for="browser-audio-language">Preferred audio language</label>
          <input id="browser-audio-language" value={clientSettingsStore.settings.audioLanguage}
            placeholder="Track default" aria-describedby="browser-language-help"
            onchange={(event) => clientSettingsStore.update({ audioLanguage: event.currentTarget.value.trim().toLowerCase() })} />
        </div>
        <div class="field">
          <label for="browser-subtitle-language">Preferred subtitle language</label>
          <input id="browser-subtitle-language" value={clientSettingsStore.settings.subtitleLanguage}
            placeholder="Track default" aria-describedby="browser-language-help"
            onchange={(event) => clientSettingsStore.update({ subtitleLanguage: event.currentTarget.value.trim().toLowerCase() })} />
        </div>
      </div>
      <p id="browser-language-help">Use a language code such as en, ja, or fr.</p>
    </section>

    <section aria-labelledby="external-playback-heading" class="player-preferences">
      <div class="setting-row">
        <div>
          <h4 id="external-playback-heading">External players and links</h4>
          <p><label class="quality-label" for="default-playback-quality">Default quality</label></p>
        </div>
        <select
          id="default-playback-quality"
          value={qualityChoices.includes(defaultQuality) ? defaultQuality : 'original'}
          onchange={(event) => { defaultQuality = qualityChoices.find((quality) => quality === event.currentTarget.value) ?? 'original' }}
        >
          {#each qualityChoices as quality (quality)}
            <option value={quality}>{qualityLabel(quality)}</option>
          {/each}
        </select>
      </div>
    </section>
  </section>

  <section aria-labelledby="playback-conversion-heading" class="settings-panel">
    <div class="setting-row panel-header">
      <h3 id="playback-conversion-heading"><label for="playback-conversion">Playback conversion</label></h3>
      <select id="playback-conversion" bind:value={conversion} disabled={!conversionAvailable}>
        <option value="full">Transcode and remux</option>
        <option value="remux">Remux only</option>
        <option value="off">Original only</option>
      </select>
    </div>
    {#if conversion === 'remux' && conversionAvailable}
      <p>Remux changes the container and keeps the original video and audio.</p>
    {/if}
    <fieldset class="resolutions" disabled={!transcodingEnabled}>
      <legend>Available transcoding resolutions</legend>
      <div class="resolution-list">
        {#each VIDEO_QUALITIES as quality (quality)}
          <label class="resolution">
            <input type="checkbox" value={quality} bind:group={qualities} />
            <span>{quality === '4k' ? '4K' : quality}</span>
          </label>
        {/each}
      </div>
    </fieldset>
    <fieldset class="encoding-grid" disabled={!transcodingEnabled}>
      <div class="field">
        <label for="hardware-acceleration">Hardware acceleration</label>
        <select id="hardware-acceleration" bind:value={encoding.hardwareAcceleration} aria-describedby="hardware-help">
          <option value="auto">Automatic</option>
          <option value="software">Software only</option>
        </select>
        <p id="hardware-help">Automatic tries VA-API and falls back to the CPU when needed.</p>
      </div>
      <div class="field">
        <label for="video-encoding-quality">Video quality</label>
        <select id="video-encoding-quality" bind:value={encoding.videoQuality} disabled={encoding.videoBitrateMbps > 0} aria-describedby="video-quality-help">
          <option value="balanced">Balanced</option>
          <option value="high">Higher quality</option>
        </select>
        <p id="video-quality-help">{encoding.videoBitrateMbps ? 'The bitrate target controls video encoding.' : 'Higher quality preserves more detail and uses more bandwidth.'}</p>
      </div>
      <div class="field">
        <label for="video-bitrate">Video bitrate target</label>
        <select id="video-bitrate" bind:value={encoding.videoBitrateMbps} aria-describedby="bitrate-help">
          {#each VIDEO_BITRATE_TARGETS as bitrate (bitrate)}
            <option value={bitrate}>{bitrate ? `${bitrate} Mbps` : 'No target'}</option>
          {/each}
        </select>
        <p id="bitrate-help">A target trades picture quality for more predictable bandwidth.</p>
      </div>
      <div class="field">
        <label for="audio-channels">Audio channels</label>
        <select id="audio-channels" bind:value={encoding.audioChannels}>
          <option value="auto">Preserve source channels</option>
          <option value="stereo">Stereo</option>
          <option value="surround">Keep surround (up to 5.1)</option>
        </select>
      </div>
    </fieldset>
  </section>

  <section aria-labelledby="playback-engine" class="settings-panel">
    <div class="setting-row">
      <h3 id="playback-engine">Playback engine</h3>
      <button class="secondary" disabled={checking} onclick={checkEngine}>Check again</button>
    </div>
    <div class="engine-status" role="status" aria-busy={checking}>
      {#if checking}
        <p>Checking FFmpeg…</p>
      {:else if worker}
        <div class="engine-summary">
          <span class:ready={worker.status === 'ready'} class="engine-state">{statusLabels[worker.status]}</span>
          <p>{worker.detail}</p>
        </div>
        {#if worker.videoBackend || worker.lastVideoBackend}
          <dl>
            {#if worker.videoBackend}
              <div>
                <dt>Backend for new transcodes</dt>
                <dd>
                  {backendLabels[worker.videoBackend]}
                  {#if worker.vaapiDevice}<code>{worker.vaapiDevice}</code>{/if}
                </dd>
              </div>
            {/if}
            {#if worker.lastVideoBackend}
              <div>
                <dt>Last transcode</dt>
                <dd>{backendLabels[worker.lastVideoBackend]}</dd>
              </div>
            {/if}
          </dl>
        {/if}
      {:else}
        <p>Playback engine status is unavailable.</p>
      {/if}
    </div>
  </section>
</div>

<style>
  .playback-settings { display: grid; gap: 1rem; }
  .settings-panel {
    display: grid;
    gap: 1rem;
    background: var(--color-background-soft);
    border: 1px solid var(--color-border-soft);
    border-radius: 8px;
    padding: 1.125rem 1.25rem;
  }
  h3 { margin: 0; font-size: 1.04rem; font-weight: 650; }
  p, dt { margin: 0; color: var(--color-text-soft); font-size: 0.85rem; }
  h4 { margin: 0; font-size: 0.95rem; font-weight: 650; }
  label { font-weight: 600; }
  .quality-label { font-weight: 400; }
  .setting-row {
    display: flex;
    flex-wrap: wrap;
    justify-content: space-between;
    align-items: center;
    gap: 0.5rem 1.25rem;
  }
  .setting-row p { margin-top: 0.25rem; }
  .setting-row select { min-width: min(100%, 12rem); }
  .panel-header { padding-bottom: 1rem; border-bottom: 1px solid var(--color-border-soft); }
  .player-preferences {
    display: grid;
    gap: 0.8rem;
    border-top: 1px solid var(--color-border-soft);
    padding-top: 1rem;
  }
  .player-preferences h4 + p { margin-top: 0.25rem; }
  fieldset { border: 0; padding: 0; margin: 0; min-width: 0; }
  fieldset:disabled { opacity: 0.6; }
  legend { padding: 0; font-weight: 600; font-size: 0.92rem; margin-bottom: 0.5rem; }
  .resolution-list { display: flex; flex-wrap: wrap; gap: 0.4rem; }
  .resolution {
    display: inline-flex;
    align-items: center;
    gap: 0.4rem;
    padding: 0.3rem 0.55rem;
    border: 1px solid var(--color-border-soft);
    border-radius: 4px;
    font-size: 0.85rem;
  }
  .resolution:has(:checked) { background: var(--color-background-mute); }
  .resolution input { margin: 0; }
  .encoding-grid {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(min(100%, 20rem), 1fr));
    gap: 1rem;
  }
  .field { display: grid; align-content: start; gap: 0.3rem; min-width: 0; }
  .field label, dd { font-size: 0.9rem; }
  .field select { min-width: 0; width: 100%; }
  .engine-status { display: grid; gap: 0.65rem; }
  .engine-summary { display: flex; align-items: center; flex-wrap: wrap; gap: 0.4rem 0.65rem; }
  .engine-state {
    padding: 0.15rem 0.5rem;
    border-radius: 4px;
    background: var(--color-background-mute);
    font-size: 0.82rem;
    font-weight: 600;
  }
  .engine-state.ready { color: var(--color-success); }
  dl { display: flex; flex-wrap: wrap; gap: 0.5rem 2rem; margin: 0; }
  dd { margin: 0.15rem 0 0; }
  code { margin-left: 0.3rem; color: var(--color-text-soft); overflow-wrap: anywhere; }
</style>
