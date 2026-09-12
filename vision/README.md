# Vision judge

GuardRail's visual accessibility audit: local **gemma4:26b** (Gemma 4 26B MoE, vision +
tools + thinking) judges screenshots for the WCAG failures axe-core cannot see from the
DOM, and reviews the page's visual design with an accessibility lens.

| file | role |
|---|---|
| `vision/Modelfile`, `vision/setup.sh` | build `guardrail-vision` (FROM gemma4:26b, `num_ctx 32768` pinned, temperature 1.0 / top_p 0.95 / top_k 64) after checking the base model's capabilities |
| `scripts/vision-capture.js` | Playwright capture: 1280px + 320px screenshots cut into section regions, real-Tab focus pairs, axe's undecided contrast nodes (+ text-hidden background shots), small-target measurements, and an element map for grounding |
| `pipeline/vision_judge.py` | Ollama `/api/chat` client: images, JSON schema in `format`, `think` per call |
| `pipeline/vision_audit.py` | plans the 5 judging calls (layout 1280, reflow 320, focus, contrast, design review; targets only when the spacing exception fails), runs them in parallel, grounds `box_2d` boxes onto elements, dedupes against axe/keyboard findings, scores confidence, draws annotated screenshots, caches judgements; `regression_check` is the pipeline's `visual` gate (thinking off) |

Why `num_ctx 32768`: it is 4x the largest vision call measured (8.3K tokens) and equals
this server's `OLLAMA_CONTEXT_LENGTH`, so `guardrail-vision` and plain `gemma4:26b`
(patching, reviewer) share one loaded runner. With different contexts Ollama needs two
runners of the same weights and does not evict an idle one: a `gemma4:26b` call waited
behind an idle 262144-context vision runner until it timed out. As a guard, the audit
unloads mismatched gemma4 runners before its calls, and the pipeline releases the vision
runner after the vision stage.

Run alone: `python3 pipeline/vision_audit.py demo/index.html [--fresh]` → artifacts and
`vision-report.json` under `pipeline/runs/vision-<timestamp>/`.
