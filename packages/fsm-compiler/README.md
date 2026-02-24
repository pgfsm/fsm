# FSM Compiler

This project is a TypeScript-based FSM (Finite State Machine) compiler built for Deno.

## Overview

The FSM Compiler transforms FSM schema definitions into code or artifacts suitable for integration with other systems, such as databases or application logic. It is designed to be fast, modular, and easy to use within Deno environments.

## Features
- Written in TypeScript, runs natively on Deno
- Parses FSM schema files (JSON, YAML, or custom formats)
- Generates code, SQL, or other artifacts for FSM integration
- Extensible for custom output targets
- CLI and API usage

## Getting Started

### Prerequisites
- [Deno](https://deno.com/) (version 1.30+ recommended)

### Installation
No installation required. Run directly with Deno:

```sh
deno run --allow-read --allow-write src/main.ts <options>
```

### Usage

#### CLI Example
```sh
deno run --allow-read --allow-write src/main.ts --input fsm.schema.json --output fsm.sql
```

#### API Example
```typescript
import { compileFSM } from "./src/compiler.ts";

const schema = await Deno.readTextFile("fsm.schema.json");
const result = compileFSM(schema);
console.log(result);
```

### Options
- `--input <file>`: Path to FSM schema file
- `--output <file>`: Path to output file (SQL, code, etc.)
- `--format <type>`: Output format (sql, ts, json, etc.)

## Project Structure
- `src/` — Main source code
- `tests/` — Test cases and sample schemas
- `README.md` — Project documentation

## Development
- Use Deno for running, testing, and formatting
- Run tests:
  ```sh
  deno test --allow-read
  ```
- Format code:
  ```sh
  deno fmt
  ```


### Deno Version Management
The Deno version is managed by `.prototools`, which is created using the command:

```
proto install Deno --pin local
```

This ensures consistent Deno versioning across development environments.


## License
MIT

## Author
Niraj 

---
For more details, see the source code and comments in each module.
