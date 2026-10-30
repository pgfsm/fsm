// Node module-resolution hook (see ../import-resolution.node.ts, #270).
// Registered via node:module's registerHooks() — only ever runs under the
// npm/npx build, never under Deno. Node runs these hooks synchronously on
// the main thread (#388; the old register() ran them on a loader thread),
// so everything here, the on-demand npm install included, is synchronous.
//
// Scope, deliberately: only exact-key `imports` entries whose value starts
// with "npm:" are resolved. Import-map `scopes`/trailing-slash prefix
// entries and `jsr:`-mapped values are NOT handled — see #270's plan for
// why. Anything outside that scope, or any failure along the way, rethrows
// the ORIGINAL Node resolution error unchanged rather than masking it.
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
} from "node:fs";
import { homedir, platform } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

interface DenoConfig {
  imports?: Record<string, string>;
  workspace?: unknown;
}

// Strips `//` and `/* */` comments from deno.jsonc while leaving string
// contents alone. Not a full JSONC parser (no trailing-comma handling) —
// deliberately minimal, matching this repo's own deno.jsonc usage.
function stripJsonComments(text: string): string {
  let result = "";
  let inString = false;
  let inLineComment = false;
  let inBlockComment = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    const next = text[i + 1];
    if (inLineComment) {
      if (ch === "\n") {
        inLineComment = false;
        result += ch;
      }
      continue;
    }
    if (inBlockComment) {
      if (ch === "*" && next === "/") {
        inBlockComment = false;
        i++;
      }
      continue;
    }
    if (inString) {
      result += ch;
      if (ch === "\\") {
        result += next;
        i++;
      } else if (ch === '"') {
        inString = false;
      }
      continue;
    }
    if (ch === '"') {
      inString = true;
      result += ch;
      continue;
    }
    if (ch === "/" && next === "/") {
      inLineComment = true;
      i++;
      continue;
    }
    if (ch === "/" && next === "*") {
      inBlockComment = true;
      i++;
      continue;
    }
    result += ch;
  }
  return result;
}

function readDenoConfig(dir: string): DenoConfig | undefined {
  for (const name of ["deno.json", "deno.jsonc"]) {
    let text: string;
    try {
      text = readFileSync(join(dir, name), "utf8");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw err;
    }
    try {
      return JSON.parse(stripJsonComments(text)) as DenoConfig;
    } catch {
      // Malformed config — treat as "no config here" rather than aborting
      // resolution entirely over an unrelated file we don't own.
      return undefined;
    }
  }
  return undefined;
}

const importMapCache = new Map<string, Record<string, string>>();

// Walks up from startDir looking for the nearest deno.json(c)'s `imports`,
// then (if that nearest config isn't itself a workspace root) continues
// walking up for a workspace root's `imports` as a lower-precedence
// fallback — approximating Deno's own workspace import-map inheritance
// closely enough for the common case. See #270's plan for exact scope.
export function findMergedImportMap(
  startDir: string,
): Record<string, string> {
  const cached = importMapCache.get(startDir);
  if (cached) return cached;

  let dir = startDir;
  let nearest: DenoConfig | undefined;
  let nearestDir: string | undefined;
  for (;;) {
    const config = readDenoConfig(dir);
    if (config) {
      nearest = config;
      nearestDir = dir;
      break;
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }

  if (!nearest || !nearestDir) {
    importMapCache.set(startDir, {});
    return {};
  }

  let merged: Record<string, string> = { ...(nearest.imports ?? {}) };

  if (!("workspace" in nearest)) {
    let rootDir = dirname(nearestDir);
    for (;;) {
      const config = readDenoConfig(rootDir);
      if (config && "workspace" in config) {
        merged = { ...(config.imports ?? {}), ...merged };
        break;
      }
      const parent = dirname(rootDir);
      if (parent === rootDir) break;
      rootDir = parent;
    }
  }

  importMapCache.set(startDir, merged);
  return merged;
}

function getCacheRoot(): string {
  const base = process.env.XDG_CACHE_HOME ??
    (platform() === "darwin"
      ? join(homedir(), "Library", "Caches")
      : platform() === "win32"
      ? (process.env.LOCALAPPDATA ?? join(homedir(), "AppData", "Local"))
      : join(homedir(), ".cache"));
  return join(base, "pgfsm-compiler", "npm-import-map-deps");
}

function sanitizeForDirName(spec: string): string {
  return spec.replace(/[^a-zA-Z0-9.@_-]/g, "_");
}

// "xstate@^5.28.0" -> "xstate"; "@scope/name@^1.0.0" -> "@scope/name";
// "@scope/name" (no version) -> "@scope/name" unchanged.
function parsePackageName(pkgSpec: string): string {
  const lastAt = pkgSpec.lastIndexOf("@");
  if (lastAt <= 0) return pkgSpec;
  return pkgSpec.slice(0, lastAt);
}

// Blocks the main thread until npm exits — the import waiting on this
// resolve can't proceed without the package anyway.
function runNpmInstall(pkgSpec: string, cwd: string): void {
  const npmCmd = platform() === "win32" ? "npm.cmd" : "npm";
  const result = spawnSync(
    npmCmd,
    [
      "install",
      pkgSpec,
      "--prefix",
      cwd,
      "--no-save",
      "--no-audit",
      "--no-fund",
      "--silent",
    ],
    { stdio: "ignore" },
  );
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(
      `npm install ${pkgSpec} exited with code ${result.status}`,
    );
  }
}

