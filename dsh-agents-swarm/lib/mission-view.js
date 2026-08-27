/**
 * The mission read model: stored state projected into what a person watches.
 *
 * One question, asked per request: given only what is on disk, what is this
 * mission doing right now? Two halves answer it, and the split is the design:
 *
 *   readMissionViewInput(db, missionId)  — every SELECT, and nothing else
 *   projectMissionView(input)            — a pure fold: no db, no clock, no writes
 *
 * WHY IT PROJECTS FROM THE COUNTER TABLES AND NOT FROM THE EVENT LOG.
 * The first version of this design fed the projector the complete un-evicted
 * event stream and had the client refetch on every event. A three-hour `deep`
 * mission with chunk-level narration produces tens of thousands of rows in
 * `mission_events`, and every SSE tick would then trigger a full synchronous
 * re-fold on the SAME BLOCKING CONNECTION the mission itself is writing
 * through — the projector becomes the thing that stalls the mission it is
 * describing. So state comes from `mission_stages`, `mission_dimensions`,
 * `mission_chapters`, a `COUNT(*)` over `mission_findings` grouped by
 * `verify_state`, and `SUM` over `mission_spend` / `mission_tool_calls`. All
 * indexed, all already carrying the numbers. The event log keeps its
 * no-eviction guarantee (§4.7); it is the READ that is bounded, to a 200-row
 * tail, not the write.
 *
 * WHY THE STAGE STATUS COLUMN IS TRUSTED. `mission_stages.status` is written in
 * the same transaction as the stage output, so the column IS the last verb — a
 * `done -> started` sequence during a rerun leaves the column at `running` with
 * no fold required. That single property is what let the event fold be deleted,
 * so do not reintroduce a fold "just for stages".
 *
 * WHY THERE ARE NO REFRESH HINTS. The reference needs a six-family hint
 * taxonomy, fetch coalescing and a polling fallback because its projection is
 * expensive and lives elsewhere; and because hints are injected only by its
 * live socket adapter, a dropped WebSocket freezes every canonical-only field
 * for ever. Its frontend then re-derives cost-by-stage, agent traces and
 * dimension pipelines from raw events and merges them into the canonical view.
 * A synchronous fold over indexed SQLite is cheap enough that the client can
 * simply refetch, so there is exactly one truth. If a field ever looks like it
 * needs a client-side derive, that is the signal to add it HERE.
 *
 * WHY IT NEVER WRITES, AND WHAT THAT COSTS. §9.1 requires every terminal sweep
 * to emit `projector:swept` naming what it repaired, because the first version
 * repaired the display silently — which would have made a genuinely missing
 * terminal emit invisible for ever, and nobody would ever learn that the
 * `finally` in the dimension latch had broken. A pure function cannot emit, so
 * the repairs are RETURNED as `view.swept[]`. The projection is idempotent, so
 * `swept` is recomputed identically on every request: the caller must emit it
 * at most once per mission — the natural place is `finalize`'s `onWon`, which
 * runs exactly once — and never once per poll. A healthy mission returns
 * `swept.length === 0`, and there is a test that asserts exactly that.
 *
 * WHY `now` IS A PARAMETER. Elapsed time, the wall-clock ratio and the stall
 * notice all need the present. Reading the clock inside would make the fold
 * impure and every fixture test time-dependent, so the present arrives in
 * `policy.now` — the same convention `insights.js` already uses for novelty
 * decay.
 *
 * WHAT IT DELIBERATELY DOES NOT OWN. The status vocabulary, the stage
 * catalogue, the budget LADDER, the depth tiers and `canResume()` all live with
 * their owners and arrive in `policy`. The reference kept four hand-copied
 * copies of one status list, each missing a different member, and shipped a
 * cancel button that stayed lit and 400'd for ever because the display mapping
 * fell through to `return 'running'`. Every copy is another list somebody can
 * forget, so this module holds none of them.
 *
 * THE SECOND PROJECTION IN THIS FILE. `buildMissionTrace` and its neighbours,
 * at the foot of the module, answer the other question — "what did this mission
 * DO, in order, one row per thing" — for the trajectory tab. It is here rather
 * than in the routes because it is the same kind of thing: a pure fold over
 * rows somebody else read, testable from fixtures with no database. It is a
 * separate function rather than more fields on the view because it is read on
 * demand, once, by a tab a person opened, and the view is read on a poll — and
 * the whole reason the view projects from counters is that the expensive
 * question must not be asked on the cheap question's schedule.
 *
 * No imports. No dependencies. Synchronous throughout, matching store.js's 45
 * call sites and zero awaits.
 */

/**
 * How many event rows the 实况 pane reads. The write side is unbounded (§4.7);
 * this is the only bound, and it is on the read.
 */
export const MISSION_VIEW_TAIL_DEFAULT = 200;

/**
 * Statuses that mean the mission is over.
 *
 * Kept as an explicit set rather than "anything that is not running", because
 * an UNKNOWN status must not read as running. A row whose status this module
 * has never heard of is treated as terminal when it carries `completed_at`;
 * defaulting to running is what manufactures a forever-running mission with a
 * live cancel button that 400s on every click.
 */
const TERMINAL_STATUSES = Object.freeze(["completed", "failed", "cancelled", "quality-failed"]);

/**
 * The one verify state that counts as evidence.
 *
 * §4.4 is explicit: only `verified-source-text` counts toward the floors, the
 * chapter supply contract and the sign-off ratio.
 */
const VERIFIED = "verified-source-text";

/**
 * Reported separately, and flagged, because the design has a live tension here.
 *
 * §4.4 defines `verified-adjacent-spans` as a genuine verification — two
 * consecutive spans of the same fetched block — that exists precisely so a TRUE
 * quote straddling a Markdown paragraph break is not fed back to the model as a
 * fabrication. The same section then says only `verified-source-text` counts
 * toward the floors. Both may be intended. This module follows the letter of
 * the rule and does NOT count it, but gives it its own field so the choice is
 * visible on the dimension card rather than discovered later inside a gate that
 * will not open.
 */
const VERIFIED_ADJACENT = "verified-adjacent-spans";

/**
 * The abstract-backed state, admissible at a discount.
 *
 * §0.1 measured the library: `resources` has no body column and its abstracts
 * average 234 characters, so a quote that verifies against a publisher abstract
 * is genuine publisher text but thin evidence. Shown as its own number, never
 * folded into the verified count.
 */
const VERIFIED_ABSTRACT = "verified-abstract";

/**
 * States meaning "we never got to check", matched by PREFIX rather than listed.
 *
 * A 429 returned as an empty result is this repository's signature bug, and
 * collapsing a refusal into a fabrication reproduces it in the column every
 * gate reads. Matching the prefix rather than enumerating the members means a
 * new `unchecked-*` state added to §4.4 appears here automatically instead of
 * silently landing in the fabrication bucket — which is how a copied vocabulary
 * drifts in the first place.
 */
const UNCHECKED_PREFIX = "unchecked-";

/** The `unchecked-` member that means a backend refused us, not that we failed. */
const UNCHECKED_RATE_LIMITED = "unchecked-rate-limited";

/**
 * Why an artefact is absent. Three reasons, and the split is load-bearing.
 *
 * A sentinel that means two different things is a `?? default` wearing a
 * costume. `not-yet-materialized` is a legitimate "not yet"; `write-failed` is
 * a failure we actually observed; `terminal-without-artifact` is "the mission
 * is over, there is no artefact, and nothing told us why" — which §5.5 says
 * should be impossible, because every failure path persists its partials and
 * writes a version. Reporting the third as the first would hide a broken
 * failure path behind a perfectly reasonable-looking sentinel.
 */
export const EMPTY_ARTIFACT_REASONS = Object.freeze([
  "not-yet-materialized",
  "write-failed",
  "terminal-without-artifact",
]);

/** The event that proves an artefact write was attempted and failed. */
const ARTIFACT_WRITE_FAILED_EVENT = "artifact:write-failed";

/** The six scarce quantities, in the order the compact meter strip prints them. */
const COST_DIMENSIONS = Object.freeze(["tokens", "calls", "arxiv", "web", "fetch", "wall"]);

/**
 * Above this, the estimate and the ledger are reported as disagreeing rather
 * than reconciled into one number.
 *
 * §8.3: the live pool is an ESTIMATE — usage arrives as one chunk at the end,
 * so there is no running token count — and `SUM(mission_spend)` is exact. They
 * are two different quantities. The reference shipped a state where the top
 * card showed $0 while the summary strip beside it showed $5.70; saying "these
 * two numbers disagree by 22%" is strictly more useful than picking one.
 */
const DRIFT_TOLERANCE = 0.15;

/**
 * Stage statuses that mean the stage has stopped, one way or another.
 * `skipped-by-tier` is here because a tier that does not run a stage has not
 * left work outstanding — §4.3 writes those rows at `s1` precisely so the UI
 * never has to guess whether a missing row is pending or excluded.
 */
const STAGE_RESOLVED = Object.freeze(["done", "failed", "degraded", "skipped-by-tier"]);

/** Dimension states that mean collection has stopped. */
const DIMENSION_RESOLVED = Object.freeze(["collected", "degraded", "failed"]);

// ── the pure projection ──────────────────────────────────────────────────────

/**
 * Project stored mission state into the view a person watches.
 * @param {object} input - everything read from disk; see `readMissionViewInput`.
 * @param {object} input.row - the `missions` row. Required; a missing row is an error, not an empty view.
 * @param {object[]} input.stages - `mission_stages` rows for this mission.
 * @param {object[]} input.dimensions - `mission_dimensions` rows, each carrying `counts` and `unique_hosts`.
 * @param {object[]} input.chapters - `mission_chapters` rows across every generation.
 * @param {object} input.spendSums - ledger aggregates; see `readMissionViewInput`.
 * @param {object[]} input.artefacts - `mission_artifacts` rows WITHOUT `markdown` or `evidence`.
 * @param {object[]} input.eventTail - a bounded tail of `mission_events`, any order.
 * @param {object} input.policy - stage catalogue, LADDER, `now`, and resolved policy answers.
 * @returns {object} `{mission, stages, dimensions, agents, todo, work, cost, artifact, timeline, resume, swept}`.
 */
export function projectMissionView(input) {
  const { row, policy } = input ?? {};
  if (!row || typeof row !== "object") {
    throw new TypeError("projectMissionView: `row` is required. Read the missions row first; a missing mission is a 404 at the route, not an empty view here.");
  }
  requirePolicy(policy);

  const stageRows = asArray(input.stages);
  const dimensionRows = asArray(input.dimensions);
  const chapterRows = asArray(input.chapters);
  const artefactRows = asArray(input.artefacts);
  const spendSums = input.spendSums ?? {};
  const eventTail = dedupeEvents(asArray(input.eventTail));

  const now = policy.now;
  const terminal = isTerminal(row);
  // Asymmetric on purpose (§9.1). On a completed mission we know the work
  // finished, so unfinished rows are forced done. On ANY other terminal state
  // we know only that the work started — forcing those to done is fabrication.
  const sweepTo = !terminal ? null : row.status === "completed" ? "done" : "failed";
  const swept = [];

  const runCount = numberOr(row.run_count, 1);
  const stages = projectStages({ stageRows, policy, now, sweepTo, swept });
  const chapters = projectChapters({ chapterRows, runCount, sweepTo, swept });
  const dimensions = projectDimensions({ dimensionRows, row, chapters, sweepTo, swept });
  const agents = projectAgents({ stages, dimensions, spendSums, sweepTo, swept });
  const cost = projectCost({ row, spendSums, stages, chapters, policy, now });
  const artifact = pickArtifact({ artefactRows, row, runCount, eventTail, terminal });
  const evidence = rollUpEvidence(dimensions);
  const timeline = projectTimeline({ eventTail, stages, evidence, artifact, input });
  const resume = projectResume({ row, policy, terminal });
  const todo = buildTodo({ stages, dimensions, chapters, terminal, resume });
  const work = buildWork({ stages, stageRows, dimensions });

  const mission = projectMission({
    row, policy, now, terminal, runCount, stages, dimensions, chapters,
    evidence, artifact, cost, swept,
  });

  // `todo` is kept beside `work` for one release rather than deleted with it.
  // Nothing in lib/client.js reads it — grep returns zero hits — but a field a
  // route has been returning is a field something outside this repository may
  // have started reading, and removing it in the same change that adds its
  // replacement leaves such a reader with no working version to move between.
  return { mission, stages, dimensions, agents, todo, work, cost, artifact, timeline, resume, swept };
}

/**
 * Reject a `policy` that is missing something the projection cannot invent.
 *
 * Every one of these has an owner elsewhere. Defaulting any of them here would
 * create the second copy that later drifts, so an absent field is a programming
 * error with a message naming who owns it.
 * @param {object} policy - the resolved policy bag.
 * @returns {void}
 */
function requirePolicy(policy) {
  if (!policy || typeof policy !== "object") {
    throw new TypeError("projectMissionView: `policy` is required. Pass {stages, ladder, now} at minimum.");
  }
  if (!Array.isArray(policy.stages) || policy.stages.length === 0) {
    throw new TypeError("projectMissionView: `policy.stages` must be the stage catalogue array. Pass the same frozen array validateStageDag() checks at init — this module must not keep a second copy of the pipeline.");
  }
  if (!policy.ladder || typeof policy.ladder.soften !== "number" || typeof policy.ladder.freeze !== "number" || typeof policy.ladder.warn !== "number") {
    throw new TypeError("projectMissionView: `policy.ladder` must be the frozen LADDER object from the budget module (§8.4). The meter's colour ramp, the degrade level and the warning text all read the same numbers; a local copy here is how 0.90 and 0.70 end up disagreeing.");
  }
  const now = policy.now;
  if (typeof now !== "number" || !Number.isFinite(now)) {
    throw new TypeError("projectMissionView: `policy.now` must be a finite epoch-millisecond number. The clock is a parameter so this stays a pure fold and fixtures stay time-independent — pass Date.now() at the route.");
  }
}

/**
 * Twelve stage rows, always, in catalogue order.
 *
 * Driven by `policy.stages` rather than by whatever the table happens to hold,
 * because §4.3 promises the count is invariant and the UI must never have to
 * decide whether a missing row means pending or excluded. Position comes from
 * the row's literal `ordinal`, never from a stage number: the reference shares
 * number 8 between `s8` and `s8b`, so a checkpoint saved after `s8` lists `s8b`
 * complete and a resume silently skips the whole section-quality stage while
 * reporting success.
 * @param {object} args - `{stageRows, policy, now, sweepTo, swept}`.
 * @returns {object[]} one entry per catalogue stage, plus any unknown row, ordered.
 */
