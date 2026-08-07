/**
 * Client bundles must not reach server-only modules.
 *
 * Two production build failures came from this exact class, both by way of a
 * `"use client"` dashboard page importing one small helper out of a module whose
 * *other* exports are server-only:
 *
 *   1. ComboControlCenterClient → combos/controlCenter → services/model.ts
 *      → `await import("@/lib/db/readCache")` → ioredis / sharp
 *      → `Module not found: Can't resolve 'net' | 'dns' | 'fs' | 'child_process'`
 *
 *   2. CliAgentsPageClient → shared/constants/cliTools → providerRegistry
 *      → providers/codebuddy-cn → oauth constants → utils/cursorAgentCliVersion.ts
 *      → `UnhandledSchemeError: Reading from "node:fs" is not handled by plugins`
 *
 * Neither was caught by tsc or by any unit test — both compile and run fine under
 * Node. Only `next build` failed, minutes into CI. This walks the static import
 * graph (plus `await import()` / `require()`, since webpack resolves those too)
 * from each client entry and fails on the first server-only specifier reached.
 *
 * When this fails: do NOT add webpack `resolve.fallback` shims — that ships dead
 * Node polyfills to the browser and hides the leak. Move the value the client
 * actually needs into a module without server dependencies, and re-export it from
 * the original so server callers keep working and no second copy can drift.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync, statSync } from "node:fs";
import { dirname, resolve, join } from "node:path";

/** Bare specifiers that pull Node builtins in and break the browser bundle. */
const SERVER_ONLY_PACKAGES = new Set([
  "ioredis",
  "sharp",
  "detect-libc",
  "better-sqlite3",
  "fs",
  "net",
  "dns",
  "child_process",
  "os",
  "path",
  "worker_threads",
]);

/** Client entries whose import graphs have regressed in production builds. */
const CLIENT_ENTRIES = [
  "src/app/(dashboard)/dashboard/cli-agents/CliAgentsPageClient.tsx",
  "src/app/(dashboard)/dashboard/combos/ComboControlCenterClient.tsx",
  "src/app/(dashboard)/dashboard/HomePageClient.tsx",
];

const SOURCE_RE = /\.(tsx?|mjs|jsx?)$/;

function resolveSpecifier(spec: string, importer: string): string | null {
  let base: string;
  if (spec.startsWith("@omniroute/")) base = resolve(".", spec.replace("@omniroute/", ""));
  else if (spec.startsWith("@/")) base = resolve("src", spec.slice(2));
  else if (spec.startsWith(".")) base = resolve(dirname(importer), spec);
  else return null;

  const candidates = [
    base,
    `${base}.ts`,
    `${base}.tsx`,
    `${base}.mjs`,
    `${base}.js`,
    join(base, "index.ts"),
    join(base, "index.tsx"),
  ];
  for (const c of candidates) {
    if (existsSync(c) && statSync(c).isFile()) return c;
  }
  return null;
}

/** Every specifier webpack resolves: static, dynamic, and require(). */
function specifiersOf(source: string): string[] {
  return [
    ...source.matchAll(/from\s+["']([^"']+)["']/g),
    ...source.matchAll(/import\s*\(\s*["']([^"']+)["']\s*\)/g),
    ...source.matchAll(/require\(\s*["']([^"']+)["']\s*\)/g),
  ].map((m) => m[1]);
}

function findServerLeaks(entry: string): string[] {
  const visited = new Set<string>();
  const leaks: string[] = [];

  const walk = (file: string, trail: string[]) => {
    if (visited.has(file) || !SOURCE_RE.test(file)) return;
    visited.add(file);

    let source: string;
    try {
      source = readFileSync(file, "utf8");
    } catch {
      return;
    }

    for (const spec of specifiersOf(source)) {
      const bare = spec.replace(/^node:/, "").split("/")[0];
      if (spec.startsWith("node:") || SERVER_ONLY_PACKAGES.has(bare)) {
        const rel = file.replace(`${process.cwd()}/`, "");
        // Trail makes the fix obvious: it names the edge to cut.
        const via = [...trail.slice(-2), rel].map((f) => f.split("/").pop()).join(" → ");
        leaks.push(`${spec} reached via ${via}\n      in ${rel}`);
        continue;
      }
      const resolved = resolveSpecifier(spec, file);
      if (resolved) walk(resolved, [...trail, file.replace(`${process.cwd()}/`, "")]);
    }
  };

  walk(resolve(entry), []);
  return [...new Set(leaks)];
}

for (const entry of CLIENT_ENTRIES) {
  test(`client entry imports no server-only module: ${entry.split("/").pop()}`, () => {
    assert.ok(existsSync(resolve(entry)), `entry moved or renamed: ${entry}`);
    const leaks = findServerLeaks(entry);
    assert.deepEqual(
      leaks,
      [],
      `${entry} reaches server-only modules — next build will fail:\n\n  ${leaks.join("\n\n  ")}\n`
    );
  });
}

// Guards the walker itself: a module that genuinely imports node:fs must be
// reported. Without this, a resolver regression would silently turn every
// assertion above into a vacuous pass.
test("walker detects a known server-only module", () => {
  const leaks = findServerLeaks("open-sse/utils/cursorAgentCliVersion.ts");
  assert.ok(
    leaks.some((l) => l.startsWith("node:fs")),
    "walker failed to flag node:fs in cursorAgentCliVersion.ts — detection is broken"
  );
});
