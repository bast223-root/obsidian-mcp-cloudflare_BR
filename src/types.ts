import type { OAuthHelpers } from "@cloudflare/workers-oauth-provider";

declare global {
  interface Env {
    AUTH_PASSWORD: string;
    OAUTH_PROVIDER: OAuthHelpers;
  }
}

export interface Props extends Record<string, unknown> {
  user: string;
}

export interface VaultConfig {
  prefix: string;
  dailyNotePathTemplate: string;
  permalinkBaseUrl: string;
}

export type ToolOk<T> = { ok: true; value: T };
export type ToolErr = { ok: false; reason: string; [k: string]: unknown };
export type ToolResult<T> = ToolOk<T> | ToolErr;

export const ok = <T>(value: T): ToolOk<T> => ({ ok: true, value });
export const err = (reason: string, extra: Record<string, unknown> = {}): ToolErr => ({
  ok: false,
  reason,
  ...extra,
});

export {};