function projectStages({ stageRows, policy, now, sweepTo, swept }) {
  const byId = new Map();
  for (const r of stageRows) if (r && r.step_id != null) byId.set(String(r.step_id), r);

  const out = [];
  const missing = [];

  for (let i = 0; i < policy.stages.length; i += 1) {
    const decl = policy.stages[i];
    const id = String(decl.id);
    const r = byId.get(id);
    byId.delete(id);

    if (!r) {
      // §4.3 writes twelve rows at mission open, including `skipped-by-tier`
      // for the stages this tier does not run. A hole here is not "pending yet"
      // — it means s1 did not finish its own bookkeeping.
      missing.push(id);
      out.push(blankStage(decl, i));
      continue;
    }

    const status = String(r.status ?? "pending");
    const startedAt = r.started_at ?? null;
    const stalled = status === "running" && decl.stallMs > 0 && startedAt != null
      && now - toMs(startedAt) > decl.stallMs;

    out.push({
      stepId: id,
      ordinal: numberOr(r.ordinal, i),
      agent: decl.agent ?? null,
      mode: decl.mode ?? null,
      status,
      attempts: numberOr(r.attempts, 0),
      startedAt,
      endedAt: r.ended_at ?? null,
      durationMs: r.duration_ms == null ? null : numberOr(r.duration_ms, 0),
      degradeNote: r.degrade_note ?? null,
      // `stallMs` is visibility only. There is no kill timer: the reference
      // deleted its per-stage deadline after it repeatedly killed fan-outs that
      // were demonstrably alive, emitting a progress event every second,
      // because the deadline could not see sub-events. Locally a paced arXiv
      // round plus a serialised jsdom parse make a long-but-healthy stage the
      // normal case, so this is a notice and nothing more.
      stalled,
      // Tokens come from the ledger, not from `mission_stages.tokens`. The
      // column is a denormalised copy, and §4.4 already paid for the lesson
      // that a counter with several writers and one critical reader drifts.
      tokens: 0,
      calls: 0,
    });
  }

  if (missing.length > 0) {
    swept.push({
      kind: "stage-rows-missing",
      key: missing.join(","),
      from: null,
      to: "pending",
      repaired: false,
      reason: `§4.3 requires one mission_stages row per catalogue stage, written at s1. ${missing.length} are absent, so the strip is showing pending for stages whose real state is unknown. Check that s1 wrote its skipped-by-tier rows.`,
    });
  }

  // A row the catalogue does not know is pipeline drift, and dropping it is
  // exactly how a stage disappears from the display while still running.
  for (const [id, r] of byId) {
    out.push({
      stepId: id, ordinal: numberOr(r.ordinal, out.length), agent: null, mode: null,
      status: String(r.status ?? "pending"), attempts: numberOr(r.attempts, 0),
      startedAt: r.started_at ?? null, endedAt: r.ended_at ?? null,
      durationMs: r.duration_ms == null ? null : numberOr(r.duration_ms, 0),
      degradeNote: r.degrade_note ?? null, stalled: false, tokens: 0, calls: 0,
      unknownToCatalogue: true,
    });
    swept.push({
      kind: "stage-row-unknown",
      key: id,
      from: String(r.status ?? "pending"),
      to: null,
      repaired: false,
      reason: `mission_stages holds step id "${id}", which is not in the stage catalogue. Either the pipeline changed under an in-flight mission or a stage id was renamed without a migration; a resume across this is the silent-skip failure §2 opens by describing.`,
    });
  }

  out.sort((a, b) => a.ordinal - b.ordinal);

  if (sweepTo) {
    for (const s of out) {
      if (s.status !== "running") continue;
      const to = sweepTo === "done" ? "done" : "failed";
      swept.push({
        kind: "stage", key: s.stepId, from: "running", to, repaired: true,
        reason: sweepTo === "done"
          ? `Mission is completed but stage ${s.stepId} is still marked running — its terminal write never landed. Displayed as done; the missing write is the bug.`
          : `Mission ended without completing while stage ${s.stepId} was still running. Forced to failed, never done: we know the work started, not that it finished.`,
      });
      s.status = to;
      s.sweptFrom = "running";
    }
  }

  return out;
}

/** A catalogue stage with no row behind it. Pending, and never invented as done. */
function blankStage(decl, index) {
  return {
    stepId: String(decl.id), ordinal: index, agent: decl.agent ?? null, mode: decl.mode ?? null,
    status: "pending", attempts: 0, startedAt: null, endedAt: null, durationMs: null,
    degradeNote: null, stalled: false, tokens: 0, calls: 0, rowMissing: true,
  };
}

/**
 * Chapters of the CURRENT generation, with a derived state.
 *
 * `mission_chapters` has no status column — it has `attempts`, a `body` and a
 * `decision` — so the state is derived from those three. Filtered to
 * `row.run_count` because a rerun writes a new generation and deletes nothing
 * (§6.1): showing every generation at once would double every count on the
 * first rerun.
 * @param {object} args - `{chapterRows, runCount, sweepTo, swept}`.
 * @returns {object[]} chapters of this generation, ordered.
 */
function projectChapters({ chapterRows, runCount, sweepTo, swept }) {
  const out = [];
  for (const r of chapterRows) {
    if (r == null) continue;
    if (numberOr(r.run_count, runCount) !== runCount) continue;
    const attempts = numberOr(r.attempts, 0);
    // `body_length` when the reader supplied it, the column itself otherwise.
    // The reader deliberately does not SELECT `body` — a deep mission's chapter
    // bodies are the report — so presence has to travel as a length. Reading
    // only `r.body` here would make every stored chapter look empty and every
    // chapter card read `pending` on a finished mission.
    const hasBody = r.body_length != null
      ? numberOr(r.body_length, 0) > 0
      : typeof r.body === "string" && r.body.length > 0;
    const decision = r.decision ?? null;
    const state = decision ? "done" : attempts > 0 || hasBody ? "writing" : "pending";
    out.push({
      dimensionId: String(r.dimension_id ?? ""),
      chapterIndex: numberOr(r.chapter_index, 0),
      sectionType: r.section_type ?? null,
      heading: r.heading ?? "",
      state,
      decision,
      score: r.score == null ? null : Number(r.score),
      attempts,
      wordCount: numberOr(r.word_count, 0),
      minDelivery: numberOr(r.min_delivery, 0),
      underDelivered: truthy(r.under_delivered),
      // Empty body with a decision is the hole s12's content guard exists to
      // catch: the assembly succeeded over nothing.
      bodyMissing: !hasBody,
    });
  }
  out.sort((a, b) => (a.dimensionId < b.dimensionId ? -1 : a.dimensionId > b.dimensionId ? 1 : a.chapterIndex - b.chapterIndex));

  if (sweepTo) {
    for (const c of out) {
      if (c.state !== "writing") continue;
      const to = sweepTo === "done" ? "done" : "failed";
      swept.push({
        kind: "chapter", key: `${c.dimensionId}#${c.chapterIndex}`, from: "writing", to, repaired: true,
        reason: sweepTo === "done"
          ? `Mission is completed but chapter ${c.dimensionId}#${c.chapterIndex} has no decision recorded — the write loop left without writing one.`
          : `Mission ended without completing while chapter ${c.dimensionId}#${c.chapterIndex} was still being written. Forced to failed, never done.`,
      });
      c.state = to;
      c.sweptFrom = "writing";
    }
  }
  return out;
}

/**
 * The per-dimension cards: the pane a mission is actually watched in.
 *
 * This is where the six-value `verify_state` earns its width. "4 fetches failed
 * with 429" and "4 quotes were invented" are the same number in the same place
 * and require opposite responses, so they are never summed into one figure.
 * @param {object} args - `{dimensionRows, row, chapters, sweepTo, swept}`.
 * @returns {object[]} one card per dimension.
 */
function projectDimensions({ dimensionRows, row, chapters, sweepTo, swept }) {
  const chaptersByDim = new Map();
  for (const c of chapters) {
    const list = chaptersByDim.get(c.dimensionId);
    if (list) list.push(c);
    else chaptersByDim.set(c.dimensionId, [c]);
  }

  // Written once by s3 and read by s4's flags, the retry prompt and the
  // researcher's own check(). Null until s3 has measured supply — and null must
  // render as "not derived yet", never as zero, or every dimension reads as
  // passing a floor nobody has set.
  const floor = row.derived_floor == null ? null : numberOr(row.derived_floor, 0);

  const out = [];
  for (const r of dimensionRows) {
    if (r == null) continue;
    const counts = normaliseCounts(r.counts);
    const buckets = bucketCounts(counts);
    const state = String(r.state ?? "pending");
    const dimensionId = String(r.dimension_id ?? "");
    const dimChapters = chaptersByDim.get(dimensionId) ?? [];

    out.push({
      dimensionId,
      name: r.name ?? dimensionId,
      facet: r.facet ?? null,
      rationale: r.rationale ?? null,
      state,
      attempt: numberOr(r.attempt, 0),
      grade: r.grade == null ? null : Number(r.grade),
      gradeAxes: parseJson(r.grade_axes, null),
      summary: r.summary ?? null,
      failureCode: r.failure_code ?? null,
      updatedAt: r.updated_at ?? null,

      // The floor currency, and only it.
      verified: buckets.verified,
      // Reported and shown, discounted. §0.1.
      verifiedAbstract: buckets.verifiedAbstract,
      // Surfaced on its own; see VERIFIED_ADJACENT for the tension.
      verifiedAdjacent: buckets.verifiedAdjacent,
      // Availability, not quality. Rendered WITH the reason, never merged.
      unchecked: buckets.unchecked,
      uncheckedTotal: buckets.uncheckedTotal,
      // Quality problems: found in the wrong source, or found nowhere.
      unverifiable: counts.unverifiable ?? 0,
      misattributed: counts.misattributed ?? 0,
      tooShort: counts["too-short"] ?? 0,
      // Anything §4.4 grows that this module has not been taught. Present so a
      // new state shows up as a number rather than disappearing.
      otherStates: buckets.other,
      counts,

      // Distinct hosts among verified findings. Counting articles instead of
      // hosts is how the whole model of independence collapses, so this is a
      // COUNT(DISTINCT source_host) and not a row count.
      uniqueHosts: numberOr(r.unique_hosts, 0),

      floor,
      meetsFloor: floor == null ? null : buckets.verified >= floor,
      chapters: summariseChapters(dimChapters),
      // Availability trouble worth a colour on the card even while collecting.
      blocked: buckets.unchecked[UNCHECKED_RATE_LIMITED] > 0,
    });
  }

  out.sort((a, b) => (a.dimensionId < b.dimensionId ? -1 : a.dimensionId > b.dimensionId ? 1 : 0));

  if (sweepTo) {
    for (const d of out) {
      if (DIMENSION_RESOLVED.includes(d.state) || d.state === "pending") continue;
      const to = sweepTo === "done" ? "collected" : "failed";
      swept.push({
        kind: "dimension", key: d.dimensionId, from: d.state, to, repaired: true,
        reason: sweepTo === "done"
          ? `Mission is completed but dimension ${d.dimensionId} is still ${d.state} — its terminal event never fired. That card would otherwise read "awaiting score" for ever, which is the exact symptom a missing finally in the dimension latch produces.`
          : `Mission ended without completing while dimension ${d.dimensionId} was ${d.state}. Forced to failed, never collected.`,
      });
      d.state = to;
      d.sweptFrom = d.sweptFrom ?? "collecting";
    }
  }

  return out;
}

/** Fold a dimension's chapters into the four numbers the card shows. */
function summariseChapters(list) {
  let done = 0, writing = 0, pending = 0, failed = 0, underDelivered = 0, rewrites = 0;
  for (const c of list) {
    if (c.state === "done") done += 1;
    else if (c.state === "writing") writing += 1;
    else if (c.state === "failed") failed += 1;
    else pending += 1;
    if (c.underDelivered) underDelivered += 1;
    if (c.attempts > 1) rewrites += c.attempts - 1;
  }
  return { total: list.length, done, writing, pending, failed, underDelivered, rewrites };
}

/**
 * Split a verify-state histogram into the buckets the UI must not merge.
 * @param {object} counts - `{[verifyState]: n}` straight from the GROUP BY.
 * @returns {object} named buckets plus an `other` map for states we do not know.
 */
function bucketCounts(counts) {
  // Null-prototype, because the keys are whatever `verify_state` holds — a TEXT
  // column. On a plain object literal a row whose state was `__proto__` would
  // be silently swallowed by the setter rather than counted, and a finding that
  // disappears from a count is the one thing this pane must never do.
  const unchecked = Object.create(null);
  const other = Object.create(null);
  let uncheckedTotal = 0;
  let total = 0;

  for (const [state, n] of Object.entries(counts)) {
    const v = numberOr(n, 0);
    total += v;
    if (state.startsWith(UNCHECKED_PREFIX)) {
      unchecked[state] = v;
      uncheckedTotal += v;
      continue;
    }
    if (state === VERIFIED || state === VERIFIED_ABSTRACT || state === VERIFIED_ADJACENT) continue;
    if (state === "unverifiable" || state === "misattributed" || state === "too-short") continue;
    other[state] = v;
  }
  if (unchecked[UNCHECKED_RATE_LIMITED] === undefined) unchecked[UNCHECKED_RATE_LIMITED] = 0;

  return {
    verified: numberOr(counts[VERIFIED], 0),
    verifiedAbstract: numberOr(counts[VERIFIED_ABSTRACT], 0),
    verifiedAdjacent: numberOr(counts[VERIFIED_ADJACENT], 0),
    unchecked,
    uncheckedTotal,
    other,
    total,
  };
}

/**
 * Roll the per-dimension histograms into one mission-wide evidence summary.
 * @param {object[]} dimensions - projected dimension cards.
 * @returns {object} totals plus the verifiable denominator §7.6 requires.
 */
function rollUpEvidence(dimensions) {
  const counts = Object.create(null);
  let uniqueHostSum = 0;
  for (const d of dimensions) {
    uniqueHostSum += d.uniqueHosts;
    for (const [state, n] of Object.entries(d.counts)) {
      counts[state] = (counts[state] ?? 0) + numberOr(n, 0);
    }
  }
  const b = bucketCounts(counts);
  const rateLimited = b.unchecked[UNCHECKED_RATE_LIMITED] ?? 0;

  // §7.6: a rate-limited check is excluded from the denominator rather than
  // scored as a failure to verify. Rate-limited is not zero results, all the
  // way up.
  const denominator = b.total - rateLimited;

  return {
    counts,
    total: b.total,
    verified: b.verified,
    verifiedAbstract: b.verifiedAbstract,
    verifiedAdjacent: b.verifiedAdjacent,
    unchecked: b.unchecked,
    uncheckedTotal: b.uncheckedTotal,
    unverifiable: numberOr(counts.unverifiable, 0),
    misattributed: numberOr(counts.misattributed, 0),
    tooShort: numberOr(counts["too-short"], 0),
    other: b.other,
    rateLimited,
    denominator,
    // Null, never 1 and never NaN, when there is nothing to divide by. A
    // mission with no citations at all presenting as fully verified is the
    // failure §12 names and s12's content guard treats as fatal.
    verifiedRatio: denominator > 0 ? b.verified / denominator : null,
    uniqueHostSum,
  };
}

/**
 * The seven agents, one entry per instance that has spent, plus every role that
 * has not spent yet.
 *
 * Built find-or-create against a Map keyed by agent id, never by pushing. That
 * is what makes the projection idempotent under a duplicated event tail: the
 * agent count cannot double because nothing is appended per observation.
 * @param {object} args - `{stages, dimensions, spendSums, sweepTo, swept}`.
 * @returns {object[]} agent rows for the trace pane.
 */
