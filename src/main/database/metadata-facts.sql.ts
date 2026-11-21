import { BUILTIN_METADATA_FIELDS, type LocalMediaField, type TmdbFilterField } from '@shared/metadata-fields'
import { tmdbColumn } from './item-metadata.sql'
import { LOCAL_MEDIA_COLUMNS } from './local-media.sql'

interface FactDefinition {
    table: string
    owner: string
    column: string
    kind: 'text' | 'number' | 'list'
    category?: { column: string; value: string }
}

export function localMediaFact(field: LocalMediaField): FactDefinition {
    const { column, track } = LOCAL_MEDIA_COLUMNS[field]
    return {
        table: track ? 'local_media_tracks' : 'local_media',
        owner: 'location_id',
        column,
        kind: BUILTIN_METADATA_FIELDS[field].kind,
        category: track ? { column: 'kind', value: track } : undefined
    }
}

export function tmdbFact(field: TmdbFilterField): FactDefinition {
    const { kind } = BUILTIN_METADATA_FIELDS[field]
    return kind === 'list'
        ? { table: 'tmdb_entity_values', owner: 'entity_id', column: 'value', kind, category: { column: 'field', value: field } }
        : { table: 'media_entities', owner: 'id', column: tmdbColumn(field), kind }
}

export function readMetadataFact(fact: FactDefinition, alias: string, byOwner = false) {
    // Categorized facts live in WITHOUT ROWID tables keyed by owner.
    // For owner lookups, skip the secondary index ordered by category and value.
    const ownerIndex = byOwner ? ` INDEXED BY sqlite_autoindex_${fact.table}_1` : ''
    const source = `${fact.table} ${alias}${ownerIndex}`
    const owner = `${alias}.${fact.owner}`
    const value = `${alias}.${fact.column}`
    const category = fact.category ? `${alias}.${fact.category.column} = '${fact.category.value}' AND ` : ''
    return { source, owner, value, present: `${category}${value} IS NOT NULL` }
}
