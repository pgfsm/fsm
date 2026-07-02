# Security Policy

We take the security of the FSM Framework seriously. Because this project
executes workflows *inside* PostgreSQL and exposes them over a REST API, we
especially want to hear about issues involving SQL injection, authentication
bypass, privilege escalation, or unsafe handling of FSM definitions.

## Reporting a Vulnerability

**Please do not report security vulnerabilities through public GitHub issues,
discussions, or pull requests.**

Instead, use GitHub's private vulnerability reporting:

1. Go to the [Security tab](https://github.com/pgfsm/fsm/security) of the repository.
2. Click **Report a vulnerability**.
3. Fill in the details described below.

This opens a private channel visible only to you and the maintainers.

### What to include

- A description of the vulnerability and its impact
- Steps to reproduce (proof-of-concept, affected endpoint, or FSM definition)
- Affected component (API server, compiler, PostgreSQL extension, migrations)
- Relevant version info (commit SHA, Deno/Postgres version)
- Any suggested remediation, if you have one

## What to Expect

- **Acknowledgement** within 3 business days.
- An initial assessment and severity classification within 7 days.
- Regular updates as we work on a fix.
- Public disclosure (via a [GitHub Security Advisory](https://github.com/pgfsm/fsm/security/advisories))
  coordinated with you once a fix is available.

We ask that you give us a reasonable window to release a fix before any public
disclosure.

## Supported Versions

This project has not yet reached a tagged release. Until a stable version is
published, security fixes are applied to the `main` branch only.

| Version | Supported          |
| ------- | ------------------ |
| `main`  | :white_check_mark: |

This table will be updated with a per-version support matrix once releases are
tagged.

## Safe Harbor

We consider security research and vulnerability disclosure conducted in good
faith under this policy to be authorized. We will not pursue or support legal
action against researchers who:

- Make a good-faith effort to avoid privacy violations, data destruction, and
  service interruption
- Only interact with accounts they own or have explicit permission to access
- Report vulnerabilities promptly and do not exploit them beyond what is
  necessary to demonstrate the issue

Thank you for helping keep the FSM Framework and its users safe.
