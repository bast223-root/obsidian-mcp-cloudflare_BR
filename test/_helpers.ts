import type { VaultConfig } from "../src/types";

// Safe defaults for VaultConfig in tests. Mirrors the wrangler-var defaults so
// tests exercise the same attachment policy the deployed Worker uses. Override
// any field per-test via the partial argument.
export function makeCfg(overrides: Partial<VaultConfig> = {}): VaultConfig {
  return {
    prefix: "",
    dailyNotePathTemplate: "Daily Notes/{{YYYY-MM-DD}}.md",
    permalinkBaseUrl: "",
    attachmentsPathMode: "per_note_subfolder",
    attachmentsSubfolder: "files",
    attachmentAllowedExtensions: "png,jpg,jpeg,gif,webp,svg,pdf",
    attachmentMaxBytes: 26214400,
    attachmentsMoveWithNote: "unique_refs",
    attachmentUrlTimeoutMs: 20000,
    ...overrides,
  };
}
