# Capability audit — the mission subsystem

Status: 2026-08-26. Baseline `npm test` in `dsh-agents-swarm`: 241 pass, 0 fail.

Three sources of truth are compared here, and keeping them apart is the whole
point of the exercise:

1. **The design** — `docs/insight-mission.md`, 3385 lines, written against
   playground as its stated reference and already carrying a §10 comparison.
2. **The implementation** — `dsh-agents-swarm/lib/`, 46,394 lines.
3. **The reference** — `genesis-agent-teams/backend/src/modules/ai-app/playground`
   (37,502 lines of product code, 69,820 of tests) and
   `frontend/components/agent-playground` (44,117 lines, 92 files).

The two are the same design implemented twice: playground's stage files are
`s1-mission-estimate-budget … s12-self-evolution`; ours are `s1-brief … s12-persist`
(`lib/mission-runtime.js:547`). Playground's role directories are
`leader/researcher/analyst/reconciler/reviewer/verifier/writer/steward`; ours are
`lib/mission/agents/{analyst,leader,reconciler,researcher,reviewer,verifier,writer}`.

**Method.** Every row below was checked against the code, not against a directory
name or a document. A capability counts as built only if a table exists, a route
answers, or a caller reaches it. Three rows changed verdict during the audit
because of that rule — the claim ledger, the fact table, and execution replay all
have code that looks like the feature and no path that reaches it.

---

## 1. What is built

Stated first so the gaps are read against a real baseline rather than an implied
zero.

| Area | State | Evidence |
|---|---|---|
| 12-stage pipeline with a declared DAG | built | `mission-runtime.js:547` — every stage declares `reads/writes/dbWrites/successors/backEdge/rerunable/rerunReason/invalidates` |
| 7 agents, one ReAct loop, one finalize gate | built | `mission-agent.js`, `lib/mission/agents/` |
| Tool registry, one door, ACL, recall, circuit, pacers | built | `mission-tools.js`, `createPacer` shared with `insight-corroborate.js` |
| Verbatim quote verification + evidence boundary | built | the counting state gates facts, chapters and sign-off (`mission-store.js:2729`) |
| Budget tiers, gate, estimate-and-reconcile, shrink ladder | built | `mission-budget.js`, `LADDER` single copy in `mission-stages-front.js` |
| Transactions, terminal-write arbitration, boot-id liveness, checkpoint/resume | built | `withTx`/`SAVEPOINT` in `mission-store.js`; `boot_id`; `runtime_owner` |
| Rerun fresh / incremental, `run_count` generations | built | `run_count` keys `mission_findings`, `mission_chapters`, `mission_artifacts` |
| Event replay by cursor + SSE | built | `GET …?action=events&since=<seq>`, `streamEvents` |
| Read model: 6 panes, trajectory with filters, cost pane | built | `mission-view.js`, `client.js`; 241 tests cover the projector |
| 16 mission tables | built | `MISSION_MIGRATIONS` 001-spine … 005-tool-args |

That is Phases 0–4 of the design's §11 build order, complete.

---

## 2. Gap A — spec debt: Phase 5 was never built

§11's last phase is *availability and learning*. Four of its five items do not
exist, and the code says so out loud in one place:

```js
// lib/mission-stages-front.js:551
// the claim ledger the postmortem corpus would come from does not exist yet.
postmortems: {
  available: false,
  why: "there is no claim ledger yet, so no postmortem corpus can be read.",
  entries: [],
},
```

Every mission plans from zero. Fifty missions teach the planner nothing.

| # | Capability | Design § | State | Evidence | Consequence |
|---|---|---|---|---|---|
| A1 | `mission_postmortems` | §4.8 | **missing** | no `CREATE TABLE` anywhere in `lib/` | s2 plans with `available:false` forever; no stage-duration corpus, no model success rate |
| A2 | `failure_patterns` + `applied_count`/`success_after` | §4.8, §5.5 | **missing** | grep `failure_patterns` → 0 hits | the three-beat loop (consult → apply → measure) has no store; a remedy that hurts is never withdrawn |
| A3 | Claim ledger repointed onto `insights`/`insight_evidence`, `origin` column | §4.8 | **missing** | `insights` has no `origin`; `client.js` calls `/insights/list`, `/insights/status`, `/insights/run-now` **zero times** | 4,678 lines of standing-claim engine (`insight-store.js`, `insight-extract.js`, `insight-corroborate.js`) are reachable only by HTTP that nothing issues. A mission's verified findings die with the mission |
| A4 | `mission_traces` + execution replay + golden fixtures | §6.2 | **missing** | `action=trace` serves the *trajectory* (events + tool calls, filtered) — a different feature that shares the word | a prompt edit is shipped-and-watched, not tested. The nine canonical mission states listed in §6.2 would have to be hand-authored |
| A5 | `mission_facts`, `mission_conflicts`, `mission_conflict_facts` | §11 phase 2 | **missing** | facts live inside s5/s6 stage-output JSON; `conflictIdFor` computes ids that are never rows | the fact table is not queryable, conflicts are not indexable, and a forecast's `factId` anchor points into a JSON blob |