function projectAgents({ stages, dimensions, spendSums, sweepTo, swept }) {
  // Role state comes from the stages that role owns — the stage table is the
  // last verb, so an agent is running exactly when one of its stages is.
  const roleState = new Map();
  const roleStage = new Map();
  for (const s of stages) {
    if (!s.agent) continue;
    const prev = roleState.get(s.agent);
    const next = s.status === "running" ? "running"
      : STAGE_RESOLVED.includes(s.status) ? (s.status === "failed" ? "failed" : "done")
      : "pending";
    // running wins over everything; failed over done; done over pending.
    const rank = { running: 3, failed: 2, done: 1, pending: 0 };
    if (prev == null || rank[next] > rank[prev]) roleState.set(s.agent, next);
    if (s.status === "running" || !roleStage.has(s.agent)) roleStage.set(s.agent, s.stepId);
  }

  const dimensionIds = new Set(dimensions.map((d) => d.dimensionId));
  const byAgent = new Map();

  const ensure = (agentId, role) => {
    const key = agentId ?? `role:${role}`;
    let e = byAgent.get(key);
    if (e) return e;
    e = {
      agentId: agentId ?? null,
      role,
      state: roleState.get(role) ?? "pending",
      lastStepId: roleStage.get(role) ?? null,
      dimensionId: resolveDimensionId(agentId, dimensionIds),
      calls: 0,
      promptTok: 0,
      completionTok: 0,
      cacheReadTok: 0,
      tokens: 0,
      toolCalls: 0,
      toolFailures: 0,
      toolCached: 0,
    };
    byAgent.set(key, e);
    return e;
  };

  // Seed one row per role in the catalogue, so all seven are visible from the
  // first second rather than appearing one at a time as they first spend.
  for (const s of stages) if (s.agent) ensure(null, s.agent);

  for (const r of asArray(spendSums.byAgent)) {
    if (r == null) continue;
    const role = String(r.role ?? "unknown");
    const e = ensure(r.agent_id == null ? null : String(r.agent_id), role);
    e.calls += numberOr(r.calls, 0);
    e.promptTok += numberOr(r.prompt_tok, 0);
    e.completionTok += numberOr(r.completion_tok, 0);
    e.cacheReadTok += numberOr(r.cache_read_tok, 0);
    e.tokens = e.promptTok + e.completionTok + e.cacheReadTok;
    if (r.step_id != null) e.lastStepId = String(r.step_id);
  }

  for (const r of asArray(spendSums.toolsByAgent)) {
    if (r == null) continue;
    const agentId = r.agent_id == null ? null : String(r.agent_id);
    // A tool call from an agent with no spend row yet is real; give it a row
    // rather than dropping the call on the floor.
    const existing = agentId != null ? byAgent.get(agentId) : null;
    const e = existing ?? ensure(agentId, String(r.role ?? "unknown"));
    e.toolCalls += numberOr(r.calls, 0);
    e.toolFailures += numberOr(r.failures, 0);
    e.toolCached += numberOr(r.cached, 0);
  }

  const out = [...byAgent.values()];

  // A seeded role that never spent and has an instance beside it is noise on
  // the trace pane; drop the placeholder only when a real instance exists.
  const rolesWithInstances = new Set(out.filter((a) => a.agentId != null).map((a) => a.role));
  const pruned = out.filter((a) => a.agentId != null || !rolesWithInstances.has(a.role));

  pruned.sort((a, b) => {
    if (a.role !== b.role) return a.role < b.role ? -1 : 1;
    return String(a.agentId ?? "").localeCompare(String(b.agentId ?? ""));
  });

  if (sweepTo) {
    for (const a of pruned) {
      if (a.state !== "running") continue;
      const to = sweepTo === "done" ? "done" : "failed";
      swept.push({
        kind: "agent", key: a.agentId ?? `role:${a.role}`, from: "running", to, repaired: true,
        reason: sweepTo === "done"
          ? `Mission is completed but agent ${a.agentId ?? a.role} is still marked running, because the stage it owns is. Displayed as done.`
          : `Mission ended without completing while agent ${a.agentId ?? a.role} was running. Forced to failed, never done.`,
      });
      a.state = to;
      a.sweptFrom = "running";
    }
  }

  return pruned;
}

/**
 * Which dimension an agent id belongs to, by exact match rather than by guess.
 *
 * Researchers run one per dimension and the id scheme is the agent loop's, not
 * this module's. Matching the trailing segment against a KNOWN dimension id
 * means an unrecognised scheme yields null instead of a plausible wrong label.
 * @param {string|null} agentId - the ledger's agent id.
 * @param {Set<string>} dimensionIds - dimension ids for this mission.
 * @returns {string|null} the dimension, or null when the id does not name one.
 */
function resolveDimensionId(agentId, dimensionIds) {
  if (!agentId) return null;
  if (dimensionIds.has(agentId)) return agentId;
  const cut = agentId.lastIndexOf(":");
  if (cut < 0) return null;
  const tail = agentId.slice(cut + 1);
  return dimensionIds.has(tail) ? tail : null;
}

/**
 * Spend against all six ceilings, the tight one named, and the waste analysis.
 *
 * The reference infers this from three stale copies. Here every number is one
 * synchronous `SUM` over an indexed table, which is also why the projection can
 * answer after a restart with nothing in memory: the live budget pool is gone,
 * the ledger is not.
 * @param {object} args - `{row, spendSums, stages, chapters, policy, now}`.
 * @returns {object} the 账 pane.
 */
function projectCost({ row, spendSums, stages, chapters, policy, now }) {
  const totals = spendSums.totals ?? {};
  const tools = spendSums.toolsByPaceKey ?? {};

  // cache_read_tok is disjoint from prompt_tok (§4.1), so the three add without
  // double counting. Summing only prompt+completion would silently under-report
  // a cached mission against its own ceiling.
  const promptTok = numberOr(totals.prompt_tok, 0);
  const completionTok = numberOr(totals.completion_tok, 0);
  const cacheReadTok = numberOr(totals.cache_read_tok, 0);
  const estimatedTok = numberOr(totals.estimated_tok, 0);
  const tokensUsed = promptTok + completionTok + cacheReadTok;

  const effectiveStart = effectiveStartMs(row);
  const elapsedMs = terminalEndMs(row, now) - effectiveStart;

  const meters = {
    tokens: meter("tokens", tokensUsed, numberOr(row.max_tokens, 0)),
    calls: meter("calls", numberOr(totals.calls, 0), numberOr(row.max_calls, 0)),
    arxiv: meter("arxiv", numberOr(tools.arxiv, 0), numberOr(row.max_arxiv, 0)),
    web: meter("web", numberOr(tools.web, 0), numberOr(row.max_web, 0)),
    fetch: meter("fetch", numberOr(tools.fetch, 0), numberOr(row.max_fetch, 0)),
    wall: meter("wall", Math.max(0, elapsedMs), numberOr(row.wall_ms, 0)),
  };

  // The max over all dimensions, and it NAMES the dimension. An unnamed scalar
  // would almost certainly be tokens-only, so a mission that burned 100% of
  // max_arxiv at 20% of tokens would never warn and never degrade — it would
  // just start failing tool calls with no explanation.
  let tight = meters.tokens;
  for (const key of COST_DIMENSIONS) {
    const m = meters[key];
    if (m.ratio != null && (tight.ratio == null || m.ratio > tight.ratio)) tight = m;
  }

  const ratio = tight.ratio ?? 0;
  const { ladder } = policy;
  const degradeLevel = ratio >= ladder.freeze ? 2 : ratio >= ladder.soften ? 1 : 0;

  // Two quantities, not one. Reported as a disagreement past the tolerance
  // rather than reconciled into whichever number happens to be to hand.
  const exact = promptTok + completionTok;
  const driftRatio = exact > 0 ? Math.abs(estimatedTok - exact) / exact : null;

  let stageRetries = 0;
  for (const s of stages) if (s.attempts > 1) stageRetries += s.attempts - 1;
  let chapterRewrites = 0;
  let underDelivered = 0;
  for (const c of chapters) {
    if (c.attempts > 1) chapterRewrites += c.attempts - 1;
    if (c.underDelivered) underDelivered += 1;
  }

  const byStage = asArray(spendSums.byStage).map((r) => ({
    stepId: String(r.step_id ?? ""),
    role: r.role ?? null,
    calls: numberOr(r.calls, 0),
    tokens: numberOr(r.prompt_tok, 0) + numberOr(r.completion_tok, 0) + numberOr(r.cache_read_tok, 0),
  }));

  // Attach ledger tokens back onto the stage strip, so "which stage ate the
  // clock" and "which stage ate the budget" are answered from the same source.
  const stageIndex = new Map(stages.map((s) => [s.stepId, s]));
  for (const b of byStage) {
    const s = stageIndex.get(b.stepId);
    if (!s) continue;
    s.tokens += b.tokens;
    s.calls += b.calls;
  }

  return {
    ...meters,
    tight: { dimension: tight.dimension, value: tight.ratio, used: tight.used, limit: tight.limit },
    ratio,
    degradeLevel,
    // The same frozen object the ladder, the warning text and the colour ramp
    // read. Passed through rather than copied.
    ladder,
    softWarnedAt: row.soft_warned_at ?? null,
    exhaustedAt: row.exhausted_at ?? null,
    tokensBreakdown: { promptTok, completionTok, cacheReadTok },
    drift: {
      estimated: estimatedTok,
      exact,
      ratio: driftRatio,
      // Null tolerance result is not "fine" — it is "nothing to compare yet".
      exceeds: driftRatio == null ? null : driftRatio > DRIFT_TOLERANCE,
      tolerance: DRIFT_TOLERANCE,
    },
    waste: {
      stageRetries,
      chapterRewrites,
      underDeliveredChapters: underDelivered,
      toolFailures: numberOr(spendSums.toolFailures, 0),
      toolCached: numberOr(spendSums.toolCached, 0),
    },
    byStage,
    byAgent: asArray(spendSums.byAgent).map((r) => ({
      agentId: r.agent_id == null ? null : String(r.agent_id),
      role: r.role ?? null,
      calls: numberOr(r.calls, 0),
      tokens: numberOr(r.prompt_tok, 0) + numberOr(r.completion_tok, 0) + numberOr(r.cache_read_tok, 0),
    })),
    // Which TOOL spent, failed and waited. `byStage` and `byAgent` answer
    // "where did the tokens go"; this answers "which door was slow or broken",
    // and the two are not the same question — a tool that fails inside a stage
    // that succeeds is invisible in both of the others.
    //
    // `latencyMeasured` travels beside `latencyMs` and is NOT `calls`: see the
    // note on the query in `readMissionViewInput`. `avgLatencyMs` is therefore
    // computed over the measured calls and is NULL when none were measured —
    // never 0, which would read as "instant" about a tool nobody timed.
    byTool: asArray(spendSums.byTool).map((r) => {
      const calls = numberOr(r.calls, 0);
      const latencyMeasured = numberOr(r.latency_measured, 0);
      const latencyMs = numberOr(r.latency_ms, 0);
      return {
        tool: r.tool == null ? null : String(r.tool),
        calls,
        failures: numberOr(r.failures, 0),
        cached: numberOr(r.cached, 0),
        latencyMs,
        latencyMeasured,
        unmeasured: Math.max(0, calls - latencyMeasured),
        avgLatencyMs: latencyMeasured > 0 ? Math.round(latencyMs / latencyMeasured) : null,
      };
    }),
  };
}

/**
 * One ceiling. `ratio` is null when there is no limit, never 0 and never
 * Infinity — an unset ceiling must not read as "plenty left".
 * @param {string} dimension - which of the six.
 * @param {number} used - the ledger figure.
 * @param {number} limit - the frozen cap from the mission row.
 * @returns {object} `{dimension, used, limit, remaining, ratio}`.
 */
function meter(dimension, used, limit) {
  const hasLimit = Number.isFinite(limit) && limit > 0;
  return {
    dimension,
    used,
    limit: hasLimit ? limit : null,
    remaining: hasLimit ? Math.max(0, limit - used) : null,
    ratio: hasLimit ? used / limit : null,
  };
}

/**
 * The current artefact, or a stable sentinel saying why there is not one.
 *
 * Never `undefined` and never a bare null: the client branches on `kind` rather
 * than optional-chaining every field. The reason is chosen from evidence, not
 * from a default — see EMPTY_ARTIFACT_REASONS.
 * @param {object} args - `{artefactRows, row, runCount, eventTail, terminal}`.
 * @returns {object} `{kind: "artifact", ...}` or `{kind: "empty-artifact", reason}`.
 */
function pickArtifact({ artefactRows, row, runCount, eventTail, terminal }) {
  let latest = null;
  for (const r of artefactRows) {
    if (r == null) continue;
    if (latest == null || numberOr(r.version, 0) > numberOr(latest.version, 0)) latest = r;
  }

  if (latest) {
    return {
      kind: "artifact",
      version: numberOr(latest.version, 0),
      runCount: numberOr(latest.run_count, runCount),
      // A version from an earlier generation is still the current artefact, but
      // a reader must know it predates this run rather than assume it does not.
      stale: numberOr(latest.run_count, runCount) !== runCount,
      trigger: latest.trigger ?? null,
      title: latest.title ?? "",
      wordCount: numberOr(latest.word_count, 0),
      markdownBytes: latest.markdown_bytes == null ? null : numberOr(latest.markdown_bytes, 0),
      degraded: truthy(latest.degraded),
      createdAt: latest.created_at ?? null,
      sections: parseJson(latest.sections, []),
      citations: parseJson(latest.citations, []),
      quality: parseJson(latest.quality, null),
      versions: artefactRows
        .filter(Boolean)
        .map((r) => ({ version: numberOr(r.version, 0), runCount: numberOr(r.run_count, 0), trigger: r.trigger ?? null, degraded: truthy(r.degraded), createdAt: r.created_at ?? null }))
        .sort((a, b) => b.version - a.version),
    };
  }

  // Checked FIRST, and regardless of status: a running mission whose artefact
  // write just failed must not report "not yet". "Not yet" means we are still
  // expecting one; here we already tried and it did not land.
  const writeFailed = eventTail.some((e) => e && e.type === ARTIFACT_WRITE_FAILED_EVENT);
  if (writeFailed) {
    return {
      kind: "empty-artifact",
      reason: "write-failed",
      detail: "An artifact:write-failed event is in the log and no artefact row exists. The report was produced and could not be stored.",
    };
  }

  if (!terminal) {
    return {
      kind: "empty-artifact",
      reason: "not-yet-materialized",
      detail: "The mission has not reached s12. An artefact is still expected.",
    };
  }

  return {
    kind: "empty-artifact",
    reason: "terminal-without-artifact",
    // Deliberately not folded into `not-yet-materialized`. §5.5 requires every
    // failure path to persist its partials and write a version, so reaching
    // here means a failure path skipped that write and left no trace of doing
    // so. Saying "not yet" about a finished mission would hide it for ever.
    detail: `Mission ended as ${row.status} with no artefact row and no write-failure event within the read tail. §5.5 requires every terminal path to write a version, so this is a hole in a failure path, not an absence to be explained away.`,
  };
}

/**
 * The 实况 tail plus the preflight warning painted on it.
 * @param {object} args - `{eventTail, stages, evidence, artifact, input}`.
 * @returns {object} `{events, sinceSeq, latestSeq, count, preflight}`.
 */
function projectTimeline({ eventTail, stages, evidence, artifact, input }) {
  // Ascending for reading; the SQL orders DESC only so LIMIT takes the tail.
  const events = eventTail
    .map((e) => ({
      seq: numberOr(e.seq, 0),
      ts: e.ts ?? null,
      type: String(e.type ?? ""),
      // Written at insert, never reconstructed by prefix at read: a lifecycle
      // event the USER caused must never count as evidence the mission is alive.
      class: e.class ?? null,
      agentId: e.agent_id ?? null,
      payload: parseJson(e.payload, {}),
    }))
    .sort((a, b) => a.seq - b.seq);

  const s9 = stages.find((s) => s.agent === "verifier" || /(^|-)s9(-|$)/.test(s.stepId)) ?? null;

  return {
    events,
    sinceSeq: numberOr(input.sinceSeq, 0),
    latestSeq: events.length > 0 ? events[events.length - 1].seq : numberOr(input.sinceSeq, 0),
    count: events.length,
    // The read is bounded (§9.1). Say so, so a client that wants everything
    // pages with ?since= instead of assuming it has the whole log.
    bounded: true,
    preflight: projectPreflight(evidence, artifact, s9),
  };
}

