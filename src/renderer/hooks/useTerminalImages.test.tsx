import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import React from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { act } from 'react';

import { useTerminalImages } from './useTerminalImages';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function createPng(width: number, height: number): Uint8Array {
  // Minimal PNG: signature + IHDR + IDAT (compressed empty image) + IEND.
  const signature = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

  function uint32Be(value: number): Uint8Array {
    return new Uint8Array([
      (value >>> 24) & 0xff,
      (value >>> 16) & 0xff,
      (value >>> 8) & 0xff,
      value & 0xff,
    ]);
  }

  function chunk(type: string, data: Uint8Array): Uint8Array {
    const typeBytes = new TextEncoder().encode(type);
    const crc = new Uint8Array(4); // bogus but valid-looking for tests
    const result = new Uint8Array(4 + 4 + data.length + 4);
    result.set(uint32Be(data.length), 0);
    result.set(typeBytes, 4);
    result.set(data, 8);
    result.set(crc, 8 + data.length);
    return result;
  }

  const ihdrData = new Uint8Array(13);
  ihdrData.set(uint32Be(width), 0);
  ihdrData.set(uint32Be(height), 4);
  ihdrData[8] = 8; // bit depth
  ihdrData[9] = 6; // color type RGBA
  ihdrData[10] = 0; // compression
  ihdrData[11] = 0; // filter
  ihdrData[12] = 0; // interlace

  // Simple zlib compression of all zeros gives a short, predictable stream.
  const compressed = new Uint8Array([0x78, 0x9c, 0x63, 0x60, 0x60, 0x60, 0x00, 0x00, 0x00, 0x04, 0x00, 0x01]);
  const idat = chunk('IDAT', compressed);
  const iend = chunk('IEND', new Uint8Array(0));

  const result = new Uint8Array(signature.length + chunk('IHDR', ihdrData).length + idat.length + iend.length);
  let offset = 0;
  result.set(signature, offset);
  offset += signature.length;
  const ihdr = chunk('IHDR', ihdrData);
  result.set(ihdr, offset);
  offset += ihdr.length;
  result.set(idat, offset);
  offset += idat.length;
  result.set(iend, offset);
  return result;
}

function createImageFile(
  name = 'test.png',
  type = 'image/png',
  width = 1,
  height = 1,
): File {
  const bytes = createPng(width, height);
  return new File([bytes.buffer as ArrayBuffer], name, { type });
}

type HookResult = ReturnType<typeof useTerminalImages>;

function TestHarness({ resultRef }: { resultRef: React.MutableRefObject<HookResult | null> }) {
  const result = useTerminalImages();
  resultRef.current = result;
  return null;
}

function renderHook(): { root: Root; container: HTMLElement; resultRef: React.MutableRefObject<HookResult> } {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  const resultRef = { current: null as unknown as HookResult };
  act(() => {
    root.render(React.createElement(TestHarness, { resultRef }));
  });
  return { root, container, resultRef };
}

function cleanup(root: Root, container: HTMLElement) {
  act(() => {
    root.unmount();
  });
  document.body.removeChild(container);
}

