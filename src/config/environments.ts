import * as fs from "fs";
import * as mysql2 from "mysql2/promise";
import { mcpConfig } from "./index.js";

/**
 * Multi-environment support.
 *
 * A single MCP server process can expose several named MySQL targets (e.g.
 * `local`, `qa`) so the LLM can pick one per tool call via the `env` argument.
 *
 * Configuration is a JSON object of `{ "name": {config} }`, delivered either as:
 *   - `MYSQL_ENVIRONMENTS_FILE` — path to a JSON file (recommended; keeps the
 *     MCP client config clean and readable). Takes precedence.
 *   - `MYSQL_ENVIRONMENTS` — the same JSON inline as a single string env var.
 *
 * The MCP client only passes flat *string* env vars to the server process, so a
 * nested object placed directly under `env` is not supported — use a file.
 *
 * Each environment accepts either short keys or the familiar server env-var
 * names, whichever is easier to read:
 *
 *   {
 *     "local": {
 *       "MYSQL_HOST": "127.0.0.1", "MYSQL_PORT": "3306", "MYSQL_USER": "root",
 *       "MYSQL_PASS": "", "MYSQL_DB": "local-db",
 *       "ALLOW_INSERT_OPERATION": "false", "ALLOW_UPDATE_OPERATION": "false",
 *       "ALLOW_DELETE_OPERATION": "false", "ALLOW_DDL_OPERATION": "false"
 *     },
 *     "qa": { "host": "127.0.0.1", "database": "qa-db", "allowInsert": true }
 *   }
 *
 * When neither var is set the server runs in legacy single-environment mode
 * driven by the flat `MYSQL_*` / `ALLOW_*` process env vars (unchanged).
 *
 * Only connection target + the four write-permission flags are per-environment.
 * PII redaction and read-only-transaction mode remain global (shared by every
 * environment).
 */

/** The four write-operation permission flags for a single environment. */
export interface WritePermissions {
  insert: boolean;
  update: boolean;
  delete: boolean;
  ddl: boolean;
}

/** A resolved, ready-to-use environment: a pool config plus write permissions. */
export interface MysqlEnvironment {
  name: string;
  poolConfig: mysql2.PoolOptions;
  permissions: WritePermissions;
}

/**
 * Raw per-environment definition as parsed from the JSON config. Both the short
 * keys (`host`, `allowInsert`, ...) and the familiar server env-var names
 * (`MYSQL_HOST`, `ALLOW_INSERT_OPERATION`, ...) are accepted; the short key wins
 * when both are present.
 */
interface EnvironmentDefinition {
  host?: string;
  port?: number | string;
  user?: string;
  password?: string;
  database?: string;
  socketPath?: string;
  allowInsert?: boolean | string;
  allowUpdate?: boolean | string;
  allowDelete?: boolean | string;
  allowDdl?: boolean | string;
  // Familiar server env-var aliases.
  MYSQL_HOST?: string;
  MYSQL_PORT?: number | string;
  MYSQL_USER?: string;
  MYSQL_PASS?: string;
  MYSQL_DB?: string;
  MYSQL_SOCKET_PATH?: string;
  ALLOW_INSERT_OPERATION?: boolean | string;
  ALLOW_UPDATE_OPERATION?: boolean | string;
  ALLOW_DELETE_OPERATION?: boolean | string;
  ALLOW_DDL_OPERATION?: boolean | string;
}

/** Canonical connection + permission fields after merging both key styles. */
interface NormalizedDefinition {
  host?: string;
  port?: number | string;
  user?: string;
  password?: string;
  database?: string;
  socketPath?: string;
  allowInsert?: boolean | string;
  allowUpdate?: boolean | string;
  allowDelete?: boolean | string;
  allowDdl?: boolean | string;
}

/** Merge short keys and familiar env-var aliases into canonical fields. */
function normalizeDefinition(def: EnvironmentDefinition): NormalizedDefinition {
  return {
    host: def.host ?? def.MYSQL_HOST,
    port: def.port ?? def.MYSQL_PORT,
    user: def.user ?? def.MYSQL_USER,
    password: def.password ?? def.MYSQL_PASS,
    database: def.database ?? def.MYSQL_DB,
    socketPath: def.socketPath ?? def.MYSQL_SOCKET_PATH,
    allowInsert: def.allowInsert ?? def.ALLOW_INSERT_OPERATION,
    allowUpdate: def.allowUpdate ?? def.ALLOW_UPDATE_OPERATION,
    allowDelete: def.allowDelete ?? def.ALLOW_DELETE_OPERATION,
    allowDdl: def.allowDdl ?? def.ALLOW_DDL_OPERATION,
  };
}

/** Accept both real booleans and the string "true"/"false" (JSON authored by hand). */
function coerceBool(value: unknown, fallback = false): boolean {
  if (typeof value === "boolean") return value;
  if (typeof value === "string") return value.trim().toLowerCase() === "true";
  return fallback;
}

/**
 * Build a mysql2 pool config for one environment. Non-connection pool options
 * (connectionLimit, keepAlive, SSL, timezone, big-number handling, ...) are
 * inherited from the global `mcpConfig.mysql`; only the connection target and
 * the auth-plugin password are overridden per environment.
 */