/**
 * The sign-off risk, painted as soon as s9 knows it rather than sprung at s11.
 *
 * The wording differs by CAUSE because the two causes need opposite responses:
 * "7 of 41 citations failed span verification" is a quality problem, and "9 of
 * 41 could not be fetched" is an availability problem. A blocked search must
 * never silently read as evidence of absence.
 * @param {object} evidence - the mission-wide roll-up.
 * @param {object} artifact - the current artefact or its sentinel.
 * @param {object|null} s9 - the verify stage, for whether the figure is final.
 * @returns {object} `{known, risk, quality, availability, messages, blockedNotAbsent}`.
 */
function projectPreflight(evidence, artifact, s9) {
  const total = evidence.total;
  if (total === 0) {
    return {
      known: false,
      risk: "unknown",
      quality: null,
      availability: null,
      messages: [],
      blockedNotAbsent: false,
      // Not "no failures". 0/0 is the case §12 names: a mission with no
      // citations at all presenting as fully verified to the one decision the
      // pipeline converges on.
      note: "No findings recorded yet, so nothing has been verified or failed. This is not a clean bill.",
    };
  }

  const qualityFailed = evidence.unverifiable + evidence.misattributed + evidence.tooShort;
  const blocked = evidence.uncheckedTotal;
  const messages = [];
  if (qualityFailed > 0) {
    messages.push(`${qualityFailed} of ${total} citations failed span verification (${evidence.misattributed} found in a different source, ${evidence.unverifiable} found nowhere we hold, ${evidence.tooShort} below the quote floor).`);
  }
  if (blocked > 0) {
    const parts = Object.entries(evidence.unchecked)
      .filter(([, n]) => n > 0)
      .map(([state, n]) => `${n} ${state.slice(UNCHECKED_PREFIX.length)}`);
    messages.push(`${blocked} of ${total} could not be checked — ${parts.join(", ")}. This is an availability result, not evidence of absence.`);
  }

  const risk = qualityFailed > 0 && blocked > 0 ? "both"
    : qualityFailed > 0 ? "quality"
    : blocked > 0 ? "availability"
    : "none";

  return {
    // The figure is provisional until s9 has run; §9.2 wants it painted early
    // anyway, so say which it is rather than withholding it for forty minutes.
    known: s9 != null && STAGE_RESOLVED.includes(s9.status),
    risk,
    quality: { failed: qualityFailed, total, ratio: evidence.denominator > 0 ? qualityFailed / evidence.denominator : null },
    availability: { blocked, rateLimited: evidence.rateLimited, total },
    messages,
    blockedNotAbsent: evidence.rateLimited > 0,
    // After s9 the artefact's own scorecard is the authoritative version; the
    // counts above are the substrate it was computed from.
    scorecard: artifact.kind === "artifact" ? artifact.quality : null,
  };
}

/**
 * Whether a resume is on offer, and when it is not, why not.
 *
 * The projector does NOT re-implement `canResume()`. Two lists of "which
 * statuses may be rerun" that drifted apart is how a rerun gets killed in its
 * first second with zero output, so the answer arrives pre-computed in
 * `policy.canResume` and this only presents it. When it is absent the reason is
 * `not-evaluated` — never a manufactured `ok`.
 * @param {object} args - `{row, policy, terminal}`.
 * @returns {object} `{offered, reason, detail, orphaned, runCount, reclaimLimit}`.
 */
function projectResume({ row, policy, terminal }) {
  const runCount = numberOr(row.run_count, 1);
  const reclaimLimit = policy.reclaimLimit == null ? null : numberOr(policy.reclaimLimit, 3);

  // A row still marked running whose boot id is not ours is orphaned BY
  // DEFINITION — one process, so no other owner can exist. No threshold, no
  // stale window, no false positives, and the answer is available immediately
  // rather than fifteen minutes later.
  const orphaned = row.status === "running"
    && policy.bootId != null
    && row.boot_id !== policy.bootId;

  if (reclaimLimit != null && runCount > reclaimLimit) {
    return {
      offered: false,
      reason: "reclaim-limit",
      detail: `Reclaimed ${runCount} times, above the limit of ${reclaimLimit}. A deterministic crash would otherwise resume and re-crash on every boot, for ever. Last stage was ${row.last_stage ?? "unknown"}; fix that stage, then start a new mission.`,
      orphaned, runCount, reclaimLimit,
    };
  }

  const answer = policy.canResume;
  if (answer == null) {
    return {
      offered: false,
      reason: "not-evaluated",
      detail: "canResume() was not run for this request, so no resume is offered. This is not the same as 'cannot resume' — pass policy.canResume to get a real answer.",
      orphaned, runCount, reclaimLimit,
    };
  }

  const reason = typeof answer === "string" ? answer : String(answer.reason ?? "not-evaluated");
  return {
    offered: reason === "ok",
    reason,
    detail: typeof answer === "object" && answer.detail ? String(answer.detail) : resumeDetail(reason, row, terminal),
    checkpointSavedAt: typeof answer === "object" ? answer.savedAt ?? null : null,
    resumeFromStepId: typeof answer === "object" ? answer.resumeFromStepId ?? null : null,
    orphaned, runCount, reclaimLimit,
  };
}

/** One actionable sentence per `canResume()` reason. */
function resumeDetail(reason, row, terminal) {
  if (reason === "ok") return `A checkpoint is usable. Resuming restarts after ${row.last_stage ?? "the last completed stage"}.`;
  if (reason === "no-checkpoint") return "No checkpoint was written, so there is nothing to resume from. Start a new mission.";
  if (reason === "expired") return "The checkpoint is older than the resume window. Start a new mission, or raise resumeWindowDays in settings.";
  if (reason === "pipeline-changed") return "The stage contracts changed since this checkpoint was written, so resuming would skip or misalign stages. Start a new mission.";
  if (reason === "wrong-status") return terminal ? `Status ${row.status} is not resumable — only failed and quality-failed snapshots are.` : "The mission is still running; there is nothing to resume.";
  return `canResume() returned "${reason}", which this module has no wording for. Treated as not offered.`;
}

/**
 * What is still outstanding, in the order it will happen.
 *
 * Empty on a terminal mission UNLESS a resume is on offer, in which case it is
 * exactly the work a resume would run. Listing pending stages on a mission that
 * ended would read as "still to come" about work that will never happen.
 * @param {object} args - `{stages, dimensions, chapters, terminal, resume}`.
 * @returns {object[]} outstanding work items.
 */
function buildTodo({ stages, dimensions, chapters, terminal, resume }) {
  if (terminal && !resume.offered) return [];
  const wouldResume = terminal && resume.offered;
  const suffix = wouldResume ? "would-run-on-resume" : "outstanding";
  const todo = [];

  for (const s of stages) {
    if (STAGE_RESOLVED.includes(s.status)) continue;
    todo.push({
      kind: "stage",
      key: s.stepId,
      label: s.stepId,
      state: s.status,
      agent: s.agent,
      reason: suffix,
    });
  }
  for (const d of dimensions) {
    if (DIMENSION_RESOLVED.includes(d.state)) continue;
    todo.push({
      kind: "dimension",
      key: d.dimensionId,
      label: d.name,
      state: d.state,
      agent: "researcher",
      reason: d.floor == null
        ? `${suffix}: floor not derived yet (s3 has not measured supply)`
        : `${suffix}: ${d.verified}/${d.floor} verified`,
    });
  }
  for (const c of chapters) {
    if (c.state === "done" || c.state === "failed") continue;
    todo.push({
      kind: "chapter",
      key: `${c.dimensionId}#${c.chapterIndex}`,
      label: c.heading || `${c.dimensionId} #${c.chapterIndex}`,
      state: c.state,
      agent: "writer",
      reason: suffix,
    });
  }
  return todo;
}

/** The stage every dimension of the plan is collected under. */
const WORK_COLLECT_STAGE = "s3-collect";

/** The stage whose output holds the Leader's per-dimension recollect decisions. */
const WORK_ASSESS_STAGE = "s4-assess";

/**
 * EVERY piece of work this mission held, finished work included, each saying
 * why it exists.
 *
 * The replacement for `todo`, which was empty on every mission anybody would
 * want to read. `buildTodo` returns `[]` for a terminal mission with no resume
 * on offer — which is nearly all of them — so a finished mission's work
 * breakdown was the empty list, and nothing in the browser ever read it. A
 * plan that is only visible while it is unfinished is not a plan, it is a
 * progress bar.
 *
 * THREE ORIGINS, and the origin is the point. A stage exists because the
 * pipeline declares twelve. A dimension exists because s2 planned it. A
 * recollect exists because the LEADER read the evidence and decided to spend
 * again on a dimension that came back thin — and that decision, with the
 * Leader's own words for it, was written to `mission_stages.output` and had no
 * reader at all. `reason` carries those words rather than a phrase this file
 * made up.
 *
 * WHAT THE s4 OUTPUT CAN AND CANNOT SAY. `mission_stages` holds ONE row per
 * step id, so a second attempt overwrites the first attempt's output: these
 * are the decisions of the LAST assess, and `counts.attempts` on the s4 parent
 * is how a reader sees that there were earlier ones whose reasons are now only
 * in the trajectory. Said out loud rather than presented as the whole history.
 *
 * @param {object} args - `{stages, stageRows, dimensions}`.
 * @returns {object[]} parents first, each child directly after its parent.
 */
function buildWork({ stages, stageRows, dimensions }) {
  const items = [];
  const stageKey = (stepId) => `stage:${stepId}`;

  for (const stage of stages) {
    items.push({
      id: stageKey(stage.stepId),
      parentId: null,
      origin: "pipeline",
      title: stage.stepId,
      state: stage.status,
      assignee: stage.agent,
      // Not "outstanding". A resolved stage is still a piece of work that
      // happened, and the reason says which of the four ways it resolved —
      // `skipped-by-tier` in particular is a decision the tier made, not a
      // stage that failed to run.
      reason: stage.status === "skipped-by-tier"
        ? "this depth tier does not run this stage; the row was written at s1 so the strip stays twelve long"
        : stage.rowMissing === true
          ? "the catalogue declares this stage and mission_stages has no row for it — s1 did not finish its own bookkeeping"
          : stage.unknownToCatalogue === true
            ? "this step id is in mission_stages and not in the stage catalogue: pipeline drift"
            : "one of the twelve stages the pipeline declares",
      attempts: stage.attempts,
      counts: {
        attempts: stage.attempts,
        tokens: stage.tokens,
        calls: stage.calls,
        durationMs: stage.durationMs,
      },
    });

    if (stage.stepId === WORK_COLLECT_STAGE) {
      for (const dimension of dimensions) {
        items.push({
          id: `dimension:${dimension.dimensionId}`,
          parentId: stageKey(WORK_COLLECT_STAGE),
          origin: "s2-plan",
          title: dimension.name,
          state: dimension.state,
          assignee: `researcher:${dimension.dimensionId}`,
          // The floor, in the reason, because "collected" over two findings
          // against a floor of five is not the same fact as "collected", and
          // a state word alone cannot tell those apart.
          reason: dimension.floor == null
            ? `${dimension.rationale ?? "planned by s2"} — floor not derived yet; s3 has not measured supply`
            : `${dimension.verified}/${dimension.floor} verified across ${dimension.uniqueHosts} independent host(s)`,
          attempts: dimension.attempt,
          counts: {
            attempts: dimension.attempt,
            verified: dimension.verified,
            floor: dimension.floor,
            uniqueHosts: dimension.uniqueHosts,
            unchecked: dimension.uncheckedTotal,
            grade: dimension.grade,
          },
          failureCode: dimension.failureCode,
        });
      }
    }

    if (stage.stepId === WORK_ASSESS_STAGE) {
      for (const decision of assessRecollects(stageRows)) {
        const dimension = dimensions.find((row) => row.dimensionId === decision.dimensionId) ?? null;
        items.push({
          id: `recollect:${decision.dimensionId}`,
          parentId: stageKey(WORK_ASSESS_STAGE),
          origin: "leader-assess-recollect",
          title: dimension?.name ?? decision.dimensionId,
          // The state of the thing the decision was ABOUT. A decision has no
          // state of its own worth printing; what a reader wants to know is
          // what the re-collection it ordered came back with.
          state: dimension?.state ?? "unknown",
          assignee: "leader",
          // The Leader's own sentence, verbatim from mission_stages.output.
          reason: decision.rationale,
          attempts: dimension?.attempt ?? null,
          counts: {
            verified: decision.verified,
            shortfall: decision.shortfall,
            uniqueHosts: decision.uniqueHosts,
          },
          // What the Leader said about THIS dimension, kept beside the
          // mission-wide rationale rather than folded into it.
          critique: decision.critique,
        });
      }
    }
  }

  return items;
}

/**
 * The per-dimension `recollect` decisions in the last s4 output.
 * @param {object[]} stageRows - raw `mission_stages` rows.
 * @returns {object[]} one entry per dimension the Leader sent back for more evidence.
 */
function assessRecollects(stageRows) {
  const row = asArray(stageRows).find((entry) => String(entry?.step_id ?? "") === WORK_ASSESS_STAGE);
  const output = parseJson(row?.output, null);
  if (!output || typeof output !== "object") return [];
  const rationale = typeof output.rationale === "string" ? output.rationale : null;

  return asArray(output.perDimension)
    .filter((entry) => entry && entry.action === "recollect" && typeof entry.dimensionId === "string")
    .map((entry) => ({
      dimensionId: entry.dimensionId,
      rationale,
      // s4 has called this field `critique` and `rationale` in different
      // drafts. Both are read rather than one being assumed, because the cost
      // of guessing wrong is a panel that shows an empty reason on a decision
      // that has one written down.
      critique: typeof entry.critique === "string" ? entry.critique
        : typeof entry.rationale === "string" ? entry.rationale : null,
      verified: entry.verified == null ? null : numberOr(entry.verified, 0),
      shortfall: entry.shortfall == null ? null : numberOr(entry.shortfall, 0),
      uniqueHosts: entry.uniqueHosts == null ? null : numberOr(entry.uniqueHosts, 0),
    }));
}

/**
 * The mission header: the pill, the numbers beside it, and the clock.
 * @param {object} args - everything already projected.
 * @returns {object} the header block.
 */
