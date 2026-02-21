
# database-src

This package is used for the main PostgreSQL files for the FSM project.

## Purpose
The `database-src` package manages PostgreSQL database schema and migration files for FSM.


## Supabase CLI Migration
Migrations are performed using Supabase CLI commands, which are integrated into npm scripts for automation and consistency. The package heavily relies on Supabase CLI for managing and migrating PostgreSQL files.

---
For more details, refer to the npm scripts and Supabase CLI documentation.


## Important Notes / Migration Patch

The migration file `20250602124504_pgmq.sql` is manually added to the migration folder. This patch is required to be run before any other SQL scripts when creating or migrating the PostgreSQL database. It ensures necessary setup or fixes are applied prior to other migrations.

Always verify that `20250602124504_pgmq.sql` is executed first during the migration process.

> **Note:** All force migration files are added manually in sequence as needed. These files will not follow the naming convention like `declarative_update`, and are intended for specific patching or forced migration requirements.

## Node & NPM Scripts
This package uses Node.js and npm scripts to handle PostgreSQL migrations via the Supabase CLI npm package.

## NPM Scripts

The following npm scripts are available for managing Supabase and PostgreSQL migrations:

- `npm run supabase:init`: Creates a new Supabase project.
- `npm run supabase:start`: Starts Supabase with debug mode enabled.
- `npm run supabase:start:env`: Loads environment variables from `.env` and starts Supabase in debug mode.
- `npm run supabase:stop`: Stops the Supabase instance.
- `npm run supabase:db:diff:schemafolder:sql`: Runs `supabase db diff` with the `declarative_update` file and debug mode to generate schema differences.
- `npm run supabase:db:reset`: Resets the Supabase database to its initial state.
- `npm run supabase:db:migrate`: Applies all pending migrations using Supabase CLI.
- `npm run supabase:docker:volume:clean`: Cleans up Docker volumes associated with the Supabase project.
- `npm run supabase:gen:types`: Generates TypeScript types from the local database schema and writes them to `database.types.ts`.
- `npm run supabase:restart:with:diff`: Stops Supabase, cleans Docker volumes, runs schema diff, restarts Supabase with environment variables, and regenerates TypeScript types.


### Node Version Management
The Node.js version is managed by `.prototools`, which is created using the command:

```
proto install node 22 --pin local
```

This ensures consistent Node.js versioning across development environments.
