import { describe, expect, it } from "vitest";
// @ts-expect-error plain browser JS module
import { bitsToGfa, bitsToGfaZ64, compressRow, contentBox, crc16, expandRows } from "../public/js/zpl.js";
// @ts-expect-error Node built-in (the app is typed for Workers)
import { inflateSync } from "node:zlib";

describe("ZPL graphic encoding", () => {
  it("uses ZPL's run-length letters, trailing-zero commas and repeat colons", () => {
    expect(compressRow("FFFF0000", null)).toBe("JF,"); // J = 4
    expect(compressRow("00000000", null)).toBe(",");
    expect(compressRow("AB", null)).toBe("AB");
    expect(compressRow("FFFF0000", "FFFF0000")).toBe(":");
    expect(compressRow("F".repeat(45), null)).toBe("hKF"); // 40 + 5
  });

  it("round-trips a picture exactly", () => {
    const w = 100, h = 60;
    const bits = new Uint8Array(w * h);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) bits[y * w + x] = (x * 7 + y * 3) % 11 < 4 || (y > 20 && y < 30) ? 1 : 0;
    const gfa: string = bitsToGfa(bits, w, h);
    const m = /^\^FO0,0\^GFA,(\d+),(\d+),(\d+),(.*)\^FS$/.exec(gfa)!;
    const bytesPerRow = Number(m[3]);
    expect(bytesPerRow).toBe(13);
    expect(Number(m[1])).toBe(13 * h);
    const rows: string[] = expandRows(m[4], bytesPerRow);
    expect(rows).toHaveLength(h);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const byte = parseInt(rows[y].slice(Math.floor(x / 8) * 2, Math.floor(x / 8) * 2 + 2), 16);
        expect((byte >> (7 - (x % 8))) & 1).toBe(bits[y * w + x]);
      }
    }
    expect(m[4].length).toBeLessThan(13 * 2 * h); // actually compressed
  });
});

describe("Z64 graphics", () => {
  it("uses the CRC-16/XMODEM check ZPL expects", () => {
    expect(crc16("123456789")).toBe("31C3"); // the standard check value
  });
  it("compresses to zlib + base64 that inflates back to the same pixels, much smaller", async () => {
    const w = 812, h = 600;
    const bits = new Uint8Array(w * h);
    for (let y = 100; y < 140; y++) for (let x = 50; x < 700; x++) bits[y * w + x] = (x >> 2) % 3 === 0 ? 1 : 0;
    const gfa: string = await bitsToGfaZ64(bits, w, h);
    const m = /^\^FO0,0\^GFA,(\d+),(\d+),(\d+),:Z64:([A-Za-z0-9+/=]+):([0-9A-F]{4})\^FS$/.exec(gfa)!;
    expect(m).toBeTruthy();
    expect(crc16(m[4])).toBe(m[5]);
    const raw = inflateSync(Buffer.from(m[4], "base64"));
    const bpr = Number(m[3]);
    expect(raw.length).toBe(Number(m[1]));
    for (let y = 0; y < h; y += 7) for (let x = 0; x < w; x += 3) expect((raw[y * bpr + (x >> 3)] >> (7 - (x & 7))) & 1).toBe(bits[y * w + x]);
    expect(gfa.length).toBeLessThan(bitsToGfa(bits, w, h).length);
  });
});

describe("contentBox (cropping PDF labels to what's printed)", () => {
  const rgba = (w: number, h: number, dark: [number, number][]) => {
    const px = new Uint8ClampedArray(w * h * 4).fill(255);
    for (const [x, y] of dark) px.fill(0, (y * w + x) * 4, (y * w + x) * 4 + 3);
    return px;
  };
  it("finds the printed area inside white margins", () => {
    expect(contentBox(rgba(10, 8, [[2, 3], [7, 5], [4, 1]]), 10, 8)).toEqual({ x0: 2, y0: 1, x1: 7, y1: 5 });
  });
  it("is null for a blank page", () => {
    expect(contentBox(rgba(4, 4, []), 4, 4)).toBeNull();
  });
});