function projectMission({ row, policy, now, terminal, runCount, stages, dimensions, chapters, evidence, artifact, cost, swept }) {
  const effectiveStart = effectiveStartMs(row);
  const endMs = terminalEndMs(row, now);

  let resolvedStages = 0;
  for (const s of stages) if (STAGE_RESOLVED.includes(s.status)) resolvedStages += 1;

  const degradedDimensions = dimensions.filter((d) => d.state === "degraded").length;
  const leaderScore = row.leader_score == null ? null : Number(row.leader_score);
  const finalScore = row.final_score == null ? null : Number(row.final_score);

  // §4.1 states the relationship and says it is asserted here: final_score is
  // the Leader's score AFTER the forced-unsign ladder and the scorecard fusion,
  // and that ladder only ever lowers it. A final above the leader's own number
  // means the fusion invented confidence. Reported, not thrown: throwing on a
  // read path blanks the whole tab over a number in a corner of it.
  if (leaderScore != null && finalScore != null && finalScore > leaderScore + 1e-9) {
    swept.push({
      kind: "score-relationship",
      key: row.id,
      from: `leader_score=${leaderScore}`,
      to: `final_score=${finalScore}`,
      repaired: false,
      reason: "§4.1: final_score is leader_score after the forced-unsign ladder and the scorecard fusion, and that ladder only lowers. A final_score above leader_score means the fusion raised a signature the Leader would not have given.",
    });
  }

  return {
    id: row.id,
    topic: row.topic ?? "",
    depth: row.depth ?? null,
    language: row.language ?? "zh",
    status: row.status ?? null,
    terminal,
    pill: computePill({ row, terminal, artifact, degradedDimensions, totalDimensions: dimensions.length }),

    // final_score is the number shown; leader_score sits beside it as the
    // pre-correction figure. Two score columns with no stated relationship is
    // how two numbers for one thing starts.
    score: finalScore,
    leaderScore,
    // NULL is load-bearing: it means s11 never ran. 0 means the Leader read the
    // report and refused. Different failures, different next actions.
    signed: row.leader_signed == null ? null : truthy(row.leader_signed),
    verdict: row.leader_verdict ?? null,

    runCount,
    patchRound: numberOr(row.patch_round, 0),
    lastStage: row.last_stage ?? null,
    lastProgressAt: row.last_progress_at ?? null,
    startedAt: row.started_at ?? null,
    lastReopenedAt: row.last_reopened_at ?? null,
    // max(started, reopened): without it a resumed mission is instantly
    // wall-time-killed against its original start and the user reads it as
    // "my rerun broke".
    effectiveStartAt: new Date(effectiveStart).toISOString(),
    completedAt: row.completed_at ?? null,
    elapsedMs: Math.max(0, endMs - effectiveStart),
    wallMs: numberOr(row.wall_ms, 0),
    wallRatio: cost.wall.ratio,

    failureCode: row.failure_code ?? null,
    errorMessage: row.error_message ?? null,
    traceEnabled: truthy(row.trace_enabled),
    retryBelowSeam: truthy(row.retry_below_seam),
    goals: parseJson(row.goals, null),
    derivedFloor: row.derived_floor == null ? null : numberOr(row.derived_floor, 0),

    progress: {
      stagesResolved: resolvedStages,
      stagesTotal: stages.length,
      // Stages only. The dimension and chapter fractions are their own numbers
      // and are not blended in, because a single blended percentage is exactly
      // the figure nobody can explain when it moves backwards.
      percent: stages.length > 0 ? Math.round((resolvedStages / stages.length) * 100) : 0,
      dimensionsResolved: dimensions.filter((d) => DIMENSION_RESOLVED.includes(d.state)).length,
      dimensionsTotal: dimensions.length,
      chaptersDone: chapters.filter((c) => c.state === "done").length,
      chaptersTotal: chapters.length,
    },

    evidence,
    degradedDimensions,
    // Present so a caller can check the projection's own health without
    // walking `swept[]`.
    anomalies: swept.length,
    bootId: row.boot_id ?? null,
    pid: row.pid == null ? null : numberOr(row.pid, 0),
    projectedAt: new Date(now).toISOString(),
  };
}

/**
 * The list pill, computed rather than stored.
 *
 * `missions.status` has no member for "degraded", and growing the vocabulary is
 * what manufactures display bugs — the reference's status column is a free
 * varchar, writers started producing `quality-failed`, the display mapping
 * still had the old enum and fell through to `return 'running'`, and cancel
 * became permanently impossible. So the status column stays exhaustive and
 * small, and degradation is resolved here from three facts the projector
 * already holds.
 * @param {object} args - `{row, terminal, artifact, degradedDimensions, totalDimensions}`.
 * @returns {object} `{code, tone, label, detail, degradedDimensions, totalDimensions}`.
 */
function computePill({ row, terminal, artifact, degradedDimensions, totalDimensions }) {
  const status = String(row.status ?? "");
  const artefactDegraded = artifact.kind === "artifact" && artifact.degraded;
  const anyDegraded = artefactDegraded || degradedDimensions > 0;

  const base = {
    running: { code: "running", tone: "active", label: "运行中" },
    completed: { code: "completed", tone: "good", label: "完成" },
    failed: { code: "failed", tone: "bad", label: "失败" },
    cancelled: { code: "cancelled", tone: "muted", label: "已取消" },
    "quality-failed": { code: "quality-failed", tone: "warn", label: "未签署" },
  }[status];

  if (!base) {
    // Evidence-based fallback, never `running`. An unknown status carrying
    // completed_at is over; presenting it as running is what lit a cancel
    // button that 400'd for ever.
    const over = terminal || row.completed_at != null;
    return {
      code: over ? "unknown-terminal" : "unknown",
      tone: over ? "bad" : "muted",
      label: over ? "未知(已结束)" : "未知",
      detail: `Status "${status}" has no public mapping. Treated as ${over ? "terminal" : "not started"} because completed_at is ${row.completed_at == null ? "absent" : "present"} — never as running. Add it to the status vocabulary module.`,
      degradedDimensions, totalDimensions,
    };
  }

  if (!anyDegraded) {
    return { ...base, detail: null, degradedDimensions, totalDimensions };
  }

  const parts = [];
  if (degradedDimensions > 0) parts.push(`${degradedDimensions}/${totalDimensions} 维度降级`);
  if (artefactDegraded) parts.push("报告降级");

  return {
    code: `${base.code}-degraded`,
    tone: base.tone === "good" ? "warn" : base.tone,
    label: `${base.label} · 部分降级 ${degradedDimensions}/${totalDimensions}`,
    detail: parts.join(" · "),
    degradedDimensions,
    totalDimensions,
  };
}

// ── the reads ────────────────────────────────────────────────────────────────

/**
 * Read everything `projectMissionView` needs, from the database alone.
 *
 * Kept beside the projector on purpose. The projection's whole claim is that it
 * can answer after a restart with nothing in memory, and the only way to hold
 * anyone to that is for the reads it depends on to be visible next to it — a
 * route that assembles its own bag will eventually slip an in-memory value in.
 * If a `mission-store.js` later owns these statements, this function becomes a
 * thin call into it and the projector below does not change.
 *
 * Statements are prepared per call rather than cached, matching store.js.
 * @param {object} db - an open `DatabaseSync` (or anything with `.prepare`).
 * @param {string} missionId - the mission to read.
 * @param {object} [opts] - `{sinceSeq, tail}`.
 * @returns {object|null} the projector's input bag, or null when no such mission.
 */
export function readMissionViewInput(db, missionId, opts = {}) {
  if (!db || typeof db.prepare !== "function") {
    throw new TypeError("readMissionViewInput: `db` must be an open DatabaseSync. Pass store.db — this module opens nothing and owns no handle.");
  }
  if (typeof missionId !== "string" || missionId.length === 0) {
    throw new TypeError("readMissionViewInput: `missionId` must be a non-empty string.");
  }

  const sinceSeq = numberOr(opts.sinceSeq, 0);
  const tail = Math.max(1, numberOr(opts.tail, MISSION_VIEW_TAIL_DEFAULT));

  const row = query(db, "SELECT * FROM missions WHERE id = ?", [missionId])[0] ?? null;
  if (!row) return null;
  const runCount = numberOr(row.run_count, 1);

  const stages = query(db, "SELECT * FROM mission_stages WHERE mission_id = ? ORDER BY ordinal", [missionId]);
  // THIS RUN'S PLAN. The counts below are already scoped to `runCount` and the
  // rows they attach to were not, so the pane listed every plan the mission had
  // ever had with this run's evidence hung off whichever ids happened to match:
  // 63 dimensions for a plan of 8, four of them the same id twice, because
  // thirteen leaders had each named the same eight concepts differently.
  const dimensionRows = query(
    db, "SELECT * FROM mission_dimensions WHERE mission_id = ? AND run_count = ?", [missionId, runCount],
  );

  // One GROUP BY answers every dimension card and the mission-wide roll-up.
  // §4.4 deleted the stored `verified_count` column precisely because four
  // writers and one critical reader is a drift generator; `ix_findings_state`
  // makes this a few microseconds.
  const counted = query(db, `
    SELECT dimension_id, verify_state, COUNT(*) AS n
      FROM mission_findings
     WHERE mission_id = ? AND run_count = ?
     GROUP BY dimension_id, verify_state`, [missionId, runCount]);

  // Distinct HOSTS, not rows. Counting articles instead of hosts is how the
  // whole model of independence collapses.
  const hosts = query(db, `
    SELECT dimension_id, COUNT(DISTINCT source_host) AS n
      FROM mission_findings
     WHERE mission_id = ? AND run_count = ? AND verify_state = ?
     GROUP BY dimension_id`, [missionId, runCount, VERIFIED]);

  const countsByDim = new Map();
  for (const c of counted) {
    const key = String(c.dimension_id ?? "");
    let bag = countsByDim.get(key);
    if (!bag) { bag = Object.create(null); countsByDim.set(key, bag); }
    bag[String(c.verify_state ?? "")] = numberOr(c.n, 0);
  }
  const hostsByDim = new Map(hosts.map((h) => [String(h.dimension_id ?? ""), numberOr(h.n, 0)]));

  const dimensions = dimensionRows.map((d) => ({
    ...d,
    counts: countsByDim.get(String(d.dimension_id ?? "")) ?? Object.create(null),
    unique_hosts: hostsByDim.get(String(d.dimension_id ?? "")) ?? 0,
  }));

  const chapters = query(db, `
    SELECT mission_id, run_count, dimension_id, chapter_index, section_type, heading,
           word_count, min_delivery, under_delivered, decision, score, attempts, updated_at,
           length(body) AS body_length
      FROM mission_chapters
     WHERE mission_id = ?
     ORDER BY run_count, dimension_id, chapter_index`, [missionId]);

  // Deliberately WITHOUT `markdown` and `evidence`. A `deep` report is 25,000
  // words and the frozen evidence blob is larger; pulling either into a
  // per-request view would put megabytes through the same blocking connection
  // the mission is writing on, which is the stall this whole section exists to
  // avoid. `length(markdown)` gives the client what it needs to decide whether
  // to fetch the document itself.
  const artefacts = query(db, `
    SELECT mission_id, version, run_count, trigger, title, sections, citations, quality,
           word_count, degraded, created_at, length(markdown) AS markdown_bytes
      FROM mission_artifacts
     WHERE mission_id = ?
     ORDER BY version DESC`, [missionId]);

  const totals = query(db, `
    SELECT COALESCE(SUM(prompt_tok),0)     AS prompt_tok,
           COALESCE(SUM(completion_tok),0) AS completion_tok,
           COALESCE(SUM(cache_read_tok),0) AS cache_read_tok,
           COALESCE(SUM(estimated_tok),0)  AS estimated_tok,
           COALESCE(SUM(calls),0)          AS calls
      FROM mission_spend WHERE mission_id = ? AND run_count = ?`, [missionId, runCount])[0] ?? {};

  const byStage = query(db, `
    SELECT step_id, role,
           COALESCE(SUM(prompt_tok),0)     AS prompt_tok,
           COALESCE(SUM(completion_tok),0) AS completion_tok,
           COALESCE(SUM(cache_read_tok),0) AS cache_read_tok,
           COALESCE(SUM(calls),0)          AS calls
      FROM mission_spend WHERE mission_id = ? AND run_count = ? GROUP BY step_id, role`, [missionId, runCount]);

  const byAgent = query(db, `
    SELECT agent_id, role, MAX(step_id) AS step_id,
           COALESCE(SUM(prompt_tok),0)     AS prompt_tok,
           COALESCE(SUM(completion_tok),0) AS completion_tok,
           COALESCE(SUM(cache_read_tok),0) AS cache_read_tok,
           COALESCE(SUM(calls),0)          AS calls
      FROM mission_spend WHERE mission_id = ? AND run_count = ? GROUP BY agent_id, role`, [missionId, runCount]);

  // `pace_key` is which ceiling a call consumed, so this is the meter for
  // arXiv, web and fetch. Calls with no pace key consume no ceiling and are
  // excluded rather than bucketed under a made-up key.
  const paceRows = query(db, `
    SELECT pace_key, COUNT(*) AS n
      FROM mission_tool_calls
     WHERE mission_id = ? AND run_count = ? AND pace_key IS NOT NULL
     GROUP BY pace_key`, [missionId, runCount]);
  const toolsByPaceKey = Object.create(null);
  for (const p of paceRows) toolsByPaceKey[String(p.pace_key)] = numberOr(p.n, 0);

  const toolsByAgent = query(db, `
    SELECT agent_id,
           COUNT(*)                                AS calls,
           SUM(CASE WHEN ok = 0 THEN 1 ELSE 0 END) AS failures,
           SUM(CASE WHEN cached = 1 THEN 1 ELSE 0 END) AS cached
      FROM mission_tool_calls WHERE mission_id = ? AND run_count = ? GROUP BY agent_id`, [missionId, runCount]);

  const toolTotals = query(db, `
    SELECT SUM(CASE WHEN ok = 0 THEN 1 ELSE 0 END)     AS failures,
           SUM(CASE WHEN cached = 1 THEN 1 ELSE 0 END) AS cached
      FROM mission_tool_calls WHERE mission_id = ? AND run_count = ?`, [missionId, runCount])[0] ?? {};

  // Per TOOL, not per pace key. `toolsByPaceKey` above says which CEILING was
  // consumed — three buckets for the whole product — and cannot answer "which
  // tool failed" or "which tool was slow".
  //
  // `latency_measured` is counted SEPARATELY from `calls` on purpose. The
  // column is NOT NULL DEFAULT 0, so a call written by a path that never timed
  // one is stored as zero; dividing the SUM by `calls` would report every
  // untimed call as instantaneous, which is a passing number over a broken
  // measurement. `MissionStore.toolTotalsByTool` runs the same aggregate for
  // callers outside the view, and tests/mission.test.mjs pins the two together.
  const byTool = query(db, `
    SELECT tool,
           COUNT(*)                                        AS calls,
           SUM(CASE WHEN ok = 0 THEN 1 ELSE 0 END)         AS failures,
           SUM(CASE WHEN cached = 1 THEN 1 ELSE 0 END)     AS cached,
           SUM(latency_ms)                                 AS latency_ms,
           SUM(CASE WHEN latency_ms > 0 THEN 1 ELSE 0 END) AS latency_measured
      FROM mission_tool_calls WHERE mission_id = ? AND run_count = ? GROUP BY tool
     ORDER BY calls DESC, tool`, [missionId, runCount]);

  // DESC + LIMIT is how the tail is taken; the projector sorts it back to
  // reading order. The write side stays unbounded (§4.7).
  const eventTail = query(db, `
    SELECT seq, ts, type, class, agent_id, payload
      FROM mission_events
     WHERE mission_id = ? AND seq > ?
     ORDER BY seq DESC LIMIT ?`, [missionId, sinceSeq, tail]);

  // Unbounded and exact, because the bounded tail above can evict the one event
  // that distinguishes "the artefact write failed" from "no artefact yet" — and
  // those must never collapse into one sentinel. A PK-prefix scan, one row.
  const writeFailed = query(db, `
    SELECT 1 AS hit FROM mission_events
     WHERE mission_id = ? AND type = ? LIMIT 1`, [missionId, ARTIFACT_WRITE_FAILED_EVENT]);
  if (writeFailed.length > 0 && !eventTail.some((e) => e.type === ARTIFACT_WRITE_FAILED_EVENT)) {
    eventTail.push({ seq: 0, ts: null, type: ARTIFACT_WRITE_FAILED_EVENT, class: "lifecycle", agent_id: null, payload: "{}", outsideTail: true });
  }

  return {
    row,
    stages,
    dimensions,
    chapters,
    artefacts,
    eventTail,
    sinceSeq,
    spendSums: {
      totals,
      byStage,
      byAgent,
      toolsByPaceKey,
      toolsByAgent,
      byTool,
      toolFailures: numberOr(toolTotals.failures, 0),
      toolCached: numberOr(toolTotals.cached, 0),
    },
  };
}

/**
 * Run one statement, turning a missing table into a message that says what to do.
 * @param {object} db - the open database.
 * @param {string} sql - the statement.
 * @param {unknown[]} params - bound parameters.
 * @returns {object[]} rows.
 */
function query(db, sql, params) {
  try {
    return db.prepare(sql).all(...params);
  } catch (err) {
    const message = String(err?.message ?? err);
    if (/no such table/i.test(message)) {
      throw new Error(`mission-view: ${message}. The mission tables have not been migrated in this library — run the mission migrations at init before serving the view route.`);
    }
    throw err;
  }
}

