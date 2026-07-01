# PGXN Publish

## Tasks

| # | Task | Status | Notes |
|---|------|--------|-------|
| 1 | Verify curl upload command works end-to-end | 🔲 Pending | Test `npm run pgxnBuildAndPublish -- -u USER -p PASS` against a real PGXN account |
| 2 | Evaluate PGXN dev tool as alternative to curl | 🔲 Pending | Check if [pgxn-utils](https://github.com/guedes/pgxn-utils) or the official PGXN client offers a more reliable upload path than raw curl |
| 3 | Confirm `provides.file` is accepted by PGXN Manager | 🔲 Pending | Currently points to `fsm_core--1.0.0.sql` (base install); verify PGXN Manager accepts this for a distribution at a higher version |
| 4 | Test full round-trip: build → upload → install via `pgxn install fsm_core` | 🔲 Pending | Confirms the zip structure, META.json, and .control file are all valid from a consumer's perspective |
