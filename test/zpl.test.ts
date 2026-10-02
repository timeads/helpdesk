import { describe, expect, it } from "vitest";
// @ts-expect-error plain browser JS module
import { bitsToGfa, compressRow, expandRows } from "../public/js/zpl.js";

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
