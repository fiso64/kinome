/**
 * Hand-placed children of a folder. Everything else keeps the folder's sort.
 * `top` and `bottom` are anchored to the ends of the list. `after` maps an
 * anchor child to the children that follow it, in display order.
 */
export interface SortPlacement {
  top?: string[]
  bottom?: string[]
  after?: Record<string, string[]>
}

export interface ResolvedSortPlacement {
  top: string[]
  bottom: string[]
  /** Naturally sorted anchors with the children that follow each, chains flattened. */
  followers: Map<string, string[]>
}

/**
 * Flattens chains ("C after B after A") and drops duplicates and cycles, so
 * each child is placed once. The server's ORDER BY and the editor's preview
 * both start from this result.
 */
export function resolveSortPlacement(placement: SortPlacement): ResolvedSortPlacement {
  const after = placement.after ?? {}
  const seen = new Set<string>()
  const expand = (ids: string[] = [], result: string[] = []) => {
    for (const id of ids) {
      if (seen.has(id)) continue
      seen.add(id)
      result.push(id)
      expand(after[id], result)
    }
    return result
  }

  const top = expand(placement.top)
  const bottom = expand(placement.bottom)
  // An anchor that follows another child belongs to that child's chain.
  const following = new Set(Object.values(after).flat())
  const followers = new Map<string, string[]>()
  for (const anchor of Object.keys(after)) {
    if (seen.has(anchor) || following.has(anchor)) continue
    seen.add(anchor)
    const chain = expand(after[anchor])
    if (chain.length) followers.set(anchor, chain)
  }
  return { top, bottom, followers }
}

/** Orders naturally sorted IDs the way the server does. A child whose anchor is absent keeps its natural position. */
export function applySortPlacement(natural: string[], placement: SortPlacement): string[] {
  const { top, bottom, followers } = resolveSortPlacement(placement)
  const present = new Set(natural)
  const placed = new Set([...top, ...bottom])
  for (const [anchor, chain] of followers) {
    if (present.has(anchor)) for (const id of chain) placed.add(id)
  }
  const middle = natural.filter((id) => !placed.has(id))
    .flatMap((id) => [id, ...(followers.get(id) ?? []).filter((follower) => present.has(follower))])
  return [...top.filter((id) => present.has(id)), ...middle, ...bottom.filter((id) => present.has(id))]
}
