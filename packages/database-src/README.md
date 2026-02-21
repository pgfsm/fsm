
# database-src

This package is used for the main PostgreSQL files for the FSM project.

## Purpose
The `database-src` package manages PostgreSQL database schema and migration files for FSM.

## Node & NPM Scripts
This package uses Node.js and npm scripts to handle PostgreSQL migrations via the Supabase CLI npm package.


## Supabase CLI Migration
Migrations are performed using Supabase CLI commands, which are integrated into npm scripts for automation and consistency. The package heavily relies on Supabase CLI for managing and migrating PostgreSQL files.

---
For more details, refer to the npm scripts and Supabase CLI documentation.

## NPM Scripts

The following npm scripts are available for managing Supabase and PostgreSQL migrations:

- `npm run supabase:init`: Creates a new Supabase project.
- `npm run supabase:start`: Starts Supabase with debug mode enabled.
- `npm run supabase:start:env`: Loads environment variables from `.env` and starts Supabase in debug mode.
- `npm run supabase:stop`: Stops the Supabase instance.


### Node Version Management
The Node.js version is managed by `.prototools`, which is created using the command:

```
proto install node 22 --pin local
```

This ensures consistent Node.js versioning across development environments.
