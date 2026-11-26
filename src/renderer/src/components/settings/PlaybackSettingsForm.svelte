<script lang="ts">
  import {
    VIDEO_QUALITIES, VIDEO_BITRATE_TARGETS, availablePlaybackQualities, qualityLabel,
    type PlaybackConversion, type PlaybackEncodingPreferences, type PlaybackQuality,
    type PlaybackVideoBackend, type PlaybackWorkerHealth, type PlaybackWorkerStatus, type VideoQuality
  } from '@shared/playback-quality'
  import {
    isWebQualityChoice, resolveWebQuality, webQualityChoices, webQualityLabel, type PlaybackPreferences, type WebQualityChoice
  } from '@shared/web-playback'
  import Icon from '@components/ui/Icon.svelte'
  import { api } from '@lib/api'

  let {
    canEditServer,
    conversionAvailable,
    conversion = $bindable(),
    defaultQuality = $bindable(),
    qualities = $bindable(),
    encoding = $bindable(),
    webQuality = $bindable(),
    centerPlayButton = $bindable(),
    preferences = $bindable(),
    onManagePlayers
  }: {
    canEditServer: boolean
    conversionAvailable: boolean
    conversion: PlaybackConversion
    defaultQuality: PlaybackQuality
    qualities: VideoQuality[]
    encoding: PlaybackEncodingPreferences
    /** This browser's web player choices. */
    webQuality: WebQualityChoice
    centerPlayButton: boolean
    /** The signed-in account's preferences. Null until they load. */
    preferences: PlaybackPreferences | null
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
  const browserQualities = $derived(webQualityChoices(qualityChoices))
  const browserQuality = $derived(resolveWebQuality(browserQualities, webQuality))
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

  $effect(() => { if (canEditServer) void checkEngine() })
</script>

<div class="playback-settings">
  <section aria-labelledby="players-heading" class="settings-panel raised-surface">
    <div class="setting-row">
      <h3 id="players-heading"><Icon name="play" size={19} /> Players</h3>
      <button class="primary" onclick={onManagePlayers}>Manage players</button>
    </div>

    <section aria-labelledby="browser-playback-heading" class="player-preferences">
      <div>
        <h4 id="browser-playback-heading">Web player</h4>
        <p>Applies to this browser</p>
      </div>
      <div class="encoding-grid">
        <div class="form-field">
          <label for="browser-quality">Default playback mode</label>
          <select id="browser-quality" value={browserQuality}
            onchange={(event) => {
              const choice = event.currentTarget.value
              if (isWebQualityChoice(choice)) webQuality = choice
            }}>
            {#each browserQualities as quality (quality)}
              <option value={quality}>{webQualityLabel(quality)}</option>
            {/each}
          </select>
        </div>
        <label class="center-play-option" for="browser-center-play">
          <input type="checkbox" id="browser-center-play" bind:checked={centerPlayButton} />
          <span>Show the play button over a paused video</span>
        </label>
      </div>
    </section>

    <section aria-labelledby="playback-languages-heading" class="player-preferences">
      <div>
        <h4 id="playback-languages-heading">Audio and subtitles</h4>
        <p>Used by every player when a title has no saved languages. Applies to your account on every device</p>
      </div>
      {#if preferences}
        <div class="encoding-grid">
          <div class="form-field">
            <label for="preferred-audio-language">Preferred audio language</label>
            <input id="preferred-audio-language" value={preferences.audioLanguage ?? ''}
              placeholder="Track default" aria-describedby="preferred-language-help"
              oninput={(event) => { preferences!.audioLanguage = event.currentTarget.value || null }} />
          </div>
          <div class="form-field">
            <label for="preferred-subtitle-language">Preferred subtitle language</label>
            <input id="preferred-subtitle-language" value={preferences.subtitleLanguage ?? ''}
              placeholder="Track default" aria-describedby="preferred-language-help"
              oninput={(event) => { preferences!.subtitleLanguage = event.currentTarget.value || null }} />
          </div>
          <div class="form-field">
            <label for="preferred-subtitles">Subtitles</label>
            <select id="preferred-subtitles" bind:value={preferences.subtitles}>
              <option value="default">Preferred or default track</option>
              <option value="forced">Forced tracks only</option>
              <option value="off">Off</option>
            </select>
          </div>
        </div>
      {/if}
      <p id="preferred-language-help">
        Use language codes such as en or ja, in priority order when listing several: ja, en. External players receive these through
        <code>&lt;alang&gt;</code> and <code>&lt;slang&gt;</code>; the subtitle language is passed only in the first subtitle mode.
      </p>
    </section>

    <fieldset aria-labelledby="external-playback-heading" class="player-preferences" disabled={!canEditServer}>
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
    </fieldset>
  </section>

  <fieldset aria-labelledby="playback-conversion-heading" class="settings-panel raised-surface" disabled={!canEditServer}>
    <div class="setting-row panel-header">
      <h3 id="playback-conversion-heading"><Icon name="bolt" size={19} /><label for="playback-conversion">Playback conversion</label></h3>
      <select id="playback-conversion" bind:value={conversion} disabled={!conversionAvailable}>
        <option value="full">Transcode and remux</option>
        <option value="remux">Remux only</option>
        <option value="off">Original only</option>
      </select>
    </div>
    {#if !canEditServer}
      <p>Only accounts with permission to change server settings can edit playback conversion.</p>
    {:else if conversion === 'remux' && conversionAvailable}
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
      <div class="form-field">
        <label for="hardware-acceleration">Hardware acceleration</label>
        <select id="hardware-acceleration" bind:value={encoding.hardwareAcceleration} aria-describedby="hardware-help">
          <option value="auto">Automatic</option>
          <option value="software">Software only</option>
        </select>
        <p id="hardware-help">Automatic tries VA-API and falls back to the CPU when needed.</p>
      </div>
      <div class="form-field">
        <label for="video-encoding-quality">Video quality</label>
        <select id="video-encoding-quality" bind:value={encoding.videoQuality} aria-describedby="video-quality-help">
          <option value="balanced">Balanced</option>
          <option value="high">Higher quality</option>
        </select>
        <p id="video-quality-help">Higher quality preserves more detail and uses more bandwidth.</p>
      </div>
      <div class="form-field">
        <label for="video-bitrate">Maximum video bitrate</label>
        <select id="video-bitrate" bind:value={encoding.videoBitrateMbps} aria-describedby="bitrate-help">
          {#each VIDEO_BITRATE_TARGETS as bitrate (bitrate)}
            <option value={bitrate}>{bitrate ? `${bitrate} Mbps` : 'No limit'}</option>
          {/each}
        </select>
        <p id="bitrate-help">Caps converted video for limited connections. CPU encoding keeps the quality setting below the cap. Hardware encoding aims near the cap instead, with less for smaller sizes.</p>
      </div>
      <div class="form-field">
        <label for="audio-channels">Audio channels</label>
        <select id="audio-channels" bind:value={encoding.audioChannels}>
          <option value="auto">Preserve source channels</option>
          <option value="stereo">Stereo</option>
          <option value="surround">Keep surround (up to 5.1)</option>
        </select>
      </div>
    </fieldset>
  </fieldset>

  {#if canEditServer}
    <section aria-labelledby="playback-engine" class="settings-panel raised-surface">
      <div class="setting-row">
        <h3 id="playback-engine"><Icon name="tool" size={19} /> Playback engine</h3>
        <button class="secondary" disabled={checking} onclick={checkEngine}>Check again</button>
      </div>
      <div class="engine-status" role="status" aria-busy={checking}>
        {#if checking}
          <p>Checking FFmpeg...</p>
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
  {/if}
</div>

<style>
  .playback-settings { display: grid; gap: 1rem; }
  fieldset { min-width: 0; margin: 0; }
  fieldset.player-preferences { border: 0; padding-inline: 0; padding-block-end: 0; }
  .settings-panel { display: grid; gap: 1rem; padding: clamp(.8rem, 2.2vw, 1.3rem); }
  h3 { display: flex; align-items: center; gap: .4rem; font-size: 1.04rem; font-weight: 650; }
  h3 :global(svg) { color: var(--color-primary-soft); flex: none; }
  p, dt { margin: 0; color: var(--color-text-soft); font-size: 0.85rem; }
  h4 { margin: 0; font-size: 0.95rem; font-weight: 650; }
  label { font-weight: 600; }
  .quality-label { font-weight: 400; }
  .center-play-option { display: flex; align-items: center; gap: .5rem; align-self: end; min-height: 2.25rem; font-weight: 400; font-size: .9rem; cursor: pointer; }
  .center-play-option input { margin: 0; }
  .setting-row {
    display: flex;
    flex-wrap: wrap;
    justify-content: space-between;
    align-items: center;
    gap: 0.5rem 1.25rem;
  }
  .setting-row p { margin-top: 0.25rem; }
  .setting-row select { min-width: min(100%, 12rem); }
  .panel-header { padding-bottom: .75rem; background: var(--section-rule) 0 100% / 100% 1px no-repeat; }
  .player-preferences {
    display: grid;
    gap: 0.8rem;
    background: var(--section-rule) 0 0 / 100% 1px no-repeat;
    padding-top: .85rem;
  }
  .player-preferences h4 + p { margin-top: 0.25rem; }
  fieldset:is(.resolutions, .encoding-grid) { border: 0; padding: 0; }
  fieldset:is(.resolutions, .encoding-grid)[disabled] { opacity: 0.6; }
  legend { padding: 0; font-weight: 600; font-size: 0.92rem; margin-bottom: 0.5rem; }
  .resolution-list { display: flex; flex-wrap: wrap; gap: 0.4rem; }
  .resolution {
    display: inline-flex;
    align-items: center;
    gap: 0.4rem;
    padding: 0.3rem 0.55rem;
    border: 1px solid var(--color-border-soft);
    border-radius: var(--radius-field);
    cursor: pointer;
    font-size: .85rem;
  }
  .resolution:has(:checked) { background: var(--accent-surface); border-color: var(--accent-border); }
  .resolution input { margin: 0; }
  .encoding-grid {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(min(100%, 15rem), 1fr));
    gap: 1rem;
  }
  .encoding-grid :global(.form-field) { align-content: start; }
  dd { font-size: .9rem; }
  .engine-status { display: grid; gap: .65rem; padding: .65rem; border-radius: var(--radius-field); background: var(--color-inset); }
  .engine-summary { display: flex; align-items: center; flex-wrap: wrap; gap: 0.4rem 0.65rem; }
  .engine-state {
    padding: 0.15rem 0.5rem;
    border-radius: 4px;
    background: var(--color-background-mute);
    font-size: 0.82rem;
    font-weight: 600;
  }
  .engine-state.ready { color: var(--color-success-soft); }
  dl { display: flex; flex-wrap: wrap; gap: 0.5rem 2rem; margin: 0; }
  dd { margin: 0.15rem 0 0; }
  code { margin-left: 0.3rem; color: var(--color-text-soft); overflow-wrap: anywhere; }
</style>
