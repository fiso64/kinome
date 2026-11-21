import type { LocalMediaField } from '@shared/metadata-fields'

export const LOCAL_MEDIA_COLUMNS: Record<LocalMediaField, { column: string; track?: string }> = {
    'file.container': { column: 'container' },
    'file.durationSeconds': { column: 'duration_seconds' },
    'file.encoder': { column: 'encoder' },
    'file.videoHeight': { column: 'video_height' },
    'file.videoCodec': { column: 'codec', track: 'video' },
    'file.audioCodec': { column: 'codec', track: 'audio' },
    'file.audioLanguage': { column: 'language', track: 'audio' },
    'file.subtitleCodec': { column: 'codec', track: 'subtitle' },
    'file.subtitleLanguage': { column: 'language', track: 'subtitle' }
}

export const LOCAL_MEDIA_SQL = `
CREATE TABLE IF NOT EXISTS local_media (
    location_id TEXT PRIMARY KEY REFERENCES media_locations(id) ON DELETE CASCADE,
    container TEXT COLLATE NOCASE,
    duration_seconds REAL,
    bitrate INTEGER,
    encoder TEXT COLLATE NOCASE,
    video_height INTEGER,
    failures INTEGER NOT NULL,
    retry_at INTEGER
);

CREATE TABLE IF NOT EXISTS local_media_tracks (
    location_id TEXT NOT NULL REFERENCES local_media(location_id) ON DELETE CASCADE,
    stream_index INTEGER NOT NULL,
    kind TEXT NOT NULL,
    codec TEXT COLLATE NOCASE,
    language TEXT COLLATE NOCASE,
    profile TEXT,
    encoder TEXT,
    pixel_format TEXT,
    frame_rate TEXT,
    bitrate INTEGER,
    title TEXT,
    width INTEGER,
    height INTEGER,
    channels INTEGER,
    channel_layout TEXT,
    sample_rate INTEGER,
    is_default INTEGER NOT NULL,
    forced INTEGER NOT NULL,
    hearing_impaired INTEGER NOT NULL,
    PRIMARY KEY(location_id, stream_index)
) WITHOUT ROWID;

CREATE INDEX IF NOT EXISTS idx_local_media_container ON local_media(container);
CREATE INDEX IF NOT EXISTS idx_local_media_duration ON local_media(duration_seconds);
CREATE INDEX IF NOT EXISTS idx_local_media_height ON local_media(video_height);
CREATE INDEX IF NOT EXISTS idx_local_media_track_codec ON local_media_tracks(kind, codec, location_id);
CREATE INDEX IF NOT EXISTS idx_local_media_track_language ON local_media_tracks(kind, language, location_id);

CREATE TRIGGER IF NOT EXISTS media_locations_invalidate_probe
AFTER UPDATE OF size, mtime, birthtime, inode, device_id ON media_locations
WHEN old.size IS NOT new.size OR old.mtime IS NOT new.mtime OR old.birthtime IS NOT new.birthtime
     OR old.inode IS NOT new.inode OR old.device_id IS NOT new.device_id
BEGIN
    DELETE FROM local_media WHERE location_id = new.id;
END;
`

// The tree uses the cached file duration and the first video stream.
export const VIDEO_SUMMARY_SQL = `CASE WHEN i.type = 'file' AND i.location_is_present = 1 THEN (
    SELECT json_object('width', t.width, 'height', t.height, 'codec', t.codec, 'durationSeconds', m.duration_seconds)
    FROM local_media m
    JOIN local_media_tracks t INDEXED BY sqlite_autoindex_local_media_tracks_1 ON t.location_id = m.location_id
    WHERE m.location_id = i.selected_location_id AND t.kind = 'video'
    ORDER BY t.stream_index LIMIT 1
) END`

// Only detail requests project all track rows to an object for transport.
export const LOCAL_MEDIA_DETAIL_SQL = `(
    SELECT json_object(
        'container', m.container, 'durationSeconds', m.duration_seconds,
        'bitrate', m.bitrate, 'encoder', m.encoder, 'tracks', json((
            SELECT json_group_array(json_object(
                'index', t.stream_index, 'kind', t.kind, 'codec', t.codec, 'language', t.language,
                'profile', t.profile, 'encoder', t.encoder, 'pixelFormat', t.pixel_format,
                'frameRate', t.frame_rate, 'bitrate', t.bitrate, 'title', t.title, 'width', t.width, 'height', t.height,
                'channels', t.channels, 'channelLayout', t.channel_layout, 'sampleRate', t.sample_rate,
                'default', json(CASE WHEN t.is_default THEN 'true' ELSE 'false' END),
                'forced', json(CASE WHEN t.forced THEN 'true' ELSE 'false' END),
                'hearingImpaired', json(CASE WHEN t.hearing_impaired THEN 'true' ELSE 'false' END)
            ))
            FROM local_media_tracks t WHERE t.location_id = m.location_id
        ))
    )
    FROM local_media m WHERE m.location_id = i.selected_location_id AND m.failures = 0 AND i.location_is_present = 1
)`
