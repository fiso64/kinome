import { Elysia, t } from 'elysia'
import * as repositoryService from '../services/repository.service'
import * as libraryService from '../services/library.service'
import * as groupingService from '../services/grouping.service'
import { isVirtualId, getFiltersFromId } from '../services/virtual-item.factory'
import { resolveViewSettings } from '../../shared/settings-helpers'
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

export const v2Routes = new Elysia({ prefix: '/v2' })
    .get('/items', ({ query }) => {
        const options = parseFindOptions(query)
        return repositoryService.find(options)
    })
    .get('/items/:id', async ({ params: { id: rawId }, query, set }) => {
        let id = rawId
        if (id === 'root') {
            const root = await libraryService.getLibraryRoot()
            if (!root) {
                set.status = 404
                return { error: 'Library root not found' }
            }
            id = root.id
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

        if (queryInclude.includes('tree')) {
            const details = await libraryService.getItemDetails(id)
            if (!details) {
                set.status = 404
                return { error: 'Item not found' }
            }
            return details
        }

        const options = parseFindOptions(query)
        options.where = { ...options.where, id }
        options.limit = 1

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
            const root = await libraryService.getLibraryRoot()
            if (!root) {
                set.status = 404
                return { error: 'Library root not found' }
            }
            id = root.id
        }

        const options = parseFindOptions(query)
        const settings = await readSettings()

        let finalGroupBy: string | undefined = undefined
        const rawGroupBy = query.groupBy

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
                return groupingService.getGroups(id, finalGroupBy, options)
            }

            return repositoryService.find(options)
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
            return groupingService.getGroups(id, finalGroupBy, options)
        }

        let children: any[]
        if (parent && parent.mediaType === 'tv') {
            children = repositoryService.getSeasonsWithEpisodes(id, options.fields)
        } else {
            options.where = { ...options.where, parentId: id }
            children = repositoryService.find(options)
        }

        return children
    })
    .get('/items/:id/ancestors', async ({ params: { id: rawId }, set }) => {
        let id = rawId
        if (id === 'root') {
            const root = await libraryService.getLibraryRoot()
            if (!root) {
                set.status = 404
                return { error: 'Library root not found' }
            }
            id = root.id
        }

        const ancestors = repositoryService.getAncestors(id)
        return ancestors.filter((a) => a.id !== id)
    })
    .post('/maintenance/scan', async () => {
        await libraryService.refreshLibrary()
        return { success: true }
    })
