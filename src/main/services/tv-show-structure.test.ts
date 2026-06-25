/**
 * TV Show Structure Sync - Regression Test
 * 
 * Verifies that Virtual Season Folders do not interfere with the
 * scanning of new physical episodes in a "flat" TV show.
 */
import { mock } from 'bun:test'
import path from 'path'

// Mock I/O boundaries
const RETRIEVER_PATH = path.resolve(__dirname, './retriever.service.ts')
const SETTINGS_PATH = path.resolve(__dirname, './settings.service.ts')

mock.module(RETRIEVER_PATH, () => ({
    search: async () => [],
    getDetails: async () => null,
    getCredits: async () => ({ cast: [], crew: [] }),
    getSeasonDetails: async () => null,
    cacheGenreLists: async () => {}
}))

mock.module(SETTINGS_PATH, () => ({
    readSettings: async () => ({ tmdbApiKey: 'fake-key' })
}))

import { describe, it, expect, beforeEach, afterEach } from 'bun:test'
import { createServiceTestContext, type ServiceTestContext } from '../database/test-helpers'
import { syncTvShowStructure } from './tv-show.service'
import { getItemById } from './repository.service'
import type { MediaFolder, MediaFile } from '@shared/types'

let ctx: ServiceTestContext

beforeEach(() => {
    ctx = createServiceTestContext()
})

afterEach(() => {
    ctx.cleanup()
})

describe('syncTvShowStructure (Flat Shows)', () => {
    it('processes loose episodes even when a virtual season folder exists', async () => {
        // Seed a flat TV show (no physical season folders) with one existing virtual season
        ctx.seedEntities([
            { id: 'e-invincible', tmdbId: 95557, mediaType: 'tv', title: 'Invincible' },
            { id: 'e-ep-4', mediaType: 'episode', seasonNumber: 4, episodeNumber: 4 },
            { id: 'e-vs-4', mediaType: 'season', seasonNumber: 4 }
        ])
        
        ctx.seedItems([
            { id: 'root', parentId: null, type: 'folder' },
            // The show folder
            { id: 'show-inv', parentId: 'root', type: 'folder', entityId: 'e-invincible', name: 'Invincible' },
            // An existing episode from a previous scan
            { id: 'ep-4', parentId: 'show-inv', type: 'file', name: 'Invincible.2021.S04E04.mkv', entityId: 'e-ep-4' },
            // The virtual season folder created by the previous scan
            { id: 'vs-4', parentId: 'show-inv', type: 'folder', name: 'Season 4', isVirtual: 1, entityId: 'e-vs-4' },
            
            // The NEW episode added by the user
            { id: 'ep-5', parentId: 'show-inv', type: 'file', name: 'Invincible.2021.S04E05.mkv' }
        ])

        const show = getItemById('show-inv') as MediaFolder
        
        // Trigger structure sync (simulating Phase 2 of a rescan)
        const changes = await syncTvShowStructure(show)
        
        // It should have identified the new episode and assigned it season 4, episode 5
        expect(changes.length).toBeGreaterThan(0)
        
        const updatedEp = getItemById('ep-5') as MediaFile
        expect(updatedEp.mediaType).toBe('episode')
        expect(updatedEp.seasonNumber).toBe(4)
        expect(updatedEp.episodeNumber).toBe(5)
    })

    it('does not assign season or episode metadata when processTvChildren is disabled', async () => {
        ctx.seedEntities([
            { id: 'e-disabled', tmdbId: 101, mediaType: 'tv', title: 'Disabled Show' }
        ])

        ctx.seedItems([
            { id: 'root', parentId: null, type: 'folder' },
            { id: 'show-disabled', parentId: 'root', type: 'folder', entityId: 'e-disabled', name: 'Disabled Show' },
            { id: 's1', parentId: 'show-disabled', type: 'folder', name: 'Season 01' },
            { id: 'ep-1', parentId: 's1', type: 'file', name: 'Disabled.Show.S01E01.mkv' },
            { id: 'ep-2', parentId: 'show-disabled', type: 'file', name: 'Disabled.Show.S02E01.mkv' }
        ])
        ctx.seedFolderSettings([
            {
                itemId: 'show-disabled',
                folderSettings: {
                    processTvChildren: false
                }
            }
        ])

        const show = getItemById('show-disabled') as MediaFolder
        const changes = await syncTvShowStructure(show)

        expect(changes).toHaveLength(0)

        const season = getItemById('s1') as MediaFolder
        expect(season.mediaType).toBeUndefined()
        expect(season.seasonNumber).toBe(null)

        const ep1 = getItemById('ep-1') as MediaFile
        expect(ep1.mediaType).toBeUndefined()
        expect(ep1.seasonNumber).toBe(null)
        expect(ep1.episodeNumber).toBe(null)

        const ep2 = getItemById('ep-2') as MediaFile
        expect(ep2.mediaType).toBeUndefined()
        expect(ep2.seasonNumber).toBe(null)
        expect(ep2.episodeNumber).toBe(null)
    })
})

