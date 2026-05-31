import { describe, expect, it } from "vitest";
import {
  assertAllowedExtension,
  attachmentResolutionCandidates,
  buildAcceptAttribute,
  buildEmbedMarkdown,
  deriveFilenameFromUrl,
  extensionToMime,
  getExtension,
  isDisallowedAttachmentHost,
  isImageMime,
  isUnderDir,
  mimeToExtension,
  parseExtensionAllowlist,
  relativeForEmbed,
  resolveAttachmentAllowlist,
  resolveAttachmentPath,
  sanitizeFilename,
  validateAttachmentSourceUrl,
} from "../src/vault/attachments";
import { makeCfg } from "./_helpers";

describe("resolveAttachmentAllowlist", () => {
  it("uses the configured CSV when non-empty", () => {
    const allow = resolveAttachmentAllowlist("png,pptx");
    expect([...allow].sort()).toEqual(["png", "pptx"]);
  });
  it("falls back to the default allowlist when empty or whitespace", () => {
    expect(resolveAttachmentAllowlist("").has("png")).toBe(true);
    expect(resolveAttachmentAllowlist("   ").has("pdf")).toBe(true);
    // default set does not include office types
    expect(resolveAttachmentAllowlist("").has("pptx")).toBe(false);
  });
});

describe("buildAcceptAttribute", () => {
  it("emits both the dotted extension and the MIME type for known types", () => {
    const accept = buildAcceptAttribute(new Set(["pptx"]));
    expect(accept).toBe(
      ".pptx,application/vnd.openxmlformats-officedocument.presentationml.presentation",
    );
  });
  it("regression: a configured .pptx is selectable (extension + MIME present)", () => {
    // The mobile picker bug was a hardcoded accept of image/*,application/pdf
    // that omitted office types. Driving accept from the allowlist must include
    // pptx by both extension and MIME so iOS Safari and Android Chrome match.
    const accept = buildAcceptAttribute(resolveAttachmentAllowlist("png,jpg,pdf,docx,xlsx,pptx"));
    expect(accept).toContain(".pptx");
    expect(accept).toContain(
      "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    );
  });
  it("includes the dotted extension even when the MIME is unknown", () => {
    const accept = buildAcceptAttribute(new Set(["heic"]));
    expect(accept).toBe(".heic");
  });
  it("does not repeat a MIME shared by two extensions (jpg/jpeg)", () => {
    const accept = buildAcceptAttribute(new Set(["jpg", "jpeg"]));
    expect(accept).toBe(".jpg,image/jpeg,.jpeg");
  });
  it("produces an attribute-safe string (no quotes or angle brackets)", () => {
    const accept = buildAcceptAttribute(resolveAttachmentAllowlist(""));
    expect(accept).not.toMatch(/["<>]/);
  });
});

describe("extensionToMime / mimeToExtension", () => {
  it("maps known extensions", () => {
    expect(extensionToMime("png")).toBe("image/png");
    expect(extensionToMime("JPG")).toBe("image/jpeg");
    expect(extensionToMime(".pdf")).toBe("application/pdf");
  });
  it("falls back to octet-stream for unknown", () => {
    expect(extensionToMime("xyz")).toBe("application/octet-stream");
  });
  it("maps MIME back to a canonical extension", () => {
    expect(mimeToExtension("image/jpeg")).toBe("jpg");
    expect(mimeToExtension("image/png; charset=binary")).toBe("png");
    expect(mimeToExtension("application/pdf")).toBe("pdf");
    expect(mimeToExtension("application/x-unknown")).toBeNull();
  });
  it("maps zip both ways", () => {
    expect(extensionToMime("zip")).toBe("application/zip");
    expect(mimeToExtension("application/zip")).toBe("zip");
  });
});

describe("isImageMime", () => {
  it("detects image types regardless of params/case", () => {
    expect(isImageMime("image/png")).toBe(true);
    expect(isImageMime("IMAGE/JPEG; charset=x")).toBe(true);
    expect(isImageMime("application/pdf")).toBe(false);
  });
});

describe("getExtension", () => {
  it("returns the lowercased extension", () => {
    expect(getExtension("a.PNG")).toBe("png");
    expect(getExtension("dir.with.dots/file.tar.gz")).toBe("gz");
  });
  it("returns empty for no extension or leading-dot names", () => {
    expect(getExtension("README")).toBe("");
    expect(getExtension(".env")).toBe("");
  });
});

describe("parseExtensionAllowlist", () => {
  it("lowercases, trims, strips dots, drops empties", () => {
    const set = parseExtensionAllowlist(" PNG, .jpg ,, jpeg,");
    expect([...set].sort()).toEqual(["jpeg", "jpg", "png"]);
  });
});

describe("assertAllowedExtension", () => {
  const allow = parseExtensionAllowlist("png,jpg,pdf");
  it("accepts allowed extensions and returns mime", () => {
    const r = assertAllowedExtension("diagram.png", allow);
    expect(r).toEqual({ ok: true, value: { ext: "png", mime: "image/png" } });
  });
  it("rejects disallowed with the allowed list", () => {
    const r = assertAllowedExtension("evil.exe", allow);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.reason).toBe("disallowed_extension");
      expect(r.ext).toBe("exe");
      expect(r.allowed).toEqual(["jpg", "pdf", "png"]);
    }
  });
  it("rejects names with no extension", () => {
    const r = assertAllowedExtension("noext", allow);
    expect(r.ok).toBe(false);
  });
});

describe("sanitizeFilename", () => {
  it("keeps a clean filename", () => {
    expect(sanitizeFilename("diagram.png")).toEqual({ ok: true, value: "diagram.png" });
  });
  it("keeps spaces and parens (screenshot style)", () => {
    expect(sanitizeFilename("Screenshot (1).png")).toEqual({
      ok: true,
      value: "Screenshot (1).png",
    });
  });
  it("drops directory components", () => {
    expect(sanitizeFilename("../../etc/passwd.png")).toEqual({ ok: true, value: "passwd.png" });
    expect(sanitizeFilename("a/b\\c.png")).toEqual({ ok: true, value: "c.png" });
  });
  it("strips leading dots", () => {
    expect(sanitizeFilename(".hidden.png")).toEqual({ ok: true, value: "hidden.png" });
  });
  it("replaces odd characters with underscore", () => {
    const r = sanitizeFilename("a*b?c.png");
    expect(r).toEqual({ ok: true, value: "a_b_c.png" });
  });
  it("rejects empty and dot-only names", () => {
    expect(sanitizeFilename("").ok).toBe(false);
    expect(sanitizeFilename("...").ok).toBe(false);
    expect(sanitizeFilename("/").ok).toBe(false);
  });
});

describe("deriveFilenameFromUrl", () => {
  it("returns the last segment when it has an extension", () => {
    expect(deriveFilenameFromUrl(new URL("https://x.test/a/b/diagram.png"))).toBe("diagram.png");
  });
  it("decodes percent-encoding", () => {
    expect(deriveFilenameFromUrl(new URL("https://x.test/my%20file.pdf"))).toBe("my file.pdf");
  });
  it("returns null with no extension or no segment", () => {
    expect(deriveFilenameFromUrl(new URL("https://x.test/page"))).toBeNull();
    expect(deriveFilenameFromUrl(new URL("https://x.test/"))).toBeNull();
  });
});

describe("resolveAttachmentPath", () => {
  it("per_note_subfolder uses the note's folder + subfolder", () => {
    const cfg = makeCfg({ attachmentsPathMode: "per_note_subfolder", attachmentsSubfolder: "files" });
    const r = resolveAttachmentPath(cfg, { target_note: "Projects/Plan.md", filename: "img.png" });
    expect(r).toEqual({ ok: true, value: "Projects/files/img.png" });
  });
  it("per_note_subfolder with a root note falls back to vault-root subfolder", () => {
    const cfg = makeCfg({ attachmentsPathMode: "per_note_subfolder" });
    const r = resolveAttachmentPath(cfg, { target_note: "Note.md", filename: "img.png" });
    expect(r).toEqual({ ok: true, value: "files/img.png" });
  });
  it("vault_default is vault-rooted and ignores target_note", () => {
    const cfg = makeCfg({ attachmentsPathMode: "vault_default", attachmentsSubfolder: "_attachments" });
    const r = resolveAttachmentPath(cfg, { target_note: "Deep/Folder/Note.md", filename: "img.png" });
    expect(r).toEqual({ ok: true, value: "_attachments/img.png" });
  });
  it("caller_specified uses the caller subfolder verbatim", () => {
    const cfg = makeCfg({ attachmentsPathMode: "caller_specified", attachmentsSubfolder: "files" });
    const r = resolveAttachmentPath(cfg, { subfolder: "Media/2026", filename: "img.png" });
    expect(r).toEqual({ ok: true, value: "Media/2026/img.png" });
  });
  it("caller_specified with no subfolder lands at the vault root", () => {
    const cfg = makeCfg({ attachmentsPathMode: "caller_specified" });
    const r = resolveAttachmentPath(cfg, { filename: "img.png" });
    expect(r).toEqual({ ok: true, value: "img.png" });
  });
  it("dest_path overrides everything", () => {
    const cfg = makeCfg();
    const r = resolveAttachmentPath(cfg, {
      target_note: "Note.md",
      filename: "ignored.png",
      dest_path: "Exact/Place/here.png",
    });
    expect(r).toEqual({ ok: true, value: "Exact/Place/here.png" });
  });
  it("rejects a traversal dest_path", () => {
    const cfg = makeCfg();
    const r = resolveAttachmentPath(cfg, { filename: "x.png", dest_path: "../escape.png" });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("invalid_path");
  });
  it("propagates a bad filename", () => {
    const cfg = makeCfg();
    const r = resolveAttachmentPath(cfg, { target_note: "Note.md", filename: "..." });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("invalid_filename");
  });
});

describe("buildEmbedMarkdown", () => {
  it("wikilink uses the path relative to the note's folder when nested", () => {
    expect(buildEmbedMarkdown("Projects/files/img.png", "Projects/Plan.md", "wikilink")).toBe(
      "![[files/img.png]]",
    );
  });
  it("wikilink uses the full vault path when the note is at the root", () => {
    expect(buildEmbedMarkdown("files/img.png", "Note.md", "wikilink")).toBe("![[files/img.png]]");
  });
  it("wikilink uses the full path when the attachment is outside the note folder", () => {
    expect(buildEmbedMarkdown("Media/img.png", "Projects/Plan.md", "wikilink")).toBe(
      "![[Media/img.png]]",
    );
  });
  it("markdown style emits alt text and URL-encoded href", () => {
    expect(buildEmbedMarkdown("files/my pic.png", "Note.md", "markdown")).toBe(
      "![my pic](files/my%20pic.png)",
    );
  });
  it("uses the full path when fromNotePath is null", () => {
    expect(buildEmbedMarkdown("Projects/files/img.png", null, "wikilink")).toBe(
      "![[Projects/files/img.png]]",
    );
  });
});

describe("isUnderDir", () => {
  it("treats the vault root as containing everything", () => {
    expect(isUnderDir("files/a.png", "")).toBe(true);
  });
  it("matches nested paths only", () => {
    expect(isUnderDir("Projects/files/a.png", "Projects")).toBe(true);
    expect(isUnderDir("Other/a.png", "Projects")).toBe(false);
    expect(isUnderDir("ProjectsX/a.png", "Projects")).toBe(false);
  });
});

describe("relativeForEmbed", () => {
  it("shortens a nested attachment to the note-relative form", () => {
    expect(relativeForEmbed("Projects/files/a.png", "Projects/Plan.md")).toBe("files/a.png");
  });
  it("keeps the full path when outside the note folder", () => {
    expect(relativeForEmbed("Media/a.png", "Projects/Plan.md")).toBe("Media/a.png");
  });
});

describe("attachmentResolutionCandidates", () => {
  it("for a slashed target tries note-relative then vault-rooted", () => {
    expect(attachmentResolutionCandidates("files/a.png", "Projects", "files")).toEqual([
      "Projects/files/a.png",
      "files/a.png",
    ]);
  });
  it("for a bare basename tries subfolder, note folder, then root", () => {
    expect(attachmentResolutionCandidates("a.png", "Projects", "files")).toEqual([
      "Projects/files/a.png",
      "Projects/a.png",
      "a.png",
    ]);
  });
  it("drops traversal candidates", () => {
    expect(attachmentResolutionCandidates("../a.png", "Projects", "files")).toEqual([]);
  });
});

describe("isDisallowedAttachmentHost", () => {
  it("blocks loopback and special suffixes", () => {
    for (const h of ["localhost", "foo.localhost", "db.internal", "printer.local"]) {
      expect(isDisallowedAttachmentHost(h)).toBe(true);
    }
  });
  it("blocks IP literals (v4 dotted, integer, hex, v6)", () => {
    for (const h of ["10.0.0.1", "127.0.0.1", "2130706433", "0x7f000001", "[::1]", "fe80::1"]) {
      expect(isDisallowedAttachmentHost(h)).toBe(true);
    }
  });
  it("allows normal hostnames", () => {
    for (const h of ["example.com", "cdn.example.com", "o.dszp.app"]) {
      expect(isDisallowedAttachmentHost(h)).toBe(false);
    }
  });
});

describe("validateAttachmentSourceUrl", () => {
  const allow = (...hosts: string[]) => new Set(hosts);
  it("accepts an https URL whose host is in the allowlist", () => {
    const r = validateAttachmentSourceUrl("https://cdn.example.com/a.png", allow("cdn.example.com"));
    expect(r.ok).toBe(true);
  });
  it("rejects a host that is not in the allowlist", () => {
    const r = validateAttachmentSourceUrl("https://evil.example.com/a.png", allow("cdn.example.com"));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("host_not_allowed");
  });
  it("denies every host when the allowlist is empty (default-closed)", () => {
    const r = validateAttachmentSourceUrl("https://cdn.example.com/a.png", allow());
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("host_not_allowed");
  });
  it("matches allowlist hosts case-insensitively", () => {
    const r = validateAttachmentSourceUrl("https://CDN.Example.com/a.png", allow("cdn.example.com"));
    expect(r.ok).toBe(true);
  });
  it("rejects non-https before any host check", () => {
    const r = validateAttachmentSourceUrl("http://cdn.example.com/a.png", allow("cdn.example.com"));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("insecure_url");
  });
  it("denylist (SSRF) wins over allowlist for IP literals", () => {
    const r = validateAttachmentSourceUrl("https://10.0.0.1/a.png", allow("10.0.0.1"));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("disallowed_host");
  });
  it("rejects unparseable URLs", () => {
    const r = validateAttachmentSourceUrl("not a url", allow("cdn.example.com"));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("invalid_url");
  });
  it("'*' allows any (non-denylisted) host", () => {
    expect(validateAttachmentSourceUrl("https://anything.example.com/a.png", allow("*")).ok).toBe(true);
    expect(validateAttachmentSourceUrl("https://some-other-host.test/x.pdf", allow("*")).ok).toBe(true);
  });
  it("'*' still rejects non-https (allow-all is not a protocol bypass)", () => {
    const r = validateAttachmentSourceUrl("http://anything.example.com/a.png", allow("*"));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("insecure_url");
  });
  it("'*' still rejects IP-literal / loopback hosts (SSRF denylist wins over allow-all)", () => {
    expect(validateAttachmentSourceUrl("https://10.0.0.1/a.png", allow("*")).ok).toBe(false);
    const r = validateAttachmentSourceUrl("https://localhost/a.png", allow("*"));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("disallowed_host");
  });
});
