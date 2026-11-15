// A minimal PNG reader for the images GRIB2 files embed (data representation template 5.41).
// Handles non-interlaced images at 8 or 16 bits per channel, which is what MRMS uses.

import { inflateSync } from "node:zlib";

export interface PngPixels {
  width: number;
  height: number;
  /** Bytes per pixel (all channels together). */
  bytesPerPixel: number;
  /** Unfiltered pixel rows, each `width * bytesPerPixel` long, back to back. */
  data: Uint8Array;
}

const SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const CHANNELS: Record<number, number> = { 0: 1, 2: 3, 4: 2, 6: 4 };

export function decodePng(bytes: Uint8Array): PngPixels {
  for (let i = 0; i < SIGNATURE.length; i++) {
    if (bytes[i] !== SIGNATURE[i]) throw new Error("Not a PNG image");
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let offset = 8;
  let width = 0;
  let height = 0;
  let bitDepth = 0;
  let colorType = -1;
  let interlace = 0;
  const idat: Uint8Array[] = [];

  while (offset + 8 <= bytes.length) {
    const length = view.getUint32(offset);
    const type = String.fromCharCode(...bytes.subarray(offset + 4, offset + 8));
    const body = bytes.subarray(offset + 8, offset + 8 + length);
    if (type === "IHDR") {
      const header = new DataView(body.buffer, body.byteOffset, body.byteLength);
      width = header.getUint32(0);
      height = header.getUint32(4);
      bitDepth = body[8]!;
      colorType = body[9]!;
      interlace = body[12]!;
    } else if (type === "IDAT") {
      idat.push(body);
    } else if (type === "IEND") {
      break;
    }
    offset += 12 + length;
  }

  const channels = CHANNELS[colorType];
  if (!width || !height || channels === undefined) throw new Error(`Unsupported PNG (color type ${colorType})`);
  if (bitDepth !== 8 && bitDepth !== 16) throw new Error(`Unsupported PNG bit depth ${bitDepth}`);
  if (interlace !== 0) throw new Error("Interlaced PNG images aren't supported");

  const bytesPerPixel = (channels * bitDepth) / 8;
  const stride = width * bytesPerPixel;
  const raw = inflateSync(Buffer.concat(idat));
  if (raw.length < height * (stride + 1)) throw new Error("PNG image data is shorter than its size says");

  const data = new Uint8Array(height * stride);
  for (let row = 0; row < height; row++) {
    const filter = raw[row * (stride + 1)]!;
    const source = row * (stride + 1) + 1;
    const target = row * stride;
    const previous = target - stride;
    for (let x = 0; x < stride; x++) {
      const value = raw[source + x]!;
      const left = x >= bytesPerPixel ? data[target + x - bytesPerPixel]! : 0;
      const up = row > 0 ? data[previous + x]! : 0;
      const upLeft = row > 0 && x >= bytesPerPixel ? data[previous + x - bytesPerPixel]! : 0;
      let predicted: number;
      switch (filter) {
        case 0:
          predicted = 0;
          break;
        case 1:
          predicted = left;
          break;
        case 2:
          predicted = up;
          break;
        case 3:
          predicted = (left + up) >> 1;
          break;
        case 4: {
          const p = left + up - upLeft;
          const pa = Math.abs(p - left);
          const pb = Math.abs(p - up);
          const pc = Math.abs(p - upLeft);
          predicted = pa <= pb && pa <= pc ? left : pb <= pc ? up : upLeft;
          break;
        }
        default:
          throw new Error(`Unknown PNG filter ${filter}`);
      }
      data[target + x] = (value + predicted) & 0xff;
    }
  }
  return { width, height, bytesPerPixel, data };
}
