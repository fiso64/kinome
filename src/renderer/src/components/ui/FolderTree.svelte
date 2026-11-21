<script lang="ts" generics="T extends { isExpanded: boolean; children: T[] | null; isLoading: boolean }">
  import type { Snippet } from 'svelte'
  import { prefersReducedMotion } from 'svelte/motion'
  import { slide } from 'svelte/transition'
  import Icon from './Icon.svelte'
  import Skeleton from './Skeleton.svelte'

  let {
    nodes,
    isInitializing = false,
    loadingText = 'Loading...',
    emptyText = 'No folders found.',
    emptyChildrenText = '',
    onToggle,
    label,
    controls
  }: {
    nodes: T[]
    isInitializing?: boolean
    loadingText?: string
    emptyText?: string
    emptyChildrenText?: string
    onToggle: (node: T) => void
    label: Snippet<[T]>
    controls?: Snippet<[T]>
  } = $props()
</script>

{#snippet treeItem(node: T)}
  <li class="tree-item">
    <div class="folder-row">
      <button type="button" class="folder-toggle" aria-expanded={node.isExpanded} onclick={() => onToggle(node)}>
        <Icon name={node.isExpanded ? 'down' : 'right'} size={15} />
        <span class="folder-icon"><Icon name="folder" size={18} /></span>
        {@render label(node)}
      </button>
      {#if controls}
        <div class="folder-controls">{@render controls(node)}</div>
      {/if}
    </div>

    {#if node.isExpanded}
      <div class="branch" in:slide={{ duration: prefersReducedMotion.current ? 0 : 110 }}>
        {#if node.isLoading}
          <div class="status" role="status" aria-label="Loading folders"><Skeleton width="55%" height="1.25rem" /></div>
        {:else if node.children?.length}
          <ul>
            {#each node.children as child (child)}
              {@render treeItem(child)}
            {/each}
          </ul>
        {:else if node.children && emptyChildrenText}
          <p class="status">{emptyChildrenText}</p>
        {/if}
      </div>
    {/if}
  </li>
{/snippet}

<div class="tree-container" aria-busy={isInitializing}>
  {#if isInitializing}
    <div class="status" role="status" aria-label={loadingText}><Skeleton width="75%" height="1.65rem" /></div>
  {:else if nodes.length === 0}
    <p class="status">{emptyText}</p>
  {:else}
    <ul>
      {#each nodes as node (node)}
        {@render treeItem(node)}
      {/each}
    </ul>
  {/if}
</div>

<style>
  .tree-container {
    max-height: min(26rem, 55dvh);
    overflow: auto;
    min-width: 0;
    padding: .45rem;
    border: 1px solid var(--color-border-soft);
    border-radius: var(--radius-panel);
    background: var(--color-inset);
    box-shadow: inset 0 2px 6px #0005;
    overscroll-behavior: contain;
  }
  ul { display: grid; gap: .25rem; list-style: none; padding: 0; }
  .tree-item { min-width: 0; }
  .status { padding: .5rem; color: var(--color-text-soft); font-size: .85rem; }
  .folder-row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    flex-wrap: wrap;
    gap: .3rem;
    min-width: 0;
    border-radius: var(--radius-field);
    border: 1px solid var(--color-border-soft);
    background: var(--surface-raised);
  }
  .folder-toggle {
    display: flex;
    flex: 1;
    align-items: center;
    gap: .35rem;
    min-width: 0;
    padding: .4rem .55rem;
    text-align: left;
    background: transparent;
    border-color: transparent;
    box-shadow: none;
  }
  .folder-toggle:hover { background: var(--color-hover); }
  .folder-toggle[aria-expanded='true'], .folder-icon { color: var(--color-primary-soft); }
  .folder-toggle :global(svg) { flex: none; }
  .folder-icon { display: flex; }
  .folder-controls { display: flex; align-items: center; flex-wrap: wrap; gap: .25rem .55rem; padding: .35rem .55rem; }
  .branch { margin: .25rem 0 .25rem .65rem; border-left: 1px solid var(--color-border); padding-left: .4rem; }

  .folder-toggle :global(.folder-name) {
    flex: 1;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    font-weight: 600;
  }
  .folder-toggle :global(.folder-kind) { font-size: .72rem; color: var(--color-text-soft); }
  .folder-controls :global(.folder-type) { padding: .23rem .42rem; font-size: .78rem; }
  .folder-controls :global(.folder-fetch) { display: flex; align-items: center; gap: .3rem; font-size: .8rem; color: var(--color-text-soft); }

  @media (max-width: 600px) {
    .folder-toggle { flex-basis: 100%; }
    .folder-controls { padding: 0 .45rem .4rem; }
    .branch { margin-left: .3rem; }
  }
</style>
