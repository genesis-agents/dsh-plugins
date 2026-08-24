# 洞察 — a landing plan

Status: proposal, 2026-08-23. Nothing here is built. The tab exists and says so.

The pipeline this product is built around is `信源 → 洞察 → 研究 → 推演`, and only
the first and last-but-one stages are real. 信源 collects and lets you read;
发布 turns a selection into a podcast, a digest or a report. Between them sits
the stage that would make the other two worth having, and it is empty.

This is a plan for filling it, grounded in what comparable systems actually do
and in what this library actually holds.

---

## 1. What an insight is, and what it is not

The trap is that 洞察 sounds like "a better summary", and the daily digest is
already a summary. Building a second summarizer would produce a tab nobody
opens.

The distinction that survives contact with real systems is **persistence**.
Feedly's Insight Cards are not documents; they are *entities* — a CVE, a threat
actor, a campaign — carrying a description, aliases, a first-seen timestamp, and
a continuously-updated timeline of events, where the system "continuously
detects and synthesizes key events and updates the timeline."[^feedly-cve] A
digest is thrown away tomorrow. A card is not: it accrues.

So:

> **An insight is a standing claim with provenance, that accrues evidence over
> time.**

A digest answers *what happened today*. An insight answers *what do we now
believe, since when, on whose word, and has anything contradicted it*. That
second question is the one a person cannot answer by reading faster, and it is
the only one worth spending a model on.

It is also the shape that gives the next two stages something to attach to: 研究
opens against an insight, 推演 projects from one. Neither has a subject until
this exists.

## 2. What the industry does

Five findings shaped the design below. Each changed something concrete.

**Dedupe before you cluster, and dedupe hard.** Feedly separates the two
deliberately: deduplication groups articles whose content is near-identical,
clustering groups articles covering different angles of the same event. They
report that **80% of their articles are duplicates of another article**, use
Locality Sensitive Hashing to match anything over ~80% similar, and note that
density-based clustering is quadratic and therefore the thing to protect.[^feedly-clustering]

→ We do URL-level dedup already and it is perfect (20,708 rows, 20,708 distinct
normalized URLs). What we do *not* do is near-duplicate detection, and without
it every wire rewrite of the same story becomes its own claim.

**A claim without a verifiable quote is not provenance.** The research on
claim-evidence interfaces builds explicit claim→evidence structures rather than
citations appended to prose,[^papertrail] and the analyst platforms converged on
the same thing from the commercial side: Hebbia provides **sentence-level
citations for every fact and quote**, which is what makes an output "defensible
in board presentations".[^hebbia]

→ Every claim we store carries a verbatim quote and the row it came from, and a
claim whose quote is not a literal substring of its source is discarded. This is
the single highest-value guard in the whole design, and it costs nothing.

**Signal versus noise has four tests, not one.** The competitive-intelligence
literature is unusually concrete here: novelty (is this genuinely new?),
relevance (could this matter to you?), credibility (does it have a factual
foundation?), and momentum (**are multiple independent sources reporting
similar developments?**).[^comintelli] The concept traces to Ansoff's "weak
signals" from the 1970s.[^weaksignal]

→ These become four stored numbers, not a vibe. Momentum in particular is
mechanical and we have the data for it: *independent* means distinct source,
not distinct article.

**Extraction is per-story, not per-article.** The claim-extraction work uses
few-shot LLM extraction but filters first with retrieval to cut cost.[^papertrail]

→ One model call per cluster, not per row. With ~120 new rows a day this is the
difference between affordable and silly.

**Structured comparison beats prose.** AlphaSense's Generative Grid answers many
questions across many documents into a table; the 2026 direction is workflow
agents that automate a whole analysis arc rather than assisting a search.[^alphasense]

→ Not phase one, but it is where 研究 should go: an insight is a row, the
questions are columns.

## 3. The design

### Data model

Two tables beside `resources`. Both are plain SQLite, synchronous, no vectors,
no service.

```sql
CREATE TABLE IF NOT EXISTS insights (
  id                  TEXT PRIMARY KEY,
  statement           TEXT NOT NULL,     -- one sentence, the claim itself
  kind                TEXT NOT NULL,     -- launch | funding | policy | finding | shift
  entities            TEXT,              -- JSON array, who/what it is about
  status              TEXT NOT NULL,     -- candidate | standing | contested | dormant
  first_seen_at       TEXT NOT NULL,
  last_seen_at        TEXT NOT NULL,
  source_count        INTEGER NOT NULL DEFAULT 0,
  independent_count   INTEGER NOT NULL DEFAULT 0,   -- distinct sources, not articles
  contradiction_count INTEGER NOT NULL DEFAULT 0,
  credibility         REAL NOT NULL DEFAULT 0,
  supersedes          TEXT,              -- id of the claim this replaced
  updated_at          TEXT NOT NULL
) STRICT;

CREATE TABLE IF NOT EXISTS insight_evidence (
  insight_id   TEXT NOT NULL,
  resource_id  TEXT NOT NULL,
  stance       TEXT NOT NULL,            -- supports | contradicts | context
  quote        TEXT NOT NULL,            -- verbatim, verified against the source
  added_at     TEXT NOT NULL,
  PRIMARY KEY (insight_id, resource_id)
) STRICT;
```