// ── the trajectory projection ────────────────────────────────────────────────

/**
 * The trajectory: one ordered list of everything a mission did.
 *
 * WHY THIS IS A SEPARATE PROJECTION AND NOT PART OF `projectMissionView`.
 * The view above answers "what is this mission doing right now" from the
 * COUNTER tables — deliberately, because folding the event stream on every tick
 * is what stalls the mission it describes. The trajectory asks the opposite
 * question: "what happened, in order, one row per thing". It is read on demand
 * by a tab a person opened, one page at a time, never on the live poll — so it
 * may read the streams the view refuses to. Keeping the two apart is what stops
 * the expensive question from being asked on the cheap question's schedule.
 *
 * WHY STAGE TRANSITIONS COME FROM THE EVENT LOG AND NOT FROM `mission_stages`.
 * `stage:started`, `stage:done`, `stage:degraded`, `stage:failed` and
 * `stage:skipped-by-tier` are all registered event types; `mission_stages`
 * holds the CURRENT status of each stage and one pair of stamps. Emitting rows
 * from both would print a stage twice — once as it happened and once as it now
 * stands — and on a rerun the second copy carries the NEW generation's stamps
 * against the OLD generation's position in the list. So the event log supplies
 * the rows and `mission_stages` supplies the numbers each row is annotated
 * with. A stage that has a row and no event is invisible here on purpose: it
 * did not transition inside the window this page read.
 *
 * WHY IT IS PURE. Same reason as the view: every input arrives already read, so
 * a fixture test can build a trajectory with no database, and the bound on how
 * much is read lives at the route where the caps are visible beside each other
 * rather than buried inside a fold.
 */

/**
 * Where a trajectory row came from. This is the row's provenance, not its
 * severity — a filter on `kind` narrows to one stream.
 *
 * `stage` and `event` both come from `mission_events`; the split is that a
 * `stage:*` type is a transition of the pipeline and everything else is a
 * notice about it. A reader scanning for "what did s3 actually do" wants the
 * first without the second, and a `kind=event` filter that also returned stage
 * transitions would make that scan impossible.
 */
export const TRACE_KINDS = Object.freeze(["stage", "tool", "finding", "event"]);

/**
 * The chip printed at the left of a trajectory row.
 *
 * A FIXED vocabulary, exported, for the reason the status list is: the client
 * colours by this string, and a role invented at read time would arrive at a
 * `switch` with no case and render as an unstyled blank. Anything this module
 * cannot class is `SYSTEM`, never a made-up chip.
 */
export const TRACE_ROLES = Object.freeze(["STAGE", "TOOL", "EVIDENCE", "GATE", "SYSTEM"]);

/** Which end of the trajectory a page is taken from. */
export const TRACE_ORDERS = Object.freeze(["newest", "oldest"]);

/**
 * How much of the left-hand argument a list row carries.
 *
 * The list is one line per row and the detail route returns the whole thing, so
 * this is a display bound, not a data bound. It is deliberately generous: a
 * search whose query is cut at forty characters cannot be told apart from the
 * next search, which is the exact failure `args_text` was added to fix.
 */
export const TRACE_DETAIL_CHARS = 200;

/** How much of the right-hand result a list row carries. See `TRACE_DETAIL_CHARS`. */
export const TRACE_RESULT_CHARS = 160;

/**
 * Event types that report a failure, so `ok: false` is never guessed from a name.
 *
 * Listed rather than matched by suffix. A guess by suffix would class
 * `gate:soft-warning` as a pass, and a soft warning is the one signal that says
 * the mission is heading for a quality failure while every stage still reports
 * success.
 */
const TRACE_FAILED_EVENTS = Object.freeze([
  "stage:failed",
  "stage:stalled",
  "gate:refused",
  "gate:hard-warning",
  "evidence:none",
  "recollect:refused",
  "checkpoint:divergence",
  "runtime:owner-conflict",
  "runtime:reclaim-limit",
  "postlude:handoff-failed",
  "artifact:write-failed",
]);

/** Event types that report a pass, for the same reason the list above exists. */
const TRACE_PASSED_EVENTS = Object.freeze([
  "stage:done",
  "gate:passed",
  "artifact:written",
  "recollect:allowed",
  "mission:finalized",
]);

/**
 * Verify states that mean the claim was CHECKED AND WRONG, as opposed to unchecked.
 *
 * The `unchecked-` family is deliberately absent: a 429 is not a fabrication,
 * and colouring it red on the trajectory reproduces in the UI the collapse §4.4
 * forbids in the column. Those rows carry `ok: null` — no verdict — and the
 * reader sees the state string itself.
 */
const TRACE_REFUTED_STATES = Object.freeze(["misattributed", "unverifiable", "too-short"]);

/**
 * Build the whole trajectory from streams that have already been read.
 *
 * Rows are numbered OLDEST FIRST, always, whichever way the caller then pages.
 * Numbering from the newest end would renumber every row each time the mission
 * wrote one more, so a detail panel opened on row 12 would be showing a
 * different row a second later. `seq` is a position in this snapshot and `ref`
 * is the identity — see `parseTraceRef`; the client keys on `ref`.
 *
 * @param {object} input - the streams, each already read from the store.
 * @param {object[]} [input.events] - `MissionStore.eventTail` / `readEvents` rows: `{seq, ts, type, class, agentId, stepId, payload}`.
 * @param {object[]} [input.stages] - `MissionStore.listStages` rows, for the numbers each stage row is annotated with.
 * @param {object[]} [input.toolCalls] - `MissionStore.recentToolCalls` rows, NEWEST FIRST as that method returns them.
 * @param {object[]} [input.findings] - `MissionStore.listFindings` rows, oldest first as that method returns them.
 * @param {object[]} [input.dimensions] - `MissionStore.listDimensions` rows, for dimension names.
 * @returns {object[]} every row, oldest first, `seq` assigned from 1.
 */
export function buildMissionTrace(input) {
  const stages = asArray(input?.stages);
  const findings = asArray(input?.findings);
  const dimensions = asArray(input?.dimensions);

  const stageByStep = new Map();
  for (const stage of stages) stageByStep.set(String(stage?.stepId ?? ""), stage);
  const dimensionNames = new Map();
  for (const dimension of dimensions) dimensionNames.set(String(dimension?.dimensionId ?? ""), dimension?.name ?? null);
  const dimensionIds = new Set(dimensionNames.keys());

  /** Every candidate row, each carrying the tuple it is sorted by. */
  const candidates = [];

  // ── the event log: stage transitions, and everything else ───────────────
  //
  // `rank: 0` for BOTH kinds, tiebroken by the event `seq`. Ranking stage rows
  // ahead of the rest would reorder two events written in the same millisecond
  // against the order the store recorded them in, and that seq is the only
  // record of that order there is.
  for (const event of dedupeEvents(asArray(input?.events))) {
    const type = String(event?.type ?? "");
    const seq = numberOr(event?.seq, 0);
    const payload = parseJson(event?.payload, {});
    const stepId = event?.stepId == null ? stepIdOf(payload) : String(event.stepId);
    const isStage = type.startsWith("stage:");
    const stage = stepId === null ? undefined : stageByStep.get(stepId);
    const verb = isStage ? type.slice("stage:".length) : type;
    // The duration belongs to the transition that ENDED the stage. Printing it
    // on `stage:started` too would show a stage announcing, at the moment it
    // began, how long it was going to take.
    const ended = isStage && verb !== "started";
    candidates.push({
      rank: 0,
      ordinal: seq,
      at: event?.ts == null ? null : String(event.ts),
      kind: isStage ? "stage" : "event",
      role: roleOfEvent(type),
      title: isStage ? (stepId ?? type) : type,
      detail: isStage ? verb : oneLine(payload, TRACE_DETAIL_CHARS),
      result: isStage ? oneLine(payload, TRACE_RESULT_CHARS) : reasonOf(payload, TRACE_RESULT_CHARS),
      ms: ended ? nullableNumber(stage?.durationMs) : nullableNumber(payload?.ms ?? payload?.durationMs),
      ok: okOfEvent(type),
      state: isStage ? verb : type,
      stepId,
      agentId: event?.agentId == null ? null : String(event.agentId),
      dimensionId: resolveDimensionId(event?.agentId ?? null, dimensionIds) ?? dimensionIdOf(payload, dimensionIds),
      paceKey: null,
      ref: isStage ? `stage:${stepId ?? type}@${seq}` : `event:${seq}`,
    });
  }

  // ── tool calls ──────────────────────────────────────────────────────────
  //
  // REVERSED, not re-sorted. `recentToolCalls` orders `at DESC, id DESC`, so
  // reversing yields `at ASC, id ASC` — and the row id is the only thing that
  // orders two calls recorded in the same millisecond. A sort keyed on `at`
  // alone would scramble exactly those, which are the rows a thrash
  // investigation is looking at.
  const ascendingCalls = [...asArray(input?.toolCalls)].reverse();
  /** How many calls have already been seen at each instant, for the ref's ordinal. */
  const seenAtInstant = new Map();
  for (const call of ascendingCalls) {
    const at = call?.at == null ? "" : String(call.at);
    const ordinal = seenAtInstant.get(at) ?? 0;
    seenAtInstant.set(at, ordinal + 1);
    const outcome = call?.errorCode ? String(call.errorCode) : (call?.cached === true ? "cached" : "ok");
    candidates.push({
      rank: 1,
      ordinal,
      at: at === "" ? null : at,
      kind: "tool",
      role: "TOOL",
      title: String(call?.tool ?? ""),
      // The arguments, which is the whole reason `args_text` exists: eight
      // dimensions, eighty-six searches, and the only honest answer to "why did
      // four of them find nothing" was that nobody could see the queries.
      detail: clip(collapse(String(call?.argsText ?? "")), TRACE_DETAIL_CHARS),
      result: outcome,
      ms: nullableNumber(call?.latencyMs),
      ok: call?.ok === true,
      state: outcome,
      stepId: call?.stepId == null ? null : String(call.stepId),
      agentId: call?.agentId == null || call.agentId === "" ? null : String(call.agentId),
      dimensionId: resolveDimensionId(call?.agentId ?? null, dimensionIds),
      paceKey: call?.paceKey == null ? null : String(call.paceKey),
      ref: `tool:${at}#${ordinal}`,
    });
  }

  // ── findings ────────────────────────────────────────────────────────────
  //
  // The rows the tab exists for. `detail` is the CLAIM and `result` is the
  // verbatim quote, because a card that reports "已核验 6" and shows neither is
  // a count of evidence the screen refuses to display.
  let findingOrdinal = 0;
  for (const finding of findings) {
    const dimensionId = finding?.dimensionId == null ? null : String(finding.dimensionId);
    candidates.push({
      rank: 2,
      ordinal: findingOrdinal++,
      at: finding?.createdAt == null ? null : String(finding.createdAt),
      kind: "finding",
      role: "EVIDENCE",
      title: String(finding?.sourceHost ?? ""),
      detail: clip(collapse(String(finding?.claim ?? "")), TRACE_DETAIL_CHARS),
      result: clip(collapse(String(finding?.evidence ?? "")), TRACE_RESULT_CHARS),
      ms: null,
      ok: okOfVerifyState(String(finding?.verifyState ?? "")),
      state: String(finding?.verifyState ?? ""),
      stepId: null,
      agentId: null,
      dimensionId,
      paceKey: null,
      ref: `finding:${String(finding?.id ?? "")}`,
    });
  }

  candidates.sort(compareTraceCandidates);

  return candidates.map((candidate, index) => ({
    seq: index + 1,
    at: candidate.at,
    kind: candidate.kind,
    role: candidate.role,
    title: candidate.title,
    detail: candidate.detail,
    result: candidate.result,
    ms: candidate.ms,
    ok: candidate.ok,
    state: candidate.state,
    stepId: candidate.stepId,
    agentId: candidate.agentId,
    dimensionId: candidate.dimensionId,
    dimensionName: candidate.dimensionId === null ? null : dimensionNames.get(candidate.dimensionId) ?? null,
    paceKey: candidate.paceKey,
    ref: candidate.ref,
  }));
}

/**
 * Filter and page a built trajectory.
 *
 * Separate from `buildMissionTrace` so `seq` is assigned over the WHOLE list
 * before any filter runs. Numbering after the filter would give row 12 of a
 * `kind=tool` page a different identity from row 12 of the unfiltered page, and
 * a detail panel that reopened against the wrong row is the most expensive kind
 * of wrong: plausible.
 *
 * `agentId` IS THE AGENT AXIS, and `role` is not. `TRACE_ROLES` is
 * ["STAGE","TOOL","EVIDENCE","GATE","SYSTEM"] — a provenance chip, nearly the
 * same axis as `kind` — so "show me only what the Leader did" had no filter at
 * all until this one. The rows have carried `agentId` since they were built.
 *
 * @param {object[]} rows - the output of `buildMissionTrace`.
 * @param {object} [options] - `{kind, role, agentId, stepId, dimensionId, search, order, take, skip}`.
 * @returns {object} `{rows, total, order, take, skip, returned, hasMore}`.
 */
export function sliceMissionTrace(rows, options = {}) {
  const all = asArray(rows);
  const kind = emptyToNull(options.kind);
  const role = emptyToNull(options.role);
  const agentId = emptyToNull(options.agentId);
  const stepId = emptyToNull(options.stepId);
  const dimensionId = emptyToNull(options.dimensionId);
  const needle = emptyToNull(options.search)?.toLowerCase() ?? null;
  const order = options.order === "oldest" ? "oldest" : "newest";
  const take = Math.max(1, numberOr(options.take, 100));
  const skip = Math.max(0, numberOr(options.skip, 0));

  const matched = all.filter((row) => {
    if (kind !== null && row.kind !== kind) return false;
    if (role !== null && row.role !== role) return false;
    if (agentId !== null && row.agentId !== agentId) return false;
    if (stepId !== null && row.stepId !== stepId) return false;
    if (dimensionId !== null && row.dimensionId !== dimensionId) return false;
    if (needle === null) return true;
    // Searched over what the row PRINTS, plus the ids it is filed under.
    // Searching the whole record instead would match a `ref` nobody can see and
    // return rows with no visible reason for being there.
    return [row.title, row.detail, row.result, row.stepId, row.agentId, row.dimensionName, row.state]
      .some((field) => typeof field === "string" && field.toLowerCase().includes(needle));
  });

  const ordered = order === "newest" ? [...matched].reverse() : matched;
  const page = ordered.slice(skip, skip + take);
  return {
    rows: page,
    total: matched.length,
    order,
    take,
    skip,
    returned: page.length,
    hasMore: skip + page.length < matched.length,
  };
}

/**
 * The filter values that actually occur in this trajectory, with counts.
 *
 * COMPUTED FROM THE ROWS, never from a catalogue, and that is the whole point.
 * The trajectory route already returns `data.dimensions` — the five the plan
 * declared — and a filter control built from it offers five options over a
 * list where 158 of 169 rows carry `dimensionId: null` and only three
 * dimensions appear at all. Two of those five chips return nothing, and an
 * empty result from a chip the product offered is indistinguishable from a
 * broken filter.
 *
 * `data.dimensions` is deliberately left alone: it answers "what was planned",
 * which other readers need. This answers "what can be filtered", which is a
 * different question with a different answer, and the two are returned side by
 * side rather than reconciled into one number that is wrong for somebody.
 *
 * @param {object[]} rows - the output of `buildMissionTrace`, unfiltered.
 * @returns {object} `{agents, dimensions}`, each `[{id, name?, rows}]`, busiest first.
 */
