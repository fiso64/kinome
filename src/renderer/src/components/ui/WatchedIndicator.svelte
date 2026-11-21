<script lang="ts">
  import Icon from './Icon.svelte'
</script>

<span class="watched-indicator" role="img" aria-label="Watched" title="Watched">
  <Icon name="check" size={14} />
</span>

<style>
  .watched-indicator {
    display: inline-grid;
    place-items: center;
    flex: 0 0 21px;
    width: 21px;
    height: 21px;
    color: var(--color-text-soft);
    background: var(--color-background-mute);
    border: 1px solid #a2a5ae4a;
    border-radius: 50%;
    box-shadow: var(--edge-light);
  }
</style>
