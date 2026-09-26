import path from "node:path";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { appDb } from "@/lib/appdb";
import { mcpConfigError, mcpUserId, tokenMatches } from "@/lib/mcp/access";
import { tempDir } from "./helpers";

const TOKEN = "0123456789abcdef".repeat(4);

beforeAll(() => {
  process.env.APP_DB = path.join(tempDir(), "app.db");
  // better-auth's user table, as far as /mcp reads it
  appDb().exec('CREATE TABLE "user"(id TEXT PRIMARY KEY, email TEXT NOT NULL)');
  appDb().prepare('INSERT INTO "user"(id, email) VALUES(?, ?)').run("admin-id", "admin@teamsrelay.test");
});

afterEach(() => {
  delete process.env.MCP_TOKEN;
  delete process.env.ADMIN_EMAIL;
});

describe("MCP_TOKEN at start", () => {
  it("may be empty: /mcp is off", () => {
    expect(mcpConfigError()).toBeNull();
  });

  it("refuses a short token", () => {
    process.env.MCP_TOKEN = "short";
    process.env.ADMIN_EMAIL = "admin@teamsrelay.test";
    expect(mcpConfigError()).toMatch(/at least 32 characters/);
  });

  it("needs the administrator of .env", () => {
    process.env.MCP_TOKEN = TOKEN;
    expect(mcpConfigError()).toMatch(/ADMIN_EMAIL/);
    process.env.ADMIN_EMAIL = "admin@teamsrelay.test";
    expect(mcpConfigError()).toBeNull();
  });
});

describe("bearer token", () => {
  it("matches only Bearer <MCP_TOKEN>", () => {
    process.env.MCP_TOKEN = TOKEN;
    expect(tokenMatches(`Bearer ${TOKEN}`)).toBe(true);
    expect(tokenMatches(`bearer ${TOKEN}`)).toBe(true);
    for (const h of [null, "", TOKEN, `Bearer ${TOKEN}x`, `Bearer ${TOKEN.slice(1)}`, `Basic ${TOKEN}`, "Bearer "]) {
      expect(tokenMatches(h), String(h)).toBe(false);
    }
  });

  it("matches nothing while MCP_TOKEN is empty", () => {
    expect(tokenMatches("Bearer ")).toBe(false);
    expect(tokenMatches("Bearer x")).toBe(false);
  });
});

describe("user of the token", () => {
  it("is the administrator of .env, whatever the case of the address", () => {
    process.env.ADMIN_EMAIL = "Admin@TeamsRelay.test";
    expect(mcpUserId()).toBe("admin-id");
  });

  it("is nobody without ADMIN_EMAIL or without that user", () => {
    expect(mcpUserId()).toBeNull();
    process.env.ADMIN_EMAIL = "gone@teamsrelay.test";
    expect(mcpUserId()).toBeNull();
  });
});
