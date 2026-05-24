import { describe, expect, it } from "vitest";
import { reconcileUploadType, sniffMime } from "../src/upload/sniff";
import { parseExtensionAllowlist } from "../src/vault/attachments";

const allow = parseExtensionAllowlist("png,jpg,jpeg,gif,webp,svg,pdf");

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00]);
const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]);
const GIF = new Uint8Array([0x47, 0x49, 0x46, 0x38, 0x39, 0x61]);
const WEBP = new Uint8Array([
  0x52, 0x49, 0x46, 0x46, 0x00, 0x00, 0x00, 0x00, 0x57, 0x45, 0x42, 0x50,
]);
const PDF = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x34]);
const TEXT = new Uint8Array([0x68, 0x65, 0x6c, 0x6c, 0x6f]); // "hello"

describe("sniffMime", () => {
  it("detects supported magic numbers", () => {
    expect(sniffMime(PNG)).toBe("image/png");
    expect(sniffMime(JPEG)).toBe("image/jpeg");
    expect(sniffMime(GIF)).toBe("image/gif");
    expect(sniffMime(WEBP)).toBe("image/webp");
    expect(sniffMime(PDF)).toBe("application/pdf");
  });
  it("returns null for unrecognized or short input", () => {
    expect(sniffMime(TEXT)).toBeNull();
    expect(sniffMime(new Uint8Array([0xff]))).toBeNull();
    expect(sniffMime(new Uint8Array([0x52, 0x49, 0x46, 0x46]))).toBeNull(); // RIFF but no WEBP
  });
});

describe("reconcileUploadType", () => {
  it("keeps a correctly-named file", () => {
    const r = reconcileUploadType("a.png", PNG, allow);
    expect(r).toEqual({ ok: true, value: { filename: "a.png", mime: "image/png", ext: "png" } });
  });
  it("treats .jpeg as matching JPEG bytes (no rename)", () => {
    const r = reconcileUploadType("photo.jpeg", JPEG, allow);
    expect(r.ok && r.value.filename).toBe("photo.jpeg");
    expect(r.ok && r.value.mime).toBe("image/jpeg");
  });
  it("corrects a JPEG mislabeled as .png to .jpg", () => {
    const r = reconcileUploadType("mislabeled.png", JPEG, allow);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.filename).toBe("mislabeled.jpg");
      expect(r.value.mime).toBe("image/jpeg");
      expect(r.value.ext).toBe("jpg");
    }
  });
  it("rejects a non-image claiming a sniffable image extension (exe-as-png)", () => {
    const r = reconcileUploadType("evil.png", TEXT, allow);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("content_mismatch");
  });
  it("trusts a non-sniffable allowed extension (svg)", () => {
    const svg = new Uint8Array([0x3c, 0x73, 0x76, 0x67]); // "<svg"
    const r = reconcileUploadType("icon.svg", svg, allow);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.mime).toBe("image/svg+xml");
      expect(r.value.ext).toBe("svg");
    }
  });
  it("rejects a sniffed type not in the allowlist", () => {
    const narrow = parseExtensionAllowlist("png");
    const r = reconcileUploadType("photo.png", JPEG, narrow); // bytes are jpeg, jpg not allowed
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("disallowed_extension");
  });
  it("rejects an unrecognized, non-allowlisted extension", () => {
    const r = reconcileUploadType("data.bin", TEXT, allow);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("disallowed_extension");
  });
});
