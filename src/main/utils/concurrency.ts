export async function processInChunks<T>(
  items: T[],
  concurrencyLimit: number,
  task: (item: T) => Promise<void>
): Promise<void> {
  const queue = [...items]
  const active: Promise<void>[] = []
  while (queue.length > 0 || active.length > 0) {
    while (active.length < concurrencyLimit && queue.length > 0) {
      const item = queue.shift()!
      const promise = task(item).finally(() => {
        const index = active.indexOf(promise)
        if (index !== -1) active.splice(index, 1)
      })
      active.push(promise)
    }
    if (active.length > 0) await Promise.race(active)
  }
}

/**
 * A simple queue to serialize asynchronous tasks.
 */
export class SerializedQueue {
  private promise: Promise<any> = Promise.resolve()

  async run<T>(task: () => Promise<T>): Promise<T> {
    const next = this.promise.then(() => task())
    this.promise = next.catch(() => {}) // Prevent failure of one task from blocking the rest
    return next
  }
}

/**
 * A Task Queue that supports a global concurrency limit and dynamic task addition (Producer-Consumer).
 * Ideal for recursive directory scanning.
 */
export class GlobalTaskQueue<T> {
  private queue: T[] = []
  private activeCount = 0
  private limit: number
  private resolveIdle: (() => void) | null = null
  private onTask: (item: T) => Promise<void>

  constructor(limit: number, onTask: (item: T) => Promise<void>) {
    this.limit = limit
    this.onTask = onTask
  }

  push(item: T) {
    this.queue.push(item)
    this.processNext()
  }

  private processNext() {
    if (this.activeCount >= this.limit || this.queue.length === 0) {
      if (this.activeCount === 0 && this.queue.length === 0 && this.resolveIdle) {
        this.resolveIdle()
      }
      return
    }

    const item = this.queue.shift()!
    this.activeCount++

    this.onTask(item)
      .catch((err) => {
        console.error('[TaskQueue] Task failed:', err)
      })
      .finally(() => {
        this.activeCount--
        this.processNext()
      })

    // Try to start more tasks if we have capacity
    this.processNext()
  }

  async waitForIdle(): Promise<void> {
    if (this.activeCount === 0 && this.queue.length === 0) return
    return new Promise((resolve) => {
      this.resolveIdle = resolve
    })
  }
}
