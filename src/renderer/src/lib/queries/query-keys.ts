let currentRootId: string | null = null

export const setGlobalRootId = (id: string | null) => {
    currentRootId = id
}

export const normalizeId = (id: string | null | undefined) => {
    if (!id) return id
    if (currentRootId && id === currentRootId) return 'root'
    return id
}

export const isIdMatch = (id1: string | null | undefined, id2: string | null | undefined) => {
    return normalizeId(id1) === normalizeId(id2)
}

export const itemKeys = {
    all: ['item'] as const,
    details: (id: string | null | undefined) => [...itemKeys.all, normalizeId(id), 'details'] as const,
    settings: (id: string | null | undefined) => [...itemKeys.all, normalizeId(id), 'settings'] as const,
    tree: (id: string | null | undefined) => [...itemKeys.all, normalizeId(id), 'tree'] as const,
}

export const childKeys = {
    all: ['children'] as const,
    byParent: (parentId: string | null | undefined, fields: string[] = [], groupBy?: string) =>
        [...childKeys.all, normalizeId(parentId), { fields, groupBy }] as const,
}

export const continueWatchingKeys = {
    all: ['continue-watching'] as const,
}
