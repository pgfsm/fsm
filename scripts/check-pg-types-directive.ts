// Fails if any `pg` import lacks `// @ts-types="@types/pg"` on the line above
// (#479).
//
// Why: pg ships no types. Deno attaches @types/pg to `npm:pg` only when the
// npm resolution already includes it, which depends on a (gitignored)
// deno.lock that some checkouts happen to have and CI never does. Without the
// directive, `pg` silently becomes `any` on a fresh clone, and `deno check`
// passes while catching nothing pg-related.
//
// Usage: deno run --allow-read --allow-run=git scripts/check-pg-types-directive.ts [files…]
// With no files (CI), checks every tracked .ts file; prek passes the staged ones.

const DIRECTIVE = '// @ts-types="@types/pg"';
// Built, not written literally, so this file doesn't match its own check.
const DYNAMIC_IMPORT = ["import(", '"pg")'].join("");

async function trackedTsFiles(): Promise<string[]> {
  const { stdout } = await new Deno.Command("git", {
    args: ["ls-files", "*.ts"],
  }).output();
  return new TextDecoder().decode(stdout).split("\n").filter(Boolean);
}

/** 1-based line numbers of pg imports in `text` that lack the directive. */
export function missingDirectives(text: string): number[] {
  const lines = text.split("\n");
  const missing: number[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.trimStart().startsWith("//")) continue;
    let start = -1;
    if (line.includes(DYNAMIC_IMPORT)) {
      start = i;
    } else if (/from "pg";\s*$/.test(line)) {
      // A static import can span lines: find the line it starts on.
      start = i;
      while (start > 0 && !/^\s*import\b/.test(lines[start])) start--;
    }
    if (start >= 0 && lines[start - 1]?.trim() !== DIRECTIVE) {
      missing.push(i + 1);
    }
  }
  return missing;
}

if (import.meta.main) {
  const files = (Deno.args.length > 0 ? Deno.args : await trackedTsFiles())
    .filter((f) => f.endsWith(".ts"));
  const problems: string[] = [];
  for (const file of files) {
    let text: string;
    try {
      text = await Deno.readTextFile(file);
    } catch (err) {
      if (err instanceof Deno.errors.NotFound) continue; // deleted in this commit
      throw err;
    }
    for (const line of missingDirectives(text)) {
      problems.push(`${file}:${line}`);
    }
  }
  if (problems.length > 0) {
    console.error(
      `pg imported without ${DIRECTIVE} on the line above (#479):\n` +
        problems.map((p) => `  ${p}`).join("\n") +
        `\nAdd the directive, or pg is \`any\` on a fresh clone and in CI.`,
    );
    Deno.exit(1);
  }
}
