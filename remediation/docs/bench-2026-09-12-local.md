# Bench: local stand-in (OpenClaw 2026.7.1 embedded + Ollama qwen3:8b, thinking off, reviewer on), 2026-09-12

3 staged violations x 3 runs from a clean checkout. "fixed" = passed all five gates (diff guard, build, rescan, functional check, reviewer).

| violation | run | status | attempts | seconds | files | failure |
|---|---|---|---|---|---|---|
| button-name#0 | 1 | fixed | 1 | 35 | demo-app/src/components/UploadButton.jsx |  |
| button-name#0 | 2 | fixed | 1 | 37 | demo-app/src/components/UploadButton.jsx |  |
| button-name#0 | 3 | fixed | 1 | 37 | demo-app/src/components/UploadButton.jsx |  |
| label#0 | 1 | fixed | 1 | 34 | demo-app/src/components/EnrollForm.jsx |  |
| label#0 | 2 | fixed | 1 | 33 | demo-app/src/components/EnrollForm.jsx |  |
| label#0 | 3 | fixed | 1 | 30 | demo-app/src/components/EnrollForm.jsx |  |
| keyboard-trap#0 | 1 | fixed | 1 | 56 | demo-app/src/components/SettingsDialog.jsx |  |
| keyboard-trap#0 | 2 | failed | 3 | 155 | demo-app/src/components/SettingsDialog.jsx | judge: The diff does not include handling the Escape key to close the dialog as required; The diff does not store the focus ref |
| keyboard-trap#0 | 3 | fixed | 1 | 52 | demo-app/src/components/SettingsDialog.jsx |  |

**Summary**
- button-name#0: 3/3 fixed, attempts 1/1/1
- label#0: 3/3 fixed, attempts 1/1/1
- keyboard-trap#0: 2/3 fixed, attempts 1/3/1
Notes: the one failure is a correct rejection (reviewer refused a Close-button-only patch lacking the Escape handler). Raw axe-core input (`axe.run()` JSON) verified end-to-end for button-name and label, including rescan via raw axe. On the GB10 the agent and reviewer run on Qwen3.6-35B-A3B, which is expected to be stronger than this 8B stand-in.

## Keyboard-trap rerun after tightening the reviewer (added controls must be wired) and the rule guidance

| violation | run | status | attempts | seconds | files | failure |
|---|---|---|---|---|---|---|
| keyboard-trap#0 | 1 | fixed | 1 | 59 | demo-app/src/components/SettingsDialog.jsx |  |
| keyboard-trap#0 | 2 | fixed | 2 | 117 | demo-app/src/components/SettingsDialog.jsx |  |
| keyboard-trap#0 | 3 | fixed | 1 | 62 | demo-app/src/components/SettingsDialog.jsx |  |
**Summary**
- keyboard-trap#0: 3/3 fixed, attempts 1/2/1- keyboard-trap#0: 3/3 fixed, attempts 1/2/1