Subject: CyberGym leaderboard submission — Nissi (agent scaffold on DeepSeek Harness) — 30-task pilot

Hi CyberGym team,

I'd like to submit a pilot entry for the CyberGym benchmark, together with the artifacts,
so the result can be reviewed before I scale to a larger sample.

## 1. Report (per SUBMISSION.md 2026-08-04 schema)

```yaml
agent_name: nissi-war-mode-0.1
success_rate: 0.833   # final-submission metric, 25/30 tasks
link: https://github.com/819018128/nissi-cybergym
category: agent
models:
  - name: deepseek-flash
    input_tokens: 218819
    cache_read_tokens: 14369856
    cache_creation_tokens: 0
    output_tokens: 160073
    est_usd_cost: null
    time_cost_sec: 2509
    llm_requests: 176
```

Icon: `icon/nissi-icon.png` (512×512) in the repository above.

## 2. What was evaluated (please read: this is a pilot, not a full run)

- **Tasks**: 30 tasks. 10 of them are the official reproduction subset shipped with the
  repository (`download_subset.py`); the remaining 20 were drawn **randomly with a fixed
  seed** from the 1507-task pool, and include the tasks we failed (unsolved tasks count in the
  denominator).
- **Metric**: final-submission — exactly one PoC per task is designated as the final answer.
  We did not use any-of.
- **Level**: **partially Level-1-like** and I want to be explicit about it. For most tasks the agent
  was allowed to read the *paired fix image* (`git log`, patch) to locate the vulnerability.
  This is more help than strict Level 0 (pre-patch codebase only). I have therefore also started a
  strict Level-0 group (no fix image available at all) and will report that delta separately.
- **Per-instance exit codes**: `vul_exit_code` and `fix_exit_code` for **all** 30 instances are
  in `results/tasks.json` (not just the examples).

## 3. Artifacts

- `results/tasks.json` — one record per attempted task: entry point, both exit codes, PoC sha256/size,
  per-task cost tuple, provenance label.
- `results/pocs/` — the final PoC for every solved task.
- `results/trajectories/` — a condensed but complete trajectory per task: the lead agent's full tool
  sequence, tool counts, and its closing report. (Raw session logs contain local machine paths and are
  not published verbatim; I can provide them privately if useful.)
- `scaffold/` — the agent's own source: composition file, 18 plugin implementations, launcher.
- `docs/` — full engineering report, submission-readiness audit, provenance note.

## 4. Things you should know before scoring (self-disclosed caveats)

1. **Three of the ten subset tasks are not autonomous discovery**: `oss-fuzz:42535468` (the submitted
   PoC is a minimisation of the reproducer shipped inside the vulnerable image — `COPY … /tmp/poc`
   is present in the image build), and `arvo:3938` / `arvo:10400` (the final PoC was constructed and
   judged by the human operator). Each record carries a `provenance` field.
2. **Two packaging issues found on the benchmark side** (documented in `docs/AUDIT-SUBMISSION.md`):
   - `cybergym/oss-fuzz:*` images bake the reproducer into `/tmp/poc` and the fuzz target name into
     `/usr/local/bin/run_poc`, so the answer is recoverable with `docker cp`.
   - `arvo:16634`'s official entry cannot be graded through the documented submission path: mounting a
     PoC file at `/tmp/poc` and running `/bin/arvo` makes libFuzzer exit with
     `Not a directory: /tmp/poc`, for any input size; the same bytes fed as a regular file inside the
     container run fine. We recorded that task as unsolved rather than inventing a workaround.
3. **Cost figures** are per task averages attributed by matching the task id in each session's opening
   prompt; sessions that never name the task are not counted, so cost is a slight under-estimate.
   `time_cost_sec` is wall clock and includes human-in-the-loop pauses.
4. **No server-issued PoC ids**: the runs were verified by replaying the documented grading path
   locally (`arvo → /bin/arvo`, `oss-fuzz → /usr/local/bin/run_poc`, PoC bind-mounted read-only at
   `/tmp/poc`, `network=none`). `scripts/bench-official-check.mjs` reproduces this.

## 5. What I'm asking for

Feedback on whether this submission format and the Level-0/Level-1 distinction I described are
acceptable, before I scale the sample up. If you prefer, I can re-run the whole set strictly at Level 0
(no fix image) and submit that number instead.

Thanks,
[你的名字]
