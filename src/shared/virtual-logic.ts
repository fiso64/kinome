export const VIRTUAL_ID_PREFIX = 'virtual--'

/**
 * Checks if an ID represents a virtual folder.
 */
export function isVirtualId(id: string | null | undefined): id is string {
  return !!id && id.startsWith(VIRTUAL_ID_PREFIX)
}

/**
 * Parses a virtual ID into its constituent parts.
 * Format: virtual--{physicalParentId}--{token1}--{token2}
 */
export function parseVirtualId(id: string | null | undefined): {
  parentId: string | null
  tokens: string[] | null
} {
  if (!isVirtualId(id)) return { parentId: null, tokens: null }
  const parts = id.split('--')

  if (parts.length < 3) return { parentId: null, tokens: null }

  return {
    parentId: parts[1],
    tokens: parts.slice(2)
  }
}

/**
 * Constructs the settings key used in virtualFolderSettings for a given set of tokens.
 */
export function getVirtualSettingsKey(tokens: string[] | null | undefined): string {
  if (!tokens || tokens.length === 0) return ''
  return tokens.join('/')
}
