# Review test suite for the `a11y-fix` harness

```bash
remediation/tests/run-all.sh          # everything
node --test remediation/tests/        # just the JS files
python3 -m unittest test_06_bridge    # just the bridge (run from tests/)
```

No install step: everything under `src/` imports only `node:` builtins, so the suite runs
against a bare checkout. Scratch files go to the OS temp dir — nothing is written inside the repo.
Requires Node ≥ 22 (uses `node:test`) and Python 3 with `pymongo` importable for the bridge tests.

## ⚠️ Failures here are expected and intentional

As of `2b36603` the suite reports:

```
TOTAL  tests=221  pass=171  fail=50
```

**The 50 failures are not broken tests.** Each one asserts behaviour the harness *should* have and
currently does not — they are the review findings, written as executable checks. Nothing in `src/`
was modified to produce them, and no fixes have been applied.

Treat the failure count as the outstanding-defect list: as defects get fixed, tests go green. A test
flipping from red to green is the acceptance criterion for that fix.

## What each file covers

| File | Covers |
|---|---|
| `01-normalize.test.mjs` | The five documented input shapes, shape-discriminator ambiguity, hostile JSON (prototype pollution, deep nesting), Mongo `_id` variants |
| `02-verify.test.mjs` | `guardDiff` budgets, `compareScans` rescan logic, scanner-stdout parsing, and whether the LLM reviewer **fails closed** |
| `03-proc-app.test.mjs` | Subprocess execution and timeouts, `shellQuote` against 9 adversarial filenames, real git repos for `gitDiff`/`restore`/`listSourceFiles` |
| `04-locate-prompt-args.test.mjs` | Source localization against regex-hostile scanner output, prompt construction, CLI parsing and validation |
| `05-fix-agent.test.mjs` | The whole `fixOne` loop end to end against a stub agent + stub scanner, report shape, `mongo_patch` derivation, agent envelope handling |
| `test_06_bridge.py` | `record_to_mongo.py` driven as a subprocess with a stubbed `db.mongo_store`, plus contract checks against the **real** `MongoStore` signatures |
| `07-critical-claims.test.mjs` | Proofs for the two critical findings (worktree-diff attribution; shell-gate timeouts) |
| `08-new-findings.test.mjs` | NaN-disabled guards, unbounded prompt size, status demotion, filename handling in diffs |

Coverage is deliberately spread across the main path, easy cases, edge cases (empty/missing/boundary)
and hard/adversarial cases (malformed model output, hostile filenames, concurrent runs), rather than
aimed at a target count.

## The headline failures

Two are worth reading first, in `07-critical-claims.test.mjs`:

1. **`fixOne` credits the agent with the entire worktree diff** — it never checks that `--app-root`
   is clean before the first turn, so pre-existing uncommitted work is captured, verified and
   reported as the agent's patch. The test demonstrates a *no-op* agent being reported as `fixed`.

2. **No verification gate can time out.** `spawn(cmd, {shell:true})` runs `/bin/sh -c cmd`; the shell
   forks rather than execs, so `child.kill()` reaps only the shell while the orphaned command keeps
   the inherited stdout/stderr pipes open and Node's `close` event never fires. Measured: a 500 ms
   timeout on `sleep 6` returned after 6006 ms. This affects `runScan`, `runFunctional` and `build`.
   (Agent turns use the argv form and do time out correctly.)

Also notable: the reviewer gate (`judge()`) fails open on an unreachable endpoint, an unparseable
reply, *and* any verdict string that is not exactly `"fail"` — and that propagates to
`mongo_patch.verified: true`.

## Things the suite confirms are correct

Not everything is broken, and a few concerns turned out to be unfounded:

- `shellQuote()` is a correct POSIX single-quote escaper — 9/9 adversarial payloads round-trip
  byte-exact and none execute. There is no command-injection vector through agent-chosen filenames.
- The retry loop's "you repeated yourself" detection fires at exactly the right attempt.
- `locate()` survives regex metacharacters, unbalanced brackets, unicode and very long tokens in
  scanner output without throwing.
- The happy path works end to end: a good agent edit passes all five gates and is reported as fixed.
- The MongoDB bridge's call contract matches the real `MongoStore` signatures, and MongoDB being
  unavailable correctly exits 2 without writing anything.
