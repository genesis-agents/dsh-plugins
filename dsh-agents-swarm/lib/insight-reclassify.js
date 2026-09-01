/**
 * Bring the claims already in the table up to the format the new ones arrive in.
 *
 * TWO THINGS CHANGED UNDER THEM AND NEITHER IS RETROACTIVE. `insightChinese`
 * decides the language the extractor writes a claim in, and `layer` — where in
 * the stack it sits — is a field the extractor was not asked for until now.
 * Every row written before either change carries an English sentence and no
 * layer, and no amount of re-running the pass fixes them: a pass reads the NEXT
 * two hundred sources, not the ones it has already read.
 *
 * So the rows are rewritten in place, and the two words that matter are IN
 * PLACE: this does not re-extract, re-verify or re-score anything. It is a
 * translation and a filing decision over the sentence the pass already wrote,
 * and it touches nothing else on the row.
 *
 * THE EVIDENCE IS NEVER TOUCHED. A quote is verbatim and was checked against
 * the block the model was shown; translating it would break that check, break
 * the transcript match that puts `▶ 38:08` under it, and turn the one thing on
 * the card that is not a machine's judgement into another one. The statement is
 * the pass's own paraphrase and is the only thing here that may be rewritten.
 */

import { simhash } from "./insights.js";
import { INSIGHT_LAYERS } from "./insight-store.js";

/** Claims per model call. Small enough to re-read, large enough to be cheap. */
const BATCH = 10;

/** Anything in this range is a Han character; one is enough to call a line Chinese. */
const HAN = /[一-鿿]/u;

/**
 * The prompt for one batch.
 *
 * NUMBERED, AND THE ANSWER IS KEYED BY THE NUMBER. Handing back the id would
 * work and would also put forty-character identifiers into the answer for a
 * model to copy — and a model that mistypes one silently rewrites the wrong
 * claim. A small integer is checkable.
 * @param claims - `[{ statement }]` in order.
 * @param zh - whether the statements should come back in Chinese.
 * @returns the prompt.
 */
export function reclassifyPrompt(claims, zh) {
  return [
    "You are filing claims that have already been extracted from a library of sources about AI and computing.",
    "",
    "For each claim below, answer two questions about it. Do NOT re-judge it, do not add to it, and do not decide whether it is true — that has been done. You are filing what is already written.",
    "",
    "\"layer\" is WHERE IN THE STACK the claim sits. Exactly one of:",
    "  energy      — power, generation, grid, cooling, siting, the electricity a data centre needs",
    "  compute     — chips, interconnect, data centres, capacity, capex, the cost of a unit of compute",
    "  model       — training, architecture, weights, licences, benchmarks, what a model can do",
    "  application — products built on models, adoption, workflows, what somebody uses it for",
    "  cross       — a relationship BETWEEN layers, and only when that relationship IS the claim",
    "Use \"cross\" sparingly. A claim that merely mentions two layers is not cross-layer; pick the one it is ABOUT. If none of the five fits — the claim is not about this stack at all — use null. A null is honest; a wrong layer sends a reader to the wrong section for ever.",
    "",
    zh
      ? "\"statement\" — rewrite the claim in Simplified Chinese. Keep every number, date, proper name and unit EXACTLY as it stands: they are the part of the claim a reader checks. Keep company, model and product names in their original spelling rather than transliterating them. One sentence, and say no more than the original says — you are translating a claim, not improving it. If it is already in Chinese, return it unchanged."
      : "\"statement\" — return the claim unchanged. It is already in the language this library is read in.",
    "",
    "Return ONE JSON object and nothing else. No prose before it, no prose after it, no code fence:",
    "",
    "{\"claims\":[{\"n\":1,\"layer\":\"compute\",\"statement\":\"…\"},{\"n\":2,\"layer\":null,\"statement\":\"…\"}]}",
    "",
    "Every claim below must appear exactly once in your answer, by its own number.",
    "",
    ...claims.map((claim, at) => `${at + 1}. ${String(claim?.statement ?? "").trim()}`),
  ].join("\n");
}

