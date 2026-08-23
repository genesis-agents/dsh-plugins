/**
 * The source roster.
 *
 * Reconstructed from the reference's own seed lists — the 49 entries its
 * runtime seeder inserts at every boot, the 4 in its YouTube JSON config, and
 * the channels that its production data proves were added by hand and never
 * made it back into code. Everything here is a plain RSS or Atom feed, which
 * is what the reference resolved to as well: its arXiv, YouTube, blog, report,
 * news, and policy collectors all end up in the same RSS parser, and none of
 * them needs an API key.
 *
 * Two corrections were made against the reference rather than copying it:
 *
 *  - Its seeder lists `UChnNjLyx_5rk_iDPQ2BQDQA` under the name "Dwarkesh
 *    Patel". YouTube answers that id with 硅谷101播客. Both channels are
 *    carried here under their real names, which is also why its library holds
 *    53 硅谷101 videos while no list mentions that channel.
 *  - Where its two lists disagree on a feed URL for the same publication
 *    (OpenAI, DeepMind), the one that currently answers with a feed is used.
 *    `checkSources()` is what settles that, not a preference.
 *
 * `checkSources()` exists because a roster is a claim about the outside world
 * and decays without warning. The reference validates every URL before
 * inserting it and silently drops the failures, which means its live roster
 * and its committed roster differ by an unknown amount. Here the check is
 * explicit and reports what it dropped.
 */

/** A YouTube channel's Atom feed. */
function channel(id) {
  return `https://www.youtube.com/feeds/videos.xml?channel_id=${id}`;
}

/**
 * Every feed, grouped by the resource type its items become.
 *
 * `name` is for the operator reading a collection report; `url` is the feed.
 * The type decides which tab the rows land in and nothing else.
 */
