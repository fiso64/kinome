import type { VirtualTagConfig } from '@shared/types'

/**
 * Predefined virtual tags shipped with the app.
 * These appear in the settings UI as editable tags but are NOT saved to
 * library-settings.json unless the user has actually modified them.
 *
 * NOTE: Use conditionGroups (not the legacy conditions shorthand) so the
 * definition matches the normalized form the frontend sends back on save,
 * enabling reliable deep-equality change detection.
 */
export const PREDEFINED_VTAGS: VirtualTagConfig[] = [
  {
    id: '_home_category',
    name: '_home_category',
    cases: [
      {
        filter: {
          conditionGroups: [
            [
              { field: 'mediaType', op: 'eq', value: 'movie' },
              { field: 'genre', op: 'contains', value: 'Animation' }
            ]
          ]
        },
        result: 'Animated Movies'
      },
      {
        filter: {
          conditionGroups: [
            [
              { field: 'mediaType', op: 'eq', value: 'tv' },
              { field: 'genre', op: 'contains', value: 'Animation' }
            ]
          ]
        },
        result: 'Animated Shows'
      },
      {
        filter: {
          conditionGroups: [
            [
              { field: 'mediaType', op: 'eq', value: 'movie' },
              { field: 'genre', op: 'notContains', value: 'Animation' }
            ]
          ]
        },
        result: 'Movies'
      },
      {
        filter: {
          conditionGroups: [
            [
              { field: 'mediaType', op: 'eq', value: 'tv' },
              { field: 'genre', op: 'notContains', value: 'Animation' }
            ]
          ]
        },
        result: 'TV Shows'
      }
    ],
    defaultResult: 'Uncategorized'
  }
]
