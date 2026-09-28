import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

export default defineConfig([
  ...nextVitals,
  ...nextTs,
  // eslint-plugin-react detects the React version through an API removed in ESLint 10
  { settings: { react: { version: "19.3" } } },
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
  // state/: the files of the local relay, its browser profile with the scripts of Edge's own extensions included
  globalIgnores([".next/**", "out/**", "build/**", "dist/**", "state/**", "next-env.d.ts", "public/sw.js"]),
]);
