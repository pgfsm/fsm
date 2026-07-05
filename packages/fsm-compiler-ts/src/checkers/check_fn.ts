// Check that a named function is exported from a TypeScript/JavaScript module.
//
// Usage: deno run --allow-all check_fn.ts <filepath> <fn_name>
// Exit 0 if the file exports fn_name as a function, 1 if not, 2 on bad args or import error.
const [filepath, fnName] = Deno.args;

if (!filepath || !fnName) {
  console.error("Usage: check_fn.ts <filepath> <fn_name>");
  Deno.exit(2);
}

try {
  const mod = await import(`file://${filepath}`);
  if (typeof mod[fnName] === "function") {
    Deno.exit(0);
  } else {
    console.error(`'${fnName}' is not exported as a function from ${filepath}`);
    Deno.exit(1);
  }
} catch (err) {
  console.error(`Failed to import ${filepath}: ${err}`);
  Deno.exit(1);
}
