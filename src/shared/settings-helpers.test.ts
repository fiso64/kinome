/**
 * Settings Helpers — resolveViewSettings tests
 *
 * Pure unit tests for the specificity cascade and its invariants.
 */
import { describe, it, expect } from 'bun:test'
import { resolveViewSettings } from './settings-helpers'
import type { MediaFolder, Settings, StoredViewSettings } from './types'

/** Minimal Settings factory — only the fields resolveViewSettings touches. */
function makeSettings(overrides: Partial<Settings> = {}): Settings {
  return {
    defaultLayouts: {
      _default: { layout: 'grid', clickAction: 'detail' },
      movie: { layout: 'grid', clickAction: 'detail' },
      tv: { layout: 'tabs', clickAction: 'detail' },
      season: { layout: 'list', clickAction: 'play' }
    },
    defaultLayoutSettings: {},
    ...overrides
  } as Settings
}

function makeFolder(overrides: Partial<MediaFolder> = {}): MediaFolder {
  return {
    id: 'folder-1',
    name: 'Test Folder',
    type: 'folder',
    ...overrides
  } as MediaFolder
}

describe('resolveViewSettings', () => {
  describe('I3: TV show children default to season layout', () => {
    const settings = makeSettings()

    it('TV show resolves childViewSettings with season defaults', () => {
      const tvShow = makeFolder({ id: 'show', mediaType: 'tv' })
      const result = resolveViewSettings(tvShow, settings)

      // I3: childViewSettings should include season defaults
      expect(result.settings.childViewSettings).toBeDefined()
      expect(result.settings.childViewSettings!.layout).toBe('list')
    })

    it('season virtual folder inherits season layout from TV parent', () => {
      const tvShow = makeFolder({ id: 'show', mediaType: 'tv' })
      const tvResult = resolveViewSettings(tvShow, settings)
      const inherited = tvResult.settings.childViewSettings!

      const seasonFolder = makeFolder({ id: 'season-1', mediaType: 'season' })
      const result = resolveViewSettings(seasonFolder, settings, new Set(), inherited)

      expect(result.settings.layout).toBe('list')
    })

    it('real sub-folder (Extras) inherits season layout from TV parent', () => {
      const tvShow = makeFolder({ id: 'show', mediaType: 'tv' })
      const tvResult = resolveViewSettings(tvShow, settings)
      const inherited = tvResult.settings.childViewSettings!

      const extrasFolder = makeFolder({ id: 'extras', mediaType: undefined })
      const result = resolveViewSettings(extrasFolder, settings, new Set(), inherited)

      expect(result.settings.layout).toBe('list')
    })

    it('loose items tab (Files) inherits season layout from TV parent', () => {
      const tvShow = makeFolder({ id: 'show', mediaType: 'tv' })
      const tvResult = resolveViewSettings(tvShow, settings)
      const inherited = tvResult.settings.childViewSettings!

      const filesFolder = makeFolder({ id: '_files:show', mediaType: undefined })
      const result = resolveViewSettings(filesFolder, settings, new Set(), inherited)

      expect(result.settings.layout).toBe('list')
    })

    it('explicit child override still wins over I3 season default', () => {
      const tvShow = makeFolder({
        id: 'show',
        mediaType: 'tv',
        viewSettings: {
          childViewSettings: {
            overrides: { extras: { layout: 'grid' } }
          }
        } as StoredViewSettings
      })
      const tvResult = resolveViewSettings(tvShow, settings)
      const inherited = tvResult.settings.childViewSettings!

      const extrasFolder = makeFolder({ id: 'extras', mediaType: undefined })
      const result = resolveViewSettings(extrasFolder, settings, new Set(), inherited)

      expect(result.settings.layout).toBe('grid')
    })
  })
})
