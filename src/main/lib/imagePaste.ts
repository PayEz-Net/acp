import * as fs from 'fs';
import * as fsp from 'fs/promises';
import * as path from 'path';
import { app, nativeImage } from 'electron';

export const PASTED_IMAGES_DIR = 'pasted-images';
export const PASTED_IMAGE_MAX_AGE_MS = 24 * 60 * 60 * 1000; // 24 hours
export const PASTED_IMAGE_MAX_SIZE_BYTES = 10 * 1024 * 1024; // 10 MB
export const PASTED_IMAGE_MAX_DIMENSION = 4096;

export type ImagePasteErrorCode =
  | 'TEMP_WRITE_FAILED'
  | 'PNG_CONVERSION_FAILED'
  | 'IMAGE_TOO_LARGE'
  | 'IMAGE_DIMENSIONS_TOO_LARGE';

export class ImagePasteError extends Error {
  constructor(
    public readonly code: ImagePasteErrorCode,
    message: string,
    public readonly imageId?: string,
  ) {
    super(message);
    this.name = 'ImagePasteError';
  }
}

async function getPastedImagesDir(): Promise<string> {
  const dir = path.join(app.getPath('temp'), app.getName(), PASTED_IMAGES_DIR);
  try {
    await fsp.access(dir);
  } catch {
    await fsp.mkdir(dir, { recursive: true });
  }
  return dir;
}

function validateImageBuffer(data: ArrayBuffer, imageId?: string): void {
  if (data.byteLength > PASTED_IMAGE_MAX_SIZE_BYTES) {
    throw new ImagePasteError(
      'IMAGE_TOO_LARGE',
      `Image exceeds ${PASTED_IMAGE_MAX_SIZE_BYTES} bytes`,
      imageId,
    );
  }
}

function validateImageDimensions(
  image: Electron.NativeImage,
  imageId?: string,
): void {
  const { width, height } = image.getSize();
  if (width > PASTED_IMAGE_MAX_DIMENSION || height > PASTED_IMAGE_MAX_DIMENSION) {
    throw new ImagePasteError(
      'IMAGE_DIMENSIONS_TOO_LARGE',
      `Image dimensions ${width}×${height} exceed ${PASTED_IMAGE_MAX_DIMENSION}×${PASTED_IMAGE_MAX_DIMENSION}`,
      imageId,
    );
  }
}

/**
 * Normalize any supported image blob to PNG and write it to a temp file.
 * Returns the absolute path. The renderer never sees this path.
 */
function formatTimestamp(date: Date): string {
  const pad = (n: number) => n.toString().padStart(2, '0');
  const yyyy = date.getFullYear();
  const MM = pad(date.getMonth() + 1);
  const dd = pad(date.getDate());
  const HH = pad(date.getHours());
  const mm = pad(date.getMinutes());
  const ss = pad(date.getSeconds());
  return `${yyyy}${MM}${dd}-${HH}${mm}${ss}`;
}

export async function writePastedImage(
  agentName: string,
  index: number,
  data: ArrayBuffer,
  imageId?: string,
): Promise<string> {
  validateImageBuffer(data, imageId);

  const dir = await getPastedImagesDir();
  const timestamp = formatTimestamp(new Date());
  const filename = `${agentName}-${timestamp}-${index}.png`;
  const filepath = path.join(dir, filename);

  try {
    const buffer = Buffer.from(data);
    const image = nativeImage.createFromBuffer(buffer);
    validateImageDimensions(image, imageId);

    const png = image.toPNG();
    if (!png || png.length === 0) {
      throw new ImagePasteError(
        'PNG_CONVERSION_FAILED',
        `PNG conversion failed for pasted image ${index}`,
        imageId,
      );
    }

    await fsp.writeFile(filepath, png, { mode: 0o600 });
    return filepath;
  } catch (err) {
    if (err instanceof ImagePasteError) {
      throw err;
    }
    throw new ImagePasteError(
      'TEMP_WRITE_FAILED',
      err instanceof Error ? err.message : `Failed to write pasted image ${index}`,
      imageId,
    );
  }
}

/**
 * Write all staged image bytes to temp PNG files.
 */
export async function writePastedImages(
  agentName: string,
  images: Array<{ id: string; data: ArrayBuffer }>,
): Promise<string[]> {
  const paths: string[] = [];
  for (let i = 0; i < images.length; i++) {
    const filepath = await writePastedImage(agentName, i, images[i].data, images[i].id);
    paths.push(filepath);
  }
  return paths;
}

/**
 * Delete pasted-image temp files older than the configured max age.
 * Called on app start and on terminal session reset.
 */
export async function cleanupOldPastedImages(maxAgeMs = PASTED_IMAGE_MAX_AGE_MS): Promise<void> {
  const dir = path.join(app.getPath('temp'), app.getName(), PASTED_IMAGES_DIR);
  try {
    await fsp.access(dir);
  } catch {
    return;
  }

  const now = Date.now();
  let entries: string[];
  try {
    entries = await fsp.readdir(dir);
  } catch (err) {
    console.warn(`[imagePaste] Failed to read temp dir ${dir}:`, err);
    return;
  }

  await Promise.all(
    entries.map(async (entry) => {
      const filepath = path.join(dir, entry);
      try {
        const stats = await fsp.stat(filepath);
        if (now - stats.mtimeMs > maxAgeMs) {
          await fsp.unlink(filepath);
        }
      } catch (err) {
        console.warn(`[imagePaste] Failed to clean up ${filepath}:`, err);
      }
    }),
  );
}
