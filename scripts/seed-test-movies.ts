import { mkdir, mkdtemp, rename, rm } from 'node:fs/promises'
import path from 'node:path'

// Complete films. Release tokens in the filenames exercise the tree's label detection.
const movies = [
  {
    title: 'Charge (2022)',
    release: '2160p.BDRemux.VP9',
    source: 'charge',
    media: '7/7a/Charge_-_Blender_Open_Movie-full_movie.webm',
    video: ['copy']
  },
  {
    title: 'Glass Half (2015)',
    release: '1080p.BDRip.HEVC',
    source: 'glass',
    media: '0/02/Glass_Half_-_Blender_Open_Movie-full_movie.webm',
    video: ['libx265', '-preset', 'ultrafast', '-crf', '25', '-x265-params', 'pools=4:log-level=error', '-vf', 'scale=1920:-2']
  },
  {
    title: 'Coffee Run (2020)',
    release: '1080p.WEB-DL.AV1',
    source: 'coffee',
    media: '3/3f/Coffee_Run_-_Blender_Open_Movie-full_movie.webm',
    video: ['libsvtav1', '-preset', '10', '-crf', '32', '-svtav1-params', 'lp=4']
  },
  {
    title: 'Charade (1963)',
    release: '720p.WEBRip.VP9',
    source: 'charade',
    media: 'transcoded/d/dc/Charade_%281963%29.webm/Charade_%281963%29.webm.720p.vp9.webm',
    video: ['copy']
  },
  {
    title: 'Spring (2019)',
    release: '1080p.BluRay.H264',
    source: 'spring',
    media: 'a/a5/Spring_-_Blender_Open_Movie.webm',
    video: ['libx264', '-preset', 'ultrafast', '-crf', '23', '-vf', 'scale=1920:-2']
  },
  {
    title: 'The General (1926)',
    release: '480p.DVDRip.VP9',
    source: 'general',
    media: 'transcoded/a/ab/The_General_1926_720p.webm/The_General_1926_720p.webm.480p.vp9.webm',
    video: ['copy']
  }
]

const fixtures = path.resolve(import.meta.dir, '../test-data')
const library = path.join(fixtures, 'test-lib-small')
const staging = await mkdtemp(path.join(fixtures, '.seed-movies-'))

async function run(command: string[]) {
  const child = Bun.spawn(command, { stderr: 'inherit' })
  if (await child.exited !== 0) throw new Error(`${command[0]} failed`)
}

try {
  await Promise.all(movies.map(async ({ title, release, source, media, video }) => {
    const name = `${title}.${release}`
    const folder = path.join(library, title)
    const destination = path.join(folder, `${name}.mkv`)
    if (await Bun.file(destination).exists()) return

    const url = `https://upload.wikimedia.org/wikipedia/commons/${media}`
    const input = path.join(staging, `${source}.webm`)
    const output = path.join(staging, `${name}.mkv`)
    try {
      await run(['curl', '-fsSL', '--retry', '2', url, '-o', input])
      await run([
        'ffmpeg', '-nostdin', '-hide_banner', '-loglevel', 'error', '-filter_threads', '2',
        '-i', input, '-map', '0:v:0', '-map', '0:a?', '-c:v', ...video, '-threads', '4', '-c:a', 'copy',
        '-metadata', `comment=Test fixture prepared from ${url}`, output
      ])
      await mkdir(folder, { recursive: true })
      await rename(output, destination)
      console.log(`Seeded ${name}.mkv`)
    } catch (error) {
      console.error(`Could not seed ${name}`, error)
      process.exitCode = 1
    }
  }))
} finally {
  await rm(staging, { recursive: true, force: true })
}
