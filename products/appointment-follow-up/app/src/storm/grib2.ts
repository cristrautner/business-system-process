// Reads NOAA MRMS hail grids (MESH) from GRIB2 files. Supports what MRMS publishes:
// a regular latitude-longitude grid (template 3.0) with PNG-packed values (template 5.41).

import { decodePng } from "./png.ts";

export interface HailGrid {
  /** Largest hail estimate, in millimeters, within one grid cell of the point. 0 when there's none. */
  maxNear(lat: number, lon: number): number;
}

export class Grib2Grid implements HailGrid {
  readonly ni: number;
  readonly nj: number;
  readonly lat1: number;
  readonly lon1: number;
  readonly di: number;
  readonly dj: number;
  private readonly jPositive: boolean;
  private readonly pixels: Uint8Array;
  private readonly bytesPerPixel: number;
  private readonly reference: number;
  private readonly binaryScale: number;
  private readonly decimalScale: number;

  constructor(fields: {
    ni: number;
    nj: number;
    lat1: number;
    lon1: number;
    di: number;
    dj: number;
    jPositive: boolean;
    pixels: Uint8Array;
    bytesPerPixel: number;
    reference: number;
    binaryScale: number;
    decimalScale: number;
  }) {
    this.ni = fields.ni;
    this.nj = fields.nj;
    this.lat1 = fields.lat1;
    this.lon1 = fields.lon1;
    this.di = fields.di;
    this.dj = fields.dj;
    this.jPositive = fields.jPositive;
    this.pixels = fields.pixels;
    this.bytesPerPixel = fields.bytesPerPixel;
    this.reference = fields.reference;
    this.binaryScale = fields.binaryScale;
    this.decimalScale = fields.decimalScale;
  }

  /** The value of one cell, in the file's units (millimeters for MESH). */
  valueAt(i: number, j: number): number {
    let packed = 0;
    const start = (j * this.ni + i) * this.bytesPerPixel;
    for (let b = 0; b < this.bytesPerPixel; b++) packed = packed * 256 + this.pixels[start + b]!;
    return ((this.reference + packed * 2 ** this.binaryScale) / 10 ** this.decimalScale);
  }

  /** Grid indexes nearest to a point, or null when it's outside the grid. */
  cellFor(lat: number, lon: number): { i: number; j: number } | null {
    const lon360 = ((lon % 360) + 360) % 360;
    const i = Math.round((lon360 - this.lon1) / this.di);
    const j = Math.round((this.jPositive ? lat - this.lat1 : this.lat1 - lat) / this.dj);
    if (i < 0 || j < 0 || i >= this.ni || j >= this.nj) return null;
    return { i, j };
  }

  maxNear(lat: number, lon: number): number {
    const cell = this.cellFor(lat, lon);
    if (!cell) return 0;
    let max = 0;
    for (let dj = -1; dj <= 1; dj++) {
      for (let di = -1; di <= 1; di++) {
        const i = cell.i + di;
        const j = cell.j + dj;
        if (i < 0 || j < 0 || i >= this.ni || j >= this.nj) continue;
        max = Math.max(max, this.valueAt(i, j));
      }
    }
    return max;
  }

  /** The largest value anywhere in the grid. */
  max(): number {
    let max = 0;
    for (let j = 0; j < this.nj; j++) for (let i = 0; i < this.ni; i++) max = Math.max(max, this.valueAt(i, j));
    return max;
  }
}

/** GRIB2 stores signed integers as sign and magnitude, not two's complement. */
function signed(view: DataView, offset: number, bytes: 2 | 4): number {
  const raw = bytes === 2 ? view.getUint16(offset) : view.getUint32(offset);
  const signBit = bytes === 2 ? 0x8000 : 0x80000000;
  return raw & signBit ? -(raw - signBit) : raw;
}

export function parseGrib2(bytes: Uint8Array): Grib2Grid {
  if (String.fromCharCode(...bytes.subarray(0, 4)) !== "GRIB") throw new Error("Not a GRIB file");
  if (bytes[7] !== 2) throw new Error(`Only GRIB edition 2 is supported, got ${bytes[7]}`);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

  let grid: { ni: number; nj: number; lat1: number; lon1: number; di: number; dj: number; jPositive: boolean } | null = null;
  let packing: { reference: number; binaryScale: number; decimalScale: number } | null = null;
  let png: Uint8Array | null = null;

  let offset = 16;
  while (offset + 4 <= bytes.length) {
    if (String.fromCharCode(...bytes.subarray(offset, offset + 4)) === "7777") break;
    const length = view.getUint32(offset);
    const section = bytes[offset + 4];
    // Offsets below are the GRIB2 octet numbers minus one, relative to the section start.
    if (section === 3) {
      const template = view.getUint16(offset + 12);
      if (template !== 0) throw new Error(`Unsupported grid template 3.${template}`);
      // Angles are in millionths of a degree unless the file names its own unit (MRMS says 1 / 1,000,000).
      const basicAngle = view.getUint32(offset + 38);
      const subdivisions = view.getUint32(offset + 42);
      const unit = basicAngle !== 0 && basicAngle !== 0xffffffff && subdivisions !== 0 && subdivisions !== 0xffffffff
        ? basicAngle / subdivisions
        : 1e-6;
      const scanning = bytes[offset + 71]!;
      if ((scanning & 0xa0) !== 0) throw new Error(`Unsupported scanning mode ${scanning}`);
      grid = {
        ni: view.getUint32(offset + 30),
        nj: view.getUint32(offset + 34),
        lat1: signed(view, offset + 46, 4) * unit,
        lon1: signed(view, offset + 50, 4) * unit,
        di: view.getUint32(offset + 63) * unit,
        dj: view.getUint32(offset + 67) * unit,
        jPositive: (scanning & 0x40) !== 0,
      };
    } else if (section === 5) {
      const template = view.getUint16(offset + 9);
      if (template !== 41) throw new Error(`Unsupported data packing 5.${template} (expected PNG, 5.41)`);
      packing = {
        reference: view.getFloat32(offset + 11),
        binaryScale: signed(view, offset + 15, 2),
        decimalScale: signed(view, offset + 17, 2),
      };
    } else if (section === 6) {
      if (bytes[offset + 5] !== 255) throw new Error("GRIB bitmaps aren't supported");
    } else if (section === 7) {
      png = bytes.subarray(offset + 5, offset + length);
      break;
    }
    offset += length;
  }

  if (!grid || !packing || !png) throw new Error("GRIB file is missing its grid, packing or data section");
  const pixels = decodePng(png);
  if (pixels.width * pixels.height !== grid.ni * grid.nj) throw new Error("GRIB data size doesn't match its grid");
  return new Grib2Grid({ ...grid, ...packing, pixels: pixels.data, bytesPerPixel: pixels.bytesPerPixel });
}
