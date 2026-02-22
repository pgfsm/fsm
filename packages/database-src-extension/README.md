## FSM Postgres Extension

This project is a PostgreSQL extension for FSM (Finite State Machine).

### About
The extension provides custom functionality to support FSM operations directly within a PostgreSQL database environment.

### Technology
- **Language:** Rust
- **Toolchain:** [cargo-pgrx](https://github.com/pgcentralfoundation/pgrx) (Rust toolchain for building PostgreSQL extensions)

---
For more details on building and using this extension, refer to the official cargo-pgrx documentation and the project source code.


### Rust Version Management
The Rust version is managed by `.prototools`, which is created using the command:

```
proto install rust --pin local
```

This ensures consistent Rust versioning across development environments.
