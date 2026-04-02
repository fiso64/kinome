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