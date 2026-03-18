<script lang="ts" generics="T extends { isExpanded: boolean; children: T[] | null; isLoading: boolean }">
  import { slide } from 'svelte/transition'
  import type { Snippet } from 'svelte'

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
    <!-- svelte-ignore a11y_click_events_have_key_events -->
    <!-- svelte-ignore a11y_no_static_element_interactions -->
    <div class="item-content" onclick={() => onToggle(node)}>
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor"
        stroke-width="2" stroke-linecap="round" stroke-linejoin="round"
        class="expand-chevron transition-transform {node.isExpanded ? 'rotate-90' : ''}">
        <path d="m9 18 6-6-6-6" />
      </svg>

      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor"
        stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="folder-icon">
        <path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z" />
      </svg>

      {@render label(node)}

      {#if controls}
        <!-- svelte-ignore a11y_click_events_have_key_events -->
        <!-- svelte-ignore a11y_no_static_element_interactions -->
        <div class="controls" onclick={(e) => e.stopPropagation()}>
          {@render controls(node)}
        </div>
      {/if}
    </div>

    {#if node.isExpanded}
      <div transition:slide>
        {#if node.isLoading}
          <div class="indent loading-sub">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor"
              stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="animate-spin">
              <path d="M21 12a9 9 0 1 1-6.219-8.56" />
            </svg>
          </div>
        {:else if node.children && node.children.length > 0}
          <ul class="indent">
            {#each node.children as child}
              {@render treeItem(child)}
            {/each}
          </ul>
        {:else if node.children && emptyChildrenText}
          <div class="indent empty-sub">{emptyChildrenText}</div>
        {/if}
      </div>
    {/if}
  </li>
{/snippet}

<div class="tree-container">
  {#if isInitializing}
    <div class="loading">
      <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor"
        stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="animate-spin">
        <path d="M21 12a9 9 0 1 1-6.219-8.56" />
      </svg>
      <span>{loadingText}</span>
    </div>
  {:else if nodes.length === 0}
    <div class="empty">{emptyText}</div>
  {:else}
    <ul class="tree">
      {#each nodes as node}
        {@render treeItem(node)}
      {/each}
    </ul>
  {/if}
</div>

<style>
  .tree-container {
    max-height: 400px;
    overflow-y: auto;
    border: 1px solid var(--color-background-mute, rgba(255, 255, 255, 0.1));
    border-radius: 8px;
    padding: 12px;
    background: rgba(0, 0, 0, 0.2);
  }
  .loading, .empty {
    display: flex;
    align-items: center;
    gap: 12px;
    color: var(--ev-c-text-3, var(--text-muted, #888));
    padding: 20px;
    justify-content: center;
  }
  .tree { list-style: none; padding: 0; margin: 0; }
  .tree-item { margin-bottom: 4px; }
  .item-content {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 4px 8px;
    border-radius: 4px;
    transition: background 0.2s;
    cursor: pointer;
  }
  .item-content:hover { background: rgba(255, 255, 255, 0.05); }
  .expand-chevron {
    color: var(--ev-c-text-3, var(--text-muted, #888));
    flex-shrink: 0;
  }
  .folder-icon { color: #4a9eff; flex-shrink: 0; }
  .controls {
    display: flex;
    align-items: center;
    gap: 16px;
    flex-shrink: 0;
  }
  .indent {
    margin-left: 20px;
    border-left: 1px solid rgba(255, 255, 255, 0.1);
    list-style: none;
    padding-left: 8px;
  }
  .loading-sub { padding: 4px 0; color: var(--ev-c-text-3, var(--text-muted, #888)); }
  .empty-sub { padding: 4px 0; color: var(--ev-c-text-3, var(--text-muted, #888)); font-size: 0.8rem; }
  .transition-transform { transition: transform 0.2s; }
  .rotate-90 { transform: rotate(90deg); }
  @keyframes spin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }
  .animate-spin { animation: spin 1s linear infinite; }
</style>
