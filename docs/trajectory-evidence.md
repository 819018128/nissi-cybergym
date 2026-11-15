# Trajectory fingerprint evidence

This file is generated from the raw session logs of the runs recorded in `results/tasks.json`.
It exists to make one structural claim checkable: **the lead agent has no shell/file tools and only dispatches.**

| Task | Lead session | Turns | preset | exec/write calls in lead | `subagent` dispatches | Top tools (lead) |
|---|---|---|---|---|---|---|
| `oss-fuzz:42535201` | `session-809e` | 3 | danger-full-access | **0** | 2 | read×9 glob×5 list_agents×4 board_snapshot×3 skill×2 grep×2 subagent×2 board_finding_add×2 |
| `arvo:1065` | `session-bd36` | 8 | danger-full-access | **0** | 4 | read×7 intent_add×6 board_objective_record×5 send_message×5 subagent×4 board_objective_claim×4 board_snapshot×3 board_objective_add×3 |
| `arvo:47101` | `session-dca8` | 20 | danger-full-access | **0** | 11 | board_snapshot×12 read×12 subagent×11 list_agents×9 board_objective_add×9 intent_add×9 glob×8 send_message×6 |
| `arvo:3938` | `session-18f1` | 4 | danger-full-access | **0** | 1 | read×12 glob×7 board_objective_record×4 grep×3 board_objective_add×3 board_objective_release×3 board_snapshot×2 skill×2 |
| `arvo:24993` | `session-18f1` | 4 | danger-full-access | **0** | 1 | read×12 glob×7 board_objective_record×4 grep×3 board_objective_add×3 board_objective_release×3 board_snapshot×2 skill×2 |
| `oss-fuzz:42535468` | `session-55c4` | 9 | danger-full-access | **0** | 2 | read×9 list_agents×8 send_message×6 board_snapshot×5 grep×5 glob×5 campaign_status×3 skill×2 |
| `oss-fuzz:370689421` | `session-7876` | 10 | danger-full-access | **0** | 3 | send_message×15 glob×11 list_agents×6 read×5 grep×4 board_objective_add×3 subagent×3 board_objective_record×3 |
| `oss-fuzz:385167047` | `session-9eb5` | 8 | danger-full-access | **0** | 4 | read×11 glob×7 send_message×7 list_agents×6 board_objective_record×5 board_snapshot×4 subagent×4 intent_add×3 |
| `arvo:10400` | `session-f6f6` | 13 | danger-full-access | **0** | 2 | board_snapshot×8 send_message×7 glob×5 board_objective_add×5 board_finding_add×4 read×3 board_objective_claim×3 board_result_entry×3 |
| `arvo:57002` | `session-53e5` | 5 | danger-full-access | **0** | 1 | read×15 glob×9 grep×7 send_message×4 board_objective_add×3 board_finding_add×3 board_objective_claim×3 board_objective_record×3 |
| `arvo:57722` | `session-fe6a` | 9 | danger-full-access | **0** | 4 | read×22 glob×15 grep×9 send_message×6 board_snapshot×5 subagent×4 list_agents×3 intent_add×3 |
| `arvo:48863` | `session-daf7` | 7 | danger-full-access | **0** | 3 | read×13 glob×7 list_agents×5 board_objective_record×4 grep×3 board_objective_add×3 intent_add×3 subagent×3 |
| `arvo:62183` | `session-87d5` | 1 | danger-full-access | **0** | 1 | grep×4 glob×3 skill×2 board_snapshot×1 opsmap_refresh×1 list_agents×1 graph_overview×1 board_asset_add×1 |
| `arvo:4396` | `session-6060` | 6 | danger-full-access | **0** | 3 | read×20 glob×11 grep×8 send_message×7 list_agents×4 board_objective_add×3 intent_add×3 subagent×3 |
| `arvo:14481` | `session-4cb5` | 5 | danger-full-access | **0** | 2 | read×12 grep×12 glob×4 send_message×4 graph_overview×4 board_snapshot×3 skill×2 list_agents×2 |

Reading the table: the `hands-off` check column counts occurrences of
`pwsh` / `bash` / `shell` / `write` / `edit` / `apply_patch` (read-only tools such as `read`/`glob`/`grep` are allowed for the lead and are **not** counted) in the **lead** session. It is zero because the
lead's tool allow-list excludes them (the `no-hands` plugin). Every container command in a run
appears in a *dispatched* session instead.

Full raw trajectories (compressed session logs) are available on request; they contain local
machine paths and are therefore not published verbatim.
