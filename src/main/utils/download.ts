import path from 'path'
import fs from 'fs/promises'

export async function downloadImage(url: string, destinationPath: string): Promise<void> {
    try {
        // Ensure the destination directory exists before writing the file.
        const dir = path.dirname(destinationPath)
        await fs.mkdir(dir, { recursive: true })

        const response = await fetch(url)
        if (!response.ok) {
            throw new Error(`Failed to fetch image: ${response.statusText}`)
        }
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const imageBuffer = Buffer.from(await (response as any).arrayBuffer())
        await fs.writeFile(destinationPath, imageBuffer)
    } catch (error) {
        console.error(`Error during image download or save from ${url}:`, error)
        // Re-throw the error so the calling function knows the operation failed.
        throw error
    }
}
