import type { VaultConfig } from "../src/types";

// Safe defaults for VaultConfig in tests. Mirrors the wrangler-var defaults so
// tests exercise the same attachment policy the deployed Worker uses. Override
// any field per-test via the partial argument.
export function makeCfg(overrides: Partial<VaultConfig> = {}): VaultConfig {
  return {
    prefix: "",
    periodicNoteTemplates: {
      daily: "Daily Notes/{{YYYY-MM-DD}}.md",
      weekly: "Weekly Notes/{{GGGG}}-W{{WW}}.md",
      monthly: "Monthly Notes/{{YYYY}}-{{MM}}.md",
      quarterly: "Quarterly Notes/{{YYYY}}-Q{{Q}}.md",
      yearly: "Yearly Notes/{{YYYY}}.md",
    },
    permalinkBaseUrl: "",
    attachmentsPathMode: "per_note_subfolder",
    attachmentsSubfolder: "files",
    attachmentAllowedExtensions: "png,jpg,jpeg,gif,webp,svg,pdf",
    // Default-closed, mirroring the deployed default: the URL-fetch path denies
    // every host until an operator opts specific hosts in. Tests that exercise
    // uploadAttachmentUrl override this with the hosts they fetch.
    attachmentFetchHostAllowlist: "",
    attachmentMaxBytes: 26214400,
    attachmentsMoveWithNote: "unique_refs",
    attachmentUrlTimeoutMs: 20000,
    ...overrides,
  };
}
