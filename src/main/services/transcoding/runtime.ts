import { constants } from 'node:fs'
import { access, readdir } from 'node:fs/promises'
import os from 'node:os'

export const ffmpeg = Bun.which('ffmpeg')
export const ffprobe = Bun.which('ffprobe')

// Background work runs a few FFmpeg processes at a time, below playback in CPU priority.
const BACKGROUND_SLOTS = 2
let backgroundRunning = 0
const backgroundWaiting: (() => void)[] = []

/**
 * Runs FFmpeg for work no viewer is waiting on frame by frame, such as
 * scrubbing thumbnails and scaled artwork, so it cannot starve a stream of
 * CPU or memory. Resolves to FFmpeg's error, or undefined when it succeeds.
 */
export async function backgroundFfmpeg(args: string[]): Promise<string | undefined> {
  if (backgroundRunning >= BACKGROUND_SLOTS) await new Promise<void>((resolve) => backgroundWaiting.push(resolve))
  backgroundRunning++
  try {
    const child = Bun.spawn([ffmpeg!, '-hide_banner', '-loglevel', 'error', '-nostdin', '-y', ...args], { stdin: 'ignore', stdout: 'ignore', stderr: 'pipe' })
    try {
      os.setPriority(child.pid, 19)
    } catch {
      // The process may have exited already.
    }
    const [code, errors] = await Promise.all([child.exited, new Response(child.stderr).text()])
    return code === 0 ? undefined : errors.trim().slice(0, 300) || `FFmpeg exited with status ${code}`
  } finally {
    backgroundRunning--
    backgroundWaiting.shift()?.()
  }
}
export const conversionEnabled = process.env.KINOME_TRANSCODING_DISABLED !== '1'
export const conversionAvailable = conversionEnabled && !!ffmpeg && !!ffprobe
const preferredRenderNode = process.env.KINOME_VAAPI_DEVICE
let detection: Promise<string | undefined> | undefined
let retryAfter = 0

async function detectVaapiDevice(executable: string): Promise<string | undefined> {
  const candidates = (await readdir('/dev/dri').catch(() => []))
    .filter((entry) => /^renderD\d+$/.test(entry))
    .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }))
    .map((entry) => `/dev/dri/${entry}`)
  if (preferredRenderNode) candidates.unshift(preferredRenderNode)
  for (const device of new Set(candidates)) {
    try {
      await access(device, constants.R_OK | constants.W_OK)
      const probe = Bun.spawn([
        executable, '-hide_banner', '-loglevel', 'error', '-nostdin', '-vaapi_device', device,
        '-f', 'lavfi', '-i', 'color=size=128x128', '-vf', 'format=nv12,hwupload',
        '-frames:v', '1', '-c:v', 'h264_vaapi', '-qp', '23', '-f', 'null', '-'
      ], { stdout: 'ignore', stderr: 'ignore', signal: AbortSignal.timeout(3000) })
      if (await probe.exited === 0) return device
    } catch {
      // Try the next accessible render node if the driver or encoder is unavailable.
    }
  }
}

export function getVaapiDevice(): Promise<string | undefined> {
  if (process.platform !== 'linux' || !ffmpeg || !conversionAvailable) return Promise.resolve(undefined)
  if (!detection || (retryAfter > 0 && performance.now() >= retryAfter)) {
    retryAfter = 0
    detection = detectVaapiDevice(ffmpeg).then((device) => {
      if (!device) retryAfter = performance.now() + 30_000
      return device
    })
  }
  return detection
}
