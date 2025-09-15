# Jam Poker

### Lockfiles
CI prefers deterministic installs via `npm ci`. If you develop locally, run `npm install` at repo root and in `functions/` to generate/refresh:
- ./package-lock.json
- ./functions/package-lock.json

Commit both lockfiles so CI can use `npm ci`. Without them, CI falls back to `npm install`.
