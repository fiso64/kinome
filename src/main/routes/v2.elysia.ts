import { Elysia, t } from 'elysia'
import * as repositoryService from '../services/repository.service'
import * as libraryService from '../services/library.service'
import * as groupingService from '../services/grouping.service'
import { isVirtualId, getFiltersFromId } from '../services/virtual-item.factory'
import { resolveViewSettings } from '@shared/settings-helpers'
import { readSettings } from '../services/settings.service'

/**
 * Helper to parse FindOptions from query
 */
function parseFindOptions(query: any): repositoryService.FindOptions {
  const options: repositoryService.FindOptions = { where: {} }

  if (query.fields) {
    options.fields = (query.fields as string).split(',')
  } else if (query.include) {
    const extraFields = (query.include as string).split(',')
    const uniqueFields = new Set([...repositoryService.CORE_FIELDS, ...extraFields])
    options.fields = Array.from(uniqueFields)
  }

  if (query.limit) {
    options.limit = parseInt(query.limit as string)
  }

  if (query.offset) {
    options.offset = parseInt(query.offset as string)
  }

  if (query.orderBy) {
    const [field, direction] = (query.orderBy as string).split(':')
    options.orderBy = {
      field,
      direction: direction?.toUpperCase() === 'DESC' ? 'DESC' : 'ASC'
    }
  }

  const reserved = ['fields', 'include', 'limit', 'offset', 'orderBy', 'sort', 'order', 'groupBy', 'includeHidden']

  for (const [key, value] of Object.entries(query)) {
    if (!reserved.includes(key)) {
      if (value === 'null' || value === 'root') {
        options.where![key] = null
      } else {
        options.where![key] = value
      }
    }
  }

  if (query.sort && !options.orderBy) {
    options.orderBy = {
      field: query.sort as string,
      direction: (query.order as string)?.toUpperCase() === 'DESC' ? 'DESC' : 'ASC'
    }
  }

  if (query.includeHidden === 'true') {
    options.includeHidden = true
  } else if (query.includeHidden === 'false') {
    options.includeHidden = false
  }

  return options
}

export const v2Routes = new Elysia({ prefix: '/v2' })
  .get('/items', ({ query }) => {
    const options = parseFindOptions(query)
    return repositoryService.find(options)
  })
  .get('/items/:id', async ({ params: { id: rawId }, query, set }) => {
    let id = rawId
    if (id === 'root') {
      const status = await libraryService.getLibraryRoot()
      if (status.status !== 'ready') {
        set.status = 404
        return {
          error: 'root_missing',
          message: `Library not ready: ${status.status}`,
          ...status
        }
      }
      id = status.root!.id
    }

    if (isVirtualId(id)) {
      const virtualItem = groupingService.getVirtualItem(id)
      if (!virtualItem) {
        set.status = 404
        return { error: 'Virtual item not found' }
      }
      return virtualItem
    }

    const queryInclude = ((query.include as string) || '').split(',')

    const options = parseFindOptions(query)
    options.where = { ...options.where, id }
    options.limit = 1

    // TODO (IMPORTANT): This default field fallback violates our lean api spec at @[spec/backend/api_rewrite.md].
    // Clients should explicitly request fields; the server shouldn't guess/bundle everything by default.
    // We are keeping this for now to avoid breaking existing/generic API consumers.
    if (!query.fields && !query.include) {
      options.fields = [
        ...repositoryService.CORE_FIELDS,
        'overview',
        'backdropPath',
        'logoPath',
        'runtime',
        'releaseDate',
        'genres',
        'tags',
        'virtualTags',
        'layout',
        'clickAction',
        'groupBy',
        'gridPosterSize',
        'listDescriptionRows',
        'showHorizontalScrollbar',
        'childViewSettings',
        'virtualFolderSettings',
        'retrieve_children_metadata',
        'children_type_hint',
        'process_tv_children'
      ]
    }

    const items = repositoryService.find(options)
    if (items.length === 0) {
      set.status = 404
      return { error: 'Item not found' }
    } else {
      return items[0]
    }
  })
  .get('/items/:id/children', async ({ params: { id: rawId }, query, set }) => {
    let id = rawId
    if (id === 'root') {
      const status = await libraryService.getLibraryRoot()
      if (status.status !== 'ready') {
        set.status = 404
        return {
          error: 'root_missing',
          message: `Library not ready: ${status.status}`,
          ...status
        }
      }
      id = status.root!.id
    }

    const options = parseFindOptions(query)

    // Default to excluding hidden items for children endpoint unless explicitly requested
    if (options.includeHidden === undefined) {
      options.includeHidden = false
    }

    const settings = await readSettings()

    let finalGroupBy: string | undefined = undefined
    const rawGroupBy = query.groupBy

    if (rawGroupBy === 'auto' || rawGroupBy === undefined) {
      const item = isVirtualId(id)
        ? groupingService.getVirtualItem(id)
        : repositoryService.getItemById(id)
      const resolved = resolveViewSettings(item as any, settings).settings
      if (['tabs', 'sections'].includes(resolved.layout)) {
        finalGroupBy = resolved.groupBy
      }
    } else if (rawGroupBy !== 'none') {
      finalGroupBy = rawGroupBy as string
    }

    if (isVirtualId(id)) {
      const filterOptions = getFiltersFromId(id)
      options.where = { ...options.where, ...filterOptions }

      if (finalGroupBy) {
        if (options.where && 'groupBy' in options.where) {
          delete (options.where as any).groupBy
        }
        return groupingService.getGroups(id, finalGroupBy, options)
      }

      return repositoryService.find(options)
    }

    options.where = { ...options.where, parentId: id }

    // Standard Children logic (with sorting and grouping)
    const parent = isVirtualId(id) ? null : repositoryService.getItemById(id)

    if (!options.orderBy && parent) {
      if (parent.mediaType === 'season') {
        options.orderBy = { field: 'episodeNumber', direction: 'ASC' }
      } else if (parent.mediaType === 'tv') {
        options.orderBy = { field: 'seasonNumber', direction: 'ASC' }
      } else {
        options.orderBy = { field: 'name', direction: 'ASC' }
      }
    }

    if (finalGroupBy) {
      if (options.where && 'groupBy' in options.where) {
        delete (options.where as any).groupBy
      }
      return groupingService.getGroups(id, finalGroupBy, options)
    }

    return repositoryService.find(options)
  })
  .get('/items/:id/ancestors', async ({ params: { id: rawId }, set }) => {
    let id = rawId
    if (id === 'root') {
      const status = await libraryService.getLibraryRoot()
      if (status.status !== 'ready') {
        set.status = 404
        return {
          error: 'root_missing',
          message: `Library not ready: ${status.status}`,
          ...status
        }
      }
      id = status.root!.id
    }

    const ancestors = repositoryService.getAncestors(id)
    return ancestors.filter((a) => a.id !== id)
  })

