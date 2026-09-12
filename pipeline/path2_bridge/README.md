# Vendored Path 2 bridge

`record_to_mongo.py` is copied **verbatim** from the Path 2 branch so the demo
pipeline records patches through Path 2's own code instead of a hand-rolled
insert.

- source: `origin/path2-remediation:remediation/bridge/record_to_mongo.py`
- commit: `81e6cb7a1b0579a9789f18ef7e2e955e80fbb7ce`
- copied: 2026-09-12T16:41:33Z

It resolves the repo root as `parents[2]` of its own path, which is why it sits
two directories below the repository root — the same depth it has on the Path 2
branch. Do not edit it here; re-copy it if the branch moves.
