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
  const report = { examined: rows.length, changed: 0, translated: 0, placed: 0, batches: 0, failures: [] };
  if (rows.length === 0) return report;

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
  logger?.info?.(`swarm: reclassified ${report.changed} of ${report.examined} claim(s); ${report.placed} placed, ${report.translated} rewritten`);
  return report;
}
