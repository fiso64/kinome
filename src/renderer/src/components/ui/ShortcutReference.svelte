<script lang="ts">
  import ShortcutKeys from './ShortcutKeys.svelte'
  import { APP_SHORTCUTS, PLAYER_SHORTCUTS } from '@lib/shortcuts'

  const sections = [...APP_SHORTCUTS, { section: 'Web player', shortcuts: PLAYER_SHORTCUTS }]
</script>

<div class="shortcut-sections">
  {#each sections as { section, shortcuts } (section)}
    <section class="raised-surface">
      <h3>{section}</h3>
      <dl>
        {#each shortcuts as shortcut (shortcut.description)}
          <div class="row">
            <dt>{shortcut.description}</dt>
            <dd><ShortcutKeys {shortcut} /></dd>
          </div>
        {/each}
      </dl>
    </section>
  {/each}
</div>

<style>
  .shortcut-sections { columns: 2 20rem; column-gap: .8rem; }
  section { break-inside: avoid; margin-bottom: .8rem; padding: .7rem .85rem; }
  h3 { margin-bottom: .55rem; font-size: .9rem; font-weight: 675; }
  dl { display: grid; gap: .4rem; margin: 0; }
  .row { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: .3rem .9rem; }
  dt { flex: 1 1 10rem; color: var(--color-text-soft); font-size: .85rem; }
  dd { margin: 0 0 0 auto; }
</style>