/**
 * Read the model's answer back onto the batch.
 *
 * BY NUMBER, AND A NUMBER OUTSIDE THE BATCH IS DROPPED rather than clamped: a
 * clamp would file claim eleven's layer onto claim ten, and the two would look
 * exactly as correct as a right answer.
 * @param answer - the model's text.
 * @param claims - the batch, in the order it was numbered.
 * @param zh - whether a rewritten statement was asked for.
 * @returns `[{ id, statement, layer }]`, only for the ones that changed.
 */
export function readReclassification(answer, claims, zh) {
  let parsed;
  try {
    const text = String(answer ?? "");
    const from = text.indexOf("{");
    const to = text.lastIndexOf("}");
    parsed = from < 0 || to <= from ? null : JSON.parse(text.slice(from, to + 1));
  } catch { parsed = null; }
  if (parsed === null || !Array.isArray(parsed.claims)) return [];

  const out = [];
  const seen = new Set();
  for (const row of parsed.claims) {
    const at = Number(row?.n);
    if (!Number.isInteger(at) || at < 1 || at > claims.length || seen.has(at)) continue;
    seen.add(at);
    const claim = claims[at - 1];
    const layer = typeof row?.layer === "string" ? row.layer.trim().toLowerCase() : "";
    const patch = { id: claim.id };
    if (INSIGHT_LAYERS.includes(layer)) patch.layer = layer;
    if (zh) {
      const statement = typeof row?.statement === "string" ? row.statement.trim() : "";
      // ONLY IF IT CAME BACK IN CHINESE. A model that echoed the English back
      // would otherwise rewrite the row with itself, spend a simhash change on
      // nothing, and report a translation that did not happen.
      if (statement !== "" && HAN.test(statement) && statement !== claim.statement) {
        patch.statement = statement;
        patch.simhash = simhash(statement);
      }
    }
    if (patch.layer !== undefined || patch.statement !== undefined) out.push(patch);
  }
  return out;
}

/** Which rows still need filing: no layer, or an English sentence in a Chinese library. */
export function needsReclassifying(row, zh) {
  const unplaced = !INSIGHT_LAYERS.includes(row?.layer);
  const untranslated = zh === true && !HAN.test(String(row?.statement ?? ""));
  return unplaced || untranslated;
}

/**
 * File every claim that still needs it.
 *
 * @param deps - `{ insights, chat, config, logger }`.
 * @returns `{ examined, changed, translated, placed, batches, failures }`.
 */
export async function runReclassifyPass({ insights, chat, config, logger }) {
  const zh = config?.insightChinese === true;
  // EVERY STATUS, INCLUDING DORMANT. A dormant claim is still on the page under
  // its filter, and one left in English under 未归层 is exactly the row that
  // makes the table look half-converted.
  const held = insights.list({ take: 500, sortBy: "recent" });
  const rows = (held?.insights ?? []).filter((row) => needsReclassifying(row, zh));
  const report = { examined: rows.length, changed: 0, translated: 0, placed: 0, merged: 0, batches: 0, failures: [] };
  // NO EARLY RETURN. A table with nothing left to refile can still hold
  // duplicates this pass created on an earlier run — that was the shape of the
  // bug: rewriting statements moves their hashes, and the rows that drifted
  // apart are exactly the ones a later "nothing to do" run would skip past.

  for (let at = 0; at < rows.length; at += BATCH) {
    const batch = rows.slice(at, at + BATCH);
    report.batches += 1;
    let answer;
    try {
      answer = await chat(reclassifyPrompt(batch, zh));
    } catch (cause) {
      // ONE BATCH, NOT THE PASS. Ten claims left as they were is a smaller loss
      // than forty, and the next run picks them up because the filter is a
      // property of the row rather than a cursor.
      report.failures.push(`batch ${report.batches}: ${String(cause?.message ?? cause)}`);
      continue;
    }
    for (const patch of readReclassification(answer, batch, zh)) {
      try {
        if (!insights.reclassifyInsight(patch.id, patch)) continue;
        report.changed += 1;
        if (patch.statement !== undefined) report.translated += 1;
        if (patch.layer !== undefined) report.placed += 1;
      } catch (cause) {
        report.failures.push(`${patch.id}: ${String(cause?.message ?? cause)}`);
      }
    }
  }
  // AND THE DUPLICATES THIS PASS ITSELF CREATES. Rewriting a statement moves
  // its simhash, so a claim translated here and the same claim extracted
  // afresh in the target language are two rows that will never find each
  // other by words. They are found by evidence instead — see below.
  const merged = mergeIdenticalEvidence(insights, logger);
  report.merged = merged.merged;
  logger?.info?.(`swarm: reclassified ${report.changed} of ${report.examined} claim(s); ${report.placed} placed, ${report.translated} rewritten, ${merged.merged} merged`);
  return report;
}

