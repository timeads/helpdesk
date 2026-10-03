import { describe, expect, it } from "vitest";
import { sniffImageType } from "../src/lib/util";

const b64 = (bytes: number[]) => btoa(String.fromCharCode(...bytes, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0));
describe("image type from the bytes", () => {
  it("recognises JPEG, PNG, GIF and WebP whatever the file was labelled", () => {
    expect(sniffImageType(b64([0xff, 0xd8, 0xff, 0xe0]))).toBe("image/jpeg");
    expect(sniffImageType(b64([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a]))).toBe("image/png");
    expect(sniffImageType(btoa("GIF89a......"))).toBe("image/gif");
    expect(sniffImageType(btoa("RIFF\0\0\0\0WEBPVP8 "))).toBe("image/webp");
    expect(sniffImageType(btoa("%PDF-1.7 hello"))).toBeNull();
    expect(sniffImageType(b64([0xff, 0xd8, 0xff]).replace(/\+/g, "-").replace(/\//g, "_"))).toBe("image/jpeg"); // Gmail's url-safe base64
  });
});
