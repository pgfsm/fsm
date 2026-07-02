## Initializing pgrx for a Specific Postgres Version

After installing `cargo-pgrx`, the first step is to initialize pgrx for your
desired PostgreSQL version.

For example, to set up for PostgreSQL 15, run:

```sh
cargo pgrx init --pg15 'download'
```

Here, the `download` option is used for a quick start, allowing pgrx to
automatically download and configure PostgreSQL 15, instead of requiring you to
provide a local pg15 config path.