A3 is the largest single piece of dead capital in the repository, and it is the
one the design says the whole 洞察 tab was for.

---

## 3. Gap B — reference parity, backend

Capabilities playground has that we do not, ordered by what they buy.

| # | Capability | Reference | Ours | Note |
|---|---|---|---|---|
| B1 | **Prediction calibration (Brier)** | `mission/calibration/prediction-calibration.service.ts` + `prediction-recalibration.scheduler.ts` + `AgentPlaygroundPredictionRecord`: record at s11 → scheduler scans due → web search + LLM adjudication with a forced evidence URL → backfill `actualOutcome` + Brier → `getTopicCalibration` feeds the next mission's confidence | forecasts are **produced** and well-formed — probability, resolution criteria, and a mandatory `factId` anchor (`mission-stages-middle.js:1415-1428`), plus a red-team pre-mortem (`mission-stages-back.js:1252`) — and then never revisited | we do the hard half and skip the cheap half. Nothing tells the user whether last month's forecasts came true |
| B2 | **Self-evolution (s12)** | postmortem → cross-mission `(topic, model, failureCode)` blacklist → vector memory of report + high-scoring findings, recalled by the next Researcher | none | same root as A1/A2 |
| B3 | **Steward role + budget stewardship** | 8th agent, `skills/budget-stewardship` | `mission-budget.js` is static tiers + a ledger | no agent participates in spending decisions mid-run |
| B4 | **s8b section quality enhancement, s9b objective evaluation** | two extra stages; `multi-judge-mission-review`, `objective-report-evaluation`, `report-meta-critic` | s9 deterministic scorecard + one `critical` LLM persona | **deliberate.** §10 argues a 3-persona consensus on one model is a fake number. Not a gap — a decision. Listed so it is not "fixed" by accident |
| B5 | **Externalised skills** | 18 `SKILL.md` files, versionable and replaceable | prompts inline in stage files | a prompt change is a code change |
| B6 | **Front/back contracts** | `api/contracts/`: `stage-contracts.registry`, `word-budget`, `chapter-count`, `dimension-tool-matrix`, `step-id-mapping`, `view-state` | view shape is `mission-view.js`'s unilateral projection | our DAG declaration covers most of what their registry does; the view-state contract has no analogue |
| B7 | **Event-sourced read models** | 5 projectors (`mission-view`, `stage-view`, `agent-view`, `artifact`, `todo-board`) + `playground.event-schemas` | `mission_events` exists; read models query tables directly | our events are durable but not the source of the view |
| B8 | **Rerun subsystem** | 8 services: auto-recovery, guard, orchestrator, resume policy, stage dispatcher, ctx hydrator, runtime builder, local rerun | fresh / incremental + checkpoint resume | no automatic recovery, no per-stage rerun dispatch |
| B9 | **Model failover** | up to 12 in-run substitutions, records what worked | one model, no fallback | **deliberate**, stated in §10 as `SINGLE_MODEL_NO_FALLBACK` |

---

## 4. Gap C — reference parity, UI

This is the widest gap by ratio. Their mission UI is 44,117 lines across 92
files in nine directories; our entire plugin UI — 信源 + 洞察 + 发布 — is 10,989
lines in one file.

