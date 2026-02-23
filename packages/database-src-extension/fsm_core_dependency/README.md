## fsm_core_dependency Helper Project

This Python project provides helper scripts and utilities to:

- Install the `pgxn` CLI (PostgreSQL Extension Network client) in your environment.
- Use `pgxn` to download and install PostgreSQL extensions such as `pgmq` that are required for `fsm_core` extension development and testing.

### Purpose

Some PostgreSQL extensions (like `pgmq`) are not available by default and must be installed from external sources. This project streamlines the process by:

- Automating the installation of the `pgxn` CLI using Python tools (e.g., pip, uv, or requirements.txt).
- Providing scripts or instructions to fetch and install extensions needed for FSM development.

### Usage

#### 1. Add pgxnclient to your project (using uv):
```sh
uv add pgxnclient
```

#### 2. Activate your virtual environment:
```sh
source .venv/bin/activate
```

#### 3. Download the pgmq extension using pgxnclient:
```sh
pgxnclient download pgmq
```

#### 4. Install pgmq extension specifying the pg_config path
```sh	
pgxnclient install pgmq --pg_config "$HOME/.pgrx/15.16/pgrx-install/bin/pg_config"
```

You can now use the downloaded pgmq extension files as needed for fsm_core development.