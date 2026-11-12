import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  {
    rules: {
      "@typescript-eslint/no-unused-vars": [
        "warn",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],
      // Connectors only talk to remote servers: the MCP SDK's stdio transport starts
      // a program on our side, and its SSE transport lets the server pick the URL we post to.
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: ["@modelcontextprotocol/sdk/client/stdio*", "@modelcontextprotocol/sdk/client/sse*", "@modelcontextprotocol/sdk/client/websocket*"],
              message: "Only the Streamable HTTP transport, through lib/sources/mcp, is allowed.",
            },
          ],
        },
      ],
    },
  },
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
    "packages/*/dist/**",
  ]),
]);

export default eslintConfig;
