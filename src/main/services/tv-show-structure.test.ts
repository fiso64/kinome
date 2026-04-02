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
const PATHS_PATH = path.resolve(__dirname, './paths.service.ts')

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

mock.module(PATHS_PATH, () => ({
    getLibraryDataPath: () => '/tmp/kinome-test',
    isRemoteLibrary: () => false,
    resolveAssetPath: () => null
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
})