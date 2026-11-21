<script lang="ts">
  let {
    width = '100%',
    height = '1em',
    radius = 'var(--radius-field)'
  }: {
    width?: string
    height?: string
    radius?: string
  } = $props()
</script>

<div class="skeleton" aria-hidden="true" style:width style:height style:border-radius={radius}></div>

<style>
  .skeleton {
    display: block;
    flex-shrink: 0;
    background: linear-gradient(
      90deg,
      var(--color-background-soft) 28%,
      var(--color-border-soft) 49%,
      var(--color-background-soft) 70%
    );
    background-size: 200% 100%;
    animation: skeleton-shimmer 2s linear infinite;
    box-shadow: var(--edge-light);
  }

  @media (prefers-reduced-motion: reduce) { .skeleton { animation: none; } }

  @keyframes skeleton-shimmer {
    0% {
      background-position: 200% 0;
    }
    100% {
      background-position: -200% 0;
    }
  }
</style>
