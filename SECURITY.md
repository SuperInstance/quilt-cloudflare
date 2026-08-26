# Security Policy

## Supported versions

| Version | Supported          |
| ------- | ------------------ |
| latest  | :white_check_mark: |
| < latest| :x:                |

Only the latest released version of Quilt receives security updates. Please upgrade before reporting issues against older versions.

## Reporting a vulnerability

**Please do not file a public issue for security vulnerabilities.**

Email security concerns to: `security@superinstance.dev` (PGP key on request).
You can also use [GitHub's private vulnerability reporting](https://docs.github.com/en/code-security/security-advisories/guidance-on-reporting-and-writing-information-about-vulnerabilities/privately-reporting-a-security-vulnerability) — open a draft security advisory on the affected repo.

Include:
- Affected repo and version
- Reproduction steps or proof-of-concept
- Impact assessment (what data / systems are at risk)
- Any known mitigations

We aim to:
- **Acknowledge** within 3 business days
- **Triage** within 7 days
- **Patch critical issues** within 30 days
- **Coordinate disclosure** with reporters on timing

## Sandboxing and trust model

Quilt evaluates cells. Cells can be:
- **Pure** (`value`, `formula`) — safe by construction
- **Sandboxed** (`program` in TS uses `new Function` with a restricted scope) — limited risk
- **Trusted** (`api`, `sensor`, `io`, `ai`) — these make network calls or invoke external services

Never load a sheet from an untrusted source without reviewing every cell. The `quilt validate <file>` command checks the structural schema; it does not check that the contents of `program`, `api`, or `io` cells are safe.

## Out of scope

- Issues in upstream dependencies (please report to the upstream project)
- Issues requiring physical access to the user's machine
- Social engineering attacks

## Recognition

We credit security researchers (with their permission) in the release notes when we ship a fix. If you'd like to be acknowledged under a different name or anonymously, just say so in your report.
