import { useState, useCallback, useRef, useEffect } from 'react';

export interface StagedImage {
  id: string;
  name: string;
  type: string;
  size: number;
  width: number;
  height: number;
  data: ArrayBuffer;
  previewUrl: string;
}

interface UseTerminalImagesOptions {
  maxImages?: number;
  maxFileSizeBytes?: number;
  maxDimension?: number;
}

interface UseTerminalImagesResult {
  images: StagedImage[];
  error: string | null;
  addImageFromFile: (file: File) => Promise<void>;
  removeImage: (id: string) => void;
  clearImages: () => void;
  clearError: () => void;
}

const DEFAULT_MAX_IMAGES = 5;
const DEFAULT_MAX_FILE_SIZE = 10 * 1024 * 1024; // 10 MB
const DEFAULT_MAX_DIMENSION = 4096;
const SUPPORTED_IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif']);

function generateId(): string {
  // UUID v4 — 128 bits with version 4 bits set.
  const bytes = new Uint8Array(16);
  if (typeof crypto !== 'undefined' && crypto.getRandomValues) {
    crypto.getRandomValues(bytes);
  } else {
    for (let i = 0; i < bytes.length; i++) {
      bytes[i] = Math.floor(Math.random() * 256);
    }
  }
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function readFileAsArrayBuffer(file: File): Promise<ArrayBuffer> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as ArrayBuffer);
    reader.onerror = () => reject(new Error(`Failed to read ${file.name}`));
    reader.readAsArrayBuffer(file);
  });
}

function readFileBytes(file: File): Promise<Uint8Array> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(new Uint8Array(reader.result as ArrayBuffer));
    reader.onerror = () => reject(new Error(`Failed to read ${file.name}`));
    reader.readAsArrayBuffer(file);
  });
}

function parsePngDimensions(bytes: Uint8Array): { width: number; height: number } | null {
  // PNG signature: 137 80 78 71 13 10 26 10
  if (bytes.length < 24) return null;
  const isPng =
    bytes[0] === 0x89 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x4e &&
    bytes[3] === 0x47 &&
    bytes[4] === 0x0d &&
    bytes[5] === 0x0a &&
    bytes[6] === 0x1a &&
    bytes[7] === 0x0a;
  if (!isPng) return null;
  // IHDR chunk starts at offset 8; dimensions at offset 16 (big-endian).
  const width = (bytes[16] << 24) | (bytes[17] << 16) | (bytes[18] << 8) | bytes[19];
  const height = (bytes[20] << 24) | (bytes[21] << 16) | (bytes[22] << 8) | bytes[23];
  // Treat negative values (signed overflow) as invalid.
  if (width <= 0 || height <= 0) return null;
  return { width, height };
}

function getImageDimensions(file: File): Promise<{ width: number; height: number }> {
  return new Promise((resolve, reject) => {
    readFileBytes(file)
      .then((bytes) => {
        const parsed = parsePngDimensions(bytes);
        if (parsed) {
          resolve(parsed);
          return;
        }
        // Fallback for non-PNG images in a real browser.
        const url = URL.createObjectURL(file);
        const img = new Image();
        img.onload = () => {
          URL.revokeObjectURL(url);
          resolve({ width: img.naturalWidth, height: img.naturalHeight });
        };
        img.onerror = () => {
          URL.revokeObjectURL(url);
          reject(new Error(`Failed to load image dimensions for ${file.name}`));
        };
        img.src = url;
      })
      .catch((err) => reject(err));
  });
}

export function useTerminalImages(options: UseTerminalImagesOptions = {}): UseTerminalImagesResult {
  const {
    maxImages = DEFAULT_MAX_IMAGES,
    maxFileSizeBytes = DEFAULT_MAX_FILE_SIZE,
    maxDimension = DEFAULT_MAX_DIMENSION,
  } = options;

  const [images, setImages] = useState<StagedImage[]>([]);
  const [error, setError] = useState<string | null>(null);
  const previewUrlsRef = useRef<Set<string>>(new Set());

  const releasePreviewUrl = useCallback((url: string) => {
    if (previewUrlsRef.current.has(url)) {
      URL.revokeObjectURL(url);
      previewUrlsRef.current.delete(url);
    }
  }, []);

  const addImageFromFile = useCallback(
    async (file: File) => {
      setError(null);

      if (!file.type.startsWith('image/')) {
        setError('Only image files can be pasted.');
        return;
      }

      if (!SUPPORTED_IMAGE_TYPES.has(file.type)) {
        setError(`${file.type} is not supported. Use PNG, JPEG, WebP, or GIF.`);
        return;
      }

      if (images.length >= maxImages) {
        setError(`At most ${maxImages} images can be attached.`);
        return;
      }

      if (file.size > maxFileSizeBytes) {
        setError(
          `${file.name} is ${formatBytes(file.size)} — max ${formatBytes(maxFileSizeBytes)}.`,
        );
        return;
      }

      let dimensions: { width: number; height: number };
      try {
        dimensions = await getImageDimensions(file);
      } catch {
        setError(`Could not read image dimensions for ${file.name}.`);
        return;
      }

      if (dimensions.width > maxDimension || dimensions.height > maxDimension) {
        setError(
          `${file.name} is ${dimensions.width}×${dimensions.height} — max ${maxDimension}×${maxDimension}.`,
        );
        return;
      }

      try {
        const data = await readFileAsArrayBuffer(file);
        const previewUrl = URL.createObjectURL(file);
        previewUrlsRef.current.add(previewUrl);

        const staged: StagedImage = {
          id: generateId(),
          name: file.name,
          type: file.type,
          size: file.size,
          width: dimensions.width,
          height: dimensions.height,
          data,
          previewUrl,
        };

        setImages((prev) => [...prev, staged]);
      } catch {
        setError(`Failed to stage ${file.name}.`);
      }
    },
    [images.length, maxDimension, maxFileSizeBytes, maxImages],
  );

  const removeImage = useCallback(
    (id: string) => {
      setImages((prev) => {
        const image = prev.find((i) => i.id === id);
        if (image) {
          releasePreviewUrl(image.previewUrl);
        }
        return prev.filter((i) => i.id !== id);
      });
      setError(null);
    },
    [releasePreviewUrl],
  );

  const clearImages = useCallback(() => {
    images.forEach((img) => releasePreviewUrl(img.previewUrl));
    previewUrlsRef.current.clear();
    setImages([]);
    setError(null);
  }, [images, releasePreviewUrl]);

  const clearError = useCallback(() => {
    setError(null);
  }, []);

  // Revoke any lingering object URLs on unmount to avoid memory leaks.
  useEffect(() => {
    return () => {
      previewUrlsRef.current.forEach((url) => URL.revokeObjectURL(url));
      previewUrlsRef.current.clear();
    };
  }, []);

  return {
    images,
    error,
    addImageFromFile,
    removeImage,
    clearImages,
    clearError,
  };
}
