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
let detection: Promise<VaapiAccelerator | undefined> | undefined
let retryAfter = 0

/** A render node that passed a VA-API encode test. */
export interface VaapiAccelerator {
  device: string
  /**
   * Whether FFmpeg's libplacebo filter works through Vulkan on this machine. It converts HDR
   * for SDR screens the way mpv does. VA-API's own conversion follows the mastering display's
   * peak, which leaves films graded well below it too dark, and it refuses HDR video without
   * mastering metadata.
   */
  libplacebo: boolean
}

function succeeds(args: string[], timeout: number): Promise<boolean> {
  const probe = Bun.spawn(args, { stdout: 'ignore', stderr: 'ignore', signal: AbortSignal.timeout(timeout) })
  return probe.exited.then((code) => code === 0, () => false)
}

async function detectVaapi(executable: string): Promise<VaapiAccelerator | undefined> {
  const candidates = (await readdir('/dev/dri').catch(() => []))
    .filter((entry) => /^renderD\d+$/.test(entry))
    .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }))
    .map((entry) => `/dev/dri/${entry}`)
  if (preferredRenderNode) candidates.unshift(preferredRenderNode)
  const base = [executable, '-hide_banner', '-loglevel', 'error', '-nostdin']
  const encode = ['-frames:v', '1', '-c:v', 'h264_vaapi', '-qp', '23', '-f', 'null', '-']
  for (const device of new Set(candidates)) {
    try {
      await access(device, constants.R_OK | constants.W_OK)
      const encodes = await succeeds([...base, '-vaapi_device', device,
        '-f', 'lavfi', '-i', 'color=size=128x128', '-vf', 'format=nv12,hwupload', ...encode], 3000)
      if (!encodes) continue
      // Vulkan startup and shader compilation take longer than the encode test.
      const libplacebo = await succeeds([...base, ...vaapiDeviceArgs({ device, libplacebo: true }),
        '-f', 'lavfi', '-i', 'color=size=128x128', '-vf',
        `format=p010le,setparams=color_primaries=bt2020:color_trc=smpte2084:colorspace=bt2020nc,${LIBPLACEBO_TO_SDR},hwupload`,
        ...encode], 10_000)
      return { device, libplacebo }
    } catch {
      // Try the next accessible render node if the driver or encoder is unavailable.
    }
  }
}

/**
 * Converts HDR to SDR BT.709 as mpv does. Peak detection is off because each segment job is a
 * separate FFmpeg run, and per-run detection could change brightness where two jobs meet.
 */
export const LIBPLACEBO_TO_SDR =
  'libplacebo=format=nv12:colorspace=bt709:color_primaries=bt709:color_trc=bt709:range=tv:peak_detect=0'

/**
 * FFmpeg options that open the accelerator. With libplacebo, Vulkan derives from the same
 * VA-API device, and filters upload to VA-API.
 */
export function vaapiDeviceArgs(accelerator: VaapiAccelerator): string[] {
  return accelerator.libplacebo
    ? ['-init_hw_device', `vaapi=va:${accelerator.device}`, '-init_hw_device', 'vulkan=vk@va', '-filter_hw_device', 'va']
    : ['-vaapi_device', accelerator.device]
}

export function getVaapiAccelerator(): Promise<VaapiAccelerator | undefined> {
  if (process.platform !== 'linux' || !ffmpeg || !conversionAvailable) return Promise.resolve(undefined)
  if (!detection || (retryAfter > 0 && performance.now() >= retryAfter)) {
    retryAfter = 0
    detection = detectVaapi(ffmpeg).then((accelerator) => {
      if (!accelerator) retryAfter = performance.now() + 30_000
      else console.info('[Playback] Detected VA-API', accelerator)
      return accelerator
    })
  }
  return detection
}