describe('useTerminalImages', () => {
  beforeEach(() => {
    let counter = 0;
    vi.stubGlobal('crypto', {
      getRandomValues: (arr: Uint8Array) => {
        for (let i = 0; i < arr.length; i++) {
          arr[i] = (counter + i) % 256;
        }
        counter += arr.length;
        return arr;
      },
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('stages a valid image', async () => {
    const { root, container, resultRef } = renderHook();
    const file = createImageFile();

    await act(async () => {
      await resultRef.current.addImageFromFile(file);
    });

    expect(resultRef.current.images).toHaveLength(1);
    expect(resultRef.current.images[0].name).toBe('test.png');
    expect(resultRef.current.images[0].type).toBe('image/png');
    expect(resultRef.current.images[0].width).toBe(1);
    expect(resultRef.current.images[0].height).toBe(1);
    expect(resultRef.current.error).toBeNull();
    cleanup(root, container);
  });

  it('rejects non-image files', async () => {
    const { root, container, resultRef } = renderHook();
    const file = new File(['text'], 'notes.txt', { type: 'text/plain' });

    await act(async () => {
      await resultRef.current.addImageFromFile(file);
    });

    expect(resultRef.current.images).toHaveLength(0);
    expect(resultRef.current.error).toBe('Only image files can be pasted.');
    cleanup(root, container);
  });

  it('rejects unsupported image formats', async () => {
    const { root, container, resultRef } = renderHook();
    const file = new File(['bmp'], 'scan.bmp', { type: 'image/bmp' });

    await act(async () => {
      await resultRef.current.addImageFromFile(file);
    });

    expect(resultRef.current.images).toHaveLength(0);
    expect(resultRef.current.error).toContain('image/bmp is not supported');
    cleanup(root, container);
  });

  it('rejects images larger than the max file size', async () => {
    const { root, container, resultRef } = renderHook();
    const file = new File(['x'], 'huge.png', { type: 'image/png' });
    Object.defineProperty(file, 'size', { value: 11 * 1024 * 1024 });

    await act(async () => {
      await resultRef.current.addImageFromFile(file);
    });

    expect(resultRef.current.images).toHaveLength(0);
    expect(resultRef.current.error).toContain('max 10.0 MB');
    cleanup(root, container);
  });

  it('rejects images exceeding max dimensions', async () => {
    const { root, container, resultRef } = renderHook();
    const file = createImageFile('big.png', 'image/png', 4097, 100);

    await act(async () => {
      await resultRef.current.addImageFromFile(file);
    });

    expect(resultRef.current.images).toHaveLength(0);
    expect(resultRef.current.error).toContain('4097×100');
    expect(resultRef.current.error).toContain('max 4096×4096');
    cleanup(root, container);
  });

  it('allows up to the max image count and refuses additional images', async () => {
    const { root, container, resultRef } = renderHook();

    for (let i = 0; i < 5; i++) {
      await act(async () => {
        await resultRef.current.addImageFromFile(createImageFile(`img${i}.png`));
      });
    }

    expect(resultRef.current.images).toHaveLength(5);
    expect(resultRef.current.error).toBeNull();

    await act(async () => {
      await resultRef.current.addImageFromFile(createImageFile('extra.png'));
    });

    expect(resultRef.current.images).toHaveLength(5);
    expect(resultRef.current.error).toBe('At most 5 images can be attached.');
    cleanup(root, container);
  });

  it('removes a staged image', async () => {
    const { root, container, resultRef } = renderHook();
    const file = createImageFile();

    await act(async () => {
      await resultRef.current.addImageFromFile(file);
    });

    const id = resultRef.current.images[0].id;
    act(() => {
      resultRef.current.removeImage(id);
    });

    expect(resultRef.current.images).toHaveLength(0);
    cleanup(root, container);
  });

  it('clears all staged images', async () => {
    const { root, container, resultRef } = renderHook();

    await act(async () => {
      await resultRef.current.addImageFromFile(createImageFile('a.png'));
      await resultRef.current.addImageFromFile(createImageFile('b.png'));
    });

    expect(resultRef.current.images).toHaveLength(2);

    act(() => {
      resultRef.current.clearImages();
    });

    expect(resultRef.current.images).toHaveLength(0);
    cleanup(root, container);
  });

  it('creates two independent previews when the same image is pasted twice', async () => {
    const { root, container, resultRef } = renderHook();
    const file = createImageFile();

    await act(async () => {
      await resultRef.current.addImageFromFile(file);
      await resultRef.current.addImageFromFile(file);
    });

    expect(resultRef.current.images).toHaveLength(2);
    expect(resultRef.current.images[0].id).not.toBe(resultRef.current.images[1].id);
    cleanup(root, container);
  });

  it('revokes object URLs on unmount', async () => {
    const revokeSpy = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
    const { root, container, resultRef } = renderHook();

    await act(async () => {
      await resultRef.current.addImageFromFile(createImageFile());
    });

    const previewUrl = resultRef.current.images[0].previewUrl;
    cleanup(root, container);

    expect(revokeSpy).toHaveBeenCalledWith(previewUrl);
    revokeSpy.mockRestore();
  });

  it('accepts PNG, JPEG, WebP, and GIF MIME types', async () => {
    const { root, container, resultRef } = renderHook();

    for (const type of ['image/png', 'image/jpeg', 'image/webp', 'image/gif']) {
      await act(async () => {
        await resultRef.current.addImageFromFile(createImageFile('file', type));
      });
    }

    expect(resultRef.current.images).toHaveLength(4);
    expect(resultRef.current.error).toBeNull();
    cleanup(root, container);
  });
});
