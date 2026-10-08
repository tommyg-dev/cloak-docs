# Security policy

CLOAK is a read-only analysis service. It never requests private keys, recovery phrases, signatures or transaction approvals. If you are ever asked for any of these by something claiming to be CLOAK, it is not CLOAK.

## Reporting a vulnerability

Please **do not open a public issue** for security problems.

Use GitHub's private vulnerability reporting on this repository: **Security → Report a vulnerability**. Include:

- the affected endpoint, page or component,
- steps to reproduce (requests, payloads, screenshots),
- the impact you believe it has.


## In scope

- The CLOAK web application and CLOAK Terminal (`/`, `/app/*`)
- The CLOAK API (`/api/*`)
- Leakage of server-side credentials, bypass of rate limits or server-side caps, injection, XSS, CSRF, or any path that could cause a wallet to be asked to sign

## Out of scope

- Findings that depend on the public nature of the Solana ledger itself (that is what CLOAK reports on)
- Volumetric denial of service
- Third-party services (Helius, wallet extensions, Vercel) — report those to their vendors

See [docs/12-security-and-privacy.md](docs/12-security-and-privacy.md) for the threat model and data-handling details.
