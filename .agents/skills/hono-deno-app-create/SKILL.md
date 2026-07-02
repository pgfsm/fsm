---
name: hono-deno-app-create
description: Create a new Hono app using Deno. Use for scaffolding, quickstart, and project setup. Keywords: Hono, Deno, app creation, scaffold, quickstart.
---

# Skill: Create Hono App with Deno

## Purpose

A step-by-step workflow for creating a new Hono web application using Deno,
including project scaffolding, setup, and verification.

## Workflow Steps

1. **Prerequisites**
   - Ensure Deno is installed and available in your PATH.

2. **Create Project Directory**
   - Choose a project name and create a new directory:
     ```sh
     mkdir <project-name> && cd <project-name>
     ```

3. **Initialize Deno Project**
   - Optionally create a `deno.json` for project config:
     ```sh
     deno init
     ```

4. **Add Hono Dependency**
   - Create `main.ts` and add:
     ```typescript
     import { Hono } from "https://deno.land/x/hono/mod.ts";

     const app = new Hono();

     app.get("/", (c) => c.text("Hello from Hono!"));

     Deno.serve(app.fetch);
     ```

5. **Run the App**
   - Start the server:
     ```sh
     deno run --allow-net main.ts
     ```
   - Visit `http://localhost:8000` to verify.

## Quality Criteria

- App runs without errors.
- Root endpoint returns "Hello from Hono!".
- Project structure is clean and minimal.

## Example Prompts

- "Create a new Hono app with Deno."
- "Quickstart Hono web project."
- "Scaffold Hono API in Deno."

## Related Customizations

- Add routes and middleware.
- Integrate with database or authentication.
- Setup debug mode or hot reload.