function buildPoolConfig(def: NormalizedDefinition): mysql2.PoolOptions {
  // Shallow-clone the shared base so per-env overrides don't mutate the global.
  const cfg: Record<string, unknown> = { ...(mcpConfig.mysql as object) };

  if (def.socketPath) {
    cfg.socketPath = def.socketPath;
    delete cfg.host;
    delete cfg.port;
  } else {
    delete cfg.socketPath;
    cfg.host = def.host ?? (cfg.host as string) ?? "127.0.0.1";
    cfg.port =
      def.port !== undefined ? Number(def.port) : ((cfg.port as number) ?? 3306);
  }

  cfg.user = def.user ?? (cfg.user as string) ?? "root";
  cfg.password = def.password ?? "";
  cfg.database = def.database ?? undefined;

  // The base authPlugins closure captures the flat-env password; override it so
  // clear-password auth uses THIS environment's password.
  cfg.authPlugins = {
    mysql_clear_password: () => () => Buffer.from(def.password ?? ""),
  };

  return cfg as mysql2.PoolOptions;
}

function buildPermissions(def: NormalizedDefinition): WritePermissions {
  return {
    insert: coerceBool(def.allowInsert),
    update: coerceBool(def.allowUpdate),
    delete: coerceBool(def.allowDelete),
    ddl: coerceBool(def.allowDdl),
  };
}

function parseEnvironments(raw: string | undefined): Map<string, MysqlEnvironment> {
  const map = new Map<string, MysqlEnvironment>();
  if (!raw || !raw.trim()) return map;

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    console.error(
      `[config] MYSQL_ENVIRONMENTS is not valid JSON, ignoring it: ${
        (err as Error).message
      }`,
    );
    return map;
  }

  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    console.error(
      '[config] MYSQL_ENVIRONMENTS must be a JSON object of {"name": {config}}, ignoring it.',
    );
    return map;
  }

  for (const [name, def] of Object.entries(parsed as Record<string, unknown>)) {
    if (typeof def !== "object" || def === null || Array.isArray(def)) {
      console.error(
        `[config] MYSQL_ENVIRONMENTS entry "${name}" is not an object, skipping it.`,
      );
      continue;
    }
    const definition = normalizeDefinition(def as EnvironmentDefinition);
    map.set(name, {
      name,
      poolConfig: buildPoolConfig(definition),
      permissions: buildPermissions(definition),
    });
  }

  return map;
}

/**
 * Resolve the raw JSON config from either the file path (preferred) or the
 * inline string var. A missing/unreadable file falls back to the inline var.
 */
function readEnvironmentsSource(): string | undefined {
  const filePath = process.env.MYSQL_ENVIRONMENTS_FILE;
  if (filePath && filePath.trim()) {
    try {
      return fs.readFileSync(filePath, "utf8");
    } catch (err) {
      console.error(
        `[config] could not read MYSQL_ENVIRONMENTS_FILE "${filePath}": ${
          (err as Error).message
        }. Falling back to MYSQL_ENVIRONMENTS.`,
      );
    }
  }
  return process.env.MYSQL_ENVIRONMENTS;
}

export const MYSQL_ENVIRONMENTS: Map<string, MysqlEnvironment> =
  parseEnvironments(readEnvironmentsSource());

/** True when at least one named environment is configured. */
export const isMultiEnvMode = MYSQL_ENVIRONMENTS.size > 0;

/**
 * Environment used when a tool call omits `env`. Explicit `MYSQL_DEFAULT_ENV`
 * wins; otherwise the first configured environment. `null` in legacy mode.
 */
export const DEFAULT_ENV_NAME: string | null = (() => {
  if (!isMultiEnvMode) return null;
  const explicit = process.env.MYSQL_DEFAULT_ENV;
  if (explicit && MYSQL_ENVIRONMENTS.has(explicit)) return explicit;
  if (explicit) {
    console.error(
      `[config] MYSQL_DEFAULT_ENV="${explicit}" is not a defined environment; falling back to the first one.`,
    );
  }
  return MYSQL_ENVIRONMENTS.keys().next().value ?? null;
})();

/** Comma-separated list of configured environment names (for messages/schemas). */
export function environmentNames(): string[] {
  return [...MYSQL_ENVIRONMENTS.keys()];
}

/**
 * Resolve an environment by name.
 * - Legacy mode (no environments configured): returns `{ env: null }` — the
 *   caller falls back to flat-env defaults.
 * - Multi-env mode: `envName` omitted → the default environment; a bad/unknown
 *   name → `{ error }` (fail-closed, with the valid names listed).
 */
export function resolveEnvironment(
  envName?: string,
): { env: MysqlEnvironment | null; error?: string } {
  if (!isMultiEnvMode) return { env: null };

  const name = envName ?? DEFAULT_ENV_NAME;
  if (!name) {
    return {
      env: null,
      error: `No environment specified and no default is set. Available environments: ${environmentNames().join(
        ", ",
      )}.`,
    };
  }

  const env = MYSQL_ENVIRONMENTS.get(name);
  if (!env) {
    return {
      env: null,
      error: `Unknown environment "${name}". Available environments: ${environmentNames().join(
        ", ",
      )}.`,
    };
  }

  return { env };
}