`stance` is what makes disagreement a first-class object rather than an
inconvenience. Two sources contradicting each other on the same claim is the
most valuable thing this library can surface, and it is invisible today.

`independent_count` is deliberately separate from `source_count`. Five articles
that are all rewrites of one wire story are one independent source, and treating
them as five is how a system manufactures false confidence. We have 45 distinct
`source_type` values to key this on.

### The pipeline

Runs on the collection tick that already exists, over the window that already
exists — `pickSources` walks a watermark and only sees rows newer than the last
run. Nothing here re-reads the library.

```
new rows since watermark  (~120/day measured)
        │
   ① near-dup fold        simhash over title+abstract shingles
        │                 exact URL dupes are already impossible
   ② cluster              same bucket + token overlap, 7-day window
        │                 comparisons bounded to within a bucket
   ③ extract              ONE model call per cluster
        │                 → 1–3 claims, each with source ids and a verbatim quote
   ④ verify quotes        literal substring check; drop what fails
        │
   ⑤ reconcile            new claim, or new evidence on a standing one,
        │                 or a contradiction of one
   ⑥ score                novelty · relevance · credibility · momentum
```

**① and ②** are ordinary code, no model. Feedly's own numbers say this is where
the volume goes, and it is the cheapest stage to get right.

**③** is the only model call. Prompt shape: given N articles about one story,
emit claims that are *specific enough to be wrong* — a claim nobody could
disagree with is not a claim — each with the ids of the articles supporting it
and a quote copied exactly.

**④** is three lines and it is the difference between provenance and decoration.
A quote that is not in its source means the model invented it; the claim goes.

**⑤** is where a daily list becomes a standing card. Cheap lexical match against
existing statements first; only near-matches go to the model, and the question
asked is narrow: same claim, contradicting claim, or unrelated.

**⑥** thresholds, all configurable beside the existing publish settings:

| test | how |
|---|---|
| momentum | `independent_count ≥ 2` promotes candidate → standing |
| credibility | weighted by kind: PAPER/POLICY above REPORT above NEWS |
| novelty | age since `first_seen_at`; a claim restated for a week is not news |
| relevance | the kinds the user already selects for publishing |

A claim with one source stays a **candidate** and does not clutter the tab. This
is the sprawl control: without it, 120 rows a day becomes hundreds of
one-off assertions and the tab is unreadable within a week.

### The tab

A list of cards, densest information first:

```
┌────────────────────────────────────────────────────────────┐
│ 三家实验室同期收敛到同一种推理时序扩展做法                    │
│ 立场分歧 · 6 篇 · 4 个独立来源 · 首见 8月18 · 最近 8月23      │
│ ─────────────────────────────────────────────────────────  │
│ ✓ arXiv cs.LG   "…we observe the same scaling…"            │
│ ✓ DeepMind blog "…test-time compute…"                      │
│ ✗ 某评论        "…the effect disappears when…"             │
└────────────────────────────────────────────────────────────┘
```

Every evidence row opens the reader that already exists. Filters that match the
four tests rather than inventing new vocabulary: **新出现 / 升温中 / 有分歧 /
已沉寂**.

The contradiction row is the part no comparable product shows well, and it is
free once `stance` exists.

## 4. Cost, measured rather than guessed

The intake looks alarming and is not. `collect/status` reports ~2,888 items
written per hourly run, but that is items *processed*: the library holds 20,708
rows total, and grows by **100–140 rows a day** in steady state. The rest are
already-known URLs.

So the daily budget is:

- ~120 new rows → after near-dup folding, perhaps 60–90 stories
- one extraction call per story, a few thousand tokens each
- reconciliation calls only for near-matches, a small fraction

That is one to two orders of magnitude below the daily podcast, which already
runs eight sources through script generation and text-to-speech every morning.
A hard per-run cap goes beside `publishSources`, so the ceiling is a setting
rather than a hope.

## 5. Phases

Each phase is shippable and useful on its own. None of them requires the next.

**P1 — claims with provenance.** ①–④ plus a flat list in the tab. No standing
cards yet: this is a day's claims, each with a verified quote and a link back.
Proves the extraction quality is good enough to build on, which is the only
question that matters at this point.

**P2 — cards that accrue.** ⑤ and ⑥. Claims become standing insights, evidence
lands on existing cards, `first_seen_at` starts meaning something. This is the
phase that makes the tab worth returning to.

