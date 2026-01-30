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
        options.fields = [...repositoryService.CORE_FIELDS, ...(query.include as string).split(',')]
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
            direction: (direction?.toUpperCase() === 'DESC' ? 'DESC' : 'ASC')
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
        const queryInclude = (req.query.include as string || '').split(',')

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
        if (!req.query.fields && !req.query.include) {
            options.fields = [
                ...repositoryService.CORE_FIELDS,
                'overview', 'backdropPath', 'logoPath', 'runtime', 'releaseDate',
                'genres', 'tags', 'virtualTags'
            ]
        }

        const items = repositoryService.find(options)
        if (items.length === 0) {
            res.status(404).json({ error: 'Item not found' })
        } else {
            res.json(items[0])
        }
    } catch (e: any) {
        res.status(500).json({ error: e.message })
    }
})

// GET /items/:id/children
router.get('/items/:id/children', (req, res) => {
    try {
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
            items = items.map(season => {
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

        res.json(items)
    } catch (e: any) {
        res.status(500).json({ error: e.message })
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
        const cleanAncestors = ancestors.filter(a => a.id !== req.params.id)
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
