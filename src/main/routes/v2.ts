import { Router } from 'express'
import * as repositoryService from '../services/repository.service'
import * as libraryService from '../services/library.service'

const router = Router()

// Helper to parse FindOptions from query
function parseFindOptions(query: any): repositoryService.FindOptions {
  const options: repositoryService.FindOptions = { where: {} }

  if (query.fields) {
    options.fields = (query.fields as string).split(',')
  } else if (query.include) {
    // Spec 4.1.1: If include is present, add to CORE_FIELDS
    // We don't have CORE_FIELDS imported yet, but repository.find handles default logic if fields is empty.
    // But here we want Base + Extra.
    // So we need to explicitly import CORE_FIELDS or just rely on find knowing what to do?
    // find() logic is: if fields empty -> use CORE. If fields NOT empty -> use fields.
    // So we must manually construct [CORE + Include].


    // We will import CORE_FIELDS from repository service.
    // Use a Set to ensure we don't request duplicate fields (e.g. 'id' which is in CORE and might be requested)
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

  // Generic filtering
  // Supported filters: parentId, type, mediaType, isMissing, isHidden, tmdbId
  // We exclude pagination/sorting keys from 'where'
  // Supported filters: parentId, type, mediaType, isMissing, isHidden, tmdbId
  // We exclude pagination/sorting keys from 'where'
  const reserved = ['fields', 'include', 'limit', 'offset', 'orderBy', 'sort', 'order']

  for (const [key, value] of Object.entries(query)) {
    if (!reserved.includes(key)) {
      // Handle "null" string as null
      if (value === 'null') {
        options.where![key] = null
      } else {
        options.where![key] = value
      }
    }
  }

  // Handle explicit 'sort' & 'order' params alternative
  if (query.sort && !options.orderBy) {
    options.orderBy = {
      field: query.sort as string,
      direction: (query.order as string)?.toUpperCase() === 'DESC' ? 'DESC' : 'ASC'
    }
  }

  return options
}

// GET /items
// Generic search/list items
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
    if (repositoryService.isVirtualId(req.params.id)) {
      const virtualItem = repositoryService.createVirtualItem(req.params.id)
      if (!virtualItem) return res.status(404).json({ error: 'Virtual item not found' })
      return res.json(virtualItem)
    }

    const queryInclude = ((req.query.include as string) || '').split(',')

    // 1. If 'tree' is requested, use the legacy getItemDetails logic (Fat Item)
    if (queryInclude.includes('tree')) {
      const details = await libraryService.getItemDetails(req.params.id)
      if (!details) return res.status(404).json({ error: 'Item not found' })
      const serialized = JSON.stringify(details, (key, value) => {
        if (key === 'children') return value ? `[${value.length}]` : value
        return value
      })
      console.log(`[V2] Sending Tree for ${details.name}: ${serialized.substring(0, 500)}...`)
      return res.json(details)
    }

    const options = parseFindOptions(req.query)
    // Force ID match
    options.where = { ...options.where, id: req.params.id }
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
router.get('/items/:id/children', (req, res) => {
  try {
    if (repositoryService.isVirtualId(req.params.id)) {
      const { parentId, groupByKey, groupByValue } = repositoryService.parseVirtualId(req.params.id)
      if (!parentId || !groupByKey || !groupByValue) return res.status(404).json({ error: 'Invalid virtual ID' })

      // Map the grouping key to a filter key that repository.service understands
      const filterOptions: Record<string, any> = {
        parentId: parentId
      }

      if (groupByKey === 'genre' || groupByKey === 'genres') {
        filterOptions['genres'] = groupByValue
      } else if (groupByKey.startsWith('vt.') || groupByKey === 'virtualTags') {
        // e.g. vt.is_animated -> virtualTags.is_animated
        const key = groupByKey.startsWith('vt.') ? groupByKey.split('.')[1] : null
        if (key) {
          filterOptions[`virtualTags.${key}`] = groupByValue
        }
      } else if (groupByKey.startsWith('tags.') || groupByKey === 'tags') {
        // e.g. tags.mood -> tags.mood
        const key = groupByKey.startsWith('tags.') ? groupByKey.replace('tags.', '') : null
        if (key) {
          filterOptions[`tags.${key}`] = groupByValue
        }
      }

      // Fetch children with DB-side filtering
      const options = parseFindOptions(req.query)
      options.where = { ...options.where, ...filterOptions }

      const filteredChildren = repositoryService.find(options)

      return res.json(filteredChildren)
    }

    const options = parseFindOptions(req.query)
    // Force parentId match
    options.where = { ...options.where, parentId: req.params.id }

    // Contextual Sorting (Spec 4.1.2)
    // If sort not specified, check parent type
    const parent = repositoryService.find({
      where: { id: req.params.id },
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

    let items = repositoryService.find(options)

    // For TV shows, populate each season's children (episodes) for the tabs view
    if (parent?.mediaType === 'tv') {
      items = items.map((season) => {
        if (season.type === 'folder') {
          const episodes = repositoryService.find({
            where: { parentId: season.id },
            orderBy: { field: 'episodeNumber', direction: 'ASC' }
          })
          return { ...season, children: episodes }
        }
        return season
      })
    }

    return res.json(items)
  } catch (e: any) {
    return res.status(500).json({ error: e.message })
  }
})

// GET /items/:id/ancestors
router.get('/items/:id/ancestors', (req, res) => {
  try {
    const ancestors = repositoryService.getAncestors(req.params.id)
    // Ancestors query includes the item itself (idx 0).
    // Usually breadcrumbs want everything BEFORE the item.
    // Let's filter out the item itself if checking IDs, or just return as is and let frontend handle?
    // Spec says "Ancestors", implying parents.
    // The recursive query above returns [Root, Parent, Self].
    // Let's remove Self.
    const cleanAncestors = ancestors.filter((a) => a.id !== req.params.id)
    res.json(cleanAncestors)
  } catch (e: any) {
    res.status(500).json({ error: e.message })
  }
})

// POST /maintenance/scan
// Triggers a filesystem scan
router.post('/maintenance/scan', async (_req, res) => {
  try {
    // libraryService.refreshLibrary() handles the scan logic
    // We accept the async nature, or we can await it?
    // refreshLibrary awaits the scan.
    await libraryService.refreshLibrary()
    res.json({ success: true })
  } catch (e: any) {
    res.status(500).json({ error: e.message })
  }
})

export default router
