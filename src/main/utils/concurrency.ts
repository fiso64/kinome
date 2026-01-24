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
