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
	- The `download` option sets up PostgreSQL in your `$HOME/.pgrx` directory.
	- To re-create the pg15 environment, use:
		```sh
		cargo pgrx init --pg15 'download' --force
		```

	#### Managing pgrx environments

	- Check the status of your pgrx-managed PostgreSQL instances:
		```sh
		cargo pgrx status
		```
	- Stop the instance:
		```sh
		cargo pgrx stop
		```
	- Start the instance:
		```sh
		cargo pgrx start
		```
	- Get the installed PostgreSQL version for pg15:
		```sh
		cargo pgrx info version pg15
		# Output: 15.16
		```
	- Get the installation path for pg15:
		```sh
		cargo pgrx info path pg15
		# Output: $HOME/.pgrx/15.16/pgrx-install
		```
	- Get the pg_config path for pg15:
		```sh
		cargo pgrx info pg-config pg15
		# Output: $HOME/.pgrx/15.16/pgrx-install/bin/pg_config
		```
        
	#### Connect to pg15 and check extensions

	- Connect to the pg15 instance using pgrx:
		```sh
		cargo pgrx connect
		```
	  This opens a psql session connected to your local pg15 instance.

	- To check installed extensions in your database, run in psql:
		```sql
		SELECT * FROM pg_extension;
		```

	- To see available extension versions (e.g., for fsm):
		```sql
		SELECT * FROM pg_available_extension_versions WHERE name LIKE '%fsm%';
		```


2. **Create a new extension:**
	 - Use the following command to scaffold a new extension:
		 ```sh
		 cargo pgrx new fsm_core
		 ```


### Daily Development Workflow

#### Prerequisites

Before starting the extension in a development environment, ensure the following PostgreSQL extensions are available:

1. **Dependencies:**
	- `fsm_core` depends on the `ltree` and `pgmq` extensions.
2. **ltree:**
	- `ltree` is available on most PostgreSQL servers as a built-in extension. You can usually install it with:
	  ```sql
	  CREATE EXTENSION ltree;
	  ```
3. **pgmq:**
	- `pgmq` is not installed by default. There are several ways to install it:

	  - **a. Install via the `pgxn` CLI:**
	    Use the [PGXN client](https://pgxn.github.io/pgxnclient/) to install `pgmq` directly:
	    ```sh
	    pgxn install pgmq
	    ```

	  - **b. Clone and build from source:**
	    Clone the `pgmq` repository, build it, and place the resulting files into your PostgreSQL extension directory. See the [pgmq GitHub repo](https://github.com/tembo-io/pgmq) for build instructions.

	  - **c. Download and install via SQL:**
		1. Download the `pgmq` SQL file from the [pgmq releases page](https://github.com/tembo-io/pgmq/releases), or use the provided shell script to automate this process.
		2. **Automated download:**
			 - Use the `download_pgmq.sh` script provided in the `fsm_core` directory to download the required `pgmq.sql` file for a specific version.
			 - The script takes the desired pgmq version as an argument (e.g., `v1.11.0`).
			 - It will download the SQL file from the official pgmq GitHub repository and place it in the `sql` folder next to `fsm_core--1.0-base-pgmq-v1.11.0.sql`.
			 - Example usage:
				 ```sh
				 ./download_pgmq.sh --PGMQ_VERSION "v1.11.0"
				 ```
			 - This will download:
				 https://github.com/pgmq/pgmq/blob/v1.11.0/pgmq-extension/sql/pgmq.sql
				 and save it as `fsm_core--1.0-base-pgmq-v1.11.0` in the `sql` directory.
			 
	 

---

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