// Ensures pkgSpec (e.g. "xstate@^5.28.0") is installed under a persistent,
// per-user cache directory, and returns that install's root (an npm
// --prefix dir, so real packages live under <dir>/node_modules/). Installs
// into a temp staging dir and renames into place atomically so a crashed
// or concurrent install (another process) can't leave a half-written cache
// entry. A failure isn't remembered, so a later resolve() retries.
function ensurePackageInstalled(pkgSpec: string): string {
  const cacheRoot = getCacheRoot();
  const finalDir = join(cacheRoot, sanitizeForDirName(pkgSpec));
  const pkgName = parsePackageName(pkgSpec);
  const markerPath = join(finalDir, "node_modules", pkgName, "package.json");
  if (existsSync(markerPath)) return finalDir;

  mkdirSync(cacheRoot, { recursive: true });
  const stagingDir = join(
    cacheRoot,
    `.staging-${sanitizeForDirName(pkgSpec)}-${process.pid}-${Date.now()}`,
  );
  mkdirSync(stagingDir, { recursive: true });
  runNpmInstall(pkgSpec, stagingDir);
  rmSync(finalDir, { recursive: true, force: true });
  renameSync(stagingDir, finalDir);
  return finalDir;
}

interface ResolveContext {
  parentURL?: string;
  conditions?: string[];
  importAttributes?: Record<string, string | undefined>;
}

interface ResolveResult {
  url: string;
  format?: string | null;
  shortCircuit?: boolean;
}

type NextResolve = (
  specifier: string,
  context: ResolveContext,
) => ResolveResult;

export function resolve(
  specifier: string,
  context: ResolveContext,
  nextResolve: NextResolve,
): ResolveResult {
  try {
    return nextResolve(specifier, context);
  } catch (err) {
    if (!context.parentURL) throw err;

    let parentPath: string;
    try {
      parentPath = fileURLToPath(context.parentURL);
    } catch {
      throw err;
    }

    const importMap = findMergedImportMap(dirname(parentPath));
    const mapped = importMap[specifier];
    if (!mapped || !mapped.startsWith("npm:")) {
      return resolveFromOwnDependencies(specifier, context, nextResolve, err);
    }

    const pkgSpec = mapped.slice("npm:".length);
    let installDir: string;
    try {
      installDir = ensurePackageInstalled(pkgSpec);
    } catch {
      // The fallback itself failed (offline, no npm on PATH, bad range,
      // …) — surface the ORIGINAL Node resolution error, not the
      // installer's, so the visible failure stays meaningful (see #271).
      throw err;
    }

    const fakeParentURL =
      pathToFileURL(join(installDir, "__pgfsm_compiler_resolver__.mjs")).href;
    return nextResolve(specifier, { ...context, parentURL: fakeParentURL });
  }
}

/**
 * Last resort for a bare specifier nothing near the importing file maps
 * (#382): resolve it as if this package imported it, so a user's
 * machine.ts gets @pgfsm/compiler's own `xstate` dependency with zero config
 * (e.g. `npx @pgfsm/cli add ~/designs/machine.ts`). Relative/absolute/URL
 * specifiers are never redirected, and a miss here rethrows the ORIGINAL
 * resolution error (see #271).
 */
function resolveFromOwnDependencies(
  specifier: string,
  context: ResolveContext,
  nextResolve: NextResolve,
  originalError: unknown,
): ResolveResult {
  const bare = !/^(\.{0,2}\/|[a-zA-Z][a-zA-Z\d+.-]*:)/.test(specifier);
  if (!bare) throw originalError;
  try {
    // import.meta is safe to read here: registerHooks() hooks run on the
    // main thread, where dnt's import.meta ponyfill exists (#388).
    return nextResolve(specifier, {
      ...context,
      parentURL: import.meta.url,
    });
  } catch {
    throw originalError;
  }
}