/**
 * Two claims resting on exactly the same evidence are one claim.
 *
 * WHY THIS IS NEEDED, AND IT IS THE PASS ABOVE'S OWN FAULT. Near-duplicate
 * detection is a simhash over the STATEMENT, and rewriting statements is
 * precisely what that pass does — so a claim extracted in English and then
 * translated, and the same claim extracted afresh in Chinese, end as two rows
 * with two different wordings, two different hashes, and no reason for either
 * to notice the other. Measured on the real library: a Mayfield claim appeared
 * twice, same quote, same video, same second.
 *
 * BY EVIDENCE, NOT BY WORDS. The words are the pass's paraphrase and two
 * paraphrases of one fact are allowed to differ; the evidence IS the fact. A
 * signature of `resourceId|quote` over the whole set is exact, needs no model
 * call and no threshold, and cannot merge two claims that merely resemble each
 * other — which a loosened simhash could, and that is a merge nobody can undo.
 *
 * THE OLDEST SURVIVES. `first_seen_at` is the column that answers "since
 * when", and keeping the newer row would reset it: a card standing since
 * August would say it was first seen today.
 * @param insights - the store.
 * @param logger - optional.
 * @returns `{ examined, merged }`.
 */
export function mergeIdenticalEvidence(insights, logger) {
  const held = insights.list({ take: 500, sortBy: "recent" });
  const rows = held?.insights ?? [];
  const report = { examined: rows.length, merged: 0 };

  const groups = new Map();
  for (const row of rows) {
    const full = insights.getWithEvidence(row.id);
    const evidence = Array.isArray(full?.evidence) ? full.evidence : [];
    // NO EVIDENCE IS NOT A SIGNATURE. Two claims that rest on nothing are not
    // thereby the same claim, and grouping them would merge the whole tail of
    // a table whose rows had lost their sources.
    if (evidence.length === 0) continue;
    const key = evidence
      .map((piece) => `${piece?.resourceId ?? ""}|${String(piece?.quote ?? "").trim()}`)
      .sort()
      .join(" ");
    const list = groups.get(key) ?? [];
    list.push(full);
    groups.set(key, list);
  }

  for (const list of groups.values()) {
    if (list.length < 2) continue;
    list.sort((left, right) => String(left.firstSeenAt ?? "").localeCompare(String(right.firstSeenAt ?? "")));
    for (const doomed of list.slice(1)) {
      // A PINNED VERDICT IS A PERSON'S DECISION and outranks this. Removing
      // the row would throw it away silently, which is the one failure
      // `pinned_status` exists to prevent.
      if (doomed.pinnedStatus !== null && doomed.pinnedStatus !== undefined) continue;
      if (insights.remove(doomed.id)) {
        report.merged += 1;
        logger?.info?.(`swarm: merged duplicate claim ${doomed.id} into ${list[0].id}`);
      }
    }
  }
  return report;
}
