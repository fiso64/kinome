import type { Writable } from 'svelte/store'

export interface HorizontalScrollState {
  canScrollLeft: boolean
  canScrollRight: boolean
}

/**
 * Centers an item in a horizontally scrolling strip. Unlike scrollIntoView, this leaves the
 * page's vertical scroll alone, so a strip below the fold does not pull the page down to it.
 */
export function centerInStrip(strip: HTMLElement, item: Element, behavior: ScrollBehavior = 'instant') {
  const stripBox = strip.getBoundingClientRect()
  const itemBox = item.getBoundingClientRect()
  const left = strip.scrollLeft + itemBox.left - stripBox.left - (stripBox.width - itemBox.width) / 2
  strip.scrollTo({ left, behavior })
}

export function horizontalScroller(node: HTMLElement, state: Writable<HorizontalScrollState> | undefined) {
  if (!state) return {}
  let targetScrollLeft = node.scrollLeft
  let scrollTimeout: any

  function checkScrollability() {
    // A small buffer helps prevent floating point inaccuracies
    const canScrollLeft = node.scrollLeft > 1
    const canScrollRight = node.scrollLeft < node.scrollWidth - node.clientWidth - 1
    state.set({ canScrollLeft, canScrollRight })
  }

  function syncScrollTarget() {
    targetScrollLeft = node.scrollLeft
  }

  function handleScroll() {
    checkScrollability()
    clearTimeout(scrollTimeout)
    scrollTimeout = setTimeout(syncScrollTarget, 150)
  }

  const observer = new ResizeObserver(() => {
    checkScrollability()
    syncScrollTarget()
  })
  observer.observe(node)

  node.addEventListener('scroll', handleScroll)

  // A one-time check after images might load
  const imageLoadTimeoutId = setTimeout(checkScrollability, 500)

  // Custom event listener for smooth scrolling
  const smoothScroll = (e: CustomEvent<{ direction: 'left' | 'right' }>) => {
    clearTimeout(scrollTimeout)
    const scrollAmount = node.clientWidth * 0.8
    let newTarget = targetScrollLeft

    if (e.detail.direction === 'left') {
      newTarget -= scrollAmount
    } else {
      newTarget += scrollAmount
    }

    const maxScroll = node.scrollWidth - node.clientWidth
    newTarget = Math.max(0, Math.min(maxScroll, newTarget))
    targetScrollLeft = newTarget

    node.scrollTo({ left: targetScrollLeft, behavior: 'smooth' })
  }

  const handleWheel = (event: WheelEvent) => {
    // Leave native horizontal gestures to the browser so momentum can continue.
    if (event.deltaX !== 0 || !event.ctrlKey || event.deltaY === 0) return
    if (node.scrollWidth <= node.clientWidth || !event.cancelable || event.defaultPrevented) return

    event.preventDefault()
    node.scrollLeft += event.deltaY
  }

  node.addEventListener('smooth-scroll', smoothScroll as EventListener)
  node.addEventListener('wheel', handleWheel)

  // Initial check
  checkScrollability()

  return {
    destroy() {
      observer.disconnect()
      node.removeEventListener('scroll', handleScroll)
      node.removeEventListener('smooth-scroll', smoothScroll as EventListener)
      node.removeEventListener('wheel', handleWheel)
      clearTimeout(scrollTimeout)
      clearTimeout(imageLoadTimeoutId)
    }
  }
}
