<script lang="ts">
  let {
    width = '100%',
    height = '1em',
    radius = '6px'
  }: {
    width?: string
    height?: string
    radius?: string
  } = $props()
</script>

<div class="skeleton" style:width style:height style:border-radius={radius}></div>

<style>
  .skeleton {
    display: block;
    flex-shrink: 0;
    background: linear-gradient(
      90deg,
      var(--color-background-mute) 25%,
      var(--color-background-soft) 50%,
      var(--color-background-mute) 75%
    );
    background-size: 200% 100%;
    animation: skeleton-shimmer 1.5s infinite;
  }

  @keyframes skeleton-shimmer {
    0% {
      background-position: 200% 0;
    }
    100% {
      background-position: -200% 0;
    }
  }
</style>
