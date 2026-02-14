import { describe, it, expect, mock, beforeEach } from 'bun:test'
import * as groupingService from './grouping.service'
import * as repositoryService from './repository.service'
import * as settingsService from './settings.service'
import { StoredViewSettings, Settings, MediaFolder, LibraryItem } from '@shared/types'
import { resolveViewSettings } from '@shared/settings-helpers'

// Setup Mocks
mock.module('./repository.service', () => ({
    getItemById: mock(() => null),
    find: mock(() => []),
    getRoot: mock(() => null),
    getValuesForKey: mock((item: LibraryItem, key: string) => {
        const val = (item as any)[key]
        if (val === undefined || val === null) return []
        return Array.isArray(val) ? val : [val]
    }),
    getChildren: mock(() => []),
    isValidField: mock(() => true)
}))

mock.module('./settings.service', () => ({
    readSettings: mock(async () => ({}))
}))

mock.module('./library.service', () => ({
    getLibraryRoot: mock(async () => ({ status: 'ready', root: { id: 'root-id' } }))
}))

describe('Layout Resolution Sensitivity Matrix', () => {
    let mockSettings: Settings

    beforeEach(() => {
        mockSettings = {
            defaultLayouts: {
                _default: { layout: 'grid', clickAction: 'detail' },
                movie: { layout: 'grid', clickAction: 'detail', gridPosterSize: 300 },
                tv: { layout: 'tabs', clickAction: 'folder', groupBy: 'folder' },
                season: { layout: 'list', clickAction: 'detail' },
            },
            defaultLayoutSettings: {
                grid: { gridPosterSize: 250 },
                list: { listDescriptionRows: 5 },
                tabs: { tabStyle: 'pills' } as any,
                sections: { sectionStyle: 'default' } as any
            },
            virtualTags: [],
        } as unknown as Settings
    })

    describe('Specificity Cascade (Spec §2.1)', () => {
        it('Scenario 1: Global Default (Lowest Specificity)', () => {
            const item: MediaFolder = { id: 'f1', type: 'folder' } as any
            const res = resolveViewSettings(item, mockSettings).settings
            expect(res.layout).toBe('grid')
            expect(res.gridPosterSize).toBe(250) // From global defaultLayoutSettings.grid
        })

        it('Scenario 2: Media-Type Default beats Global', () => {
            const item: MediaFolder = { id: 'show1', type: 'folder', mediaType: 'movie' } as any
            const res = resolveViewSettings(item, mockSettings).settings
            expect(res.layout).toBe('grid')
            expect(res.gridPosterSize).toBe(300) // Specified in media-type default
        })

        it('Scenario 3: Local Item Settings beat Media-Type', () => {
            const item: MediaFolder = {
                id: 'show1',
                type: 'folder',
                mediaType: 'movie',
                viewSettings: { layout: 'list', listDescriptionRows: 10 }
            } as any
            const res = resolveViewSettings(item, mockSettings).settings
            expect(res.layout).toBe('list')
            expect(res.listDescriptionRows).toBe(10)
        })

        it('Scenario 4: Inherited Context beats Local Item', () => {
            const item: MediaFolder = {
                id: 'f1',
                type: 'folder',
                viewSettings: { layout: 'grid' }
            } as any
            const inherited: StoredViewSettings = { layout: 'sections' }
            const res = resolveViewSettings(item, mockSettings, new Set(), inherited).settings
            expect(res.layout).toBe('sections')
        })

        it('Scenario 5: Direct Override (Highest Specificity) beats Inherited', () => {
            const item: MediaFolder = { id: 'child-1' } as any
            const inherited: StoredViewSettings = {
                layout: 'sections',
                overrides: {
                    'child-1': { layout: 'tabs' }
                }
            }
            const res = resolveViewSettings(item, mockSettings, new Set(), inherited).settings
            expect(res.layout).toBe('tabs')
        })
    })

    describe('Layer Bypassing (ignoreLayers & ignoreOverrideId)', () => {
        it('Scenario 6: ignoreLayers - bypasses type-specific and falls back to global', () => {
            const item: MediaFolder = { id: 'm1', type: 'folder', mediaType: 'movie' } as any
            // 'movie' default has gridPosterSize 300. Global has 250.
            const res = resolveViewSettings(item, mockSettings, new Set(['movie'])).settings
            expect(res.gridPosterSize).toBe(250)
        })

        it('Scenario 7: ignoreOverrideId - bypasses specific child override', () => {
            const item: MediaFolder = { id: 'c1', type: 'folder' } as any
            const inherited: StoredViewSettings = {
                layout: 'sections',
                overrides: {
                    'c1': { layout: 'list' }
                }
            }
            // Should resolve to 'sections' (inherited level) despite override
            const res = resolveViewSettings(item, mockSettings, new Set(), inherited, 'c1').settings
            expect(res.layout).toBe('sections')
        })
    })

    describe('Additive Merging of Complex Maps', () => {
        it('merges virtualFolderSettings across all layers', () => {
            const item: MediaFolder = {
                id: 'f1',
                viewSettings: {
                    layout: 'tabs',
                    virtualFolderSettings: { 'v1': { title: 'Local V1' } }
                }
            } as any

            const inherited: StoredViewSettings = {
                virtualFolderSettings: { 'v2': { title: 'Inherited V2' } }
            }

            mockSettings.defaultLayouts.movie = {
                ...(mockSettings.defaultLayouts.movie as any),
                virtualFolderSettings: { 'v3': { title: 'Type V3' } }
            } as any

            const res = resolveViewSettings({ ...item, mediaType: 'movie' } as any, mockSettings, new Set(), inherited).settings
            const vfs = res.virtualFolderSettings!

            expect(vfs['v1'].title).toBe('Local V1')
            expect(vfs['v2'].title).toBe('Inherited V2')
            expect(vfs['v3'].title).toBe('Type V3')
        })

        it('merges childViewSettings.overrides across layers', () => {
            const parent: MediaFolder = {
                id: 'p1',
                viewSettings: {
                    childViewSettings: {
                        overrides: { 'c1': { layout: 'list' } }
                    }
                }
            } as any

            const inherited: StoredViewSettings = {
                childViewSettings: {
                    overrides: { 'c2': { layout: 'grid' } }
                }
            }

            const res = resolveViewSettings(parent, mockSettings, new Set(), inherited).settings
            const overrides = res.childViewSettings?.overrides

            expect(overrides?.['c1'].layout).toBe('list')
            expect(overrides?.['c2'].layout).toBe('grid')
        })
    })

    describe('Invariant Validation', () => {
        it('I3: Mixed Content Fallback - TV Show injectors', () => {
            const show: MediaFolder = { id: 'show1', mediaType: 'tv' } as any
            const res = resolveViewSettings(show, mockSettings).settings

            // Implicit season default is 'list' in this test's mock
            expect(res.childViewSettings?.layout).toBe('list')
        })

        it('I3: Mixed Content Fallback - Preservation of existing overrides', () => {
            const show: MediaFolder = {
                id: 'show1',
                mediaType: 'tv',
                viewSettings: {
                    childViewSettings: {
                        overrides: { 'spec': { title: 'Special Episode' } }
                    }
                }
            } as any
            const res = resolveViewSettings(show, mockSettings).settings

            expect(res.childViewSettings?.layout).toBe('list')
            expect(res.childViewSettings?.overrides?.['spec'].title).toBe('Special Episode')
        })
    })
})