export function traceVocabulary(rows) {
  const agents = new Map();
  const dimensions = new Map();

  for (const row of asArray(rows)) {
    const agentId = emptyToNull(row?.agentId);
    if (agentId !== null) agents.set(agentId, (agents.get(agentId) ?? 0) + 1);

    const dimensionId = emptyToNull(row?.dimensionId);
    if (dimensionId === null) continue;
    const seen = dimensions.get(dimensionId);
    if (seen === undefined) {
      dimensions.set(dimensionId, { dimensionId, name: row?.dimensionName ?? null, rows: 1 });
    } else {
      seen.rows += 1;
      // First non-null name wins rather than the last: a row whose dimension
      // fell outside the run being read carries a null name, and letting it
      // overwrite would blank a label that another row already supplied.
      if (seen.name === null) seen.name = row?.dimensionName ?? null;
    }
  }

  const byRows = (a, b) => b.rows - a.rows || (a.id ?? a.dimensionId).localeCompare(b.id ?? b.dimensionId);
  return {
    agents: [...agents].map(([id, count]) => ({ id, rows: count })).sort(byRows),
    dimensions: [...dimensions.values()].sort(byRows),
  };
}

/**
 * Read one row's `ref` back into the identity it names.
 *
 * A ref, not the `seq`, is what a detail panel refetches with. `seq` is a
 * position in a snapshot: the trajectory is assembled from bounded windows over
 * three streams, so a mission that wrote fifty more events between the list
 * request and the click has shifted every position by fifty. The grammar is
 * `kind ":" key`, split on the FIRST colon because two of the keys contain
 * colons of their own — an ISO instant and a step id both can.
 *
 *   event:412                             the event with that `seq`
 *   stage:s3-collect@118                  that stage, at that event
 *   tool:2026-08-25T09:14:02.771Z#0       the first tool call recorded at that instant
 *   finding:f-9a2c…                       that finding row
 *
 * @param {string} ref - the `ref` field of a trajectory row.
 * @returns {object|null} `{kind, …}` naming what to fetch, or null when the ref is malformed.
 */
export function parseTraceRef(ref) {
  if (typeof ref !== "string" || ref === "") return null;
  const cut = ref.indexOf(":");
  if (cut < 1) return null;
  const kind = ref.slice(0, cut);
  const key = ref.slice(cut + 1);
  if (!TRACE_KINDS.includes(kind) || key === "") return null;

  if (kind === "event") {
    const seq = Number(key);
    return Number.isInteger(seq) && seq > 0 ? { kind, eventSeq: seq } : null;
  }
  if (kind === "stage") {
    // `lastIndexOf`, not `indexOf`: no step id contains `@` today, but reading
    // from the right means that the day one does, the event seq is still read
    // correctly rather than the id being silently truncated.
    const at = key.lastIndexOf("@");
    if (at < 1) return null;
    const seq = Number(key.slice(at + 1));
    if (!Number.isInteger(seq) || seq <= 0) return null;
    return { kind, stepId: key.slice(0, at), eventSeq: seq };
  }
  if (kind === "tool") {
    const hash = key.lastIndexOf("#");
    if (hash < 1) return null;
    const ordinal = Number(key.slice(hash + 1));
    if (!Number.isInteger(ordinal) || ordinal < 0) return null;
    return { kind, at: key.slice(0, hash), ordinal };
  }
  return { kind: "finding", findingId: key };
}

/**
 * Find the store rows one trajectory ref names, inside the streams the page was
 * built from.
 *
 * Kept HERE, beside `buildMissionTrace`, because it is that function's inverse
 * and the two have to agree about one rule: a tool call's ordinal is its index
 * among the calls recorded at the same instant, ASCENDING. Spelled twice in two
 * files, that rule drifts, and the drift shows up as a detail panel that opens
 * on the wrong call of a retried fetch — the one case where two rows genuinely
 * do share a timestamp and a tool name.
 *
 * A ref that names nothing returns null rather than a partially filled bag. The
 * caller answers 404 with the window bound, because "the row scrolled out of
 * the window this page reads" and "there is no such row" want different
 * sentences and a null that means both is a sentinel wearing a costume.
 *
 * @param {object|null} parsed - `parseTraceRef`'s answer.
 * @param {object} [streams] - `{events, stages, toolCalls, findings}`, exactly as handed to `buildMissionTrace`.
 * @returns {object|null} `{event, stage, toolCall, finding}` with the members this kind has, or null.
 */
export function resolveTraceSource(parsed, streams = {}) {
  if (parsed === null || typeof parsed !== "object") return null;
  const events = asArray(streams.events);
  const stages = asArray(streams.stages);
  const stageOf = (stepId) => (stepId == null ? null : stages.find((s) => String(s?.stepId ?? "") === String(stepId)) ?? null);

  if (parsed.kind === "event" || parsed.kind === "stage") {
    const event = events.find((row) => numberOr(row?.seq, -1) === parsed.eventSeq) ?? null;
    if (event === null) return null;
    return { event, stage: stageOf(parsed.stepId ?? event.stepId), toolCall: null, finding: null };
  }
  if (parsed.kind === "tool") {
    // Reversed then filtered, in that order: `recentToolCalls` returns
    // `at DESC, id DESC`, and only after reversing does index-within-instant
    // mean the same thing it meant when the ref was minted.
    const atInstant = [...asArray(streams.toolCalls)].reverse().filter((row) => String(row?.at ?? "") === parsed.at);
    const toolCall = atInstant[parsed.ordinal] ?? null;
    if (toolCall === null) return null;
    return { event: null, stage: stageOf(toolCall.stepId), toolCall, finding: null };
  }
  const finding = asArray(streams.findings).find((row) => String(row?.id ?? "") === parsed.findingId) ?? null;
  if (finding === null) return null;
  return { event: null, stage: null, toolCall: null, finding };
}

/**
 * One finding, in the shape the evidence panel renders.
 *
 * The quote is called `quote` here and `evidence` in the store, and the rename
 * is deliberate rather than careless: `evidence` already names three other
 * things in this codebase — the artefact's frozen citation blob, the dimension
 * roll-up on the view, and the `evidence:*` event family — and a panel field
 * that collides with all three is a field somebody will fetch the wrong one of.
 * Every other field keeps the store's name exactly.
 *
 * @param {object} finding - a `MissionStore.listFindings` row.
 * @param {object} [context] - `{dimensionName}`.
 * @returns {object} the wire shape.
 */
export function projectFinding(finding, context = {}) {
  const verifyState = String(finding?.verifyState ?? "");
  const quote = String(finding?.evidence ?? "");
  return {
    id: finding?.id == null ? null : String(finding.id),
    dimensionId: finding?.dimensionId == null ? null : String(finding.dimensionId),
    dimensionName: context.dimensionName ?? null,
    runCount: numberOr(finding?.runCount, 1),
    attempt: numberOr(finding?.attempt, 0),
    claim: String(finding?.claim ?? ""),
    claimHash: finding?.claimHash == null ? null : String(finding.claimHash),
    // The verbatim span, WHOLE. This is the only place it is ever returned, and
    // truncating it here would leave the quote unreadable everywhere in the
    // product — which is the state the tab is being rebuilt out of.
    quote,
    quoteChars: quote.length,
    sourceUrl: finding?.sourceUrl == null ? null : String(finding.sourceUrl),
    sourceHost: finding?.sourceHost == null ? null : String(finding.sourceHost),
    sourceTitle: finding?.sourceTitle ?? null,
    publishedAt: finding?.publishedAt ?? null,
    verifyState,
    verifyReason: finding?.verifyReason ?? null,
    // `counts` is the store's own name for the evidence boundary and is carried
    // through unchanged, so the one gate every stage converges on is spelled
    // the same on the wire as it is in the column.
    counts: finding?.counts === true || verifyState === VERIFIED,
    // Three values, never two — see `okOfVerifyState`.
    verified: okOfVerifyState(verifyState),
    documentId: finding?.documentId ?? null,
    spanIndex: finding?.spanIndex ?? null,
    recordedAt: finding?.createdAt == null ? null : String(finding.createdAt),
  };
}

// ── trajectory helpers ───────────────────────────────────────────────────────

/** Order two candidates: by instant, then by stream, then by that stream's own order. */
function compareTraceCandidates(a, b) {
  const at = toMs(a.at) - toMs(b.at);
  if (at !== 0) return at;
  if (a.rank !== b.rank) return a.rank - b.rank;
  return a.ordinal - b.ordinal;
}

/** The chip an event type prints under. An unknown family is SYSTEM, never an invented chip. */
function roleOfEvent(type) {
  if (type.startsWith("stage:")) return "STAGE";
  if (type.startsWith("gate:") || type.startsWith("evidence:") || type.startsWith("recollect:")) return "GATE";
  return "SYSTEM";
}

/** An event's verdict, from the two registered lists. Anything else has NO verdict, which is not the same as passing. */
function okOfEvent(type) {
  if (TRACE_FAILED_EVENTS.includes(type)) return false;
  if (TRACE_PASSED_EVENTS.includes(type)) return true;
  return null;
}

/**
 * A finding's verdict.
 *
 * Three values, not two. `null` means nobody ever checked — a fetch that failed
 * or a host that refused us — and reporting that as `false` is the collapse
 * that makes a rate limit read as a fabrication.
 */
function okOfVerifyState(verifyState) {
  if (verifyState === "") return null;
  if (verifyState.startsWith(UNCHECKED_PREFIX)) return null;
  if (TRACE_REFUTED_STATES.includes(verifyState)) return false;
  return true;
}

/** A step id carried in an event payload rather than in the column. */
function stepIdOf(payload) {
  const value = payload?.stepId ?? payload?.step_id ?? payload?.stage;
  return typeof value === "string" && value !== "" ? value : null;
}

/** A dimension id carried in an event payload, accepted only when it names a KNOWN dimension. */
function dimensionIdOf(payload, dimensionIds) {
  const value = payload?.dimensionId ?? payload?.dimension_id;
  return typeof value === "string" && dimensionIds.has(value) ? value : null;
}

/** The one field of a payload a reader scanning for a failure wants on the right of the arrow. */
function reasonOf(payload, limit) {
  const value = payload?.reason ?? payload?.error ?? payload?.message ?? payload?.note ?? payload?.verdict;
  if (value == null) return null;
  return clip(collapse(String(value)), limit);
}

/** A finite number, or null. Never 0 for "unknown": a latency of zero and an unmeasured latency are different rows. */
function nullableNumber(value) {
  const n = typeof value === "number" ? value : Number(value);
  return Number.isFinite(n) ? n : null;
}

/** A trimmed non-empty string, or null, so `?stepId=` reads as absent rather than as an id of "". */
function emptyToNull(value) {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed === "" ? null : trimmed;
}

/** Newlines and runs of whitespace flattened, because a trajectory row is one line. */
function collapse(text) {
  return text.replace(/\s+/g, " ").trim();
}

/** Cut to `limit`, marking the cut. The marker is what tells the reader there is a detail panel worth opening. */
function clip(text, limit) {
  return text.length <= limit ? text : `${text.slice(0, Math.max(0, limit - 1))}…`;
}

/**
 * A JSON payload as one scannable line.
 *
 * Not `JSON.stringify`: a stringified payload spends its first forty characters
 * on braces and quotes, so every row in the list looks identical until the
 * reader has read past the punctuation. `k=v · k=v` puts the field names where
 * they can be scanned down a column.
 */
function oneLine(value, limit) {
  if (value == null) return "";
  if (typeof value === "string") return clip(collapse(value), limit);
  if (typeof value !== "object") return String(value);
  if (Array.isArray(value)) return clip(`[${value.length}] ${value.map(scalarish).join(", ")}`, limit);
  const parts = [];
  let width = 0;
  for (const [key, entry] of Object.entries(value)) {
    const piece = `${key}=${scalarish(entry)}`;
    parts.push(piece);
    width += piece.length + 3;
    if (width > limit) break;
  }
  return clip(parts.join(" · "), limit);
}

/** One field of a payload, as a short token. A nested object is reported by SHAPE, never expanded. */
function scalarish(value) {
  if (value == null) return "null";
  if (typeof value === "string") return collapse(value).slice(0, 60);
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (Array.isArray(value)) return `[${value.length}]`;
  return `{${Object.keys(value).length}}`;
}

// ── small shared helpers ─────────────────────────────────────────────────────

/** Always an array, so a missing input reads as empty rather than throwing later. */
function asArray(value) {
  return Array.isArray(value) ? value : [];
}

/** A finite number, or the fallback. Never NaN, which formats as "NaN" on screen. */
function numberOr(value, fallback) {
  const n = typeof value === "number" ? value : Number(value);
  return Number.isFinite(n) ? n : fallback;
}

/** SQLite has no boolean; 0/1 INTEGER columns and real booleans both arrive here. */
function truthy(value) {
  return value === true || value === 1 || value === "1";
}

/** Parse a JSON TEXT column, or return the fallback. A malformed column must not blank the tab. */
function parseJson(value, fallback) {
  if (value == null) return fallback;
  if (typeof value === "object") return value;
  try {
    return JSON.parse(String(value));
  } catch {
    // Swallowed on purpose, and this is the read path: one malformed JSON
    // column must not blank the whole tab. The caller's fallback is a shape the
    // client can render, and the bad column is still visible in its raw row.
    return fallback;
  }
}

/** Milliseconds from an ISO 8601 stamp, or 0 when it is absent or unparseable. */
function toMs(iso) {
  if (iso == null) return 0;
  const n = Date.parse(String(iso));
  return Number.isFinite(n) ? n : 0;
}

/** Whether the mission is over. An unknown status with a completion stamp counts. */
function isTerminal(row) {
  const status = String(row.status ?? "");
  if (TERMINAL_STATUSES.includes(status)) return true;
  // Never default an unknown status to running (§5.1).
  return status !== "running" && row.completed_at != null;
}

/**
 * The clock a mission is measured against: `max(started_at, last_reopened_at)`.
 * Without the reopen stamp a resumed mission is instantly wall-time-killed
 * against its original start.
 */
function effectiveStartMs(row) {
  return Math.max(toMs(row.started_at), toMs(row.last_reopened_at));
}

/** When the elapsed clock stops: the completion stamp for a finished mission, `now` otherwise. */
function terminalEndMs(row, now) {
  const done = toMs(row.completed_at);
  return done > 0 ? done : now;
}

/**
 * Drop duplicate event rows by `seq`.
 *
 * `(mission_id, seq)` is the primary key, so duplicates cannot come from the
 * database — they come from a caller concatenating two overlapping pages, which
 * is exactly what the idempotence test does on purpose. Deduping here is what
 * makes `project(events ⊕ events)` equal `project(events)`.
 */
function dedupeEvents(events) {
  const seen = new Map();
  for (const e of events) {
    if (e == null) continue;
    const seq = numberOr(e.seq, NaN);
    if (!Number.isFinite(seq)) continue;
    if (!seen.has(seq)) seen.set(seq, e);
  }
  return [...seen.values()];
}

/** A verify-state histogram as a plain object, whatever shape the caller supplied. */
function normaliseCounts(counts) {
  const out = Object.create(null);
  if (!counts || typeof counts !== "object") return out;
  for (const [k, v] of Object.entries(counts)) out[String(k)] = numberOr(v, 0);
  return out;
}

// ── what the stages decided ──────────────────────────────────────────────────

/**
 * The four stages whose output IS the mission's reasoning, and the key each is
 * reshaped under.
 *
 * Not every stage: s8 writes prose that the artefact already carries, s12
 * writes bookkeeping. These four hold judgements that exist nowhere else on
 * disk — the Leader's per-dimension verdict, the reconciled fact table, the
 * critic's blindspots, and the signature — and every one of them was
 * unreachable except by guessing the event `seq` a trajectory ref is keyed on.
 */
