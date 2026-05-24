import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { handleUpload } from "../src/upload/handler";
import { signUploadToken } from "../src/upload/tokens";

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x01]);
const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46]);
const TEXT = new Uint8Array([0x68, 0x69]); // "hi"

async function reset() {
  const list = await env.VAULT.list();
  if (list.objects.length) await env.VAULT.delete(list.objects.map((o) => o.key));
}

function uploadReq(
  bytes: Uint8Array,
  filename: string,
  opts: { bearer?: string; t?: string; target_note?: string; fileType?: string } = {},
): Request {
  const fd = new FormData();
  fd.append("file", new File([bytes], filename, { type: opts.fileType ?? "application/octet-stream" }), filename);
  if (opts.t) fd.append("t", opts.t);
  if (opts.target_note) fd.append("target_note", opts.target_note);
  const headers: Record<string, string> = {};
  if (opts.bearer) headers["Authorization"] = "Bearer " + opts.bearer;
  return new Request("https://vault.example.test/upload", { method: "POST", headers, body: fd });
}

describe("handleUpload", () => {
  beforeEach(reset);

  it("returns null for non-/upload paths", async () => {
    const r = await handleUpload(new Request("https://x/authorize"), env);
    expect(r).toBeNull();
  });

  it("serves the upload page on GET", async () => {
    const r = await handleUpload(new Request("https://x/upload"), env);
    expect(r).not.toBeNull();
    expect(r!.status).toBe(200);
    expect(r!.headers.get("content-type")).toContain("text/html");
    expect(await r!.text()).toContain("Upload to vault");
  });

  it("rejects a POST with no credentials", async () => {
    const r = await handleUpload(uploadReq(PNG, "a.png"), env);
    expect(r!.status).toBe(401);
    expect((await r!.json() as any).reason).toBe("unauthorized");
  });

  it("rejects a non-multipart POST (CSRF hardening)", async () => {
    const req = new Request("https://x/upload", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", Authorization: "Bearer " + env.UPLOAD_TOKEN },
      body: "file=x",
    });
    const r = await handleUpload(req, env);
    expect(r!.status).toBe(415);
    expect((await r!.json() as any).reason).toBe("unsupported_content_type");
  });

  it("stores a PNG with the long-lived bearer token", async () => {
    const r = await handleUpload(uploadReq(PNG, "a.png", { bearer: env.UPLOAD_TOKEN, fileType: "image/png" }), env);
    expect(r!.status).toBe(200);
    const body = (await r!.json()) as any;
    expect(body.ok).toBe(true);
    expect(body.files[0].path).toBe("files/a.png");
    expect(body.files[0].content_type).toBe("image/png");
    expect(await env.VAULT.get("files/a.png")).not.toBeNull();
  });

  it("corrects a JPEG mislabeled as .png (folder mode)", async () => {
    const r = await handleUpload(uploadReq(JPEG, "shot.png", { bearer: env.UPLOAD_TOKEN }), env);
    const body = (await r!.json()) as any;
    expect(body.ok).toBe(true);
    expect(body.files[0].path).toBe("files/shot.jpg");
    expect(body.files[0].content_type).toBe("image/jpeg");
  });

  it("rejects a non-image claiming an image extension", async () => {
    const r = await handleUpload(uploadReq(TEXT, "evil.png", { bearer: env.UPLOAD_TOKEN }), env);
    expect(r!.status).toBe(415);
    expect((await r!.json() as any).reason).toBe("content_mismatch");
  });

  it("rejects a bad bearer token", async () => {
    const r = await handleUpload(uploadReq(PNG, "a.png", { bearer: "wrong" }), env);
    expect(r!.status).toBe(401);
  });

  it("accepts a signed link token, scopes the folder, and is single-use", async () => {
    const { token } = await signUploadToken(env, { target_note: "Projects/Plan.md" });
    const r1 = await handleUpload(uploadReq(PNG, "diagram.png", { t: token, fileType: "image/png" }), env);
    const body1 = (await r1!.json()) as any;
    expect(body1.ok).toBe(true);
    expect(body1.files[0].path).toBe("Projects/files/diagram.png"); // scoped by the token's target_note

    // Reusing the same link fails (token consumed).
    const r2 = await handleUpload(uploadReq(PNG, "diagram2.png", { t: token, fileType: "image/png" }), env);
    expect(r2!.status).toBe(401);
    expect((await r2!.json() as any).reason).toBe("token_used");
  });

  it("honors a deterministic dest_path link exactly", async () => {
    const { token } = await signUploadToken(env, { dest_path: "Inbox/receipt.png" });
    // Upload a JPEG even though the link path says .png — the exact path is honored,
    // but the stored content-type is the true (sniffed) type.
    const r = await handleUpload(uploadReq(JPEG, "whatever.jpg", { t: token }), env);
    const body = (await r!.json()) as any;
    expect(body.ok).toBe(true);
    expect(body.files[0].path).toBe("Inbox/receipt.png");
    expect(body.files[0].content_type).toBe("image/jpeg");
  });

  it("rejects multiple files on a deterministic single-file link", async () => {
    const { token } = await signUploadToken(env, { dest_path: "Inbox/one.png" });
    const fd = new FormData();
    fd.append("file", new File([PNG], "a.png", { type: "image/png" }), "a.png");
    fd.append("file", new File([PNG], "b.png", { type: "image/png" }), "b.png");
    fd.append("t", token);
    const req = new Request("https://x/upload", { method: "POST", body: fd });
    const r = await handleUpload(req, env);
    expect(r!.status).toBe(400);
    expect((await r!.json() as any).reason).toBe("single_file_link");
  });

  it("stores multiple files on a batch link", async () => {
    const { token } = await signUploadToken(env, { target_note: "Trip.md", max_files: 5 });
    const fd = new FormData();
    fd.append("file", new File([PNG], "p1.png", { type: "image/png" }), "p1.png");
    fd.append("file", new File([JPEG], "p2.jpg", { type: "image/jpeg" }), "p2.jpg");
    fd.append("t", token);
    const req = new Request("https://x/upload", { method: "POST", body: fd });
    const r = await handleUpload(req, env);
    const body = (await r!.json()) as any;
    expect(body.ok).toBe(true);
    expect(body.files.map((f: any) => f.path).sort()).toEqual(["files/p1.png", "files/p2.jpg"]);
  });

  it("does not consume the link token when the upload fails", async () => {
    const { token } = await signUploadToken(env, {});
    // First attempt fails content_mismatch (text claiming .png) — token must survive.
    const fail = await handleUpload(uploadReq(TEXT, "x.png", { t: token }), env);
    expect(fail!.status).toBe(415);
    // Retry with a real PNG using the same token succeeds.
    const ok = await handleUpload(uploadReq(PNG, "x.png", { t: token, fileType: "image/png" }), env);
    expect((await ok!.json() as any).ok).toBe(true);
  });
});