describe('Grouping and Layouts (Service Integration)', () => {
    let mockSettings: Settings

    beforeEach(() => {
        mockSettings = {
            defaultLayouts: {
                _default: { layout: 'grid', clickAction: 'detail' },
                movie: { layout: 'grid', clickAction: 'detail' },
                tv: { layout: 'tabs', clickAction: 'folder', groupBy: 'folder' },
                season: { layout: 'grid', clickAction: 'detail' },
            },
            defaultLayoutSettings: {
                grid: { gridPosterSize: 250 },
                list: { listDescriptionRows: 5 },
                tabs: { tabStyle: 'pills' } as any,
                sections: { sectionStyle: 'default' } as any
            },
            virtualTags: [],
        } as unknown as Settings

        const repo = require('./repository.service')
        repo.getItemById.mockReset()
        repo.find.mockReset()
        repo.getChildren.mockReset()
        repo.getRoot.mockReset()

        repo.find.mockReturnValue([])
        repo.getItemById.mockReturnValue(null)
        repo.getChildren.mockReturnValue([])

        const settings = require('./settings.service')
        settings.readSettings.mockResolvedValue(mockSettings)
    })

    describe('Grouping Logic', () => {
        it('groups loose files into "Season N" and "Files" folders (groupBy: folder)', async () => {
            const folder: MediaFolder = { id: 'f1' } as any
            const items: LibraryItem[] = [
                { id: 'file-1', seasonNumber: 1, type: 'file' },
                { id: 'sub-1', type: 'folder', name: 'Other' }
            ] as any
            const repo = require('./repository.service')
            repo.getItemById.mockReturnValue(folder)
            repo.find.mockReturnValue(items)
            repo.getChildren.mockReturnValue(items)

            const res = await groupingService.getGroupedChildren('f1', {}, 'folder') as LibraryItem[]

            const names = res.map(i => i.name)
            expect(names).toContain('Season 1')
            expect(names).toContain('Other')
        })

        it('supports deep recursive grouping', async () => {
            const rootFolder: MediaFolder = {
                id: 'movies',
                viewSettings: {
                    layout: 'tabs',
                    groupBy: 'genres',
                    childViewSettings: { layout: 'tabs', groupBy: 'year' }
                }
            } as any
            const movie: LibraryItem = { id: 'm1', name: 'M1', genres: ['Action'], year: 2024, type: 'file' } as any
            const repo = require('./repository.service')
            repo.getItemById.mockImplementation((id: string) => (id === 'movies' ? rootFolder : null))
            repo.find.mockReturnValue([movie])

            const level1 = await groupingService.getGroupedChildren('movies', {}) as MediaFolder[]
            expect(level1.length).toBe(1)
            expect(level1[0].name).toBe('Action')
            expect(level1[0].children?.[0].name).toBe('2024')
        })
    })

    describe('Hierarchy & Virtual IDs', () => {
        it('Scenario 8: resolveViewHierarchy respects recursive=false', async () => {
            const root: MediaFolder = {
                id: 'root-id',
                type: 'folder',
                viewSettings: { layout: 'tabs', groupBy: 'folder' }
            } as any
            const child: MediaFolder = { id: 'c1', parentId: 'root-id', type: 'folder' } as any

            const repo = require('./repository.service')
            repo.getItemById.mockImplementation((id: string) => (id === 'root-id' ? root : id === 'c1' ? child : null))
            repo.find.mockReturnValue([child])

            const res = await groupingService.resolveViewHierarchy('root-id', false)
            expect(res?.children).toBeUndefined()
        })

        it('generates deterministic virtual IDs and paths', async () => {
            const parent: MediaFolder = { id: 'p1', name: 'Parent', type: 'folder' } as any
            const repo = require('./repository.service')
            repo.getItemById.mockReturnValue(parent)

            const id = 'virtual--p1--genre:Action'
            const item = groupingService.getVirtualItem(id)

            expect(item?.id).toBe(id)
            expect(item?.path).toBe('virtual/genre:Action')
            expect((item as MediaFolder).isVirtual).toBe(true)
        })
    })
})