export const SOURCES = [
  // ── papers ────────────────────────────────────────────────────────────
  { type: "PAPER", name: "arXiv cs.AI", url: "https://rss.arxiv.org/rss/cs.AI" },
  { type: "PAPER", name: "arXiv cs.LG", url: "https://rss.arxiv.org/rss/cs.LG" },
  { type: "PAPER", name: "arXiv cs.CL", url: "https://rss.arxiv.org/rss/cs.CL" },
  { type: "PAPER", name: "arXiv cs.CV", url: "https://rss.arxiv.org/rss/cs.CV" },

  // ── vendor and lab blogs ──────────────────────────────────────────────
  { type: "BLOG", name: "OpenAI", url: "https://openai.com/news/rss.xml" },
  { type: "BLOG", name: "Anthropic", url: "https://raw.githubusercontent.com/Olshansk/rss-feeds/refs/heads/main/feeds/feed_anthropic_news.xml" },
  { type: "BLOG", name: "Google DeepMind", url: "https://blog.google/technology/google-deepmind/rss/" },
  { type: "BLOG", name: "Google AI", url: "https://blog.google/technology/ai/rss/" },
  { type: "BLOG", name: "Google Cloud", url: "https://cloudblog.withgoogle.com/rss/" },
  { type: "BLOG", name: "AWS News", url: "https://aws.amazon.com/blogs/aws/feed/" },
  { type: "BLOG", name: "AWS Machine Learning", url: "https://aws.amazon.com/blogs/machine-learning/feed/" },
  { type: "BLOG", name: "Microsoft Research", url: "https://www.microsoft.com/en-us/research/feed/" },
  { type: "BLOG", name: "NVIDIA Technical Blog", url: "https://developer.nvidia.com/blog/feed/" },
  { type: "BLOG", name: "Hugging Face", url: "https://huggingface.co/blog/feed.xml" },
  { type: "BLOG", name: "Meta Engineering", url: "https://engineering.fb.com/feed/" },
  { type: "BLOG", name: "Cisco Networking", url: "https://blogs.cisco.com/networking/feed" },
  { type: "BLOG", name: "Palo Alto Networks", url: "https://www.paloaltonetworks.com/blog/feed/" },
  { type: "BLOG", name: "CrowdStrike", url: "https://www.crowdstrike.com/blog/feed/" },
  { type: "BLOG", name: "Cloudflare", url: "https://blog.cloudflare.com/rss/" },
  { type: "BLOG", name: "Databricks", url: "https://www.databricks.com/feed" },
  { type: "BLOG", name: "Mistral AI", url: "https://mistral.ai/rss.xml" },
  { type: "BLOG", name: "Netflix Tech", url: "https://netflixtechblog.com/feed" },
  { type: "BLOG", name: "Stripe Engineering", url: "https://stripe.com/blog/feed.rss" },
  { type: "BLOG", name: "Discord Engineering", url: "https://discord.com/blog/rss.xml" },
  { type: "BLOG", name: "Dropbox Tech", url: "https://dropbox.tech/feed/" },
  { type: "BLOG", name: "Spotify Engineering", url: "https://engineering.atspotify.com/feed/" },

  // ── analysis and industry reports ─────────────────────────────────────
  { type: "REPORT", name: "SemiAnalysis", url: "https://semianalysis.substack.com/feed" },
  { type: "REPORT", name: "Stratechery", url: "https://stratechery.com/feed/" },
  { type: "REPORT", name: "Benedict Evans", url: "https://www.ben-evans.com/benedictevans?format=rss" },
  { type: "REPORT", name: "AI Supremacy", url: "https://aisupremacy.substack.com/feed" },
  { type: "REPORT", name: "Import AI", url: "https://importai.substack.com/feed" },
  { type: "REPORT", name: "MIT Technology Review AI", url: "https://www.technologyreview.com/topic/artificial-intelligence/feed" },
  { type: "REPORT", name: "Stanford AI Lab", url: "https://ai.stanford.edu/blog/feed.xml" },
  { type: "REPORT", name: "Berkeley AI Research", url: "https://bair.berkeley.edu/blog/feed.xml" },
  { type: "REPORT", name: "MIT CSAIL", url: "https://www.csail.mit.edu/rss.xml" },
  { type: "REPORT", name: "Allen Institute for AI", url: "https://allenai.org/rss.xml" },
  { type: "REPORT", name: "McKinsey QuantumBlack", url: "https://www.mckinsey.com/insights/rss" },
  { type: "REPORT", name: "Sequoia", url: "https://www.sequoiacap.com/feed/" },

  // ── news ──────────────────────────────────────────────────────────────
  { type: "NEWS", name: "Ars Technica", url: "https://feeds.arstechnica.com/arstechnica/index" },
  { type: "NEWS", name: "Hacker News", url: "https://news.ycombinator.com/rss" },
  { type: "NEWS", name: "TechCrunch", url: "https://techcrunch.com/feed/" },
  { type: "NEWS", name: "The Verge", url: "https://www.theverge.com/rss/index.xml" },
  { type: "NEWS", name: "Wired", url: "https://www.wired.com/feed/rss" },
  { type: "NEWS", name: "VentureBeat", url: "https://venturebeat.com/feed/" },
  { type: "NEWS", name: "ZDNet", url: "https://www.zdnet.com/news/rss.xml" },
  { type: "NEWS", name: "CNBC Tech", url: "https://www.cnbc.com/id/19854910/device/rss/rss.html" },
  { type: "NEWS", name: "AI News", url: "https://www.artificialintelligence-news.com/feed/" },

  // ── policy ────────────────────────────────────────────────────────────
  { type: "POLICY", name: "CSET Georgetown", url: "https://cset.georgetown.edu/feed/" },
  { type: "POLICY", name: "EU AI Act", url: "https://artificialintelligenceact.substack.com/feed" },
  { type: "POLICY", name: "Ada Lovelace Institute", url: "https://www.adalovelaceinstitute.org/feed/" },
  { type: "POLICY", name: "ChinAI", url: "https://chinai.substack.com/feed" },
  { type: "POLICY", name: "DigiChina", url: "https://digichina.stanford.edu/feed/" },
  { type: "POLICY", name: "Future of Life Institute", url: "https://futureoflife.org/feed/" },
  { type: "POLICY", name: "Partnership on AI", url: "https://partnershiponai.org/feed/" },
  { type: "POLICY", name: "Federal Register AI", url: "https://www.federalregister.gov/api/v1/documents.rss?conditions%5Bterm%5D=artificial+intelligence" },
  { type: "POLICY", name: "NIST News", url: "https://www.nist.gov/news-events/news/rss.xml" },
  { type: "POLICY", name: "FTC Technology", url: "https://www.ftc.gov/feeds/press-release.xml" },
  { type: "POLICY", name: "DARPA News", url: "https://www.darpa.mil/rss.xml" },
  { type: "POLICY", name: "GAO Science & Technology", url: "https://www.gao.gov/rss/topic/science-technology.xml" },
  { type: "POLICY", name: "NSF News", url: "https://new.nsf.gov/rss/rss_www_news.xml" },
  { type: "POLICY", name: "DOE News", url: "https://www.energy.gov/rss.xml" },

  // ── video ─────────────────────────────────────────────────────────────
  // Channel ids resolved against YouTube, not copied: see the file header for
  // the one the reference has under the wrong name.
  { type: "YOUTUBE_VIDEO", name: "Y Combinator", url: channel("UCcefcZRL2oaA_uBNeo5UOWg") },
  { type: "YOUTUBE_VIDEO", name: "BG2Pod", url: channel("UC-yRDvpR99LUc5l7i7jLzew") },
  { type: "YOUTUBE_VIDEO", name: "Dwarkesh Patel", url: channel("UCXl4i9dYBrFOabk0xGmbkRA") },
  { type: "YOUTUBE_VIDEO", name: "硅谷101播客", url: channel("UChnNjLyx_5rk_iDPQ2BQDQA") },
  { type: "YOUTUBE_VIDEO", name: "Bloomberg Technology", url: channel("UCrM7B7SL_g1edFOnmj-SDKg") },
  { type: "YOUTUBE_VIDEO", name: "Lenny's Podcast", url: channel("UC6t1O76G0jYXOAoYCm153dA") },
  { type: "YOUTUBE_VIDEO", name: "World Economic Forum", url: channel("UCw-kH-Od73XDAt7qtH9uBYA") },
  { type: "YOUTUBE_VIDEO", name: "Andrej Karpathy", url: channel("UCXUPKJO5MZQN11PqgIvyuvQ") },
  { type: "YOUTUBE_VIDEO", name: "Lex Fridman", url: channel("UCSHZKyawb77ixDdsGog4iWA") },
  { type: "YOUTUBE_VIDEO", name: "Yannic Kilcher", url: channel("UCZHmQk67mSJgfCCTn7xBfew") },
  { type: "YOUTUBE_VIDEO", name: "Two Minute Papers", url: channel("UCbfYPyITQ-7l4upoX8nvctg") },
  { type: "YOUTUBE_VIDEO", name: "AI Explained", url: channel("UCNJ1Ymd5yFuUPtn21xtRbbw") },
];

