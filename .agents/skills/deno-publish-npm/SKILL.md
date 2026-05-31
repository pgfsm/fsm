---
name: deno-publish-npm
description: Guides the workflow for compiling, packaging, and publishing an npm package from a Deno project using the 'deno pack' command in Deno v2.8+.
---

# Publishing npm Packages with Deno Pack

Use this skill when tasked with preparing, testing, or publishing a Deno-first project to the npm registry.

## 1. Prerequisites Check
Ensure the project uses Deno v2.8 or later and contains a `deno.json` file in the root. The `deno.json` must expose these mandatory fields:
- `name`: The target npm package name (can include a scope like `@my-scope/my-lib`).
- `version`: A valid Semantic Versioning string (e.g., `1.0.0`).
- `exports`: Entry points mapping to source files (e.g., `./mod.ts`).

## 2. Compilation and Tarball Step
Execute the native pack command to let Deno transpile TypeScript, generate declaration (`.d.ts`) files, build conditional exports, and inject Deno global API shims automatically:
```bash
deno pack
```
*Note: To skip adding the `@deno/shim-deno` polyfill dependency, explicitly append `--no-deno-shim`.*

## 3. Local Inspection
Before executing the network publish phase, always verify the packaged contents to ensure everything compiled correctly:
```bash
tar -tzf <scope>-<package-name>-<version>.tgz
```

## 4. npm Publishing Execution
Authenticate to the npm registry and pass the exact file path of the freshly created `.tgz` file to the native npm command:
```bash
npm publish ./<scope>-<package-name>-<version>.tgz
```
*Flag Warning:* If the package utilizes a scope and is being uploaded for the first time, append the `--access=public` flag to prevent private package configuration errors.

## 5. Maintenance and Version Bumping
For subsequent updates, instruct the user to strictly follow this command sequence to ensure files stay synced with the project manifest:
1. `deno bump-version patch` (or `minor` / `major`)
2. `deno pack`
3. `npm publish ./<generated-archive>.tgz`