| # | View | Reference | Ours |
|---|---|---|---|
| C1 | **Stage DAG** | `dag/MissionDagView` + `mission-dag.controller/service/types` | none. `client.js` contains the string `DAG` **zero** times — while `STAGES` already declares the full edge set. The data is built and never drawn |
| C2 | **Report versions** | `artifact/ReportVersionDrawer`, `MissionReportVersion` | `run_count` already versions findings/chapters/artefacts in SQL; the UI cannot switch between them |
| C3 | **Leader chat mid-mission** | `modals/LeaderChatModal` + `mission/chat/` + `AgentPlaygroundLeaderChat` | s4-assess is fully automatic; a person cannot intervene while a mission runs |
| C4 | **Todo board** | `board/MissionTodoBoard` + `TodoDetailDrawer` + `todo-board.projector` | one "收尾待办" line |
| C5 | **Live agent roster** | `roster/AgentLiveGrid`, `TeamRosterPanel` | no per-agent live view |
| C6 | **Reader matrix** | `ArtifactReader`/`ChapterReader`/`ContinuousReader`/`QuickReader`, `FactTablePanel`, `ReconciliationPanel`, `ToolRecallTrace`, `QualityBadge` | one reading view; no fact table, no reconciliation panel |
| C7 | **Panels** | 11: budget/time, capability meters, compute usage, cost breakdown, dimensions, lead journal, memory index, references, report, stage process, verify consensus | 6 panes: stages, dimensions, evidence, report, trajectory, references (+ cost) |
| C8 | **Raw event log / flow view** | `flow/MissionFlowView`, `RawEventLog` | a short event tail at the bottom of the detail |
| C9 | **Mission graph** | `MissionGraphTab` + `mission-graph.service/analysis` + `PlaygroundMissionGraph` | none |

---

## 5. What we have that the reference does not

Listed so the parity work does not trade it away.

- **A verifier that means something.** Playground's verifier is `loop: 'simple'`
  with no tools and no caller; `verified` is permanently 0 by its own SKILL.md.
  Ours fetches, verifies contiguous spans, and its counts force the Leader's
  refusal. §10.1.
- **The library as a free lead index**, compounding: every fetched page is
  upserted back into `resources`. §10.2.
- **One process, one pacer** — arXiv is reachable here and was abandoned there.
  §10.3.
- **Transactional stage commits** — stage output, cross-state, progress marker
  and checkpoint in one transaction. Playground's checkpoint save is
  fire-and-forget with a swallowed failure. §10.4.
- **Boot reclamation by boot id**, not by heartbeat.
- **Absence carries a reason.** `projectStageInsights` returns `null` plus which
  of three absences this is, never `{}`.
- **The DAG declaration** does in one table what their `stage-contracts.registry`
  plus `rerun-guard` plus `resume-rerun-policy` do across eight files.

---

## 6. Backlog, in order

Cost is engineering days at the density of the surrounding code, including tests.

| Order | Work | Closes | Cost | Why here |
|---|---|---|---|---|
| 1 | `mission_postmortems` + `failure_patterns`, postlude writes, s2 reads, three-beat loop with `applied_count`/`success_after` | A1, A2, half of B2 | 2–3d | Deletes a hardcoded `available:false`. Every later item gets a memory to write into |
| 2 | Claim ledger repoint: `origin` column, postlude claim reconciliation from verified findings, `/insights/*` wired into the tab | A3 | 3–4d | Turns 4,678 dead lines into the product's namesake feature |
| 3 | Forecast ledger: `mission_forecasts`, due scan, adjudication with a forced evidence URL, Brier, feedback into s6 | B1 | 3–4d | We already emit falsifiable forecasts; this is the missing return path |
| 4 | Fact and conflict tables | A5 | 2d | Makes the forecast anchor and the reconciliation panel queryable |
| 5 | Stage DAG view | C1 | 1d | Pure front-end over data that already exists |
| 6 | Report version switching | C2 | 1d | Pure front-end over `run_count` |
| 7 | `mission_traces` + execution replay + golden fixtures | A4 | 4–5d | Makes prompt edits testable; nine canonical states become recordings |
| 8 | Leader chat mid-mission | C3 | 3d | Needs a new interrupt path into a running mission |
| 9 | Externalised skills | B5 | 2d | Mechanical, once prompts stop being edited weekly |

Items 1–4 are spec debt: the design specifies them and the code stubs them.
Items 5–9 are reference parity.

---

## Related

- [`insight-mission.md`](insight-mission.md) — the design this audits against
- [`insights.md`](insights.md) — the standing-claim model item 2 repoints onto
- [`architecture.md`](architecture.md) — where the process runs
