# JamPoker — Project State

## Environments
- Firebase project: **jam-poker**
- Site (live): **https://jampoker.web.app/**
- Functions (gen2, us-central1): **ping**, **onSeatsChanged**, **onVariantChosen**, **onHandEnded**
- GitHub CI: deploys Functions + Hosting (+ rules) on merges to **main**

## Current Features
- Lobby/Admin basic UI
- Players + wallets (CRUD) — dev rules (no auth yet)
- Tables (create/join/leave)
- **Auto hand start** when ≥2 seated
- **Blinds auto-posted** (SB/BB → pot; seat stacks deducted)
- **Preflop skeleton** (fold, check/call, min-raise; server-validated; ends hand after round)
- **Streets engine** merged: preflop→flop→turn→river + board, but UI render depends on table wiring (see “Open Issues”)

## Open Issues / Next Steps
- **brief-11c**: Seats wiring + Admin delete hotfix
  - Ensure Lobby “Join” writes to `tables/{tableId}/seats/{playerId}` using the REAL `tableId` (doc.id).
  - Ensure Table page subscribes to the SAME `tableId`.
  - Relax Admin delete (dev) via HTTPS Functions so no key needed.
- Verify **Board UI** renders in /table.html after closing preflop.
- Later: Hand evaluator (Texas/Omaha), showdown settlement, Auth, stricter rules.

## How to Resume Quickly
1. Open a new chat and say: “Use Codex with repo **Mappledude/jampoker**. Follow **docs/PROJECT_STATE.md**.”
2. Ask for the next brief number (start with **brief-11c** if not merged).
3. After each PR merges, wait for the GitHub Action to go green, then test:
   - Lobby: join with 2 players → Open Table
   - Table: action panel for current actor; board appears on flop/turn/river
