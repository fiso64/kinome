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
 * Ensures that tasks are executed one after another in the order they were added.
 */
export class SerializedQueue {
  private promise: Promise<any> = Promise.resolve()

  async run<T>(task: () => Promise<T>): Promise<T> {
    const next = this.promise.then(() => task())
    this.promise = next.catch(() => { }) // Prevent failure of one task from blocking the rest
    return next
  }
}
