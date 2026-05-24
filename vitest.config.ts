import { defineConfig } from "vitest/config";
import { cloudflarePool, cloudflareTest } from "@cloudflare/vitest-pool-workers";

const poolOptions = {
  main: "test/_test-worker.ts",
  wrangler: { configPath: "./wrangler.jsonc" },
  miniflare: {
    r2Buckets: ["VAULT"],
    kvNamespaces: ["OAUTH_KV"],
    compatibilityFlags: ["nodejs_compat"],
    bindings: {
      VAULT_PREFIX: "",
      DAILY_NOTE_PATH_TEMPLATE: "Daily Notes/{{YYYY-MM-DD}}.md",
      AUTH_PASSWORD: "test-password",
      UPLOAD_TOKEN: "test-upload-secret",
      SERVICE_BASE_URL: "https://vault.example.test",
    },
  },
};

export default defineConfig({
  plugins: [cloudflareTest(poolOptions)],
  test: {
    pool: cloudflarePool(poolOptions),
    deps: {
      optimizer: {
        ssr: {
          enabled: true,
          include: ["gray-matter"],
        },
      },
    },
  },
});
