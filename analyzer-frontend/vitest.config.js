import { fileURLToPath, URL } from "node:url";
import { defineConfig } from "vitest/config";

// Dedicated test config so the test runner never needs a browser DOM.
// Browser-only modules used anywhere in the import graph are stubbed here.
export default defineConfig({
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
      // AvatarService statically imports a jpg asset; replace it in tests.
      "^.*\\.(jpg|jpeg|png|svg|css)$": fileURLToPath(
        new URL("./test/stubs/assetStub.js", import.meta.url),
      ),
    },
  },
  test: {
    environment: "node",
    include: ["test/**/*.test.ts"],
    globals: false,
  },
});
