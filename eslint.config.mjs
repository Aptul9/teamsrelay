import js from "@eslint/js";
import { defineConfig, globalIgnores } from "eslint/config";
import tseslint from "typescript-eslint";

export default defineConfig([
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    rules: {
      // the page scripts match the no-break and zero-width spaces Teams puts in its text, in regular expressions
      "no-irregular-whitespace": ["error", { skipRegExps: true, skipStrings: true, skipTemplates: true }],
      // a failed probe inside a page script is ignored on purpose
      "no-empty": ["error", { allowEmptyCatch: true }],
    },
  },
  // Page scripts are serialized into the Teams page (page.evaluate): nothing imported exists there
  {
    files: ["src/agent/teams/scripts/**/*.ts"],
    rules: {
      "no-restricted-syntax": [
        "error",
        { selector: "ImportDeclaration[importKind!='type']", message: "Page scripts run inside the Teams page: type imports only." },
      ],
    },
  },
  // The PWA and its service worker run in the phone's browser
  {
    files: ["web/**/*.js"],
    languageOptions: { sourceType: "module", globals: { window: "readonly", document: "readonly", navigator: "readonly", localStorage: "readonly", location: "readonly", history: "readonly", fetch: "readonly", Notification: "readonly", URL: "readonly", URLSearchParams: "readonly", atob: "readonly", setTimeout: "readonly", clearTimeout: "readonly", setInterval: "readonly", clearInterval: "readonly", console: "readonly", self: "readonly", clients: "readonly", Response: "readonly", Blob: "readonly" } },
  },
  {
    files: ["scripts/**/*.mjs", "*.cjs"],
    languageOptions: { globals: { process: "readonly", console: "readonly", Buffer: "readonly", __dirname: "readonly", module: "writable", require: "readonly" } },
  },
  globalIgnores(["dist/**", "state/**", "node_modules/**"]),
]);
