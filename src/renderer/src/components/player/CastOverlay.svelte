<script lang="ts">
  import { formatClockTime } from '@lib/view-helpers'
  import { castController } from './cast.svelte'

  let { title, onNext }: { title: string; onNext?: () => void } = $props()

  const remaining = $derived(Math.max(0, castController.duration - castController.position))
</script>

<!-- Shown over the player while a cast device plays the video. -->
<section class="cast-overlay" aria-label="Casting">
  <p class="device">Playing on {castController.device}</p>
  <h2>{title}</h2>
  {#if castController.finished}
    <p class="status" role="status">Finished</p>
  {/if}
  <div class="controls">
    <button type="button" class="secondary" data-action="cast-back" aria-label="Back 10 seconds"
      onclick={() => castController.seek(castController.position - 10)}>-10</button>
    <button type="button" class="primary play" data-action="cast-play-pause" aria-label={castController.paused ? 'Play' : 'Pause'}
      onclick={() => castController.playOrPause()}>
      <media-icon name={castController.paused ? 'play' : 'pause'} aria-hidden="true"></media-icon>
    </button>
    <button type="button" class="secondary" data-action="cast-forward" aria-label="Forward 10 seconds"
      onclick={() => castController.seek(castController.position + 10)}>+10</button>
  </div>
  <input type="range" aria-label="Position on the cast device" min="0" max={Math.max(castController.duration, 1)} step="1"
    value={castController.position} onchange={(event) => castController.seek(Number(event.currentTarget.value))} />
  <p class="times">
    <span>{formatClockTime(castController.position, castController.duration)}</span>
    <span>-{formatClockTime(remaining, castController.duration)}</span>
  </p>
  <div class="actions">
    {#if onNext}
      <button type="button" class="secondary" data-action="cast-next" onclick={onNext}>Next video</button>
    {/if}
    <button type="button" class="secondary" data-action="cast-stop" onclick={() => castController.stop()}>Stop casting</button>
  </div>
</section>

<style>
  .cast-overlay {
    position: absolute;
    inset: 0;
    z-index: 2;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 0.75rem;
    padding: 2rem;
    background: rgb(0 0 0 / 0.85);
    color: #fff;
    text-align: center;
  }
  .device { margin: 0; opacity: 0.75; }
  h2 { margin: 0; font-size: 1.4rem; }
  .status { margin: 0; }
  .controls, .actions { display: flex; gap: 0.75rem; align-items: center; }
  .play { width: 3.5rem; height: 3.5rem; border-radius: 50%; display: grid; place-items: center; padding: 0; }
  .play media-icon { width: 1.75rem; height: 1.75rem; }
  input[type="range"] { width: min(36rem, 100%); }
  .times { display: flex; justify-content: space-between; width: min(36rem, 100%); margin: 0; font-variant-numeric: tabular-nums; }
</style>
