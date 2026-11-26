<script lang="ts">
  import Icon from '@ui/Icon.svelte'

  // Browsers offer pull to refresh only when the page itself scrolls, and never in
  // installed apps. Kinome's views scroll inside their own containers, so this
  // reloads the page when a touch pulls down a view that is already at its top.
  const THRESHOLD = 80
  const IGNORED = 'input, textarea, select, [contenteditable], dialog[open], .modal-backdrop, .context-menu, .context-menu-scrim'

  let pull = $state(0)
  let reloading = $state(false)
  let start: { x: number; y: number } | undefined

  function scrollParent(element: Element | null): Element | null {
    for (let node = element; node && node !== document.body; node = node.parentElement) {
      const { overflowY } = getComputedStyle(node)
      if ((overflowY === 'auto' || overflowY === 'scroll') && node.scrollHeight > node.clientHeight) return node
    }
    return null
  }

  function begin(event: TouchEvent) {
    start = undefined
    pull = 0
    const target = event.target as Element
    if (reloading || event.touches.length !== 1 || !matchMedia('(hover: none)').matches || target.closest(IGNORED)) return
    if ((scrollParent(target)?.scrollTop ?? 0) > 0) return
    start = { x: event.touches[0].clientX, y: event.touches[0].clientY }
  }

  function move(event: TouchEvent) {
    if (!start) return
    const dx = event.touches[0].clientX - start.x
    const dy = event.touches[0].clientY - start.y
    // Sideways swipes belong to horizontal lists, and upward ones to scrolling.
    if (dy <= 0 || Math.abs(dx) > dy) {
      if (pull === 0) start = undefined
      pull = 0
      return
    }
    // Resist the finger, like the native gesture.
    pull = Math.min(dy * 0.5, THRESHOLD * 1.4)
  }

  function end() {
    if (start && pull >= THRESHOLD) {
      reloading = true
      location.reload()
    } else {
      pull = 0
    }
    start = undefined
  }
</script>

<svelte:window ontouchstart={begin} ontouchmove={move} ontouchend={end} ontouchcancel={end} />

{#if pull > 0 || reloading}
  <div class="pull-indicator glass-surface" class:ready={pull >= THRESHOLD || reloading} aria-hidden="true"
    style:--pull="{reloading ? THRESHOLD : pull}px" style:--turn="{pull / THRESHOLD * 270}deg">
    <span class:spinning={reloading}><Icon name="refresh" size={20} /></span>
  </div>
{/if}

<style>
  .pull-indicator {
    position: fixed;
    z-index: 900;
    top: calc(env(safe-area-inset-top) - 2.75rem + var(--pull));
    left: 50%;
    display: grid;
    place-items: center;
    width: 2.75rem;
    height: 2.75rem;
    border-radius: 50%;
    color: var(--color-text-dim);
    transform: translateX(-50%) rotate(var(--turn));
    pointer-events: none;
  }
  .pull-indicator.ready { color: var(--color-primary-soft); }
  .pull-indicator span { display: flex; }
  .spinning { animation: spin .8s linear infinite; }
  @keyframes spin { to { transform: rotate(360deg); } }
  @media (prefers-reduced-motion: reduce) { .spinning { animation: none; } }
</style>