export const INSIGHT_STAGES = Object.freeze([
  Object.freeze({ key: "assess", stepId: "s4-assess" }),
  Object.freeze({ key: "reconcile", stepId: "s5-reconcile" }),
  Object.freeze({ key: "critique", stepId: "s10-critique" }),
  Object.freeze({ key: "signoff", stepId: "s11-signoff" }),
]);

/**
 * Reshape the four reasoning stages' recorded output into one readable answer.
 *
 * READ-TIME ONLY. Nothing here writes, nothing here migrates, and every field
 * it returns was already in `mission_stages.output` before this function
 * existed. That is deliberate: a write-path change would only help missions run
 * after it, and every mission already on disk — including the ones somebody
 * actually wants to read — would go on saying nothing.
 *
 * A MISSING STAGE IS `null` WITH A REASON, NEVER `{}`. An empty object renders
 * as a panel with headings and no content, which reads as "the Leader had no
 * blindspots to report" when the truth is "s10 never ran". The two want
 * opposite reactions, so `sources` carries the stage's real status and a
 * sentence naming which of the three cases this is: no row, a row that never
 * produced output, or output this projection could not read.
 *
 * @param {object[]} stageOutputs - `MissionStore.listStageOutputs` rows.
 * @returns {object} `{assess, reconcile, critique, signoff, sources}`.
 */
export function projectStageInsights(stageOutputs) {
  const byStep = new Map();
  for (const row of asArray(stageOutputs)) {
    if (row && row.stepId != null) byStep.set(String(row.stepId), row);
  }

  const out = { assess: null, reconcile: null, critique: null, signoff: null, sources: {} };

  for (const { key, stepId } of INSIGHT_STAGES) {
    const row = byStep.get(stepId) ?? null;
    const output = row?.output ?? null;
    const usable = output !== null && typeof output === "object" && !Array.isArray(output);

    out.sources[key] = {
      stepId,
      present: usable,
      status: row?.status ?? null,
      attempts: row === null ? null : numberOr(row.attempts, 0),
      reason: usable
        ? null
        : row === null
          ? `mission_stages has no ${stepId} row for this mission; §4.3 writes twelve at s1, so this mission predates that or s1 did not finish its bookkeeping.`
          : output === null
            ? `${stepId} is ${row.status} and recorded no output. There is no decision here to show — this is an absence, not an empty result.`
            : `${stepId} recorded output that is not an object (${Array.isArray(output) ? "an array" : typeof output}); this projection will not guess at its shape.`,
      // Only the LAST attempt's output survives in mission_stages — one row per
      // step id — so a stage that ran twice has one output here and its earlier
      // reasoning only in the trajectory. Said out loud on every stage that
      // retried rather than left for a reader to discover.
      supersededAttempts: row === null ? null : Math.max(0, numberOr(row.attempts, 0) - 1),
    };

    if (!usable) continue;
    if (key === "assess") out.assess = shapeAssess(output);
    if (key === "reconcile") out.reconcile = shapeReconcile(output);
    if (key === "critique") out.critique = shapeCritique(output);
    if (key === "signoff") out.signoff = shapeSignoff(output);
  }

  return out;
}

/** s4's verdict: what the Leader decided about each dimension, and about the whole. */
function shapeAssess(output) {
  return {
    decision: textOrNull(output.decision),
    rationale: textOrNull(output.rationale),
    derivedFloor: output.derivedFloor == null ? null : numberOr(output.derivedFloor, 0),
    perDimension: asArray(output.perDimension).map((row) => ({
      dimensionId: textOrNull(row?.dimensionId),
      action: textOrNull(row?.action),
      // s4 has written this field under both names across drafts. Both are
      // read; the field is never left null while a value sits in the other one.
      rationale: textOrNull(row?.rationale) ?? textOrNull(row?.critique),
      verified: row?.verified == null ? null : numberOr(row.verified, 0),
      meetsFloor: typeof row?.meetsFloor === "boolean" ? row.meetsFloor : null,
      shortfall: row?.shortfall == null ? null : numberOr(row.shortfall, 0),
      uniqueHosts: row?.uniqueHosts == null ? null : numberOr(row.uniqueHosts, 0),
    })),
    weakest: asArray(output.weakest),
    shrinkRung: output.shrinkRung ?? null,
  };
}

/** s5's reconciliation: the fact table, and what it could not reconcile. */
function shapeReconcile(output) {
  const facts = asArray(output.facts);
  const conflicts = asArray(output.conflicts);
  const overlaps = asArray(output.overlaps);
  const gaps = asArray(output.gaps);
  return {
    facts,
    conflicts,
    overlaps,
    gaps,
    hypotheses: asArray(output.hypotheses),
    // The stage's own counts pass through unchanged, and the lengths this
    // projection actually returned are reported beside them. A disagreement
    // between the two is a real disagreement worth seeing, not something to
    // reconcile silently into whichever number is to hand.
    counts: {
      ...(output.counts && typeof output.counts === "object" ? output.counts : {}),
      returnedFacts: facts.length,
      returnedConflicts: conflicts.length,
      returnedOverlaps: overlaps.length,
      returnedGaps: gaps.length,
    },
  };
}

/** s10's critique: what the report cannot see, and where it leans. */
function shapeCritique(output) {
  return {
    blindspots: asArray(output.blindspots),
    biases: asArray(output.biases),
    forecastVulnerabilities: asArray(output.forecastVulnerabilities),
    counts: {
      blindspots: asArray(output.blindspots).length,
      biases: asArray(output.biases).length,
      forecastVulnerabilities: asArray(output.forecastVulnerabilities).length,
    },
  };
}

/** s11's signature: signed or refused, and the words for it. */
function shapeSignoff(output) {
  const signature = output.signature && typeof output.signature === "object" ? output.signature : {};
  return {
    signature: {
      // null / true / false, never coerced. `null` means s11 wrote a signature
      // block with no verdict in it; `false` means the Leader read the report
      // and refused. Collapsing them loses the only distinction that matters.
      signed: typeof signature.signed === "boolean" ? signature.signed : null,
      score: signature.score == null ? null : numberOr(signature.score, 0),
      verdict: textOrNull(signature.verdict),
      refusalReason: textOrNull(signature.refusalReason),
      accountabilityNote: textOrNull(signature.accountabilityNote),
    },
    foreword: output.foreword && typeof output.foreword === "object" ? output.foreword : null,
    // The forced-unsign ladder's corrections. s11 has recorded these both on
    // the signature and at the top level; both are read and merged, because a
    // correction that exists and is not shown is the ladder firing invisibly.
    corrections: [...asArray(signature.corrections), ...asArray(output.corrections)],
    leaderScore: output.leaderScore == null ? null : numberOr(output.leaderScore, 0),
  };
}

/** A string, or null. Never `""` — an empty string renders as a field that exists and says nothing. */
function textOrNull(value) {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed === "" ? null : trimmed;
}

// ── why an artefact is degraded ──────────────────────────────────────────────

/** The event whose payload carries the guard's violations as structured rows. */
const FINALIZED_EVENT = "mission:finalized";

/**
 * WHY this artefact is degraded, said on the artefact itself.
 *
 * `degraded: true` is a flag with no sentence attached, and the reader of a
 * report is exactly the person who needs the sentence. Everything here is
 * already on disk: the mission row's `failure_code`, `error_message`,
 * `leader_signed` and `final_score`, plus s11's signature.
 *
 * DERIVED AT READ TIME, on purpose. Writing this into the artefact row instead
 * would help only artefacts produced after the change; every artefact that
 * exists today would keep saying nothing, which is the whole complaint.
 *
 * THE VIOLATIONS COME FROM THE EVENT, NOT FROM THE PROSE. `s12` builds
 * `error_message` by joining `${code}: ${detail}` with a space, and the same
 * violations go into the `mission:finalized` payload as structured rows. The
 * structured ones are used when they are there; splitting the sentence is the
 * fallback for a mission whose terminal event predates the payload, and the
 * result says which of the two it used rather than presenting a parse as a
 * record.
 *
 * @param {object} args - `{mission, signoff, finalizedPayload}`.
 * @returns {object} `{signed, score, verdict, refusalReason, accountabilityNote, guardViolations, guardMessage, guardSource, failureCode, degraded}`.
 */
export function projectDegradeReason({ mission, signoff = null, finalizedPayload = null }) {
  const row = mission ?? {};
  const signature = signoff?.signature ?? null;
  const guardMessage = textOrNull(row.errorMessage);

  const structured = asArray(finalizedPayload?.detail?.violations)
    .filter((entry) => entry && typeof entry.code === "string")
    .map((entry) => ({ code: entry.code, detail: textOrNull(entry.detail) }));
  const guardViolations = structured.length > 0 ? structured : splitGuardViolations(guardMessage);

  // The mission row wins on `signed` and `score`: `finalizeMissionRow` writes
  // the number AFTER the forced-unsign ladder, and s11's own signature is the
  // Leader's pre-correction one. Where the row carries nothing — a mission that
  // died before the terminal write — the signature is used and `signedSource`
  // says so, rather than a null being served as "not signed".
  const rowSigned = typeof row.leaderSigned === "boolean" ? row.leaderSigned : null;
  const signatureSigned = typeof signature?.signed === "boolean" ? signature.signed : null;

  return {
    signed: rowSigned ?? signatureSigned,
    signedSource: rowSigned !== null ? "missions.leader_signed" : signatureSigned !== null ? "s11-signoff.output.signature.signed" : null,
    score: row.finalScore ?? signature?.score ?? null,
    verdict: textOrNull(row.leaderVerdict) ?? signature?.verdict ?? null,
    refusalReason: signature?.refusalReason ?? null,
    accountabilityNote: signature?.accountabilityNote ?? null,
    guardViolations,
    guardMessage,
    guardSource: structured.length > 0
      ? `${FINALIZED_EVENT}.detail.violations`
      : guardViolations.length > 0
        ? "split from missions.error_message; the terminal event carried no structured violations"
        : null,
    failureCode: textOrNull(row.failureCode),
    // The three ways an artefact can be degraded, kept apart. A report can fail
    // the guard while the Leader signs it, and the Leader can refuse a report
    // that passes every guard.
    degraded: guardViolations.length > 0 || (rowSigned ?? signatureSigned) === false || textOrNull(row.failureCode) !== null,
  };
}

/**
 * Split `s12`'s joined guard sentence back into the violations it was built
 * from.
 *
 * The FALLBACK, used only when the terminal event carried no structured rows.
 * It matches on the closed set of guard codes rather than on "a word followed
 * by a colon", because the details themselves contain colons and a generic
 * pattern would cut a violation in half at the first one and present the halves
 * as two findings.
 *
 * @param {string|null} message - `missions.error_message`.
 * @returns {object[]} `[{code, detail}]`, in the order they appear.
 */
export function splitGuardViolations(message) {
  if (typeof message !== "string" || message.trim() === "") return [];

  const hits = [];
  for (const code of GUARD_CODES) {
    let from = 0;
    for (;;) {
      const at = message.indexOf(`${code}: `, from);
      if (at < 0) break;
      // Only at a boundary: `word-count: ` inside a detail sentence is prose,
      // not the start of the next violation.
      const before = at === 0 ? "" : message[at - 1];
      if (at === 0 || before === "：" || before === ":" || before === " " || before === "\n") {
        hits.push({ code, at });
      }
      from = at + code.length;
    }
  }
  hits.sort((a, b) => a.at - b.at);

  return hits.map((hit, index) => {
    const start = hit.at + hit.code.length + 2;
    const end = index + 1 < hits.length ? hits[index + 1].at : message.length;
    return { code: hit.code, detail: textOrNull(message.slice(start, end)) };
  });
}

/**
 * Every code `contentGuard` in lib/mission-stages-back.js can emit.
 *
 * A COPY, and named as one. The guard owns the list; this module only has to
 * recognise the codes inside a sentence it did not build, and importing the
 * whole stage module into the read model to get a seven-element array would
 * pull the writer half into every view request. If the guard grows a code and
 * this list does not, the fallback split misses it — which is why the
 * structured violations on the terminal event are preferred and this is the
 * fallback, and why `guardSource` says which one produced the answer.
 */
const GUARD_CODES = Object.freeze([
  "word-count",
  "empty-chapter",
  "under-delivered",
  "no-citations",
  "section-offsets",
  "placeholder",
  "scorecard-empty",
]);

/**
 * The bibliography a report.md export ships with.
 *
 * Built by joining `artifact.citations` to `artifact.evidence` on `findingId`.
 * An index that will not join is printed anyway, marked, and never dropped: a
 * silently omitted citation turns `[7]` in the prose into a dangling reference
 * to nothing, and the reader has no way to tell that from a numbering mistake.
 *
 * @param {object} artifact - the stored artefact row, with `citations` and `evidence`.
 * @param {object} [options] - `{language}` — "zh" picks the Chinese heading.
 * @returns {string} the section, starting with a blank line and its heading, or "" when there is nothing to cite.
 */
export function buildBibliography(artifact, { language = "zh" } = {}) {
  const citations = asArray(artifact?.citations);
  if (citations.length === 0) return "";

  const zh = String(language ?? "zh").toLowerCase().startsWith("zh");
  const evidence = new Map();
  for (const row of asArray(artifact?.evidence)) {
    if (row && typeof row.findingId === "string") evidence.set(row.findingId, row);
  }

  const lines = [];
  lines.push("");
  lines.push(zh ? "## 参考文献" : "## References");
  lines.push("");

  // Sorted by the index the PROSE uses, not by the order the array happens to
  // be in, and deduped on it: two citation rows carrying index 3 would
  // otherwise print `[3]` twice and push every later entry out of step with
  // the text that refers to it.
  const seen = new Set();
  const ordered = [...citations]
    .map((row, position) => ({ row, index: Number.isInteger(row?.index) ? row.index : position + 1 }))
    .sort((a, b) => a.index - b.index);

  for (const { row, index } of ordered) {
    if (seen.has(index)) continue;
    seen.add(index);
    const url = typeof row?.url === "string" && row.url !== "" ? row.url : null;
    const found = typeof row?.findingId === "string" ? evidence.get(row.findingId) ?? null : null;

    if (found === null) {
      // Printed, marked, never omitted. The metadata is missing; the citation
      // is not.
      lines.push(`[${index}] ${zh ? "（引用元数据缺失）" : "(citation metadata missing)"} ${url ?? (zh ? "（无链接）" : "(no url)")}`);
      const inline = textOrNull(row?.inlineQuote);
      if (inline !== null) lines.push(`    > ${oneLineQuote(inline)}`);
      lines.push("");
      continue;
    }

    const label = textOrNull(found.sourceTitle) ?? textOrNull(found.sourceHost) ?? (zh ? "（来源不详）" : "(source unknown)");
    lines.push(`[${index}] ${label} — ${url ?? found.sourceUrl ?? (zh ? "（无链接）" : "(no url)")}`);

    const quote = textOrNull(found.quote) ?? textOrNull(row?.inlineQuote);
    if (quote !== null) lines.push(`    > ${oneLineQuote(quote)}`);

    // The fetch stamp, which is what makes the quote checkable: it says the
    // page said this, on this date, with this status. A quote with no stamp is
    // an assertion about a page that may since have changed.
    const stamp = [
      found.fetchedAt == null ? null : `${zh ? "抓取于" : "fetched"} ${found.fetchedAt}`,
      found.status == null ? null : `HTTP ${found.status}`,
      textOrNull(found.verifyState),
    ].filter((part) => part !== null);
    if (stamp.length > 0) lines.push(`    ${stamp.join(" · ")}`);
    lines.push("");
  }

  return lines.join("\n");
}

/** One line of quote, so a multi-paragraph span cannot break the list it sits in. */
function oneLineQuote(text) {
  return String(text).replace(/\s+/gu, " ").trim();
}
