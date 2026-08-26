import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: "./wrangler.jsonc" },
      miniflare: {
        bindings: {
          VIEW_TOKEN: "test-view-token",
          CONTROL_TOKEN: "test-control-token",
          ALLOWED_ORIGIN: "http://localhost:1420",
        },
      },
    }),
  ],
});