/** The roster as collector jobs, ready to store as configuration. */
export function sourceFeeds() {
  return SOURCES.map((entry) => ({ url: entry.url, type: entry.type, name: entry.name }));
}

/**
 * Ask every feed whether it is still a feed.
 *
 * A 200 is not enough: a retired feed commonly answers 200 with the site's
 * HTML, and a roster that counts those as healthy is worse than one that
 * reports them, because the failure only shows up later as a source that
 * quietly collects nothing.
 * @param sources - the roster to check.
 * @param concurrency - simultaneous requests.
 * @returns `[{ ...source, ok, status, detail }]`.
 */
export async function checkSources(sources = SOURCES, concurrency = 6) {
  const results = [];
  const queue = [...sources];
  const worker = async () => {
    for (;;) {
      const entry = queue.shift();
      if (entry === undefined) return;
      try {
        const response = await fetch(entry.url, {
          headers: {
            "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36",
            accept: "application/rss+xml, application/atom+xml, application/xml, text/xml, */*",
          },
          redirect: "follow",
          signal: AbortSignal.timeout(25_000),
        });
        const body = (await response.text()).slice(0, 4000);
        const isFeed = /<(rss|feed|rdf:RDF)[\s>]/i.test(body);
        results.push({
          ...entry,
          ok: response.ok && isFeed,
          status: response.status,
          detail: !response.ok ? `HTTP ${response.status}` : isFeed ? "" : "answered, but not a feed",
        });
      } catch (cause) {
        results.push({ ...entry, ok: false, status: 0, detail: String(cause?.message ?? cause).slice(0, 60) });
      }
    }
  };
  await Promise.all(Array.from({ length: concurrency }, worker));
  return results.sort((left, right) => left.type.localeCompare(right.type) || left.name.localeCompare(right.name));
}
