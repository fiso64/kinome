export const itemKeys = {
    all: ['item'] as const,
    details: (id: string | null | undefined) => [...itemKeys.all, id, 'details'] as const,
    settings: (id: string | null | undefined) => [...itemKeys.all, id, 'settings'] as const,
    tree: (id: string | null | undefined) => [...itemKeys.all, id, 'tree'] as const,
}

export const childKeys = {
    all: ['children'] as const,
    byParent: (parentId: string | null | undefined, fields: string[] = [], groupBy?: string) =>
        [...childKeys.all, parentId, { fields, groupBy }] as const,
}
