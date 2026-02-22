## FSM Postgres Extension

This project is a PostgreSQL extension for FSM (Finite State Machine).

### About
The extension provides custom functionality to support FSM operations directly within a PostgreSQL database environment.


### Getting Started

1. **Initialize pgrx:**
	 - Follow the instructions in `pgrx-help.md` to initialize pgrx for your desired PostgreSQL version. For example:
		 ```sh
		 cargo pgrx init --pg15 'download'
		 ```
	 - The `download` option allows pgrx to automatically set up PostgreSQL for you.

2. **Create a new extension:**
	 - Use the following command to scaffold a new extension:
		 ```sh
		 cargo pgrx new fsm_core
		 ```

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
