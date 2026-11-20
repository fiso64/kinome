import {
  metadataFieldKey, metadataSuggestionLookup, type BuiltinMetadataField
} from '@shared/metadata-fields'
import type { AutocompleteSuggestions } from '@shared/types'
import { api } from './api'

export async function getMetadataSuggestions(
  field: BuiltinMetadataField,
  query: string,
  suggestions?: AutocompleteSuggestions
): Promise<string[]> {
  const lookup = metadataSuggestionLookup(field)
  if (!lookup) return []

  if ((lookup === 'genre' || lookup === 'mediaType') && suggestions) return suggestions[lookup] ?? []

  return api.getAutocompleteValues(metadataFieldKey(field), query)
}