**P3 — disagreement.** `stance` populated, contested status, the ✗ rows. Cheap
once P2 exists, and the most differentiated thing on the list.

**P4 — feed it back into 发布.** The daily report stops being "here are eight
articles" and becomes "here is what changed, and what now disagrees". This is
where the work pays for itself, and it needs nothing new — the report generator
already takes sources; it would take insights instead.

## 6. What would make this fail

**Hallucinated quotes.** Guarded by ④, which is why ④ is not optional.

**Claims too vague to be wrong.** "AI is advancing rapidly" passes every
mechanical test and is worthless. Mitigation is in the prompt (specific enough
to be wrong) and measurable: sample twenty and count how many a reader would
dispute.

**Insight sprawl.** Guarded by the candidate threshold. Watch `insights` row
count weekly; if standing cards grow faster than ~10/week the threshold is
wrong.

**Reconciliation drift.** The model deciding "same claim?" will sometimes merge
two different things. `supersedes` keeps the history, and a merged card can be
split by hand — but this is the part most likely to need a second pass after
real use.

**The thing nobody says out loud:** if the extracted claims are boring, no
amount of architecture saves the tab. P1 exists to find that out in a week
rather than a quarter.

## 7. Being a guest on somebody else's service

The corroboration step is the only part of this that leaves the machine, and
every service it touches is either free or metered. Rate limits were missing
from the first version of this plan and from the first version of the code,
which is worth writing down rather than quietly fixing.

**arXiv publishes a hard rule and means it**: "make no more than one request
every three seconds, and limit requests to a single connection at a time",
counted across every machine you run, with blocking as the stated
remedy.[^arxiv-tou] The first implementation issued one request per candidate
claim in a plain loop — three inside a second, hourly, for ever.

Requests are now serialised through a per-process pacer at a four-second gap.
The extra second is not politeness theatre: the interval is measured on
completion, network jitter moves the observed gap either way, and the penalty
for being slightly under is being blocked from a service with no account to
appeal through. Fetched pages get the same treatment at one second, which is a
courtesy rather than a rule — the sites on the receiving end are the ones this
library is built out of.

**A refusal is not an empty result.** This is the part that matters, and it is
this repository's signature bug wearing a new hat. `catch { return [] }` reports
a blocked search as "nobody else wrote about this" — a claim about the world
drawn from a fact about our own request rate. Three states are now kept apart:

| what happened | what it is a fact about |
|---|---|
| every backend answered, nothing found | the claim |
| a backend refused us for going too fast | our request rate |
| there was no backend to ask | the installation |

A pass that is throttled stops the stage rather than moving to the next claim —
a second request to a service that just said no is what gets an anonymous
client blocked outright — and the claims it did not reach are **not** marked as
tried, so a three-second interval does not put a card to sleep for a day.
`corroborationRateLimited` reports it.

**The metered backends behind `ctx.web`** — Serper, Tavily, Brave — sell quota
by the month. The seam surfaces their refusal as a thrown error carrying the
status, and that is now matched and reported rather than swallowed, so an
exhausted monthly allowance does not read as an empty web.

[^arxiv-tou]: [arXiv API terms of use](https://info.arxiv.org/help/api/tou.html) — one request per three seconds, one connection, across all your machines.

---

## Sources

[^feedly-cve]: [CVE Insights Cards: comprehensive, real-time intelligence](https://feedly.com/new-features/posts/cve-insights-cards-2025) — cards as entities with continuously-updated event timelines.
[^feedly-clustering]: [Optimizing news aggregation: clustering & deduplication](https://feedly.com/engineering/posts/reducing-clustering-latency) — dedupe before cluster, LSH at ~80% similarity, 80% of articles are duplicates, clustering is quadratic.
[^papertrail]: [PaperTrail: a claim-evidence interface for grounding provenance in LLM-based scholarly Q&A](https://arxiv.org/pdf/2602.21045) — explicit claim→evidence structures; few-shot LLM extraction with retrieval pre-filtering.
[^hebbia]: [AlphaSense competitors](https://www.hebbia.com/resources/alphasense-competitors) — sentence-level citations for every fact and quote.
[^alphasense]: [AlphaSense product updates, January 2026](https://help.alpha-sense.com/hc/en-us/articles/48824062007187-AlphaSense-Product-Updates-January-2026) — Generative Grid, workflow agents.
[^comintelli]: [How to identify weak signals](https://comintelli.com/how-to-identify-weak-signals/) — novelty, relevance, credibility, momentum.
[^weaksignal]: [A framework for weak signal detection in competitive intelligence](https://thesai.org/Downloads/Volume12No12/Paper_71-A_Framework_for_Weak_Signal_Detection_in_Competitive_Intelligence.pdf) — Ansoff's weak signals, semantic clustering.