describe('syncTvShowStructure (Mixed Shows)', () => {
    it('processes both physical season folders and loose episodes in the root', async () => {
        ctx.seedEntities([
            { id: 'e-mixed', tmdbId: 101, mediaType: 'tv', title: 'Mixed Show' }
        ])

        ctx.seedItems([
            { id: 'root', parentId: null, type: 'folder' },
            { id: 'show-mix', parentId: 'root', type: 'folder', entityId: 'e-mixed', name: 'Mixed Show' },

            // Physical Season 1 Folder + Episode inside
            { id: 's1', parentId: 'show-mix', type: 'folder', name: 'Season 1' },
            { id: 'ep-1', parentId: 's1', type: 'file', name: 'Show.S01E01.mkv' },

            // Loose Episode in the root (lazy user)
            { id: 'ep-2', parentId: 'show-mix', type: 'file', name: 'Show.S02E01.mkv' }
        ])

        const show = getItemById('show-mix') as MediaFolder
        
        // Before the fix, ep-2 would be completely ignored because 'Season 1' exists
        const changes = await syncTvShowStructure(show)

        expect(changes.length).toBeGreaterThan(0)

        // Ep 1 processed via physical folder
        const ep1 = getItemById('ep-1') as MediaFile
        expect(ep1.seasonNumber).toBe(1)
        expect(ep1.episodeNumber).toBe(1)

        // Ep 2 processed via loose file root scan
        const ep2 = getItemById('ep-2') as MediaFile
        expect(ep2.seasonNumber).toBe(2)
        expect(ep2.episodeNumber).toBe(1)
    })

    it('does not assign Season 1 to unrelated sibling folders when explicit Season XX folders exist', async () => {
        ctx.seedEntities([
            { id: 'e-jojo-like', tmdbId: 45790, mediaType: 'tv', title: 'Parted Adventure' }
        ])

        ctx.seedItems([
            { id: 'root', parentId: null, type: 'folder' },
            { id: 'show-parted', parentId: 'root', type: 'folder', entityId: 'e-jojo-like', name: 'Parted Adventure' },

            // Intentionally first, like the reported OVA folder. This name is not in the
            // special-folder ignore list, so the assertion only depends on explicit season matching.
            { id: 'side-stories', parentId: 'show-parted', type: 'folder', name: 'Side Stories' },
            { id: 'side-ep', parentId: 'side-stories', type: 'file', name: '01. The Side Chapter (2000).mkv' },

            { id: 's3', parentId: 'show-parted', type: 'folder', name: 'Season 03 (Part 04) - Diamond is Unbreakable' },
            { id: 's3-ep', parentId: 's3', type: 'file', name: 'Parted Adventure (2012) S03E01.mkv' },

            { id: 's4', parentId: 'show-parted', type: 'folder', name: 'Season 04 (Part 05) - Golden Wind' },
            { id: 's4-ep', parentId: 's4', type: 'file', name: 'Parted Adventure (2012) S04E01.mkv' },

            { id: 's2', parentId: 'show-parted', type: 'folder', name: 'Season 02 (Part 03) - Stardust Crusaders' },
            { id: 's2-ep', parentId: 's2', type: 'file', name: 'Parted Adventure (2012) S02E01.mkv' },

            { id: 's5', parentId: 'show-parted', type: 'folder', name: 'Season 05 (Part 06) - Stone Ocean' },
            { id: 's5-ep', parentId: 's5', type: 'file', name: 'Parted Adventure (2012) S05E01.mkv' },

            { id: 's1', parentId: 'show-parted', type: 'folder', name: 'Season 01 (Part 01+02) Phantom Blood & Battle Tendency' },
            { id: 's1-ep', parentId: 's1', type: 'file', name: 'Parted Adventure (2012) S01E01.mkv' }
        ])

        const show = getItemById('show-parted') as MediaFolder
        await syncTvShowStructure(show)

        const sideStories = getItemById('side-stories') as MediaFolder
        expect(sideStories.mediaType).toBeUndefined()
        expect(sideStories.seasonNumber).toBe(null)

        const sideEpisode = getItemById('side-ep') as MediaFile
        expect(sideEpisode.mediaType).toBeUndefined()
        expect(sideEpisode.seasonNumber).toBe(null)
        expect(sideEpisode.episodeNumber).toBe(null)

        for (const [id, seasonNumber] of [
            ['s1', 1],
            ['s2', 2],
            ['s3', 3],
            ['s4', 4],
            ['s5', 5]
        ] as const) {
            const season = getItemById(id) as MediaFolder
            expect(season.mediaType).toBe('season')
            expect(season.seasonNumber).toBe(seasonNumber)
        }
    })

    it('uses explicit season folders and repairs stale OVA season metadata', async () => {
        ctx.seedEntities([
            { id: 'e-jojo', tmdbId: 45790, mediaType: 'tv', title: "JoJo's Bizarre Adventure" },
            // Simulates metadata left behind by an earlier bad scan.
            { id: 'e-ova', mediaType: 'season', seasonNumber: 1, title: 'Season 1' },
            { id: 'e-s1', mediaType: 'season', seasonNumber: 4, title: 'Wrong Season' }
        ])

        ctx.seedItems([
            { id: 'root', parentId: null, type: 'folder' },
            { id: 'show-jojo', parentId: 'root', type: 'folder', entityId: 'e-jojo', name: "JoJo's Bizarre Adventure" },

            { id: 'ova', parentId: 'show-jojo', type: 'folder', entityId: 'e-ova', name: 'OVA' },
            { id: 'ova-ep', parentId: 'ova', type: 'file', name: '01. The Evil Spirit (2000).mkv' },

            { id: 's1', parentId: 'show-jojo', type: 'folder', entityId: 'e-s1', name: 'Season 01 (Part 01+02) Phantom Blood & Battle Tendency' },
            { id: 's1-ep', parentId: 's1', type: 'file', name: "JoJo's Bizarre Adventure (2012) S01E01.mkv" },

            { id: 's2', parentId: 'show-jojo', type: 'folder', name: 'Season 02 (Part 03) - Stardust Crusaders' },
            { id: 's2-ep', parentId: 's2', type: 'file', name: "JoJo's Bizarre Adventure (2012) S02E01.mkv" }
        ])

        const show = getItemById('show-jojo') as MediaFolder
        await syncTvShowStructure(show)

        const ova = getItemById('ova') as MediaFolder
        expect(ova.mediaType).toBe(null)
        expect(ova.seasonNumber).toBe(null)
        expect(ova.title).toBe(null)

        const ovaEp = getItemById('ova-ep') as MediaFile
        expect(ovaEp.mediaType).toBeUndefined()
        expect(ovaEp.seasonNumber).toBe(null)
        expect(ovaEp.episodeNumber).toBe(null)

        const season1 = getItemById('s1') as MediaFolder
        expect(season1.mediaType).toBe('season')
        expect(season1.seasonNumber).toBe(1)

        const ep1 = getItemById('s1-ep') as MediaFile
        expect(ep1.seasonNumber).toBe(1)
        expect(ep1.episodeNumber).toBe(1)

        const season2 = getItemById('s2') as MediaFolder
        expect(season2.mediaType).toBe('season')
        expect(season2.seasonNumber).toBe(2)

        const ep2 = getItemById('s2-ep') as MediaFile
        expect(ep2.seasonNumber).toBe(2)
        expect(ep2.episodeNumber).toBe(1)
    })
})
