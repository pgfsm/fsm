# FSM: Finite State Machine Builder for Postgres

FSM is an open source project designed to help you build, manage, and operate finite state machines directly within PostgreSQL. It provides a robust framework for modeling stateful workflows, automating transitions, and tracking state changes in your database.

## Features

- Define states and transitions using SQL or API
- Enforce state transition rules at the database level
- Track history and audit state changes
- Integrate with application logic for workflow automation
- Extensible for custom actions and triggers

## Why FSM in Postgres?

PostgreSQL is a powerful relational database with advanced procedural capabilities. By embedding FSM logic in Postgres, you gain:

- Transactional guarantees for state changes
- Centralized workflow management
- Easy integration with existing data models
- Performance and reliability


## Monorepo Structure & Language Management

This repository is organized as a monorepo, containing multiple packages and components for building and integrating finite state machines across different environments.

- **`packages/`**: Directory for shared libraries or reusable packages.
- **`apps/`**: Directory for standalone applications.

We use [proto](https://moonrepo.dev/docs/proto/overview) to manage multiple programming languages and their versions within the repo. This ensures consistent development environments and smooth collaboration, regardless of whether you are working with SQL, JavaScript/Node.js, Python, or other supported languages.

**Key points:**
- All language versions are defined and managed via proto configuration files.
- Developers can easily install and switch between required language versions using proto commands.
- This approach supports polyglot development and simplifies onboarding for contributors.

See the `proto` documentation and the repo's configuration files for more details on supported languages and setup instructions.


## Contributing

Contributions are welcome! Please open issues or submit pull requests for new features, bug fixes, or documentation improvements.

## License

This project is licensed under the MIT License.

---

For more details, see the [docs](docs/) or contact the maintainers.
