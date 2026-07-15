import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

/**
 * Re-import the environments module fresh after stubbing env vars, since it
 * parses MYSQL_ENVIRONMENTS at module-load time.
 */
async function loadEnvironments(env: Record<string, string | undefined>) {
  vi.resetModules();
  for (const [k, v] of Object.entries(env)) {
    if (v === undefined) vi.stubEnv(k, "");
    else vi.stubEnv(k, v);
  }
  return await import("../../src/config/environments.js");
}

const TWO_ENVS = JSON.stringify({
  local: { host: "127.0.0.1", database: "local-db", allowInsert: false },
  qa: {
    host: "10.0.0.5",
    port: 3307,
    user: "qa_user",
    password: "secret",
    database: "qa-db",
    allowInsert: true,
    allowUpdate: "true",
    allowDelete: false,
  },
});

describe("environments config", () => {
  beforeEach(() => {
    vi.unstubAllEnvs();
  });

  it("is legacy (no multi-env) when MYSQL_ENVIRONMENTS is unset", async () => {
    const m = await loadEnvironments({ MYSQL_ENVIRONMENTS: undefined });
    expect(m.isMultiEnvMode).toBe(false);
    expect(m.DEFAULT_ENV_NAME).toBeNull();
    expect(m.resolveEnvironment().env).toBeNull();
    // Legacy: a stray env name is ignored, not an error.
    expect(m.resolveEnvironment("whatever").error).toBeUndefined();
  });

  it("parses multiple environments with connection + permission fields", async () => {
    const m = await loadEnvironments({ MYSQL_ENVIRONMENTS: TWO_ENVS });
    expect(m.isMultiEnvMode).toBe(true);
    expect(m.environmentNames()).toEqual(["local", "qa"]);

    const qa = m.MYSQL_ENVIRONMENTS.get("qa")!;
    expect(qa.poolConfig.host).toBe("10.0.0.5");
    expect(qa.poolConfig.port).toBe(3307);
    expect(qa.poolConfig.user).toBe("qa_user");
    expect(qa.poolConfig.database).toBe("qa-db");
    // Accepts both boolean and "true"/"false" strings.
    expect(qa.permissions).toEqual({
      insert: true,
      update: true,
      delete: false,
      ddl: false,
    });

    const local = m.MYSQL_ENVIRONMENTS.get("local")!;
    expect(local.permissions).toEqual({
      insert: false,
      update: false,
      delete: false,
      ddl: false,
    });
  });

  it("defaults to the first environment when MYSQL_DEFAULT_ENV is unset", async () => {
    const m = await loadEnvironments({ MYSQL_ENVIRONMENTS: TWO_ENVS });
    expect(m.DEFAULT_ENV_NAME).toBe("local");
    expect(m.resolveEnvironment().env?.name).toBe("local");
  });

  it("honours MYSQL_DEFAULT_ENV when valid", async () => {
    const m = await loadEnvironments({
      MYSQL_ENVIRONMENTS: TWO_ENVS,
      MYSQL_DEFAULT_ENV: "qa",
    });
    expect(m.DEFAULT_ENV_NAME).toBe("qa");
    expect(m.resolveEnvironment().env?.name).toBe("qa");
  });

  it("falls back to first env when MYSQL_DEFAULT_ENV is invalid", async () => {
    const m = await loadEnvironments({
      MYSQL_ENVIRONMENTS: TWO_ENVS,
      MYSQL_DEFAULT_ENV: "nope",
    });
    expect(m.DEFAULT_ENV_NAME).toBe("local");
  });

  it("resolves a named environment and fails closed on unknown names", async () => {
    const m = await loadEnvironments({ MYSQL_ENVIRONMENTS: TWO_ENVS });
    expect(m.resolveEnvironment("qa").env?.name).toBe("qa");

    const bad = m.resolveEnvironment("prod");
    expect(bad.env).toBeNull();
    expect(bad.error).toContain("Unknown environment");
    expect(bad.error).toContain("local, qa");
  });

  it("ignores invalid JSON and runs as legacy mode", async () => {
    const m = await loadEnvironments({ MYSQL_ENVIRONMENTS: "{not json" });
    expect(m.isMultiEnvMode).toBe(false);
  });

  it("accepts familiar server env-var names inside a definition", async () => {
    const m = await loadEnvironments({
      MYSQL_ENVIRONMENTS: JSON.stringify({
        local: {
          MYSQL_HOST: "127.0.0.1",
          MYSQL_PORT: "3306",
          MYSQL_USER: "root",
          MYSQL_PASS: "",
          MYSQL_DB: "local-db",
          ALLOW_INSERT_OPERATION: "false",
          ALLOW_UPDATE_OPERATION: "true",
        },
      }),
    });
    const local = m.MYSQL_ENVIRONMENTS.get("local")!;
    expect(local.poolConfig.host).toBe("127.0.0.1");
    expect(local.poolConfig.port).toBe(3306);
    expect(local.poolConfig.database).toBe("local-db");
    expect(local.permissions).toEqual({
      insert: false,
      update: true,
      delete: false,
      ddl: false,
    });
  });

  it("loads environments from MYSQL_ENVIRONMENTS_FILE (takes precedence)", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-envs-"));
    const file = path.join(dir, "envs.json");
    fs.writeFileSync(
      file,
      JSON.stringify({
        fromfile: { MYSQL_HOST: "db.example", MYSQL_DB: "filedb" },
      }),
    );
    try {
      const m = await loadEnvironments({
        MYSQL_ENVIRONMENTS_FILE: file,
        // Inline var must be ignored when the file is present & readable.
        MYSQL_ENVIRONMENTS: JSON.stringify({ inline: { MYSQL_DB: "x" } }),
      });
      expect(m.environmentNames()).toEqual(["fromfile"]);
      expect(m.MYSQL_ENVIRONMENTS.get("fromfile")!.poolConfig.database).toBe(
        "filedb",
      );
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("falls back to inline var when the file is unreadable", async () => {
    const m = await loadEnvironments({
      MYSQL_ENVIRONMENTS_FILE: "/nonexistent/path/envs.json",
      MYSQL_ENVIRONMENTS: JSON.stringify({ inline: { MYSQL_DB: "x" } }),
    });
    expect(m.environmentNames()).toEqual(["inline"]);
  });

  it("prefers socketPath over host/port when provided", async () => {
    const m = await loadEnvironments({
      MYSQL_ENVIRONMENTS: JSON.stringify({
        sock: { socketPath: "/tmp/mysql.sock", database: "d" },
      }),
    });
    const cfg = m.MYSQL_ENVIRONMENTS.get("sock")!.poolConfig as Record<
      string,
      unknown
    >;
    expect(cfg.socketPath).toBe("/tmp/mysql.sock");
    expect(cfg.host).toBeUndefined();
    expect(cfg.port).toBeUndefined();
  });
});
