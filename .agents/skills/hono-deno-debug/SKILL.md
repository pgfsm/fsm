---
name: hono-deno-debug
description: Start any Deno project (including Hono apps) in debug mode with VS Code or CLI. Includes troubleshooting steps and completion criteria. Keywords: Deno, debug, Hono, VS Code, CLI, troubleshooting.
---

# Skill: Start Deno App in Debug Mode

## Purpose
A generic, reusable workflow for starting any Deno project (including Hono apps) in debug mode, with troubleshooting steps for common issues.

## Workflow Steps

1. **Prerequisites**
   - Ensure Deno is installed and available in your PATH (or at `${env:HOME}/.proto/shims/deno`).
   - Confirm your app entry file (e.g., `src/main.ts`).

2. **VS Code Debug Setup**
   - Use `.vscode/launch.json` with a configuration like:
     ```json
     {
       "request": "launch",
       "name": "Debug Deno App",
       "type": "node",
       "program": "${file}",
       "cwd": "${workspaceFolder}",
       "runtimeExecutable": "${env:HOME}/.proto/shims/deno",
       "runtimeArgs": [
         "run",
         "--inspect-wait",
         "--allow-all",
         "--unstable-detect-cjs",
         "--unstable-sloppy-imports",
         "--env-file=${workspaceFolder}/.env"
       ],
       "attachSimplePort": 9229
     }
     ```
   - Adjust paths and permissions as needed.

3. **Start Debugging**
   - Open your entry file.
   - Start debugging via VS Code (Run > Start Debugging).
   - The debugger attaches to port 9229.

4. **CLI Alternative**
   - Run in terminal:
     ```sh
     deno run --inspect-wait --allow-all --unstable-detect-cjs --unstable-sloppy-imports --env-file=.env <entry-file>
     ```

## Troubleshooting
- **Debugger does not attach**: Ensure port 9229 is open and not blocked by firewall.
- **Deno not found**: Check Deno installation and PATH.
- **Permission errors**: Add necessary `--allow-*` flags.
- **Environment variables not loading**: Verify `.env` file path and permissions.
- **Code not reloading**: Use `--watch` flag for hot reload.

## Completion Criteria
- App starts without errors.
- Debugger attaches successfully.
- Environment variables loaded.

## Example Prompts
- "Start my Deno app in debug mode."
- "How do I debug a Hono app with Deno?"
- "Troubleshoot Deno debug setup."

## Related Customizations
- Add custom debug configurations for test files.
- Integrate hot reload with `--watch`.
- Extend for other frameworks (Oak, Aleph, etc.).