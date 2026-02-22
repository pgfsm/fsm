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


### Daily Development Workflow

To run and test your extension during development:

1. **Start the extension in a development environment:**
	```sh
	cargo pgrx run
	```
	This command launches a local PostgreSQL instance with your extension loaded.

2. **Load the extension in psql:**
	Connect to the running database using `psql` and execute:
	```sql
	CREATE EXTENSION fsm_core;
	SELECT hello_fsm_core();
	```
	- `CREATE EXTENSION fsm_core;` loads your extension.
	- `SELECT hello_fsm_core();` runs a sample function provided by the extension.

Refer to your extension's source code for more available functions and usage examples.



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
