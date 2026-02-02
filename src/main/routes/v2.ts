import { Router } from 'express'
import * as repositoryService from '../services/repository.service'
import * as libraryService from '../services/library.service'
import * as groupingService from '../services/grouping.service'
import { isVirtualId, getFiltersFromId } from '../services/virtual-item.factory'
import { resolveViewSettings } from '../../shared/settings-helpers'
import { readSettings } from '../services/settings.service'

const router = Router()

// Helper to parse FindOptions from query
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

  const reserved = ['fields', 'include', 'limit', 'offset', 'orderBy', 'sort', 'order', 'groupBy']

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

  return options
}

// GET /items
router.get('/items', (req, res) => {
  try {
    const options = parseFindOptions(req.query)
    const items = repositoryService.find(options)
    res.json(items)
  } catch (e: any) {
    res.status(500).json({ error: e.message })
  }
})

// GET /items/:id
router.get('/items/:id', async (req, res) => {
  try {
    let id = req.params.id
    if (id === 'root') {
      const root = await libraryService.getLibraryRoot()
      if (!root) return res.status(404).json({ error: 'Library root not found' })
      id = root.id
    }

    if (isVirtualId(id)) {
      const virtualItem = groupingService.getVirtualItem(id)
      if (!virtualItem) return res.status(404).json({ error: 'Virtual item not found' })
      return res.json(virtualItem)
    }

    const queryInclude = ((req.query.include as string) || '').split(',')

    if (queryInclude.includes('tree')) {
      const details = await libraryService.getItemDetails(id)
      if (!details) return res.status(404).json({ error: 'Item not found' })
      return res.json(details)
    }

    const options = parseFindOptions(req.query)
    options.where = { ...options.where, id }
    options.limit = 1

    // 2. For single items (Detail View), we always want essential metadata by default

    // TODO: Think about this part hard.
    if (!req.query.fields && !req.query.include) {
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
        // View settings (for folders)
        'layout',
        'clickAction',
        'groupBy',
        'gridPosterSize',
        'listDescriptionRows',
        'showHorizontalScrollbar',
        'childViewSettings',
        'virtualFolderSettings',
        // Scraper settings (for folders)
        'retrieve_children_metadata',
        'children_type_hint',
        'process_tv_children'
      ]
    }

    const items = repositoryService.find(options)
    if (items.length === 0) {
      return res.status(404).json({ error: 'Item not found' })
    } else {
      return res.json(items[0])
    }
  } catch (e: any) {
    return res.status(500).json({ error: e.message })
  }
})

// GET /items/:id/children
router.get('/items/:id/children', async (req, res) => {
  try {
    let id = req.params.id
    if (id === 'root') {
      const root = await libraryService.getLibraryRoot()
      if (!root) return res.status(404).json({ error: 'Library root not found' })
      id = root.id
    }

    const options = parseFindOptions(req.query)
    const settings = await readSettings()

    let finalGroupBy: string | undefined = undefined
    const rawGroupBy = req.query.groupBy

    if (rawGroupBy === 'auto' || rawGroupBy === undefined) {
      const item = isVirtualId(id) ? groupingService.getVirtualItem(id) : repositoryService.getItemById(id)
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
        const groups = await groupingService.getGroups(id, finalGroupBy, options)
        return res.json(groups)
      }

      const filteredChildren = repositoryService.find(options)
      return res.json(filteredChildren)
    }

    options.where = { ...options.where, parentId: id }

    const parent = repositoryService.find({
      where: { id: id },
      fields: ['mediaType']
    })[0]

    if (!options.orderBy) {
      if (parent) {
        if (parent.mediaType === 'season') {
          options.orderBy = { field: 'episodeNumber', direction: 'ASC' }
        } else if (parent.mediaType === 'tv') {
          options.orderBy = { field: 'seasonNumber', direction: 'ASC' }
        } else {
          options.orderBy = { field: 'name', direction: 'ASC' }
        }
      } else {
        options.orderBy = { field: 'name', direction: 'ASC' }
      }
    }


    if (finalGroupBy) {
      if (options.where && 'groupBy' in options.where) {
        delete (options.where as any).groupBy
      }
      const groups = await groupingService.getGroups(id, finalGroupBy, options)
      return res.json(groups)
    }

    // FIX: Removed legacy getChildren call which forced a "SELECT *".
    // Instead, we use the options object which contains the specific fields requested.

    let children: any[]

    if (parent && parent.mediaType === 'tv') {
      // Pass the fields down to the recursive fetcher
      children = repositoryService.getSeasonsWithEpisodes(id, options.fields)
    } else {
      // Use the generic lean find.
      // We must explicitly add the parentId filter here since getChildren(id) implied it.
      options.where = { ...options.where, parentId: id }
      children = repositoryService.find(options)
    }

    return res.json(children)
  } catch (e: any) {
    return res.status(500).json({ error: e.message })
  }
})

// GET /items/:id/ancestors
router.get('/items/:id/ancestors', async (req, res) => {
  try {
    let id = req.params.id
    if (id === 'root') {
      const root = await libraryService.getLibraryRoot()
      if (!root) return res.status(404).json({ error: 'Library root not found' })
      id = root.id
    }

    const ancestors = repositoryService.getAncestors(id)
    const cleanAncestors = ancestors.filter((a) => a.id !== id)
    return res.json(cleanAncestors)
  } catch (e: any) {
    return res.status(500).json({ error: e.message })
  }
})

// POST /maintenance/scan
// Triggers a filesystem scan
router.post('/maintenance/scan', async (_req, res) => {
  try {
    await libraryService.refreshLibrary()
    res.json({ success: true })
  } catch (e: any) {
    res.status(500).json({ error: e.message })
  }
})

export default router
