import { embeddedSubtitleFormats } from '@shared/web-playback'
import type { LocalMedia } from '@shared/local-media'
import type { LocalMediaField } from '@shared/metadata-fields'
import { LOCAL_MEDIA_COLUMNS } from '../local-media.sql'
import { withAccountLocations } from '../media-read-model.sql'
import { getDb, runTransaction } from '../client'

export interface ProbeCandidate {
  id: string
  sourceId: string
  relativePath: string
  size: number
  mtime: number
  birthtime: number
  inode: number
  device: number
  failures: number
  hadMetadata: number
}

export function findProbeCandidates(sourceIds: string[], now: number): ProbeCandidate[] {
  return getDb().query(`
    SELECT l.id, l.source_id AS sourceId, l.relative_path AS relativePath,
           l.size, l.mtime, l.birthtime, l.inode, l.device_id AS device,
           coalesce(m.failures, 0) AS failures, m.failures IS 0 AS hadMetadata
    FROM media_locations l LEFT JOIN local_media m ON m.location_id = l.id
    WHERE l.source_id IN (SELECT value FROM json_each(?))
      AND l.type = 'file' AND l.is_present = 1 AND l.is_ignored = 0
      AND l.size IS NOT NULL AND l.mtime IS NOT NULL
      AND (m.location_id IS NULL OR m.retry_at <= ?)
    ORDER BY l.source_id, l.relative_path
  `).all(JSON.stringify(sourceIds), now) as ProbeCandidate[]
}

export function saveProbeResult(
  file: ProbeCandidate,
  media: LocalMedia | null,
  retryAt: number | null
): boolean {
  return runTransaction(() => {
    const db = getDb()
    // A rescan can update the file or reconcile its identity while the probe runs.
    const current = db.query(`
      SELECT 1 FROM media_locations WHERE id = ? AND source_id = ? AND relative_path = ?
        AND is_present = 1 AND is_ignored = 0 AND size IS ? AND mtime IS ? AND birthtime IS ?
        AND inode IS ? AND device_id IS ?
    `).get(file.id, file.sourceId, file.relativePath, file.size, file.mtime, file.birthtime, file.inode, file.device)
    if (!current) return false

    const videoHeight = media?.tracks.find((track) => track.kind === 'video')?.height ?? null
    db.query(`
      INSERT INTO local_media (location_id, container, duration_seconds, bitrate, encoder, video_height, failures, retry_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(location_id) DO UPDATE SET
        container = excluded.container, duration_seconds = excluded.duration_seconds,
        bitrate = excluded.bitrate, encoder = excluded.encoder, video_height = excluded.video_height,
        failures = excluded.failures, retry_at = excluded.retry_at
    `).run(file.id, media?.container ?? null, media?.durationSeconds ?? null, media?.bitrate ?? null,
      media?.encoder ?? null, videoHeight, media ? 0 : file.failures + 1, retryAt)
    db.query('DELETE FROM local_media_tracks WHERE location_id = ?').run(file.id)
    const insert = db.query(`
      INSERT INTO local_media_tracks (
        location_id, stream_index, kind, codec, language, profile, encoder, pixel_format, frame_rate, bitrate, title, width, height,
        channels, channel_layout, sample_rate, is_default, forced, hearing_impaired
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `)
    for (const track of media?.tracks ?? []) {
      insert.run(file.id, track.index, track.kind, track.codec ?? null, track.language ?? null,
        track.profile ?? null, track.encoder ?? null, track.pixelFormat ?? null, track.frameRate ?? null,
        track.bitrate ?? null, track.title ?? null, track.width ?? null, track.height ?? null,
        track.channels ?? null, track.channelLayout ?? null, track.sampleRate ?? null,
        Number(track.default), Number(track.forced), Number(track.hearingImpaired))
    }
    return true
  })
}

export function suggestLocalMediaValues(
  field: LocalMediaField,
  query: string,
  limit: number,
  accountId?: string
): string[] {
  const { column, track } = LOCAL_MEDIA_COLUMNS[field]
  const table = track ? 'local_media_tracks' : 'local_media'
  const kind = track ? `kind = '${track}' AND ` : ''
  const visibility = accountId ? `
    AND (NOT EXISTS (SELECT 1 FROM account_filter_rules WHERE account_id = $accountId)
      OR EXISTS (
        SELECT 1 FROM account_visible_items WHERE account_id = $accountId AND item_id = i.id
      ))
  ` : ''
  // Deduplicate using the fact index before resolving account-selected locations.
  const sql = `
    SELECT CAST(candidate.value AS TEXT) AS value
    FROM (
      SELECT DISTINCT ${column} AS value
      FROM ${table}
      WHERE ${kind}${column} IS NOT NULL AND instr(lower(${column}), lower($query)) > 0
    ) candidate
    WHERE EXISTS (
      SELECT 1 FROM ${table} fact
      JOIN media_locations l ON l.id = fact.location_id
      JOIN media_items_read i ON i.id = l.item_id AND i.selected_location_id = l.id
      WHERE ${track ? `fact.kind = '${track}' AND ` : ''}fact.${column} = candidate.value
        AND i.location_is_present = 1 AND i.is_hidden = 0 AND i.is_ignored = 0
        ${visibility}
    )
    ORDER BY instr(lower(candidate.value), lower($query)), candidate.value COLLATE NOCASE
    LIMIT $limit
  `
  const params = { $query: query, $limit: Number.isSafeInteger(limit) && limit >= 0 ? limit : 20 }
  const rows = (accountId
    ? getDb().query(withAccountLocations(sql, '$accountId')).all({ ...params, $accountId: accountId })
    : getDb().query(sql).all(params)) as { value: string }[]
  return rows.map(({ value }) => value)
}

const supportedSubtitles = Object.keys(embeddedSubtitleFormats).map((codec) => `'${codec}'`).join(', ')

export function getPlaybackTrackLanguages(locationId: string) {
  return getDb().query<{ kind: 'audio' | 'subtitle'; language: string }, [string]>(`
    SELECT DISTINCT kind, language FROM local_media_tracks
    WHERE location_id = ? AND language IS NOT NULL
      AND (kind = 'audio' OR (kind = 'subtitle' AND codec IN (${supportedSubtitles})))
    ORDER BY kind, language
  `).all(locationId)
}
