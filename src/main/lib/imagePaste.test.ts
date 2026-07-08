import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  writePastedImage,
  writePastedImages,
  cleanupOldPastedImages,
  PASTED_IMAGE_MAX_SIZE_BYTES,
  PASTED_IMAGE_MAX_DIMENSION,
  ImagePasteError,
} from './imagePaste';

const mockTempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'acp-image-paste-test-'));

let mockImageWidth = 100;
let mockImageHeight = 100;
let shouldThrowOnCreate = false;

const pngBytes = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, // PNG signature
  0x00, 0x00, 0x00, 0x0d, // IHDR length
  0x49, 0x48, 0x44, 0x52, // IHDR
  0x00, 0x00, 0x00, 0x64, // width = 100
  0x00, 0x00, 0x00, 0x64, // height = 100
  0x08, 0x02, 0x00, 0x00, 0x00,
  0x90, 0x91, 0x68, 0x36, // IHDR CRC (bogus but valid-looking)
  0x00, 0x00, 0x00, 0x00, // IEND length
  0x49, 0x45, 0x4e, 0x44, // IEND
  0xae, 0x42, 0x60, 0x82, // IEND CRC
]);

vi.mock('electron', () => ({
  app: {
    getPath: (_name: string) => mockTempRoot,
    getName: () => 'acp-test',
  },
  nativeImage: {
    createFromBuffer: (buffer: Buffer) => {
      if (shouldThrowOnCreate) {
        throw new Error('bad buffer');
      }
      return {
        getSize: () => ({ width: mockImageWidth, height: mockImageHeight }),
        toPNG: () => buffer,
      };
    },
  },
}));

describe('imagePaste', () => {
  beforeEach(() => {
    mockImageWidth = 100;
    mockImageHeight = 100;
    shouldThrowOnCreate = false;
  });

  afterEach(() => {
    const dir = path.join(mockTempRoot, 'acp-test', 'pasted-images');
    if (fs.existsSync(dir)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  describe('writePastedImage', () => {
    it('writes a PNG temp file and returns the absolute path', async () => {
      const data = pngBytes.buffer.slice(pngBytes.byteOffset, pngBytes.byteOffset + pngBytes.byteLength);
      const filepath = await writePastedImage('NextPert', 0, data, 'img-1');

      expect(filepath.endsWith('.png')).toBe(true);
      expect(fs.existsSync(filepath)).toBe(true);
      expect(fs.readFileSync(filepath).toString('hex').startsWith('89504e47')).toBe(true);
      expect(path.basename(filepath)).toMatch(/^NextPert-\d{8}-\d{6}-0\.png$/);
    });

    it('rejects images larger than the max size', async () => {
      const tooBig = new ArrayBuffer(PASTED_IMAGE_MAX_SIZE_BYTES + 1);
      await expect(writePastedImage('NextPert', 0, tooBig, 'img-big')).rejects.toSatisfy(
        (err: unknown) => err instanceof ImagePasteError && err.code === 'IMAGE_TOO_LARGE',
      );
    });

    it('rejects images exceeding max dimensions', async () => {
      mockImageWidth = PASTED_IMAGE_MAX_DIMENSION + 1;
      mockImageHeight = 100;
      const data = pngBytes.buffer.slice(pngBytes.byteOffset, pngBytes.byteOffset + pngBytes.byteLength);

      await expect(writePastedImage('NextPert', 0, data, 'img-large')).rejects.toSatisfy(
        (err: unknown) => err instanceof ImagePasteError && err.code === 'IMAGE_DIMENSIONS_TOO_LARGE',
      );
    });

    it('surfaces a TEMP_WRITE_FAILED error for unexpected conversion failures', async () => {
      shouldThrowOnCreate = true;
      const data = new ArrayBuffer(8);
      await expect(writePastedImage('NextPert', 0, data, 'img-bad')).rejects.toSatisfy(
        (err: unknown) => err instanceof ImagePasteError && err.code === 'TEMP_WRITE_FAILED',
      );
    });
  });

  describe('writePastedImages', () => {
    it('writes multiple images and returns paths in order', async () => {
      const data = pngBytes.buffer.slice(pngBytes.byteOffset, pngBytes.byteOffset + pngBytes.byteLength);
      const images = [
        { id: 'a', data },
        { id: 'b', data },
      ];
      const paths = await writePastedImages('NextPert', images);

      expect(paths).toHaveLength(2);
      expect(paths[0]).not.toBe(paths[1]);
      expect(fs.existsSync(paths[0])).toBe(true);
      expect(fs.existsSync(paths[1])).toBe(true);
    });
  });

  describe('cleanupOldPastedImages', () => {
    it('removes files older than max age and keeps fresh files', async () => {
      const dir = path.join(mockTempRoot, 'acp-test', 'pasted-images');
      fs.mkdirSync(dir, { recursive: true });

      const oldFile = path.join(dir, 'old.png');
      const freshFile = path.join(dir, 'fresh.png');
      fs.writeFileSync(oldFile, pngBytes);
      fs.writeFileSync(freshFile, pngBytes);

      const now = Date.now();
      fs.utimesSync(oldFile, now / 1000 - 60 * 60 * 25, now / 1000 - 60 * 60 * 25);
      fs.utimesSync(freshFile, now / 1000, now / 1000);

      await cleanupOldPastedImages(24 * 60 * 60 * 1000);

      expect(fs.existsSync(oldFile)).toBe(false);
      expect(fs.existsSync(freshFile)).toBe(true);
    });

    it('is a no-op when the temp dir does not exist', async () => {
      await expect(cleanupOldPastedImages()).resolves.toBeUndefined();
    });
  });
});
