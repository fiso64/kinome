<script lang="ts">
  let {
    onHideItem,
    onClearMetadata
  }: {
    onHideItem: () => Promise<void>
    onClearMetadata: () => Promise<void>
  } = $props()
</script>

<div class="content">
  <div class="danger-zone">
    <div class="danger-zone-header">
      <h4>Danger Zone</h4>
    </div>
    <div>
      <button class="danger" onclick={onClearMetadata}> Clear Metadata </button>
      <p class="help-text danger-help-text">
        Removes all metadata (including custom titles, posters, and tags) for this file.
      </p>
    </div>
    <div>
      <button class="danger" onclick={onHideItem}> Hide This Item </button>
      <p class="help-text danger-help-text">
        Hides this item from all library views and searches. It can be unhidden from its parent
        folder's settings.
      </p>
    </div>
  </div>
</div>

<style>
  .content {
    padding: 1.5rem;
    display: flex;
    flex-direction: column;
    gap: 1.5rem;
  }
  .danger-zone {
    border: 1px solid #c50f1f;
    border-radius: 6px;
    padding: 1rem;
    display: flex;
    flex-direction: column;
    gap: 0.75rem;
    background-color: rgba(197, 15, 31, 0.1);
  }
  .danger-zone-header h4 {
    color: #ff7d7d;
    font-weight: bold;
    margin: 0;
  }
  .danger-help-text {
    margin-top: 0.5rem;
  }
  button.danger {
    background-color: #c50f1f;
    color: white;
    align-self: flex-start;
  }
  button.danger:hover:not(:disabled) {
    background-color: #a40e19;
  }
</style>
