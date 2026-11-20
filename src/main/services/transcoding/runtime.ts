import { constants } from 'node:fs'
import { access, readdir } from 'node:fs/promises'

export const ffmpeg = Bun.which('ffmpeg')
export const ffprobe = Bun.which('ffprobe')
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
