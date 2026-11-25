<script lang="ts">
  import type { Shortcut } from '@lib/shortcuts'

  let { shortcut }: { shortcut: Shortcut } = $props()
</script>

<!-- Alternatives are separated by "or"; a chord's keys by "+". -->
<span class="shortcut-keys">
  {#each shortcut.keys as chord, index (chord)}
    {#if index > 0}<span class="separator">or</span>{/if}
    {#each chord.split('+') as key, keyIndex (keyIndex)}
      {#if keyIndex > 0}<span class="separator">+</span>{/if}<kbd>{key}</kbd>
    {/each}
  {/each}
</span>

<style>
  .shortcut-keys { display: inline-flex; flex-wrap: wrap; align-items: center; gap: .25rem; }
  .separator { color: var(--color-text-dim, #8a8a96); font-size: .75rem; }
  kbd {
    min-width: 1.6rem;
    padding: .1rem .4rem;
    border: 1px solid var(--color-border, #393c45);
    border-bottom-width: 2px;
    border-radius: 6px;
    background: var(--color-inset, #101115);
    font: 600 .78rem/1.4 inherit;
    text-align: center;
    white-space: nowrap;
  }
</style>
