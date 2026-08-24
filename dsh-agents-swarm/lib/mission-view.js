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
 * @returns {object} `{mission, stages, dimensions, agents, todo, cost, artifact, timeline, resume, swept}`.
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

  const mission = projectMission({
    row, policy, now, terminal, runCount, stages, dimensions, chapters,
    evidence, artifact, cost, swept,
  });

  return { mission, stages, dimensions, agents, todo, cost, artifact, timeline, resume, swept };
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
  const dimensionRows = query(db, "SELECT * FROM mission_dimensions WHERE mission_id = ?", [missionId]);

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
      FROM mission_spend WHERE mission_id = ?`, [missionId])[0] ?? {};

  const byStage = query(db, `
    SELECT step_id, role,
           COALESCE(SUM(prompt_tok),0)     AS prompt_tok,
           COALESCE(SUM(completion_tok),0) AS completion_tok,
           COALESCE(SUM(cache_read_tok),0) AS cache_read_tok,
           COALESCE(SUM(calls),0)          AS calls
      FROM mission_spend WHERE mission_id = ? GROUP BY step_id, role`, [missionId]);

  const byAgent = query(db, `
    SELECT agent_id, role, MAX(step_id) AS step_id,
           COALESCE(SUM(prompt_tok),0)     AS prompt_tok,
           COALESCE(SUM(completion_tok),0) AS completion_tok,
           COALESCE(SUM(cache_read_tok),0) AS cache_read_tok,
           COALESCE(SUM(calls),0)          AS calls
      FROM mission_spend WHERE mission_id = ? GROUP BY agent_id, role`, [missionId]);

  // `pace_key` is which ceiling a call consumed, so this is the meter for
  // arXiv, web and fetch. Calls with no pace key consume no ceiling and are
  // excluded rather than bucketed under a made-up key.
  const paceRows = query(db, `
    SELECT pace_key, COUNT(*) AS n
      FROM mission_tool_calls
     WHERE mission_id = ? AND pace_key IS NOT NULL
     GROUP BY pace_key`, [missionId]);
  const toolsByPaceKey = Object.create(null);
  for (const p of paceRows) toolsByPaceKey[String(p.pace_key)] = numberOr(p.n, 0);

  const toolsByAgent = query(db, `
    SELECT agent_id,
           COUNT(*)                                AS calls,
           SUM(CASE WHEN ok = 0 THEN 1 ELSE 0 END) AS failures,
           SUM(CASE WHEN cached = 1 THEN 1 ELSE 0 END) AS cached
      FROM mission_tool_calls WHERE mission_id = ? GROUP BY agent_id`, [missionId]);

  const toolTotals = query(db, `
    SELECT SUM(CASE WHEN ok = 0 THEN 1 ELSE 0 END)     AS failures,
           SUM(CASE WHEN cached = 1 THEN 1 ELSE 0 END) AS cached
      FROM mission_tool_calls WHERE mission_id = ?`, [missionId])[0] ?? {};

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
