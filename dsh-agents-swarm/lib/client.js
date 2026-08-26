window.__ModuleLoader__.load({
	id: "@ai4gensteam/dsh-agents-swarm",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		let react = require("react");
		let react_jsx_runtime = require("react/jsx-runtime");
		const jsx = react_jsx_runtime.jsx;
		const jsxs = react_jsx_runtime.jsxs;
		const useCallback = react.useCallback;
		const useEffect = react.useEffect;
		const useLayoutEffect = react.useLayoutEffect;
		const useMemo = react.useMemo;
		const useRef = react.useRef;
		const useState = react.useState;
		const useSyncExternalStore = react.useSyncExternalStore;

		//#region open store
		/**
		* The trigger and the page are two occupants of two different slots, so
		* the open flag lives in the bundle rather than in either component.
		* Both are rendered by the same module instance, so a module-scoped
		* store is the whole coordination surface needed.
		*/
		let openState = false;
		const listeners = new Set();
		function subscribe(listener) {
			listeners.add(listener);
			return () => { listeners.delete(listener); };
		}
		function setOpen(next) {
			if (openState === next) return;
			openState = next;
			for (const listener of listeners) listener();
		}
		function useOpen() {
			return useSyncExternalStore(subscribe, () => openState, () => false);
		}
		//#endregion

		/**
		* Whether a click is on a control that only resizes the shell.
		*
		* Neither signal is ideal and that is why there are two. `aria-label` is
		* the honest one but is written in the shell's language, so matching it
		* means matching every locale the shell ships. The CSS-module class is
		* language-proof but hashed per build — except for the suffix, which is
		* the source-level name and survives. Together they cover each other's
		* gap, and if both miss, the fallback is the old behaviour: the page
		* closes, which is wrong but not harmful.
		* @param target - the element the pointer went down on.
		* @returns true when the click only changes layout.
		*/
		function isLayoutToggle(target) {
			const button = target.closest('button, [role="button"]');
			if (button === null) return false;
			// The suffix, not the whole class: a CSS module renders this as
			// `KzdQ8a_toggle`, and only the hash before the underscore moves
			// between builds.
			if (/[_-]toggle\b/i.test(String(button.className))) return true;
			const label = (button.getAttribute("aria-label") ?? "") + " " + (button.getAttribute("title") ?? "");
			return /侧边栏|sidebar|collapse|expand/i.test(label);
		}

		/**
		* The version of THIS half.
		*
		* Stated rather than read, because the browser half is a plain file
		* served as-is — no build step, and no `package.json` to import at
		* runtime. Which makes it exactly the kind of constant that drifts, so
		* `tests/version.test.mjs` fails the moment it stops matching the
		* manifest. A version string nobody checks is worse than none: it is a
		* number people act on.
		*
		* It matters here more than in most plugins. The page is served by the
		* machine you opened; `/swarm-api` may be proxied to another. Showing
		* both is how "deployed but apparently absent" becomes legible instead
		* of costing an afternoon.
		*/
		const CLIENT_VERSION = "0.6.3";

		//#region locale + mark
		/**
		* Whether the document is presenting Chinese. The slot's `label` is
		* re-read on every projection, so reading the live document language
		* keeps the entry in step with a locale change.
		*/
		function isChinese() {
			return document.documentElement.lang.toLowerCase().startsWith("zh");
		}

		/**
		* Entry label, resolved per projection.
		*
		* The slot id and the package name stay `agents-swarm`: they are the
		* addresses other things register against, and renaming an address to
		* match a label breaks the installation for a word nobody sees.
		*/
		function swarmLabel() {
			return isChinese() ? "智能体" : "Agents";
		}

		/**
		* The Agents mark: three nodes that work as one.
		*
		* It used to be a honeycomb cell, from when this was called 智能体蜂群 —
		* a hive of agents. The name lost 蜂群 and the mark kept it, so the
		* picture went on arguing for a metaphor the words had dropped. Worse,
		* the hexagon carried most of the ink and the dots inside it were the
		* part that meant anything.
		*
		* Now the relationship IS the mark: three peers, the edges between them
		* drawn, one filled because somebody is always the one asked. At the 16
		* and 18 pixels this renders at, an outline plus three dots resolves to
		* a grey blob; three dots and three lines stay separable.
		*/
		function SwarmMark({ size }) {
			return jsxs("svg", {
				width: size, height: size, viewBox: "0 0 32 32", fill: "none", "aria-hidden": "true",
				stroke: "currentColor", strokeWidth: 2, strokeLinecap: "round", strokeLinejoin: "round",
				children: [
					jsx("path", { d: "M16 7.5 L7.5 22 L24.5 22 Z", opacity: 0.42 }),
					jsx("circle", { cx: 16, cy: 7.5, r: 3.4, fill: "currentColor", stroke: "none" }),
					jsx("circle", { cx: 7.5, cy: 22, r: 3.4, fill: "var(--dsw-specific-menu)" }),
					jsx("circle", { cx: 24.5, cy: 22, r: 3.4, fill: "var(--dsw-specific-menu)" })
				]
			});
		}

		/**
		* Tab marks, drawn in the same hand as {@link SwarmMark}: stroked
		* geometry on a 24-unit grid, round joins, no fill except where a dot
		* carries meaning. Emoji were the alternative and are the wrong
		* register — they render in someone else's colour, sit on their own
		* baseline, and change shape per platform, so a row of them reads as
		* decoration stuck onto the labels rather than as part of the type.
		*
		* Each mark says what its stage DOES rather than what it is called, so
		* the row stays legible at 15px where detail disappears.
		*/
		const TAB_ICONS = {
			// Layers: a corpus, stacked. Not an RSS arc — this reads as one
			// source, and the tab is the whole library.
			sources: [
				jsx("path", { d: "M12 3 L21 7.5 L12 12 L3 7.5 Z", key: "a" }),
				jsx("path", { d: "M3 12 L12 16.5 L21 12", key: "b" }),
				jsx("path", { d: "M3 16.5 L12 21 L21 16.5", key: "c" })
			],
			// A spark, not a lightbulb: the bulb's filament and base turn to
			// mud below about 20px, and every product uses it anyway.
			insights: [
				jsx("path", { d: "M12 2.5 L14 9.2 L20.7 11.2 L14 13.2 L12 19.9 L10 13.2 L3.3 11.2 L10 9.2 Z", key: "a" }),
				jsx("path", { d: "M18.6 17.4 L19.4 19.9 L21.9 20.7 L19.4 21.5", key: "b" })
			],
			// A magnifier over a line of text: looking INTO something, which is
			// what separates research from search.
			research: [
				jsx("circle", { cx: 10.5, cy: 10.5, r: 6.5, key: "a" }),
				jsx("path", { d: "M15.4 15.4 L21 21", key: "b" }),
				jsx("path", { d: "M8 10.5 H13", key: "c" })
			],
			// One present branching into two futures, with the fork marked.
			// A scenario is exactly this shape.
			simulation: [
				jsx("path", { d: "M4 12 H9", key: "a" }),
				jsx("path", { d: "M9 12 C 14 12, 14 5.5, 19.5 5.5", key: "b" }),
				jsx("path", { d: "M9 12 C 14 12, 14 18.5, 19.5 18.5", key: "c" }),
				jsx("circle", { cx: 9, cy: 12, r: 1.9, fill: "currentColor", stroke: "none", key: "d" })
			],
			// Sound leaving a point. The tab makes a podcast; radiating is the
			// one thing every listener already reads correctly.
			publish: [
				jsx("circle", { cx: 7, cy: 12, r: 2.4, fill: "currentColor", stroke: "none", key: "a" }),
				jsx("path", { d: "M12.4 8.2 A 5.6 5.6 0 0 1 12.4 15.8", key: "b" }),
				jsx("path", { d: "M16.2 5.2 A 10.2 10.2 0 0 1 16.2 18.8", key: "c" })
			]
		};

		/**
		* One tab mark.
		* @param id - the tab whose mark to draw.
		* @returns the svg, or null for a tab with no mark.
		*/
		function TabIcon({ id }) {
			const parts = TAB_ICONS[id];
			if (parts === undefined) return null;
			return jsx("svg", {
				width: 15, height: 15, viewBox: "0 0 24 24", fill: "none",
				stroke: "currentColor", strokeWidth: 1.7,
				strokeLinecap: "round", strokeLinejoin: "round",
				"aria-hidden": "true",
				// `flex: none` and the nudge keep the mark on the label's optical
				// centre; svg sits on the text baseline otherwise and the row
				// looks like it is falling over.
				style: { flex: "none", marginTop: "-1px" },
				children: parts
			});
		}
		//#endregion

		//#region sidebar geometry
		/**
		* Left edge of the centre column, in viewport pixels.
		*
		* The `[data-slot="<key>"]` anchor is `display: contents`, so it has no
		* box of its own and `getBoundingClientRect()` on it reads all zeros.
		* Its first element child is the sidebar's real node, and the frame's
		* inline `grid-template-columns` is the fallback.
		*/
		function centreColumnLeft() {
			// A measurement wider than this cannot be a navigation column, and
			// trusting one would push the page off-screen — which is exactly
			// what a bad reading did: the page rendered at 0, the measurement
			// landed, and it slid out of the viewport and looked like a flash.
			// An unusable reading must fall back to 0 (page covers the frame)
			// rather than to something that hides the surface entirely.
			const ceiling = Math.max(0, Math.floor(window.innerWidth * 0.5));
			const usable = (value) => Number.isFinite(value) && value >= 0 && value <= ceiling;

			const anchor = document.querySelector('[data-slot="sidebar"]');
			const node = anchor?.firstElementChild;
			if (node != null) {
				const rect = node.getBoundingClientRect();
				if (rect.width > 0 && usable(rect.right)) return rect.right;
			}
			const layer = document.querySelector("[data-shell-overlay]");
			const frame = layer?.parentElement;
			if (frame != null) {
				const track = getComputedStyle(frame).gridTemplateColumns.split(/\s+/)[0];
				const width = Number.parseFloat(track);
				if (usable(width)) return width;
			}
			return 0;
		}
		//#endregion

		//#region explore model
		/**
		* Explore (信源库), modelled on the gens.team implementation:
		* `frontend/components/explore/*` for the feed, `ai-app/explore/*` for
		* the API, and `Resource` in `prisma/schema/models.prisma` for the row.
		*
		* Three facts that guessing got wrong once each:
		*  - Every kind carries its OWN colour (`ResponsiveNav.tsx:52`); the red
		*    in the reference feed is YouTube's brand colour, not an accent and
		*    certainly not an error state.
		*  - A card's description is `aiSummary || abstract`, and only when BOTH
		*    are empty does it fall back to `Source: <host> · By: <authors>`.
		*  - YouTube rows carry no `thumbnailUrl`; the still is derived from the
		*    video id in `sourceUrl` (`ResourceThumbnail.tsx:136`).
		*/
		/**
		* The page reads THIS harness's own source library.
		*
		* `/swarm-api` is served by this package's Host half from a local
		* SQLite store (`lib/store.js`); the upstream is reachable only through
		* the explicit seed action, because the remote service is scheduled to
		* be retired and a surface that reads it live would retire with it.
		*/
		const DEFAULT_API_BASE = "/swarm-api";
		const PAGE_SIZE = 20;

		/** API base, overridable before the bundle loads. */
		function apiBase() {
			const override = window.__DSH_SWARM_API_BASE__;
			return typeof override === "string" && override !== "" ? override : DEFAULT_API_BASE;
		}

		/** Kinds the feed narrows to, each with the palette the reference nav gives it. */
		const KINDS = [
			{ id: "youtube", type: "YOUTUBE_VIDEO", en: "YouTube", zh: "YouTube", hue: "220,38,38" },
			{ id: "papers", type: "PAPER", en: "Papers", zh: "论文", hue: "2,132,199" },
			{ id: "blogs", type: "BLOG", en: "Blogs", zh: "博客", hue: "124,58,237" },
			{ id: "reports", type: "REPORT", en: "Reports", zh: "报告", hue: "217,119,6" },
			{ id: "policy", type: "POLICY", en: "Policy", zh: "政策", hue: "79,70,229" },
			{ id: "news", type: "NEWS", en: "News", zh: "新闻", hue: "5,150,105" }
		];

		/** Sort orders the resources endpoint accepts. */
		const SORTS = [
			{ id: "publishedAt", en: "Newest", zh: "最新" },
			{ id: "trendingScore", en: "Trending", zh: "热度" },
			{ id: "qualityScore", en: "Quality", zh: "质量" }
		];

		/** `rgb()` / `rgba()` string from a kind's stored channel triple. */
		function hue(kind, alpha) {
			return alpha === undefined ? `rgb(${kind.hue})` : `rgba(${kind.hue},${alpha})`;
		}

		/** Extract a YouTube video id from a watch, short, or embed URL. */
		function youTubeVideoId(url) {
			if (typeof url !== "string") return undefined;
			const patterns = [
				/[?&]v=([A-Za-z0-9_-]{11})/,
				/youtu\.be\/([A-Za-z0-9_-]{11})/,
				/\/embed\/([A-Za-z0-9_-]{11})/,
				/\/shorts\/([A-Za-z0-9_-]{11})/
			];
			for (const pattern of patterns) {
				const match = pattern.exec(url);
				if (match !== null) return match[1];
			}
			return undefined;
		}

		/** Stored thumbnail when the collector found one, derived YouTube still otherwise. */
		function thumbnailOf(row) {
			if (typeof row.thumbnailUrl === "string" && row.thumbnailUrl !== "") return row.thumbnailUrl;
			const videoId = youTubeVideoId(row.sourceUrl);
			return videoId === undefined ? undefined : `https://img.youtube.com/vi/${videoId}/mqdefault.jpg`;
		}

		//#region on-demand thumbnails
		/**
		* Thumbnails already resolved this session, keyed by resource id.
		*
		* Module-level rather than component state: a card unmounts and remounts
		* as the feed is filtered and scrolled, and without this every remount
		* would ask again for something already answered. An empty string is a
		* remembered NO — the Host has recorded that the page carries no image,
		* and asking again would only repeat that.
		*/
		const thumbnailCache = new Map();

		/** Requests in flight, so two cards for one row make one request. */
		const thumbnailPending = new Map();

		/**
		* Simultaneous thumbnail lookups.
		*
		* Each one is a request the Host makes to somebody else's site, so a feed
		* of twenty cards must not become twenty simultaneous fetches. Three is
		* what the reference settled on and it is the right order of magnitude:
		* enough that a screenful fills quickly, few enough to stay polite.
		*/
		const THUMBNAIL_CONCURRENCY = 3;
		let thumbnailActive = 0;
		const thumbnailQueue = [];

		/** Start the next queued lookup if there is room. */
		function pumpThumbnails() {
			while (thumbnailActive < THUMBNAIL_CONCURRENCY && thumbnailQueue.length > 0) {
				const task = thumbnailQueue.shift();
				thumbnailActive += 1;
				task().finally(() => {
					thumbnailActive -= 1;
					pumpThumbnails();
				});
			}
		}

		/**
		* Ask the Host for a row's thumbnail, once.
		* @param id - the resource id.
		* @returns the image URL, or an empty string when there is none.
		*/
		function requestThumbnail(id) {
			if (thumbnailCache.has(id)) return Promise.resolve(thumbnailCache.get(id));
			const inFlight = thumbnailPending.get(id);
			if (inFlight !== undefined) return inFlight;
			const promise = new Promise((resolve) => {
				thumbnailQueue.push(async () => {
					let url = "";
					try {
						const response = await fetch(`${apiBase()}/thumbnail-for?resourceId=${encodeURIComponent(id)}`);
						const payload = await response.json();
						if (payload?.success === true) url = payload.data.url ?? "";
					} catch {
						// A lookup that fails is not cached, so scrolling back
						// later tries again — unlike a page that genuinely has no
						// image, which the Host records so it is asked once.
						thumbnailPending.delete(id);
						resolve("");
						return;
					}
					thumbnailCache.set(id, url);
					thumbnailPending.delete(id);
					resolve(url);
				});
				pumpThumbnails();
			});
			thumbnailPending.set(id, promise);
			return promise;
		}
		//#endregion

		/**
		* The byline row: who published this, who wrote it, how long it takes.
		*
		* Reading time is characters over 1000 a minute, which is what the
		* reference uses. Words per minute would be the usual measure, but the
		* library holds Chinese as well as English and a "word" is not a unit
		* those two share — characters are.
		* @param row - the stored resource.
		* @param reader - the extracted article.
		* @param zh - whether the interface is Chinese.
		* @returns the parts, in order, without separators.
		*/
		function bylineParts(row, reader, zh) {
			const parts = [];
			// The publication first, then the author. The library derives its
			// "source" from the first author or the hostname, so on a post with a
			// named author that slot holds the person and the masthead is lost
			// entirely — the page's own `og:site_name` is the one a reader knows.
			const site = typeof reader?.siteName === "string" ? reader.siteName.trim() : "";
			const source = site !== "" ? site : sourceNameOf(row);
			if (source !== "") parts.push(source);
			// Readability finds a byline on maybe half of pages; the row carries
			// one from the feed for most of the rest. Losing the author because
			// the extractor happened not to find it would be a step backwards
			// from what the card already showed.
			const extracted = typeof reader?.byline === "string" ? reader.byline.trim() : "";
			const authors = Array.isArray(row.authors) ? row.authors : [];
			const stored = typeof authors[0]?.name === "string" ? authors[0].name.trim() : "";
			const byline = extracted !== "" ? extracted : stored;
			if (byline !== "" && byline !== source) parts.push(byline);
			const text = typeof reader?.text === "string" ? reader.text : "";
			if (text.length > 0) {
				const minutes = Math.max(1, Math.ceil(text.length / 1000));
				parts.push(zh ? `约 ${minutes} 分钟读完` : `${minutes} min read`);
			}
			if (typeof row.publishedAt === "string" && row.publishedAt !== "") parts.push(formatDate(row.publishedAt));
			return parts;
		}

		/**
		* The lead paragraph shown above the divider.
		*
		* Readability's own excerpt first — it is drawn from the page's
		* description meta and describes THIS article — then whatever summary
		* the library already holds. Skipped when it merely repeats the opening
		* of the body, which would make the reader read the same sentence twice.
		* @param row - the stored resource.
		* @param reader - the extracted article.
		* @returns the lead text, or an empty string.
		*/
		function articleLead(row, reader) {
			const excerpt = typeof reader?.excerpt === "string" ? reader.excerpt.trim() : "";
			const lead = excerpt !== "" ? excerpt : summaryOf(row);
			if (lead === "") return "";
			const body = typeof reader?.text === "string" ? reader.text.trim() : "";
			const head = lead.slice(0, 60);
			if (head !== "" && body.slice(0, 200).includes(head)) return "";
			return lead;
		}

		/**
		* The text this row already carries, for when its document cannot be
		* reached. Not a substitute for the article, but better than a page
		* that says only that something went wrong.
		* @param row - a stored `Resource`.
		* @returns the summary, or an empty string.
		*/
		function summaryOf(row) {
			for (const field of [row.aiSummary, row.abstract]) {
				if (typeof field === "string" && field.trim() !== "") return field.trim();
			}
			return "";
		}

		/**
		* An instant as local date and time, for a log line.
		*
		* `formatDate` shows the day only, which is right for a published date
		* and useless for a run that happens hourly.
		* @param iso - an ISO 8601 instant.
		* @returns a short local timestamp, or an empty string.
		*/
		function formatStamp(iso) {
			const at = Date.parse(iso);
			if (Number.isNaN(at)) return "";
			const when = new Date(at);
			const pad = (value) => String(value).padStart(2, "0");
			return `${pad(when.getMonth() + 1)}-${pad(when.getDate())} ${pad(when.getHours())}:${pad(when.getMinutes())}`;
		}

		/** Host portion of a URL, without `www.`. */
		function hostOf(url) {
			try {
				return new URL(url).hostname.replace(/^www\./, "");
			} catch {
				return "";
			}
		}

		/** First author's name, else the source host. */
		function sourceNameOf(row) {
			const authors = Array.isArray(row.authors) ? row.authors : [];
			const first = authors[0];
			if (first != null && typeof first.name === "string" && first.name !== "") return first.name;
			return hostOf(row.sourceUrl);
		}

		/** At most three author names, then an et-al marker. */
		function authorLine(row, zh) {
			const authors = Array.isArray(row.authors) ? row.authors : [];
			if (authors.length === 0) return "";
			const names = authors.slice(0, 3).map((author) => author?.name ?? author?.username ?? (zh ? "未知" : "Unknown"));
			return names.join(", ") + (authors.length > 3 ? (zh ? " 等" : " et al.") : "");
		}

		/** The card description, following the reference precedence exactly. */
		function descriptionOf(row, zh) {
			const ai = typeof row.aiSummary === "string" && row.aiSummary.trim() !== "" ? row.aiSummary : undefined;
			const abstract = typeof row.abstract === "string" && row.abstract.trim() !== "" ? row.abstract : undefined;
			const summary = ai ?? abstract;
			if (summary !== undefined) return { kind: "summary", text: summary };
			const parts = [];
			const host = hostOf(row.sourceUrl);
			if (host !== "") parts.push((zh ? "来源" : "Source") + ": " + host);
			const authors = authorLine(row, zh);
			if (authors !== "") parts.push((zh ? "作者" : "By") + ": " + authors);
			return { kind: "fallback", text: parts.join(" · ") };
		}

		/** Format a published date the way the reference card does (`Aug 19, 2026`). */
		function formatDate(value) {
			if (typeof value !== "string" || value === "") return "";
			const parsed = new Date(value);
			if (Number.isNaN(parsed.getTime())) return "";
			return parsed.toLocaleDateString("en-US", { day: "numeric", month: "short", year: "numeric" });
		}

		/** Build the resources query the reference context builds. */
		function resourcesUrl({ base, kind, sortBy, search, skip }) {
			const params = new URLSearchParams({
				take: String(PAGE_SIZE),
				skip: String(skip ?? 0),
				sortBy: sortBy ?? "publishedAt",
				sortOrder: "desc",
				type: kind.type
			});
			if (typeof search === "string" && search.trim() !== "") params.append("search", search.trim());
			return `${base}/resources?${params.toString()}`;
		}

		/**
		* Unwrap the API envelope. The endpoint answers
		* `{ success, data: { data: Resource[], pagination }, metadata }`, but
		* older routes answer a bare array, so both shapes are accepted.
		*/
		function unwrapFeed(payload) {
			const body = payload?.data ?? payload;
			const rows = Array.isArray(body) ? body : Array.isArray(body?.data) ? body.data : [];
			const pagination = Array.isArray(body) ? undefined : body?.pagination;
			return {
				rows,
				total: typeof pagination?.total === "number" ? pagination.total : rows.length,
				hasMore: pagination?.hasMore === true
			};
		}
		//#endregion

		//#region page chrome styling
		/**
		* The page chrome uses neutral tokens only. State tokens
		* (`state-error-*`, `state-warn-*`) carry meaning in this product and
		* must not stand in for an accent — per-kind colour comes from KINDS.
		*/
		const HEADER_STYLE = {
			flex: "none", display: "flex", alignItems: "center", gap: "10px",
			padding: "20px 32px 0", fontSize: "16px", fontWeight: 600,
			color: "var(--dsw-alias-label-primary)"
		};
		const TABBAR_STYLE = {
			flex: "none", display: "flex", alignItems: "center", gap: "20px",
			padding: "0 32px", borderBottom: "1px solid var(--dsw-alias-border-l2)"
		};
		const BODY_STYLE = { flex: 1, minHeight: 0, overflowY: "auto", padding: "20px 32px 32px" };
		/** The detail view scrolls inside its own panes, so the body must not. */
		// No horizontal padding: the sources tab scrolls inside this box, and any
		// padding here insets the scrollbar from the window edge. The two views
		// underneath carry their own side padding instead.
		const READER_BODY_STYLE = { flex: 1, minHeight: 0, overflow: "hidden", padding: "12px 0 16px" };
		/**
		* The feed reads as a column, so it is capped. The detail view is a
		* two-pane reader and must use the whole frame — capping it left a band
		* of dead space down the right of the page.
		*/
		const CONTENT_STYLE = { maxWidth: "1080px" };
		const WIDE_STYLE = { maxWidth: "none" };
		const LEDE_STYLE = {
			margin: "0 0 16px", maxWidth: "62ch", fontSize: "14px", lineHeight: "22px",
			color: "var(--dsw-alias-label-secondary)"
		};
		/**
		* The marker on a stage that is designed but not built.
		*
		* These three tabs used to render "no insight extracted yet", which is
		* what a working feature with no data says. Nobody could tell the
		* difference from the outside, so the honest reading was the wrong one:
		* you wait for output that is not coming. Said plainly instead, and said
		* on the tab as well as inside it, so it costs a glance rather than a
		* click.
		*/
		const SOON_STYLE = {
			marginLeft: "6px", padding: "0 5px", borderRadius: "4px",
			border: "1px solid var(--dsw-alias-border-l2)",
			color: "var(--dsw-alias-label-tertiary, var(--dsw-alias-label-secondary))",
			fontSize: "10px", lineHeight: "15px", fontWeight: 500,
			letterSpacing: "0.02em", whiteSpace: "nowrap"
		};
		const NOTE_STYLE = {
			display: "flex", alignItems: "center", justifyContent: "center",
			minHeight: "140px", padding: "24px",
			border: "1px dashed var(--dsw-alias-border-l2)", borderRadius: "10px",
			color: "var(--dsw-alias-label-secondary)", fontSize: "13px", textAlign: "center"
		};

		/** Tab styling; the active tab carries the underline, matching the session view ring. */
		function tabStyle(active) {
			return {
				appearance: "none", border: "none", background: "transparent",
				padding: "10px 0 12px", marginBottom: "-1px",
				borderBottom: "2px solid " + (active ? "var(--dsw-alias-label-primary)" : "transparent"),
				color: active ? "var(--dsw-alias-label-primary)" : "var(--dsw-alias-label-secondary)",
				font: "inherit", fontSize: "14px", fontWeight: active ? 600 : 400,
				lineHeight: "20px", cursor: "pointer", whiteSpace: "nowrap"
			};
		}
		//#endregion

		//#region explore styling
		const SEARCH_STYLE = {
			width: "100%", boxSizing: "border-box", height: "42px", padding: "0 14px",
			border: "1px solid var(--dsw-alias-border-l2)", borderRadius: "10px",
			background: "transparent", color: "var(--dsw-alias-label-primary)",
			font: "inherit", fontSize: "14px", outline: "none"
		};
		const TOOLBAR_STYLE = {
			display: "flex", alignItems: "center", gap: "8px", flexWrap: "wrap", margin: "12px 0 18px"
		};
		/**
		* Card surface. A card should read as a sheet lying above the page, and
		* that is a job for shadow, not for an outline: `--dsw-alias-border-l2`
		* resolves to `#0000001a`, a black hairline, so every row was drawn as a
		* box first and a card second.
		*
		* `l1` (`#0000000a`) keeps the top edge defined where a downward shadow
		* cannot reach, without asserting itself as a frame.
		*/
		const CARD_STYLE = {
			display: "flex", gap: "16px", padding: "16px", marginBottom: "14px",
			border: "1px solid var(--dsw-alias-border-l1)", borderRadius: "14px",
			background: "var(--dsw-specific-menu)",
			boxShadow: "var(--dsw-shadow-lv1)",
			transition: "box-shadow 160ms ease, transform 160ms ease"
		};

		/**
		* Hover: the sheet rises. `lv2` cannot express that — its total ink
		* (`#00000005` + `#0000000a`) is LIGHTER than `lv1`'s `#0000000d`, so
		* using it made the card settle while a coloured border appeared, which
		* is why the hover read as a frame switching on rather than a lift.
		* `lv3` is the elevation token, and the border stays where it was.
		*/
		const CARD_HOVER_STYLE = {
			...CARD_STYLE,
			boxShadow: "var(--dsw-shadow-lv3)",
			transform: "translateY(-2px)"
		};
		// `label-tertiary` resolves to rgb(129,133,140) — 3.71:1 on white, under
		// the 4.5:1 that normal-size text needs, and it was carrying the dates,
		// sources, and counts at 11-12px across 101 places. `label-secondary`
		// is 5.8:1. Hierarchy still reads: size and weight separate these rows
		// from the title without asking the reader to squint.
		const META_STYLE = {
			display: "flex", alignItems: "center", gap: "10px", flexWrap: "wrap",
			fontSize: "12px", color: "var(--dsw-alias-label-secondary)"
		};
		const ACTIONS_STYLE = {
			display: "flex", alignItems: "center", gap: "18px",
			fontSize: "12px", color: "var(--dsw-alias-label-secondary)"
		};

		/**
		* Kind chip: the active kind takes its own colour as a tinted fill with
		* a matching border, which is the reference nav's active treatment.
		*/
		function chipStyle(kind, active) {
			return {
				appearance: "none", display: "inline-flex", alignItems: "center",
				height: "34px", padding: "0 14px", borderRadius: "8px",
				border: "1px solid " + (active ? hue(kind, 0.45) : "var(--dsw-alias-border-l2)"),
				background: active ? hue(kind, 0.1) : "transparent",
				color: active ? hue(kind) : "var(--dsw-alias-label-secondary)",
				font: "inherit", fontSize: "13px", fontWeight: active ? 600 : 400,
				cursor: "pointer", whiteSpace: "nowrap"
			};
		}

		/** Small neutral control used by the sort selector and the retry button. */
		function controlStyle() {
			return {
				appearance: "none", height: "34px", padding: "0 10px", borderRadius: "8px",
				border: "1px solid var(--dsw-alias-border-l2)", background: "transparent",
				color: "var(--dsw-alias-label-secondary)", font: "inherit", fontSize: "13px",
				cursor: "pointer"
			};
		}
		//#endregion

		//#region explore card
		/** One feed row, mapping `Resource` onto the reference card's slots. */
		function ResourceCard({ row, kind, zh, onOpen }) {
			const [hover, setHover] = useState(false);
			const stored = thumbnailOf(row);
			// Only rows that arrive without one are looked up, and only while
			// the card is mounted — which is to say, only for what is on screen.
			const [fetched, setFetched] = useState(() => (stored === undefined ? thumbnailCache.get(row.id) ?? "" : ""));
			useEffect(() => {
				if (stored !== undefined) return;
				let live = true;
				void requestThumbnail(row.id).then((url) => { if (live) setFetched(url); });
				return () => { live = false; };
			}, [row.id, stored]);
			const thumbnail = stored ?? (fetched === "" ? undefined : fetched);
			// Two strikes: the direct URL, then the relay.
			const [relayed, setRelayed] = useState(false);
			const [broken, setBroken] = useState(false);
			const description = descriptionOf(row, zh);
			const sourceName = sourceNameOf(row);
			const categories = Array.isArray(row.categories) ? row.categories.slice(0, 2) : [];
			// The reference narrows a PAPER thumbnail and widens the rest.
			const thumbWidth = row.type === "PAPER" ? "104px" : "168px";
			return jsxs("article", {
				onMouseEnter: () => { setHover(true); },
				onMouseLeave: () => { setHover(false); },
				style: hover ? CARD_HOVER_STYLE : CARD_STYLE,
				children: [
					jsx("button", {
						type: "button",
						onClick: () => { onOpen(row); },
						"aria-hidden": "true",
						tabIndex: -1,
						style: {
							flex: "none", width: thumbWidth, height: "104px", borderRadius: "8px",
							overflow: "hidden", display: "flex", alignItems: "center", justifyContent: "center",
							background: hue(kind, 0.08), color: hue(kind), border: "none", padding: 0,
							fontSize: "16px", fontWeight: 600, cursor: "pointer"
						},
						children: thumbnail === undefined || broken
							? sourceName.slice(0, 2)
							: jsx("img", {
								// One retry through the Host, then the initials. Sites
								// commonly advertise an `og:image` they then refuse to
								// hand to another page — Microsoft Research answers 403
								// for the very image its own page names. The relay has
								// no page origin to be refused for.
								src: relayed ? `${apiBase()}/proxy/image?url=${encodeURIComponent(thumbnail)}` : thumbnail,
								alt: "",
								loading: "lazy",
								onError: () => { if (relayed) setBroken(true); else setRelayed(true); },
								style: { width: "100%", height: "100%", objectFit: "cover" }
							})
					}),
					jsxs("div", {
						style: { flex: 1, minWidth: 0, display: "flex", flexDirection: "column", gap: "6px" },
						children: [
							jsxs("div", {
								style: META_STYLE,
								children: [
									jsx("span", { children: formatDate(row.publishedAt) }),
									sourceName === "" ? null : jsx("span", {
										style: {
											padding: "1px 8px", borderRadius: "999px",
											background: hue(kind, 0.1), color: hue(kind),
											fontSize: "11px", fontWeight: 500,
											maxWidth: "160px", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap"
										},
										children: sourceName
									}),
									jsx("span", { children: "↑ " + (row.upvoteCount ?? 0) }),
									...categories.map((category, index) => jsx("span", { children: String(category) }, "cat" + index))
								]
							}),
							jsx("button", {
								type: "button",
								onClick: () => { onOpen(row); },
								style: {
									appearance: "none", border: "none", background: "transparent",
									padding: 0, textAlign: "left", font: "inherit", cursor: "pointer",
									fontSize: "15px", fontWeight: 600, lineHeight: "22px",
									color: hue(kind),
									overflow: "hidden", display: "-webkit-box",
									WebkitLineClamp: 2, WebkitBoxOrient: "vertical"
								},
								children: row.title
							}),
							description.text === "" ? null : jsx("p", {
								style: {
									margin: 0, fontSize: "12px", lineHeight: "18px",
									color: "var(--dsw-alias-label-secondary)",
									overflow: "hidden", display: "-webkit-box",
									WebkitLineClamp: 2, WebkitBoxOrient: "vertical"
								},
								children: description.text
							}),
							jsx("div", { style: { height: "1px", background: "var(--dsw-alias-border-l1)", margin: "6px 0 2px" } }),
							jsxs("div", {
								style: ACTIONS_STYLE,
								children: [
									jsx("span", { children: zh ? "收藏" : "Bookmark" }),
									jsx("span", { children: (zh ? "赞 " : "Likes ") + (row.upvoteCount ?? 0) }),
									jsx("span", { children: (zh ? "评论 " : "Comments ") + (row.commentCount ?? 0) })
								]
							})
						]
					})
				]
			});
		}
		//#endregion

		//#region document mode
		/**
		 * The PDF an abstract page stands for, where that mapping is deterministic.
		 *
		 * arXiv publishes `/abs/<id>` as the landing page and `/pdf/<id>` as the paper,
		 * and 84% of the papers in this library arrived as `/abs/` with no `pdfUrl` —
		 * so treating them as ordinary web pages opened arXiv's abstract listing and
		 * called it the paper. The reference never hits this because its own collector
		 * fills `pdfUrl`; rows that arrived without one still need the mapping.
		 * @param row - a stored `Resource`.
		 * @returns the derived PDF URL, or an empty string when none is implied.
		 */
		function derivedPdfUrl(row) {
		  const sourceUrl = typeof row?.sourceUrl === "string" ? row.sourceUrl : "";
		  const match = /^https?:\/\/(?:www\.)?arxiv\.org\/abs\/(.+)$/i.exec(sourceUrl);
		  return match === null ? "" : `https://arxiv.org/pdf/${match[1]}`;
		}

		function displayModeOf(row) {
		  const sourceUrl = typeof row?.sourceUrl === "string" ? row.sourceUrl : "";
		  const stored = typeof row?.pdfUrl === "string" ? row.pdfUrl : "";
		  const pdfUrl = stored !== "" ? stored : derivedPdfUrl(row);
		  if (row?.type === "YOUTUBE" || row?.type === "YOUTUBE_VIDEO") return "youtube";
		  if (sourceUrl.includes("/html/") || pdfUrl.includes("/html/")) return sourceUrl === "" ? "none" : "html";
		  const looksPdf = (url) => {
		    if (url === "") return false;
		    if (url.toLowerCase().endsWith(".pdf")) return true;
		    if (url.includes("/pdf/")) return true;
		    try {
		      const { pathname } = new URL(url);
		      return pathname === "/pdf" || pathname.endsWith("/pdf");
		    } catch {
		      return false;
		    }
		  };
		  if (looksPdf(sourceUrl) || looksPdf(pdfUrl)) return "pdf";
		  return sourceUrl === "" ? "none" : "html";
		}

		/**
		 * The URL whose document should be shown for a source.
		 * @param row - a stored `Resource`.
		 * @returns the document URL, or an empty string when there is none.
		 */
		function documentUrlOf(row) {
		  if (displayModeOf(row) === "pdf") {
		    const stored = typeof row?.pdfUrl === "string" ? row.pdfUrl : "";
		    if (stored !== "") return stored;
		    const derived = derivedPdfUrl(row);
		    if (derived !== "") return derived;
		  }
		  return typeof row?.sourceUrl === "string" ? row.sourceUrl : "";
		}

		//#endregion

		//#region transcript blocks

		/** A block closes at a sentence end in either script's punctuation. */
		const SENTENCE_END = /[.!?。！？][\s]*$/;

		/** Or when it has grown past this, so one unpunctuated monologue is not one block. */
		const MAX_BLOCK_CHARS = 200;

		/** Alternating block tints cycle with this period, as the reference does. */
		const BLOCK_TINT_PERIOD = 4;

		/**
		 * Strip the artifacts YouTube's auto-captions carry.
		 * @param text - one cue's text.
		 * @returns the cleaned text, possibly empty.
		 */
		function cleanCueText(text) {
		  return String(text ?? "")
		    .trim()
		    .replace(/^>\s*>\s*/g, "")
		    .replace(/>\s*>\s*/g, " ")
		    .replace(/^-\s?/, "")
		    .replace(/\s+/g, " ")
		    .trim();
		}

		/**
		 * Merge timed cues into sentence-bounded reading blocks.
		 * @param cues - `[{ start, duration, text }]` in order.
		 * @returns `[{ text, start, duration, blockIndex }]`.
		 */
		function mergeBySentence(cues) {
		  const source = Array.isArray(cues) ? cues : [];
		  const merged = [];
		  let text = "";
		  let start = 0;
		  let duration = 0;
		  let held = 0;
		  let blockIndex = 0;

		  for (const cue of source) {
		    if (held === 0) start = Number(cue?.start ?? 0);
		    const cleaned = cleanCueText(cue?.text);
		    held += 1;
		    if (cleaned === "") continue;
		    text += (text === "" ? "" : " ") + cleaned;
		    duration = Number(cue?.start ?? 0) + Number(cue?.duration ?? 0) - start;
		    if (SENTENCE_END.test(cleaned) || text.length > MAX_BLOCK_CHARS) {
		      merged.push({ text, start, duration, blockIndex: blockIndex++ });
		      text = "";
		      held = 0;
		    }
		  }
		  if (text !== "") merged.push({ text, start, duration, blockIndex });
		  return merged;
		}

		/**
		 * Format a playback offset the way the reference labels a block: `m:ss`, with
		 * hours folded into the minutes rather than shown separately.
		 * @param seconds - offset in seconds.
		 * @returns the label.
		 */
		function formatTime(seconds) {
		  const total = Number.isFinite(seconds) ? Math.max(0, seconds) : 0;
		  const minutes = Math.floor(total / 60);
		  const rest = Math.floor(total % 60);
		  return `${minutes}:${String(rest).padStart(2, "0")}`;
		}

		/**
		 * Index of the block covering a playback position.
		 * @param blocks - merged blocks in order.
		 * @param seconds - current playback offset.
		 * @returns the index, or -1 before the first block starts.
		 */
		function activeBlockIndex(blocks, seconds) {
		  if (!Array.isArray(blocks) || blocks.length === 0) return -1;
		  let found = -1;
		  for (let index = 0; index < blocks.length; index += 1) {
		    if (blocks[index].start <= seconds) found = index;
		    else break;
		  }
		  return found;
		}

		//#endregion

		//#region markdown
		/**
		* Render an assistant answer as Markdown.
		*
		* The reference pipes the same text through `react-markdown` + `remark-gfm`.
		* This bundle resolves no packages — it is loaded as one self-contained
		* script — so the subset a model actually emits is rendered here: headings,
		* bullet and ordered lists, fenced and inline code, bold, italic, links,
		* and paragraphs. Anything unrecognised falls through as its own text
		* rather than disappearing, so no answer is ever silently truncated by the
		* renderer.
		*/

		/** Inline spans: code first, so a backtick span is never re-scanned for bold. */
		const INLINE_PATTERN = /(`[^`]+`)|(\*\*[^*]+\*\*)|(\*[^*\n]+\*)|(\[[^\]]+\]\([^)\s]+\))|(\[\d{1,4}\])/g;
		// The link alternative comes FIRST on purpose: `[1](https://…)` is a
		// link whose text happens to be a number, and a citation alternative
		// scanned before it would eat the `[1]` and leave `(https://…)` as bare
		// text in the middle of a sentence.

		/**
		* Split one line into React children, honouring inline Markdown.
		* @param text - the raw line.
		* @param keyPrefix - key namespace for the produced nodes.
		* @returns an array of strings and elements.
		*/
		/**
		* One `[N]` in the prose, as a control rather than as two characters.
		*
		* A number in a report body is the only thing tying a sentence to the page
		* it came from, and until now it was inert text: a reader who wanted to know
		* what [7] was had nowhere to go, in the browser or in the exported file.
		*
		* With a citation behind it this is a button that scrolls the reference list
		* to that entry. WITHOUT one it is a greyed superscript that says so, because
		* a marker whose source did not survive and a marker whose source is one
		* click away must not look identical — that is the whole difference between
		* a citable report and one that only looks cited.
		* @param token - the raw `[N]`.
		* @param key - the key namespace for the node.
		* @param refs - `{has, jump, zh}` from the report, or null in a chat answer.
		*/
		function missionCitationMark(token, key, refs) {
			const index = Number(token.slice(1, -1));
			const zh = refs?.zh === true;
			const known = typeof refs?.has === "function" && refs.has(index);
			if (!known) {
				return jsx("sup", {
					// Said, not hidden. An index with nothing stored behind it is a hole in
					// the record, and drawing it in the same blue as a working one would
					// hide the hole behind a click that does nothing.
					title: zh
						? "引用元数据缺失：这个编号后面没有留下来源，报告里也查不到它引的是哪一页。"
						: "Citation metadata missing: nothing was stored behind this number, so the page it points at cannot be named.",
					style: {
						fontSize: "10px", verticalAlign: "super", padding: "0 1px",
						color: "var(--dsw-alias-label-tertiary)", cursor: "help"
					},
					children: token
				}, key);
			}
			return jsx("button", {
				type: "button",
				title: zh ? `跳到参考文献第 ${index} 条` : `Jump to reference ${index}`,
				onClick: () => { refs.jump?.(index); },
				style: {
					appearance: "none", border: "none", background: "transparent",
					padding: "0 1px", margin: 0, cursor: "pointer", font: "inherit",
					fontSize: "10px", lineHeight: 1, verticalAlign: "super",
					color: "var(--dsw-alias-state-business-primary)"
				},
				children: token
			}, key);
		}

		function renderInline(text, keyPrefix, refs) {
			const nodes = [];
			let cursor = 0;
			let index = 0;
			for (const match of String(text).matchAll(INLINE_PATTERN)) {
				if (match.index > cursor) nodes.push(text.slice(cursor, match.index));
				const token = match[0];
				const key = `${keyPrefix}-i${index++}`;
				if (token.startsWith("`")) {
					nodes.push(jsx("code", {
						style: {
							padding: "1px 5px", borderRadius: "4px",
							background: "var(--dsw-alias-markdown-code-block)",
							fontFamily: "var(--ds-font-family-code)", fontSize: "12px"
						},
						children: token.slice(1, -1)
					}, key));
				} else if (token.startsWith("**")) {
					nodes.push(jsx("strong", {
						style: { fontWeight: 650, color: "var(--dsw-alias-label-primary)" },
						children: token.slice(2, -2)
					}, key));
				} else if (token.startsWith("[")) {
					const split = token.indexOf("](");
				// `[12]` with no `(` after it is a citation marker, not a broken link.
				if (split < 0) {
					nodes.push(missionCitationMark(token, key, refs));
					cursor = match.index + token.length;
					continue;
				}
					nodes.push(jsx("a", {
						href: token.slice(split + 2, -1),
						target: "_blank",
						rel: "noreferrer noopener",
						style: { color: "var(--dsw-alias-state-business-primary)" },
						children: token.slice(1, split)
					}, key));
				} else {
					nodes.push(jsx("em", { children: token.slice(1, -1) }, key));
				}
				cursor = match.index + token.length;
			}
			if (cursor < text.length) nodes.push(text.slice(cursor));
			return nodes;
		}

		const MD_BLOCK = { margin: "0 0 10px", lineHeight: "22px" };
		const MD_HEADING_SIZES = { 1: "17px", 2: "15px", 3: "14px", 4: "13px" };

		/**
		* Typography for a read, as opposed to a chat answer.
		*
		* One renderer serves both, and they want opposite things: an answer in a
		* 400px panel wants to be compact, an article wants to be comfortable.
		* The article numbers match the reference measured directly from its
		* reader — 18px on 1.75, paragraphs 20px apart, headings in Georgia.
		* Its serif is a system stack, not a downloaded face, so this costs
		* nothing and cannot fail to load.
		*/
		const ARTICLE_SERIF = 'Georgia, "Times New Roman", "Songti SC", "SimSun", serif';
		const ARTICLE_BLOCK = { margin: "0 0 20px", lineHeight: "1.75" };
		const ARTICLE_HEADING_SIZES = { 1: "24px", 2: "20px", 3: "18px", 4: "17px" };

		/**
		* Render a Markdown document as React nodes.
		* @param source - the raw answer text.
		* @param variant - `"chat"` for a panel answer, `"article"` for a read.
		* @param refs - the report's citation index, or null when there is none.
		* @returns an array of block elements.
		*/
		function renderMarkdown(source, variant = "chat", refs = null) {
			const article = variant === "article";
			const block = article ? ARTICLE_BLOCK : MD_BLOCK;
			const headingSizes = article ? ARTICLE_HEADING_SIZES : MD_HEADING_SIZES;
			const lines = String(source ?? "").split("\n");
			const blocks = [];
			let paragraph = [];
			let list = null;
			let fence = null;
			let key = 0;

			const flushParagraph = () => {
				if (paragraph.length === 0) return;
				const text = paragraph.join(" ");
				blocks.push(jsx("p", {
					style: { ...block, color: article ? "var(--dsw-alias-label-primary)" : "var(--dsw-alias-label-secondary)" },
					children: renderInline(text, `p${key}`, refs)
				}, `p${key++}`));
				paragraph = [];
			};
			const flushList = () => {
				if (list === null) return;
				const items = list.items.map((item, at) => jsx("li", {
					style: article ? { margin: "0 0 8px", lineHeight: "1.7" } : { margin: "0 0 5px" },
					children: renderInline(item, `l${key}-${at}`, refs)
				}, `l${key}-${at}`));
				blocks.push(jsx(list.ordered ? "ol" : "ul", {
					style: { ...block, paddingLeft: "24px", color: article ? "var(--dsw-alias-label-primary)" : "var(--dsw-alias-label-secondary)" },
					children: items
				}, `list${key++}`));
				list = null;
			};

			for (const raw of lines) {
				const line = raw.replace(/\s+$/, "");

				if (fence !== null) {
					if (/^```/.test(line.trim())) {
						blocks.push(jsx("pre", {
							style: {
								...MD_BLOCK, padding: "10px 12px", borderRadius: "8px", overflowX: "auto",
								background: "var(--dsw-alias-markdown-code-block)",
								fontFamily: "var(--ds-font-family-code)", fontSize: "12px", lineHeight: "18px",
								color: "var(--dsw-alias-label-secondary)"
							},
							children: fence.join("\n")
						}, `pre${key++}`));
						fence = null;
					} else {
						fence.push(raw);
					}
					continue;
				}
				if (/^```/.test(line.trim())) {
					flushParagraph();
					flushList();
					fence = [];
					continue;
				}

				if (line.trim() === "") {
					flushParagraph();
					flushList();
					continue;
				}

				const heading = /^(#{1,4})\s+(.*)$/.exec(line);
				if (heading !== null) {
					flushParagraph();
					flushList();
					const level = heading[1].length;
					blocks.push(jsx(`h${level}`, {
						style: {
							margin: blocks.length === 0 ? "0 0 8px" : article ? "32px 0 12px" : "14px 0 8px",
							fontSize: (headingSizes[level] ?? (article ? "17px" : "13px")),
							fontWeight: article ? 700 : 650,
							lineHeight: article ? "1.3" : "22px",
							...(article && level <= 2 ? { fontFamily: ARTICLE_SERIF } : {}),
							color: "var(--dsw-alias-label-primary)"
						},
						children: renderInline(heading[2], `h${key}`, refs)
					}, `h${key++}`));
					continue;
				}

				const bullet = /^\s*[-*+]\s+(.*)$/.exec(line);
				const ordered = /^\s*\d+[.)]\s+(.*)$/.exec(line);
				if (bullet !== null || ordered !== null) {
					flushParagraph();
					const wantOrdered = ordered !== null;
					if (list === null || list.ordered !== wantOrdered) {
						flushList();
						list = { ordered: wantOrdered, items: [] };
					}
					list.items.push((bullet ?? ordered)[1]);
					continue;
				}

				// A continuation line inside a list item belongs to that item.
				if (list !== null && /^\s{2,}\S/.test(raw)) {
					list.items[list.items.length - 1] += ` ${line.trim()}`;
					continue;
				}

				flushList();
				paragraph.push(line.trim());
			}
			if (fence !== null) {
				blocks.push(jsx("pre", {
					style: {
						...MD_BLOCK, padding: "10px 12px", borderRadius: "8px", overflowX: "auto",
						background: "var(--dsw-alias-markdown-code-block)",
						fontFamily: "var(--ds-font-family-code)", fontSize: "12px"
					},
					children: fence.join("\n")
				}, `pre${key++}`));
			}
			flushParagraph();
			flushList();
			return blocks;
		}
		//#endregion

		//#region transcript export
		/**
		* Transcript export.
		*
		* The reference exports a PDF, rendered server-side through Chromium
		* (`youtube-subtitles-<id>.pdf`). That needs a renderer this package does
		* not carry, and for captions it is also the least useful shape: a PDF
		* cannot be loaded by a player, diffed, or fed to another tool. So the
		* formats here are the ones a transcript is actually wanted in — SRT and
		* WebVTT load straight into a player, Markdown and plain text go into
		* notes and prompts — and the whole thing is produced in the page, since
		* the cues are already here.
		*
		* The reference's own options carry over: timestamps can be dropped, and
		* the video's identity can be included as a header.
		*/
		const EXPORT_FORMATS = [
			{ id: "txt", label: "TXT", extension: "txt", mime: "text/plain" },
			{ id: "md", label: "Markdown", extension: "md", mime: "text/markdown" },
			{ id: "srt", label: "SRT", extension: "srt", mime: "application/x-subrip" },
			{ id: "vtt", label: "WebVTT", extension: "vtt", mime: "text/vtt" }
		];

		/** `hh:mm:ss,mmm` for SRT and `hh:mm:ss.mmm` for WebVTT. */
		function stampFor(seconds, separator) {
			const total = Number.isFinite(seconds) ? Math.max(0, seconds) : 0;
			const hours = Math.floor(total / 3600);
			const minutes = Math.floor((total % 3600) / 60);
			const rest = Math.floor(total % 60);
			const millis = Math.round((total - Math.floor(total)) * 1000);
			return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}:${String(rest).padStart(2, "0")}${separator}${String(millis).padStart(3, "0")}`;
		}

		/**
		* Build the export body.
		*
		* Subtitle formats carry the ORIGINAL cues: a player needs each cue's own
		* start and end, and the sentence blocks the reader shows would drift out
		* of sync. The prose formats use the merged blocks, because that is what
		* reads as text.
		* @param options - `{ format, cues, blocks, row, withTimestamps, withHeader }`.
		* @returns the file body.
		*/
		function buildExport({ format, cues, blocks, row, withTimestamps, withHeader }) {
			if (format === "srt" || format === "vtt") {
				const separator = format === "srt" ? "," : ".";
				const body = cues.map((cue, index) => {
					const start = stampFor(cue.start, separator);
					const end = stampFor(cue.start + (cue.duration || 2), separator);
					const head = format === "srt" ? `${index + 1}\n` : "";
					return `${head}${start} --> ${end}\n${cue.text}`;
				}).join("\n\n");
				return format === "vtt" ? `WEBVTT\n\n${body}\n` : `${body}\n`;
			}

			const lines = [];
			if (withHeader) {
				if (format === "md") {
					lines.push(`# ${row.title}`, "", `- ${zhLabelSource()}: ${row.sourceUrl}`);
					if (typeof row.publishedAt === "string" && row.publishedAt !== "") lines.push(`- ${zhLabelDate()}: ${formatDate(row.publishedAt)}`);
					lines.push("");
				} else {
					lines.push(row.title, row.sourceUrl, "");
				}
			}
			for (const block of blocks) {
				const stamp = withTimestamps ? `[${formatTime(block.start)}] ` : "";
				lines.push(format === "md" ? `${stamp}${block.text}` : `${stamp}${block.text}`, "");
			}
			return `${lines.join("\n").trimEnd()}\n`;
		}

		/** Locale-following labels for the export header. */
		function zhLabelSource() { return isChinese() ? "来源" : "Source"; }
		function zhLabelDate() { return isChinese() ? "发布" : "Published"; }

		/**
		* Hand the built file to the browser.
		* @param name - file name including extension.
		* @param mime - content type.
		* @param body - file body.
		*/
		function downloadFile(name, mime, body) {
			const url = URL.createObjectURL(new Blob([body], { type: `${mime};charset=utf-8` }));
			const link = document.createElement("a");
			link.href = url;
			link.download = name;
			document.body.appendChild(link);
			link.click();
			link.remove();
			// Revoked on the next turn so the navigation has started.
			setTimeout(() => { URL.revokeObjectURL(url); }, 1000);
		}

		/** Export controls shown above the transcript. */
		function ExportMenu({ row, kind, zh, cues, blocks }) {
			const [open, setOpen] = useState(false);
			const [withTimestamps, setWithTimestamps] = useState(true);
			const [withHeader, setWithHeader] = useState(true);
			const rootRef = useRef(null);

			useEffect(() => {
				if (!open) return;
				const onPointerDown = (event) => {
					if (rootRef.current !== null && !rootRef.current.contains(event.target)) setOpen(false);
				};
				document.addEventListener("pointerdown", onPointerDown, true);
				return () => { document.removeEventListener("pointerdown", onPointerDown, true); };
			}, [open]);

			const run = useCallback((format) => {
				const entry = EXPORT_FORMATS.find((candidate) => candidate.id === format);
				const body = buildExport({ format, cues, blocks, row, withTimestamps, withHeader });
				const stem = String(row.title).replace(/[\\/:*?"<>|]+/g, " ").trim().slice(0, 60) || "transcript";
				downloadFile(`${stem}.${entry.extension}`, entry.mime, body);
				setOpen(false);
			}, [cues, blocks, row, withTimestamps, withHeader]);

			return jsxs("div", {
				ref: rootRef,
				style: { position: "relative" },
				children: [
					jsx("button", {
						type: "button",
						"aria-expanded": open,
						style: { ...controlStyle(), height: "24px", padding: "0 8px", fontSize: "11px" },
						onClick: () => { setOpen((value) => !value); },
						children: zh ? "导出" : "Export"
					}),
					!open ? null : jsxs("div", {
						style: {
							position: "absolute", right: 0, top: "28px", zIndex: 5, width: "230px",
							padding: "10px", borderRadius: "10px",
							border: "1px solid var(--dsw-alias-border-l2)",
							background: "var(--dsw-specific-menu)", boxShadow: "var(--dsw-shadow-lv3)"
						},
						children: [
							jsxs("label", {
								style: { display: "flex", alignItems: "center", gap: "8px", marginBottom: "6px", fontSize: "12px", color: "var(--dsw-alias-label-secondary)", cursor: "pointer" },
								children: [
									jsx("input", { type: "checkbox", checked: withTimestamps, onChange: (event) => { setWithTimestamps(event.target.checked); } }),
									jsx("span", { children: zh ? "包含时间戳" : "Include timestamps" })
								]
							}),
							jsxs("label", {
								style: { display: "flex", alignItems: "center", gap: "8px", marginBottom: "10px", fontSize: "12px", color: "var(--dsw-alias-label-secondary)", cursor: "pointer" },
								children: [
									jsx("input", { type: "checkbox", checked: withHeader, onChange: (event) => { setWithHeader(event.target.checked); } }),
									jsx("span", { children: zh ? "包含标题与链接" : "Include title and link" })
								]
							}),
							jsx("div", {
								style: { display: "grid", gridTemplateColumns: "1fr 1fr", gap: "6px" },
								children: EXPORT_FORMATS.map((entry) => jsx("button", {
									type: "button",
									style: { ...controlStyle(), height: "28px", fontSize: "12px", color: hue(kind) },
									onClick: () => { run(entry.id); },
									children: entry.label
								}, entry.id))
							}),
							jsx("p", {
								style: { margin: "10px 0 0", fontSize: "11px", lineHeight: "16px", color: "var(--dsw-alias-label-secondary)" },
								children: zh
									? "SRT / WebVTT 按原始时轴导出，可直接载入播放器；TXT / Markdown 按语义块导出，便于阅读与引用。"
									: "SRT and WebVTT carry the original cue timings and load into a player; TXT and Markdown carry the reading blocks."
							})
						]
					})
				]
			});
		}
		//#endregion

		//#region detail + assistant
		/** Quick actions the assistant offers, matching the upstream's three. */
		const QUICK_ACTIONS = [
			{ id: "summary", en: "Summary", zh: "摘要" },
			{ id: "insights", en: "Insights", zh: "洞察" },
			{ id: "methodology", en: "Method", zh: "方法" }
		];

		/**
		* Consume one SSE chat response, calling `onDelta` per text fragment.
		*
		* The wire format is the upstream's — `data: {"content"}` lines closed by
		* `data: [DONE]` — so this parser serves both mediums. Frames can split
		* across chunks, so the tail is buffered rather than parsed eagerly.
		* @param response - the streaming fetch response.
		* @param onDelta - receives each text fragment.
		* @returns the terminal error text, or undefined on a clean finish.
		*/
		async function consumeSse(response, onDelta) {
			const reader = response.body?.getReader();
			if (reader === undefined) return "no response body";
			const decoder = new TextDecoder();
			let buffer = "";
			let failure;
			for (;;) {
				const { done, value } = await reader.read();
				if (done) break;
				buffer += decoder.decode(value, { stream: true });
				const lines = buffer.split("\n");
				buffer = lines.pop() ?? "";
				for (const line of lines) {
					if (!line.startsWith("data: ")) continue;
					const data = line.slice(6);
					if (data === "[DONE]") return failure;
					try {
						const parsed = JSON.parse(data);
						if (typeof parsed.error === "string") failure = parsed.error;
						else if (typeof parsed.content === "string") onDelta(parsed.content);
					} catch {
						// A malformed frame is skipped rather than aborting the stream.
					}
				}
			}
			return failure;
		}

		/**
		* Transcript reader for a video source.
		*
		* Laid out the way the reference lays it out
		* (`app/explore/youtube/page.tsx:1554`), because those choices are what
		* make a caption track readable: cues merged to sentence blocks, one
		* timestamp per block in the gutter, alternating block tints so the eye
		* keeps its place in a long column, and a coloured left rule plus raised
		* contrast on the block that is currently playing.
		*
		* The reference hardcodes `bg-white / bg-slate-50 / bg-gray-50 /
		* bg-zinc-50` and `text-gray-700`. Those are reproduced here as theme
		* tokens and a tint of the kind's own colour instead: this shell has a
		* dark mode, and a literal white row would go blind in it.
		*/
		/**
		* Target languages offered for a transcript, mirroring the Host's own
		* list. The Host validates the code it is sent, so a stale entry here
		* fails with a message rather than translating into the wrong language.
		*/
		const TARGET_LANGUAGES = [
			{ code: "zh-Hans", label: "中文（简体）" },
			{ code: "zh-Hant", label: "中文（繁體）" },
			{ code: "en", label: "English" },
			{ code: "ja", label: "日本語" },
			{ code: "ko", label: "한국어" }
		];

		/** Blocks per translation request; must not exceed the Host's own cap. */
		const TRANSLATE_BATCH = 20;

		function TranscriptPanel({ row, kind, zh, currentTime, onSeek }) {
			const [state, setState] = useState({ status: "idle" });
			const activeRef = useRef(null);
			const [follow, setFollow] = useState(true);
			// "" means off. Holding the language here rather than a boolean is
			// what lets a second language be requested without discarding the
			// first: both are cached under their own key.
			const [target, setTarget] = useState("");
			const [translated, setTranslated] = useState(new Map());
			const [translating, setTranslating] = useState({ done: 0, total: 0, error: "" });
			// Bumped to re-run the translation pass over whatever is still
			// missing. A batch the model fluffed writes nothing, so a retry asks
			// only for the gap rather than paying for the whole transcript again.
			const [retryTick, setRetryTick] = useState(0);
			// Read, never depended on: the playback position changes several
			// times a second, and listing it as a dependency would restart the
			// translation run on every tick.
			const positionRef = useRef(0);
			positionRef.current = currentTime;

			useEffect(() => { setState({ status: "idle" }); }, [row.id]);

			/**
			* Fetch the captions from THIS browser and hand them to the Host.
			*
			* The server can read the watch page and extract the signed caption
			* URL, but fetching that URL from a server answers 200 with an empty
			* body — measured with and without `Origin` and `Referer`. The same
			* URL returns the captions here, because YouTube answers the page
			* origin with `Access-Control-Allow-Origin` and
			* `Access-Control-Allow-Credentials: true`, so the visitor's own
			* session travels with the request. This is the route that keeps NEW
			* videos readable with no key and no third party.
			*/
			const browserFetch = useCallback(async () => {
				const videoId = youTubeVideoId(row.sourceUrl);
				if (videoId === undefined) throw new Error(zh ? "不是 YouTube 信源" : "not a YouTube source");
				const listed = await fetch(`${apiBase()}/transcript/tracks?videoId=${videoId}`);
				const listing = await listed.json();
				if (listing?.success !== true) throw new Error(listing?.error ?? "HTTP " + listed.status);
				const tracks = listing.data.tracks;
				if (tracks.length === 0) throw new Error(zh ? "该视频没有字幕轨" : "this video publishes no caption track");
				const preferred = ["zh-Hans", "zh-CN", "zh", "en", "en-US"];
				const track = preferred
					.map((language) => tracks.find((candidate) => String(candidate.languageCode).startsWith(language.split("-")[0])))
					.find((candidate) => candidate !== undefined) ?? tracks[0];
				const captions = await fetch(track.baseUrl, { credentials: "include" });
				if (!captions.ok) throw new Error("timedtext: HTTP " + captions.status);
				const xml = await captions.text();
				if (xml.trim() === "") throw new Error(zh ? "字幕接口返回空内容" : "the caption endpoint returned an empty body");
				const stored = await fetch(`${apiBase()}/transcript/ingest`, {
					method: "POST",
					headers: { "content-type": "application/json" },
					body: JSON.stringify({ resourceId: row.id, language: track.languageCode, xml })
				});
				const payload = await stored.json();
				if (payload?.success !== true) throw new Error(payload?.error ?? "HTTP " + stored.status);
				return payload.data;
			}, [row.id, row.sourceUrl, zh]);

			const load = useCallback(async (refresh) => {
				setState({ status: "loading" });
				const problems = [];
				try {
					const response = await fetch(`${apiBase()}/transcript`, {
						method: "POST",
						headers: { "content-type": "application/json" },
						body: JSON.stringify({ resourceId: row.id, refresh })
					});
					const payload = await response.json();
					if (payload?.success === true) {
						setState({ status: "ready", ...payload.data });
						return;
					}
					problems.push(payload?.error ?? "HTTP " + response.status);
				} catch (cause) {
					problems.push(String(cause?.message ?? cause));
				}
				try {
					setState({ status: "ready", ...await browserFetch() });
				} catch (cause) {
					problems.push((zh ? "浏览器获取：" : "browser: ") + String(cause?.message ?? cause));
					setState({ status: "error", error: problems.join("; ") });
				}
			}, [row.id, browserFetch, zh]);

			// A cached transcript costs nothing to show, so the panel opens with
			// the text already there rather than behind a button.
			useEffect(() => { void load(false); }, [load]);

			// Memoised on the cues, not recomputed per render: the blocks are the
			// dependency of the translation run, and a fresh array each render
			// would restart it every time the playback position ticked.
			const blocks = useMemo(
				() => (state.status === "ready" ? mergeBySentence(state.cues ?? []) : []),
				[state.status, state.cues]
			);
			const active = activeBlockIndex(blocks, currentTime);

			// Switching video or language starts from that language's own cache.
			useEffect(() => {
				setTranslated(new Map());
				setTranslating({ done: 0, total: 0, error: "" });
			}, [row.id, target]);

			useEffect(() => {
				if (target === "" || blocks.length === 0) return;
				let live = true;

				const run = async () => {
					const known = new Map();
					try {
						const cached = await fetch(`${apiBase()}/transcript/translation?resourceId=${encodeURIComponent(row.id)}&lang=${encodeURIComponent(target)}`);
						const payload = await cached.json();
						if (payload?.success === true) {
							for (const entry of payload.data.rows) known.set(entry.start, entry.text);
						}
					} catch {
						// A cache that cannot be read is not a reason to refuse to
						// translate; it only means nothing is skipped.
					}
					if (!live) return;
					if (known.size > 0) setTranslated(new Map(known));

					const missing = blocks.filter((block) => !known.has(block.start));
					if (missing.length === 0) {
						setTranslating({ done: 0, total: 0, error: "" });
						return;
					}
					// Nearest to where the reader is looking first, so the wait
					// starts at their position rather than at the top of what may
					// be a two-hour recording.
					const from = positionRef.current;
					const ordered = [...missing].sort((a, b) => Math.abs(a.start - from) - Math.abs(b.start - from));
					const batches = [];
					for (let at = 0; at < ordered.length; at += TRANSLATE_BATCH) {
						batches.push(ordered.slice(at, at + TRANSLATE_BATCH).sort((a, b) => a.start - b.start));
					}

					let done = 0;
					setTranslating({ done: 0, total: ordered.length, error: "" });
					for (const batch of batches) {
						if (!live) return;
						try {
							const response = await fetch(`${apiBase()}/transcript/translate`, {
								method: "POST",
								headers: { "content-type": "application/json" },
								body: JSON.stringify({
									resourceId: row.id,
									lang: target,
									blocks: batch.map((block) => ({ start: block.start, text: block.text }))
								})
							});
							const payload = await response.json();
							if (!live) return;
							if (payload?.success !== true) throw new Error(payload?.error ?? "HTTP " + response.status);
							setTranslated((previous) => {
								const next = new Map(previous);
								for (const entry of payload.data.rows) next.set(entry.start, entry.text);
								return next;
							});
						} catch (cause) {
							if (!live) return;
							// Report and keep going. One failed batch is a gap in
							// the middle of the transcript, not a reason to leave
							// the rest of it untranslated — and the gap is retried
							// the next time translation is switched on, because
							// nothing was written for it.
							setTranslating((previous) => ({ ...previous, error: String(cause?.message ?? cause) }));
						}
						done += batch.length;
						setTranslating((previous) => ({ ...previous, done }));
					}
				};

				void run();
				return () => { live = false; };
			}, [row.id, target, blocks, retryTick]);

			// What is still missing after a pass, which is what the reader
			// actually needs to know — the raw model error says nothing about
			// how much of the transcript it cost.
			const untranslated = target === "" ? 0 : blocks.reduce((count, block) => count + (translated.has(block.start) ? 0 : 1), 0);
			const running = translating.total > 0 && translating.done < translating.total;

			useEffect(() => {
				if (!follow) return;
				activeRef.current?.scrollIntoView({ block: "center", behavior: "smooth" });
			}, [active, follow]);

			if (state.status === "loading") {
				return jsx("div", { style: NOTE_STYLE, children: zh ? "加载字幕中…" : "Loading transcript…" });
			}
			if (state.status === "error" || blocks.length === 0) {
				return jsxs("div", {
					style: NOTE_STYLE,
					children: [
						jsxs("div", {
							children: [
								jsx("div", {
									style: { fontWeight: 600, color: "var(--dsw-alias-label-secondary)" },
									children: zh ? "暂无字幕" : "No transcript"
								}),
								jsx("div", {
									style: { marginTop: "6px", maxWidth: "48ch" },
									children: state.error ?? (zh ? "该视频可能没有字幕，或字幕暂时无法获取。" : "This video may publish no captions, or they could not be fetched.")
								}),
								jsxs("div", {
									style: { marginTop: "12px", display: "flex", gap: "8px", justifyContent: "center" },
									children: [
										jsx("button", {
											type: "button",
											style: { ...controlStyle(), height: "28px", fontSize: "12px" },
											onClick: () => { void load(true); },
											children: zh ? "重试" : "Retry"
										}),
										jsx("a", {
											href: row.sourceUrl,
											target: "_blank",
											rel: "noreferrer noopener",
											style: {
												...controlStyle(), height: "28px", fontSize: "12px",
												display: "inline-flex", alignItems: "center",
												textDecoration: "none", color: hue(kind)
											},
											children: zh ? "在 YouTube 上观看" : "Watch on YouTube"
										})
									]
								})
							]
						})
					]
				});
			}

			return jsxs("div", {
				style: { display: "flex", flexDirection: "column", minHeight: 0, height: "100%" },
				children: [
					jsxs("div", {
						// Two rows, not one. Six controls plus a status line do not
						// fit across a 400px panel: the status was the flexible
						// item, so it absorbed every shortfall and read as
						// "zh-Hans · cach…". Giving it its own row means the text
						// that says what is happening is never the thing that gets
						// clipped to say it.
						style: {
							flex: "none", display: "flex", flexDirection: "column", gap: "6px",
							padding: "8px 12px", borderBottom: "1px solid var(--dsw-alias-border-l2)",
							fontSize: "11px", color: "var(--dsw-alias-label-secondary)"
						},
						children: [
							jsxs("span", {
								style: { minWidth: 0, display: "flex", alignItems: "center", gap: "6px", overflow: "hidden" },
								children: [
									jsx("span", {
										style: { minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" },
										title: translating.error === "" ? undefined : translating.error,
										children: running
											? (zh ? `翻译中 ${translating.done}/${translating.total}` : `Translating ${translating.done}/${translating.total}`)
											: untranslated > 0
												? (zh ? `${untranslated} 段未译` : `${untranslated} blocks untranslated`)
												: `${state.language} · ${state.via} · ${blocks.length} ${zh ? "段" : "blocks"}`
									}),
									running || untranslated === 0 ? null : jsx("button", {
										type: "button",
										style: { ...controlStyle(), height: "20px", padding: "0 6px", fontSize: "11px", color: hue(kind) },
										onClick: () => { setRetryTick((tick) => tick + 1); },
										children: zh ? "重译" : "Retry"
									})
								]
							}),
							jsxs("div", {
								style: { display: "flex", alignItems: "center", gap: "10px", flexWrap: "wrap" },
								children: [
									jsxs("label", {
										style: { display: "inline-flex", alignItems: "center", gap: "6px", cursor: "pointer" },
										children: [
											jsx("input", {
												type: "checkbox",
												checked: follow,
												onChange: (event) => { setFollow(event.target.checked); }
											}),
											jsx("span", { children: zh ? "跟随播放" : "Follow" })
										]
									}),
									jsxs("label", {
										style: { display: "inline-flex", alignItems: "center", gap: "6px" },
										children: [
											jsx("span", { children: zh ? "翻译" : "Translate" }),
											jsx("select", {
												value: target,
												"aria-label": zh ? "字幕翻译语言" : "Transcript translation language",
												onChange: (event) => { setTarget(event.target.value); },
												style: { ...controlStyle(), height: "24px", padding: "0 4px", fontSize: "11px" },
												children: [
													jsx("option", { value: "", children: zh ? "关闭" : "Off" }, "off"),
													...TARGET_LANGUAGES.map((entry) => jsx("option", { value: entry.code, children: entry.label }, entry.code))
												]
											})
										]
									}),
									jsx("span", { style: { flex: 1 } }, "spacer"),
									jsx(ExportMenu, { row, kind, zh, cues: state.cues ?? [], blocks }),
									jsx("button", {
										type: "button",
										style: { ...controlStyle(), height: "24px", padding: "0 8px", fontSize: "11px" },
										onClick: () => { void load(true); },
										children: zh ? "重取" : "Refetch"
									})
								]
							})
						]
					}),
					jsx("div", {
						style: { flex: 1, minHeight: 0, overflowY: "auto" },
						children: blocks.map((block, index) => {
							const isActive = index === active;
							// The reference cycles four near-white tints; the same
							// rhythm is kept as an alternating token tint so it
							// survives a dark theme.
							const tint = block.blockIndex % BLOCK_TINT_PERIOD === 0
								? "transparent"
								: block.blockIndex % 2 === 0
									? "var(--dsw-alias-bg-module-platform)"
									: "transparent";
							return jsx("div", {
								ref: isActive ? activeRef : undefined,
								onClick: () => { onSeek?.(block.start); },
								style: {
									cursor: "pointer",
									padding: "12px",
									fontSize: "13px",
									background: isActive ? hue(kind, 0.06) : tint,
									borderLeft: `4px solid ${isActive ? hue(kind) : "transparent"}`,
									transition: "background 160ms ease"
								},
								children: jsxs("div", {
									style: { display: "flex", alignItems: "flex-start", gap: "12px" },
									children: [
										jsx("span", {
											style: {
												flex: "none", fontSize: "11px", fontWeight: 500, lineHeight: "21px",
												color: isActive ? hue(kind) : "var(--dsw-alias-label-secondary)"
											},
											children: formatTime(block.start)
										}),
										jsxs("div", {
											style: { flex: 1, minWidth: 0 },
											children: [
												jsx("div", {
													style: {
														lineHeight: "21px",
														fontWeight: isActive ? 500 : 400,
														color: isActive ? "var(--dsw-alias-label-primary)" : "var(--dsw-alias-label-secondary)"
													},
													children: block.text
												}),
												// The translation reads under its source, in the
												// kind's own colour so the two are never mistaken
												// for one another. A block still in the queue
												// renders nothing rather than a placeholder line:
												// a column of "翻译中…" is noise, and the progress
												// count in the header already says work is running.
												target === "" || !translated.has(block.start) ? null : jsx("div", {
													style: {
														marginTop: "4px", lineHeight: "21px",
														color: hue(kind, 0.9)
													},
													children: translated.get(block.start)
												})
											]
										})
									]
								})
							}, `${block.start}-${index}`);
						})
					})
				]
			});
		}

		/** The assistant column: quick actions, transcript, and the composer. */
		function AssistantPanel({ row, zh, currentTime }) {
			const [messages, setMessages] = useState([]);
			const [draft, setDraft] = useState("");
			const [busy, setBusy] = useState(false);
			const tailRef = useRef(null);

			// A new resource starts a new conversation: the upstream clears its
			// transcript on selection for the same reason, so the panel never
			// shows the previous article's answers beside this one's text.
			useEffect(() => {
				setMessages([]);
				setDraft("");
			}, [row.id]);

			useEffect(() => {
				tailRef.current?.scrollIntoView({ block: "end" });
			}, [messages]);

			const run = useCallback(async (endpoint, body, label) => {
				if (busy) return;
				setBusy(true);
				setMessages((prev) => prev.concat([{ role: "user", text: label }, { role: "assistant", text: "" }]));
				try {
					const response = await fetch(`${apiBase()}${endpoint}`, {
						method: "POST",
						headers: { "content-type": "application/json" },
						body: JSON.stringify({ ...body, resourceId: row.id, currentTime })
					});
					if (!response.ok) throw new Error("HTTP " + response.status);
					const failure = await consumeSse(response, (delta) => {
						setMessages((prev) => {
							const next = prev.slice();
							const last = next[next.length - 1];
							next[next.length - 1] = { ...last, text: last.text + delta };
							return next;
						});
					});
					if (failure !== undefined) {
						setMessages((prev) => {
							const next = prev.slice();
							const last = next[next.length - 1];
							next[next.length - 1] = { ...last, text: last.text === "" ? (zh ? "模型调用失败：" : "Model call failed: ") + failure : last.text };
							return next;
						});
					}
				} catch (cause) {
					setMessages((prev) => {
						const next = prev.slice();
						next[next.length - 1] = { role: "assistant", text: (zh ? "请求失败：" : "Request failed: ") + String(cause?.message ?? cause) };
						return next;
					});
				} finally {
					setBusy(false);
				}
			}, [busy, row.id, zh, currentTime]);

			// Fills its tab panel rather than sizing itself: the panel owns the
			// column now, so a fixed width and a sticky box left the composer
			// floating mid-column instead of sitting at the foot where a
			// composer belongs.
			return jsxs("div", {
				style: { flex: 1, minWidth: 0, minHeight: 0, display: "flex", flexDirection: "column" },
				children: [
					jsxs("div", {
						style: {
							flex: "none", display: "flex", alignItems: "center", gap: "8px",
							padding: "12px 16px", borderBottom: "1px solid var(--dsw-alias-border-l2)"
						},
						children: [
							jsx("span", {
								style: { flex: 1, fontSize: "13px", fontWeight: 600, color: "var(--dsw-alias-label-primary)" },
								children: zh ? "AI 助手" : "Assistant"
							}),
							...QUICK_ACTIONS.map((action) => jsx("button", {
								type: "button",
								disabled: busy,
								style: { ...controlStyle(), height: "28px", padding: "0 10px", fontSize: "12px" },
								onClick: () => { void run("/quick-action", { action: action.id }, zh ? action.zh : action.en); },
								children: zh ? action.zh : action.en
							}, action.id))
						]
					}),
					jsxs("div", {
						style: { flex: 1, minHeight: 0, overflowY: "auto", padding: "14px 16px" },
						children: [
							messages.length === 0
								? jsx("p", {
									style: { margin: 0, fontSize: "13px", lineHeight: "20px", color: "var(--dsw-alias-label-secondary)" },
									children: zh
										? "针对这条信源提问，或用上方的快捷操作。回答只依据本条信源的内容。"
										: "Ask about this source, or use a quick action. Answers are grounded in this source only."
								})
								: null,
							// A model answers in Markdown, so it is rendered as Markdown.
							// Shown raw, an answer arrives as `## 核心观点` and
							// `- **…**` and reads worse than no formatting at all.
							// The question keeps `pre-wrap` plain text: it is the
							// person's own words, not a document.
							...messages.map((message, index) => {
								const pending = message.text === "" && busy && index === messages.length - 1;
								if (message.role === "user") {
									return jsx("div", {
										style: {
											marginBottom: "12px", fontSize: "13px", lineHeight: "20px",
											whiteSpace: "pre-wrap", fontWeight: 600,
											color: "var(--dsw-alias-label-primary)"
										},
										children: message.text
									}, String(index));
								}
								return jsx("div", {
									style: { marginBottom: "16px", fontSize: "13px", color: "var(--dsw-alias-label-secondary)" },
									children: pending
										? jsx("span", { style: { color: "var(--dsw-alias-label-secondary)" }, children: zh ? "思考中…" : "Thinking…" })
										: renderMarkdown(message.text)
								}, String(index));
							}),
							jsx("div", { ref: tailRef })
						]
					}),
					jsxs("div", {
						style: {
							flex: "none", display: "flex", gap: "8px", padding: "12px 16px",
							borderTop: "1px solid var(--dsw-alias-border-l2)"
						},
						children: [
							jsx("input", {
								type: "text",
								value: draft,
								disabled: busy,
								placeholder: zh ? "提问…" : "Ask…",
								onChange: (event) => { setDraft(event.target.value); },
								onKeyDown: (event) => {
									if (event.key !== "Enter" || draft.trim() === "") return;
									const message = draft.trim();
									setDraft("");
									void run("/chat", { message }, message);
								},
								style: { ...SEARCH_STYLE, height: "36px", flex: 1 }
							}),
							jsx("button", {
								type: "button",
								disabled: busy || draft.trim() === "",
								style: { ...controlStyle(), height: "36px" },
								onClick: () => {
									const message = draft.trim();
									setDraft("");
									void run("/chat", { message }, message);
								},
								children: zh ? "发送" : "Send"
							})
						]
					})
				]
			});
		}

		/**
		* The uploader's own description of a video.
		*
		* Replaces the chapter-marker panel that used to sit here. A row
		* collected from a feed carries a title and nothing else, so what a video
		* is about was the missing thing on this page — derived chapter markers
		* were answering a question nobody had asked yet.
		*/
		//#region video description structure
		/**
		* A timestamp as a video description writes one: `1:23`, `01:02:03`,
		* optionally in brackets. Anchored per line, not global, because a URL
		* can contain digits and colons too.
		*/
		const CHAPTER_LINE = /^[([]?((?:\d{1,2}:)?\d{1,2}:\d{2})[)\]]?\s*[-–—:.]?\s*(.+)$/;

		/** The same, written inline: `(00:00) Introduction (02:49) Why ...`. */
		const CHAPTER_INLINE = /[([]((?:\d{1,2}:)?\d{1,2}:\d{2})[)\]]\s*/g;

		/** A bare URL. */
		const BARE_URL = /https?:\/\/[^\s<>()[\]]+[^\s<>()[\].,;:!?'"]/g;

		/** `*A section heading*`, which is what YouTube's editor emits for bold. */
		const SECTION_LINE = /^\*(.+?)\*:?\s*$/;

		/** `• item` or `- item`. */
		const BULLET_LINE = /^[•·*\-–]\s+(.+)$/;

		/** `1. item` or `1) item`. */
		const NUMBER_LINE = /^(\d{1,2})[.)]\s+(.+)$/;

		/** Seconds named by a `h:mm:ss` or `m:ss` stamp. */
		function stampSeconds(stamp) {
			const parts = String(stamp).split(":").map((part) => Number(part));
			if (parts.some((part) => !Number.isFinite(part))) return -1;
			return parts.reduce((total, part) => total * 60 + part, 0);
		}

		/**
		* Turn a video description into blocks.
		*
		* A description is a document, not a paragraph: an opening, a numbered
		* list of what the episode covers, a chapter index, and sections of
		* links. It arrives as text with newlines and nothing else, so the
		* structure has to be recognised rather than parsed. Every rule below is
		* one an uploader actually uses; anything unrecognised stays a paragraph,
		* so no line is ever dropped for failing to match.
		*
		* Chapters are the reason this is worth doing at all — the description is
		* where a video keeps its table of contents, and the player is right
		* there.
		* @param text - the raw description.
		* @returns `[{ kind, ... }]` blocks.
		*/
		function describeVideo(text) {
			const lines = String(text ?? "").split("\n");
			const blocks = [];
			let paragraph = [];
			let list = null;

			const flushParagraph = () => {
				if (paragraph.length === 0) return;
				blocks.push({ kind: "paragraph", text: paragraph.join(" ") });
				paragraph = [];
			};
			const flushList = () => {
				if (list === null) return;
				blocks.push(list);
				list = null;
			};
			const flushAll = () => { flushParagraph(); flushList(); };

			for (const raw of lines) {
				const line = raw.trim();
				if (line === "") { flushAll(); continue; }

				const section = SECTION_LINE.exec(line);
				if (section !== null) {
					flushAll();
					blocks.push({ kind: "section", text: section[1].trim() });
					continue;
				}

				// A line that is only chapters — `(00:00) Intro (02:49) Why ...` —
				// is how many uploaders write the whole index on one line.
				const inline = [...line.matchAll(CHAPTER_INLINE)];
				if (inline.length >= 2) {
					flushAll();
					const chapters = [];
					for (let at = 0; at < inline.length; at += 1) {
						const start = inline[at].index + inline[at][0].length;
						const end = at + 1 < inline.length ? inline[at + 1].index : line.length;
						const label = line.slice(start, end).trim();
						if (label !== "") chapters.push({ at: stampSeconds(inline[at][1]), stamp: inline[at][1], label });
					}
					if (chapters.length > 0) { blocks.push({ kind: "chapters", chapters }); continue; }
				}

				const chapter = CHAPTER_LINE.exec(line);
				if (chapter !== null && stampSeconds(chapter[1]) >= 0) {
					flushParagraph();
					if (list === null || list.kind !== "chapters") { flushList(); list = { kind: "chapters", chapters: [] }; }
					list.chapters.push({ at: stampSeconds(chapter[1]), stamp: chapter[1], label: chapter[2].trim() });
					continue;
				}

				const numbered = NUMBER_LINE.exec(line);
				if (numbered !== null) {
					flushParagraph();
					if (list === null || list.kind !== "ordered") { flushList(); list = { kind: "ordered", items: [] }; }
					list.items.push(numbered[2].trim());
					continue;
				}

				const bullet = BULLET_LINE.exec(line);
				if (bullet !== null) {
					flushParagraph();
					if (list === null || list.kind !== "bullets") { flushList(); list = { kind: "bullets", items: [] }; }
					list.items.push(bullet[1].trim());
					continue;
				}

				flushList();
				paragraph.push(line);
			}
			flushAll();
			return blocks;
		}

		/**
		* Render one line, turning bare URLs into links.
		* @param text - the line.
		* @param key - a key prefix.
		* @returns React children.
		*/
		function linkify(text, key) {
			const source = String(text ?? "");
			const nodes = [];
			let at = 0;
			let index = 0;
			BARE_URL.lastIndex = 0;
			for (;;) {
				const match = BARE_URL.exec(source);
				if (match === null) break;
				if (match.index > at) nodes.push(source.slice(at, match.index));
				nodes.push(jsx("a", {
					href: match[0], target: "_blank", rel: "noreferrer noopener",
					style: { color: "var(--dsw-alias-label-link)", wordBreak: "break-all" },
					children: match[0].replace(/^https?:\/\/(?:www\.)?/, "")
				}, `${key}u${index++}`));
				at = match.index + match[0].length;
			}
			if (at < source.length) nodes.push(source.slice(at));
			return nodes.length === 0 ? source : nodes;
		}
		//#endregion

		function VideoDescription({ row, kind, zh, onSeek }) {
			const [state, setState] = useState({ status: "idle", text: row.abstract ?? "" });
			const [expanded, setExpanded] = useState(false);

			useEffect(() => {
				setState({ status: "idle", text: row.abstract ?? "" });
				setExpanded(false);
			}, [row.id, row.abstract]);

			const load = useCallback(async (refresh) => {
				setState((prev) => ({ ...prev, status: "loading" }));
				try {
					const response = await fetch(`${apiBase()}/video-info`, {
						method: "POST",
						headers: { "content-type": "application/json" },
						body: JSON.stringify({ resourceId: row.id, refresh })
					});
					const payload = await response.json();
					if (payload?.success !== true) throw new Error(payload?.error ?? "HTTP " + response.status);
					setState({ status: "ready", text: payload.data.description, meta: payload.data });
				} catch (cause) {
					setState((prev) => ({ ...prev, status: "error", error: String(cause?.message ?? cause) }));
				}
			}, [row.id]);

			// A description already stored costs nothing to show; only a missing
			// one reaches out to the watch page, and it does so on its own.
			useEffect(() => {
				if ((row.abstract ?? "").trim() === "") void load(false);
			}, [row.abstract, load]);

			const text = state.text ?? "";
			const long = text.length > 700;
			// Truncate on a line boundary. Cutting at a character count lands
			// mid-chapter and leaves half a timestamp, which the parser then
			// reads as prose.
			const shown = long && !expanded ? text.slice(0, text.lastIndexOf("\n", 700) + 1 || 700) : text;
			const meta = state.meta;

			return jsxs("section", {
				style: {
					marginTop: "16px", boxSizing: "border-box",
					border: "1px solid var(--dsw-alias-border-l1)",
					borderRadius: "14px", background: "var(--dsw-specific-menu)",
					boxShadow: "var(--dsw-shadow-lv1)", padding: "14px 16px"
				},
				children: [
					jsxs("div", {
						style: { display: "flex", alignItems: "center", gap: "10px", marginBottom: text === "" ? 0 : "10px" },
						children: [
							jsx("span", {
								style: { fontSize: "13px", fontWeight: 600, color: "var(--dsw-alias-label-primary)" },
								children: zh ? "视频介绍" : "About this video"
							}),
							meta === undefined ? jsx("span", { style: { flex: 1 } }) : jsx("span", {
								style: { flex: 1, fontSize: "11px", color: "var(--dsw-alias-label-secondary)" },
								children: [
									meta.lengthSeconds > 0 ? formatTime(meta.lengthSeconds) : "",
									meta.viewCount > 0 ? `${meta.viewCount.toLocaleString()} ${zh ? "次观看" : "views"}` : ""
								].filter((part) => part !== "").join(" · ")
							}),
							jsx("button", {
								type: "button",
								disabled: state.status === "loading",
								style: { ...controlStyle(), height: "26px", padding: "0 10px", fontSize: "11px" },
								onClick: () => { void load(true); },
								children: state.status === "loading" ? (zh ? "获取中…" : "Fetching…") : (zh ? "刷新" : "Refresh")
							})
						]
					}),
					text === ""
						? jsx("p", {
							style: { margin: 0, fontSize: "12px", lineHeight: "18px", color: "var(--dsw-alias-label-secondary)" },
							children: state.status === "error"
								? state.error
								: state.status === "loading"
									? (zh ? "正在从视频页读取简介…" : "Reading the description from the watch page…")
									: (zh ? "该视频没有简介。" : "This video carries no description.")
						})
						: jsxs("div", {
							children: [
								jsx("div", {
									style: { fontSize: "13px", lineHeight: "21px", color: "var(--dsw-alias-label-secondary)" },
									children: describeVideo(shown).map((piece, at) => {
										if (piece.kind === "section") {
											return jsx("div", {
												style: {
													margin: at === 0 ? "0 0 6px" : "14px 0 6px", fontSize: "12px",
													fontWeight: 600, color: "var(--dsw-alias-label-primary)"
												},
												children: piece.text
											}, `s${at}`);
										}
										if (piece.kind === "chapters") {
											// The description is where a video keeps its table of
											// contents, and the player is right beside it. A chapter
											// that cannot be clicked is a timestamp you have to copy
											// out by hand.
											return jsx("div", {
												style: { margin: "6px 0 10px", display: "flex", flexDirection: "column", gap: "1px" },
												children: piece.chapters.map((chapter, index) => jsxs("button", {
													type: "button",
													onClick: () => { onSeek?.(chapter.at); },
													title: zh ? `跳到 ${chapter.stamp}` : `Jump to ${chapter.stamp}`,
													style: {
														appearance: "none", display: "flex", gap: "10px", width: "100%",
														padding: "3px 6px", border: "none", borderRadius: "6px",
														background: "transparent", font: "inherit", fontSize: "12px",
														textAlign: "left", cursor: onSeek === undefined ? "default" : "pointer",
														color: "var(--dsw-alias-label-secondary)"
													},
													children: [
														jsx("span", {
															style: { flex: "none", minWidth: "44px", fontWeight: 500, color: hue(kind) },
															children: chapter.stamp
														}),
														jsx("span", { style: { flex: 1, minWidth: 0 }, children: chapter.label })
													]
												}, `c${index}`))
											}, `ch${at}`);
										}
										if (piece.kind === "ordered" || piece.kind === "bullets") {
											return jsx(piece.kind === "ordered" ? "ol" : "ul", {
												style: { margin: "6px 0 10px", paddingLeft: "22px" },
												children: piece.items.map((item, index) => jsx("li", {
													style: { margin: "0 0 4px" },
													children: linkify(item, `l${at}-${index}-`)
												}, `i${index}`))
											}, `${piece.kind}${at}`);
										}
										return jsx("p", { style: { margin: "0 0 10px" }, children: linkify(piece.text, `p${at}-`) }, `p${at}`);
									})
								}),
								long ? jsx("button", {
									type: "button",
									onClick: () => { setExpanded((value) => !value); },
									style: {
										appearance: "none", border: "none", background: "transparent", padding: "8px 0 0",
										font: "inherit", fontSize: "12px", color: hue(kind), cursor: "pointer"
									},
									children: expanded ? (zh ? "收起" : "Show less") : (zh ? "展开全部" : "Show more")
								}) : null
							]
						})
				]
			});
		}

		/** Reader's own notes on a source, optionally pinned to a playback position. */
		function NotesPanel({ row, zh, currentTime }) {
			const [notes, setNotes] = useState([]);
			const [draft, setDraft] = useState("");
			const [pin, setPin] = useState(true);

			const reload = useCallback(async () => {
				const response = await fetch(`${apiBase()}/notes?resourceId=${encodeURIComponent(row.id)}`);
				const payload = await response.json();
				if (payload?.success === true) setNotes(payload.data.notes);
			}, [row.id]);

			useEffect(() => { void reload(); }, [reload]);

			const add = useCallback(async () => {
				const body = draft.trim();
				if (body === "") return;
				setDraft("");
				await fetch(`${apiBase()}/notes`, {
					method: "POST",
					headers: { "content-type": "application/json" },
					body: JSON.stringify({ resourceId: row.id, body, atSeconds: pin ? currentTime : undefined })
				});
				await reload();
			}, [draft, row.id, pin, currentTime, reload]);

			return jsxs("div", {
				style: { display: "flex", flexDirection: "column", height: "100%", minHeight: 0 },
				children: [
					jsx("div", {
						style: { flex: 1, minHeight: 0, overflowY: "auto", padding: "12px" },
						children: notes.length === 0
							? jsx("p", {
								style: { margin: 0, fontSize: "13px", lineHeight: "20px", color: "var(--dsw-alias-label-secondary)" },
								children: zh ? "还没有笔记。记下的内容存在本地信源库里，跟着这条信源走。" : "No notes yet. What you write is stored in the local library beside this source."
							})
							: notes.map((note) => jsxs("article", {
								style: {
									marginBottom: "10px", padding: "10px 12px",
									border: "1px solid var(--dsw-alias-border-l2)", borderRadius: "10px"
								},
								children: [
									jsxs("div", {
										style: { display: "flex", alignItems: "center", gap: "8px", marginBottom: "6px", fontSize: "11px", color: "var(--dsw-alias-label-secondary)" },
										children: [
											note.atSeconds === null ? null : jsx("span", { children: formatTime(note.atSeconds) }),
											jsx("span", { style: { flex: 1 }, children: formatDate(note.createdAt) }),
											jsx("button", {
												type: "button",
												style: { ...controlStyle(), height: "22px", padding: "0 8px", fontSize: "11px" },
												onClick: async () => {
													await fetch(`${apiBase()}/notes?id=${encodeURIComponent(note.id)}`, { method: "DELETE" });
													await reload();
												},
												children: zh ? "删除" : "Delete"
											})
										]
									}),
									jsx("div", {
										style: { fontSize: "13px", lineHeight: "20px", whiteSpace: "pre-wrap", color: "var(--dsw-alias-label-secondary)" },
										children: note.body
									})
								]
							}, note.id))
					}),
					jsxs("div", {
						style: { flex: "none", padding: "10px 12px", borderTop: "1px solid var(--dsw-alias-border-l2)" },
						children: [
							jsx("textarea", {
								value: draft,
								rows: 3,
								placeholder: zh ? "写点什么…" : "Write a note…",
								onChange: (event) => { setDraft(event.target.value); },
								style: {
									width: "100%", boxSizing: "border-box", resize: "vertical",
									padding: "8px 10px", borderRadius: "8px",
									border: "1px solid var(--dsw-alias-border-l2)", background: "transparent",
									color: "var(--dsw-alias-label-primary)", font: "inherit", fontSize: "13px", outline: "none"
								}
							}),
							jsxs("div", {
								style: { display: "flex", alignItems: "center", gap: "10px", marginTop: "8px" },
								children: [
									jsxs("label", {
										style: { display: "inline-flex", alignItems: "center", gap: "6px", flex: 1, fontSize: "11px", color: "var(--dsw-alias-label-secondary)", cursor: "pointer" },
										children: [
											jsx("input", { type: "checkbox", checked: pin, onChange: (event) => { setPin(event.target.checked); } }),
											jsx("span", { children: zh ? `记录时间点 ${formatTime(currentTime)}` : `Pin at ${formatTime(currentTime)}` })
										]
									}),
									jsx("button", {
										type: "button",
										disabled: draft.trim() === "",
										style: controlStyle(),
										onClick: () => { void add(); },
										children: zh ? "保存" : "Save"
									})
								]
							})
						]
					})
				]
			});
		}

		/**
		* A source's own document, relayed by the Host so the browser can frame it.
		*
		* Three presentations, chosen the way the reference chooses them: a PDF
		* becomes a same-origin blob (a cross-origin PDF cannot be framed), an
		* article can be read either as its own page or as extracted text, and a
		* source with neither shows its link.
		*/
		function DocumentView({ row, kind, zh, wide }) {
			const mode = displayModeOf(row);
			const url = documentUrlOf(row);
			const [blobUrl, setBlobUrl] = useState("");
			const [reader, setReader] = useState(null);
			const [view, setView] = useState(mode === "pdf" ? "pdf" : "reader");
			const [error, setError] = useState("");

			useEffect(() => {
				if (mode !== "pdf" || url === "") return;
				let revoked = "";
				let live = true;
				setError("");
				fetch(`${apiBase()}/proxy/pdf?url=${encodeURIComponent(url)}`)
					.then(async (response) => {
						if (!response.ok) throw new Error("HTTP " + response.status);
						return response.blob();
					})
					.then((blob) => {
						if (!live) return;
						revoked = URL.createObjectURL(blob);
						setBlobUrl(revoked);
					})
					.catch((cause) => { if (live) setError(String(cause?.message ?? cause)); });
				return () => {
					live = false;
					if (revoked !== "") URL.revokeObjectURL(revoked);
				};
			}, [mode, url]);

			useEffect(() => {
				if (mode !== "html" || url === "" || view !== "reader") return;
				let live = true;
				setError("");
				setReader(null);
				fetch(`${apiBase()}/proxy/reader?url=${encodeURIComponent(url)}`)
					.then((response) => response.json())
					.then((payload) => {
						if (!live) return;
						if (payload?.success !== true) throw new Error(payload?.error ?? "extraction failed");
						setReader(payload.data);
					})
					.catch((cause) => { if (live) setError(String(cause?.message ?? cause)); });
				return () => { live = false; };
			}, [mode, url, view]);

			if (mode === "none" || url === "") {
				return jsx("div", { style: NOTE_STYLE, children: zh ? "这条信源没有可打开的文档。" : "This source carries no document to open." });
			}

			const frame = {
				width: "100%", height: "100%", border: "1px solid var(--dsw-alias-border-l1)",
				borderRadius: "12px", boxShadow: "var(--dsw-shadow-lv1)",
				background: "var(--dsw-specific-menu)"
			};

			return jsxs("div", {
				style: { display: "flex", flexDirection: "column", height: "100%", minHeight: 0, gap: "10px" },
				children: [
					mode !== "html" ? null : jsxs("div", {
						style: { flex: "none", display: "flex", gap: "8px" },
						children: [
							jsx("button", {
								type: "button",
								style: view === "reader" ? { ...controlStyle(), borderColor: hue(kind, 0.45), color: hue(kind) } : controlStyle(),
								onClick: () => { setView("reader"); },
								children: zh ? "阅读视图" : "Reader"
							}),
							jsx("button", {
								type: "button",
								style: view === "page" ? { ...controlStyle(), borderColor: hue(kind, 0.45), color: hue(kind) } : controlStyle(),
								onClick: () => { setView("page"); },
								children: zh ? "原始页面" : "Original page"
							})
						]
					}),
					// A refusal is not a blank page. Measured across 40 random rows,
					// nothing else in the library refuses a server-side fetch — the
					// sites that do are consultancies behind a bot check, and their
					// own browser opens them fine. So this state has one job: say
					// plainly what happened, hand over the abstract we already hold
					// so the visit is not wasted, and make opening the original the
					// obvious next move. It fills the pane because a short box above
					// a screen of white reads as a broken layout.
					error !== "" ? jsxs("div", {
						style: {
							flex: 1, minHeight: 0, display: "flex", flexDirection: "column",
							alignItems: "center", justifyContent: "center", gap: "14px",
							padding: "32px", textAlign: "center",
							border: "1px dashed var(--dsw-alias-border-l2)", borderRadius: "12px"
						},
						children: [
							jsx("div", {
								style: { fontSize: "13px", fontWeight: 600, color: "var(--dsw-alias-label-primary)" },
								children: zh ? "该站点拒绝了抓取" : "This site refused the fetch"
							}),
							jsx("div", {
								style: { fontSize: "12px", color: "var(--dsw-alias-label-secondary)", maxWidth: "52ch" },
								children: (zh ? "在你自己的浏览器里通常可以正常打开。" : "It usually opens normally in your own browser. ") + error
							}),
							jsx("a", {
								href: url, target: "_blank", rel: "noreferrer noopener",
								style: {
									display: "inline-flex", alignItems: "center", height: "32px", padding: "0 16px",
									borderRadius: "8px", border: "1px solid " + hue(kind, 0.45),
									background: hue(kind, 0.1), color: hue(kind),
									fontSize: "13px", fontWeight: 500, textDecoration: "none"
								},
								children: zh ? "在浏览器中打开原文 ↗" : "Open the original ↗"
							}),
							summaryOf(row) === "" ? null : jsxs("div", {
								style: {
									marginTop: "8px", paddingTop: "16px", maxWidth: "72ch", textAlign: "left",
									borderTop: "1px solid var(--dsw-alias-border-l1)",
									fontSize: "13px", lineHeight: "21px", color: "var(--dsw-alias-label-secondary)"
								},
								children: [
									jsx("div", {
										style: { marginBottom: "6px", fontSize: "11px", fontWeight: 600, color: "var(--dsw-alias-label-secondary)" },
										children: zh ? "库中已有的摘要" : "The summary already in the library"
									}),
									jsx("div", { children: summaryOf(row) })
								]
							})
						]
					}) : null,
					error !== "" ? null : mode === "pdf"
						? (blobUrl === ""
							? jsx("div", { style: NOTE_STYLE, children: zh ? "加载 PDF 中…" : "Loading PDF…" })
							: jsx("iframe", { src: blobUrl, title: row.title, style: { ...frame, flex: 1 } }))
						: view === "page"
							? jsx("iframe", {
								src: `${apiBase()}/proxy/html?url=${encodeURIComponent(url)}`,
								title: row.title,
								sandbox: "allow-same-origin",
								style: { ...frame, flex: 1 }
							})
							: reader === null
								? jsx("div", { style: NOTE_STYLE, children: zh ? "提取正文中…" : "Extracting article…" })
								: jsx("div", {
									style: { flex: 1, minHeight: 0, overflowY: "auto", padding: "4px 2px" },
									children: jsxs("article", {
										// A measure cap keeps prose readable, but pinned to
										// the left it leaves a field of white beside the
										// text when the reading column is collapsed —
										// which reads as broken rather than deliberate.
										// Centring balances the margins, and the wider
										// cap spends some of the reclaimed width on the
										// text itself.
										// A px measure, not a ch one: `ch` is the width of "0" and varies
										// by face, so a ch cap silently changes meaning when the font
										// does. The reference caps the column at 720px and lands around
										// 68-75 characters a line, on 18px/1.75 — measured from its own
										// reader. Ours was 14px on 24px, and those four pixels are most
										// of why theirs reads better.
										style: {
											maxWidth: wide ? "860px" : "720px",
											margin: "0 auto",
											padding: "8px 24px 40px",
											boxSizing: "border-box",
											fontSize: "18px", lineHeight: "1.75",
											color: "var(--dsw-alias-label-primary)"
										},
										children: [
											// An article opens with its own title. The header row above
											// truncates to fit beside the controls; here it has room.
											jsxs("header", {
												style: { marginBottom: "24px" },
												children: [
													jsx("h1", {
														style: {
															margin: "0 0 12px", fontFamily: ARTICLE_SERIF,
															fontSize: "30px", fontWeight: 700, lineHeight: "1.375",
															letterSpacing: "-0.025em", color: "var(--dsw-alias-label-primary)"
														},
														children: typeof reader.title === "string" && reader.title !== "" ? reader.title : row.title
													}),
													jsx("div", {
														style: {
															display: "flex", flexWrap: "wrap", alignItems: "center", gap: "8px",
															fontSize: "14px", lineHeight: "20px", color: "var(--dsw-alias-label-secondary)"
														},
														children: bylineParts(row, reader, zh).flatMap((part, at) => (at === 0
															? [jsx("span", { style: { fontWeight: 500 }, children: part }, `by${at}`)]
															: [jsx("span", { children: "·" }, `dot${at}`), jsx("span", { children: part }, `by${at}`)]))
													}),
													articleLead(row, reader) === "" ? null : jsx("p", {
														style: {
															margin: "16px 0 0", paddingLeft: "16px",
															borderLeft: `4px solid ${hue(kind)}`,
															fontSize: "16px", fontStyle: "italic", lineHeight: "1.625",
															color: "var(--dsw-alias-label-secondary)"
														},
														children: articleLead(row, reader)
													}),
													jsx("div", { style: { marginTop: "24px", borderBottom: "1px solid var(--dsw-alias-border-l2)" } })
												]
											}, "head"),
											// Readability hands back structure; rendering it as Markdown
											// keeps the headings, lists, and links the article had.
											// The degraded fallback has no markdown, only rough text.
											typeof reader.markdown === "string" && reader.markdown !== ""
												? jsx("div", { children: renderMarkdown(reader.markdown, "article") }, "body")
												: jsx("p", { style: { margin: 0, whiteSpace: "pre-wrap" }, children: reader.text }, "body")
										]
									})
								})
				]
			});
		}

		/** The four reading tabs the reference puts beside a video. */
		const READER_TABS = [
			{ id: "transcript", en: "Transcript", zh: "字幕" },
			{ id: "chat", en: "AI Chat", zh: "AI 对话" },
			{ id: "notes", en: "Notes", zh: "笔记" }
		];

		/**
		* The detail view.
		*
		* Two columns, as the reference lays them out: the source itself on the
		* left — player and derived chapter markers for a video, the document for
		* anything else — and a tabbed reading column on the right. Opening a card
		* switches this view IN PLACE rather than navigating, the way the
		* upstream's `handleResourceClick` flips `viewMode` to `detail`, so the
		* sidebar and the swarm tabs never move.
		*/
		function DetailView({ row, kind, zh, onBack }) {
			const videoId = youTubeVideoId(row.sourceUrl);
			const isVideo = videoId !== undefined;
			const [tab, setTab] = useState(isVideo ? "transcript" : "chat");
			const [collapsed, setCollapsed] = useState(false);
			const [currentTime, setCurrentTime] = useState(0);
			const playerRef = useRef(null);
			const frameRef = useRef(null);

			useEffect(() => { setTab(isVideo ? "transcript" : "chat"); }, [row.id, isVideo]);

			/**
			* Drive the embedded player through the IFrame API.
			*
			* `enablejsapi=1` plus `postMessage` is the whole contract: it gives
			* the transcript a position to highlight and a way to seek, without
			* loading YouTube's own script into this page.
			*/
			const command = useCallback((func, args) => {
				frameRef.current?.contentWindow?.postMessage(
					JSON.stringify({ event: "command", func, args: args ?? [] }),
					"https://www.youtube.com"
				);
			}, []);

			useEffect(() => {
				if (!isVideo) return;
				let heard = false;
				const onMessage = (event) => {
					if (typeof event.data !== "string" || !event.origin.includes("youtube.com")) return;
					heard = true;
					try {
						const parsed = JSON.parse(event.data);
						const seconds = parsed?.info?.currentTime;
						if (typeof seconds === "number") setCurrentTime(seconds);
					} catch {
						// Not a player frame message.
					}
				};
				window.addEventListener("message", onMessage);

				// The handshake only registers if it lands AFTER the player
				// script inside the frame is running, and nothing on this side
				// says when that is — the frame's `load` fires for the document,
				// not for the player. Posting once at mount always arrived too
				// early, so the frame stayed silent for the whole session and
				// the transcript had no position to follow.
				//
				// Retrying until the frame answers is the fix. Once it does,
				// YouTube pushes `infoDelivery` on its own several times a
				// second while playing, so there is nothing left to poll —
				// which is just as well, because `getCurrentTime` sent as a
				// command is write-only and never replies.
				const hello = () => {
					frameRef.current?.contentWindow?.postMessage(
						JSON.stringify({ event: "listening", id: "swarm-player", channel: "widget" }),
						"https://www.youtube.com"
					);
				};
				hello();
				let attempts = 0;
				const handshake = setInterval(() => {
					attempts += 1;
					if (heard || attempts > 40) clearInterval(handshake);
					else hello();
				}, 500);
				return () => {
					window.removeEventListener("message", onMessage);
					clearInterval(handshake);
				};
			}, [isVideo, row.id]);

			const seek = useCallback((seconds) => {
				command("seekTo", [seconds, true]);
				command("playVideo");
				setCurrentTime(seconds);
			}, [command]);

			// Only a video has a transcript; every other source reads its
			// document in the left column, the way the reference puts a viewer
			// beside the assistant rather than behind a tab.
			const activeTabs = isVideo ? READER_TABS : READER_TABS.filter((entry) => entry.id !== "transcript");

			return jsxs("div", {
				// Fills whatever the page body leaves rather than guessing at it.
				// The guess was `calc(100vh - 190px)`, and it was 98px short of
				// the space actually available — a hardcoded subtraction cannot
				// track a header whose height it does not measure.
				style: { display: "flex", gap: "20px", height: "100%", minHeight: 0, padding: "0 24px", boxSizing: "border-box" },
				children: [
					// ── the source itself ────────────────────────────────────
					jsxs("div", {
						style: {
							// `1 1 auto` here resolves the basis from content, so a long
							// title or a wide table let this column bid for space and
							// squeezed the panel below its own width — the panel
							// measured 282px against the 400px it was given. A zero
							// basis makes it take exactly the remainder.
							flex: "1 1 0%", minWidth: 0, display: "flex", flexDirection: "column",
							minHeight: 0, overflowY: "auto", overflowX: "hidden"
						},
						children: [
							jsxs("div", {
								// One row, not three stacked blocks. Back, kind, title,
								// provenance, and the outbound link were costing 140px
								// of height above the document — on a paper that is a
								// third of a page of reading, spent on chrome. The
								// title truncates and keeps its full text in `title`.
								style: {
									flex: "none", display: "flex", alignItems: "baseline",
									gap: "10px", marginBottom: "10px", minWidth: 0
								},
								children: [
									jsx("button", {
										type: "button",
										style: { ...controlStyle(), flex: "none", height: "28px", padding: "0 10px", fontSize: "12px" },
										onClick: onBack,
										children: zh ? "← 返回" : "← Back"
									}),
									jsx("span", {
										style: {
											flex: "none", padding: "2px 10px", borderRadius: "999px",
											background: hue(kind, 0.1), color: hue(kind),
											fontSize: "12px", fontWeight: 500
										},
										children: zh ? kind.zh : kind.en
									}),
									jsx("h1", {
										title: row.title,
										style: {
											flex: 1, minWidth: 0, margin: 0,
											fontSize: "16px", lineHeight: "24px", fontWeight: 650,
											color: "var(--dsw-alias-label-primary)",
											overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap"
										},
										children: row.title
									}),
									jsx("span", {
										style: { flex: "none", fontSize: "11px", color: "var(--dsw-alias-label-secondary)" },
										children: [formatDate(row.publishedAt), sourceNameOf(row)].filter((part) => part !== "").join(" · ")
									}),
									jsx("a", {
										href: row.sourceUrl, target: "_blank", rel: "noreferrer noopener",
										style: { flex: "none", fontSize: "12px", color: hue(kind), textDecoration: "none" },
										children: zh ? "打开原文 ↗" : "Open original ↗"
									})
								]
							}),
							isVideo
								? jsx("div", {
									style: {
										flex: "none", position: "relative", width: "100%", aspectRatio: "16 / 9",
										boxSizing: "border-box", borderRadius: "12px", overflow: "hidden",
										border: "1px solid var(--dsw-alias-border-l1)"
									},
									children: jsx("iframe", {
										ref: frameRef,
										src: `https://www.youtube.com/embed/${videoId}?enablejsapi=1&origin=${encodeURIComponent(window.location.origin)}`,
										title: row.title,
										allow: "accelerometer; clipboard-write; encrypted-media; picture-in-picture",
										allowFullScreen: true,
										referrerPolicy: "strict-origin-when-cross-origin",
										style: { position: "absolute", inset: 0, width: "100%", height: "100%", border: "none" }
									})
								})
								: jsx("div", { style: { flex: 1, minHeight: 0 }, children: jsx(DocumentView, { row, kind, zh, wide: collapsed }) }),
							isVideo ? jsx(VideoDescription, { row, kind, zh, onSeek: seek }) : null
						]
					}),

					// ── the reading column ───────────────────────────────────
					// Collapsed, the column becomes a rail carrying only the way
					// back: a reader who wants the document full-width should not
					// have to lose the transcript's scroll position or the
					// conversation to get it, so the panes are hidden rather
					// than unmounted.
					collapsed ? jsx("aside", {
						style: {
							flex: "none", width: "44px", display: "flex", flexDirection: "column",
							alignItems: "center", padding: "10px 0",
							border: "1px solid var(--dsw-alias-border-l1)", borderRadius: "14px",
							boxShadow: "var(--dsw-shadow-lv1)",
							background: "var(--dsw-specific-menu)"
						},
						children: jsx("button", {
							type: "button",
							title: zh ? "展开阅读栏" : "Expand the reading column",
							"aria-label": zh ? "展开阅读栏" : "Expand the reading column",
							"aria-expanded": false,
							onClick: () => { setCollapsed(false); },
							style: {
								appearance: "none", border: "none", borderRadius: "8px",
								background: hue(kind, 0.1), color: hue(kind),
								padding: "10px 4px", font: "inherit", fontSize: "12px", cursor: "pointer",
								writingMode: "vertical-rl", letterSpacing: "0.08em"
							},
							children: `⟨⟨ ${activeTabs.map((entry) => (zh ? entry.zh : entry.en)).join(" · ")}`
						})
					}) : jsxs("aside", {
						style: {
							// A percentage split gave the panel half the row, which is
							// more than a transcript or a chat thread can use — the
							// document was reading in 650px while 600px of it went to
							// a column of short lines. A capped share keeps the panel
							// usable on a laptop and stops it from claiming width it
							// has no content for on a wide screen.
							flex: "0 0 auto", width: "min(32%, 400px)", minWidth: "260px",
							display: "flex", flexDirection: "column", minHeight: 0,
							// A hairline this faint cannot hold a panel's edge on its
							// own against a white page, so the panel gets the same
							// resting elevation as a card.
							border: "1px solid var(--dsw-alias-border-l1)", borderRadius: "14px",
							boxShadow: "var(--dsw-shadow-lv1)",
							background: "var(--dsw-specific-menu)", overflow: "hidden"
						},
						children: [
							jsx("div", {
								style: {
									flex: "none", display: "flex", alignItems: "center", gap: "6px",
									padding: "8px", borderBottom: "1px solid var(--dsw-alias-border-l2)"
								},
								role: "tablist",
								children: [
									...activeTabs.map((entry) => jsx("button", {
										type: "button",
										role: "tab",
										"aria-selected": entry.id === tab,
										onClick: () => { setTab(entry.id); },
										style: {
											appearance: "none", border: "none", borderRadius: "8px",
											padding: "7px 14px", font: "inherit", fontSize: "13px", cursor: "pointer",
											fontWeight: entry.id === tab ? 600 : 400,
											background: entry.id === tab ? hue(kind, 0.12) : "transparent",
											color: entry.id === tab ? hue(kind) : "var(--dsw-alias-label-secondary)"
										},
										children: zh ? entry.zh : entry.en
									}, entry.id)),
									jsx("span", { style: { flex: 1 } }, "spacer"),
									// Carries a border and a word. The first attempt was a
									// 28px chevron in the faintest label colour, and it
									// could only be found by reading the accessibility
									// tree — a control nobody sees is not a feature.
									jsx("button", {
										type: "button",
										title: zh ? "折叠阅读栏，让正文占满" : "Collapse the reading column and widen the document",
										"aria-label": zh ? "折叠阅读栏" : "Collapse the reading column",
										"aria-expanded": true,
										onClick: () => { setCollapsed(true); },
										style: {
											...controlStyle(), height: "28px", padding: "0 10px",
											display: "inline-flex", alignItems: "center", gap: "6px",
											fontSize: "12px"
										},
										children: `⟩⟩ ${zh ? "折叠" : "Collapse"}`
									}, "collapse")
								]
							}),
							jsx("div", {
								style: { flex: 1, minHeight: 0, display: "flex", flexDirection: "column" },
								role: "tabpanel",
								children: tab === "transcript"
									? jsx(TranscriptPanel, { row, kind, zh, currentTime, onSeek: seek })
									: tab === "chat"
										? jsx(AssistantPanel, { row, zh, currentTime })
										: jsx(NotesPanel, { row, zh, currentTime })
							})
						]
					})
				]
			});
		}
		//#endregion

		//#region explore tab
		/** The 信源 tab: search, kind filter, sort, and the paged resource feed. */
		function ExploreTab({ zh }) {
			const [kindId, setKindId] = useState(KINDS[0].id);
			const [sortBy, setSortBy] = useState(SORTS[0].id);
			const [draft, setDraft] = useState("");
			const [search, setSearch] = useState("");
			const [rows, setRows] = useState([]);
			const [total, setTotal] = useState(0);
			const [hasMore, setHasMore] = useState(false);
			const [status, setStatus] = useState("loading");
			const [error, setError] = useState("");
			const kind = KINDS.find((candidate) => candidate.id === kindId) ?? KINDS[0];
			// list | detail, switched in place so the frame never changes.
			const [selected, setSelected] = useState(null);
			const [seeding, setSeeding] = useState(false);
			const [seedReport, setSeedReport] = useState("");
			const [reloadTick, setReloadTick] = useState(0);
			// Guards a stale response from overwriting a newer one when the
			// kind or query changes while a request is still in flight.
			const requestId = useRef(0);

			/**
			* Pull the current kind from the upstream into the local library.
			*
			* Seeding is a migration action, not a read path: the remote service
			* is scheduled to be retired, so this exists to get its rows into the
			* local store while it is still up.
			*/
			const runSeed = useCallback(async () => {
				setSeeding(true);
				setSeedReport("");
				try {
					const response = await fetch(`${apiBase()}/seed?type=${encodeURIComponent(kind.type)}`, { method: "POST" });
					const payload = await response.json();
					if (payload?.success !== true) throw new Error(payload?.error ?? "seed failed");
					const result = payload.data.results[0] ?? {};
					setSeedReport(zh
						? `已导入 ${result.written ?? 0} 条（跳过 ${result.skipped ?? 0}），本地库共 ${payload.data.total} 条。`
						: `Imported ${result.written ?? 0} row(s), skipped ${result.skipped ?? 0}; the library now holds ${payload.data.total}.`);
					setReloadTick((tick) => tick + 1);
				} catch (cause) {
					setSeedReport((zh ? "导入失败：" : "Seed failed: ") + String(cause?.message ?? cause));
				} finally {
					setSeeding(false);
				}
			}, [kind, zh]);


			const load = useCallback(async (append) => {
				const ticket = ++requestId.current;
				setStatus(append ? "loading-more" : "loading");
				setError("");
				try {
					const url = resourcesUrl({
						base: apiBase(), kind, sortBy, search,
						skip: append ? rows.length : 0
					});
					const response = await fetch(url);
					if (!response.ok) throw new Error("HTTP " + response.status);
					const feed = unwrapFeed(await response.json());
					if (ticket !== requestId.current) return;
					setRows(append ? rows.concat(feed.rows) : feed.rows);
					setTotal(feed.total);
					setHasMore(feed.hasMore);
					setStatus("ready");
				} catch (cause) {
					if (ticket !== requestId.current) return;
					setError(String(cause?.message ?? cause));
					setStatus("error");
				}
			}, [kind, sortBy, search, rows]);

			// Reload whenever the query identity changes. `load` closes over
			// `rows` for appending, so the effect depends on the identity
			// fields rather than on the callback.
			useEffect(() => {
				let live = true;
				const ticket = ++requestId.current;
				setStatus("loading");
				setError("");
				fetch(resourcesUrl({ base: apiBase(), kind, sortBy, search, skip: 0 }))
					.then((response) => {
						if (!response.ok) throw new Error("HTTP " + response.status);
						return response.json();
					})
					.then((payload) => {
						if (!live || ticket !== requestId.current) return;
						const feed = unwrapFeed(payload);
						setRows(feed.rows);
						setTotal(feed.total);
						setHasMore(feed.hasMore);
						setStatus("ready");
					})
					.catch((cause) => {
						if (!live || ticket !== requestId.current) return;
						setError(String(cause?.message ?? cause));
						setStatus("error");
					});
				return () => { live = false; };
			}, [kindId, sortBy, search, reloadTick]);

			if (selected !== null) {
				return jsx(DetailView, { row: selected, kind, zh, onBack: () => { setSelected(null); } });
			}

			// The scrollbar belongs to the frame, not to the column of cards.
			// `overflowY` sat on the box that also carried `maxWidth: 1080px`,
			// so the bar was parked 1080px in with a band of dead page beside
			// it. The scroller has to span the full width; the measure cap and
			// the side padding both live one level deeper.
			return jsx("div", {
				style: { height: "100%", minHeight: 0, overflowY: "auto" },
				children: jsxs("div", {
				style: { ...CONTENT_STYLE, padding: "0 24px" },
				children: [
					jsx("input", {
						type: "search",
						placeholder: zh ? "搜索任何内容…" : "Search anything…",
						"aria-label": zh ? "搜索信源" : "Search sources",
						value: draft,
						onChange: (event) => { setDraft(event.target.value); },
						onKeyDown: (event) => { if (event.key === "Enter") setSearch(draft); },
						style: SEARCH_STYLE
					}),
					jsxs("div", {
						style: TOOLBAR_STYLE,
						children: [
							...KINDS.map((candidate) => jsx("button", {
								type: "button",
								role: "tab",
								"aria-selected": candidate.id === kindId,
								style: chipStyle(candidate, candidate.id === kindId),
								onClick: () => { setKindId(candidate.id); },
								children: zh ? candidate.zh : candidate.en
							}, candidate.id)),
							jsx("span", { style: { flex: 1 } }, "spacer"),
							jsx("select", {
								"aria-label": zh ? "排序" : "Sort",
								value: sortBy,
								onChange: (event) => { setSortBy(event.target.value); },
								style: controlStyle(),
								children: SORTS.map((option) => jsx("option", {
									value: option.id,
									children: zh ? option.zh : option.en
								}, option.id))
							}, "sort")
						]
					}),
					status === "error"
						? jsxs("div", {
							style: NOTE_STYLE,
							children: [
								jsxs("div", {
									children: [
										jsx("div", { children: (zh ? "信源加载失败：" : "Could not load sources: ") + error }),
										jsx("div", {
											style: { marginTop: "10px", fontSize: "12px" },
											children: (zh ? "接口：" : "Endpoint: ") + apiBase()
										})
									]
								})
							]
						})
						: null,
					status === "loading"
						? jsx("div", { style: NOTE_STYLE, children: zh ? "加载中…" : "Loading…" })
						: null,
					status !== "loading" && status !== "error" && rows.length === 0
						? jsx("div", {
							style: NOTE_STYLE,
							children: jsxs("div", {
								children: [
									jsx("div", { children: zh ? "本地信源库中该类别为空。" : "The local library holds no source of this kind." }),
									jsx("div", {
										style: { marginTop: "6px", fontSize: "12px", color: "var(--dsw-alias-label-secondary)" },
										children: zh
											? "可从云端导入一批做种，之后由蜂群自行采集。"
											: "Seed a batch from the upstream, then let the swarm collect on its own."
									}),
									jsx("button", {
										type: "button",
										style: { ...controlStyle(), marginTop: "14px" },
										disabled: seeding,
										onClick: () => { void runSeed(); },
										children: seeding
											? (zh ? "导入中…" : "Seeding…")
											: (zh ? "从云端导入" : "Seed from upstream")
									})
								]
							})
						})
						: null,
					seedReport === "" ? null : jsx("div", {
						style: { margin: "10px 0", fontSize: "12px", color: "var(--dsw-alias-label-secondary)" },
						children: seedReport
					}),
					rows.length === 0 ? null : jsxs("div", {
						children: [
							jsx("div", {
								style: { margin: "0 0 10px", fontSize: "12px", color: "var(--dsw-alias-label-secondary)" },
								children: (zh ? "共 " : "") + total + (zh ? " 条" : " results")
							}),
							...rows.map((row, index) => jsx(ResourceCard, { row, kind, zh, onOpen: setSelected }, row.id ?? String(index)))
						]
					}),
					hasMore && status === "ready"
						? jsx("div", {
							style: { display: "flex", justifyContent: "center", padding: "8px 0 4px" },
							children: jsx("button", {
								type: "button",
								style: controlStyle(),
								onClick: () => { void load(true); },
								children: zh ? "加载更多" : "Load more"
							})
						})
						: null,
					status === "loading-more"
						? jsx("div", {
							style: { textAlign: "center", padding: "8px", fontSize: "12px", color: "var(--dsw-alias-label-secondary)" },
							children: zh ? "加载中…" : "Loading…"
						})
						: null
				]
				})
			});
		}
		//#endregion

		//#region missions model
		/**
		* 洞察 — the mission surface: start one, watch it run, read what it wrote.
		*
		* This tab used to list claim cards from the hourly batch pass. It drives
		* the twelve-stage mission pipeline instead, because that is the thing a
		* person can start, watch, and be answered by; the batch pass has no
		* beginning anybody chose and no end they can read.
		*
		* Everything on screen comes from the Host half's routes and nothing is
		* computed here that lib/mission-view.js already computes: `/missions/list`,
		* `/missions/:id/view` (the whole read model), `/missions/:id/artifact`,
		* and the four POST actions. In particular the tier table and the five
		* ceilings are READ from `/missions/budget-tiers` rather than held here —
		* playground centralised its tier values and its frontend still drifted
		* from its backend on the field limits, which is exactly why that route
		* serves the limits too.
		*
		* Progress is POLLED. `/missions/:id/events` is a Server-Sent stream and
		* would give a tighter tail, but the view route already carries that tail
		* beside the stages, the dimensions and the cost — one request that
		* cannot disagree with itself beats two that can.
		*/
		const MISSION_POLL_MS = 4000;

		/**
		* How many events the tail asks for.
		*
		* The view route bounds this read and says so (`timeline.bounded`), and
		* the one payload worth having in it — the `evidence:none` diagnostics —
		* is written at s4, near the end of a mission that found nothing. Asking
		* for the maximum would carry a deep mission's whole log on every poll.
		*/
		const MISSION_TAIL = 200;

		/**
		* The status chips. Every id is a member of the Host half's
		* MISSION_STATUSES, because the route answers an unknown one with a 400
		* naming the accepted values — which is the right answer, and not one
		* worth provoking from a chip.
		*/
		const MISSION_FILTERS = [
			{ id: "", en: "All", zh: "全部", hue: "100,116,139" },
			{ id: "running", en: "Running", zh: "运行中", hue: "2,132,199" },
			{ id: "completed", en: "Completed", zh: "已完成", hue: "5,150,105" },
			{ id: "quality-failed", en: "Not signed", zh: "未签署", hue: "217,119,6" },
			{ id: "resumable", en: "Resumable", zh: "可继续", hue: "124,58,237" },
			{ id: "failed", en: "Failed", zh: "失败", hue: "220,38,38" },
			{ id: "cancelled", en: "Cancelled", zh: "已取消", hue: "100,116,139" }
		];

		/**
		* The pill vocabulary, keyed by the code the projector computes.
		*
		* `mission.pill.label` arrives from the Host half in Chinese only, so the
		* words are re-derived here rather than shown as they come: a tab that
		* pairs every other string and then prints one server-side Chinese label
		* into an English page is worse than one that never translated anything.
		*
		* `quality-failed` is 未签署 rather than 失败 because the report exists
		* and is readable and the Leader declined to sign it. Those are different
		* outcomes, and the second one still has something to read.
		*/
		const MISSION_PILL_FACES = {
			running: { zh: "运行中", en: "Running", hue: "2,132,199" },
			resumable: { zh: "可继续", en: "Resumable", hue: "124,58,237" },
			completed: { zh: "完成", en: "Completed", hue: "5,150,105" },
			failed: { zh: "失败", en: "Failed", hue: "220,38,38" },
			cancelled: { zh: "已取消", en: "Cancelled", hue: "100,116,139" },
			"quality-failed": { zh: "未签署", en: "Not signed off", hue: "217,119,6" },
			unknown: { zh: "未知", en: "Unknown", hue: "100,116,139" },
			"unknown-terminal": { zh: "未知（已结束）", en: "Unknown (ended)", hue: "220,38,38" }
		};

		/** The twelve stages, in the order they run. The ids are the Host half's; the words are ours. */
		const MISSION_STAGE_FACES = {
			"s1-brief": { zh: "立项", en: "Brief" },
			"s2-plan": { zh: "规划", en: "Plan" },
			"s3-collect": { zh: "采集", en: "Collect" },
			"s4-assess": { zh: "评估", en: "Assess" },
			"s5-reconcile": { zh: "归一", en: "Reconcile" },
			"s6-synthesize": { zh: "综合", en: "Synthesize" },
			"s7-outline": { zh: "拟纲", en: "Outline" },
			"s8-write": { zh: "撰写", en: "Write" },
			"s9-verify": { zh: "核验", en: "Verify" },
			"s10-critique": { zh: "复盘", en: "Critique" },
			"s11-signoff": { zh: "签署", en: "Sign-off" },
			"s12-persist": { zh: "归档", en: "Persist" }
		};

		/** Stage statuses. `skipped-by-tier` is not a failure and must not be drawn as one. */
		const MISSION_STAGE_STATUS_FACES = {
			pending: { zh: "待运行", en: "Pending", hue: "148,163,184" },
			running: { zh: "运行中", en: "Running", hue: "2,132,199" },
			done: { zh: "完成", en: "Done", hue: "5,150,105" },
			degraded: { zh: "降级完成", en: "Degraded", hue: "217,119,6" },
			failed: { zh: "失败", en: "Failed", hue: "220,38,38" },
			"skipped-by-tier": { zh: "本档跳过", en: "Skipped at this tier", hue: "148,163,184" }
		};

		/** Dimension states, from `mission_dimensions.state`. */
		const MISSION_DIMENSION_FACES = {
			pending: { zh: "待采集", en: "Pending", hue: "148,163,184" },
			collecting: { zh: "采集中", en: "Collecting", hue: "2,132,199" },
			collected: { zh: "已采集", en: "Collected", hue: "5,150,105" },
			degraded: { zh: "降级", en: "Degraded", hue: "217,119,6" },
			failed: { zh: "失败", en: "Failed", hue: "220,38,38" }
		};

		/**
		* The verify states, split the way the store splits them.
		*
		* The whole reason `verify_state` has nine values is that "4 fetches
		* failed with 429" and "4 quotes were invented" are the same number in
		* the same place and need opposite responses. Merging them here would
		* undo that at the last step, on the one screen where it matters.
		*/
		const MISSION_VERIFY_FACES = {
			"verified-source-text": { zh: "已核验", en: "Verified" },
			"verified-adjacent-spans": { zh: "跨段核验", en: "Verified across spans" },
			"verified-abstract": { zh: "仅摘要核验", en: "Verified against an abstract" },
			misattributed: { zh: "出处不符", en: "Found in another source" },
			unverifiable: { zh: "查无此文", en: "Found nowhere we hold" },
			"too-short": { zh: "引语过短", en: "Below the quote floor" },
			"unchecked-fetch-failed": { zh: "抓取失败", en: "Fetch failed" },
			"unchecked-rate-limited": { zh: "被限流", en: "Rate limited" },
			"unchecked-stale": { zh: "页面过期", en: "Page too old" }
		};

		/**
		* The content guard's seven codes, in words a reader can act on.
		*
		* A COPY of `GUARD_CODES` in lib/mission-view.js, and named as one: the guard
		* owns the list, this side only has to say what each one means. A code that
		* grows on the Host half and not here falls through `missionFace` to its raw
		* string, which reads badly but never blank.
		*/
		const MISSION_GUARD_FACES = {
			"word-count": { zh: "字数没到下限", en: "Below the word floor" },
			"empty-chapter": { zh: "有章节是空的", en: "A chapter came back empty" },
			"under-delivered": { zh: "有章节没写够", en: "A chapter under-delivered" },
			"no-citations": { zh: "全文一处引用都没有", en: "Nothing in the report is cited" },
			"section-offsets": { zh: "章节位置和正文对不上", en: "The section offsets do not line up with the body" },
			placeholder: { zh: "正文里留着占位符", en: "Placeholder text was left in the body" },
			"scorecard-empty": { zh: "核验记分卡是空的", en: "The scorecard was never filled in" }
		};

		/**
		* The three orders `/missions/:id/findings` sorts by.
		*
		* `created` is the order the run wrote them in and is the default. The other
		* two exist because the two questions a reader has about a dimension's
		* evidence — is this all one site, and did any of it actually verify — are
		* answered by a sort and not by a scroll.
		*/
		const MISSION_FINDING_ORDER_FACES = {
			created: { zh: "按记录顺序", en: "As recorded" },
			host: { zh: "按站点", en: "By host" },
			verifyState: { zh: "按核验状态", en: "By verify state" }
		};

		/** The six ceilings, named. `wall` is a clock, so it is formatted as one. */
		const MISSION_METER_FACES = {
			tokens: { zh: "令牌", en: "Tokens" },
			calls: { zh: "模型调用", en: "Model calls" },
			arxiv: { zh: "arXiv 请求", en: "arXiv requests" },
			web: { zh: "网页搜索", en: "Web searches" },
			fetch: { zh: "抓取页面", en: "Page fetches" },
			wall: { zh: "用时", en: "Wall clock" }
		};

		/** Every event type the Host half registers, in the reader's language. */
		const MISSION_EVENT_FACES = {
			"mission:created": { zh: "任务建立", en: "Mission created" },
			"mission:claimed": { zh: "接管本次运行", en: "Run claimed" },
			"mission:parked": { zh: "已挂起", en: "Parked" },
			"mission:finalized": { zh: "任务收尾", en: "Mission finalized" },
			"mission:started": { zh: "开始运行", en: "Mission started" },
			"mission:resumed": { zh: "从检查点继续", en: "Resumed from a checkpoint" },
			"stages:opened": { zh: "阶段表建立", en: "Stage rows opened" },
			"stage:started": { zh: "阶段开始", en: "Stage started" },
			"stage:done": { zh: "阶段完成", en: "Stage done" },
			"stage:degraded": { zh: "阶段降级完成", en: "Stage degraded" },
			"stage:failed": { zh: "阶段失败", en: "Stage failed" },
			"stage:skipped-by-tier": { zh: "本档跳过", en: "Skipped at this tier" },
			"stage:stalled": { zh: "阶段停滞", en: "Stage stalled" },
			"gate:passed": { zh: "闸门通过", en: "Gate passed" },
			"gate:soft-warning": { zh: "预算软警告", en: "Soft budget warning" },
			"gate:hard-warning": { zh: "硬闸门告警", en: "Hard gate warning" },
			"gate:refused": { zh: "闸门拒绝", en: "Gate refused" },
			"artifact:written": { zh: "报告已归档", en: "Artefact written" },
			"evidence:none": { zh: "没有任何可核验的证据", en: "No verifiable evidence" },
			"evidence:thin": { zh: "证据偏薄", en: "Evidence is thin" },
			"recollect:allowed": { zh: "允许补采", en: "Recollect allowed" },
			"recollect:refused": { zh: "拒绝补采", en: "Recollect refused" },
			"recollect:no-gain": { zh: "补采没有新增", en: "Recollect gained nothing" },
			"checkpoint:divergence": { zh: "检查点分歧", en: "Checkpoint divergence" },
			"runtime:orphan-reclaimed": { zh: "回收了孤儿任务", en: "Orphan reclaimed" },
			"runtime:owner-conflict": { zh: "归属冲突", en: "Owner conflict" },
			"runtime:reclaim-limit": { zh: "回收次数到顶", en: "Reclaim limit reached" },
			"postlude:pending": { zh: "收尾待办", en: "Postlude pending" },
			"postlude:handoff-failed": { zh: "收尾交接失败", en: "Postlude handoff failed" }
		};

		/**
		* Label a stored vocabulary value, falling back to the value itself.
		*
		* Own-property lookup, and never an empty string: these tables are keyed
		* by whatever a TEXT column holds, `constructor` included, and a badge
		* that renders blank for a value the page does not recognise looks
		* exactly like a badge for a row that has no value at all.
		* @param faces - the label table.
		* @param value - the stored value.
		* @param zh - whether to write Chinese.
		* @returns the label, or the raw value when the table does not know it.
		*/
		function missionFace(faces, value, zh) {
			const key = String(value ?? "");
			if (!Object.hasOwn(faces, key)) return key;
			return zh ? faces[key].zh : faces[key].en;
		}

		/** The colour a vocabulary value carries, neutral for one this page does not know. */
		function missionHue(faces, value) {
			const key = String(value ?? "");
			return Object.hasOwn(faces, key) && typeof faces[key].hue === "string" ? faces[key].hue : "100,116,139";
		}

		/**
		* The pill: its words, its colour, and the degradation it carries.
		*
		* `pill.code` is `completed-degraded` when the projector found degraded
		* dimensions or a degraded report, and that suffix is the whole point —
		* 完成 and 完成 · 3/5 维度降级 are different answers to "did this work",
		* and only the second one says go and read it anyway.
		* @param pill - `mission.pill` from the view route.
		* @param zh - whether to write Chinese.
		* @returns `{ label, hue, note }`; `note` is "" when nothing is degraded.
		*/
		function missionPillFace(pill, zh) {
			const code = String(pill?.code ?? "unknown");
			const degraded = code.endsWith("-degraded");
			const base = degraded ? code.slice(0, -"-degraded".length) : code;
			const label = missionFace(MISSION_PILL_FACES, base, zh);
			if (!degraded) return { label, hue: missionHue(MISSION_PILL_FACES, base), note: "" };
			const total = Number(pill?.totalDimensions ?? 0);
			const bad = Number(pill?.degradedDimensions ?? 0);
			return {
				label,
				// Degradation is amber whatever the base outcome was, because the
				// question it answers — can I trust all of this — is the same
				// whether the mission completed or failed.
				hue: "217,119,6",
				note: bad > 0
					? (zh ? `${bad}/${total} 个维度降级` : `${bad}/${total} dimensions degraded`)
					: (zh ? "报告降级" : "the report is degraded")
			};
		}

		/**
		* A duration a person reads at a glance.
		*
		* Missions run from minutes to hours, so seconds alone are unreadable at
		* the top of the range and hours alone say nothing while one is starting.
		* @param ms - milliseconds.
		* @param zh - whether to write Chinese.
		* @returns the duration, or "" when there is no number to show.
		*/
		function missionDuration(ms, zh) {
			const value = Number(ms);
			if (!Number.isFinite(value) || value < 0) return "";
			const seconds = Math.round(value / 1000);
			if (seconds < 60) return zh ? `${seconds} 秒` : `${seconds}s`;
			const minutes = Math.floor(seconds / 60);
			if (minutes < 60) {
				// A round number stays round. "20 分 0 秒" is the same duration
				// written to look like a measurement, and a ceiling that reads as
				// a measurement invites a precision nobody promised.
				if (seconds % 60 === 0) return zh ? `${minutes} 分` : `${minutes}m`;
				return zh ? `${minutes} 分 ${seconds % 60} 秒` : `${minutes}m ${seconds % 60}s`;
			}
			const hours = Math.floor(minutes / 60);
			if (minutes % 60 === 0) return zh ? `${hours} 小时` : `${hours}h`;
			return zh ? `${hours} 小时 ${minutes % 60} 分` : `${hours}h ${minutes % 60}m`;
		}

		/**
		* One meter's used-against-limit line, in the unit that meter counts in.
		*
		* `limit: null` is not "no ceiling to worry about" — it is a ceiling the
		* mission row does not carry, which is a different sentence and must not
		* read as plenty left.
		* @param meter - one of the six from `cost`.
		* @param zh - whether to write Chinese.
		* @returns the line under the bar.
		*/
		function missionMeterLine(meter, zh) {
			const wall = meter.dimension === "wall";
			const used = wall ? missionDuration(meter.used, zh) : String(meter.used ?? 0);
			if (meter.limit === null || meter.limit === undefined) {
				return used + (zh ? " · 未记录上限" : " · no ceiling recorded");
			}
			const limit = wall ? missionDuration(meter.limit, zh) : String(meter.limit);
			return `${used} / ${limit} · ${Math.round((meter.ratio ?? 0) * 100)}%`;
		}

		/**
		* Read one mission answer, envelope and all.
		*
		* The envelope is read even on a non-2xx, unlike the sources feed: these
		* routes answer 400 and 409 with the sentence that says what to do about
		* it — budgetGate's own refusal, canResume's next action, the concurrency
		* cap listing what is already running — and throwing "HTTP 409" discards
		* the only part of that answer worth showing.
		* @param response - the fetch response.
		* @returns the `data` object.
		*/
		async function missionData(response) {
			const payload = await response.json();
			if (payload?.success !== true) throw new Error(payload?.error ?? "HTTP " + response.status);
			return payload.data ?? {};
		}

		/**
		* Non-zero entries of a verify-state histogram, labelled and ordered.
		*
		* Zeroes are dropped rather than drawn as "0 被限流", which reads as a
		* problem that happened none of the time instead of one that never
		* happened at all.
		* @param counts - `{[verifyState]: n}`.
		* @param zh - whether to write Chinese.
		* @returns `[{ state, n, label }]`, largest first.
		*/
		function missionVerifyRows(counts, zh) {
			const rows = [];
			for (const [state, value] of Object.entries(counts ?? {})) {
				const n = Number(value ?? 0);
				if (!Number.isFinite(n) || n <= 0) continue;
				rows.push({ state, n, label: missionFace(MISSION_VERIFY_FACES, state, zh) });
			}
			return rows.sort((a, b) => b.n - a.n);
		}

		/**
		* One line of detail for an event, from the fields we know it carries.
		*
		* Known keys first, then a bounded dump of the rest. The dump is
		* deliberate: this tail is the only place a person can see WHY a stage
		* settled the way it did, and a log that hides every payload it was not
		* taught about stops being useful exactly when something new goes wrong.
		* @param event - one entry from `timeline.events`.
		* @param zh - whether to write Chinese.
		* @returns the detail line, or "".
		*/
		function missionEventDetail(event, zh) {
			const payload = event?.payload ?? {};
			if (payload === null || typeof payload !== "object") return "";
			const parts = [];
			const step = payload.stepId ?? payload.step_id ?? null;
			if (typeof step === "string" && step !== "") parts.push(missionFace(MISSION_STAGE_FACES, step, zh));
			if (typeof payload.durationMs === "number") parts.push(missionDuration(payload.durationMs, zh));
			// Every one of these is a sentence the Host half wrote to say what
			// happened and what to do next. Shown verbatim: two wordings of one
			// refusal is the same defect as two names for one method.
			for (const key of ["why", "reason", "note", "detail", "error", "degradeNote"]) {
				const value = payload[key];
				if (typeof value === "string" && value !== "") parts.push(value);
			}
			if (Array.isArray(payload.violations) && payload.violations.length > 0) {
				parts.push(payload.violations.map((row) => `${row?.code ?? ""}: ${row?.detail ?? ""}`).join(" "));
			}
			if (parts.length > 0) return parts.join(" · ");
			const rest = JSON.stringify(payload);
			return rest === "{}" || rest === undefined ? "" : rest.slice(0, 200);
		}

		/**
		* The collection diagnostics carried by the last `evidence:none` event.
		*
		* Written by the runtime the moment the evidence floor gate answers
		* `none`, precisely so a mission that verified nothing can still say what
		* it tried. Read from the event tail rather than from a second route,
		* because there is no second route and inventing one would put a second
		* answer beside the one the runtime already froze.
		* @param timeline - `timeline` from the view route.
		* @returns `{ why, diagnostics }`, or null when no such event is in the tail.
		*/
		function missionNoEvidence(timeline) {
			const events = Array.isArray(timeline?.events) ? timeline.events : [];
			for (let at = events.length - 1; at >= 0; at -= 1) {
				const event = events[at];
				if (event?.type !== "evidence:none") continue;
				const payload = event.payload ?? {};
				return {
					why: typeof payload.why === "string" ? payload.why : "",
					diagnostics: payload.diagnostics ?? null
				};
			}
			return null;
		}
		//#endregion

		//#region missions start
		/**
		* The three depth tiers, as words only.
		*
		* Every NUMBER behind a tier — the five ceilings and the wall clock —
		* comes from `/missions/budget-tiers`, never from here. A copy of the
		* tier table in the browser is the drift playground shipped: its frontend
		* and its backend disagreed about the field limits long after the tier
		* values had been centralised, and nothing on either side said so.
		*/
		const MISSION_TIER_FACES = {
			quick: { zh: "快速", en: "Quick", hue: "5,150,105" },
			standard: { zh: "标准", en: "Standard", hue: "2,132,199" },
			deep: { zh: "深度", en: "Deep", hue: "124,58,237" }
		};

		/**
		* What one tier costs at most, in the units the ceilings are counted in.
		* @param budget - one entry of `tiers` from `/missions/budget-tiers`.
		* @param zh - whether to write Chinese.
		* @returns the line under the tier's name, or "" when the route sent nothing for it.
		*/
		function missionTierLine(budget, zh) {
			if (budget === null || budget === undefined || typeof budget !== "object") return "";
			const wall = missionDuration(budget.wallMs, zh);
			return zh
				? `最长 ${wall} · ${budget.maxCalls} 次模型调用 · 最多抓 ${budget.maxFetch} 页`
				: `up to ${wall} · ${budget.maxCalls} model calls · at most ${budget.maxFetch} pages fetched`;
		}

		/**
		* Start a mission: a topic, a tier, and one button.
		*
		* The tiers are FETCHED rather than listed, so the three names on screen
		* are the three the Host half will accept and the numbers under them are
		* the ones it will actually spend. When that fetch fails the button is
		* disabled and says which endpoint did not answer — a form that submits a
		* tier the server has never heard of is a 400 the person cannot act on.
		* @param zh - whether to write Chinese.
		* @param onStarted - called with the new mission id, to open it.
		*/
		function MissionStarter({ zh, onStarted }) {
			const [topic, setTopic] = useState("");
			const [depth, setDepth] = useState("");
			const [tiers, setTiers] = useState(null);
			const [tiersError, setTiersError] = useState("");
			const [busy, setBusy] = useState(false);
			const [error, setError] = useState("");
			const [notice, setNotice] = useState("");

			useEffect(() => {
				let live = true;
				fetch(`${apiBase()}/missions/budget-tiers`)
					.then(missionData)
					.then((data) => {
						if (!live) return;
						setTiers(data);
						setTiersError("");
						// The middle tier is the default the Host half also
						// defaults to, but it is picked from the answer rather
						// than named here, so a tier list that changes shape does
						// not leave this form pointing at a depth nobody serves.
						const depths = Array.isArray(data.depths) ? data.depths : [];
						setDepth((current) => (current !== "" ? current : depths[1] ?? depths[0] ?? ""));
					})
					.catch((cause) => { if (live) setTiersError(String(cause?.message ?? cause)); });
				return () => { live = false; };
			}, []);

			const start = useCallback(async () => {
				setBusy(true);
				setError("");
				setNotice("");
				try {
					const response = await fetch(`${apiBase()}/missions/create`, {
						method: "POST",
						headers: { "content-type": "application/json" },
						body: JSON.stringify({ topic, depth })
					});
					const data = await missionData(response);
					setTopic("");
					// `started: false` means the row exists and nothing is driving
					// it. Reported with the Host half's own reason: a create that
					// answered 200 and quietly did not run is the one failure this
					// field exists to name.
					if (data.started === false) {
						setNotice((zh ? "任务已建立，但没有跑起来：" : "The mission was created but did not start: ")
							+ String(data.startedReason ?? ""));
					}
					if (typeof data.id === "string" && data.id !== "") onStarted(data.id);
				} catch (cause) {
					// budgetGate's refusal, the concurrency cap, the topic length —
					// all of them arrive as one sentence that says what to change.
					// Shown as it came.
					setError(String(cause?.message ?? cause));
				} finally {
					setBusy(false);
				}
			}, [topic, depth, zh, onStarted]);

			const depths = Array.isArray(tiers?.depths) ? tiers.depths : [];
			const table = tiers?.tiers ?? {};
			const ready = topic.trim() !== "" && depth !== "" && !busy;

			return jsxs("div", {
				style: { ...CARD_STYLE, display: "flex", flexDirection: "column", gap: "12px", padding: "16px" },
				children: [
					jsx("input", {
						type: "text",
						value: topic,
						placeholder: zh ? "要调研什么？写一个问题，越具体越好。" : "What should the swarm research? A question, as specific as you can make it.",
						"aria-label": zh ? "任务课题" : "Mission topic",
						onChange: (event) => { setTopic(event.target.value); },
						onKeyDown: (event) => { if (event.key === "Enter" && ready) void start(); },
						style: SEARCH_STYLE
					}, "topic"),
					jsxs("div", {
						style: { display: "flex", alignItems: "center", gap: "8px", flexWrap: "wrap" },
						children: [
							...depths.map((id) => jsx("button", {
								type: "button",
								role: "tab",
								"aria-selected": id === depth,
								title: missionTierLine(table[id], zh),
								onClick: () => { setDepth(id); },
								style: chipStyle({ hue: missionHue(MISSION_TIER_FACES, id) }, id === depth),
								children: missionFace(MISSION_TIER_FACES, id, zh)
							}, id)),
							jsx("span", { style: { flex: 1 } }, "spacer"),
							jsx("button", {
								type: "button",
								disabled: !ready,
								onClick: () => { void start(); },
								style: { ...controlStyle(), opacity: ready ? 1 : 0.5 },
								children: busy ? (zh ? "正在建立…" : "Starting…") : (zh ? "开始调研" : "Start")
							}, "go")
						]
					}, "controls"),
					depth === "" ? null : jsx("div", {
						style: { fontSize: "12px", color: "var(--dsw-alias-label-secondary)" },
						children: missionTierLine(table[depth], zh)
					}, "tier"),
					tiersError === "" ? null : jsx("div", {
						style: { fontSize: "12px", color: "rgb(220,38,38)" },
						children: (zh ? "读不到档位表，暂时不能新建任务：" : "The tier table did not answer, so a mission cannot be started: ")
							+ tiersError + ` (${apiBase()}/missions/budget-tiers)`
					}, "tiersError"),
					error === "" ? null : jsx("div", {
						style: { fontSize: "12px", lineHeight: "18px", color: "rgb(220,38,38)" },
						children: error
					}, "error"),
					notice === "" ? null : jsx("div", {
						style: { fontSize: "12px", lineHeight: "18px", color: "rgb(217,119,6)" },
						children: notice
					}, "notice")
				]
			});
		}
		//#endregion

		//#region missions list
		/**
		* One mission in the list: what was asked, how it ended, what it cost.
		*
		* `live` is the Host half's answer to "which of these is this process
		* actually running", which is not the same question as "which rows say
		* running". A row left running by a process that died is not a live
		* mission, and this list is where that difference is visible.
		* @param mission - one row from `/missions/list`.
		* @param live - whether the runner reports this id as running here.
		* @param zh - whether to write Chinese.
		* @param onOpen - open the detail view on this mission.
		*/
		function MissionListRow({ mission, live, zh, onOpen, onRemoved }) {
			const [hover, setHover] = useState(false);
			// Two clicks, no dialog. `confirm()` blocks the event loop and a modal
			// for one row is more chrome than the action deserves; the label
			// changing to "click again" is the confirmation.
			const [confirming, setConfirming] = useState(false);
			const [removing, setRemoving] = useState(false);
			const [trouble, setTrouble] = useState("");

			const remove = useCallback(async () => {
				if (!confirming) { setConfirming(true); return; }
				setRemoving(true);
				setTrouble("");
				try {
					const response = await fetch(`${apiBase()}/missions/${encodeURIComponent(mission.id)}/delete`, { method: "DELETE" });
					const payload = await response.json();
					if (payload?.success !== true) throw new Error(payload?.error ?? `HTTP ${response.status}`);
					onRemoved?.(mission.id);
				} catch (cause) {
					// Named, not swallowed: the route refuses a running mission with
					// a reason, and that reason is the whole answer to "why is it
					// still there".
					setTrouble(String(cause?.message ?? cause));
					setConfirming(false);
				} finally {
					setRemoving(false);
				}
			}, [confirming, mission.id, onRemoved]);
			const face = missionPillFace({ code: mission.status }, zh);
			const stale = mission.status === "running" && !live;
			const meta = [
				missionFace(MISSION_TIER_FACES, mission.depth, zh),
				zh ? `第 ${mission.runCount} 次运行` : `run ${mission.runCount}`,
				zh ? `已核验 ${mission.verifiedFindings ?? 0} 条` : `${mission.verifiedFindings ?? 0} verified`,
				zh ? `${Number(mission.spend?.tokens ?? 0).toLocaleString()} 令牌` : `${Number(mission.spend?.tokens ?? 0).toLocaleString()} tokens`,
				formatStamp(mission.startedAt)
			].filter((piece) => piece !== "").join(" · ");

			// The topic is the control, the way a 信源 card's title is: a whole
			// card wrapped in one button puts flow content inside phrasing
			// content and hands a screen reader one enormous label.
			return jsx("article", {
				style: hover ? CARD_HOVER_STYLE : CARD_STYLE,
				onMouseEnter: () => { setHover(true); },
				onMouseLeave: () => { setHover(false); },
				children: jsxs("div", {
					style: { flex: 1, minWidth: 0, display: "flex", flexDirection: "column", gap: "8px" },
					children: [
						jsxs("div", {
							style: { display: "flex", alignItems: "center", gap: "10px", width: "100%" },
							children: [
								jsx("button", {
									type: "button",
									onClick: () => { onOpen(mission.id); },
									style: {
										appearance: "none", border: "none", background: "transparent", padding: 0,
										flex: 1, minWidth: 0, textAlign: "left", font: "inherit", cursor: "pointer",
										fontSize: "15px", fontWeight: 600, lineHeight: "22px",
										color: "var(--dsw-alias-label-primary)"
									},
									children: mission.topic
								}, "topic"),
								jsx("span", {
									style: {
										flex: "none", padding: "1px 7px", borderRadius: "5px",
										background: `rgba(${face.hue},0.12)`, color: `rgb(${face.hue})`,
										fontSize: "11px", fontWeight: 600
									},
									children: face.label
								}, "pill")
							]
						}, "head"),
						jsx("div", { style: META_STYLE, children: meta }, "meta"),
						// A row that says running while nothing is running it is the
						// symptom of a process that died mid-mission. Named here
						// rather than left for the person to infer from a clock that
						// never moves.
						!stale ? null : jsx("div", {
							style: { fontSize: "12px", color: "rgb(217,119,6)" },
							children: zh
								? "这一条写着运行中，但本进程没有在跑它 —— 多半是上次进程退出时留下的，打开后可以继续或重跑。"
								: "This row says running, but this process is not running it — most likely left behind by an earlier exit. Open it to resume or rerun."
						}, "stale"),
						mission.errorMessage === null || mission.errorMessage === undefined || mission.errorMessage === "" ? null : jsx("div", {
							style: { fontSize: "12px", lineHeight: "18px", color: "var(--dsw-alias-label-secondary)" },
							children: (mission.failureCode === null || mission.failureCode === undefined ? "" : `${mission.failureCode} · `) + mission.errorMessage
						}, "error"),
						// Delete. There was no way to remove a mission at all — no
						// route, no store method, no button — so the list only ever
						// grew, and the first thing anybody wants to do with a run
						// that failed for a reason since fixed is get rid of it.
						//
						// Shown on hover and only for a settled mission: the route
						// refuses a running one, and offering a control that will be
						// refused is worse than not offering it.
						!hover || mission.status === "running" ? null : jsx("div", {
							style: { display: "flex", justifyContent: "flex-end" },
							children: jsx("button", {
								type: "button",
								disabled: removing,
								style: {
									appearance: "none", background: "transparent", cursor: "pointer",
									border: "1px solid var(--dsw-alias-border-l1)", borderRadius: "8px",
									padding: "3px 10px", fontSize: "11px",
									color: "var(--dsw-alias-label-secondary)"
								},
								onClick: (event) => {
									// The card's own click opens the mission; without this
									// the delete would open what it just removed.
									event.stopPropagation();
									void remove();
								},
								children: removing
									? (zh ? "删除中…" : "Deleting…")
									: confirming
									? (zh ? "再点一次确认删除" : "Click again to delete")
									: (zh ? "删除" : "Delete")
							}, "delete")
						}, "actions"),
						trouble === "" ? null : jsx("div", {
							style: { fontSize: "12px", color: "rgb(220,38,38)" },
							children: trouble
						}, "trouble")
					]
				})
			});
		}

		/**
		* The 洞察 tab: the mission list, the form that opens one, and the
		* detail view that watches it.
		*
		* List and detail are switched IN PLACE, the way 信源 switches into its
		* reader, so the frame never moves under the person reading it.
		* @param zh - whether to write Chinese.
		*/
		function MissionsTab({ zh }) {
			const [filterId, setFilterId] = useState("");
			const [missions, setMissions] = useState([]);
			const [counts, setCounts] = useState({});
			const [live, setLive] = useState([]);
			const [total, setTotal] = useState(0);
			const [state, setState] = useState("loading");
			const [error, setError] = useState("");
			const [tick, setTick] = useState(0);
			const [openId, setOpenId] = useState("");
			// Guards a stale answer from overwriting a newer one when the chip
			// changes while a request is still in flight.
			const requestId = useRef(0);

			useEffect(() => {
				let alive = true;
				const ticket = ++requestId.current;
				const params = new URLSearchParams({ take: String(PAGE_SIZE), skip: "0" });
				if (filterId !== "") params.append("status", filterId);
				fetch(`${apiBase()}/missions/list?${params.toString()}`)
					.then(missionData)
					.then((data) => {
						if (!alive || ticket !== requestId.current) return;
						setMissions(Array.isArray(data.missions) ? data.missions : []);
						setCounts(data.counts !== null && typeof data.counts === "object" ? data.counts : {});
						setLive(Array.isArray(data.live) ? data.live : []);
						setTotal(Number(data.total ?? 0));
						setState("ready");
					})
					.catch((cause) => {
						if (!alive || ticket !== requestId.current) return;
						setError(String(cause?.message ?? cause));
						setState("error");
					});
				return () => { alive = false; };
			}, [filterId, tick]);

			// Re-read while this process is running something. The timer is
			// unref'd because this module is also rendered in Node by
			// tests/settings.test.mjs, which never unmounts: an ordinary interval
			// there keeps the test runner alive after the assertions have passed.
			useEffect(() => {
				if (live.length === 0) return;
				const timer = setTimeout(() => { setTick((value) => value + 1); }, MISSION_POLL_MS);
				timer.unref?.();
				return () => { clearTimeout(timer); };
			}, [live, tick]);

			if (openId !== "") {
				return jsx(MissionDetail, {
					missionId: openId,
					zh,
					onBack: () => { setOpenId(""); setTick((value) => value + 1); }
				});
			}

			const known = Object.values(counts).reduce((sum, value) => sum + Number(value ?? 0), 0);

			// The scrollbar belongs to the frame, not to the column of cards —
			// the same arrangement 信源 settled on, and the reason the tab body
			// hands this component the whole height.
			return jsx("div", {
				style: { height: "100%", minHeight: 0, overflowY: "auto" },
				children: jsxs("div", {
					style: { ...CONTENT_STYLE, padding: "0 24px" },
					children: [
						jsx(MissionStarter, { zh, onStarted: (id) => { setOpenId(id); } }, "starter"),
						jsxs("div", {
							style: TOOLBAR_STYLE,
							children: [
								...MISSION_FILTERS.map((entry) => jsx("button", {
									type: "button",
									role: "tab",
									"aria-selected": entry.id === filterId,
									style: chipStyle(entry, entry.id === filterId),
									onClick: () => { setFilterId(entry.id); },
									children: entry.id === "" || counts[entry.id] === undefined
										? (zh ? entry.zh : entry.en)
										: `${zh ? entry.zh : entry.en} ${counts[entry.id]}`
								}, entry.id === "" ? "all" : entry.id)),
								jsx("span", { style: { flex: 1 } }, "spacer"),
								jsx("button", {
									type: "button",
									style: controlStyle(),
									onClick: () => { setTick((value) => value + 1); },
									children: zh ? "刷新" : "Refresh"
								}, "refresh")
							]
						}, "toolbar"),
						state !== "error" ? null : jsx("div", {
							style: NOTE_STYLE,
							children: jsxs("div", {
								children: [
									jsx("div", { children: (zh ? "任务列表加载失败：" : "Could not load the missions: ") + error }),
									jsx("div", {
										style: { marginTop: "10px", fontSize: "12px" },
										children: (zh ? "接口：" : "Endpoint: ") + apiBase() + "/missions/list"
									})
								]
							})
						}, "error"),
						state !== "loading" ? null : jsx("div", { style: NOTE_STYLE, children: zh ? "加载中…" : "Loading…" }, "loading"),
						state !== "ready" || missions.length > 0 ? null : jsx("div", {
							style: NOTE_STYLE,
							children: jsx("div", {
								// Two different empties, two different sentences. A
								// chip with nothing under it is a filter to undo; a
								// library with nothing in it is waiting for somebody
								// to ask a question.
								children: filterId !== "" && known > 0
									? (zh ? "这个筛选下没有任务，换成“全部”看看。" : "No mission under this chip — try All.")
									: (zh ? "还没有跑过任何任务。在上面写一个课题，选一个档位，按“开始调研”。" : "No mission has been run yet. Write a topic above, pick a tier, and press Start.")
							})
						}, "empty"),
						missions.length === 0 ? null : jsxs("div", {
							children: [
								jsx("div", {
									style: { margin: "0 0 10px", fontSize: "12px", color: "var(--dsw-alias-label-secondary)" },
									children: (zh ? `共 ${total} 个任务` : `${total} mission(s)`)
										+ (live.length === 0 ? "" : (zh ? ` · 本进程正在跑 ${live.length} 个` : ` · ${live.length} running in this process`))
								}, "tally"),
								...missions.map((mission) => jsx(MissionListRow, {
									mission, zh, live: live.includes(mission.id),
									onOpen: (id) => { setOpenId(id); },
									// The list refreshes on a tick rather than through a
									// loader, so a delete nudges the tick instead of
									// calling one that does not exist.
									onRemoved: () => { setTick((value) => value + 1); }
								}, mission.id))
							]
						}, "rows")
					]
				})
			});
		}
		//#endregion

		//#region missions detail panels
		/** A small section heading, so the detail view reads as panels rather than as one column of text. */
		function MissionPanel({ title, note, children, bare }) {
			return jsxs("section", {
				// `bare` drops the card entirely. A pane whose only child is a
				// panel titled the same as the tab above it is a border, a title
				// and 28px of padding spent restating the tab.
				style: bare === true
					? { display: "flex", flexDirection: "column", gap: "6px" }
					: { ...CARD_STYLE, display: "flex", flexDirection: "column", gap: "8px", padding: "12px" },
				children: [
					jsxs("div", {
						style: { display: "flex", alignItems: "baseline", gap: "10px", flexWrap: "wrap" },
						children: [
							bare === true ? null : jsx("h3", {
								style: { margin: 0, fontSize: "13px", fontWeight: 600, letterSpacing: "0.02em", color: "var(--dsw-alias-label-primary)" },
								children: title
							}, "title"),
							note === "" || note === undefined || note === null ? null : jsx("span", {
								style: { fontSize: "12px", color: "var(--dsw-alias-label-secondary)" },
								children: note
							}, "note")
						]
					}, "head"),
					jsx("div", { children }, "body")
				]
			});
		}

		/**
		* The twelve stages, always twelve, in catalogue order.
		*
		* The projector guarantees the count is invariant — a stage this tier
		* does not run is `skipped-by-tier`, not a hole — so the strip is a fixed
		* ruler a person can learn the shape of, rather than a list that grows.
		* Degrade notes are printed UNDER the strip rather than left in a
		* tooltip: a stage that finished by lowering its own bar has said why,
		* and hiding that behind a hover is how a degraded run reads as a clean one.
		* @param stages - `stages` from the view route.
		* @param zh - whether to write Chinese.
		*/
		function MissionStageStrip({ stages, zh, notes: withNotes }) {
			// The notes are OFF by default. This strip sits above every pane, and
			// the four degrade paragraphs it used to print under itself were the
			// third copy of the same text on the screen: the task board carries
			// each note on its own row, and the drawer holds it whole. Three
			// copies of a paragraph is not emphasis, it is five lines of the pane
			// underneath.
			const notes = withNotes !== true
				? []
				: stages.filter((stage) => (stage.degradeNote ?? "") !== "" || stage.status === "failed" || stage.stalled);
			return jsxs("div", {
				style: { display: "flex", flexDirection: "column", gap: "10px" },
				children: [
					jsx("div", {
						style: { display: "flex", flexWrap: "wrap", gap: "6px" },
						children: stages.map((stage) => {
							const hue = missionHue(MISSION_STAGE_STATUS_FACES, stage.status);
							const duration = stage.durationMs === null || stage.durationMs === undefined
								? "" : missionDuration(stage.durationMs, zh);
							return jsxs("span", {
								title: `${stage.stepId} · ${missionFace(MISSION_STAGE_STATUS_FACES, stage.status, zh)}`
									+ (stage.agent === null ? "" : ` · ${stage.agent}`),
								style: {
									display: "inline-flex", alignItems: "center", gap: "6px",
									padding: "3px 9px", borderRadius: "7px",
									border: `1px solid rgba(${hue},0.35)`, background: `rgba(${hue},0.08)`,
									color: `rgb(${hue})`, fontSize: "12px", lineHeight: "18px"
								},
								children: [
									jsx("span", { children: missionFace(MISSION_STAGE_FACES, stage.stepId, zh) }, "name"),
									duration === "" ? null : jsx("span", { style: { opacity: 0.75 }, children: duration }, "took"),
									stage.attempts > 1 ? jsx("span", {
										style: { opacity: 0.75 },
										children: zh ? `第 ${stage.attempts} 次` : `attempt ${stage.attempts}`
									}, "attempts") : null,
									stage.stalled ? jsx("span", { children: zh ? "停滞" : "stalled" }, "stalled") : null
								]
							}, stage.stepId);
						})
					}, "strip"),
					notes.length === 0 ? null : jsx("div", {
						style: { display: "flex", flexDirection: "column", gap: "4px" },
						children: notes.map((stage) => jsx("div", {
							style: { fontSize: "12px", lineHeight: "18px", color: "var(--dsw-alias-label-secondary)" },
							children: `${missionFace(MISSION_STAGE_FACES, stage.stepId, zh)} · `
								+ missionFace(MISSION_STAGE_STATUS_FACES, stage.status, zh)
								+ ((stage.degradeNote ?? "") === "" ? "" : `：${stage.degradeNote}`)
						}, stage.stepId))
					}, "notes")
				]
			});
		}

		/**
		* Where the tokens went, by stage.
		*
		* `cost.byStage` has been computed, correct and in the /view payload the whole
		* time, and read by nothing: the pane showed six ceilings and a per-agent
		* table, which answer "how close to the wall" and "who spent it" and neither
		* of them "which step ate it".
		*
		* A stage with calls and zero tokens prints 未记账 rather than a zero. That is
		* the true state of the ledger — the call happened and its usage never came
		* back — and a 0 in a spend column reads as free, which is the one thing it is
		* not.
		* @param byStage - `cost.byStage` from the view route.
		* @param zh - whether to write Chinese.
		*/
		function MissionStageSpend({ byStage, zh }) {
			const rows = Array.isArray(byStage) ? byStage : [];
			const peak = rows.reduce((most, row) => Math.max(most, Number(row.tokens) || 0), 0);
			const unbilled = rows.filter((row) => (Number(row.calls) || 0) > 0 && (Number(row.tokens) || 0) === 0);
			return jsxs("div", {
				style: { display: "flex", flexDirection: "column", gap: "8px" },
				children: [
					jsx("div", {
						style: { display: "flex", flexDirection: "column", gap: "7px" },
						children: rows.map((row) => {
							const tokens = Number(row.tokens) || 0;
							const calls = Number(row.calls) || 0;
							const missing = calls > 0 && tokens === 0;
							return jsxs("div", {
								// The raw step id where a raw step id belongs: on the hover, beside
								// the name a person reads. The strip above does the same.
								title: `${row.stepId}${(row.role ?? null) === null ? "" : ` · ${row.role}`}`,
								style: { display: "flex", flexDirection: "column", gap: "3px" },
								children: [
									jsxs("div", {
										style: { display: "flex", alignItems: "baseline", gap: "8px", fontSize: "12px", color: "var(--dsw-alias-label-secondary)" },
										children: [
											jsx("span", { style: { flex: 1, minWidth: 0 }, children: missionFace(MISSION_STAGE_FACES, row.stepId, zh) }, "name"),
											jsx("span", {
												style: { flex: "none", fontFamily: MISSION_MONO, fontVariantNumeric: "tabular-nums", color: missing ? "rgb(217,119,6)" : undefined },
												children: (missing ? (zh ? "未记账" : "not billed") : (zh ? `${missionCompact(tokens)} 令牌` : `${missionCompact(tokens)} tokens`))
													+ (zh ? ` · ${calls} 次调用` : ` · ${calls} calls`)
											}, "spend")
										]
									}, "head"),
									jsx("div", {
										style: { height: "5px", borderRadius: "3px", background: "var(--dsw-alias-border-l1)", overflow: "hidden" },
										children: jsx("div", {
											style: {
												width: peak === 0 ? "0%" : `${Math.max(1, Math.round((tokens / peak) * 100))}%`,
												height: "100%", background: missing ? "rgba(217,119,6,0.45)" : "rgb(2,132,199)"
											}
										})
									}, "bar")
								]
							}, row.stepId);
						})
					}, "rows"),
					unbilled.length === 0 ? null : jsx("div", {
						style: { fontSize: "11px", lineHeight: "17px", color: "rgb(217,119,6)" },
						children: zh
							? "标着未记账的阶段确实调用了模型，只是账本上没有留下令牌数 —— 这不等于没花钱。"
							: "A stage marked not billed did call the model; the ledger simply has no token figure for it. That is not the same as free."
					}, "unbilled")
				]
			});
		}

		/**
		* Which door is slow, and which one is broken.
		*
		* `byStage` and `byAgent` answer where the tokens went; a tool that fails
		* inside a stage that succeeds is invisible in both of them. Latency is printed
		* over the calls that were actually TIMED, and the untimed ones are named:
		* dividing a partial total by every call produces an average that is quietly
		* too low, and 0ms reads as instant about a tool nobody measured.
		* @param byTool - `cost.byTool` from the view route.
		* @param zh - whether to write Chinese.
		*/
		function MissionToolTable({ byTool, zh }) {
			const rows = Array.isArray(byTool) ? byTool : [];
			const head = {
				padding: "6px 9px", textAlign: "left", fontSize: "11px", fontWeight: 600,
				color: "var(--dsw-alias-label-secondary)", whiteSpace: "nowrap"
			};
			const cell = { padding: "6px 9px", fontSize: "12px", lineHeight: "18px", fontFamily: MISSION_MONO };
			const columns = [
				{ id: "tool", label: zh ? "工具" : "Tool", align: "left" },
				{ id: "calls", label: zh ? "调用" : "Calls", align: "right" },
				{ id: "failures", label: zh ? "失败" : "Failed", align: "right" },
				{ id: "rate", label: zh ? "成功率" : "Success", align: "right" },
				{ id: "cached", label: zh ? "缓存" : "Cached", align: "right" },
				{ id: "latency", label: zh ? "平均延迟" : "Mean latency", align: "right" }
			];
			return jsx("div", {
				style: {
					border: "1px solid var(--dsw-alias-border-l2)", borderRadius: "10px",
					overflow: "hidden", background: "var(--dsw-alias-bg-layer-1)"
				},
				children: jsxs("table", {
					style: { width: "100%", borderCollapse: "collapse" },
					children: [
						jsx("thead", {
							children: jsx("tr", {
								style: { background: "var(--dsw-alias-bg-layer-2)", borderBottom: "1px solid var(--dsw-alias-border-l2)" },
								children: columns.map((column) => jsx("th", {
									style: { ...head, textAlign: column.align },
									children: column.label
								}, column.id))
							})
						}, "head"),
						jsx("tbody", {
							children: rows.map((row) => {
								const calls = Number(row.calls) || 0;
								const failures = Number(row.failures) || 0;
								const unmeasured = Number(row.unmeasured) || 0;
								const rate = calls === 0 ? "—" : `${Math.round(((calls - failures) / calls) * 100)}%`;
								const latency = row.avgLatencyMs === null || row.avgLatencyMs === undefined
									? (zh ? "未测量" : "not measured")
									: `${row.avgLatencyMs}ms` + (unmeasured > 0
										? (zh ? ` · ${unmeasured} 次未测量` : ` · ${unmeasured} not measured`)
										: "");
								return jsxs("tr", {
									style: { borderTop: "1px solid var(--dsw-alias-border-l1)" },
									children: [
										jsx("td", { style: { ...cell, color: "var(--dsw-alias-label-primary)" }, children: row.tool ?? "—" }, "tool"),
										jsx("td", { style: { ...cell, textAlign: "right" }, children: String(calls) }, "calls"),
										jsx("td", {
											style: { ...cell, textAlign: "right", color: failures > 0 ? "rgb(220,38,38)" : undefined },
											children: String(failures)
										}, "failures"),
										jsx("td", { style: { ...cell, textAlign: "right" }, children: rate }, "rate"),
										jsx("td", { style: { ...cell, textAlign: "right" }, children: String(Number(row.cached) || 0) }, "cached"),
										jsx("td", {
											style: { ...cell, textAlign: "right", color: unmeasured > 0 ? "rgb(217,119,6)" : undefined },
											children: latency
										}, "latency")
									]
								}, String(row.tool));
							})
						}, "body")
					]
				})
			});
		}

		/**
		* The six ceilings, as bars, with the tight one named.
		*
		* Named rather than summed: a mission that has burned 100% of its arXiv
		* allowance at 20% of its tokens is about to start failing tool calls,
		* and a single blended percentage would say it is fine right up until it
		* stops working.
		* @param cost - `cost` from the view route.
		* @param zh - whether to write Chinese.
		*/
		function MissionCostMeters({ cost, zh }) {
			const order = ["tokens", "calls", "arxiv", "web", "fetch", "wall"];
			const waste = cost.waste ?? {};
			const wasted = [
				waste.stageRetries > 0 ? (zh ? `阶段重试 ${waste.stageRetries} 次` : `${waste.stageRetries} stage retries`) : "",
				waste.chapterRewrites > 0 ? (zh ? `章节重写 ${waste.chapterRewrites} 次` : `${waste.chapterRewrites} chapter rewrites`) : "",
				waste.underDeliveredChapters > 0 ? (zh ? `字数不足的章节 ${waste.underDeliveredChapters} 个` : `${waste.underDeliveredChapters} under-delivered chapters`) : "",
				waste.toolFailures > 0 ? (zh ? `工具调用失败 ${waste.toolFailures} 次` : `${waste.toolFailures} tool-call failures`) : "",
				waste.toolCached > 0 ? (zh ? `命中缓存 ${waste.toolCached} 次` : `${waste.toolCached} cache hits`) : ""
			].filter((piece) => piece !== "").join(" · ");

			return jsxs("div", {
				style: { display: "flex", flexDirection: "column", gap: "10px" },
				children: [
					jsx("div", {
						style: { display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))", gap: "10px" },
						children: order.map((key) => {
							const meter = cost[key] ?? { dimension: key, used: 0, limit: null, ratio: null };
							const ratio = meter.ratio ?? 0;
							// The ladder the Host half froze, passed through on the
							// cost object. Reading a second copy of 0.70 / 0.85 here
							// is how the meter and the degrade steps start disagreeing.
							const ladder = cost.ladder ?? {};
							const hue = ratio >= (ladder.warn ?? 0.9) ? "220,38,38"
								: ratio >= (ladder.soften ?? 0.7) ? "217,119,6"
								: "5,150,105";
							const tight = cost.tight?.dimension === key;
							return jsxs("div", {
								style: { display: "flex", flexDirection: "column", gap: "4px" },
								children: [
									jsxs("div", {
										style: { display: "flex", alignItems: "baseline", gap: "6px", fontSize: "12px", color: "var(--dsw-alias-label-secondary)" },
										children: [
											jsx("span", {
												style: { fontWeight: tight ? 600 : 400, color: tight ? `rgb(${hue})` : "inherit" },
												children: missionFace(MISSION_METER_FACES, key, zh)
											}, "name"),
											!tight ? null : jsx("span", {
												style: { color: `rgb(${hue})` },
												children: zh ? "最紧" : "tightest"
											}, "tight")
										]
									}, "head"),
									jsx("div", {
										style: { height: "6px", borderRadius: "3px", background: "var(--dsw-alias-border-l1)", overflow: "hidden" },
										children: jsx("div", {
											style: {
												width: `${Math.min(100, Math.round(ratio * 100))}%`,
												height: "100%", background: `rgb(${hue})`
											}
										})
									}, "bar"),
									jsx("div", {
										style: { fontSize: "11px", color: "var(--dsw-alias-label-secondary)" },
										children: missionMeterLine(meter, zh)
									}, "line")
								]
							}, key);
						})
					}, "meters"),
					wasted === "" ? null : jsx("div", {
						style: { fontSize: "12px", color: "var(--dsw-alias-label-secondary)" },
						children: (zh ? "其中花在返工上的：" : "Spent on rework: ") + wasted
					}, "waste"),
					// Two quantities, reported as a disagreement rather than
					// reconciled into whichever one is to hand. The exact figure is
					// the ledger; the estimate is what the live pool was steering by.
					cost.drift?.exceeds !== true ? null : jsx("div", {
						style: { fontSize: "12px", color: "rgb(217,119,6)" },
						children: zh
							? `预估用量与实际账本相差 ${Math.round((cost.drift.ratio ?? 0) * 100)}%（预估 ${cost.drift.estimated}，实际 ${cost.drift.exact}），超过 ${Math.round((cost.drift.tolerance ?? 0) * 100)}% 的容差 —— 运行中的预算表是估算，账本才是准的。`
							: `The live estimate and the ledger differ by ${Math.round((cost.drift.ratio ?? 0) * 100)}% (estimated ${cost.drift.estimated}, exact ${cost.drift.exact}), past the ${Math.round((cost.drift.tolerance ?? 0) * 100)}% tolerance. The meter is an estimate; the ledger is the truth.`
					}, "drift")
				]
			});
		}

		/**
		* One dimension: how much verified evidence it found, from how many
		* hosts, and what stopped it.
		*
		* The floor is shown as a fraction rather than as a tick, because
		* `verified` is the only currency the evidence gate spends and "3/4" is
		* the difference between a dimension that nearly made it and one that
		* found nothing.
		*
		* The card OPENS. This is the part that was called unusable: it printed
		* "已核验 6 条 · 1 个独立站点" and there was no way, anywhere, to see one of
		* those six. The counts stay — they are the currency the evidence gate
		* spends — but they have stopped being all there is.
		* @param dimension - one card from the view route.
		* @param zh - whether to write Chinese.
		* @param expanded - whether this card is showing its evidence.
		* @param onToggle - open or close it; omitted, the card does not open.
		* @param children - the evidence list, rendered by the caller when open.
		*/
		function MissionDimensionCard({ dimension, zh, expanded, onToggle, children }) {
			const hue = missionHue(MISSION_DIMENSION_FACES, dimension.state);
			const axes = dimension.gradeAxes ?? {};
			const rows = missionVerifyRows(dimension.counts, zh);
			const chapters = dimension.chapters ?? {};
			// Every finding this dimension recorded, verified or not. The verified
			// count alone would make "0 verified, 9 rate-limited" look like a
			// dimension with nothing behind it to open.
			const recorded = rows.reduce((sum, row) => sum + row.n, 0);

			return jsxs("div", {
				style: {
					display: "flex", flexDirection: "column", gap: "6px", padding: "10px 12px",
					border: "1px solid var(--dsw-alias-border-l1)", borderRadius: "10px"
				},
				children: [
					jsxs(onToggle === undefined ? "div" : "button", {
						type: onToggle === undefined ? undefined : "button",
						onClick: onToggle,
						"aria-expanded": onToggle === undefined ? undefined : expanded === true,
						style: {
							appearance: "none", width: "100%", boxSizing: "border-box",
							display: "flex", alignItems: "center", gap: "8px",
							padding: 0, border: "none", background: "transparent",
							font: "inherit", textAlign: "left",
							cursor: onToggle === undefined ? "default" : "pointer"
						},
						children: [
							onToggle === undefined ? null : jsx("span", {
								style: { flex: "none", width: "10px", color: "var(--dsw-alias-label-secondary)", fontSize: "10px" },
								children: expanded === true ? "▾" : "▸"
							}, "caret"),
							jsx("span", {
								style: { flex: 1, minWidth: 0, fontSize: "13px", fontWeight: 600, color: "var(--dsw-alias-label-primary)" },
								children: dimension.name
							}, "name"),
							onToggle === undefined ? null : jsx("span", {
								style: { flex: "none", fontSize: "11px", color: "var(--dsw-alias-label-secondary)" },
								children: expanded === true
									? (zh ? "收起证据" : "Hide the evidence")
									: (zh ? `看这 ${recorded} 条证据` : `Read the ${recorded} finding(s)`)
							}, "toggle"),
							jsx("span", {
								style: {
									flex: "none", padding: "1px 7px", borderRadius: "5px",
									background: `rgba(${hue},0.12)`, color: `rgb(${hue})`, fontSize: "11px", fontWeight: 600
								},
								children: missionFace(MISSION_DIMENSION_FACES, dimension.state, zh)
							}, "state")
						]
					}, "head"),
					jsx("div", {
						style: { fontSize: "12px", color: "var(--dsw-alias-label-secondary)" },
						children: [
							// `floor: null` means s3 has not measured supply yet. It
							// must not render as 0, or every dimension reads as
							// passing a bar nobody has set.
							dimension.floor === null || dimension.floor === undefined
								? (zh ? `已核验 ${dimension.verified} 条 · 门槛还没算出来` : `${dimension.verified} verified · floor not derived yet`)
								: (zh ? `已核验 ${dimension.verified}/${dimension.floor} 条` : `${dimension.verified}/${dimension.floor} verified`),
							zh ? `${dimension.uniqueHosts} 个独立站点` : `${dimension.uniqueHosts} independent host(s)`,
								chapters.total > 0 ? (zh ? `章节 ${chapters.done}/${chapters.total}` : `chapters ${chapters.done}/${chapters.total}`) : ""
						].filter((piece) => piece !== "").join(" · ")
					}, "counts"),
				// THE NUMBERS THE GRADE WAS COMPUTED FROM, which are not the same as the
				// live counts above them: `gradeAxes` is frozen at the moment s4 judged
				// this dimension, and a re-collection since then moves one and not the
				// other. It is present on every live dimension and was rendered nowhere.
				Object.keys(axes).length === 0 ? null : jsx("div", {
					style: { fontSize: "11px", lineHeight: "17px", color: "var(--dsw-alias-label-tertiary)" },
					children: (zh ? "打分时的数：" : "Graded on: ") + [
						axes.verified === undefined ? "" : (zh ? `已核验 ${axes.verified}` : `${axes.verified} verified`),
						axes.uniqueHosts === undefined ? "" : (zh ? `独立站点 ${axes.uniqueHosts}` : `${axes.uniqueHosts} host(s)`),
						axes.pagesFetched === undefined ? "" : (zh ? `抓到 ${axes.pagesFetched} 页` : `${axes.pagesFetched} page(s) fetched`),
						axes.seedTarget === undefined ? "" : (zh ? `种子目标 ${axes.seedTarget}` : `seed target ${axes.seedTarget}`),
						dimension.grade === null || dimension.grade === undefined ? "" : (zh ? `得分 ${dimension.grade}` : `grade ${dimension.grade}`)
					].filter((piece) => piece !== "").join(" · ")
				}, "axes"),					rows.length === 0 ? null : jsx("div", {
						style: { display: "flex", flexWrap: "wrap", gap: "6px" },
						children: rows.map((row) => jsx("span", {
							style: {
								padding: "1px 7px", borderRadius: "5px",
								border: "1px solid var(--dsw-alias-border-l2)",
								fontSize: "11px", color: "var(--dsw-alias-label-secondary)"
							},
							children: `${row.label} ${row.n}`
						}, row.state))
					}, "states"),
					!dimension.blocked ? null : jsx("div", {
						style: { fontSize: "12px", color: "rgb(217,119,6)" },
						children: zh
							? "这个维度有请求被限流 —— 这是取不到，不是没有。"
							: "Requests under this dimension were rate limited — that is an availability result, not evidence of absence."
					}, "blocked"),
					(dimension.summary ?? "") === "" ? null : jsx("div", {
						style: { fontSize: "12px", lineHeight: "18px", color: "var(--dsw-alias-label-secondary)" },
						// The researcher's own closing note, in the mission's
						// language, verbatim. It is the only sentence that says what
						// this dimension actually ran into.
						children: dimension.summary
					}, "summary"),
					// The evidence itself, when the card is open. Rendered by the
					// caller rather than fetched here, so one component owns which
					// finding is selected and one panel shows it — a card that
					// fetched and displayed its own detail would be a second
					// renderer for the same row.
					expanded !== true ? null : jsx("div", { children }, "findings")
				]
			});
		}

		/**
		* What was tried, for a mission that verified nothing.
		*
		* This panel is the reason the runtime freezes `collectionDiagnostics`
		* into the `evidence:none` event: a mission that ends with zero verified
		* findings is exactly the one whose screen would otherwise be blank, and
		* a blank screen is indistinguishable from a broken feature. Tools
		* called, hosts reached, and every tool call that FAILED with the code the
		* tool door classified it as.
		*
		* It says plainly that search terms are not among them. `mission_tool_calls`
		* stores a hash of the arguments, not the arguments, so listing "queries"
		* here would be a promise the column cannot keep.
		* @param report - `missionNoEvidence`'s answer.
		* @param zh - whether to write Chinese.
		*/
		function MissionTried({ report, zh }) {
			const diagnostics = report.diagnostics ?? null;
			const tools = diagnostics?.tools ?? {};
			const hosts = Array.isArray(diagnostics?.hosts) ? diagnostics.hosts : [];
			const failed = Array.isArray(diagnostics?.queries) ? diagnostics.queries : [];
			const findings = missionVerifyRows(diagnostics?.findings ?? {}, zh);
			const toolRows = Object.entries(tools);

			return jsxs("div", {
				style: { display: "flex", flexDirection: "column", gap: "10px" },
				children: [
					report.why === "" ? null : jsx("div", {
						style: { fontSize: "13px", lineHeight: "20px", color: "var(--dsw-alias-label-primary)" },
						// The evidence gate's own sentence. Reused rather than
						// re-worded: two wordings of one refusal is the same defect
						// as two names for one method.
						children: report.why
					}, "why"),
					diagnostics === null ? jsx("div", {
						style: { fontSize: "12px", lineHeight: "18px", color: "var(--dsw-alias-label-secondary)" },
						children: zh
							? "这次运行没有留下采集诊断，或者它已经滚出了事件尾部。事件是完整存着的：用 /events?since=0 可以从头读。"
							: "No collection diagnostics were recorded for this run, or they have scrolled out of the event tail. The log itself is complete — read it from the beginning with /events?since=0."
					}, "none") : null,
					typeof diagnostics?.unavailable === "string" ? jsx("div", {
						style: { fontSize: "12px", color: "rgb(217,119,6)" },
						children: (zh ? "采集诊断本身失败了：" : "The diagnostics query itself failed: ") + diagnostics.unavailable
					}, "unavailable") : null,
					toolRows.length === 0 ? null : jsxs("div", {
						children: [
							jsx("div", {
								style: { fontSize: "12px", fontWeight: 600, marginBottom: "4px", color: "var(--dsw-alias-label-primary)" },
								children: zh ? "调用过的工具" : "Tools called"
							}, "head"),
							jsx("div", {
								style: { display: "flex", flexWrap: "wrap", gap: "6px" },
								children: toolRows.map(([tool, tally]) => jsx("span", {
									style: {
										padding: "1px 7px", borderRadius: "5px",
										border: "1px solid var(--dsw-alias-border-l2)",
										fontSize: "11px", color: "var(--dsw-alias-label-secondary)"
									},
									children: zh
										? `${tool} 调用 ${tally.calls} 次，成功 ${tally.ok}，失败 ${tally.failed}`
										: `${tool}: ${tally.calls} call(s), ${tally.ok} ok, ${tally.failed} failed`
								}, tool))
							}, "tools")
						]
					}, "toolBlock"),
					hosts.length === 0 ? null : jsx("div", {
						style: { fontSize: "12px", color: "var(--dsw-alias-label-secondary)" },
						children: (zh ? "已核验证据来自这些站点：" : "Verified evidence came from these hosts: ") + hosts.join("、")
					}, "hosts"),
					findings.length === 0 ? null : jsx("div", {
						style: { fontSize: "12px", color: "var(--dsw-alias-label-secondary)" },
						children: (zh ? "写下来的发现按核验结果分：" : "Recorded findings by verify state: ")
							+ findings.map((row) => `${row.label} ${row.n}`).join(" · ")
					}, "findings"),
					failed.length === 0 ? null : jsxs("div", {
						children: [
							jsx("div", {
								style: { fontSize: "12px", fontWeight: 600, marginBottom: "4px", color: "var(--dsw-alias-label-primary)" },
								children: zh ? `失败或被拒绝的工具调用（最近 ${failed.length} 条）` : `Tool calls that failed or were refused (latest ${failed.length})`
							}, "head"),
							jsx("div", {
								style: { display: "flex", flexDirection: "column", gap: "3px" },
								children: failed.map((row, at) => jsx("div", {
									style: { fontSize: "12px", lineHeight: "18px", color: "var(--dsw-alias-label-secondary)" },
									children: `${formatStamp(row.at)} · ${missionFace(MISSION_STAGE_FACES, row.stepId, zh)} · ${row.tool}`
										+ (row.paceKey === null || row.paceKey === undefined ? "" : ` · ${row.paceKey}`)
										+ ` · ${row.errorCode ?? (zh ? "未记录错误码" : "no error code recorded")}`
								}, `${row.tool}-${row.at}-${at}`))
							}, "list"),
							jsx("div", {
								style: { marginTop: "6px", fontSize: "11px", lineHeight: "17px", color: "var(--dsw-alias-label-secondary)" },
								children: zh
									? "工具调用只记了工具名、配额键和参数哈希，没有记检索词本身，所以这里给不出具体搜了什么。"
									: "Tool calls are recorded with the tool, the pace key and a hash of the arguments — not the arguments — so the search terms themselves cannot be listed here."
							}, "caveat")
						]
					}, "failedBlock")
				]
			});
		}

		/**
		* The live tail: what the mission has been doing, newest first.
		*
		* Newest first because this is read while something is running, and the
		* line worth seeing is the one that just landed. The read is bounded and
		* the panel says so, so an absent event is "not in this window" rather
		* than "never happened".
		* @param timeline - `timeline` from the view route.
		* @param zh - whether to write Chinese.
		*/
		function MissionTimeline({ timeline, zh }) {
			const events = Array.isArray(timeline?.events) ? timeline.events : [];
			const shown = events.slice(-60).reverse();
			if (shown.length === 0) {
				return jsx("div", {
					style: { fontSize: "12px", color: "var(--dsw-alias-label-secondary)" },
					children: zh ? "这一段窗口里还没有事件。" : "No events in this window yet."
				});
			}
			return jsx("div", {
				style: { display: "flex", flexDirection: "column", gap: "4px" },
				children: shown.map((event) => {
					const detail = missionEventDetail(event, zh);
					return jsxs("div", {
						style: { display: "flex", gap: "8px", fontSize: "12px", lineHeight: "18px" },
						children: [
							jsx("span", {
								style: { flex: "none", color: "var(--dsw-alias-label-secondary)", fontVariantNumeric: "tabular-nums" },
								children: formatStamp(event.ts)
							}, "at"),
							jsx("span", {
								style: { flex: "none", fontWeight: 600, color: "var(--dsw-alias-label-primary)" },
								children: missionFace(MISSION_EVENT_FACES, event.type, zh)
							}, "type"),
							detail === "" ? null : jsx("span", {
								style: { flex: 1, minWidth: 0, color: "var(--dsw-alias-label-secondary)", wordBreak: "break-word" },
								children: detail
							}, "detail")
						]
					}, String(event.seq));
				})
			});
		}
		//#endregion

		//#region missions trace
		/**
		* 轨迹 — everything the mission did, as one ordered list you can click.
		*
		* This replaces a detail view whose dimension card printed
		* "已核验 6 · 1 个独立站点" and offered no way, anywhere in the product, to
		* see one of those six. The six rows were in `mission_findings` the whole
		* time — claim, verbatim quote, source URL, source host, verify state —
		* so the screen was reporting a count of evidence it refused to display.
		*
		* The shape is the harness's own 轨迹 tab, deliberately: dense one-line
		* rows, a role chip, the name, the arguments, an arrow, the result; click
		* a row and one panel opens beside the list with Summary · Payload ·
		* Result · Timing. Master-detail IN PLACE — the list stays where it is
		* and the frame does not move.
		*
		* Three routes feed it and nothing here recomputes what they compute:
		* `/missions/:id/trace` merges stage transitions, tool calls (with the
		* arguments they were made with), findings and the rest of the event log
		* by timestamp; `/missions/:id/trace/:ref` returns whatever the list had
		* to truncate, whole; `/missions/:id/findings` returns a dimension's
		* evidence. See lib/mission-view.js `buildMissionTrace` for why stage rows
		* come out of the event log rather than out of `mission_stages`.
		*/
		const MISSION_TRACE_TAKE = 120;

		/**
		* How many findings one dimension shows before it says there are more.
		*
		* Bounded because a `deep` mission's dimension can hold hundreds and this
		* list lives inside a card. The route's `hasMore` is printed rather than
		* hidden, so a truncated list reads as truncated instead of complete.
		*/
		const MISSION_FINDINGS_TAKE = 50;

		/**
		* Mono where the text is DATA rather than prose.
		*
		* A tool name, a JSON argument and a source host are things a person
		* compares character by character across rows, and a proportional face
		* makes two nearly-identical queries look identical.
		*/
		const MISSION_MONO = "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace";

		/**
		* The chip at the left of a row, keyed by the Host half's `TRACE_ROLES`.
		*
		* The English labels are capitals because that is what the reference tab
		* prints and because a role is a category marker rather than a sentence.
		* An unknown role falls through `missionFace` to the raw string: a blank
		* chip and a chip for a row with no role look the same, and only one of
		* them is a bug.
		*/
		const MISSION_ROLE_FACES = {
			STAGE: { zh: "阶段", en: "STAGE", hue: "2,132,199" },
			TOOL: { zh: "工具", en: "TOOL", hue: "124,58,237" },
			EVIDENCE: { zh: "证据", en: "EVIDENCE", hue: "5,150,105" },
			GATE: { zh: "闸门", en: "GATE", hue: "217,119,6" },
			SYSTEM: { zh: "系统", en: "SYSTEM", hue: "100,116,139" }
		};

		/**
		* The kind filter. Every id but `""` is a member of the route's
		* `TRACE_KINDS`, because an unknown one is answered with a 400 naming the
		* four — the right answer, and not one worth provoking from a chip.
		*
		* "全部记录" rather than "全部": the mission list has its own 全部 chip and
		* two controls with one label on one screen is how a person presses the
		* wrong one.
		*/
		const MISSION_TRACE_KINDS = [
			{ id: "", zh: "全部记录", en: "All rows", hue: "100,116,139" },
			{ id: "stage", zh: "阶段", en: "Stages", hue: "2,132,199" },
			{ id: "tool", zh: "工具", en: "Tools", hue: "124,58,237" },
			{ id: "finding", zh: "发现", en: "Findings", hue: "5,150,105" },
			{ id: "event", zh: "事件", en: "Events", hue: "217,119,6" }
		];

		/** The four tabs of the detail panel, in the reference's order. */
		const MISSION_TRACE_TABS = [
			{ id: "summary", zh: "摘要", en: "Summary" },
			{ id: "payload", zh: "载荷", en: "Payload" },
			{ id: "result", zh: "结果", en: "Result" },
			{ id: "timing", zh: "计时", en: "Timing" }
		];

		/**
		* The wall clock of one row, to the second.
		*
		* `formatStamp` stops at the minute, which is right for a feed and wrong
		* here: one collect stage fires a dozen tool calls inside a single
		* minute, and a column where all twelve carry the same stamp cannot be
		* used to order them.
		* @param iso - an ISO 8601 instant.
		* @returns `HH:MM:SS`, or "" when there is no instant.
		*/
		function missionClock(iso) {
			const at = Date.parse(iso);
			if (Number.isNaN(at)) return "";
			const when = new Date(at);
			const pad = (value) => String(value).padStart(2, "0");
			return `${pad(when.getHours())}:${pad(when.getMinutes())}:${pad(when.getSeconds())}`;
		}

		/**
		* A tool call's latency, in the unit it was measured in.
		*
		* `missionDuration` rounds to seconds, which turns every sub-second call
		* into "0 秒" — and the whole reason to look at a latency column is to see
		* that one fetch took 40ms and the next took nine seconds.
		* @param ms - milliseconds.
		* @param zh - whether to write Chinese.
		* @returns the duration, or "" when there is no number.
		*/
		function missionLatency(ms, zh) {
			const value = Number(ms);
			if (!Number.isFinite(value) || value < 0) return "";
			if (value < 1000) return `${Math.round(value)}ms`;
			return missionDuration(value, zh);
		}

		/**
		* A row's verdict, in three values rather than two.
		*
		* `ok: null` means nobody checked — a fetch that never returned, a host
		* that rate-limited us, an event type with no registered verdict. Drawing
		* it as a failure reproduces on screen the collapse the verify-state
		* column exists to prevent: "4 requests were refused" and "4 quotes were
		* invented" are the same number in the same place and want opposite
		* responses.
		* @param ok - `true` | `false` | `null` from a trajectory row.
		* @param zh - whether to write Chinese.
		* @returns `{ mark, hue, label }`.
		*/
		function missionOkFace(ok, zh) {
			if (ok === true) return { mark: "✓", hue: "5,150,105", label: zh ? "通过" : "Passed" };
			if (ok === false) return { mark: "✗", hue: "220,38,38", label: zh ? "未通过" : "Failed" };
			return { mark: "·", hue: "100,116,139", label: zh ? "没有判定" : "No verdict was recorded" };
		}

		/**
		* What a row prints as its name.
		*
		* A stage row's title is a step id and an event row's is an event type —
		* both are vocabulary this page already has words for, and printing
		* `s3-collect` beside 采集 everywhere else is two names for one thing. A
		* tool name and a source host are data and are shown exactly as recorded.
		* @param row - one row from `/missions/:id/trace`.
		* @param zh - whether to write Chinese.
		* @returns `{ text, mono }`; `mono` is true when the text is data.
		*/
		function missionRowTitle(row, zh) {
			if (row.kind === "stage") return { text: missionFace(MISSION_STAGE_FACES, row.title, zh), mono: false };
			if (row.kind === "event") return { text: missionFace(MISSION_EVENT_FACES, row.title, zh), mono: false };
			return { text: String(row.title ?? ""), mono: true };
		}

		/**
		* A row's state token, spelled out.
		*
		* Every kind files its state under a different vocabulary — a stage
		* transition, a verify state, an event type, a tool error code — and only
		* the last of those is a string a person can read as it comes.
		* @param row - one row from `/missions/:id/trace`.
		* @param zh - whether to write Chinese.
		* @returns the label, or "" when the row carries no state.
		*/
		function missionRowState(row, zh) {
			const state = String(row?.state ?? "");
			if (state === "") return "";
			if (row.kind === "finding") return missionFace(MISSION_VERIFY_FACES, state, zh);
			if (row.kind === "stage") return missionFace(MISSION_STAGE_STATUS_FACES, state, zh);
			if (row.kind === "event") return missionFace(MISSION_EVENT_FACES, state, zh);
			return state;
		}

		/**
		* A cheap identity for one page of the trajectory.
		*
		* The list is POLLED, and a poll that brought back the same rows must not
		* replace them: a new array is a new render, a new render resets the
		* scroll of the list the reader is halfway down, and a mission that
		* changed nothing for a minute would still twitch every four seconds.
		* Compared on what a reader can see move — how many rows exist, which
		* rows these are, and how far the log has got.
		* @param data - the `data` object from `/missions/:id/trace`.
		* @returns a string that changes exactly when the page does.
		*/
		function missionTraceSignature(data) {
			const rows = Array.isArray(data?.rows) ? data.rows : [];
			return [
				data?.page?.total ?? 0,
				data?.page?.unfiltered ?? 0,
				data?.lastEventSeq ?? 0,
				rows.map((row) => row.ref).join("|")
			].join("~");
		}

		/** The same idea for one page of `/missions/:id/findings`. */
		function missionFindingsSignature(data) {
			const rows = Array.isArray(data?.findings) ? data.findings : [];
			return [data?.counts?.total ?? 0, rows.map((row) => row.id).join("|")].join("~");
		}

		//#region trajectory stylesheet
		/**
		* The trajectory's stylesheet, injected once.
		*
		* WHY A REAL STYLESHEET AND NOT INLINE STYLES: three of the reference
		* tab's design decisions cannot be expressed as a style object at all —
		* the 2px underline under the active detail tab is an `::after`, the row
		* and tab hovers are `:hover`, and the keyboard ring is `:focus-visible`.
		* Emulating those with JavaScript state produced a tab strip that looked
		* like the reference and behaved like a mock.
		*
		* Every value here is READ FROM `packages/client/ui-trajectory`, not
		* invented beside it: 38px rows, a fixed tag slot, a 24px index column, a
		* right-aligned trailing block, a 50px timeline over a 44px label column,
		* and a detail pane of clamp(320px, 38%, 440px). Matching the host app's
		* geometry is the point — a second trajectory with its own proportions
		* reads as a different app bolted on, which is what the first attempt was.
		*/
		const TRACE_STYLE_ID = "dsw-swarm-trace-style";
		const TRACE_CSS = [
			".swt-row{display:flex;align-items:center;box-sizing:border-box;height:38px;padding:0 8px 0 10px;gap:12px;border-radius:8px;border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-3);min-width:0;width:100%;appearance:none;font:inherit;text-align:left;cursor:pointer;color:var(--dsw-alias-label-primary)}",
			".swt-row:hover{background:var(--dsw-alias-interactive-bg-hover)}",
			'.swt-row[aria-pressed="true"]{border-color:transparent;box-shadow:inset 0 0 0 2px var(--dsw-alias-state-business-primary)}',
			".swt-row:focus-visible{outline:1px solid var(--dsw-alias-state-business-primary);outline-offset:-1px}",
			".swt-idx{flex:none;width:24px;font:var(--dsw-font-xs-13);font-variant-numeric:tabular-nums;color:var(--dsw-alias-label-tertiary)}",
			".swt-clock{flex:none;width:58px;font:11px/16px var(--ds-font-family-code,monospace);font-variant-numeric:tabular-nums;color:var(--dsw-alias-label-tertiary)}",
			".swt-tagslot{flex:none;width:64px;display:flex;align-items:center;min-width:0}",
			".swt-tag{display:inline-flex;align-items:center;box-sizing:border-box;height:22px;max-width:100%;padding:0 6px;border-radius:6px;font-size:11px;font-weight:600;line-height:22px;white-space:nowrap}",
			".swt-title{flex:none;width:132px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font:500 12px/16px var(--ds-font-family-code,monospace);color:var(--dsw-alias-label-primary)}",
			".swt-text{flex:2 1 0;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font:var(--dsw-font-xs-13);color:var(--dsw-alias-label-secondary)}",
			".swt-arrow{flex:none;color:var(--dsw-alias-label-caption)}",
			".swt-res{flex:1 1 0;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font:var(--dsw-font-xs-13);color:var(--dsw-alias-label-secondary)}",
			".swt-trail{flex:none;display:flex;align-items:center;justify-content:flex-end;width:72px;min-width:0}",
			".swt-metric{flex:none;width:69px;text-align:right;font:var(--dsw-font-xs-13);font-variant-numeric:tabular-nums;color:var(--dsw-alias-label-tertiary);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}",
			".swt-band{flex:none;border:1px solid var(--dsw-alias-border-l2);border-radius:8px;overflow:hidden;user-select:none;margin-bottom:10px}",
			".swt-plot{display:grid;grid-template-columns:44px minmax(0,1fr);height:50px;overflow:hidden;background:var(--dsw-alias-bg-layer-2)}",
			".swt-lanelabels{position:relative;border-right:1px solid var(--dsw-alias-border-l2);color:var(--dsw-alias-label-caption);font-size:10px;line-height:1}",
			".swt-lanelabels span{position:absolute;right:4px;display:flex;align-items:center;justify-content:flex-end;height:8px}",
			".swt-lanelabels span:nth-child(1){top:7px}",
			".swt-lanelabels span:nth-child(2){top:21px}",
			".swt-lanelabels span:nth-child(3){top:35px}",
			".swt-track{position:relative;overflow:hidden}",
			".swt-span{position:absolute;height:8px;min-width:2px;border-radius:1px;opacity:.85}",
			'.swt-span[data-lane="0"]{top:7px}',
			'.swt-span[data-lane="1"]{top:21px}',
			'.swt-span[data-lane="2"]{top:35px}',
			'.swt-span[data-tone="stage"]{background:var(--dsw-alias-state-business-primary)}',
			'.swt-span[data-tone="finding"]{background:var(--dsw-alias-state-success-primary)}',
			'.swt-span[data-tone="tool"]{background:var(--dsw-alias-state-warn-label);opacity:1}',
			'.swt-span[data-tone="bad"]{background:var(--dsw-alias-state-error-primary);opacity:1}',
			".swt-wrap{display:flex;align-items:stretch;border:1px solid var(--dsw-alias-border-l2);border-radius:10px;overflow:hidden;background:var(--dsw-alias-bg-layer-1)}",
			".swt-list{flex:1 1 0;min-width:0;display:flex;flex-direction:column;gap:2px;padding:8px}",
			".swt-pane{position:relative;display:flex;flex:none;flex-direction:column;width:clamp(300px,32%,392px);min-width:0;min-height:0;border-left:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-1)}",
			".swt-panehead{display:flex;flex:none;align-items:center;justify-content:space-between;box-sizing:border-box;height:42px;padding:0 8px 0 12px;border-bottom:1px solid var(--dsw-alias-border-l2);gap:8px}",
			".swt-panetitle{display:flex;align-items:center;min-width:0;gap:8px;color:var(--dsw-alias-label-primary)}",
			".swt-dot{flex:none;width:5px;height:5px;border-radius:50%;background:var(--dsw-alias-label-secondary)}",
			".swt-panename{flex:none;font:500 12px/16px var(--ds-font-family-code,monospace)}",
			".swt-paneref{min-width:0;overflow:hidden;color:var(--dsw-alias-label-tertiary);font:11px/16px var(--ds-font-family-code,monospace);text-overflow:ellipsis;white-space:nowrap}",
			".swt-close{display:inline-flex;flex:none;align-items:center;justify-content:center;width:28px;height:28px;padding:0;border:0;border-radius:6px;color:var(--dsw-alias-label-secondary);background:transparent;cursor:pointer;font-size:18px;line-height:18px}",
			".swt-close:hover{color:var(--dsw-alias-label-primary);background:var(--dsw-alias-interactive-bg-hover)}",
			".swt-tabs{display:flex;flex:none;box-sizing:border-box;width:100%;height:34px;padding:0 8px;overflow-x:auto;overflow-y:hidden;gap:1px;border-bottom:1px solid var(--dsw-alias-border-l2);white-space:nowrap;scrollbar-width:none}",
			".swt-tabs::-webkit-scrollbar{display:none}",
			".swt-tab{position:relative;flex:none;padding:0 9px;border:0;color:var(--dsw-alias-label-tertiary);background:transparent;cursor:pointer;font:var(--dsw-font-xs-13)}",
			".swt-tab:hover{color:var(--dsw-alias-label-primary);background:var(--dsw-alias-interactive-bg-hover)}",
			'.swt-tab[aria-selected="true"]{color:var(--dsw-alias-state-business-primary)}',
			'.swt-tab[aria-selected="true"]::after{position:absolute;right:9px;bottom:0;left:9px;height:2px;border-radius:1px 1px 0 0;background:var(--dsw-alias-state-business-primary);content:""}',
			".swt-tab:focus-visible,.swt-close:focus-visible{outline:1px solid var(--dsw-alias-state-business-primary);outline-offset:-1px}",
			".swt-panebody{flex:1;min-height:0;overflow-x:hidden;overflow-y:auto;padding-bottom:12px}",
			".swt-kv{margin:0;padding:8px 0;font:var(--dsw-font-xs-13)}",
			".swt-kv>div{display:grid;grid-template-columns:94px minmax(0,1fr);min-height:22px;padding:0 14px;align-items:center;gap:8px}",
			".swt-kv dt{color:var(--dsw-alias-label-tertiary);margin:0}",
			".swt-kv dd{min-width:0;margin:0;overflow:hidden;color:var(--dsw-alias-label-primary);text-overflow:ellipsis;white-space:nowrap}",
			".swt-secthead{margin:0;padding:6px 14px 2px;color:var(--dsw-alias-label-secondary);font-size:13px;font-weight:600;user-select:none}",
			".swt-code{margin:0 14px;padding:8px 10px;border-radius:6px;overflow:auto;max-height:340px;color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-layer-2);font:11px/17px var(--ds-font-family-code,monospace);white-space:pre-wrap;word-break:break-word}",
			".swt-scrim{position:fixed;inset:0;z-index:40;display:flex;justify-content:flex-end;background:rgba(0,0,0,0.30);backdrop-filter:blur(2px)}",
			".swt-drawer{display:flex;height:100%;width:100%;max-width:672px;flex-direction:column;overflow:hidden;border-left:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-2);box-shadow:-10px 0 34px rgba(0,0,0,0.20)}",
			".swt-drawer .swt-pane{width:100%;max-width:none;border-left:0;height:100%}",
			".swt-quote{margin:0 14px;padding:10px 12px;border-radius:6px;border-left:2px solid var(--dsw-alias-state-success-primary);background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary);font:var(--dsw-font-xs-13);line-height:19px;white-space:pre-wrap;word-break:break-word}"
		].join("\n");

		/**
		* Put the stylesheet in the document, at most once.
		*
		* Guarded rather than assumed: this module is executed in Node by
		* tests/settings.test.mjs against a hand-written `document` stub, and a
		* bundle that throws at load time there is a bundle nobody can test.
		*/
		function ensureTraceStyle() {
			try {
				if (typeof document?.getElementById !== "function") return;
				if (document.getElementById(TRACE_STYLE_ID) !== null) return;
				const node = document.createElement("style");
				node.id = TRACE_STYLE_ID;
				node.textContent = TRACE_CSS;
				const host = document.head ?? document.documentElement;
				if (typeof host?.appendChild === "function") host.appendChild(node);
			} catch {
				// A host that will not take a stylesheet still gets a working
				// trajectory: every rule above is presentation, and the geometry
				// it carries degrades to the browser's own box model rather than
				// to a blank screen.
			}
		}
		//#endregion
		/**
		* The eight columns of one trajectory row, in the reference tab's geometry.
		*
		* 38px tall, and the columns are FIXED rather than content-sized: an index,
		* a clock, a 64px tag slot, the name, the arguments, an arrow, the result,
		* and a right-aligned trailing block. Fixed columns are what make a hundred
		* rows scannable — a tag that grows with its longest word puts every name
		* on the page at a different x, and the eye has to read each one to find
		* the next.
		*
		* Everything visual lives in `.swt-*` in TRACE_CSS, so the hover, the
		* selected ring and the focus ring exist at all. They cannot be expressed
		* as inline style objects, and the first draft simply did without them.
		* @param row - one row from `/missions/:id/trace`.
		* @param zh - whether to write Chinese.
		* @param active - whether this row is the one open in the panel.
		* @param onOpen - called with the row's `ref`.
		*/
		function MissionTraceRow({ row, zh, active, onOpen }) {
			const face = missionTagFace(row);
			const name = missionRowTitle(row, zh);
			const verdict = missionOkFace(row.ok, zh);
			const took = row.kind === "tool" ? missionLatency(row.ms, zh) : missionDuration(row.ms, zh);
			return jsxs("button", {
				type: "button",
				className: "swt-row",
				onClick: () => { onOpen(row.ref); },
				// The raw identifiers, on hover. `s3-collect` and `mission:started`
				// are the strings the search box matches and the strings a log grep
				// uses, so they stay reachable even though the row prints the words.
				title: `${row.ref} · ${row.title}${row.agentId === null || row.agentId === undefined ? "" : ` · ${row.agentId}`}`,
				"aria-pressed": active,
				children: [
					jsx("span", { className: "swt-idx", children: String(row.seq) }, "seq"),
					jsx("span", { className: "swt-clock", children: missionClock(row.at) }, "at"),
					jsx("span", {
						className: "swt-tagslot",
						children: jsx("span", {
							className: "swt-tag",
							style: { color: face.fg, background: face.bg },
							children: missionFace(MISSION_ROLE_FACES, row.role, zh)
						}, "tag")
					}, "role"),
					jsx("span", {
						className: "swt-title",
						style: name.mono ? undefined : { fontFamily: "inherit", fontWeight: 600 },
						children: name.text
					}, "title"),
					jsx("span", { className: "swt-text", children: row.detail }, "detail"),
					jsx("span", { className: "swt-arrow", children: "→" }, "arrow"),
					jsx("span", {
						// The verdict is CARRIED BY the result rather than repeated
						// beside it. A separate 通过/未通过 column said the same thing
						// twice and cost 81px of the arguments column, which is the
						// column that answers "why did that search find nothing".
						className: "swt-res",
						title: `${verdict.mark} ${verdict.label}`,
						style: row.ok === false
							? { color: "var(--dsw-alias-state-error-primary)" }
							: row.ok === true ? { color: "var(--dsw-alias-state-success-primary)" } : undefined,
						children: row.result
					}, "result"),
					jsx("span", {
						className: "swt-trail",
						children: jsx("span", { className: "swt-metric", children: took }, "took")
					}, "trail")
				]
			});
		}

		/**
		* The two colours of one row's tag, from the host app's own state tokens.
		*
		* Not a hue triple: the reference tab draws every tag as a token pair, and
		* a plugin that mixes its own rgb() beside them is the plugin that looks
		* almost right in light mode and wrong in dark. Tokens follow the theme;
		* literals do not.
		* @param row - one trajectory row.
		*/
		function missionTagFace(row) {
			if (row.ok === false) {
				return { fg: "var(--dsw-alias-state-error-primary)", bg: "var(--dsw-alias-state-error-tertiary, rgba(220,38,38,0.12))" };
			}
			if (row.kind === "tool") {
				return { fg: "var(--dsw-alias-state-warn-label)", bg: "var(--dsw-alias-state-warn-tertiary)" };
			}
			if (row.kind === "finding") {
				return { fg: "var(--dsw-alias-state-success-primary)", bg: "var(--dsw-alias-state-success-tertiary)" };
			}
			if (row.kind === "stage") {
				return { fg: "var(--dsw-alias-state-business-primary)", bg: "var(--dsw-alias-state-business-tertiary)" };
			}
			return { fg: "var(--dsw-alias-label-secondary)", bg: "var(--dsw-alias-bg-module-platform)" };
		}

		/**
		* One trajectory row, whole: Summary · Payload · Result · Timing.
		*
		* Fetched by `ref` rather than by position. `seq` is a place in a snapshot
		* assembled from bounded windows over three tables, so a mission that
		* wrote fifty events between the list request and the click has moved
		* every position by fifty — and a panel that reopened onto the wrong row
		* is the most expensive kind of wrong, because it is plausible.
		*
		* The same component serves the trajectory list and a dimension's
		* findings, which is what makes "the same detail panel" true rather than a
		* resemblance between two renderers that will drift.
		* @param missionId - the mission.
		* @param traceRef - the row's `ref`.
		* @param zh - whether to write Chinese.
		* @param onClose - close the panel.
		* @param onOpenSource - open a finding's page in the reader.
		*/
		function MissionTraceDetail({ missionId, traceRef, zh, onClose, onOpenSource }) {
			const [tab, setTab] = useState("summary");
			const [held, setHeld] = useState(null);
			const [error, setError] = useState("");

			useEffect(() => {
				let alive = true;
				fetch(`${apiBase()}/missions/${encodeURIComponent(missionId)}/trace/${encodeURIComponent(traceRef)}`)
					.then(missionData)
					.then((data) => {
						if (!alive) return;
						// Kept as `{ref, data}` and replaced only when the ref moved.
						// The list around this panel polls; without the guard every
						// poll would hand back an equal-but-new object and re-render
						// the panel under the reader.
						setHeld((previous) => (previous !== null && previous.ref === traceRef ? previous : { ref: traceRef, data }));
						setError("");
					})
					.catch((cause) => {
						if (!alive) return;
						setError(String(cause?.message ?? cause));
					});
				return () => { alive = false; };
			}, [missionId, traceRef]);

			// 42px, the reference tab's header: a dot, the row's own name in the
			// code face, the ref beside it in a lighter one, and a ✕. The ref is
			// the identity a reader can quote back, so it is on screen rather
			// than in a tooltip.
			const head = jsxs("div", {
				className: "swt-panehead",
				children: [
					jsxs("span", {
						className: "swt-panetitle",
						children: [
							jsx("span", { className: "swt-dot" }, "dot"),
							jsx("span", { className: "swt-panename", children: String(traceRef).split(":")[0] }, "kind"),
							jsx("span", { className: "swt-paneref", children: traceRef }, "ref")
						]
					}, "title"),
					jsx("button", {
						type: "button",
						className: "swt-close",
						"aria-label": zh ? "关闭" : "Close",
						onClick: onClose,
						children: "\u00d7"
					}, "close")
				]
			}, "head");

			// Header, tab strip, scrolling body — three fixed rows, the middle one
			// 34px with a 2px underline under the active tab. `tabs` is false on
			// the loading and error paths: a tab strip over a panel that has
			// nothing to show is four controls that do nothing.
			const shell = (body, tabs) => jsxs("div", {
				className: "swt-pane",
				children: [
					head,
					tabs !== true ? null : jsx("div", {
						className: "swt-tabs",
						role: "tablist",
						children: MISSION_TRACE_TABS.map((entry) => jsx("button", {
							type: "button",
							role: "tab",
							className: "swt-tab",
							"aria-selected": entry.id === tab,
							onClick: () => { setTab(entry.id); },
							children: zh ? entry.zh : entry.en
						}, entry.id))
					}, "tabs"),
					jsx("div", { className: "swt-panebody", children: body }, "body")
				]
			});

			if (held === null || held.ref !== traceRef) {
				return shell(jsx("div", {
					style: { fontSize: "12px", lineHeight: "18px", color: error === "" ? "var(--dsw-alias-label-secondary)" : "rgb(217,119,6)" },
					children: error === ""
						? (zh ? "读取中…" : "Loading…")
						// The 404 this route answers names the WINDOW, not just the
						// absence: a row that scrolled out of the bounded read and a
						// row that never existed want different reactions. Shown as
						// it came rather than reduced to "not found".
						: (zh ? "读不到这一行：" : "Could not read this row: ") + error
				}, "state"));
			}

			const detail = held.data;
			const row = detail.row ?? {};
			const verdict = missionOkFace(detail.ok, zh);
			// One row of the 94px key column. A grid rather than a flex pair so
			// every value in the panel starts at the same x — the whole reason
			// the reference reads as a specification sheet and the first draft
			// read as a paragraph with bold words in it.
			const line = (label, value) => (value === "" || value === null || value === undefined ? null : jsxs("div", {
				children: [
					jsx("dt", { children: label }, "k"),
					jsx("dd", { title: String(value), children: String(value) }, "v")
				]
			}, label));

			const block = (text) => jsx("pre", { className: "swt-code", children: missionColourJson(text) });

			// A finding is the row this whole rebuild exists for, so its summary is
			// not the generic key/value list: the claim, the WHOLE quote, the source
			// with a way to open it, and the verify state in words rather than as
			// the enum a person would otherwise have to go and look up.
			const finding = detail.kind === "finding" ? (detail.payload ?? {}) : null;
			const openable = finding !== null && typeof finding.sourceUrl === "string" && finding.sourceUrl !== "";

			const summary = jsxs("dl", {
				className: "swt-kv",
				children: [
					finding === null ? null : jsx("div", {
						style: {
							padding: "10px 14px 6px", fontSize: "13px", lineHeight: "20px",
							fontWeight: 600, color: "var(--dsw-alias-label-primary)"
						},
						children: finding.claim
					}, "claim"),
					finding === null ? null : jsx("div", {
						className: "swt-quote",
						// Verbatim and whole. The list clips it and this is the only
						// place it can be read, which is the point of the panel.
						children: `“${finding.quote}”`
					}, "quote"),
					finding === null ? null : jsxs("div", {
						style: { display: "flex", alignItems: "center", gap: "10px", flexWrap: "wrap", margin: "0 0 6px", fontSize: "11px" },
						children: [
							!openable ? jsx("span", {
								style: { color: "var(--dsw-alias-label-secondary)" },
								children: zh ? "这条发现没有带回可打开的地址" : "no openable address travelled with this finding"
							}, "noUrl") : jsx("button", {
								type: "button",
								onClick: () => { onOpenSource?.(finding); },
								style: {
									appearance: "none", border: "none", background: "transparent", padding: 0,
									color: `rgb(${verdict.hue})`, font: "inherit", fontSize: "11px", cursor: "pointer"
								},
								// 信源's own reader: the Host half re-fetches the page
								// and extracts it, which is the only thing that can
								// answer "does that page still say this".
								children: (zh ? "在阅读器里打开 · " : "Open in the reader · ")
									+ ((finding.sourceHost ?? "") === "" ? hostOf(finding.sourceUrl) : finding.sourceHost)
							}, "open"),
							!openable ? null : jsx("a", {
								href: finding.sourceUrl, target: "_blank", rel: "noreferrer noopener",
								style: { color: "var(--dsw-alias-label-secondary)", textDecoration: "none" },
								children: zh ? "原始链接" : "Original link"
							}, "raw")
						]
					}, "source"),
					line(zh ? "结果" : "Verdict", `${verdict.mark} ${verdict.label}`),
					line(zh ? "状态" : "State", missionRowState(row, zh)),
					finding === null ? null : line(zh ? "计入证据" : "Counts as evidence", finding.counts === true
						? (zh ? "是 —— 越过了证据边界" : "yes — it crosses the evidence boundary")
						: (zh ? "否" : "no")),
					finding === null || finding.verifyReason === null || finding.verifyReason === undefined
						? null : line(zh ? "核验说明" : "Verifier", finding.verifyReason),
					finding === null ? null : line(zh ? "出处" : "Source",
						[finding.sourceTitle ?? "", finding.sourceHost ?? "", finding.sourceUrl ?? ""].filter((piece) => piece !== "" && piece !== null).join(" · ")),
					line(zh ? "类别" : "Kind", `${detail.kind} · ${missionFace(MISSION_ROLE_FACES, detail.role, zh)}`),
					line(zh ? "时刻" : "At", `${formatStamp(detail.at)} ${missionClock(detail.at)}`),
					detail.stepId === null || detail.stepId === undefined ? null
						: line(zh ? "阶段" : "Stage", `${missionFace(MISSION_STAGE_FACES, detail.stepId, zh)} (${detail.stepId})`),
					detail.agentId === null || detail.agentId === undefined ? null : line(zh ? "执行者" : "Agent", detail.agentId),
					detail.dimension === null || detail.dimension === undefined ? null : line(zh ? "维度" : "Dimension",
						`${detail.dimension.name} · ${missionFace(MISSION_DIMENSION_FACES, detail.dimension.state, zh)} · `
						+ (zh
							? `已核验 ${detail.dimension.verified}/${detail.dimension.total} 条，来自 ${detail.dimension.uniqueHosts} 个站点`
							: `${detail.dimension.verified}/${detail.dimension.total} verified from ${detail.dimension.uniqueHosts} host(s)`)),
					detail.stage === null || detail.stage === undefined ? null : line(zh ? "阶段记录" : "Stage row",
						`${missionFace(MISSION_STAGE_STATUS_FACES, detail.stage.status, zh)} · `
						+ (zh ? `第 ${detail.stage.attempts} 次尝试` : `attempt ${detail.stage.attempts}`)
						+ (detail.stage.durationMs === null || detail.stage.durationMs === undefined ? "" : ` · ${missionDuration(detail.stage.durationMs, zh)}`)),
					(detail.stage?.degradeNote ?? "") === "" ? null : jsx("div", {
						style: { marginTop: "4px", fontSize: "12px", lineHeight: "18px", color: "rgb(217,119,6)" },
						children: detail.stage.degradeNote
					}, "degrade"),
					// A position, said to be a position. The trajectory is assembled
					// from bounded windows over three tables, so `seq` slides when the
					// oldest end falls off; the `ref` above is what survives.
					jsx("div", {
						style: { marginTop: "6px", fontSize: "11px", lineHeight: "17px", color: "var(--dsw-alias-label-secondary)" },
						children: zh
							? `第 ${detail.seq} 行 —— 这是当前这份快照里的位置，不是身份；身份是上面那个 ref。`
							: `Row ${detail.seq} — a position in this snapshot, not an identity. The identity is the ref above.`
					}, "seqNote")
				]
			});

			const result = detail.result ?? {};
			const timing = detail.timing ?? {};

			return shell(jsxs("div", {
				style: { display: "flex", flexDirection: "column", gap: "8px" },
				children: [
					tab !== "summary" ? null : summary,
					tab !== "payload" ? null : jsxs("div", {
						style: { display: "flex", flexDirection: "column", gap: "6px" },
						children: [
							block(JSON.stringify(detail.payload ?? null, null, 2)),
							detail.kind !== "tool" ? null : jsx("div", {
								style: { fontSize: "11px", lineHeight: "17px", color: "var(--dsw-alias-label-secondary)" },
								// The cap is the COLUMN's, not this panel's. Saying which
								// layer cut the string is the difference between a reader
								// who goes looking for the rest and one who knows there
								// is no rest to find.
								children: zh
									? `参数在写入时就截到 ${detail.payload?.argsTextStoredCap ?? 300} 个字符 —— 上面已经是存下来的全部。`
									: `Arguments are capped at ${detail.payload?.argsTextStoredCap ?? 300} characters when the call is recorded; the above is everything that was stored.`
							}, "cap")
						]
					}, "payloadTab"),
					tab !== "result" ? null : jsxs("div", {
						style: { display: "flex", flexDirection: "column", gap: "6px" },
						children: [
							result.text === null || result.text === undefined || result.text === ""
								? jsx("div", {
									style: { fontSize: "12px", color: "var(--dsw-alias-label-secondary)" },
									children: zh ? "这一行没有留下结果文本。" : "This row recorded no result text."
								}, "empty")
								: block(result.text),
							result.note === null || result.note === undefined || result.note === "" ? null : jsx("div", {
								style: { fontSize: "11px", lineHeight: "17px", color: "var(--dsw-alias-label-secondary)" },
								// The route's own sentence about what the column does and
								// does not hold. Re-worded here it would become a second
								// answer to the same question.
								children: result.note
							}, "note")
						]
					}, "resultTab"),
					tab !== "timing" ? null : jsxs("div", {
						style: { display: "flex", flexDirection: "column", gap: "4px" },
						children: [
							line(zh ? "记录于" : "Recorded", timing.at === null || timing.at === undefined ? "" : `${formatStamp(timing.at)} ${missionClock(timing.at)}`),
							line(zh ? "开始" : "Started", timing.startedAt === null || timing.startedAt === undefined ? "" : `${formatStamp(timing.startedAt)} ${missionClock(timing.startedAt)}`),
							line(zh ? "结束" : "Ended", timing.endedAt === null || timing.endedAt === undefined ? "" : `${formatStamp(timing.endedAt)} ${missionClock(timing.endedAt)}`),
							line(zh ? "用时" : "Duration", detail.kind === "tool" ? missionLatency(timing.ms, zh) : missionDuration(timing.ms, zh)),
							timing.source === null || timing.source === undefined || timing.source === "" ? null : jsx("div", {
								style: { marginTop: "4px", fontSize: "11px", lineHeight: "17px", color: "var(--dsw-alias-label-secondary)" },
								// WHERE the number came from. A tool call's start is
								// computed — the row is written when the call returns —
								// and a derived instant presented as a recorded one is a
								// measurement nobody promised.
								children: (zh ? "这些数字的来源：" : "Where these came from: ") + timing.source
							}, "source")
						]
					}, "timingTab")
				]
			}), true);
		}

		/**
		* Colour a JSON payload: keys, strings, numbers.
		*
		* Returns an array of spans rather than HTML, because the panel renders
		* through the runtime's `jsx` and never touches innerHTML — a payload is
		* text a remote page put in front of us, and the one place it must not be
		* able to become markup is the panel that exists to show it safely.
		*
		* Not a parser. It tokenizes the string form, so a result that is NOT
		* JSON — a plain sentence, an error message — comes back as one plain
		* span rather than as a failure.
		* @param text - the payload, already stringified.
		*/
		function missionColourJson(text) {
			const source = typeof text === "string" ? text : String(text ?? "");
			if (source === "") return source;
			// Cheap guard: anything that does not look like JSON stays plain, and
			// so does anything long enough that colouring it would cost more than
			// reading it.
			const head = source.trimStart().charAt(0);
			if ((head !== "{" && head !== "[") || source.length > 20000) return source;
			const out = [];
			const pattern = /("(?:[^"\\]|\\.)*")(\s*:)?|(-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)|(\btrue\b|\bfalse\b|\bnull\b)/g;
			let at = 0;
			let key = 0;
			let match = pattern.exec(source);
			while (match !== null) {
				if (match.index > at) out.push(source.slice(at, match.index));
				if (match[1] !== undefined) {
					// A string followed by a colon is a key; the colon is punctuation
					// and stays uncoloured, which is what makes the key column read.
					out.push(jsx("span", { className: match[2] === undefined ? "s" : "k", children: match[1] }, `t${key}`));
					key += 1;
					if (match[2] !== undefined) out.push(match[2]);
				} else if (match[3] !== undefined) {
					out.push(jsx("span", { className: "n", children: match[3] }, `t${key}`));
					key += 1;
				} else {
					out.push(jsx("span", { className: "n", children: match[4] }, `t${key}`));
					key += 1;
				}
				at = match.index + match[0].length;
				match = pattern.exec(source);
			}
			if (at < source.length) out.push(source.slice(at));
			return out;
		}

		/**
		* The three-lane band over the trajectory: 阶段 · 工具 · 证据.
		*
		* WHAT IT ANSWERS that no list can: where the time went. A mission that
		* spent forty of its forty-three collection seconds inside one fetch is
		* indistinguishable, row by row, from one that spread them evenly — and
		* the two have completely different problems.
		*
		* The domain is the mission's own span, from the first row to the last,
		* NOT wall-clock now: a finished mission whose band kept stretching would
		* squash its own history into the left edge as the page sat open.
		*
		* Rows with no duration still get a mark. A tool call that took 3ms and a
		* finding that took no time at all are events, and a band that only draws
		* what lasted is a band with holes exactly where the fast things happened.
		* @param rows - the trajectory rows currently loaded.
		* @param zh - whether to write Chinese.
		*/
		function MissionTraceBand({ rows, zh }) {
			const points = [];
			for (const row of rows) {
				const at = Date.parse(row.at);
				if (!Number.isFinite(at)) continue;
				const ms = Number.isFinite(row.ms) && row.ms > 0 ? row.ms : 0;
				const lane = row.kind === "stage" ? 0 : row.kind === "finding" ? 2 : 1;
				const tone = row.ok === false ? "bad" : row.kind === "stage" ? "stage" : row.kind === "finding" ? "finding" : "tool";
				points.push({ at, ms, lane, tone, title: `${row.title} · ${missionClock(row.at)}` });
			}
			if (points.length === 0) return null;
			let first = points[0].at;
			let last = points[0].at;
			for (const point of points) {
				if (point.at < first) first = point.at;
				if (point.at + point.ms > last) last = point.at + point.ms;
			}
			// A mission whose rows all share one timestamp has no span to divide
			// by. One second is an arbitrary denominator, said to be arbitrary:
			// every mark then lands at the left edge, which is true.
			const span = Math.max(1, last - first);
			return jsx("div", {
				className: "swt-band",
				children: jsxs("div", {
					className: "swt-plot",
					children: [
						jsxs("div", {
							className: "swt-lanelabels",
							children: [
								jsx("span", { children: zh ? "阶段" : "Stages" }, "l0"),
								jsx("span", { children: zh ? "工具" : "Tools" }, "l1"),
								jsx("span", { children: zh ? "证据" : "Evidence" }, "l2")
							]
						}, "labels"),
						jsx("div", {
							className: "swt-track",
							children: points.map((point, at) => jsx("span", {
								className: "swt-span",
								"data-lane": String(point.lane),
								"data-tone": point.tone,
								title: point.title,
								style: {
									left: `${((point.at - first) / span) * 100}%`,
									width: `${Math.max(0.25, (point.ms / span) * 100)}%`
								}
							}, `p${at}`))
						}, "track")
					]
				}, "plot")
			});
		}
		/**
		* The trajectory: filters, the dense list, and the panel beside it.
		*
		* Polls while the mission is live. When a row is open the poll's answer is
		* HELD rather than applied — a list that reflows under a reader who has
		* just clicked something is the failure this panel exists to avoid — and
		* the fact that there is something newer is said out loud, with a control
		* that applies it.
		* @param missionId - the mission.
		* @param zh - whether to write Chinese.
		* @param live - whether the mission is still running, which is what polls.
		* @param timeline - `timeline` from the view route, used only as a fallback.
		* @param onOpenSource - open a finding's page in the reader.
		*/
		function MissionTrace({ missionId, zh, live, timeline, onOpenSource, focusStep }) {
			// The stylesheet, before the first row is built. Idempotent, so the
			// poll and every re-render after it cost one `getElementById`.
			ensureTraceStyle();
			const [kind, setKind] = useState("");
			// Seeded from the task board: clicking 看轨迹 on a stage opens this
			// list already filtered to it. A jump that lands on 169 unfiltered
			// rows is a jump that has not answered the question it was asked.
			const [stepId, setStepId] = useState(focusStep ?? "");
			const [dimensionId, setDimensionId] = useState("");
			// WHO DID IT. `role` is a provenance chip — STAGE, TOOL, EVIDENCE, GATE,
			// SYSTEM — nearly the same axis as `kind`, so "show me only what the
			// Leader did" had no control at all until this one.
			const [agentId, setAgentId] = useState("");
			const [search, setSearch] = useState("");
			const [order, setOrder] = useState("newest");
			const [selected, setSelected] = useState(null);
			const [page, setPage] = useState(null);
			const [fresh, setFresh] = useState(null);
			const [error, setError] = useState("");
			const [tick, setTick] = useState(0);
			// The signature of the page the list is currently drawing. Held in a
			// ref rather than read back from `page`, because the effect below
			// closes over the state it was created with: the moment the reader
			// presses "load them", `page` inside the not-yet-recreated effect is
			// still the page BEFORE the load, and the next poll would offer the
			// very rows just loaded as though they were new.
			const applied = useRef("");

			const query = new URLSearchParams();
			query.set("take", String(MISSION_TRACE_TAKE));
			query.set("order", order);
			if (kind !== "") query.set("kind", kind);
			if (stepId !== "") query.set("stepId", stepId);
			if (dimensionId !== "") query.set("dimensionId", dimensionId);
			if (agentId !== "") query.set("agentId", agentId);
			// Sent to the route rather than filtered here, and sent per keystroke
			// rather than debounced: the route searches the WHOLE trajectory while
			// this page holds a window of it, so a local filter would answer
			// "nothing matches" for a row that is one page away. The read is a
			// bounded merge over three already-open tables on the same machine, and
			// a stale answer is dropped by the `alive` guard below.
			if (search !== "") query.set("search", search);
			const address = `${apiBase()}/missions/${encodeURIComponent(missionId)}/trace?${query.toString()}`;

			useEffect(() => {
				let alive = true;
				fetch(address)
					.then(missionData)
					.then((data) => {
						if (!alive) return;
						setError("");
						const signature = missionTraceSignature(data);
						if (selected === null) {
							applied.current = signature;
							setPage((previous) => (previous !== null && previous.signature === signature ? previous : { signature, data }));
							setFresh(null);
							return;
						}
						// A row is open. Hold the newer page rather than swapping the
						// list out from under the click that opened it — but only when
						// it IS newer, or the panel would sit behind a control offering
						// rows the list is already showing.
						if (applied.current === signature) {
							setFresh(null);
							return;
						}
						setFresh((previous) => (previous !== null && previous.signature === signature ? previous : { signature, data }));
					})
					.catch((cause) => {
						if (!alive) return;
						setError(String(cause?.message ?? cause));
					});
				return () => { alive = false; };
			}, [address, selected, tick]);

			// Closing the panel is consent to move the list, so a held page goes in
			// by itself rather than leaving a stale list behind a dead button.
			useEffect(() => {
				if (selected !== null || fresh === null) return;
				applied.current = fresh.signature;
				setPage(fresh);
				setFresh(null);
			}, [selected, fresh]);

			// Unref'd for the reason the other two timers are: this module is
			// rendered in Node by tests/settings.test.mjs, which never unmounts.
			useEffect(() => {
				if (!live) return;
				const timer = setTimeout(() => { setTick((value) => value + 1); }, MISSION_POLL_MS);
				timer.unref?.();
				return () => { clearTimeout(timer); };
			}, [live, tick]);

			const data = page?.data ?? null;
			const rows = Array.isArray(data?.rows) ? data.rows : [];
			const stages = Array.isArray(data?.stages) ? data.stages : [];
			const dimensions = Array.isArray(data?.dimensions) ? data.dimensions : [];
			// MEASURED, NOT PLANNED. `data.dimensions` is s2's plan: on a real mission
			// it offers five options of which three can ever match, because 158 of 169
			// rows carry no dimension at all — and nothing on the screen said which
			// two were dead. `vocabulary.dimensions` is derived from the rows
			// themselves and carries the count, so an option that matches one row says
			// so before it is chosen.
			const vocabulary = data?.vocabulary ?? {};
			const dimensionOptions = Array.isArray(vocabulary.dimensions)
				? vocabulary.dimensions
				: dimensions.map((entry) => ({ dimensionId: entry.dimensionId, name: entry.name, rows: null }));
			const agentOptions = Array.isArray(vocabulary.agents) ? vocabulary.agents : [];
			const paging = data?.page ?? {};
			const bounds = data?.window ?? {};
			const saturated = ["events", "toolCalls", "findings"].filter((stream) => bounds[stream]?.saturated === true);
			const gained = Math.max(0, Number(fresh?.data?.page?.total ?? 0) - Number(paging.total ?? 0));

			const selectStyle = {
				appearance: "none", height: "28px", padding: "0 8px", borderRadius: "8px",
				border: "1px solid var(--dsw-alias-border-l2)", background: "transparent",
				color: "var(--dsw-alias-label-secondary)", font: "inherit", fontSize: "12px", cursor: "pointer"
			};

			const filters = jsxs("div", {
				style: { display: "flex", alignItems: "center", gap: "6px", flexWrap: "wrap", marginBottom: "8px" },
				children: [
					...MISSION_TRACE_KINDS.map((entry) => jsx("button", {
						type: "button",
						role: "tab",
						"aria-selected": entry.id === kind,
						style: { ...chipStyle(entry, entry.id === kind), height: "28px", padding: "0 10px", fontSize: "12px" },
						onClick: () => { setKind(entry.id); },
						children: zh ? entry.zh : entry.en
					}, entry.id === "" ? "all" : entry.id)),
					jsx("select", {
						value: stepId,
						"aria-label": zh ? "按阶段筛选" : "Filter by stage",
						style: selectStyle,
						onChange: (event) => { setStepId(event.target.value); },
						children: [
							jsx("option", { value: "", children: zh ? "所有阶段" : "Every stage" }, "any"),
							...stages.map((stage) => jsx("option", {
								value: stage.stepId,
								children: `${missionFace(MISSION_STAGE_FACES, stage.stepId, zh)} · ${missionFace(MISSION_STAGE_STATUS_FACES, stage.status, zh)}`
							}, stage.stepId))
						]
					}, "stage"),
					jsx("select", {
						value: dimensionId,
						"aria-label": zh ? "按维度筛选" : "Filter by dimension",
						style: selectStyle,
						onChange: (event) => { setDimensionId(event.target.value); },
						children: [
							jsx("option", { value: "", children: zh ? "所有维度" : "Every dimension" }, "any"),
							...dimensionOptions.map((dimension) => jsx("option", {
								value: dimension.dimensionId,
								children: (dimension.name ?? dimension.dimensionId)
									+ (typeof dimension.rows === "number" ? (zh ? ` · ${dimension.rows} 条` : ` · ${dimension.rows}`) : "")
							}, dimension.dimensionId))
						]
					}, "dimension"),
					agentOptions.length === 0 ? null : jsx("select", {
						value: agentId,
						"aria-label": zh ? "按执行者筛选" : "Filter by agent",
						style: selectStyle,
						onChange: (event) => { setAgentId(event.target.value); },
						children: [
							jsx("option", { value: "", children: zh ? "所有执行者" : "Every agent" }, "any"),
							...agentOptions.map((agent) => jsx("option", {
								value: agent.id,
								children: zh ? `${agent.id} · ${agent.rows} 条` : `${agent.id} · ${agent.rows}`
							}, agent.id))
						]
					}, "agent"),
					jsx("input", {
						type: "search",
						value: search,
						placeholder: zh ? "搜索工具名、参数、结果…" : "Search calls, arguments, results…",
						"aria-label": zh ? "搜索轨迹" : "Search the trajectory",
						style: {
							flex: "1 1 180px", minWidth: "140px", boxSizing: "border-box",
							height: "28px", padding: "0 10px", borderRadius: "8px",
							border: "1px solid var(--dsw-alias-border-l2)", background: "transparent",
							color: "var(--dsw-alias-label-primary)", font: "inherit", fontSize: "12px", outline: "none"
						},
						onChange: (event) => { setSearch(event.target.value); }
					}, "search"),
					jsx("button", {
						type: "button",
						style: { ...controlStyle(), height: "28px", padding: "0 10px", fontSize: "12px" },
						onClick: () => { setOrder(order === "newest" ? "oldest" : "newest"); },
						children: order === "newest" ? (zh ? "最新在前" : "Newest first") : (zh ? "最早在前" : "Oldest first")
					}, "order")
				]
			}, "filters");

			// Three states, not two. `data === null` with no error is a read that
			// has not come back, and it has exactly the shape of a mission that
			// recorded nothing — `rows` is `[]` either way. Falling through to the
			// empty branch made a slow or wedged route say "这个任务还没有留下任何
			// 轨迹" about a mission that was running fine, which is a claim this
			// page has not checked. MissionDimensionFindings below already draws
			// this distinction for its own read; the trajectory now draws it too.
			const body = data === null && error === ""
				? jsx("div", {
					style: { fontSize: "12px", lineHeight: "18px", color: "var(--dsw-alias-label-secondary)" },
					children: zh ? "正在读取轨迹…" : "Reading the trajectory…"
				}, "loading")
				: error !== "" && data === null
				? jsxs("div", {
					style: { display: "flex", flexDirection: "column", gap: "8px" },
					children: [
						jsx("div", {
							style: { fontSize: "12px", lineHeight: "18px", color: "rgb(217,119,6)" },
							children: (zh ? "读不到轨迹：" : "Could not read the trajectory: ") + error
								+ (zh ? " 下面是视图里带的那一小段事件尾部。" : " What follows is the short event tail the view route carries.")
						}, "why"),
						// Not a blank panel. The view route's tail is a fraction of the
						// trajectory and holds only events, but a mission that cannot
						// show its trajectory can still show what it was doing — and
						// saying which of the two you are looking at is the difference
						// between a fallback and a lie.
						jsx(MissionTimeline, { timeline, zh }, "fallback")
					]
				}, "traceError")
				: jsxs("div", {
					// One bordered surface, list and panel inside it sharing a
					// hairline. Two floating boxes with a gap between them was the
					// arrangement that made the panel read as a tooltip rather than
					// as the other half of a master-detail.
					className: "swt-wrap",
					children: [
						jsx("div", {
							className: "swt-list",
							children: rows.length === 0
								? jsx("div", {
									style: { fontSize: "12px", lineHeight: "18px", color: "var(--dsw-alias-label-secondary)" },
									// "0" and "0 of 431" are different sentences: the first
									// says the mission did nothing, the second says this
									// filter matches nothing.
									children: Number(paging.unfiltered ?? 0) > 0
										? (zh ? `这个筛选下没有记录 —— 轨迹里一共有 ${paging.unfiltered} 条。` : `Nothing matches this filter — the trajectory holds ${paging.unfiltered} row(s).`)
										: (zh ? "这个任务还没有留下任何轨迹。" : "This mission has not recorded a trajectory yet.")
								}, "empty")
								: rows.map((row) => jsx(MissionTraceRow, {
									row, zh,
									active: row.ref === selected,
									onOpen: (ref) => { setSelected(ref === selected ? null : ref); }
								}, row.ref))
						}, "list"),
						// Over the list, not beside it. A pane that took a third of
						// the frame narrowed the very column a reader opened the row
						// to read: the arguments clipped to "https:…" the moment the
						// detail appeared. One overlay for every row on this screen,
						// so the interaction is learnt once.
						jsx(MissionDrawer, {
							open: selected !== null,
							onClose: () => { setSelected(null); },
							children: selected === null ? null : jsx(MissionTraceDetail, {
								missionId, traceRef: selected, zh,
								onClose: () => { setSelected(null); },
								onOpenSource
							})
						}, "drawer")
					]
				}, "master");

			return jsxs("div", {
				style: { display: "flex", flexDirection: "column" },
				children: [
					filters,
					fresh === null ? null : jsx("button", {
						type: "button",
						style: { ...controlStyle(), height: "26px", marginBottom: "8px", fontSize: "12px", alignSelf: "flex-start" },
						onClick: () => { applied.current = fresh.signature; setPage(fresh); setFresh(null); },
						children: gained > 0
							? (zh ? `又有 ${gained} 条记录 · 点这里更新（正在看的那一行不会动）` : `${gained} more row(s) · load them (the open row stays)`)
							: (zh ? "轨迹有更新 · 点这里加载" : "The trajectory moved · load it")
					}, "pending"),
					// A refresh that failed over a list we already have. Without this
					// the page keeps drawing the last good answer beside a clock that
					// never moves, which is the most convincing wrong screen here.
					error === "" || data === null ? null : jsx("div", {
						style: { marginBottom: "8px", fontSize: "12px", lineHeight: "18px", color: "rgb(217,119,6)" },
						children: (zh ? "这一次刷新失败了，下面是上一次读到的轨迹：" : "The latest refresh failed; what follows is the trajectory as it was last read: ") + error
					}, "stale"),
					rows.length === 0 ? null : jsx(MissionTraceBand, { rows, zh }, "band"),
					body,
					data === null ? null : jsx("div", {
						style: { marginTop: "8px", fontSize: "11px", lineHeight: "17px", color: "var(--dsw-alias-label-secondary)" },
						children: [
							zh ? `显示 ${rows.length} / ${paging.total ?? 0} 条` : `showing ${rows.length} of ${paging.total ?? 0}`,
							Number(paging.unfiltered ?? 0) === Number(paging.total ?? 0) ? "" : (zh ? `未筛选共 ${paging.unfiltered} 条` : `${paging.unfiltered} unfiltered`),
							paging.hasMore === true ? (zh ? "还有更多，缩小筛选范围可以看到" : "there is more — narrow the filter to reach it") : "",
							// The window is the honest answer to "is this the whole
							// history". A mission that stops at the thousandth event
							// looks exactly like a mission that stopped working.
							saturated.length === 0 ? "" : (zh
								? `已经读到窗口上限（${saturated.join("、")}）—— 更早的记录还在磁盘上，只是不在这一页里`
								: `the read hit its window (${saturated.join(", ")}) — older rows are on disk, outside this page`)
						].filter((piece) => piece !== "").join(" · ")
					}, "bounds")
				]
			});
		}

		/**
		* One finding, as a row: the mark, the claim, the quote, the state.
		*
		* Three lines rather than one, unlike a trajectory row, because a finding
		* IS the claim and the quote — a list of claims with the quotes hidden
		* behind a click would be the same withholding this rebuild is undoing,
		* one level down.
		* @param finding - one row from `/missions/:id/findings`.
		* @param zh - whether to write Chinese.
		* @param active - whether this finding is the one open in the panel.
		* @param onOpen - called with the finding's trajectory `ref`.
		*/
		function MissionFindingRow({ finding, zh, active, onOpen }) {
			// Three-valued, and `null` is grey rather than red: `unchecked-*` means
			// the check never happened, and a rate limit drawn as a refuted quote is
			// the one confusion the verify-state column exists to prevent.
			const verdict = missionOkFace(finding.verified, zh);
			return jsxs("button", {
				type: "button",
				onClick: () => { onOpen(`finding:${finding.id}`); },
				"aria-pressed": active,
				title: finding.sourceUrl ?? "",
				style: {
					appearance: "none", width: "100%", boxSizing: "border-box",
					display: "flex", alignItems: "flex-start", gap: "8px",
					padding: "5px 8px", borderRadius: "8px",
					border: "1px solid " + (active ? `rgba(${verdict.hue},0.45)` : "transparent"),
					background: active ? `rgba(${verdict.hue},0.10)` : "transparent",
					font: "inherit", textAlign: "left", cursor: "pointer",
					color: "var(--dsw-alias-label-secondary)"
				},
				children: [
					jsx("span", {
						style: { flex: "none", color: `rgb(${verdict.hue})`, fontSize: "12px", lineHeight: "19px" },
						children: verdict.mark
					}, "mark"),
					jsxs("span", {
						style: { flex: 1, minWidth: 0, display: "flex", flexDirection: "column", gap: "1px" },
						children: [
							jsx("span", {
								style: {
									fontSize: "12px", lineHeight: "19px", color: "var(--dsw-alias-label-primary)",
									overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap"
								},
								children: finding.claim
							}, "claim"),
							jsx("span", {
								style: {
									fontSize: "11px", lineHeight: "17px",
									overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap"
								},
								children: `“${finding.quote}”`
							}, "quote"),
							jsx("span", {
								style: { fontSize: "10px", lineHeight: "16px", fontFamily: MISSION_MONO },
								children: [
									missionFace(MISSION_VERIFY_FACES, finding.verifyState, zh),
									finding.sourceHost ?? "",
									zh ? `${finding.quoteChars} 字` : `${finding.quoteChars} chars`
								].filter((piece) => piece !== "" && piece !== null && piece !== undefined).join(" · ")
							}, "meta")
						]
					}, "body")
				]
			});
		}

		/**
		* A dimension's evidence, at last.
		*
		* `/missions/:id/findings?dimensionId=…` is the route whose absence was the
		* complaint. The counts stay on the card above; this is the part that
		* stops them being all there is.
		*
		* Read once when the card opens, and not polled. A running mission's
		* dimension gains findings while it is open, and prepending them would
		* move the row under the reader's cursor for a gain nobody asked for;
		* closing and reopening the card reads it again.
		* @param missionId - the mission.
		* @param dimensionId - the dimension to list.
		* @param zh - whether to write Chinese.
		* @param selected - the `ref` currently open in the panel, if any.
		* @param onOpen - called with a finding's trajectory `ref`.
		*/
		function MissionDimensionFindings({ missionId, dimensionId, zh, selected, onOpen, runCount }) {
			const [held, setHeld] = useState(null);
			const [error, setError] = useState("");
			// THE CONTROLS THE ROUTE HAS BEEN VALIDATING ALL ALONG. Every one of these
			// is a parameter `/missions/:id/findings` already accepts and already 400s
			// on a bad value; this pane sent three of them and offered none, so a
			// dimension of ninety findings was a wall with a dead-end sentence at the
			// bottom saying the other forty exist somewhere.
			const [verifyState, setVerifyState] = useState("");
			const [sourceHost, setSourceHost] = useState("");
			const [order, setOrder] = useState("");
			const [skip, setSkip] = useState(0);

			useEffect(() => {
				let alive = true;
				const query = new URLSearchParams();
				query.set("dimensionId", dimensionId);
				query.set("take", String(MISSION_FINDINGS_TAKE));
				// The run this pane is showing, which is NOT always the mission's
				// current one — see MissionDimensions.
				if (runCount !== null && runCount !== undefined) query.set("runCount", String(runCount));
				if (verifyState !== "") query.set("verifyState", verifyState);
				if (sourceHost !== "") query.set("sourceHost", sourceHost);
				if (order !== "") query.set("order", order);
				// Sent only when it is not the first page: a `skip=0` on every request is
				// noise in the log and one more thing that can be wrong.
				if (skip > 0) query.set("skip", String(skip));
				fetch(`${apiBase()}/missions/${encodeURIComponent(missionId)}/findings?${query.toString()}`)
					.then(missionData)
					.then((data) => {
						if (!alive) return;
						const signature = missionFindingsSignature(data);
						setHeld((previous) => (previous !== null && previous.signature === signature ? previous : { signature, data }));
						setError("");
					})
					.catch((cause) => {
						if (!alive) return;
						setError(String(cause?.message ?? cause));
					});
				return () => { alive = false; };
			}, [missionId, dimensionId, runCount, verifyState, sourceHost, order, skip]);

			if (held === null) {
				return jsx("div", {
					style: { fontSize: "12px", lineHeight: "18px", color: error === "" ? "var(--dsw-alias-label-secondary)" : "rgb(217,119,6)" },
					children: error === ""
						? (zh ? "读取中…" : "Loading…")
						// The route answers a mistyped dimension with a 400 naming the
						// dimensions that exist, which is worth far more than the empty
						// list it could have sent instead.
						: (zh ? "读不到这个维度的证据：" : "Could not read this dimension's evidence: ") + error
				});
			}

			const data = held.data;
			const findings = Array.isArray(data.findings) ? data.findings : [];
			const counts = data.counts ?? {};
			const hosts = Array.isArray(data.hosts) ? data.hosts : [];
			const paging = data.page ?? {};
			const vocabulary = data.vocabulary ?? {};
			// The states this dimension ACTUALLY holds, with their counts — not the
			// nine-value enum. An option that can only ever come back empty teaches a
			// reader that the control is decorative.
			const stateOptions = Object.entries(counts.byState ?? {}).filter(([, n]) => n > 0);
			// Every host in scope, verified or not: `hosts` above is the verified-only
			// roll-up, and filtering to a host whose findings all failed verification
			// is exactly what a reader chasing a bad source wants to do.
			const hostOptions = Array.isArray(data.allHosts) ? data.allHosts : hosts;
			const orderOptions = Array.isArray(vocabulary.orders) ? vocabulary.orders : [];
			const filterStyle = {
				appearance: "none", height: "24px", padding: "0 6px", borderRadius: "6px",
				border: "1px solid var(--dsw-alias-border-l2)", background: "transparent",
				color: "var(--dsw-alias-label-secondary)", font: "inherit", fontSize: "11px", cursor: "pointer"
			};
			// Any change of filter is a new list, so the page offset goes back to the
			// top with it. Keeping it would answer "page 3 of a list that now has one
			// page" with an empty pane and no explanation.
			const refilter = (apply) => { apply(); setSkip(0); };

			return jsxs("div", {
				style: { display: "flex", flexDirection: "column", gap: "4px", marginTop: "4px" },
				children: [
					stateOptions.length === 0 && hostOptions.length === 0 && orderOptions.length === 0 ? null : jsxs("div", {
						style: { display: "flex", alignItems: "center", gap: "6px", flexWrap: "wrap", marginBottom: "4px" },
						children: [
							stateOptions.length === 0 ? null : jsx("select", {
								value: verifyState,
								"aria-label": zh ? "按核验状态筛选" : "Filter by verify state",
								style: filterStyle,
								onChange: (event) => { refilter(() => { setVerifyState(event.target.value); }); },
								children: [
									jsx("option", { value: "", children: zh ? "所有核验状态" : "Every verify state" }, "any"),
									...stateOptions.map(([state, n]) => jsx("option", {
										value: state,
										children: `${missionFace(MISSION_VERIFY_FACES, state, zh)} (${n})`
									}, state))
								]
							}, "verifyState"),
							hostOptions.length === 0 ? null : jsx("select", {
								value: sourceHost,
								"aria-label": zh ? "按站点筛选" : "Filter by host",
								style: filterStyle,
								onChange: (event) => { refilter(() => { setSourceHost(event.target.value); }); },
								children: [
									jsx("option", { value: "", children: zh ? "所有站点" : "Every host" }, "any"),
									...hostOptions.map((entry) => jsx("option", {
										value: entry.host,
										children: `${entry.host} (${entry.findings})`
									}, entry.host))
								]
							}, "sourceHost"),
							orderOptions.length === 0 ? null : jsx("select", {
								value: order,
								"aria-label": zh ? "排序" : "Order",
								style: filterStyle,
								onChange: (event) => { refilter(() => { setOrder(event.target.value); }); },
								children: orderOptions.map((entry) => jsx("option", {
									value: entry === "created" ? "" : entry,
									children: missionFace(MISSION_FINDING_ORDER_FACES, entry, zh)
								}, entry))
							}, "order")
						]
					}, "filters"),
					hosts.length === 0 ? null : jsx("div", {
						style: { fontSize: "11px", lineHeight: "17px", color: "var(--dsw-alias-label-secondary)" },
						// WHICH sites, not how many. "1 个独立站点" gave the reader a
						// number and withheld the only part of it that can be judged.
						children: (zh ? "站点：" : "Hosts: ")
							+ hosts.map((host) => `${host.host} (${host.findings})`).join(zh ? "、" : ", ")
					}, "hosts"),
					findings.length === 0 ? jsx("div", {
						style: { fontSize: "12px", lineHeight: "18px", color: "var(--dsw-alias-label-secondary)" },
						children: zh
							? "这个维度没有写下任何发现 —— 不是没显示，是确实一条也没有。"
							: "This dimension recorded no findings at all — nothing is being hidden; there is nothing."
					}, "none") : jsx("div", {
						style: { display: "flex", flexDirection: "column", gap: "2px" },
						children: findings.map((finding) => jsx(MissionFindingRow, {
							finding, zh,
							active: selected === `finding:${finding.id}`,
							onOpen
						}, finding.id))
					}, "rows"),
					// A PAGE, not a dead end. What stood here said the other forty findings
					// exist and offered no way to reach them, which is the same as not saying
					// it: `skip` was a parameter the route took the whole time.
					paging.hasMore !== true && skip === 0 ? null : jsxs("div", {
						style: { display: "flex", alignItems: "center", gap: "8px", flexWrap: "wrap", marginTop: "2px" },
						children: [
							jsx("span", {
								style: { fontSize: "11px", color: "var(--dsw-alias-label-secondary)" },
								children: zh
									? `第 ${skip + 1}–${skip + (paging.returned ?? 0)} 条，共 ${counts.total ?? 0} 条`
									: `${skip + 1}–${skip + (paging.returned ?? 0)} of ${counts.total ?? 0}`
							}, "range"),
							skip === 0 ? null : jsx("button", {
								type: "button",
								style: { ...controlStyle(), height: "24px", padding: "0 9px", fontSize: "11px" },
								onClick: () => { setSkip(Math.max(0, skip - MISSION_FINDINGS_TAKE)); },
								children: zh ? "上一页" : "Previous"
							}, "prev"),
							paging.hasMore !== true ? null : jsx("button", {
								type: "button",
								style: { ...controlStyle(), height: "24px", padding: "0 9px", fontSize: "11px" },
								onClick: () => { setSkip(skip + MISSION_FINDINGS_TAKE); },
								children: zh ? "下一页" : "Next"
							}, "next")
						]
					}, "more")
				]
			});
		}

		/**
		* The dimension pane: cards that open, and the panel they open into.
		*
		* Master-detail, the same arrangement as the trajectory and with the same
		* component doing the detail, so a finding reached from a dimension and a
		* finding reached from the trajectory are read in one place rather than in
		* two renderers that will drift apart.
		* @param missionId - the mission.
		* @param dimensions - `dimensions` from the view route.
		* @param zh - whether to write Chinese.
		* @param onOpenSource - open a finding's page in the reader.
		*/
		function MissionDimensions({ missionId, dimensions, zh, onOpenSource }) {
			const [openId, setOpenId] = useState(null);
			const [selected, setSelected] = useState(null);
			// Which run's evidence is on screen, and every run that holds any.
			// `null` means "not chosen yet", which is what lets the effect below
			// pick the newest run that actually collected something.
			const [runs, setRuns] = useState([]);
			const [run, setRun] = useState(null);
			const [current, setCurrent] = useState(null);
			// Per-dimension counts for the run on screen. Without this the cards
			// keep drawing the CURRENT run's zeroes under a banner that says the
			// evidence is in an earlier one — the same withholding, one line down.
			const [byDimension, setByDimension] = useState(null);

			// WHY THIS FETCH EXISTS. Every other reader scopes to the mission's
			// current run. That is right while a mission runs and wrong the moment
			// it is re-run: measured on a real mission, five runs, all fourteen
			// findings in run 1, and eight dimension cards reading "0 verified of
			// 0" because run 5 settled without collecting. The evidence was one
			// integer away and the screen said there was none.
			useEffect(() => {
				let alive = true;
				fetch(`${apiBase()}/missions/${encodeURIComponent(missionId)}/findings?take=1`)
					.then(missionData)
					.then((data) => {
						if (!alive) return;
						const rows = Array.isArray(data?.runs) ? data.runs : [];
						setRuns(rows);
						setCurrent(data?.runCount ?? null);
						setByDimension(data?.byDimension ?? null);
						setRun((previous) => {
							if (previous !== null) return previous;
							const here = rows.find((entry) => entry.runCount === data?.runCount);
							if (here !== undefined && here.total > 0) return here.runCount;
							// Newest run that collected anything. Falling back to the
							// current run when nothing did keeps "this mission found
							// nothing" sayable — it is sometimes the truth.
							const best = rows.find((entry) => entry.total > 0);
							return best === undefined ? (data?.runCount ?? null) : best.runCount;
						});
					})
					.catch(() => {
						// A picker that cannot load is not a reason to hide the
						// dimensions; they fall back to the mission's current run.
					});
				return () => { alive = false; };
			}, [missionId]);

			// A second read, once a run is chosen: the first one answered for the
			// mission's current run, which is the one the banner is about to say
			// is empty.
			useEffect(() => {
				if (run === null) return undefined;
				let alive = true;
				fetch(`${apiBase()}/missions/${encodeURIComponent(missionId)}/findings?take=1&runCount=${run}`)
					.then(missionData)
					.then((data) => { if (alive) setByDimension(data?.byDimension ?? null); })
					.catch(() => {});
				return () => { alive = false; };
			}, [missionId, run]);

			const chosen = runs.find((entry) => entry.runCount === run) ?? null;
			const elsewhere = current !== null && run !== null && run !== current;
			const picker = runs.length <= 1 ? null : jsxs("div", {
				style: { display: "flex", alignItems: "center", gap: "6px", flexWrap: "wrap", margin: "0 0 10px" },
				children: [
					jsx("span", {
						style: { fontSize: "12px", color: "var(--dsw-alias-label-secondary)" },
						children: zh ? "运行：" : "Run:"
					}, "label"),
					...runs.map((entry) => jsx("button", {
						type: "button",
						"aria-pressed": entry.runCount === run,
						style: {
							...controlStyle(), height: "24px", padding: "0 9px", fontSize: "11px",
							fontWeight: entry.runCount === run ? 600 : 400,
							color: entry.total === 0 ? "var(--dsw-alias-label-tertiary)" : undefined
						},
						onClick: () => { setRun(entry.runCount); setOpenId(null); setSelected(null); },
						children: zh
							? `第 ${entry.runCount} 次 · ${entry.verified}/${entry.total}`
							: `run ${entry.runCount} · ${entry.verified}/${entry.total}`
					}, `run-${entry.runCount}`))
				]
			}, "runs");

			// Said out loud, not inferred from a highlighted button. A reader who
			// does not notice the picker must still not believe they are looking
			// at the latest run.
			const elsewhereNote = !elsewhere ? null : jsx("div", {
				style: {
					margin: "0 0 10px", padding: "6px 10px", borderRadius: "8px",
					background: "rgba(217,119,6,0.08)", border: "1px solid rgba(217,119,6,0.25)",
					fontSize: "12px", lineHeight: "18px", color: "var(--dsw-alias-label-primary)"
				},
				children: zh
					? `第 ${current} 次运行没有留下任何发现；下面是第 ${run} 次运行的 ${chosen?.total ?? 0} 条（已核验 ${chosen?.verified ?? 0} 条）。`
					: `Run ${current} recorded no findings. What follows is run ${run}: ${chosen?.total ?? 0} findings, ${chosen?.verified ?? 0} verified.`
			}, "elsewhere");

			return jsxs("div", {
				children: [
					picker,
					elsewhereNote,
					jsx("div", {
						// The grid does not change when a finding opens. It used to
						// collapse to a single column to make room for a panel beside
						// it, so reading one finding re-laid-out every card on the
						// screen — the cards you were comparing it against.
						style: {
							minWidth: 0, display: "grid",
							gridTemplateColumns: "repeat(auto-fit, minmax(260px, 1fr))",
							gap: "10px"
						},
						children: dimensions.map((dimension) => jsx(MissionDimensionCard, {
							dimension: byDimension === null ? dimension : {
								...dimension,
								verified: byDimension[dimension.dimensionId]?.verified ?? 0,
								counts: { ...(dimension.counts ?? {}), total: byDimension[dimension.dimensionId]?.total ?? 0 },
								uniqueHosts: byDimension[dimension.dimensionId]?.hosts ?? 0
							},
							zh,
							expanded: dimension.dimensionId === openId,
							onToggle: () => { setOpenId(dimension.dimensionId === openId ? null : dimension.dimensionId); },
							children: dimension.dimensionId !== openId ? null : jsx(MissionDimensionFindings, {
								missionId, dimensionId: dimension.dimensionId, zh, selected,
								runCount: run,
								onOpen: (ref) => { setSelected(ref === selected ? null : ref); }
							})
						}, dimension.dimensionId))
					}, "cards"),
					jsx(MissionDrawer, {
						open: selected !== null,
						onClose: () => { setSelected(null); },
						children: selected === null ? null : jsx(MissionTraceDetail, {
							missionId, traceRef: selected, zh,
							onClose: () => { setSelected(null); },
							onOpenSource
						})
					}, "drawer")
				]
			});
		}

		/**
		* The page behind one quote, read through 信源's own reader.
		*
		* The Host half re-fetches the address and extracts it, which is the only
		* way to answer "does that page still say this" from here. Shared by the
		* report and the trajectory precisely so there is one answer to that
		* question rather than two readers that drift.
		* @param source - anything carrying `sourceUrl`, `sourceTitle`, `quote`, `documentId`.
		* @param zh - whether to write Chinese.
		* @param back - the label on the control that leaves.
		* @param onBack - leave the reader.
		*/
		function MissionSourceReader({ source, zh, back, onBack }) {
			return jsxs("div", {
				style: { height: "100%", minHeight: 0, display: "flex", flexDirection: "column", gap: "10px", padding: "0 24px 16px" },
				children: [
					jsxs("div", {
						style: { flex: "none", display: "flex", alignItems: "center", gap: "10px" },
						children: [
							jsx("button", { type: "button", style: controlStyle(), onClick: onBack, children: back }, "back"),
							jsx("span", {
								style: { flex: 1, minWidth: 0, fontSize: "13px", color: "var(--dsw-alias-label-secondary)" },
								children: ((source.sourceTitle ?? "") === "" ? hostOf(source.sourceUrl) : source.sourceTitle)
									+ (zh ? " · 引语：" : " · quote: ") + `“${source.quote}”`
							}, "which")
						]
					}, "bar"),
					jsx("div", {
						style: { flex: 1, minHeight: 0 },
						children: jsx(DocumentView, {
							// A synthetic row, because `DocumentView` reads a resource
							// and this is a fetched web page: the mission documents are
							// not library rows and no route serves them. Everything the
							// reader actually uses — the url, the title, the display
							// mode it derives from the url — is here.
							row: { id: source.documentId ?? source.sourceUrl, title: source.sourceTitle ?? "", sourceUrl: source.sourceUrl, type: "" },
							kind: MISSION_SOURCE_KIND, zh, wide: true
						})
					}, "reader")
				]
			});
		}
		//#endregion

		//#region missions detail
		/**
		* One action's answer, said out loud.
		*
		* Every one of these routes reports two things — whether the row moved
		* and whether the WORK moved — and they can disagree: a cancel that wins
		* the write while the run belongs to a dead process aborts nothing, and a
		* rerun that parks has claimed the row without dispatching it. Collapsing
		* either pair into "done" is how a button that did half of what it said
		* looks exactly like one that worked.
		* @param action - `cancel` | `resume` | `rerun`.
		* @param data - the route's `data` object.
		* @param zh - whether to write Chinese.
		* @returns the sentence to show.
		*/
		function missionActionNote(action, data, zh) {
			if (action === "cancel") {
				return data.aborted === true
					? (zh ? "已中止，运行中的工作也停了。" : "Cancelled, and the running work was stopped.")
					: (zh ? `状态已写成 ${data.status ?? "cancelled"}，但本进程没有在跑它，所以没有东西可以中止。` : `The row was written as ${data.status ?? "cancelled"}, but this process was not running it, so there was nothing to abort.`);
			}
			if (action === "resume") {
				return data.started === true
					? (zh ? `已从检查点继续，这是第 ${data.runCount} 次运行。` : `Resumed from the checkpoint as run ${data.runCount}.`)
					: (zh ? "没有继续起来。" : "It did not resume.");
			}
			if (action === "rerun") {
				if (data.started === true) {
					return data.mode === "incremental"
						? (zh ? `已增量重跑，这是第 ${data.runCount} 次运行；上一次的结果一条也没删。` : `Rerunning incrementally as run ${data.runCount}; nothing from the previous run was deleted.`)
						: (zh ? `已全新重跑，这是第 ${data.runCount} 次运行；上一次的结果一条也没删。` : `Rerunning from scratch as run ${data.runCount}; nothing from the previous run was deleted.`);
				}
				return data.parked === true
					? (zh ? "任务已认领但没有派发出去，已经挂回可继续状态 —— 不会留下一个没人跑的“运行中”。" : "The mission was claimed but not dispatched, so it was parked back as resumable rather than left running with nothing driving it.")
					: (zh ? "没有重跑起来。" : "It did not start.");
			}
			return "";
		}

		/**
		* One mission, watched: the stages, the dimensions, the cost, the tail,
		* and the four things a person can do about it.
		*
		* Polls `/missions/:id/view` while the mission is not terminal and stops
		* the moment it is. There is no websocket here and the SSE route is not
		* used: the view route already carries the tail beside everything else,
		* and one request cannot disagree with itself.
		* @param missionId - the mission to watch.
		* @param zh - whether to write Chinese.
		* @param onBack - return to the list.
		*/
		/**
		* The right-hand slide-over, over the page rather than beside it.
		*
		* SPEC TAKEN FROM playground's DrawerShell, not approximated: a fixed
		* backdrop at `rgba(0,0,0,0.30)` with a 2px blur, the panel right-aligned
		* at `max-width: 672px` with a left border and a heavy shadow, Escape and
		* a backdrop click both close, and a click inside does not.
		*
		* WHY IT IS AN OVERLAY. The first version was a flex sibling of the table,
		* so opening a row squeezed every column of the board it was describing —
		* the arguments column collapsed, rows re-wrapped, and reading the detail
		* changed the thing you were reading it about. A drawer leaves the table
		* exactly where it was.
		*
		* The trajectory deliberately keeps its side pane. That one is a copy of
		* the host app's own 轨迹 tab, which is a master-detail with a resizable
		* divider, and matching it was the instruction.
		* @param open - whether to render at all.
		* @param onClose - backdrop click, Escape, or the child's own control.
		* @param children - the panel body, which draws its own header.
		*/
		function MissionDrawer({ open, onClose, children }) {
			useEffect(() => {
				if (open !== true) return undefined;
				const onKey = (event) => {
					if (event.key !== "Escape") return;
					// STOPPED HERE. The host app closes the whole 智能体 panel on
					// Escape, so one press with a drawer open closed the drawer AND
					// the panel behind it — measured: the page went from 1945
					// characters to 65. A drawer that is open owns the key.
					event.stopPropagation();
					if (typeof event.preventDefault === "function") event.preventDefault();
					onClose?.();
				};
				// Guarded: this module is executed in Node by the render tests
				// against a hand-written window stub.
				if (typeof window?.addEventListener !== "function") return undefined;
				// Capture phase, so this runs BEFORE the panel's own handler rather
				// than after it has already closed.
				window.addEventListener("keydown", onKey, true);
				return () => { window.removeEventListener("keydown", onKey, true); };
			}, [open, onClose]);

			if (open !== true) return null;
			return jsx("div", {
				className: "swt-scrim",
				role: "dialog",
				"aria-modal": "true",
				onClick: () => { onClose?.(); },
				children: jsx("div", {
					className: "swt-drawer",
					onClick: (event) => { event.stopPropagation(); },
					children
				})
			});
		}
		/**
		* The task board: one row per stage, in playground's column shape.
		*
		* TAKEN, NOT INVENTED. gens.team's MissionTodoBoard is a single flat table
		* — `# · 任务名称 · 负责人 · 模型 · 状态 · 操作`, a grey header, divided
		* rows, a status colour bar down the left edge, and a row click that opens
		* the item. What stood here was the stage strip with the degrade notes
		* printed under it as a paragraph, which is a picture and a wall of text,
		* not a list of work.
		*
		* The columns are OURS where the data is ours: there is no per-stage model
		* to name, and a stage's attempts and duration are the two numbers that
		* say whether it struggled. The degrade note rides in the name cell as a
		* second line, because a stage that finished by lowering its own bar has
		* said why and that sentence is the most useful text on the screen.
		*
		* @param stages - `stages` from the view route, always twelve.
		* @param agents - `agents` from the view route, for the owner column.
		* @param zh - whether to write Chinese.
		* @param onOpenStage - called with a stepId; opens the trajectory on it.
		*/
		function MissionTaskBoard({ stages, agents, zh, onOpenStage, selected, onSelect, mission, work }) {
			// WHAT A TASK IS HERE, and it took a rebuild to get right. playground's
			// board deliberately does NOT show system-stage rows: a todo there is a
			// piece of work somebody decided on — a dimension to research, a gap the
			// reconciler found, a warning the critic raised. This board showed the
			// twelve pipeline stages and nothing else, which is the pipeline's
			// shape, not the mission's work.
			//
			// `view.work` carries both, as a tree: the twelve stages as parents and
			// the real decisions as children under the stage that made them — five
			// researched dimensions under s3-collect, the Leader's re-collect calls
			// under s4-assess, each one with the sentence the Leader wrote about it.
			// The projection existed and had NO READER, which is this codebase's
			// signature failure: the data was one field away and the screen showed
			// the scaffolding instead.
			const tree = Array.isArray(work) ? work : [];
			const rows = Array.isArray(stages) ? stages : [];
			// NOT null. A board with no rows used to render nothing at all, which on
			// screen is a blank rectangle — the same rectangle a component that threw
			// leaves behind. The three reasons the board can be empty want three
			// different reactions, and only one of them is "wait".
			if (rows.length === 0) {
				return jsx(MissionEmptyPane, {
					mission, zh,
					waiting: zh
						? "暂无任务：等 Leader 拆完维度，任务会动态出现。"
						: "No tasks yet: the leader is still breaking the topic into dimensions, and tasks appear as it does.",
					finished: zh
						? "这次运行结束时，任务表里暂无任何一条阶段记录 —— 不是没显示，是确实一条也没落下。"
						: "This run ended with nothing in the task table at all — nothing is being hidden; not one stage row was written."
				});
			}
			// Who ran it. `agents` is keyed by role and carries `lastStepId`, so a
			// stage nobody reached simply has no owner rather than a wrong one.
			const owner = new Map();
			for (const agent of Array.isArray(agents) ? agents : []) {
				if (typeof agent?.lastStepId === "string" && agent.lastStepId !== "") {
					owner.set(agent.lastStepId, agent);
				}
			}
			const head = {
				padding: "7px 10px", textAlign: "left", fontSize: "11px", fontWeight: 600,
				color: "var(--dsw-alias-label-secondary)", whiteSpace: "nowrap"
			};
			const cell = { padding: "7px 10px", fontSize: "12px", lineHeight: "18px", verticalAlign: "top" };
			const columns = [
				{ id: "idx", label: "#", width: "40px", align: "center" },
				{ id: "name", label: zh ? "任务" : "Task", width: "42%" },
				{ id: "owner", label: zh ? "负责人" : "Owner", width: "14%" },
				{ id: "status", label: zh ? "状态" : "Status", width: "14%" },
				{ id: "took", label: zh ? "用时" : "Took", width: "10%", align: "right" },
				{ id: "action", label: zh ? "操作" : "", width: "12%", align: "right" }
			];
			// Parents in pipeline order with their children directly under them,
			// which is the order `buildWork` already returns; this only groups so a
			// stage that gained no children still prints, and a child whose parent
			// fell out of the window is not silently dropped.
			// A host that does not serve `work` yet still gets a board. During a
			// rolling update the browser half is newer than the machine that owns
			// the library, and a blank rectangle is indistinguishable from a
			// component that threw.
			const nodes = tree.length > 0 ? tree : rows.map((row) => ({
				id: `stage:${row.stepId}`, parentId: null, origin: "pipeline",
				title: row.stepId, state: row.status, assignee: row.agent ?? null,
				reason: row.degradeNote ?? null, counts: { attempts: row.attempts ?? 0 }
			}));
			const parents = nodes.filter((node) => node.parentId === null || node.parentId === undefined);
			const kids = new Map();
			for (const node of nodes) {
				if (node.parentId === null || node.parentId === undefined) continue;
				const list = kids.get(node.parentId) ?? [];
				list.push(node);
				kids.set(node.parentId, list);
			}
			const display = [];
			for (const parent of parents) {
				display.push({ node: parent, depth: 0 });
				for (const kid of kids.get(parent.id) ?? []) display.push({ node: kid, depth: 1 });
			}

			const chosen = rows.find((row) => row.stepId === selected) ?? null;
			const table = jsx("div", {
				style: {
					border: "1px solid var(--dsw-alias-border-l2)", borderRadius: "10px",
					overflow: "hidden", background: "var(--dsw-alias-bg-layer-1)"
				},
				children: jsxs("table", {
					style: { width: "100%", borderCollapse: "collapse", tableLayout: "fixed" },
					children: [
						jsx("thead", {
							children: jsx("tr", {
								style: { background: "var(--dsw-alias-bg-layer-2)", borderBottom: "1px solid var(--dsw-alias-border-l2)" },
								children: columns.map((column) => jsx("th", {
									style: { ...head, width: column.width, textAlign: column.align ?? "left" },
									children: column.label
								}, column.id))
							})
						}, "head"),
						jsx("tbody", {
							children: display.map((entry, at) => {
								const node = entry.node;
								const child = entry.depth > 0;
								// A parent row IS a stage, so it keeps the stage row's
								// timings and attempt count. A child is a decision — a
								// dimension somebody planned, a re-collect the Leader
								// called for — and carries its own.
								const stage = child ? null : (rows.find((row) => `stage:${row.stepId}` === node.id) ?? null);
								const status = stage?.status ?? node.state ?? "pending";
								const face = missionFace(MISSION_STAGE_STATUS_FACES, status, zh)
									|| missionFace(MISSION_DIMENSION_FACES, status, zh);
								const hue = missionHue(MISSION_STAGE_STATUS_FACES, status);
								const ran = status !== "pending" && status !== "skipped-by-tier";
								const key = stage === null ? node.id : stage.stepId;
								// The Leader's sentence about THIS dimension when there is
								// one. `reason` on a re-collect child is the mission-level
								// rationale, identical on every child of that decision;
								// `critique` is what was written about this dimension.
								const note = child
									? String(node.critique ?? node.reason ?? "")
									: String(stage?.degradeNote ?? node.reason ?? "");
								const who = child ? (node.assignee ?? null) : (owner.get(stage?.stepId)?.agentId ?? owner.get(stage?.stepId)?.role ?? node.assignee ?? null);
								const attempts = Number(stage?.attempts ?? node.counts?.attempts ?? 0);
								const open = key === selected;
								return jsxs("tr", {
									onClick: () => { onSelect?.(open ? null : key); },
									style: {
										borderBottom: "1px solid var(--dsw-alias-border-l2)",
										cursor: "pointer",
										background: open ? "var(--dsw-alias-interactive-bg-hover)" : "transparent",
										boxShadow: `inset 3px 0 0 0 rgba(${hue},${ran ? 0.9 : 0.25})`
									},
									children: [
										jsx("td", {
											style: { ...cell, textAlign: "center", color: "var(--dsw-alias-label-tertiary)", fontVariantNumeric: "tabular-nums" },
											children: child ? "" : String(at + 1)
										}, "idx"),
										jsxs("td", {
											style: { ...cell, display: "flex", alignItems: "center", gap: "8px", minWidth: 0, paddingLeft: child ? "26px" : "10px" },
											children: [
												// The origin, on the child only. "Why does this row
												// exist" is the whole difference between a plan and a
												// progress bar, and for a stage the answer is always
												// "the pipeline declares twelve".
												!child ? null : jsx("span", {
													style: {
														flex: "none", padding: "0 5px", borderRadius: "5px",
														background: node.origin === "leader-assess-recollect"
															? "var(--dsw-alias-state-warn-tertiary)"
															: "var(--dsw-alias-state-business-tertiary)",
														color: node.origin === "leader-assess-recollect"
															? "var(--dsw-alias-state-warn-label)"
															: "var(--dsw-alias-state-business-primary)",
														fontSize: "10px", fontWeight: 600, whiteSpace: "nowrap"
													},
													children: node.origin === "leader-assess-recollect"
														? (zh ? "领队要求重采" : "re-collect")
														: (zh ? "维度" : "dimension")
												}, "origin"),
												jsx("span", {
													style: {
														fontWeight: child ? 400 : 600,
														color: "var(--dsw-alias-label-primary)",
														whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis",
														maxWidth: child ? "40%" : "none"
													},
													children: child ? node.title : missionFace(MISSION_STAGE_FACES, stage?.stepId ?? node.title, zh)
												}, "name"),
												note === "" ? null : jsx("span", {
													style: {
														flex: "1 1 0", minWidth: 0,
														overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
														fontSize: "11px", color: "var(--dsw-alias-label-tertiary)"
													},
													title: note,
													children: note
												}, "note")
											]
										}, "name"),
										jsx("td", {
											style: { ...cell, fontFamily: MISSION_MONO, fontSize: "11px", color: "var(--dsw-alias-label-secondary)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" },
											children: who === null || who === undefined ? "—" : who
										}, "owner"),
										jsxs("td", {
											style: cell,
											children: [
												jsx("span", {
													style: {
														display: "inline-block", padding: "1px 7px", borderRadius: "6px",
														background: `rgba(${hue},0.12)`, color: `rgb(${hue})`,
														fontSize: "11px", fontWeight: 600, whiteSpace: "nowrap"
													},
													children: face
												}, "pill"),
												attempts <= 1 ? null : jsx("span", {
													style: { marginLeft: "6px", fontSize: "11px", color: "var(--dsw-alias-label-tertiary)" },
													children: zh ? `第 ${attempts} 次` : `try ${attempts}`
												}, "attempts"),
												// A dimension's own arithmetic, where it is the row's
												// point: 已核验 N/下限 is what says whether this piece
												// of work succeeded, and the status word does not.
												!child || node.counts?.verified === undefined || node.counts?.verified === null ? null : jsx("span", {
													style: { marginLeft: "6px", fontSize: "11px", color: "var(--dsw-alias-label-tertiary)", fontVariantNumeric: "tabular-nums" },
													children: node.counts.floor === null || node.counts.floor === undefined
														? (zh ? `已核验 ${node.counts.verified}` : `${node.counts.verified} verified`)
														: (zh ? `已核验 ${node.counts.verified}/${node.counts.floor}` : `${node.counts.verified}/${node.counts.floor} verified`)
												}, "verified")
											]
										}, "status"),
										jsx("td", {
											style: { ...cell, textAlign: "right", fontVariantNumeric: "tabular-nums", color: "var(--dsw-alias-label-secondary)" },
											children: stage === null || stage.durationMs === null || stage.durationMs === undefined
												? "—"
												: missionDuration(stage.durationMs, zh)
										}, "took"),
										jsx("td", {
											style: { ...cell, textAlign: "right" },
											children: !ran || stage === null ? null : jsx("button", {
												type: "button",
												style: {
													appearance: "none", border: "none", background: "transparent",
													padding: 0, cursor: "pointer", font: "inherit", fontSize: "11px",
													color: "var(--dsw-alias-state-business-primary)"
												},
												onClick: (event) => { event.stopPropagation(); onOpenStage?.(stage.stepId); },
												children: zh ? "看轨迹 →" : "Trajectory →"
											}, "open")
										}, "action")
									]
								}, node.id ?? String(at));
							})
						}, "body")
					]
				})
			});
			return jsxs("div", {
				children: [
					table,
					jsx(MissionDrawer, {
						open: chosen !== null,
						onClose: () => { onSelect?.(null); },
						children: chosen === null ? null : jsx(MissionStageDetail, {
							stage: chosen, owner: owner.get(chosen.stepId) ?? null, zh,
							onClose: () => { onSelect?.(null); },
							onOpenStage
						})
					}, "drawer")
				]
			});
		}

		/**
		* One task, whole: the same panel the trajectory uses, on a stage.
		*
		* Reusing `.swt-pane` rather than inventing a second inspector is the
		* point. A person who has learnt that clicking a row on this screen opens
		* a titled panel on the right with a key column at 94px should not have to
		* learn it twice, and two inspectors drift the moment one of them gains a
		* field.
		* @param stage - one row from `stages`.
		* @param owner - the agent whose `lastStepId` is this stage, or null.
		* @param zh - whether to write Chinese.
		* @param onClose - close the panel.
		* @param onOpenStage - open the trajectory filtered to this stage.
		*/
		function MissionStageDetail({ stage, owner, zh, onClose, onOpenStage }) {
			ensureTraceStyle();
			const face = missionFace(MISSION_STAGE_STATUS_FACES, stage.status, zh);
			const note = stage.degradeNote ?? "";
			const line = (label, value) => (value === "" || value === null || value === undefined ? null : jsxs("div", {
				children: [
					jsx("dt", { children: label }, "k"),
					jsx("dd", { title: String(value), children: String(value) }, "v")
				]
			}, label));
			return jsxs("div", {
				className: "swt-pane",
				style: { alignSelf: "flex-start" },
				children: [
					jsxs("div", {
						className: "swt-panehead",
						children: [
							jsxs("span", {
								className: "swt-panetitle",
								children: [
									jsx("span", { className: "swt-dot" }, "dot"),
									jsx("span", { className: "swt-panename", children: missionFace(MISSION_STAGE_FACES, stage.stepId, zh) }, "name"),
									jsx("span", { className: "swt-paneref", children: stage.stepId }, "ref")
								]
							}, "title"),
							jsx("button", {
								type: "button", className: "swt-close",
								"aria-label": zh ? "关闭" : "Close",
								onClick: onClose,
								children: "\u00d7"
							}, "close")
						]
					}, "head"),
					jsxs("div", {
						className: "swt-panebody",
						children: [
							jsxs("dl", {
								className: "swt-kv",
								children: [
									line(zh ? "状态" : "Status", face),
									line(zh ? "尝试" : "Attempts", stage.attempts),
									line(zh ? "用时" : "Took", stage.durationMs === null || stage.durationMs === undefined ? null : missionDuration(stage.durationMs, zh)),
									line(zh ? "负责人" : "Owner", owner === null ? null : (owner.agentId ?? owner.role ?? null)),
									line(zh ? "令牌" : "Tokens", stage.tokens === null || stage.tokens === undefined ? null : Number(stage.tokens).toLocaleString("en-US")),
									line(zh ? "开始" : "Started", stage.startedAt === null || stage.startedAt === undefined ? null : `${formatStamp(stage.startedAt)} ${missionClock(stage.startedAt)}`),
									line(zh ? "结束" : "Ended", stage.endedAt === null || stage.endedAt === undefined ? null : `${formatStamp(stage.endedAt)} ${missionClock(stage.endedAt)}`)
								]
							}, "kv"),
							note === "" ? null : jsx("p", { className: "swt-secthead", children: zh ? "降级说明" : "Why it degraded" }, "noteHead"),
							// WHOLE, and in a block that is allowed to wrap. This is
							// the sentence a degraded stage wrote about itself, and it
							// was being clipped to two lines inside a table cell.
							note === "" ? null : jsx("div", { className: "swt-quote", children: note }, "note"),
							jsx("div", {
								style: { padding: "10px 14px 0" },
								children: jsx("button", {
									type: "button",
									style: { ...controlStyle(), height: "26px", padding: "0 10px", fontSize: "12px" },
									onClick: () => { onOpenStage?.(stage.stepId); },
									children: zh ? "在轨迹里看这一步 →" : "See this step in the trajectory →"
								})
							}, "jump")
						]
					}, "body")
				]
			});
		}

		/**
		* Who spent the budget, by agent.
		*
		* WHAT ONE TOTAL CANNOT SAY: "76 of 120 calls" is true of a mission that
		* worked and of a mission where one researcher burned forty turns
		* re-searching a dimension that was never going to yield. The per-agent
		* row is the difference — the columns that separate them are `toolFailures`
		* and `toolCached`, which is why they are columns rather than a footnote.
		*
		* Sorted by tokens, descending: the biggest spender is the one worth
		* looking at, and a table in agent-id order buries it alphabetically.
		* @param agents - `agents` from the view route.
		* @param zh - whether to write Chinese.
		*/
		function MissionAgentTable({ agents, zh }) {
			const rows = [...(Array.isArray(agents) ? agents : [])]
				.sort((a, b) => (Number(b?.tokens ?? 0) - Number(a?.tokens ?? 0)));
			if (rows.length === 0) return null;
			const totals = rows.reduce((sum, row) => ({
				calls: sum.calls + Number(row?.calls ?? 0),
				tokens: sum.tokens + Number(row?.tokens ?? 0),
				toolCalls: sum.toolCalls + Number(row?.toolCalls ?? 0),
				toolFailures: sum.toolFailures + Number(row?.toolFailures ?? 0),
				toolCached: sum.toolCached + Number(row?.toolCached ?? 0)
			}), { calls: 0, tokens: 0, toolCalls: 0, toolFailures: 0, toolCached: 0 });

			const head = { fontSize: "11px", color: "var(--dsw-alias-label-tertiary)", fontWeight: 400, textAlign: "right", padding: "0 0 6px" };
			const cell = {
				fontSize: "12px", lineHeight: "26px", textAlign: "right",
				fontVariantNumeric: "tabular-nums", color: "var(--dsw-alias-label-primary)"
			};
			const name = { ...cell, textAlign: "left", fontFamily: MISSION_MONO };
			const columns = [
				{ id: "calls", label: zh ? "模型调用" : "Calls", of: (row) => row.calls },
				{ id: "tokens", label: zh ? "令牌" : "Tokens", of: (row) => row.tokens },
				{ id: "toolCalls", label: zh ? "工具调用" : "Tool calls", of: (row) => row.toolCalls },
				// Failures and cache hits are drawn apart from the counts they
				// came out of. A run whose tool calls were 40% cached and one
				// whose tool calls were 40% failures cost the same and mean
				// opposite things.
				{ id: "toolFailures", label: zh ? "失败" : "Failed", of: (row) => row.toolFailures, bad: true },
				{ id: "toolCached", label: zh ? "命中缓存" : "Cached", of: (row) => row.toolCached, good: true }
			];

			return jsx("div", {
				style: { overflowX: "auto" },
				children: jsxs("table", {
					style: { width: "100%", borderCollapse: "collapse", minWidth: "620px" },
					children: [
						jsx("thead", {
							children: jsxs("tr", {
								style: { borderBottom: "1px solid var(--dsw-alias-border-l2)" },
								children: [
									jsx("th", { style: { ...head, textAlign: "left" }, children: zh ? "执行者" : "Agent" }, "agent"),
									jsx("th", { style: { ...head, textAlign: "left" }, children: zh ? "停在" : "Last step" }, "step"),
									...columns.map((column) => jsx("th", { style: head, children: column.label }, column.id))
								]
							})
						}, "head"),
						jsx("tbody", {
							children: rows.map((row, at) => jsxs("tr", {
								style: { borderBottom: "1px solid var(--dsw-alias-border-l2)" },
								children: [
									// `agentId` is null until an agent actually runs; `role` is
									// what the planner named it. A table of "?" for every
									// agent the tier skipped is a table that looks broken.
									jsx("td", { style: name, children: row.agentId ?? row.role ?? "—" }, "agent"),
									jsx("td", {
										style: { ...cell, textAlign: "left", color: "var(--dsw-alias-label-secondary)" },
										children: row.lastStepId === null || row.lastStepId === undefined
											? "—"
											: `${missionFace(MISSION_STAGE_FACES, row.lastStepId, zh)} · ${missionFace(MISSION_STAGE_STATUS_FACES, row.state, zh)}`
									}, "step"),
									...columns.map((column) => {
										const value = Number(column.of(row) ?? 0);
										return jsx("td", {
											style: {
												...cell,
												color: value === 0
													? "var(--dsw-alias-label-tertiary)"
													: column.bad === true
														? "var(--dsw-alias-state-error-primary)"
														: column.good === true
															? "var(--dsw-alias-state-success-primary)"
															: cell.color
											},
											children: value.toLocaleString("en-US")
										}, column.id);
									})
								]
							}, `${row.agentId ?? "?"}-${at}`))
						}, "body"),
						jsx("tfoot", {
							children: jsxs("tr", {
								children: [
									jsx("td", { style: { ...cell, textAlign: "left", color: "var(--dsw-alias-label-secondary)" }, children: zh ? "合计" : "Total" }, "agent"),
									jsx("td", { style: cell, children: "" }, "step"),
									...columns.map((column) => jsx("td", {
										style: { ...cell, fontWeight: 600 },
										children: Number(totals[column.id] ?? 0).toLocaleString("en-US")
									}, column.id))
								]
							})
						}, "foot")
					]
				})
			});
		}
		/**
		* What each failure code means to the PERSON, and what they can do.
		*
		* WHY THIS TABLE EXISTS. The banner used to print the runtime's own
		* sentence, whole, at the top of the screen in the biggest box on it:
		*
		*   "stage_contract_violation · Stage s12-persist broke the stage
		*    contract: every stage settled but s12-persist wrote no terminal
		*    state. The mission is not complete and will not be reported as
		*    such.. This is a bug in the stage, not in your mission; the run
		*    stopped rather than continuing over it."
		*
		* Three things wrong with that, and they compound. It is written to a
		* maintainer — "stage contract", "terminal state", "s12-persist" are this
		* codebase's words, not anybody else's. It is English, at the top of a
		* Chinese screen. And it spends its last clause reassuring the reader that
		* the bug is not theirs, which is the one thing they already assumed and
		* the one thing they cannot act on. What a person needs from a failure is
		* two sentences: what happened to my mission, and what can I do now.
		*
		* The runtime's own text is not thrown away — it goes behind 详情, where
		* it is exactly right, because that is where somebody who can fix it will
		* look. `next` is the sentence that names the action, and it is separate
		* from `what` so a screen can show one without the other.
		*/
		const MISSION_FAILURE_FACES = {
			budget_exhausted: {
				zh: "预算用完了，任务停在半路。",
				en: "The budget ran out and the mission stopped part-way.",
				zhNext: "在成本页看是哪一项先见底，提高那一项后重跑，或者换更低的档位。",
				enNext: "The cost tab names which ceiling ran out first — raise that one and re-run, or run at a lower depth."
			},
			wall_time_exceeded: {
				zh: "跑得太久，超过了这次任务的时间上限。",
				en: "The mission ran past its wall-clock ceiling.",
				zhNext: "提高时间上限后重跑，或者换更低的档位。",
				enNext: "Raise the wall-clock ceiling and re-run, or run at a lower depth."
			},
			context_exceeded: {
				zh: "要读的材料超过了模型一次能装下的量。",
				en: "The material outgrew what the model can hold in one context.",
				zhNext: "换上下文窗口更大的模型，或者把课题拆小一点。",
				enNext: "Route to a model with a larger context window, or narrow the topic."
			},
			tool_unavailable: {
				zh: "任务需要的工具这台机器上没有。",
				en: "A tool this mission needs is not installed on this machine.",
				zhNext: "去信源页看看搜索和抓取的插件是不是都装好了。",
				enNext: "Check the 信源 tab: the search and fetch plugins have to be installed and configured."
			},
			rate_limited: {
				zh: "上游把请求挡回来了 —— 是取不到，不是没有。",
				en: "An upstream service rate-limited the run — this is unreachable, not absent.",
				zhNext: "过一会儿再重跑；增量重跑会保留已经拿到的东西。",
				enNext: "Re-run later. An incremental re-run keeps what was already collected."
			},
			model_error: {
				zh: "模型这一侧报错了。",
				en: "The model provider returned an error.",
				zhNext: "先看详情里provider说了什么；换一个模型或稍后重跑。",
				enNext: "Read what the provider said under 详情, then switch models or re-run later."
			},
			no_evidence: {
				zh: "所有维度都没能找到可核验的证据。",
				en: "Not one dimension produced checkable evidence.",
				zhNext: "这有时就是答案：公开材料里可能确实没有。也可以换个说法重开一个任务。",
				enNext: "Sometimes that is the answer — the public record may not hold it. Otherwise re-open the mission with a differently-worded topic."
			},
			runtime_crashed: {
				zh: "任务跑到一半，进程没了。",
				en: "The process died mid-mission.",
				zhNext: "从检查点继续，已经做完的阶段不用重做。",
				enNext: "Resume from the checkpoint — the stages that finished do not run again."
			},
			input_invalid: {
				zh: "这次任务的输入有问题，走不下去。",
				en: "The mission was opened with input it cannot run on.",
				zhNext: "看详情里说的是哪一项，改掉之后重开一个任务。",
				enNext: "详情 names which field; fix it and open a new mission."
			},
			stage_contract_violation: {
				zh: "某个阶段没有按约定收尾，所以这次运行没有结果。",
				en: "A stage settled without writing the result it is required to write, so this run has no outcome.",
				zhNext: "这是系统缺陷，已经记在详情里。已经采到的证据还在，可以直接重跑。",
				enNext: "That is a defect on our side and the details are recorded below. The evidence already collected is kept; re-running is safe."
			},
			no_progress: {
				zh: "任务原地打转，停了下来。",
				en: "The mission stopped making progress and was halted.",
				zhNext: "在轨迹里看它反复在做什么；换个说法重开通常有效。",
				enNext: "The trajectory shows what it kept repeating. Re-opening with a differently-worded topic usually clears it."
			},
			user_cancelled: {
				zh: "你中止了这次运行。",
				en: "You cancelled this run.",
				zhNext: "从检查点继续，或者全新重跑。",
				enNext: "Resume from the checkpoint, or re-run from scratch."
			},
			superseded: {
				zh: "这次运行被后来的一次接手了。",
				en: "A later run took over from this one.",
				zhNext: "看最新那一次运行。",
				enNext: "Look at the newest run."
			},
			shutdown: {
				zh: "服务停止时，这次运行被一并停下。",
				en: "The service shut down and took this run with it.",
				zhNext: "从检查点继续。",
				enNext: "Resume from the checkpoint."
			},
			quality_refused: {
				zh: "报告写出来了，但没有达到这次任务自己定的标准，领队拒签。",
				en: "A report was written, but it missed the bar this mission set for itself and the Leader refused to sign it.",
				zhNext: "报告仍然可读。详情里写着差在哪一项 —— 通常是证据条数或篇幅。",
				enNext: "The report is still readable. 详情 says which bar it missed — usually the number of findings or the length."
			}
		};

		/**
		* The failure banner: one sentence, one action, and the raw text folded away.
		* @param code - `missions.failure_code`.
		* @param message - the runtime's own sentence.
		* @param zh - whether to write Chinese.
		*/
		function MissionFailureNote({ code, message, zh }) {
			const [open, setOpen] = useState(false);
			const face = MISSION_FAILURE_FACES[code] ?? null;
			const raw = String(message ?? "");
			// An unknown code still gets a banner rather than a blank: the codes
			// are a fixed vocabulary, so a miss here is a code that was added
			// without a sentence, and saying so is more useful than saying nothing.
			const what = face === null
				? (zh ? "这次运行失败了。" : "This run failed.")
				: (zh ? face.zh : face.en);
			const next = face === null ? "" : (zh ? face.zhNext : face.enNext);
			return jsxs("div", {
				style: {
					margin: "0 0 8px", padding: "8px 10px", borderRadius: "8px",
					background: "rgba(220,38,38,0.06)", border: "1px solid rgba(220,38,38,0.25)",
					fontSize: "13px", lineHeight: "20px", color: "var(--dsw-alias-label-primary)"
				},
				children: [
					jsxs("div", {
						style: { display: "flex", alignItems: "baseline", gap: "8px", flexWrap: "wrap" },
						children: [
							jsx("span", { style: { fontWeight: 600 }, children: what }, "what"),
							next === "" ? null : jsx("span", {
								style: { color: "var(--dsw-alias-label-secondary)" },
								children: next
							}, "next"),
							raw === "" ? null : jsx("button", {
								type: "button",
								style: {
									appearance: "none", border: "none", background: "transparent", padding: 0,
									font: "inherit", fontSize: "12px", cursor: "pointer",
									color: "var(--dsw-alias-state-business-primary)"
								},
								onClick: () => { setOpen((was) => !was); },
								children: open ? (zh ? "收起详情" : "Hide details") : (zh ? "详情" : "Details")
							}, "toggle")
						]
					}, "line"),
					!open ? null : jsx("pre", {
						// The runtime's own words, verbatim, where the person who can
						// act on them will look. Not re-worded: two phrasings of one
						// failure is the same defect as two names for one method.
						style: {
							margin: "8px 0 0", padding: "8px 10px", borderRadius: "6px",
							background: "var(--dsw-alias-bg-layer-2)",
							fontFamily: MISSION_MONO, fontSize: "11px", lineHeight: "17px",
							whiteSpace: "pre-wrap", wordBreak: "break-word",
							color: "var(--dsw-alias-label-secondary)"
						},
						children: (code === null || code === undefined ? "" : `${code}\n\n`) + raw
					}, "raw")
				]
			});
		}
		/**
		* A big number, short enough to sit on a tab row.
		*
		* Rounded, never truncated to look smaller: 412000 is `412k` and 1_480_000 is
		* `1.5M`, so the trailing slot reads at a glance and still says the same thing
		* as the meter it summarises.
		* @param value - the count.
		* @returns the short form.
		*/
		function missionCompact(value) {
			const n = Number(value);
			if (!Number.isFinite(n)) return "—";
			if (Math.abs(n) >= 1000000) return `${(n / 1000000).toFixed(1)}M`;
			if (Math.abs(n) >= 1000) return `${Math.round(n / 1000)}k`;
			return String(n);
		}

		/**
		* A pane with nothing in it, saying WHICH nothing.
		*
		* Three panes used to `return null` when their list was empty, which draws a
		* blank rectangle — and a blank rectangle is exactly what a crashed component
		* draws too. The three states behind an empty pane want different reactions:
		* a mission still planning will fill it by itself, a mission that died before
		* planning never will and the failure is the thing to read, and a finished
		* mission with an empty pane is a real, final answer.
		* @param mission - `view.mission`, or undefined when the caller has none.
		* @param waiting - the sentence for a run that has not got there yet.
		* @param finished - the sentence for a finished run that produced nothing here.
		* @param zh - whether to write Chinese.
		*/
		function MissionEmptyPane({ mission, waiting, finished, zh }) {
			const failureCode = mission?.failureCode ?? null;
			const message = mission?.errorMessage ?? "";
			const failed = failureCode !== null || message !== "";
			const terminal = mission?.terminal === true;
			const hue = failed ? "220,38,38" : terminal ? "100,116,139" : "217,119,6";
			// The same table the failure banner reads, so a pane and the banner over it
			// cannot name the same code two different ways.
			const face = failureCode !== null && Object.hasOwn(MISSION_FAILURE_FACES, failureCode)
				? MISSION_FAILURE_FACES[failureCode]
				: null;
			const lines = failed
				? [
					zh ? "这一格是空的，因为这次运行没有走到这一步：" : "This pane is empty because the run never got here:",
					face === null ? "" : (zh ? face.zh : face.en),
					message === "" ? "" : message,
					face === null ? "" : (zh ? face.zhNext : face.enNext)
				].filter((line) => line !== "")
				: [terminal ? finished : waiting];

			return jsx("div", {
				style: {
					padding: "10px 12px", borderRadius: "10px",
					border: `1px solid rgba(${hue},0.25)`, background: `rgba(${hue},0.06)`,
					display: "flex", flexDirection: "column", gap: "4px"
				},
				children: lines.map((line, at) => jsx("div", {
					style: {
						fontSize: "12px", lineHeight: "19px",
						color: at === 0 ? "var(--dsw-alias-label-primary)" : "var(--dsw-alias-label-secondary)"
					},
					children: line
				}, `l${at}`))
			});
		}

		/**
		* Everything this mission read, once each.
		*
		* The evidence pane answers "what did we learn" and answers it per finding;
		* this answers "what did we read" and answers it per page. On a real mission
		* the two differ by half — fourteen findings over seven pages — and a
		* references screen built from the findings route shows the same page six times
		* and makes a thinly-sourced mission look well sourced.
		*
		* The run picker is the same one the evidence pane carries, for the same
		* reason: measured on a real mission, five runs, every finding in run 1, and a
		* references screen scoped to run 5 that would list nothing at all.
		* @param missionId - the mission.
		* @param zh - whether to write Chinese.
		* @param mission - `view.mission`, for the empty state's sentence.
		*/
		function MissionSources({ missionId, zh, mission }) {
			const [held, setHeld] = useState(null);
			const [error, setError] = useState("");
			const [run, setRun] = useState(null);
			const [byHost, setByHost] = useState(false);

			useEffect(() => {
				let alive = true;
				const query = run === null ? "" : `?runCount=${run}`;
				fetch(`${apiBase()}/missions/${encodeURIComponent(missionId)}/sources${query}`)
					.then(missionData)
					.then((data) => {
						if (!alive) return;
						setHeld(data);
						setError("");
						setRun((previous) => {
							if (previous !== null) return previous;
							const runs = Array.isArray(data?.runs) ? data.runs : [];
							const here = runs.find((entry) => entry.runCount === data?.runCount);
							if (here !== undefined && here.total > 0) return here.runCount;
							// The newest run that read anything. Falling back to the current run
							// when none did keeps "this mission read nothing" sayable — it is
							// sometimes the truth, and it is the truth this pane must not hide.
							const best = runs.find((entry) => entry.total > 0);
							return best === undefined ? previous : best.runCount;
						});
					})
					.catch((cause) => {
						if (!alive) return;
						setError(String(cause?.message ?? cause));
					});
				return () => { alive = false; };
			}, [missionId, run]);

			if (held === null) {
				return jsx("div", {
					style: { fontSize: "12px", lineHeight: "18px", color: error === "" ? "var(--dsw-alias-label-secondary)" : "rgb(217,119,6)" },
					children: error === ""
						? (zh ? "读取中…" : "Loading…")
						: (zh ? "读不到这次任务的来源清单：" : "Could not read this mission's sources: ") + error
				});
			}

			const sources = Array.isArray(held.sources) ? held.sources : [];
			const totals = held.totals ?? { sources: 0, hosts: 0, findings: 0, verified: 0 };
			const runs = Array.isArray(held.runs) ? held.runs : [];
			const names = new Map((Array.isArray(held.dimensions) ? held.dimensions : []).map((row) => [row.dimensionId, row.name]));
			const current = held.runCount ?? null;

			const picker = runs.length <= 1 ? null : jsxs("div", {
				style: { display: "flex", alignItems: "center", gap: "6px", flexWrap: "wrap", margin: "0 0 10px" },
				children: [
					jsx("span", {
						style: { fontSize: "12px", color: "var(--dsw-alias-label-secondary)" },
						children: zh ? "运行：" : "Run:"
					}, "label"),
					...runs.map((entry) => jsx("button", {
						type: "button",
						"aria-pressed": entry.runCount === current,
						style: {
							...controlStyle(), height: "24px", padding: "0 9px", fontSize: "11px",
							fontWeight: entry.runCount === current ? 600 : 400,
							color: entry.total === 0 ? "var(--dsw-alias-label-tertiary)" : undefined
						},
						onClick: () => { setRun(entry.runCount); },
						children: zh
							? `第 ${entry.runCount} 次 · ${entry.verified}/${entry.total}`
							: `run ${entry.runCount} · ${entry.verified}/${entry.total}`
					}, `run-${entry.runCount}`))
				]
			}, "runs");

			if (sources.length === 0) {
				return jsxs("div", { children: [picker, jsx(MissionEmptyPane, {
					mission, zh,
					waiting: zh
						? "还没有读到任何一页 —— 采集阶段一开始，这里就会一条条长出来。"
						: "Nothing has been read yet. Entries appear here one page at a time once collection starts.",
					finished: zh
						? "这次运行结束时，一个来源也没有留下 —— 不是没显示，是确实一页都没读成。"
						: "This run ended with no sources at all — nothing is being hidden; not one page was read."
				}, "empty")] });
			}

			// Sorted by how much each host carried, not alphabetically: the question a
			// reader has here is whether one site is holding the whole report up.
			const hosts = new Map();
			for (const source of sources) {
				const bag = hosts.get(source.host);
				if (bag === undefined) hosts.set(source.host, { host: source.host, rows: [source], findings: source.findings });
				else { bag.rows.push(source); bag.findings += source.findings; }
			}
			const grouped = [...hosts.values()].sort((a, b) => b.findings - a.findings);

			const row = (source) => jsxs("div", {
				style: {
					display: "flex", flexDirection: "column", gap: "2px",
					padding: "7px 0", borderTop: "1px solid var(--dsw-alias-border-l1)"
				},
				children: [
					jsx("a", {
						href: source.url,
						target: "_blank",
						rel: "noreferrer noopener",
						style: { fontSize: "13px", color: "var(--dsw-alias-state-business-primary)", textDecoration: "none" },
						// The page's own title where it has one. A column of raw addresses is
						// what this pane looks like without the join, and it is unreadable.
						children: (source.title ?? "") === "" ? source.url : source.title
					}, "link"),
					jsx("div", {
						style: { fontSize: "11px", lineHeight: "17px", fontFamily: MISSION_MONO, color: "var(--dsw-alias-label-tertiary)" },
						children: [
							byHost ? "" : source.host,
							zh ? `${source.findings} 条发现` : `${source.findings} finding(s)`,
							// Verified against the page, not merely recorded from it. A source
							// that produced six findings of which none verified is a source that
							// carried nothing, and one number cannot say that.
							zh ? `已核验 ${source.verified} 条` : `${source.verified} verified`,
							(Array.isArray(source.dimensionIds) ? source.dimensionIds : [])
								.map((id) => names.get(id) ?? id).join(zh ? "、" : ", "),
							source.firstSeenAt === null || source.firstSeenAt === undefined ? "" : formatStamp(source.firstSeenAt)
						].filter((piece) => piece !== "" && piece !== null && piece !== undefined).join(" · ")
					}, "meta")
				]
			}, source.url);

			return jsxs("div", {
				children: [
					picker,
					jsxs("div", {
						style: { display: "flex", alignItems: "center", gap: "10px", flexWrap: "wrap", margin: "0 0 8px" },
						children: [
							jsx("span", {
								style: { fontSize: "12px", color: "var(--dsw-alias-label-secondary)" },
								children: zh
									? `${totals.findings} 条发现 · ${totals.sources} 个来源 · ${totals.hosts} 个站点 · 已核验 ${totals.verified} 条`
									: `${totals.findings} findings · ${totals.sources} sources · ${totals.hosts} hosts · ${totals.verified} verified`
							}, "totals"),
							jsx("span", { style: { flex: 1 } }, "spacer"),
							jsx("button", {
								type: "button",
								"aria-pressed": byHost,
								style: { ...controlStyle(), height: "26px", padding: "0 10px", fontSize: "12px" },
								onClick: () => { setByHost(!byHost); },
								children: byHost ? (zh ? "按引用次数排" : "By citation count") : (zh ? "按站点分组" : "Group by host")
							}, "group")
						]
					}, "head"),
					!byHost ? jsx("div", { children: sources.map(row) }, "flat") : jsx("div", {
						style: { display: "flex", flexDirection: "column", gap: "12px" },
						children: grouped.map((entry) => jsxs("div", {
							children: [
								jsx("div", {
									style: { fontSize: "12px", fontWeight: 600, fontFamily: MISSION_MONO, color: "var(--dsw-alias-label-primary)" },
									children: zh
										? `${entry.host} · ${entry.rows.length} 页 · ${entry.findings} 条发现`
										: `${entry.host} · ${entry.rows.length} page(s) · ${entry.findings} finding(s)`
								}, "host"),
								jsx("div", { children: entry.rows.map(row) }, "rows")
							]
						}, entry.host))
					}, "grouped")
				]
			});
		}

		/**
		* Every pane the strip can offer, in order.
		*
		* Named once so the strip and the guard below it cannot disagree. `pane` is
		* free state and the strip used to change shape underneath it — the report tab
		* appeared and vanished with `hasReport` — so a rerun that dropped the artefact
		* left the state pointing at a tab that no longer existed: a pressed-nothing
		* strip over an empty body, which is a blank screen with chrome on top.
		*/
		const MISSION_PANES = ["tasks", "trace", "report", "sources", "dimensions", "cost"];

		/**
		* The six panes of one mission, as a tab strip.
		*
		* WHY A STRIP AND NOT A LONGER PAGE: the trajectory carries a detail panel
		* beside it, and a panel that opens below two thousand pixels of stage
		* strip, cost meters and dimension cards is a panel nobody finds. Each
		* pane reads the same `view` that is already in memory, so switching is
		* free and no pane can show a different mission than its neighbour.
		*
		* The counts are on the tabs on purpose. "维度 5" and "发现 11" said on the
		* strip is the difference between a reader who opens the pane and a reader
		* who assumes it is empty, which is exactly what happened when the numbers
		* lived only inside the pane they described.
		*/
		function MissionDetailTabs({ pane, setPane, zh, findings, steps, stages, spend }) {
			// The set gens.team's playground arrived at for the same object, and
			// it is taken rather than re-derived: 任务列表 · 协作动态 · 输出报告 ·
			// 参考文献 · 图谱分析 · 算力消耗. Two of those were folded into an
			// "overview" here, and folding them is what made the overview a
			// drawer with the trajectory buried under it.
			//
			// 图谱分析 is the one deliberately absent. A knowledge graph needs
			// entities and edges this mission never builds, and a tab that opens
			// onto "no graph data" for every mission is a tab that teaches people
			// the strip is decorative.
			// FIXED SHAPE. 报告 stays in the strip whether or not there is an
			// artefact behind it: a tab that vanishes teaches the reader the strip is
			// unreliable, and "还没有生成报告" is a better answer than a missing tab —
			// it says the mission has not written one yet, which a gap cannot.
			const panes = [
				{ id: "tasks", label: zh ? "任务" : "Tasks", count: stages },
				{ id: "trace", label: zh ? "轨迹" : "Trajectory", count: steps },
				{ id: "report", label: zh ? "报告" : "Report", count: null },
				{ id: "sources", label: zh ? "参考文献" : "References", count: null },
				{ id: "dimensions", label: zh ? "证据" : "Evidence", count: findings },
				{ id: "cost", label: zh ? "成本" : "Cost", count: null }
			];
			const strip = jsx("div", {
				style: {
					display: "flex", alignItems: "center", gap: "4px",
					margin: 0, padding: "3px",
					borderRadius: "9px", background: "var(--dsw-alias-fill-tertiary)",
					width: "fit-content"
				},
				children: panes.map((entry) => {
					const on = entry.id === pane;
					return jsxs("button", {
						type: "button",
						"aria-pressed": on,
						onClick: () => { setPane(entry.id); },
						style: {
							appearance: "none", border: "none", cursor: "pointer",
							display: "flex", alignItems: "center", gap: "6px",
							height: "28px", padding: "0 14px", borderRadius: "7px",
							font: "inherit", fontSize: "13px",
							fontWeight: on ? 600 : 400,
							background: on ? "var(--dsw-alias-bg-primary)" : "transparent",
							color: on ? "var(--dsw-alias-label-primary)" : "var(--dsw-alias-label-secondary)",
							boxShadow: on ? "0 1px 2px rgba(0,0,0,0.06)" : "none"
						},
						children: [
							jsx("span", { children: entry.label }, "label"),
							entry.count === null || entry.count === 0 ? null : jsx("span", {
								style: {
									fontFamily: MISSION_MONO, fontSize: "11px",
									fontVariantNumeric: "tabular-nums",
									color: "var(--dsw-alias-label-tertiary)"
								},
								children: String(entry.count)
							}, "count")
						]
					}, entry.id);
				})
			});
			// The spend, ON the strip. It lived one pane away, so "how much has this
			// cost so far" was a click from every screen except the one that answers
			// it. A span rather than a control: the strip's buttons are the strip's
			// buttons, and a seventh clickable thing in that row would be read as a
			// seventh pane.
			return jsxs("div", {
				style: { display: "flex", alignItems: "center", gap: "12px", flexWrap: "wrap", margin: "0 0 12px" },
				children: [
					strip,
					(spend ?? "") === "" ? null : jsx("span", {
						style: {
							fontSize: "11px", fontFamily: MISSION_MONO, fontVariantNumeric: "tabular-nums",
							color: "var(--dsw-alias-label-tertiary)"
						},
						children: spend
					}, "spend")
				]
			});
		}

		function MissionDetail({ missionId, zh, onBack, initialPane }) {
			const [view, setView] = useState(null);
			const [state, setState] = useState("loading");
			const [error, setError] = useState("");
			const [tick, setTick] = useState(0);
			const [busy, setBusy] = useState("");
			const [notice, setNotice] = useState("");
			const [actionError, setActionError] = useState("");

			// Which of the three panes is showing. Held here rather than in the
			// tab bar so that leaving a mission and coming back opens on the
			// overview, and so a reader who is deep in the trajectory keeps it
			// across a poll.
			const [pane, setPane] = useState(typeof initialPane === "string" ? initialPane : "tasks");
			// Which version the report pane is showing, held HERE because the download
			// control is on the header row one level up. A reader looking at v1 who
			// presses 下载 and receives v3 has been handed a different document than
			// the one on their screen, and nothing on either would say so.
			const [reportVersion, setReportVersion] = useState(0);
			// Which stage the trajectory should open on, when it was reached from
			// the task board rather than from the tab.
			const [focusStep, setFocusStep] = useState("");
			// Which task row is open in the panel beside the board.
			const [task, setTask] = useState(null);
			// The page behind a quote, opened from the trajectory or from a
			// dimension. Switched in place, the way the report does it, so the
			// frame never moves under the reader.
			const [source, setSource] = useState(null);

			useEffect(() => {
				let alive = true;
				fetch(`${apiBase()}/missions/${encodeURIComponent(missionId)}/view?tail=${MISSION_TAIL}`)
					.then(missionData)
					.then((data) => {
						if (!alive) return;
						setView(data);
						setState("ready");
					})
					.catch((cause) => {
						if (!alive) return;
						setError(String(cause?.message ?? cause));
						setState("error");
					});
				return () => { alive = false; };
			}, [missionId, tick]);

			// Polls only while the mission is live. Unref'd for the same reason
			// the list's timer is: this module is rendered in Node by
			// tests/settings.test.mjs, which never unmounts.
			const terminal = view?.mission?.terminal === true;
			useEffect(() => {
				if (state !== "ready" || terminal) return;
				const timer = setTimeout(() => { setTick((value) => value + 1); }, MISSION_POLL_MS);
				timer.unref?.();
				return () => { clearTimeout(timer); };
			}, [state, terminal, tick]);

			const act = useCallback(async (action, body) => {
				setBusy(action);
				setNotice("");
				setActionError("");
				try {
					const response = await fetch(`${apiBase()}/missions/${encodeURIComponent(missionId)}/${action}`, {
						method: "POST",
						headers: { "content-type": "application/json" },
						body: JSON.stringify(body ?? {})
					});
					setNotice(missionActionNote(action, await missionData(response), zh));
				} catch (cause) {
					// The 409s here carry the reason AND the next action — one of
					// the six resume refusals, or the sentence telling you to
					// cancel before rerunning a live mission. Shown as it came.
					setActionError(String(cause?.message ?? cause));
				} finally {
					setBusy("");
					setTick((value) => value + 1);
				}
			}, [missionId, zh]);

			if (state === "loading" && view === null) {
				// With the back control, not without it. A slow first read that
				// offers no way out is a tab a person has to close the whole
				// page to leave.
				return jsxs("div", {
					style: { ...CONTENT_STYLE, padding: "0 24px" },
					children: [
						jsx("button", {
							type: "button", style: controlStyle(), onClick: onBack,
							children: zh ? "← 返回任务列表" : "← Back to missions"
						}, "back"),
						jsx("div", { style: { ...NOTE_STYLE, marginTop: "14px" }, children: zh ? "加载中…" : "Loading…" }, "note")
					]
				});
			}
			if (state === "error" && view === null) {
				return jsxs("div", {
					style: { ...CONTENT_STYLE, padding: "0 24px" },
					children: [
						jsx("button", {
							type: "button", style: controlStyle(), onClick: onBack,
							children: zh ? "← 返回任务列表" : "← Back to missions"
						}, "back"),
						jsx("div", {
							style: { ...NOTE_STYLE, marginTop: "14px" },
							children: (zh ? "读不到这个任务：" : "Could not read this mission: ") + error
						}, "note")
					]
				});
			}

			if (source !== null) {
				return jsx(MissionSourceReader, {
					source, zh,
					back: zh ? "← 返回任务" : "← Back to the mission",
					onBack: () => { setSource(null); }
				});
			}


			const mission = view.mission;
			// A pane the strip no longer offers falls back to the board rather than
			// rendering a pressed-nothing strip over an empty body.
			const activePane = MISSION_PANES.includes(pane) ? pane : "tasks";
			const face = missionPillFace(mission.pill, zh);
			const artifact = view.artifact ?? { kind: "empty-artifact", reason: "not-yet-materialized" };
			const hasReport = artifact.kind === "artifact";
			const evidence = mission.evidence ?? {};
			const noEvidence = missionNoEvidence(view.timeline);
			const preflight = view.timeline?.preflight ?? null;
			const resume = view.resume ?? { offered: false };
			// The version the download control names. An explicit choice wins; with
			// none, the artefact the view route says is current.
			const shownVersion = reportVersion > 0 ? reportVersion : Number(artifact.version ?? 0);
			const progress = mission.progress ?? {};

			const meta = [
				missionFace(MISSION_TIER_FACES, mission.depth, zh),
				zh ? `第 ${mission.runCount} 次运行` : `run ${mission.runCount}`,
				zh ? `阶段 ${progress.stagesResolved}/${progress.stagesTotal}` : `stages ${progress.stagesResolved}/${progress.stagesTotal}`,
				progress.dimensionsTotal > 0
					? (zh ? `维度 ${progress.dimensionsResolved}/${progress.dimensionsTotal}` : `dimensions ${progress.dimensionsResolved}/${progress.dimensionsTotal}`)
					: "",
				progress.chaptersTotal > 0
					? (zh ? `章节 ${progress.chaptersDone}/${progress.chaptersTotal}` : `chapters ${progress.chaptersDone}/${progress.chaptersTotal}`)
					: "",
				zh ? `已用 ${missionDuration(mission.elapsedMs, zh)}` : `${missionDuration(mission.elapsedMs, zh)} elapsed`,
				formatStamp(mission.startedAt)
			].filter((piece) => piece !== "").join(" · ");

			// What this run has spent, for the tab row. Compact on purpose: it is a
			// glance, and the meters one pane over are the reading.
			const spend = [
				zh ? `令牌 ${missionCompact(view.cost?.tokens?.used ?? 0)}` : `${missionCompact(view.cost?.tokens?.used ?? 0)} tokens`,
				zh ? `调用 ${view.cost?.calls?.used ?? 0} 次` : `${view.cost?.calls?.used ?? 0} calls`,
				mission.score === null || mission.score === undefined
					? ""
					: (zh ? `评分 ${mission.score}` : `score ${mission.score}`)
			].filter((piece) => piece !== "").join(" · ");

			// The mission's four actions, hoisted so they can sit on the header
			// row rather than under it. They were a row of their own, which cost
			// 34px plus its margin above a list whose value is how many rows fit.
			const missionActions = [
				mission.terminal ? null : jsx("button", {
					type: "button",
					disabled: busy !== "",
					style: { ...controlStyle(), height: "28px", padding: "0 10px", fontSize: "12px", flex: "none" },
					onClick: () => { void act("cancel"); },
					children: busy === "cancel" ? (zh ? "正在中止…" : "Cancelling…") : (zh ? "中止" : "Cancel")
				}, "cancel"),
				!resume.offered ? null : jsx("button", {
					type: "button",
					disabled: busy !== "",
					title: resume.detail ?? "",
					style: { ...controlStyle(), height: "28px", padding: "0 10px", fontSize: "12px", flex: "none" },
					onClick: () => { void act("resume"); },
					children: busy === "resume" ? (zh ? "正在继续…" : "Resuming…") : (zh ? "从检查点继续" : "Resume")
				}, "resume"),
				!mission.terminal ? null : jsx("button", {
					type: "button",
					disabled: busy !== "",
					style: { ...controlStyle(), height: "28px", padding: "0 10px", fontSize: "12px", flex: "none" },
					onClick: () => { void act("rerun", { mode: "fresh" }); },
					children: busy === "rerun" ? (zh ? "正在重跑…" : "Rerunning…") : (zh ? "全新重跑" : "Rerun from scratch")
				}, "rerun"),
				!mission.terminal ? null : jsx("button", {
					type: "button",
					disabled: busy !== "",
					style: { ...controlStyle(), height: "28px", padding: "0 10px", fontSize: "12px", flex: "none" },
					onClick: () => { void act("rerun", { mode: "incremental" }); },
					children: zh ? "增量重跑" : "Rerun incrementally"
				}, "rerunIncremental"),
				!hasReport ? null : jsx("a", {
					// The version on screen, in the query AND in the filename. Both halves
					// matter: the query is what makes the file the one being read, and the
					// filename is what stops three downloads of three versions from
					// overwriting each other in the downloads folder.
					href: `${apiBase()}/missions/${encodeURIComponent(missionId)}/report.md`
						+ (reportVersion > 0 ? `?version=${reportVersion}` : ""),
					download: `${missionId}${shownVersion > 0 ? `-v${shownVersion}` : ""}.md`,
					style: { ...controlStyle(), height: "28px", padding: "0 10px", fontSize: "12px", flex: "none", display: "inline-flex", alignItems: "center", textDecoration: "none" },
					children: zh ? "下载 .md" : "Download .md"
				}, "download")
			].filter((entry) => entry !== null);

			return jsx("div", {
				// The frame does not scroll. The header row, the notices, the stage ruler
				// and the tab strip are the reader's fixed point — which mission this is,
				// how far it got, and how to leave — and they used to scroll away with the
				// pane under them.
				style: { height: "100%", minHeight: 0, display: "flex", flexDirection: "column" },
				children: jsxs("div", {
					// The trajectory is the two-pane reader this cap was written
					// for: a list and a panel side by side, both of which lose
					// their arguments column first when the frame narrows. The
					// report is prose and keeps the cap, because a 1600px line of
					// text is not a wider report, it is an unreadable one.
					style: {
						// Every pane takes the frame. The 1080px cap was written for a
						// column of prose read on its own; here it leaves a band of dead
						// page down the right of a screen whose panes are tables, lists
						// and a two-pane reader. The report keeps its own measure on the
						// paragraph itself, where a measure belongs.
						...WIDE_STYLE,
						padding: "0 24px", height: "100%", minHeight: 0, flex: "1 1 auto",
						display: "flex", flexDirection: "column"
					},
					children: [
						// ONE ROW: back, title, status, actions. This was four stacked
						// blocks, and with the banner and the tab strip under them the
						// first row of actual content began 396px down a 1050px
						// screen — thirty-eight per cent of the window spent on
						// chrome, above a list whose whole value is how many rows fit.
						jsxs("div", {
							style: { display: "flex", alignItems: "center", gap: "8px", margin: "0 0 4px", minHeight: "30px" },
							children: [
								jsx("button", {
									type: "button",
									style: { ...controlStyle(), height: "28px", padding: "0 10px", fontSize: "12px", flex: "none" },
									onClick: onBack,
									children: zh ? "← 任务" : "← Missions"
								}, "back"),
								jsx("h2", {
									style: {
										margin: 0, flex: "0 1 auto", minWidth: "60px",
										overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
										fontSize: "16px", lineHeight: "24px", fontWeight: 600,
										color: "var(--dsw-alias-label-primary)"
									},
									title: mission.topic,
									children: mission.topic
								}, "topic"),
								jsx("span", {
									style: {
										flex: "none", padding: "1px 8px", borderRadius: "6px",
										background: `rgba(${face.hue},0.12)`, color: `rgb(${face.hue})`,
										fontSize: "11px", fontWeight: 600, whiteSpace: "nowrap"
									},
									children: face.note === "" ? face.label : `${face.label} · ${face.note}`
								}, "pill"),
								jsx("span", { style: { flex: 1, minWidth: "8px" } }, "spacer"),
								...missionActions
							]
						}, "bar"),
						jsx("div", { style: { ...META_STYLE, margin: "0 0 8px" }, children: meta }, "meta"),

						notice === "" ? null : jsx("div", {
							style: { margin: "0 0 12px", fontSize: "12px", lineHeight: "18px", color: "var(--dsw-alias-label-secondary)" },
							children: notice
						}, "notice"),
						actionError === "" ? null : jsx("div", {
							style: { margin: "0 0 12px", fontSize: "12px", lineHeight: "18px", color: "rgb(220,38,38)" },
							children: actionError
						}, "actionError"),
						// A refresh that failed over a view we already have. Without
						// this line the page keeps drawing the last good answer with
						// a clock that never moves, which is the most convincing
						// wrong screen this tab can produce.
						state !== "error" ? null : jsx("div", {
							style: { margin: "0 0 12px", fontSize: "12px", lineHeight: "18px", color: "rgb(217,119,6)" },
							children: (zh ? "这一次刷新失败了，下面是上一次读到的状态：" : "The latest refresh failed; what follows is the last state that was read: ") + error
						}, "staleView"),
						// The mission's own failure, with the code beside it. The
						// code is what makes a failure countable across missions;
						// the sentence is what makes this one actionable.
						(mission.errorMessage ?? "") === "" && (mission.failureCode ?? null) === null ? null : jsx(MissionFailureNote, {
							code: mission.failureCode ?? null,
							message: mission.errorMessage ?? "",
							zh
						}, "failure"),
						// Sign-off, when there is one. `signed: null` means s11 never
						// ran; `false` means the Leader read the report and refused.
						// Different failures, different next actions.
						mission.signed === null || mission.signed === undefined ? null : jsx("div", {
							style: { margin: "0 0 14px", fontSize: "13px", lineHeight: "20px", color: "var(--dsw-alias-label-primary)" },
							children: mission.signed
								? (zh ? `领队已签署，评分 ${mission.score ?? "—"}${(mission.verdict ?? "") === "" ? "" : `（${mission.verdict}）`}。` : `Signed off by the leader at ${mission.score ?? "—"}${(mission.verdict ?? "") === "" ? "" : ` (${mission.verdict})`}.`)
								: (zh ? `领队读过报告后拒绝签署，评分 ${mission.score ?? "—"}。报告仍然可读。` : `The leader read the report and declined to sign it, at ${mission.score ?? "—"}. The report is still readable.`)
						}, "signature"),
						// Not when the banner above already said why. "The mission
						// ended without a report" under "budget_exhausted: calls
						// reached 40 of 40" is the same sentence twice, and the
						// second one costs a row of the list below it.
						hasReport || (mission.errorMessage ?? "") !== "" ? null : jsx("div", {
							style: { margin: "0 0 14px", fontSize: "12px", lineHeight: "18px", color: "var(--dsw-alias-label-secondary)" },
							// Three reasons, three sentences. A sentinel that means
							// both "not yet" and "we tried and it did not land" is a
							// default wearing a costume.
							children: artifact.reason === "write-failed"
								? (zh ? "报告写失败了：任务已经结束，但没有落下任何一版报告。" : "The artefact write failed: the mission ended and no version was stored.")
								: artifact.reason === "terminal-without-artifact"
								? (zh ? "任务结束了，却没有留下报告 —— 每条结束路径都应该写一版，所以这是失败路径上的一个洞。" : "The mission ended without an artefact. Every terminal path is supposed to write one, so this is a hole in a failure path.")
								: (zh ? "报告还没有生成 —— 任务还没有走到归档那一步。" : "No report yet — the mission has not reached the persist stage.")
						}, "noArtifact"),


						// The detail is four screens, not one scroll. The trajectory needs
						// the height its side panel takes, and burying it under the stage
						// strip, the meters and five dimension cards is how it went
						// unnoticed. Every pane reads the same `view`; switching one does
						// not refetch.
						// The twelve-stage ruler, over every pane rather than inside one. The
						// projector guarantees the count is invariant, so this is a shape a
						// person learns once and then reads at a glance — which is worth
						// nothing if it is only visible on the tab they are not on. It was
						// defined, exported, and rendered nowhere at all.
						(view.stages ?? []).length === 0 ? null : jsx("div", {
							style: { margin: "0 0 10px" },
							children: jsx(MissionStageStrip, { stages: view.stages, zh })
						}, "ruler"),
						jsx(MissionDetailTabs, {
							pane: activePane, setPane, zh,
							findings: evidence.total ?? 0,
							steps: view.timeline?.lastEventSeq ?? null,
							stages: (view.stages ?? []).length,
							spend
						}, "panes"),

						// THE ONE SCROLLER on this screen. Everything above it stays put.
						jsxs("div", {
							// The bar belongs to the FRAME, not to a column inside it. The
						// scroller sat inside the page's 24px gutter, so its scrollbar
						// drew 24px in from the right edge — a rail floating in the
						// middle of the screen with dead page beside it. Negative
						// margin widens the scroll box to the frame edge; the padding
						// puts the content back where it was.
						style: {
							flex: "1 1 auto", minHeight: 0, overflowY: "auto",
							marginRight: "-24px", paddingRight: "24px", paddingBottom: "24px"
						},
							children: [
						...(activePane !== "tasks" ? [] : [
						jsx(MissionPanel, {
							bare: true,
							title: zh ? "任务" : "Tasks",
							note: "",
							children: jsx(MissionTaskBoard, {
								mission,
								stages: view.stages ?? [],
								work: view.work ?? [],
								agents: view.agents ?? [],
								zh,
								selected: task,
								onSelect: (stepId) => { setTask(stepId); },
								onOpenStage: (stepId) => { setFocusStep(stepId); setPane("trace"); }
							})
						}, "board"),
						preflight === null || (preflight.messages ?? []).length === 0 ? null : jsx(MissionPanel, {
							title: zh ? "核验风险" : "Verification risk",
							note: preflight.known
								? (zh ? "已经过核验阶段" : "measured after the verify stage")
								: (zh ? "核验阶段还没跑完，这是临时值" : "provisional: the verify stage has not run yet"),
							children: jsx("div", {
								style: { display: "flex", flexDirection: "column", gap: "6px" },
								children: preflight.messages.map((message, at) => jsx("div", {
									style: { fontSize: "12px", lineHeight: "18px", color: "var(--dsw-alias-label-secondary)" },
									children: message
								}, String(at)))
							})
						}, "preflight"),

						// The panel that keeps a failed mission from being a blank
						// screen. Shown whenever the run recorded that it verified
						// nothing, whatever the mission then went on to do.
						noEvidence === null ? null : jsx(MissionPanel, {
							title: zh ? "这次都试了什么" : "What was tried",
							note: zh ? "零条通过核验时留下的采集诊断" : "the collection diagnostics frozen when nothing verified",
							children: jsx(MissionTried, { report: noEvidence, zh })
						}, "tried"),
						// The projector's own health. Anomalies are things it had to
						// repair while reading — a stage still marked running on a
						// finished mission, a stage id the catalogue does not know —
						// and they are shown rather than silently smoothed over.
						(view.swept ?? []).length === 0 ? null : jsx(MissionPanel, {
							title: zh ? "读取时修正的异常" : "Anomalies repaired while reading",
							note: zh ? "这些是显示层的修补，不是任务本身的输出" : "display-time repairs, not the mission's own output",
							children: jsx("div", {
								style: { display: "flex", flexDirection: "column", gap: "6px" },
								children: view.swept.map((entry, at) => jsx("div", {
									style: { fontSize: "12px", lineHeight: "18px", color: "var(--dsw-alias-label-secondary)" },
									children: `${entry.kind} · ${entry.key} · ${entry.reason}`
								}, `${entry.kind}-${entry.key}-${at}`))
							})
						}, "swept")
						]),

						...(activePane !== "report" ? [] : [
						// The deliverable, in the frame rather than instead of it. It
						// used to replace the whole screen, which meant leaving the
						// report was leaving the mission — so the evidence behind a
						// sentence was two navigations away from the sentence.
						!hasReport ? jsx(MissionEmptyPane, {
							mission, zh,
							waiting: zh
								? "还没有生成报告 —— 任务还没有走到归档那一步。写好之后会出现在这里。"
								: "No report yet: the mission has not reached the persist stage. It appears here once it is written.",
							finished: zh
								? "还没有生成报告：这次运行结束了，却一版也没有落下 —— 每条结束路径都应该写一版，所以这是失败路径上的一个洞。"
								: "No report exists: this run ended without storing a version, and every terminal path is supposed to write one, so this is a hole in a failure path."
						}, "noReport") : jsx(MissionReport, {
							missionId, zh, onBack: null,
							version: reportVersion, onVersion: setReportVersion
						}, "report")
						]),
						...(activePane !== "sources" ? [] : [
						jsx(MissionPanel, {
							bare: true,
							title: zh ? "参考文献" : "References",
							note: "",
							children: jsx(MissionSources, { missionId, zh, mission })
						}, "sources")
						]),

						...(activePane !== "dimensions" ? [] : [
						(view.dimensions ?? []).length === 0 ? jsx(MissionEmptyPane, {
							mission, zh,
							waiting: zh
								? "还没有维度：等 Leader 把课题拆开，维度和它们的证据会一个个出现。"
								: "No dimensions yet: once the leader breaks the topic apart, they and their evidence appear here one at a time.",
							finished: zh
								? "这次运行没有留下任何维度，也就没有任何证据可看。"
								: "This run recorded no dimensions at all, so there is no evidence to read."
						}, "noDimensions") : jsx(MissionPanel, {
							bare: true,
							title: zh ? "维度" : "Dimensions",
							// The counts stay — they are facts about this mission — but
							// the instruction ("open a dimension to read them") does
							// not: the cards say 看这 N 条证据 on themselves.
							note: zh
								? `已核验 ${evidence.verified ?? 0} 条 · 共 ${evidence.total ?? 0} 条发现`
								: `${evidence.verified ?? 0} verified of ${evidence.total ?? 0} findings`,
							children: jsx(MissionDimensions, {
								missionId, dimensions: view.dimensions, zh,
								onOpenSource: (entry) => { setSource(entry); }
							})
						}, "dimensions")
						]),

						...(activePane !== "trace" ? [] : [
						// The trajectory, in place of the event tail that used to sit
						// here. The tail showed one of the four things a mission does
						// and none of the three that answer "why did this dimension
						// come back empty" — the tool calls with their arguments, the
						// findings with their quotes, and the stage transitions those
						// two happened under.
						jsx(MissionPanel, {
							bare: true,
							title: zh ? "轨迹" : "Trajectory",
							// The sentence explaining what a trajectory is belongs on
							// the tab that opens it, not on a line above it that is
							// re-read every single visit.
							note: "",
							children: jsx(MissionTrace, {
								missionId, zh,
								live: !mission.terminal,
								timeline: view.timeline,
								focusStep,
								onOpenSource: (entry) => { setSource(entry); }
							})
						}, "trace")
						]),

						...(activePane !== "cost" ? [] : [
						jsx(MissionPanel, {
							title: zh ? "额度" : "Allowances",
							note: zh ? "上限在建立任务时冻结，之后每个阶段都读同一行" : "the ceilings were frozen when the mission was opened",
							children: jsx(MissionCostMeters, { cost: view.cost ?? {}, zh })
						}, "cost"),
						(view.cost?.byStage ?? []).length === 0 ? null : jsx(MissionPanel, {
							title: zh ? "哪一步花的" : "Which stage spent it",
							note: zh
								? "按阶段分解 —— 一份总数说不出是哪一步在烧"
								: "broken down by stage — one total cannot say which step is burning it",
							children: jsx(MissionStageSpend, { byStage: view.cost.byStage, zh })
						}, "byStage"),
						(view.cost?.byTool ?? []).length === 0 ? null : jsx(MissionPanel, {
							title: zh ? "哪个工具在失败" : "Which tool is failing",
							note: zh
								? "失败和缓存都算在调用里 —— 一次失败的抓取和一次命中缓存都花了额度"
								: "failures and cache hits are calls too — both spent the allowance",
							children: jsx(MissionToolTable, { byTool: view.cost.byTool, zh })
						}, "byTool"),
						(view.agents ?? []).length === 0 ? null : jsx(MissionPanel, {
							title: zh ? "谁花的" : "Who spent it",
							note: zh
								? "按执行者分解 —— 一份总数说不出哪个维度在返工"
								: "broken down by agent — one total cannot say which dimension was redoing its work",
							children: jsx(MissionAgentTable, { agents: view.agents, zh })
						}, "agents")
						])
							]
						}, "paneBody")
					]
				})
			});
		}
		//#endregion

		//#region missions report
		/**
		* The kind an evidence source is read under.
		*
		* `DocumentView` colours itself from `kind.hue` and would throw on an
		* undefined kind, taking the whole pane blank — and a mission cites
		* whatever the open web served it, which is not one of the 信源 kinds at
		* all. A neutral entry is the difference between a grey badge and a
		* reader that renders nothing.
		*/
		const MISSION_SOURCE_KIND = { id: "other", type: "", en: "Source", zh: "信源", hue: "100,116,139" };

		/**
		* One frozen piece of evidence: what was claimed, the sentence it rests
		* on, and the address a reader can open.
		*
		* The blob is frozen at persist time on purpose — the live findings and
		* documents move on, and a report nobody can check later is not a report.
		* So the quote is shown verbatim, the source is named, and the link goes
		* to the page the quote was verified against rather than to anything this
		* page reconstructed.
		* @param row - one entry of `artifact.evidence`.
		* @param zh - whether to write Chinese.
		*/
		function MissionEvidenceRow({ row, zh, onOpen }) {
			const verified = String(row.verifyState ?? "").startsWith("verified");
			const accent = verified ? "5,150,105" : "217,119,6";
			const name = (row.sourceTitle ?? "") !== "" ? row.sourceTitle
				: (row.sourceHost ?? "") !== "" ? row.sourceHost
				: hostOf(row.sourceUrl ?? "");
			const openable = typeof row.sourceUrl === "string" && row.sourceUrl !== "";

			return jsxs("div", {
				style: {
					display: "flex", alignItems: "flex-start", gap: "9px",
					padding: "8px 10px", borderRadius: "8px", background: `rgba(${accent},0.06)`
				},
				children: [
					jsx("span", {
						style: { flex: "none", color: `rgb(${accent})`, fontSize: "13px", lineHeight: "20px" },
						children: verified ? "✓" : "!"
					}, "mark"),
					jsxs("div", {
						style: { flex: 1, minWidth: 0, display: "flex", flexDirection: "column", gap: "3px" },
						children: [
							jsx("div", {
								style: { fontSize: "13px", lineHeight: "20px", color: "var(--dsw-alias-label-primary)" },
								children: row.claim
							}, "claim"),
							jsx("div", {
								style: { fontSize: "12px", lineHeight: "19px", color: "var(--dsw-alias-label-secondary)" },
								children: `“${row.quote}”`
							}, "quote"),
							jsxs("div", {
								style: { display: "flex", alignItems: "center", gap: "8px", flexWrap: "wrap", fontSize: "11px", color: "var(--dsw-alias-label-secondary)" },
								children: [
									jsx("span", { children: missionFace(MISSION_VERIFY_FACES, row.verifyState, zh) }, "state"),
									jsx("span", { children: name }, "name"),
									row.fetchedAt === null || row.fetchedAt === undefined ? null
										: jsx("span", { children: (zh ? "抓取于 " : "fetched ") + formatStamp(row.fetchedAt) }, "fetched"),
									// Two ways to follow the quote, because they answer
									// two questions. The reader is 信源's own — the
									// Host half re-fetches the page and extracts it —
									// and answers "does the page still say this". The
									// plain link answers "what else is on that page",
									// which an extractor cannot.
									//
									// An address that did not survive is neither: the
									// row still shows its quote and simply does not
									// offer a control it cannot honour, because a
									// button that fails quietly when pressed is the
									// same lie as a report that cites what it cannot
									// show.
									!openable ? jsx("span", {
										children: zh ? "证据里没有带回可打开的地址" : "no openable address travelled with this evidence"
									}, "noUrl") : jsx("button", {
										type: "button",
										onClick: () => { onOpen(row); },
										style: {
											appearance: "none", border: "none", background: "transparent", padding: 0,
											color: `rgb(${accent})`, font: "inherit", fontSize: "11px", cursor: "pointer"
										},
										children: (zh ? "在阅读器里打开 · " : "Open in the reader · ") + hostOf(row.sourceUrl)
									}, "open"),
									!openable ? null : jsx("a", {
										href: row.sourceUrl,
										target: "_blank",
										rel: "noreferrer noopener",
										style: { color: "var(--dsw-alias-label-secondary)", textDecoration: "none" },
										children: zh ? "原始链接" : "Original link"
									}, "raw")
								]
							}, "meta")
						]
					}, "body")
				]
			});
		}

		/**
		* How many times `[N]` stands in the prose.
		*
		* A marker followed by `(` is a Markdown link whose text happens to be a
		* number, not a citation, and counting it would tell the reader this source is
		* leaned on once more than it is.
		* @param markdown - the report body.
		* @param index - the citation number.
		* @returns the count.
		*/
		function missionMarkerCount(markdown, index) {
			const needle = `[${index}]`;
			let found = 0;
			let at = markdown.indexOf(needle);
			while (at >= 0) {
				if (markdown[at + needle.length] !== "(") found += 1;
				at = markdown.indexOf(needle, at + needle.length);
			}
			return found;
		}

		/**
		* The report's numbered sources, joined from the two halves already stored.
		*
		* `artifact.citations` carries the index, the address and the finding it came
		* from; `artifact.evidence` carries that finding's verified quote, its title and
		* its fetch stamp. Neither half is a reference list on its own — a list built
		* from citations alone is a column of bare URLs, which is what a reader gets
		* today — and the join is on `findingId`, measured 11/11 on a live artefact.
		*
		* An index that will not join is kept and marked rather than dropped: a missing
		* entry turns `[7]` in the prose into a pointer to nothing, and a reader cannot
		* tell that from a numbering mistake.
		* @param artifact - the artefact row from `/missions/:id/artifact`.
		* @returns `[{index, url, host, title, quote, verifyState, fetchedAt, status, joined, inText}]`, in citation order.
		*/
		function missionReferences(artifact) {
			const citations = Array.isArray(artifact?.citations) ? artifact.citations : [];
			const evidence = Array.isArray(artifact?.evidence) ? artifact.evidence : [];
			const markdown = typeof artifact?.markdown === "string" ? artifact.markdown : "";
			const byFinding = new Map();
			for (const row of evidence) {
				const id = row?.findingId ?? null;
				if (id === null || byFinding.has(id)) continue;
				byFinding.set(id, row);
			}

			// Keyed by index rather than pushed: s12 writes one citation row per
			// occurrence, so a source leaned on six times arrives six times and a list
			// built from the array would print `[3]` six times over.
			const seen = new Map();
			for (const citation of citations) {
				const index = Number(citation?.index);
				if (!Number.isFinite(index) || seen.has(index)) continue;
				const backing = byFinding.get(citation?.findingId ?? null) ?? null;
				const url = String(citation?.url ?? backing?.sourceUrl ?? "");
				seen.set(index, {
					index,
					url,
					title: (backing?.sourceTitle ?? "") === "" ? "" : backing.sourceTitle,
					host: (backing?.sourceHost ?? "") === "" ? hostOf(url) : backing.sourceHost,
					quote: backing?.quote ?? citation?.inlineQuote ?? "",
					verifyState: backing?.verifyState ?? null,
					fetchedAt: backing?.fetchedAt ?? null,
					status: backing?.status ?? null,
					joined: backing !== null,
					inText: missionMarkerCount(markdown, index)
				});
			}
			return [...seen.values()].sort((a, b) => a.index - b.index);
		}

		/**
		* Why a version was archived degraded, in the words the run itself recorded.
		*
		* What stood here was one either/or sentence — the guard fired OR the leader
		* refused — printed identically for both, which told the reader that something
		* is wrong and nothing about what. Every field below was already on disk: the
		* guard's violations ride on the terminal event, the refusal and its reason are
		* s11's own signature.
		* @param reason - `artifact.degradeReason`, or null from an older Host half.
		* @param zh - whether to write Chinese.
		*/
		function MissionDegradeNote({ reason, zh }) {
			const lines = [];
			if (reason === null || reason === undefined) {
				// Not a guess. An older server sends no reason at all, and inventing the
				// either/or sentence back would be this page claiming to know something
				// it was not told.
				lines.push(zh
					? "这台机器上的服务端还没有给出降级原因 —— 它跑的是较旧的版本。"
					: "This server did not say why: it is running an older build.");
			} else {
				const violations = Array.isArray(reason.guardViolations) ? reason.guardViolations : [];
				if (violations.length > 0) {
					lines.push(zh ? `内容闸门拦下 ${violations.length} 处：` : `The content guard raised ${violations.length}:`);
					for (const violation of violations) {
						const detail = (violation?.detail ?? "") === "" ? "" : (zh ? "：" : " — ") + violation.detail;
						lines.push("· " + missionFace(MISSION_GUARD_FACES, violation?.code, zh) + detail);
					}
				}
				if (reason.signed === false) {
					lines.push((zh
						? `领队读过报告后拒绝签署，评分 ${reason.score ?? "—"}。`
						: `The leader read the report and declined to sign it, at ${reason.score ?? "—"}.`)
						+ ((reason.refusalReason ?? "") === "" ? "" : (zh ? "理由：" : " Reason: ") + reason.refusalReason));
				} else if (reason.signed === null || reason.signed === undefined) {
					lines.push(zh
						? "签署阶段没有跑到，这份报告没有人签过字。"
						: "The sign-off stage was never reached, so nobody put their name to this report.");
				}
				if ((reason.accountabilityNote ?? "") !== "") {
					lines.push((zh ? "领队留下的话：" : "The leader's own note: ") + reason.accountabilityNote);
				}
				if ((reason.failureCode ?? null) !== null) {
					lines.push(missionFace(MISSION_FAILURE_FACES, reason.failureCode, zh));
				}
				// Nothing matched, and the flag is still set: print the guard's own
				// sentence rather than an empty warning box.
				if (lines.length === 0) {
					lines.push((reason.guardMessage ?? "") === ""
						? (zh ? "这一版被标成了降级，但归档时没有留下任何原因 —— 这本身是一处缺陷。" : "This version is flagged degraded and no reason was recorded with it, which is itself a defect.")
						: reason.guardMessage);
				}
			}
			return jsxs("div", {
				style: {
					margin: "0 0 12px", padding: "8px 11px", borderRadius: "8px",
					background: "rgba(217,119,6,0.08)", border: "1px solid rgba(217,119,6,0.25)",
					fontSize: "12px", lineHeight: "19px", color: "var(--dsw-alias-label-primary)"
				},
				children: [
					jsx("div", {
						style: { fontWeight: 600, color: "rgb(217,119,6)" },
						children: zh ? "这一版是降级归档的。" : "This version was stored degraded."
					}, "lead"),
					...lines.map((line, at) => jsx("div", { children: line }, `l${at}`)),
					jsx("div", {
						style: { color: "var(--dsw-alias-label-secondary)" },
						children: zh
							? "报告仍然写出来了，就是为了让你能看见问题出在哪。"
							: "It was written anyway so the problem is readable."
					}, "why")
				]
			});
		}

		/**
		* The report's 参考文献 list: one entry per citation index, with a real source
		* behind it.
		*
		* Each entry carries the id the markers scroll to, so `[3]` in the prose and
		* the third entry here are the same object as far as the reader is concerned.
		* The verified quote is printed under the address because that — not the
		* address — is what a person checks a citation against.
		* @param references - `missionReferences`'s answer.
		* @param zh - whether to write Chinese.
		*/
		function MissionReferenceList({ references, zh }) {
			return jsxs("div", {
				style: { maxWidth: "760px", margin: "0 0 18px" },
				children: [
					jsx("h3", {
						style: {
							margin: "0 0 10px", fontSize: "15px", fontWeight: 700,
							fontFamily: ARTICLE_SERIF, color: "var(--dsw-alias-label-primary)"
						},
						children: zh ? "参考文献" : "References"
					}, "head"),
					jsx("div", {
						style: { display: "flex", flexDirection: "column", gap: "10px" },
						children: references.map((entry) => jsxs("div", {
							id: `ref-${entry.index}`,
							style: {
								display: "flex", alignItems: "flex-start", gap: "8px",
								fontSize: "12px", lineHeight: "19px", color: "var(--dsw-alias-label-secondary)"
							},
							children: [
								jsx("span", {
									style: { flex: "none", minWidth: "26px", fontFamily: MISSION_MONO, color: "var(--dsw-alias-label-primary)" },
									children: `[${entry.index}]`
								}, "index"),
								jsxs("span", {
									style: { flex: 1, minWidth: 0, display: "flex", flexDirection: "column", gap: "2px" },
									children: [
										entry.url === "" ? jsx("span", {
											style: { color: "var(--dsw-alias-label-tertiary)" },
											children: zh ? "这条引用没有留下地址。" : "No address was stored for this citation."
										}, "noUrl") : jsx("a", {
											href: entry.url,
											target: "_blank",
											rel: "noreferrer noopener",
											style: { color: "var(--dsw-alias-state-business-primary)", textDecoration: "none" },
											// The title where there is one, the host where there is not — never a
											// bare address as a name. A column of URLs is what a citation list built
											// from `citations` alone looks like, and it is unreadable.
											children: entry.title !== "" ? entry.title : entry.host !== "" ? entry.host : entry.url
										}, "link"),
										jsx("div", {
											style: { fontSize: "11px", fontFamily: MISSION_MONO, color: "var(--dsw-alias-label-tertiary)" },
											children: [
												entry.host,
												zh ? `文中 ${entry.inText} 处` : `cited ${entry.inText}× in the text`,
												entry.verifyState === null ? "" : missionFace(MISSION_VERIFY_FACES, entry.verifyState, zh),
												entry.status === null || entry.status === undefined ? "" : `HTTP ${entry.status}`,
												entry.fetchedAt === null ? "" : formatStamp(entry.fetchedAt)
											].filter((piece) => piece !== "" && piece !== null && piece !== undefined).join(" · ")
										}, "meta"),
										!entry.joined ? jsx("div", {
											style: { color: "rgb(217,119,6)" },
											children: zh
												? "引用元数据缺失：这个编号没有对上任何一条冻结证据，所以引语和核验状态都查不到。"
												: "Citation metadata missing: this index matched no frozen evidence row, so neither the quote nor its verify state can be shown."
										}, "unjoined") : entry.quote === "" ? null : jsx("div", {
											style: { color: "var(--dsw-alias-label-secondary)" },
											children: `“${entry.quote}”`
										}, "quote")
									]
								}, "body")
							]
						}, `ref-${entry.index}`))
					}, "list")
				]
			});
		}

		/**
		* The report, its scorecard, and every quote under it.
		*
		* The markdown is read from `/missions/:id/artifact` rather than
		* reassembled here: `assemble()` is the Host half's, it is deterministic,
		* and a second assembler in the browser is a second document that would
		* drift from the one the sign-off was given against.
		* @param missionId - the mission.
		* @param zh - whether to write Chinese.
		* @param onBack - return to the detail view.
		*/
		function MissionReport({ missionId, zh, onBack, version: pinned, onVersion }) {
			// WHOSE VERSION THIS IS. The download control lives on the mission's
			// header row, one frame up, and a reader looking at v1 who presses it and
			// gets v3 has been handed a different document than the one on screen. So
			// the frame may own the choice; kept here when it does not, because this
			// component is also readable on its own.
			const [ownVersion, setOwnVersion] = useState(0);
			const version = typeof pinned === "number" ? pinned : ownVersion;
			const setVersion = typeof onVersion === "function" ? onVersion : setOwnVersion;
			const [artifact, setArtifact] = useState(null);
			const [versions, setVersions] = useState([]);
			const [state, setState] = useState("loading");
			const [error, setError] = useState("");
			const [showEvidence, setShowEvidence] = useState(true);
			// report | source, switched in place: the same arrangement 信源 uses
			// when a card is opened, so the frame never moves under the reader.
			const [source, setSource] = useState(null);

			useEffect(() => {
				let alive = true;
				const query = version === 0 ? "" : `?version=${version}`;
				fetch(`${apiBase()}/missions/${encodeURIComponent(missionId)}/artifact${query}`)
					.then(missionData)
					.then((data) => {
						if (!alive) return;
						setArtifact(data.artifact ?? null);
						setVersions(Array.isArray(data.versions) ? data.versions : []);
						setState("ready");
					})
					.catch((cause) => {
						if (!alive) return;
						setError(String(cause?.message ?? cause));
						setState("error");
					});
				return () => { alive = false; };
			}, [missionId, version]);

			// Null when the report is a PANE rather than a screen: there is
			// nothing to go back to, because the mission is still around it. A
			// back button that unmounts the tab strip it lives under is worse
			// than no back button.
			const back = onBack === null || onBack === undefined ? null : jsx("button", {
				type: "button", style: controlStyle(), onClick: onBack,
				children: zh ? "← 返回任务" : "← Back to the mission"
			}, "back");

			// The source behind one quote, read through 信源's own reader: the
			// Host half re-fetches the page and extracts it, which is the only
			// way to answer "does that page still say this" from here. One reader,
			// shared with the mission's own trajectory — a second one written for
			// missions would be a second answer to that question.
			if (source !== null) {
				return jsx(MissionSourceReader, {
					source, zh,
					back: zh ? "← 返回报告" : "← Back to the report",
					onBack: () => { setSource(null); }
				});
			}

			if (state === "loading") {
				return jsx("div", { style: NOTE_STYLE, children: zh ? "加载中…" : "Loading…" });
			}
			if (state === "error") {
				return jsxs("div", {
					style: { ...CONTENT_STYLE, padding: "0 24px" },
					children: [back, jsx("div", {
						style: { ...NOTE_STYLE, marginTop: "14px" },
						children: (zh ? "读不到这份报告：" : "Could not read this report: ") + error
					}, "note")]
				});
			}
			if (artifact === null || artifact.kind === "empty-artifact") {
				return jsxs("div", {
					style: { ...CONTENT_STYLE, padding: "0 24px" },
					children: [back, jsx("div", {
						style: { ...NOTE_STYLE, marginTop: "14px" },
						children: artifact?.reason === "write-failed"
							? (zh ? "报告写失败了：任务已经结束，但没有落下任何一版。" : "The artefact write failed: the mission ended and no version was stored.")
							: artifact?.reason === "no-such-version"
							? (zh ? "没有这一版报告。" : "There is no such version.")
							: (zh ? "还没有生成报告。" : "No report has been produced yet.")
					}, "note")]
				});
			}

			const quality = artifact.quality ?? {};
			// Built once, read twice: the markers in the prose ask whether an index has
			// anything behind it, and the list under the article is the same set.
			const references = missionReferences(artifact);
			const numbered = new Set(references.map((entry) => entry.index));
			const evidence = Array.isArray(artifact.evidence) ? artifact.evidence : [];
			const citations = Array.isArray(artifact.citations) ? artifact.citations : [];
			const tallies = [
				["evidenced", zh ? "有据章节" : "Evidenced"],
				["interpretive", zh ? "解读章节" : "Interpretive"],
				["unplaced", zh ? "无法归章" : "Unplaced"]
			].filter(([key]) => Number(quality[key]?.total ?? 0) > 0);

			// NOT a scroller. The report is a pane inside the mission frame now, and a
			// scroller inside a scroller is the arrangement where the header scrolls
			// away in one pane and stays in the next.
			return jsx("div", {
				style: { minHeight: 0 },
				children: jsxs("div", {
					style: { ...CONTENT_STYLE, padding: onBack === null || onBack === undefined ? 0 : "0 24px 24px" },
					children: [
						// The version row only exists when it has something to offer. With
						// the report a pane rather than a screen there is no back button,
						// and with one version there is nothing to switch between — so it
						// rendered as an empty band with a pill parked at the far right.
						// The version itself moves into the meta line under the title,
						// where the rest of the facts about this artefact already are.
						back === null && versions.length <= 1 ? null : jsxs("div", {
							style: { display: "flex", alignItems: "center", gap: "8px", flexWrap: "wrap", margin: "0 0 12px" },
							children: [
								back,
								jsx("span", { style: { flex: 1 } }, "spacer"),
								...versions.map((entry) => jsx("button", {
									type: "button",
									role: "tab",
									"aria-selected": entry.version === artifact.version,
									style: chipStyle({ hue: entry.degraded ? "217,119,6" : "100,116,139" }, entry.version === artifact.version),
									onClick: () => { setVersion(entry.version); },
									children: (zh ? `第 ${entry.version} 版` : `v${entry.version}`)
										+ (entry.degraded ? (zh ? " · 降级" : " · degraded") : "")
								}, String(entry.version)))
							]
						}, "versions"),
						jsx("h2", {
							style: { margin: "0 0 6px", fontSize: "20px", lineHeight: "28px", fontWeight: 600, color: "var(--dsw-alias-label-primary)" },
							children: artifact.title
						}, "title"),
						jsx("div", {
							style: { ...META_STYLE, margin: "0 0 6px" },
							children: [
								zh ? `${artifact.wordCount} 字` : `${artifact.wordCount} words`,
								zh ? `${citations.length} 处引用` : `${citations.length} citation(s)`,
								zh ? `${evidence.length} 条冻结证据` : `${evidence.length} frozen evidence row(s)`,
								artifact.trigger === null || artifact.trigger === undefined ? "" : String(artifact.trigger),
								versions.length > 1 ? "" : (zh ? `第 ${artifact.version ?? 1} 版` : `v${artifact.version ?? 1}`),
								formatStamp(artifact.createdAt)
							].filter((piece) => piece !== "").join(" · ")
						}, "meta"),
						!artifact.degraded ? null : jsx(MissionDegradeNote, { reason: artifact.degradeReason ?? null, zh }, "degraded"),
						// Per section type, never averaged. "Chapter seven has zero
						// citations" has to stay visible instead of disappearing
						// into a healthy-looking overall ratio.
						Number(quality.total ?? 0) === 0
							? jsx("div", {
								style: { margin: "0 0 12px", fontSize: "12px", lineHeight: "18px", color: "rgb(220,38,38)" },
								children: zh
									? "核验记分卡是空的：一处引用都没有核验过。这不是“没有发现问题”，这是没有检查过。"
									: "The scorecard is empty: not one citation was checked. That is not a clean bill — nothing was verified at all."
							}, "noScore")
							: jsx("div", {
								style: { display: "flex", flexWrap: "wrap", gap: "8px", margin: "0 0 14px" },
								children: tallies.map(([key, label]) => {
									const tally = quality[key] ?? {};
									return jsx("span", {
										style: {
											padding: "2px 9px", borderRadius: "6px",
											border: "1px solid var(--dsw-alias-border-l2)",
											fontSize: "11px", color: "var(--dsw-alias-label-secondary)"
										},
										children: `${label} · ` + (zh
											? `${tally.verified}/${tally.total} 已核验，未通过 ${tally.unverified}，未检查 ${tally.unchecked}，被反驳 ${tally.contradicted}`
											: `${tally.verified}/${tally.total} verified, ${tally.unverified} unverified, ${tally.unchecked} unchecked, ${tally.contradicted} contradicted`)
									}, key);
								})
							}, "score"),
						jsx("div", {
							style: { maxWidth: "760px", margin: "0 0 18px" },
							children: renderMarkdown(artifact.markdown ?? "", "article", {
								zh,
								has: (index) => numbered.has(index),
								// The browser's own anchor, not a router: the list is on this page, and
								// a marker that navigated would lose the reader's place in the prose.
								jump: (index) => {
									if (typeof document?.getElementById !== "function") return;
									document.getElementById(`ref-${index}`)?.scrollIntoView?.({ behavior: "smooth", block: "start" });
								}
							})
						}, "body"),
						references.length === 0 ? null : jsx(MissionReferenceList, { references, zh }, "references"),
						jsxs("div", {
							style: { display: "flex", alignItems: "center", gap: "8px", margin: "0 0 10px" },
							children: [
								jsx("h3", {
									style: { margin: 0, fontSize: "13px", fontWeight: 600, color: "var(--dsw-alias-label-primary)" },
									children: zh ? "证据" : "Evidence"
								}, "title"),
								jsx("button", {
									type: "button",
									style: { ...controlStyle(), height: "27px", fontSize: "12px" },
									onClick: () => { setShowEvidence(!showEvidence); },
									children: showEvidence
										? (zh ? "收起" : "Hide")
										: (zh ? `展开 ${evidence.length} 条` : `Show ${evidence.length}`)
								}, "toggle")
							]
						}, "evidenceHead"),
						!showEvidence ? null : (evidence.length === 0
							? jsx("div", {
								style: { fontSize: "12px", lineHeight: "18px", color: "var(--dsw-alias-label-secondary)" },
								// An empty blob is only legal on a degraded artefact,
								// and "we looked and found nothing verifiable" is a
								// real answer — as long as it is said rather than
								// rendered as an empty list.
								children: zh
									? "这一版没有冻结任何证据 —— 也就是说这次运行没有产出一条通过核验的引语。"
									: "No evidence was frozen with this version: the run produced no quote that verified."
							}, "noEvidence")
							: jsx("div", {
								style: { display: "flex", flexDirection: "column", gap: "6px" },
								children: evidence.map((row, at) => jsx(MissionEvidenceRow, {
									row, zh, onOpen: (entry) => { setSource(entry); }
								}, `${String(row.findingId ?? "row")}-${at}`))
							}, "evidence"))
					]
				})
			});
		}
		//#endregion

		//#region publish tab
		/**
		* The 发布 tab: selected sources, spoken as a two-host conversation.
		*
		* Three steps, kept separate on purpose. Picking sources is cheap and
		* reversible. Writing the script costs one model call and produces
		* something worth READING before committing to the next step — a script
		* that misread the sources is obvious in ten seconds of reading and
		* invisible after ten minutes of synthesis. Only then does rendering
		* spend a request per turn.
		*
		* Collapsing them into one button would be a smaller interface that
		* wastes more: every bad script would cost the full render before anyone
		* could see it was bad.
		*/
		/**
		* One line describing the standing order: what it would draw on now, and
		* what it did last.
		*
		* The last run is reported by its OUTCOME rather than as "ran / did not
		* run", because the interesting failure is the quiet one — a morning
		* that produced nothing because three sources had not arrived reads
		* identically to a morning that never fired, and only one of those is
		* a problem worth touching.
		* @param schedule - the payload from `/publish/schedule`.
		* @param zh - whether to write Chinese.
		* @returns the line.
		*/
		/**
		* One line describing the last manual run, or "" when there has not been one.
		*
		* Separate from {@link scheduleNote} because the two answer different
		* questions and sharing a line would make a skip look like the schedule
		* had failed. The timer's record also must not be written by a manual
		* run: `publishLastRun` is what tells the timer a day is served, so a
		* manual run that wrote it would silently cancel the morning's.
		* @param schedule - the payload from `/publish/schedule`.
		* @param zh - whether to write Chinese.
		* @returns the line, or "".
		*/
		function manualNote(schedule, zh) {
			const run = schedule?.publishLastManualRun;
			if (run === null || run === undefined) return "";
			const when = formatStamp(run.at);
			if (typeof run.error === "string") {
				return (zh ? `立即生成 ${when} 失败：` : `Run now at ${when} failed: `) + run.error;
			}
			if (typeof run.skipped === "string") {
				return (zh ? `立即生成 ${when} 跳过：` : `Run now at ${when} skipped: `) + run.skipped;
			}
			const kinds = Array.isArray(run.made) ? run.made.map((entry) => entry.kind).join(zh ? "、" : ", ") : "";
			return zh
				? `立即生成 ${when}：用 ${run.sources} 条信源做了 ${kinds}。`
				: `Run now at ${when}: made ${kinds} from ${run.sources} source(s).`;
		}

		function scheduleNote(schedule, zh) {
			const parts = [];
			if (schedule.publishAt === "") {
				parts.push(zh ? "定时发布已关闭 —— 填入时间即可开启。" : "No standing order — set a time to start one.");
			} else {
				parts.push(zh
					? `现在有 ${schedule.waiting} 条新信源在等，少于 ${schedule.publishMinSources} 条就跳过当天。`
					: `${schedule.waiting} new source(s) waiting; a day with fewer than ${schedule.publishMinSources} is skipped.`);
			}
			const last = schedule.publishLastRun;
			if (last === null || last === undefined) {
				parts.push(zh ? "还没有跑过。" : "It has not run yet.");
			} else if (typeof last.error === "string") {
				parts.push((zh ? `上次 ${formatStamp(last.at)} 失败：` : `Last run ${formatStamp(last.at)} failed: `) + last.error);
			} else if (typeof last.skipped === "string") {
				parts.push((zh ? `上次 ${formatStamp(last.at)} 跳过：` : `Last run ${formatStamp(last.at)} skipped: `) + last.skipped);
			} else {
				parts.push(zh
					? `上次 ${formatStamp(last.at)} 用 ${last.sources} 条信源生成了一集。`
					: `Last run ${formatStamp(last.at)} made an episode from ${last.sources} source(s).`);
			}
			return parts.join(" ");
		}

		/**
		* A section heading that carries its own position in the sequence.
		*
		* Numbered because this tab IS a sequence — pick sources, write the
		* script, hear it — and the numbers are the only thing that says the
		* controls below must happen in order. Everything here used to sit in
		* one flat stack at one weight, which read as a settings page for a
		* process that is actually four steps.
		* @param step - the ordinal, or undefined for an unnumbered section.
		* @param title - the heading.
		* @param hint - optional right-aligned status.
		* @param accent - the kind colour to tint the ordinal with.
		*/
		function StepHeading({ step, title, hint, accent }) {
			return jsxs("div", {
				style: { display: "flex", alignItems: "center", gap: "9px", margin: "0 0 10px" },
				children: [
					step === undefined ? null : jsx("span", {
						style: {
							flex: "none", width: "19px", height: "19px", borderRadius: "50%",
							display: "inline-flex", alignItems: "center", justifyContent: "center",
							fontSize: "11px", fontWeight: 600, fontVariantNumeric: "tabular-nums",
							background: accent === undefined ? "var(--dsw-alias-interactive-bg-hover)" : `rgba(${accent}, 0.13)`,
							color: accent === undefined ? "var(--dsw-alias-label-secondary)" : `rgb(${accent})`
						},
						children: String(step)
					}),
					jsx("h3", {
						style: { margin: 0, fontSize: "13px", fontWeight: 600, color: "var(--dsw-alias-label-primary)" },
						children: title
					}),
					jsx("span", { style: { flex: 1 } }),
					hint === undefined || hint === "" ? null : jsx("span", {
						style: { fontSize: "11px", color: "var(--dsw-alias-label-secondary)", fontVariantNumeric: "tabular-nums" },
						children: hint
					})
				]
			});
		}

		/** `m:ss`, with the minutes unpadded the way a player shows them. */
		function clock(seconds) {
			if (!Number.isFinite(seconds) || seconds < 0) return "0:00";
			const whole = Math.floor(seconds);
			return `${Math.floor(whole / 60)}:${String(whole % 60).padStart(2, "0")}`;
		}

		/**
		* One episode: its row, and its player when it is the open one.
		*
		* Row and player are the same component because they share a control.
		* Split apart, the open episode grew TWO play buttons — one in the row
		* that selected it, one in the player below that started it — which is
		* not a layout problem but a model problem: the audio has one state and
		* was being offered two handles.
		*
		* The element is still an `<audio>`, kept out of sight. It does the
		* buffering, the ranged fetches, and the codec work; only its face is
		* replaced. `<audio controls>` arrives at the platform's own size, in
		* the platform's colours, with a three-dot menu offering downloads and
		* playback speed — browser chrome dropped into a designed page.
		* @param episode - the stored record.
		* @param open - whether this is the episode being listened to.
		* @param accent - `r,g,b` for the fill.
		* @param zh - whether to write Chinese.
		* @param onOpen - make this the open one.
		* @param onDelete - forget it.
		* @param last - suppresses the divider on the final row.
		*/
		function EpisodeRow({ episode, open, accent, zh, onOpen, onDelete, last }) {
			const audioRef = useRef(null);
			const [playing, setPlaying] = useState(false);
			const [at, setAt] = useState(0);
			// Seeded from the record rather than starting at zero. With
			// `preload="none"` the element knows no duration until playback
			// begins, so a ten-minute episode read "0:00 / 0:00" beside the
			// "10:28" printed on its own row — which looks exactly like a
			// player that failed to load.
			const [total, setTotal] = useState(Number.isFinite(episode.durationSeconds) ? episode.durationSeconds : 0);
			const [failed, setFailed] = useState(false);

			// Opening another episode stops this one. Two shows talking at once
			// is never what a click on a different title meant.
			useEffect(() => {
				if (open) return;
				const audio = audioRef.current;
				if (audio !== null && !audio.paused) audio.pause();
				setPlaying(false);
			}, [open]);

			const toggle = useCallback(() => {
				if (!open) { onOpen(); return; }
				const audio = audioRef.current;
				if (audio === null) return;
				if (audio.paused) {
					// A rejected play() is the usual autoplay refusal and must
					// not surface as a broken episode.
					void audio.play().then(() => { setPlaying(true); }).catch(() => { setPlaying(false); });
				} else {
					audio.pause();
					setPlaying(false);
				}
			}, [open, onOpen]);

			const seek = useCallback((event) => {
				const audio = audioRef.current;
				if (audio === null || !Number.isFinite(audio.duration)) return;
				const box = event.currentTarget.getBoundingClientRect();
				const ratio = Math.min(1, Math.max(0, (event.clientX - box.left) / box.width));
				audio.currentTime = ratio * audio.duration;
				setAt(audio.currentTime);
			}, []);

			const progress = total > 0 ? Math.min(1, at / total) : 0;

			return jsxs("div", {
				style: {
					borderBottom: last ? "none" : "1px solid var(--dsw-alias-border-l1)",
					background: open ? `rgba(${accent}, 0.035)` : "transparent",
					transition: "background 140ms ease"
				},
				children: [
					jsx("audio", {
						ref: audioRef,
						src: `${apiBase()}/publish/episodes/${encodeURIComponent(episode.id)}/audio`,
						preload: "none",
						style: { display: "none" },
						onLoadedMetadata: (event) => {
							// The element's own duration wins once it has one: the
							// recorded value is an encoder estimate, out by a second
							// or two.
							const measured = event.currentTarget.duration;
							if (Number.isFinite(measured) && measured > 0) setTotal(measured);
						},
						onTimeUpdate: (event) => { setAt(event.currentTarget.currentTime); },
						onEnded: () => { setPlaying(false); setAt(0); },
						onError: () => { setFailed(true); setPlaying(false); }
					}),
					jsxs("div", {
						style: { display: "flex", alignItems: "center", gap: "12px", padding: open ? "13px 15px 9px" : "11px 15px" },
						children: [
							jsx("button", {
								type: "button",
								"aria-label": playing ? (zh ? "暂停" : "Pause") : (zh ? "播放" : "Play"),
								disabled: failed,
								onClick: toggle,
								style: {
									flex: "none", width: "30px", height: "30px", borderRadius: "50%",
									border: "none", cursor: failed ? "not-allowed" : "pointer", padding: 0, lineHeight: 0,
									display: "inline-flex", alignItems: "center", justifyContent: "center",
									background: open ? `rgb(${accent})` : `rgba(${accent}, 0.1)`,
									color: open ? "#fff" : `rgb(${accent})`,
									transition: "background 140ms ease"
								},
								children: jsx("svg", {
									width: 12, height: 12, viewBox: "0 0 24 24", fill: "currentColor", "aria-hidden": "true",
									children: playing
										? jsx("path", { d: "M7 5h3.6v14H7zM13.4 5H17v14h-3.6z" })
										: jsx("path", { d: "M8 5.2v13.6L19 12z" })
								})
							}),
							jsx("button", {
								type: "button",
								onClick: () => { onOpen(); },
								style: {
									flex: 1, minWidth: 0, textAlign: "left", appearance: "none",
									border: "none", background: "transparent", padding: 0, cursor: "pointer",
									font: "inherit", fontSize: "13px", fontWeight: open ? 600 : 400,
									lineHeight: "19px", color: "var(--dsw-alias-label-primary)",
									// Truncated in the list, wrapped when open: the row
									// being listened to is worth two lines, the forty
									// below it are not.
									...(open ? {} : { overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" })
								},
								children: episode.title
							}),
							jsx("span", {
								style: {
									flex: "none", fontSize: "11px", fontVariantNumeric: "tabular-nums",
									color: "var(--dsw-alias-label-secondary)"
								},
								children: `${clock(episode.durationSeconds)} · ${formatStamp(episode.createdAt)}`
							}),
							jsx("button", {
								type: "button",
								"aria-label": zh ? "删除" : "Delete",
								title: zh ? "删除" : "Delete",
								onClick: () => { onDelete(); },
								style: {
									flex: "none", appearance: "none", border: "none", background: "transparent",
									padding: "2px", cursor: "pointer", lineHeight: 0, color: "var(--dsw-alias-label-tertiary)"
								},
								children: jsx("svg", {
									width: 13, height: 13, viewBox: "0 0 24 24", fill: "none",
									stroke: "currentColor", strokeWidth: 1.8, strokeLinecap: "round", "aria-hidden": "true",
									children: jsx("path", { d: "M5 7h14M10 7V5h4v2M9 7v11M15 7v11M6 7l1 13h10l1-13" })
								})
							})
						]
					}),
					!open ? null : jsxs("div", {
						style: { display: "flex", alignItems: "center", gap: "11px", padding: "0 15px 14px 57px" },
						children: [
							failed ? jsx("span", {
								style: { flex: 1, fontSize: "12px", color: "rgb(220,38,38)" },
								children: zh ? "音频无法加载" : "This audio would not load"
							}) : jsx("div", {
								role: "slider",
								"aria-label": zh ? "进度" : "Seek",
								"aria-valuenow": Math.round(progress * 100),
								tabIndex: 0,
								onClick: seek,
								style: {
									flex: 1, height: "4px", borderRadius: "2px", cursor: "pointer",
									background: "var(--dsw-alias-border-l2)", position: "relative"
								},
								children: jsx("div", {
									style: {
										position: "absolute", inset: "0 auto 0 0", width: `${progress * 100}%`,
										borderRadius: "2px", background: `rgb(${accent})`
									}
								})
							}),
							jsx("span", {
								style: {
									flex: "none", fontSize: "11px", fontVariantNumeric: "tabular-nums",
									color: "var(--dsw-alias-label-secondary)"
								},
								children: `${clock(at)} / ${clock(total)}`
							})
						]
					})
				]
			});
		}

		/**
		* Episodes fetched at a time.
		*
		* A daily schedule makes 365 a year and keeps every one; the newest
		* handful is what anybody looks at. The rest are one request away, and
		* the feed still carries all of them — which is where a back catalogue
		* actually belongs: a podcast client is built to hold hundreds and this
		* panel is not.
		*/
		const EPISODE_PAGE = 6;

		/** Documents fetched at a time, for the same reason as episodes. */
		const DOCUMENT_PAGE = 8;

		/** The − and + of a stepper: same weight, same box, no platform spinner. */
		const STEPPER_BUTTON = {
			appearance: "none", border: "none", background: "transparent",
			width: "28px", height: "28px", cursor: "pointer", font: "inherit",
			fontSize: "14px", lineHeight: 1, color: "var(--dsw-alias-label-secondary)"
		};

		/**
		* The display name for a stored type.
		* @param type - the stored resource type.
		* @param zh - whether to write Chinese.
		* @returns the label, or the raw type when it is one this panel does not chip.
		*/
		function kindLabel(type, zh) {
			const found = KINDS.find((candidate) => candidate.type === type);
			return found === undefined ? String(type ?? '') : (zh ? found.zh : found.en);
		}

		/** How many search hits the add-a-source field offers at once. */
		const SUGGEST_LIMIT = 8;

		/**
		* Adding sources to an episode: a field you search, not a library you browse.
		*
		* Two earlier attempts were wrong in opposite directions. The first put
		* a checkbox list here — the library rendered a second time, worse, with
		* no search and no filters over twenty thousand rows. The second moved
		* selection into the 信源 tab, taxing a reading surface with a mode most
		* visits never enter. Both shared a premise that turns out to be false:
		* that choosing sources requires BROWSING them.
		*
		* It does not. By the time you are making a specific episode you already
		* know roughly what belongs in it, so the interaction is the one for
		* attaching a file — type, recognize, add — and the list that matters is
		* the short one you have built, not the long one you searched. That also
		* happens to be the only shape indifferent to how large the library gets.
		* @param zh - whether to write Chinese.
		* @param picked - the current selection, keyed by resource id.
		* @param onPick - toggles one row.
		* @param accent - `r,g,b` for the highlight.
		*/
		function SourceField({ zh, picked, onPick, accent }) {
			const [term, setTerm] = useState("");
			const [query, setQuery] = useState("");
			const [matches, setMatches] = useState([]);
			const [busy, setBusy] = useState(false);
			const [failed, setFailed] = useState("");
			const [focused, setFocused] = useState(false);

			// Debounced: typing a phrase should be one query against this table,
			// not one per keystroke.
			useEffect(() => {
				const timer = setTimeout(() => { setQuery(term.trim()); }, 240);
				return () => { clearTimeout(timer); };
			}, [term]);

			useEffect(() => {
				if (query === "") { setMatches([]); setFailed(""); return; }
				let live = true;
				setBusy(true);
				fetch(`${apiBase()}/resources?take=${SUGGEST_LIMIT}&skip=0&sortBy=publishedAt&search=${encodeURIComponent(query)}`)
					.then((response) => response.json())
					.then((payload) => {
						if (!live) return;
						if (payload?.success !== true) throw new Error(payload?.error ?? "search failed");
						setMatches(unwrapFeed(payload).rows);
						setFailed("");
					})
					.catch((cause) => {
						if (!live) return;
						setMatches([]);
						// "Nothing matched" and "could not search" are different
						// answers. With the library on another machine the second
						// one is not hypothetical, and showing it as the first
						// would be a wrong statement about the library.
						setFailed(String(cause?.message ?? cause));
					})
					.finally(() => { if (live) setBusy(false); });
				return () => { live = false; };
			}, [query]);

			const add = useCallback((row) => {
				onPick(row);
				setTerm("");
				setMatches([]);
			}, [onPick]);

			const open = focused && (query !== "" || busy);

			return jsxs("div", {
				style: { position: "relative" },
				children: [
					jsx("input", {
						type: "search",
						value: term,
						placeholder: zh ? "输入标题搜索，点一下加入这一集…" : "Search by title, click to add…",
						onChange: (event) => { setTerm(event.target.value); },
						onFocus: () => { setFocused(true); },
						// Delayed, or the blur fires before the click on a result
						// lands and the list disappears out from under the cursor.
						onBlur: () => { setTimeout(() => { setFocused(false); }, 160); },
						style: { ...SEARCH_STYLE, height: "38px", fontSize: "13px" }
					}),

					!open ? null : jsx("div", {
						style: {
							position: "absolute", top: "42px", left: 0, right: 0, zIndex: 3,
							border: "1px solid var(--dsw-alias-border-l1)", borderRadius: "12px",
							background: "var(--dsw-specific-menu)", boxShadow: "var(--dsw-shadow-lv3)",
							maxHeight: "290px", overflowY: "auto", overflowX: "hidden"
						},
						children: failed !== ""
							? jsx("div", { style: { padding: "14px", fontSize: "12px", color: "rgb(220,38,38)" }, children: (zh ? "搜索失败：" : "Search failed: ") + failed })
							: busy && matches.length === 0
							? jsx("div", { style: { padding: "14px", fontSize: "12px", color: "var(--dsw-alias-label-secondary)" }, children: zh ? "搜索中…" : "Searching…" })
							: matches.length === 0
							? jsx("div", { style: { padding: "14px", fontSize: "12px", color: "var(--dsw-alias-label-secondary)" }, children: zh ? "没有匹配的信源。" : "Nothing matches." })
							: jsxs("div", {
								children: matches.map((row, at) => {
									const already = picked.has(row.id);
									return jsxs("button", {
										type: "button",
										disabled: already,
										onClick: () => { add(row); },
										style: {
											display: "flex", width: "100%", alignItems: "flex-start", gap: "10px",
											padding: "10px 13px", textAlign: "left", appearance: "none",
											border: "none", borderBottom: at === matches.length - 1 ? "none" : "1px solid var(--dsw-alias-border-l1)",
											background: "transparent", font: "inherit", fontSize: "12px",
											cursor: already ? "default" : "pointer", opacity: already ? 0.45 : 1
										},
										children: [
											jsx("span", {
												style: {
													flex: "none", marginTop: "1px", fontSize: "11px", fontWeight: 600,
													color: already ? "var(--dsw-alias-label-tertiary)" : `rgb(${accent})`
												},
												children: already ? "✓" : "＋"
											}),
											jsxs("span", {
												style: { flex: 1, minWidth: 0 },
												children: [
													jsx("span", {
														style: { display: "block", color: "var(--dsw-alias-label-primary)", lineHeight: "18px" },
														children: row.title
													}),
													jsx("span", {
														style: { display: "block", marginTop: "2px", fontSize: "11px", color: "var(--dsw-alias-label-secondary)" },
														children: `${kindLabel(row.type, zh)} · ${sourceNameOf(row)} · ${formatDate(row.publishedAt)}`
													})
												]
											})
										]
									}, row.id);
								})
							})
					})
				]
			});
		}

		/**
		* A written format: the digest and the report share everything but a
		* prompt, so they share this.
		*
		* Publishing is not one shape. The podcast was the first format the
		* library grew and it set the pipeline — choose sources, gather them,
		* ask a model, store the artefact, list it, schedule it — but speech was
		* only the last step of that. A digest and a report reuse the whole
		* pipeline and replace the ending, which is why they are a sibling tab
		* rather than a separate feature.
		* @param zh - whether to write Chinese.
		* @param format - the format entry from the Host.
		* @param accent - `r,g,b` for this tab.
		*/
		function DocumentFormat({ zh, format, accent }) {
			const [picked, setPicked] = useState(() => new Map());
			const [guidance, setGuidance] = useState("");
			const [busy, setBusy] = useState(false);
			const [error, setError] = useState("");
			const [documents, setDocuments] = useState([]);
			const [total, setTotal] = useState(0);
			const [openId, setOpenId] = useState(undefined);
			const [body, setBody] = useState(null);

			const chosen = picked.size;

			const togglePick = useCallback((row) => {
				setPicked((previous) => {
					const next = new Map(previous);
					if (next.has(row.id)) next.delete(row.id);
					else next.set(row.id, row);
					return next;
				});
			}, []);

			const load = useCallback(async (take = DOCUMENT_PAGE) => {
				try {
					const response = await fetch(`${apiBase()}/publish/documents?format=${format.id}&take=${take}`);
					const payload = await response.json();
					if (payload?.success !== true) throw new Error(payload?.error ?? "could not list");
					setDocuments(payload.data.documents);
					setTotal(payload.data.total);
				} catch (cause) {
					setError(String(cause?.message ?? cause));
				}
			}, [format.id]);

			useEffect(() => { void load(); }, [load]);

			// The body is fetched only when a document is opened. The list holds
			// titles and dates; reading fifty files to render fifty rows would
			// make the list slower the more useful it became.
			useEffect(() => {
				if (openId === undefined) { setBody(null); return; }
				let live = true;
				setBody(null);
				fetch(`${apiBase()}/publish/documents/${encodeURIComponent(openId)}`)
					.then((response) => response.json())
					.then((payload) => {
						if (!live) return;
						if (payload?.success !== true) throw new Error(payload?.error ?? "could not read it");
						setBody(payload.data);
					})
					.catch((cause) => { if (live) setError(String(cause?.message ?? cause)); });
				return () => { live = false; };
			}, [openId]);

			const write = useCallback(async () => {
				setBusy(true);
				setError("");
				try {
					const response = await fetch(`${apiBase()}/publish/document`, {
						method: "POST",
						headers: { "content-type": "application/json" },
						body: JSON.stringify({
							format: format.id,
							zh: isChinese(),
							guidance,
							resourceIds: [...picked.keys()],
						}),
					});
					const payload = await response.json();
					if (payload?.success !== true) throw new Error(payload?.error ?? "HTTP " + response.status);
					// Straight to the finished thing. The reason to press the
					// button was to read what comes out of it.
					await load();
					setOpenId(payload.data.id);
					setBody(payload.data);
					setPicked(new Map());
				} catch (cause) {
					setError(String(cause?.message ?? cause));
				} finally {
					setBusy(false);
				}
			}, [format.id, guidance, picked, load]);

			const remove = useCallback(async (id) => {
				await fetch(`${apiBase()}/publish/documents/${encodeURIComponent(id)}`, { method: "DELETE" });
				if (id === openId) setOpenId(undefined);
				await load();
			}, [openId, load]);

			const CARD = {
				border: "1px solid var(--dsw-alias-border-l1)", borderRadius: "12px",
				background: "var(--dsw-specific-menu)", boxShadow: "var(--dsw-shadow-lv1)"
			};

			return jsxs("div", {
				children: [
					jsx("p", {
						style: { ...LEDE_STYLE, marginTop: 0 },
						children: zh ? format.blurb.zh : format.blurb.en
					}),

					jsxs("div", {
						style: { ...CARD, padding: "16px", marginBottom: "22px" },
						children: [
							jsx(StepHeading, {
								step: 1, accent,
								title: zh ? "选择信源" : "Choose the sources",
								hint: chosen === 0 ? "" : (zh ? `已选 ${chosen} 条` : `${chosen} selected`)
							}),
							jsx(SourceField, { zh, picked, onPick: togglePick, accent }),
							chosen === 0 ? null : jsx("div", {
								style: { ...CARD, marginTop: "12px", overflow: "hidden", boxShadow: "none" },
								children: [...picked.values()].map((row, at) => jsxs("div", {
									style: {
										display: "flex", alignItems: "flex-start", gap: "10px", padding: "9px 13px",
										borderBottom: at === picked.size - 1 ? "none" : "1px solid var(--dsw-alias-border-l1)",
										fontSize: "12px"
									},
									children: [
										jsx("span", {
											style: {
												flex: "none", marginTop: "1px", width: "15px", fontSize: "11px", fontWeight: 600,
												fontVariantNumeric: "tabular-nums", color: "var(--dsw-alias-label-tertiary)"
											},
											children: String(at + 1)
										}),
										jsxs("span", {
											style: { flex: 1, minWidth: 0 },
											children: [
												jsx("span", { style: { color: "var(--dsw-alias-label-primary)", lineHeight: "18px" }, children: row.title }),
												jsx("span", {
													style: { display: "block", marginTop: "2px", fontSize: "11px", color: "var(--dsw-alias-label-secondary)" },
													children: `${sourceNameOf(row)} · ${formatDate(row.publishedAt)}`
												})
											]
										}),
										jsx("button", {
											type: "button",
											"aria-label": zh ? "移出" : "Remove",
											onClick: () => { togglePick(row); },
											style: {
												flex: "none", appearance: "none", border: "none", background: "transparent",
												padding: "2px", cursor: "pointer", lineHeight: 0, color: "var(--dsw-alias-label-tertiary)"
											},
											children: jsx("svg", {
												width: 12, height: 12, viewBox: "0 0 24 24", fill: "none",
												stroke: "currentColor", strokeWidth: 2, strokeLinecap: "round", "aria-hidden": "true",
												children: jsx("path", { d: "M6 6l12 12M18 6L6 18" })
											})
										})
									]
								}, row.id))
							}),

							jsx("div", { style: { height: "20px" } }),

							jsx(StepHeading, {
								step: 2, accent,
								title: zh ? `生成${format.zh}` : `Write the ${format.en.toLowerCase()}`
							}),
							jsxs("div", {
								style: { display: "flex", alignItems: "center", gap: "12px", flexWrap: "wrap" },
								children: [
									jsx("input", {
										type: "text",
										value: guidance,
										placeholder: zh ? "想让它侧重什么？（可留空）" : "Anything it should focus on? (optional)",
										onChange: (event) => { setGuidance(event.target.value); },
										style: { ...SEARCH_STYLE, flex: 1, minWidth: "200px", height: "32px", fontSize: "12px" }
									}),
									jsx("button", {
										type: "button",
										disabled: busy || chosen === 0,
										style: {
											...controlStyle(), height: "32px",
											opacity: chosen === 0 ? 0.5 : 1,
											color: `rgb(${accent})`, borderColor: `rgba(${accent}, 0.45)`
										},
										onClick: () => { void write(); },
										children: busy
											? (zh ? "撰写中…" : "Writing…")
											: (zh ? `生成${format.zh}` : `Write it`)
									}),
									chosen !== 0 ? null : jsx("span", {
										style: { fontSize: "11px", color: "var(--dsw-alias-label-secondary)" },
										children: zh ? "先加几条信源" : "Add some sources first"
									})
								]
							})
						]
					}),

					jsxs("div", {
						style: { display: "flex", alignItems: "center", gap: "10px", margin: "0 0 12px" },
						children: [
							jsx("h3", {
								style: { margin: 0, fontSize: "14px", fontWeight: 600, color: "var(--dsw-alias-label-primary)" },
								children: zh ? `已生成的${format.zh}` : `${format.en}s`
							}),
							total === 0 ? null : jsx("span", {
								style: { fontSize: "12px", color: "var(--dsw-alias-label-secondary)", fontVariantNumeric: "tabular-nums" },
								children: String(total)
							})
						]
					}),

					documents.length === 0
						? jsx("div", {
							style: { ...CARD, padding: "20px", fontSize: "12px", color: "var(--dsw-alias-label-secondary)" },
							children: zh ? `还没有生成过${format.zh}。` : `Nothing written yet.`
						})
						: jsxs("div", {
							children: [
								jsx("div", {
									style: { ...CARD, overflow: "hidden" },
									children: documents.map((record, at) => {
										const open = record.id === openId;
										return jsxs("div", {
											style: {
												borderBottom: at === documents.length - 1 ? "none" : "1px solid var(--dsw-alias-border-l1)",
												background: open ? `rgba(${accent}, 0.035)` : "transparent"
											},
											children: [
												jsxs("div", {
													style: { display: "flex", alignItems: "center", gap: "12px", padding: "11px 15px" },
													children: [
														jsx("button", {
															type: "button",
															onClick: () => { setOpenId(open ? undefined : record.id); },
															style: {
																flex: 1, minWidth: 0, textAlign: "left", appearance: "none",
																border: "none", background: "transparent", padding: 0, cursor: "pointer",
																font: "inherit", fontSize: "13px", fontWeight: open ? 600 : 400,
																lineHeight: "19px", color: "var(--dsw-alias-label-primary)",
																...(open ? {} : { overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" })
															},
															children: record.title
														}),
														jsx("span", {
															style: {
																flex: "none", fontSize: "11px", fontVariantNumeric: "tabular-nums",
																color: "var(--dsw-alias-label-secondary)"
															},
															children: `${record.sourceIds.length} ${zh ? "条" : "src"} · ${formatStamp(record.createdAt)}`
														}),
														jsx("button", {
															type: "button",
															"aria-label": zh ? "删除" : "Delete",
															title: zh ? "删除" : "Delete",
															onClick: () => { void remove(record.id); },
															style: {
																flex: "none", appearance: "none", border: "none", background: "transparent",
																padding: "2px", cursor: "pointer", lineHeight: 0, color: "var(--dsw-alias-label-tertiary)"
															},
															children: jsx("svg", {
																width: 13, height: 13, viewBox: "0 0 24 24", fill: "none",
																stroke: "currentColor", strokeWidth: 1.8, strokeLinecap: "round", "aria-hidden": "true",
																children: jsx("path", { d: "M5 7h14M10 7V5h4v2M9 7v11M15 7v11M6 7l1 13h10l1-13" })
															})
														})
													]
												}),
												!open ? null : jsxs("div", {
													style: { padding: "0 15px 16px" },
													children: [
														body === null
															? jsx("div", { style: { fontSize: "12px", color: "var(--dsw-alias-label-secondary)" }, children: zh ? "读取中…" : "Loading…" })
															: body.missing === true
															// The index and the files can disagree. Saying which
															// beats rendering an empty document that looks like a
															// model that produced nothing.
															? jsx("div", { style: { fontSize: "12px", color: "rgb(220,38,38)" }, children: zh ? "这篇的文件不见了，只剩记录。" : "The file for this one is gone; only the record remains." })
															: jsx("div", { style: { maxWidth: "760px" }, children: renderMarkdown(body.text, "article") }),
														body === null || body.missing === true ? null : jsx("button", {
															type: "button",
															style: { ...controlStyle(), height: "26px", fontSize: "11px", marginTop: "10px" },
															onClick: () => { void navigator.clipboard?.writeText(body.text); },
															children: zh ? "复制 Markdown" : "Copy Markdown"
														})
													]
												})
											]
										}, record.id);
									})
								}),
								documents.length >= total ? null : jsx("div", {
									style: { display: "flex", justifyContent: "center", padding: "12px 0 2px" },
									children: jsx("button", {
										type: "button",
										style: { ...controlStyle(), height: "28px", fontSize: "12px" },
										onClick: () => { void load(documents.length + DOCUMENT_PAGE); },
										children: zh ? `再显示 ${Math.min(DOCUMENT_PAGE, total - documents.length)} 篇` : `Show ${Math.min(DOCUMENT_PAGE, total - documents.length)} more`
									})
								})
							]
						}),

					error === "" ? null : jsx("div", {
						style: { ...NOTE_STYLE, minHeight: 0, padding: "11px 14px", marginTop: "14px", color: "rgb(220,38,38)" },
						children: error
					})
				]
			});
		}

		function PodcastFormat({ zh }) {
			// Local, because only this tab selects and only this tab spends it.
			// It lived on the page for one iteration, when the plan was to pick
			// in 信源; that plan taxed a reading surface with a mode most visits
			// never enter, and the state has no reason to outlive this tab.
			const [picked, setPicked] = useState(() => new Map());
			const togglePick = useCallback((row) => {
				setPicked((previous) => {
					const next = new Map(previous);
					// The row, not just its id: this tab has to name what you
					// chose, and re-fetching rows it was handed a moment ago
					// would be a request for data already in hand.
					if (next.has(row.id)) next.delete(row.id);
					else next.set(row.id, row);
					return next;
				});
			}, []);
			const [minutes, setMinutes] = useState(6);
			const [script, setScript] = useState(null);
			const [voices, setVoices] = useState(null);
			const [hosts, setHosts] = useState(null);
			const [job, setJob] = useState(null);
			const [episodes, setEpisodes] = useState([]);
			const [episodeTotal, setEpisodeTotal] = useState(0);
			// Which episode is open. Undefined means "the newest", so the tab
			// always lands on something playable rather than on a list of
			// closed rows.
			const [activeId, setActiveId] = useState(undefined);
			// The make-an-episode flow, closed by default: the standing order
			// covers the ordinary day, and three construction steps permanently
			// open put the machinery in front of the output.
			const [making, setMaking] = useState(false);
			// The schedule's fields, likewise. It is a setting you touch twice
			// a year and read every day.
			const [tuning, setTuning] = useState(false);
			const [lastAt, setLastAt] = useState("07:00");
			const [artifactChoices, setArtifactChoices] = useState([{ id: "podcast", label: zh ? "播客" : "Podcast" }]);

			// The formats come from the Host so this list cannot drift from what
			// can actually be produced — arming something that does not exist
			// would fail at seven the next morning rather than here.
			useEffect(() => {
				let live = true;
				fetch(`${apiBase()}/publish/formats`)
					.then((response) => response.json())
					.then((payload) => {
						if (!live || payload?.success !== true) return;
						setArtifactChoices([
							{ id: "podcast", label: zh ? "播客" : "Podcast" },
							...payload.data.formats.map((format) => ({ id: format.id, label: zh ? format.zh : format.en })),
						]);
					})
					.catch(() => {
						// The podcast choice alone still works, and it is the one
						// with an audience waiting on a feed.
					});
				return () => { live = false; };
			}, [zh]);
			const [schedule, setSchedule] = useState(null);
			const [watchUntil, setWatchUntil] = useState(0);
			const [busy, setBusy] = useState(false);
			const [error, setError] = useState("");
			// The accent follows what you picked rather than a chip row that no
			// longer exists here: one kind selected tints the tab with it, a
			// mixed selection stays neutral rather than claiming to be whichever
			// kind happened to be chosen first.
			const kinds = new Set([...(picked?.values() ?? [])].map((row) => row.type));
			const kind = (kinds.size === 1 ? KINDS.find((candidate) => candidate.type === [...kinds][0]) : undefined)
				?? KINDS.find((candidate) => candidate.id === "news")
				?? KINDS[0];

			const loadEpisodes = useCallback(async (take = EPISODE_PAGE) => {
				try {
					const response = await fetch(`${apiBase()}/publish/episodes?take=${take}`);
					const payload = await response.json();
					if (payload?.success === true) {
						// Whatever came back has to be a list before it becomes
						// the state a render iterates. A success envelope carrying
						// something else -- a proxy returning an error page as
						// JSON, a far end one version older -- used to put
						// `undefined` here, and the next render died on
						// `episodes.find`. A dead render is a blank panel with
						// nothing in the log, which is the failure this codebase
						// keeps producing; an empty list is a page that says
						// there are no episodes.
						const list = Array.isArray(payload.data?.episodes) ? payload.data.episodes : [];
						setEpisodes(list);
						setEpisodeTotal(Number.isFinite(payload.data?.total) ? payload.data.total : list.length);
					}
				} catch {
					// The list is a convenience; failing to read it must not
					// stop someone from making the next episode.
				}
			}, []);

			useEffect(() => {
				void (async () => {
					try {
						const response = await fetch(`${apiBase()}/publish/voices`);
						const payload = await response.json();
						if (payload?.success !== true) return;
						setVoices(payload.data.voices);
						setHosts(payload.data.hosts);
					} catch {
						// Without the voice list the page still works on defaults.
					}
				})();
				void loadEpisodes();
			}, [loadEpisodes]);

			// Polling, not a stream: a render is a sequence of discrete steps and
			// the page only needs the count. A second connection held open for
			// minutes would buy nothing and add a reconnection story.
			useEffect(() => {
				if (job === null || job.state !== "running") return;
				let live = true;
				const timer = setInterval(async () => {
					try {
						const response = await fetch(`${apiBase()}/publish/jobs/${encodeURIComponent(job.id)}`);
						const payload = await response.json();
						if (!live) return;
						if (payload?.success !== true) {
							setJob((previous) => ({ ...previous, state: "error", error: payload?.error ?? "lost" }));
							return;
						}
						setJob(payload.data);
						if (payload.data.state === "done") void loadEpisodes();
					} catch {
						// A missed poll is not a failed render; the next one tells us.
					}
				}, 1500);
				return () => { live = false; clearInterval(timer); };
			}, [job, loadEpisodes]);

			const loadSchedule = useCallback(async () => {
				try {
					const response = await fetch(`${apiBase()}/publish/schedule`);
					const payload = await response.json();
					if (payload?.success === true) setSchedule(payload.data);
				} catch {
					// The schedule strip is a reading of server state; failing to
					// read it must not stop someone making an episode by hand.
				}
			}, []);

			useEffect(() => { void loadSchedule(); }, [loadSchedule]);

			// Watching a scheduled or manual run land. It ends on its own
			// deadline, and on unmount, so a tab left open does not poll forever.
			useEffect(() => {
				if (watchUntil === 0) return;
				const timer = setInterval(() => {
					if (Date.now() > watchUntil) { setWatchUntil(0); return; }
					void loadEpisodes();
					void loadSchedule();
				}, 5000);
				return () => { clearInterval(timer); };
			}, [watchUntil, loadEpisodes, loadSchedule]);

			// Written through /config rather than a route of its own: these are
			// the same settings the Host reads at every tick, and one writer for
			// them means one whitelist to keep honest.
			const saveSchedule = useCallback(async (patch) => {
				setBusy(true);
				try {
					const response = await fetch(`${apiBase()}/config`, {
						method: "PUT",
						headers: { "content-type": "application/json" },
						body: JSON.stringify(patch)
					});
					const payload = await response.json();
					if (payload?.success !== true) throw new Error(payload?.error ?? "HTTP " + response.status);
					await loadSchedule();
				} catch (cause) {
					setError(String(cause?.message ?? cause));
				} finally {
					setBusy(false);
				}
			}, [loadSchedule]);

			const runNow = useCallback(async () => {
				setBusy(true);
				setError("");
				try {
					const response = await fetch(`${apiBase()}/publish/run-now`, { method: "POST" });
					const payload = await response.json();
					if (payload?.success !== true) throw new Error(payload?.error ?? "HTTP " + response.status);
					// It takes minutes and reports only through the settings it
					// writes, so the page watches for the episode instead of a
					// job id: the first one to appear IS the answer. The deadline
					// goes into state rather than a bare setInterval, so leaving
					// the tab stops the polling instead of leaking it.
					setWatchUntil(Date.now() + 15 * 60 * 1000);
				} catch (cause) {
					setError(String(cause?.message ?? cause));
				} finally {
					setBusy(false);
				}
			}, [loadEpisodes, loadSchedule]);

			const writeScript = useCallback(async () => {
				setBusy(true);
				setError("");
				setScript(null);
				try {
					const response = await fetch(`${apiBase()}/publish/script`, {
						method: "POST",
						headers: { "content-type": "application/json" },
						body: JSON.stringify({ resourceIds: [...picked.keys()], minutes })
					});
					const payload = await response.json();
					if (payload?.success !== true) throw new Error(payload?.error ?? "HTTP " + response.status);
					setScript(payload.data);
				} catch (cause) {
					setError(String(cause?.message ?? cause));
				} finally {
					setBusy(false);
				}
			}, [picked, minutes]);

			const render = useCallback(async () => {
				if (script === null) return;
				setBusy(true);
				setError("");
				try {
					const response = await fetch(`${apiBase()}/publish/render`, {
						method: "POST",
						headers: { "content-type": "application/json" },
						body: JSON.stringify({ title: script.title, turns: script.turns, sourceIds: script.sourceIds, hosts })
					});
					const payload = await response.json();
					if (payload?.success !== true) throw new Error(payload?.error ?? "HTTP " + response.status);
					setJob({ id: payload.data.jobId, state: "running", done: 0, total: payload.data.total });
				} catch (cause) {
					setError(String(cause?.message ?? cause));
				} finally {
					setBusy(false);
				}
			}, [script, hosts]);

			const remove = useCallback(async (id) => {
				await fetch(`${apiBase()}/publish/episodes/${encodeURIComponent(id)}`, { method: "DELETE" });
				await loadEpisodes();
			}, [loadEpisodes]);

			const chosen = picked?.size ?? 0;
			const feedUrl = `${window.location.origin}/swarm-api/publish/feed.xml`;
			const running = job !== null && job.state === "running";
			const accent = kind.hue;
			const armed = schedule !== null && schedule.publishAt !== "";
			const armedArtifacts = Array.isArray(schedule?.publishArtifacts) && schedule.publishArtifacts.length > 0
				? schedule.publishArtifacts
				: ["podcast"];
			// Held so switching off and on again restores the time you chose
			// rather than making you type it a second time. Client-side on
			// purpose: it is a convenience, not a setting, and persisting it
			// would mean a second place where the schedule's time is written
			// down.
			useEffect(() => {
				if (schedule !== null && schedule.publishAt !== "") setLastAt(schedule.publishAt);
			}, [schedule]);
			const CARD = {
				border: "1px solid var(--dsw-alias-border-l1)", borderRadius: "12px",
				background: "var(--dsw-specific-menu)", boxShadow: "var(--dsw-shadow-lv1)"
			};
			const FIELD_LABEL = { fontSize: "12px", color: "var(--dsw-alias-label-secondary)", whiteSpace: "nowrap" };
			const NUM_INPUT = { ...SEARCH_STYLE, width: "56px", height: "30px", fontSize: "12px", textAlign: "center", fontVariantNumeric: "tabular-nums" };
			const active = episodes.find((episode) => episode.id === activeId) ?? episodes[0];

			return jsxs("div", {
				style: { paddingBottom: "14px" },
				children: [
					// ── the standing order ───────────────────────────────────
					// One line when it is doing its job, because that is the
					// state it is in almost always. The fields only matter on
					// the day you set them, and a form permanently open for a
					// setting you touch twice a year is a form in the way.
					schedule === null ? null : jsxs("div", {
						style: { ...CARD, padding: "13px 16px", marginBottom: "24px" },
						children: [
							jsxs("div", {
								style: { display: "flex", alignItems: "center", gap: "10px", flexWrap: "wrap" },
								children: [
									// A switch, not a dot. The only way to turn this off used
									// to be clearing the time field, which reads as editing a
									// setting rather than as disabling a feature — and left no
									// way back except retyping the time you had chosen.
									jsx("button", {
										type: "button",
										role: "switch",
										"aria-checked": armed,
										"aria-label": zh ? "自动发布" : "Publish on a schedule",
										onClick: () => { void saveSchedule({ publishAt: armed ? "" : (lastAt || "07:00") }); },
										style: {
											flex: "none", width: "34px", height: "19px", borderRadius: "10px",
											border: "none", padding: 0, cursor: "pointer", position: "relative",
											background: armed ? `rgb(${accent})` : "var(--dsw-alias-border-l2)",
											transition: "background 160ms ease"
										},
										children: jsx("span", {
											style: {
												position: "absolute", top: "2px", left: armed ? "17px" : "2px",
												width: "15px", height: "15px", borderRadius: "50%",
												background: "#fff", boxShadow: "0 1px 2px #0000002e",
												transition: "left 160ms ease"
											}
										})
									}),
									jsx("span", {
										style: { fontSize: "13px", fontWeight: 600, color: "var(--dsw-alias-label-primary)" },
										children: armed
											? (zh
												? `每天 ${schedule.publishAt} 自动生成${armedArtifacts.map((id) => artifactChoices.find((c) => c.id === id)?.label ?? id).join("、")}`
												: `${armedArtifacts.map((id) => artifactChoices.find((c) => c.id === id)?.label ?? id).join(" + ")} every day at ${schedule.publishAt}`)
											: (zh ? "自动发布已关闭" : "Automatic publishing is off")
									}),
									jsx("span", { style: { flex: 1, minWidth: "8px" } }),
									jsx("button", {
										type: "button",
										disabled: busy || watchUntil !== 0,
										style: { ...controlStyle(), height: "27px", fontSize: "12px" },
										onClick: () => { void runNow(); },
										children: watchUntil !== 0 ? (zh ? "生成中…" : "Running…") : (zh ? "立即生成" : "Run now")
									}),
									!armed ? null : jsx("button", {
										type: "button",
										"aria-expanded": tuning,
										style: { ...controlStyle(), height: "27px", fontSize: "12px" },
										onClick: () => { setTuning((previous) => !previous); },
										children: tuning ? (zh ? "收起" : "Done") : (zh ? "设置" : "Settings")
									})
								]
							}),
							jsx("div", {
								style: { marginTop: "8px", fontSize: "11px", lineHeight: "17px", color: "var(--dsw-alias-label-secondary)" },
								children: armed
									? scheduleNote(schedule, zh)
									: (zh
										? "打开后每天自动做一集。手动生成不受影响。"
										: "Turn it on to get one every day. Making them by hand still works.")
							}),
							// What "Run now" did, separately from what the timer did.
							// Pressing it and getting a legitimate skip used to
							// produce nothing at all — no artefact and no message,
							// which is indistinguishable from a broken button.
							manualNote(schedule, zh) === "" ? null : jsx("div", {
								style: {
									marginTop: "7px", fontSize: "11px", lineHeight: "17px",
									color: schedule.publishLastManualRun?.error === undefined
										? "var(--dsw-alias-label-secondary)"
										: "rgb(220,38,38)"
								},
								children: manualNote(schedule, zh)
							}),
							!tuning || !armed ? null : jsxs("div", {
								style: {
									display: "flex", alignItems: "flex-end", gap: "18px", flexWrap: "wrap",
									marginTop: "13px", paddingTop: "13px", borderTop: "1px solid var(--dsw-alias-border-l1)"
								},
								children: [
									jsxs("label", {
										style: { display: "flex", flexDirection: "column", gap: "5px" },
										children: [
											jsx("span", { style: FIELD_LABEL, children: zh ? "每天" : "Every day at" }),
											jsx("input", {
												type: "time",
												value: schedule.publishAt,
												onChange: (event) => { setSchedule((previous) => ({ ...previous, publishAt: event.target.value })); },
												onBlur: (event) => {
													// An empty field is a half-finished edit, not an
													// instruction to stop publishing. The switch above
													// exists because clearing the time used to be the
													// only way to turn this off; that reading was taken
													// out of the UI and left in this handler, so
													// clearing the field and clicking away still
													// disarmed the daily episode — silently, the first
													// evidence being a morning with nothing in it.
													if (!event.target.value) {
														setSchedule((previous) => ({ ...previous, publishAt: lastAt || "07:00" }));
														return;
													}
													void saveSchedule({ publishAt: event.target.value });
												},
												style: { ...SEARCH_STYLE, width: "108px", height: "30px", fontSize: "12px", fontVariantNumeric: "tabular-nums" }
											})
										]
									}),
									jsxs("label", {
										style: { display: "flex", flexDirection: "column", gap: "5px" },
										children: [
											jsx("span", { style: FIELD_LABEL, children: zh ? "取最新（条）" : "Newest sources" }),
											jsx("input", {
												type: "number", min: 1, max: 20, value: schedule.publishSources,
												onChange: (event) => { setSchedule((previous) => ({ ...previous, publishSources: Number(event.target.value) || 1 })); },
												onBlur: (event) => { void saveSchedule({ publishSources: Math.max(1, Math.min(20, Number(event.target.value) || 8)) }); },
												style: NUM_INPUT
											})
										]
									}),
									jsxs("label", {
										style: { display: "flex", flexDirection: "column", gap: "5px" },
										children: [
											jsx("span", { style: FIELD_LABEL, children: zh ? "时长（分钟）" : "Length (min)" }),
											jsx("input", {
												type: "number", min: 2, max: 20, value: schedule.publishMinutes,
												onChange: (event) => { setSchedule((previous) => ({ ...previous, publishMinutes: Number(event.target.value) || 2 })); },
												onBlur: (event) => { void saveSchedule({ publishMinutes: Math.max(2, Math.min(20, Number(event.target.value) || 8)) }); },
												style: NUM_INPUT
											})
										]
									}),
									// What the daily run makes. Chips rather than
									// checkboxes because this is a small closed set and
									// the state that matters — which are on — should be
									// legible without reading each label's box.
									jsxs("div", {
										style: { display: "flex", flexDirection: "column", gap: "5px" },
										children: [
											jsx("span", { style: FIELD_LABEL, children: zh ? "每天生成" : "Produce" }),
											jsx("div", {
												style: { display: "flex", gap: "6px", flexWrap: "wrap", height: "30px", alignItems: "center" },
												children: artifactChoices.map((choice) => {
													const on = armedArtifacts.includes(choice.id);
													return jsx("button", {
														type: "button",
														"aria-pressed": on,
														onClick: () => {
															// At least one, always. An armed schedule that
															// produces nothing is a timer that runs every
															// morning to do no work, and the run would fail
															// with "nothing was armed to publish" — a state
															// nobody would choose on purpose.
															const next = on
																? armedArtifacts.filter((id) => id !== choice.id)
																: [...armedArtifacts, choice.id];
															if (next.length === 0) return;
															void saveSchedule({ publishArtifacts: next });
														},
														style: {
															appearance: "none", cursor: "pointer", font: "inherit",
															height: "26px", padding: "0 11px", borderRadius: "999px", fontSize: "12px",
															border: `1px solid ${on ? `rgba(${accent}, 0.45)` : "var(--dsw-alias-border-l2)"}`,
															background: on ? `rgba(${accent}, 0.09)` : "transparent",
															color: on ? `rgb(${accent})` : "var(--dsw-alias-label-secondary)",
															fontWeight: on ? 600 : 400,
															transition: "background 140ms ease, color 140ms ease"
														},
														children: choice.label
													}, choice.id);
												})
											})
										]
									})
								]
							})
						]
					}),

					// ── the episodes ─────────────────────────────────────────
					// The output, above the machinery that makes it. Somebody
					// opening this tab is far more often here to listen than to
					// produce, and the previous layout made them scroll past
					// three construction steps to reach what already exists.
					jsxs("div", {
						style: { display: "flex", alignItems: "center", gap: "10px", margin: "0 0 12px" },
						children: [
							jsx("h3", {
								style: { margin: 0, fontSize: "14px", fontWeight: 600, color: "var(--dsw-alias-label-primary)" },
								children: zh ? "节目" : "Episodes"
							}),
							episodeTotal === 0 ? null : jsx("span", {
								style: { fontSize: "12px", color: "var(--dsw-alias-label-secondary)", fontVariantNumeric: "tabular-nums" },
								children: zh ? `${episodeTotal} 集` : `${episodeTotal}`
							}),
							jsx("span", { style: { flex: 1 } }),
							jsx("button", {
								type: "button",
								"aria-expanded": making,
								style: {
									...controlStyle(), height: "28px", fontSize: "12px",
									color: making ? "var(--dsw-alias-label-secondary)" : `rgb(${accent})`,
									borderColor: making ? undefined : `rgba(${accent}, 0.45)`
								},
								onClick: () => { setMaking((previous) => !previous); },
								children: making ? (zh ? "取消" : "Cancel") : (zh ? "＋ 新建一集" : "＋ New episode")
							})
						]
					}),

					// ── making one, on demand ────────────────────────────────
					// Behind a button because it is the exception. The standing
					// order covers the ordinary case; this is for the day you
					// want a specific episode about specific things.
					!making ? null : jsxs("div", {
						style: {
							...CARD, padding: "16px", marginBottom: "20px",
							borderColor: `rgba(${accent}, 0.35)`
						},
						children: [
							jsx(StepHeading, {
								step: 1, accent,
								title: zh ? "选择信源" : "Choose the sources",
								hint: chosen === 0 ? "" : (zh ? `已选 ${chosen} 条` : `${chosen} selected`)
							}),

							jsx(SourceField, { zh, picked, onPick: togglePick, accent }),

							// Listed apart from the picker on purpose: a row picked
							// under one kind vanishes from the list the moment you
							// filter elsewhere, and a selection you cannot see is a
							// selection you cannot trust.
							chosen === 0 ? null : jsxs("div", {
								style: { ...CARD, marginTop: "12px", overflow: "hidden", boxShadow: "none" },
								children: [
									jsxs("div", {
										style: {
											display: "flex", alignItems: "center", gap: "10px",
											padding: "9px 13px", borderBottom: "1px solid var(--dsw-alias-border-l1)",
											background: `rgba(${accent}, 0.05)`
										},
										children: [
											jsx("span", {
												style: { flex: 1, fontSize: "12px", fontWeight: 600, color: `rgb(${accent})` },
												children: zh ? `这一集要讲的 ${chosen} 条` : `${chosen} source${chosen === 1 ? "" : "s"} in this episode`
											}),
											jsx("button", {
												type: "button",
												style: { ...controlStyle(), height: "24px", fontSize: "11px" },
												onClick: () => { setPicked(new Map()); },
												children: zh ? "清空" : "Clear"
											})
										]
									}),
									...[...picked.values()].map((row, at) => jsxs("div", {
										style: {
											display: "flex", alignItems: "flex-start", gap: "10px", padding: "9px 13px",
											borderBottom: at === picked.size - 1 ? "none" : "1px solid var(--dsw-alias-border-l1)",
											fontSize: "12px"
										},
										children: [
											jsx("span", {
												style: {
													flex: "none", marginTop: "1px", width: "15px", fontSize: "11px", fontWeight: 600,
													fontVariantNumeric: "tabular-nums", color: "var(--dsw-alias-label-tertiary)"
												},
												children: String(at + 1)
											}),
											jsxs("span", {
												style: { flex: 1, minWidth: 0 },
												children: [
													jsx("span", { style: { color: "var(--dsw-alias-label-primary)", lineHeight: "18px" }, children: row.title }),
													jsx("span", {
														style: { display: "block", marginTop: "2px", fontSize: "11px", color: "var(--dsw-alias-label-secondary)" },
														children: `${sourceNameOf(row)} · ${formatDate(row.publishedAt)}`
													})
												]
											}),
											jsx("button", {
												type: "button",
												"aria-label": zh ? "移出" : "Remove",
												onClick: () => { togglePick(row); },
												style: {
													flex: "none", appearance: "none", border: "none", background: "transparent",
													padding: "2px", cursor: "pointer", lineHeight: 0, color: "var(--dsw-alias-label-tertiary)"
												},
												children: jsx("svg", {
													width: 12, height: 12, viewBox: "0 0 24 24", fill: "none",
													stroke: "currentColor", strokeWidth: 2, strokeLinecap: "round", "aria-hidden": "true",
													children: jsx("path", { d: "M6 6l12 12M18 6L6 18" })
												})
											})
										]
									}, row.id))
								]
							}),

							jsx("div", { style: { height: "20px" } }),

							jsx(StepHeading, {
								step: 2, accent,
								title: zh ? "生成对话稿" : "Write the script",
								hint: script === null ? "" : (zh
									? `${script.turns.length} 轮 · ${script.chars} 字 · 约 ${script.estimatedMinutes} 分钟`
									: `${script.turns.length} turns · ${script.chars} chars · ~${script.estimatedMinutes} min`)
							}),

							// One baseline, not a stacked label over a small box with
							// a button and a hint each floating at their own height.
							// A stepper rather than a bare number field: the value
							// has a narrow useful range, the spinner arrows a plain
							// `number` input draws are tiny and platform-specific,
							// and this is a dial, not a quantity you type.
							jsxs("div", {
								style: { display: "flex", alignItems: "center", gap: "12px", flexWrap: "wrap", marginBottom: script === null ? 0 : "14px" },
								children: [
									jsx("span", { style: FIELD_LABEL, children: zh ? "目标时长" : "Target length" }),
									jsxs("div", {
										style: {
											display: "inline-flex", alignItems: "center", height: "30px",
											border: "1px solid var(--dsw-alias-border-l2)", borderRadius: "8px", overflow: "hidden"
										},
										children: [
											jsx("button", {
												type: "button",
												"aria-label": zh ? "减少一分钟" : "One minute less",
												disabled: minutes <= 2,
												onClick: () => { setMinutes((previous) => Math.max(2, previous - 1)); },
												style: { ...STEPPER_BUTTON, opacity: minutes <= 2 ? 0.35 : 1 },
												children: "−"
											}),
											jsx("span", {
												style: {
													minWidth: "58px", textAlign: "center", fontSize: "12px",
													fontVariantNumeric: "tabular-nums", color: "var(--dsw-alias-label-primary)"
												},
												children: zh ? `${minutes} 分钟` : `${minutes} min`
											}),
											jsx("button", {
												type: "button",
												"aria-label": zh ? "增加一分钟" : "One minute more",
												disabled: minutes >= 20,
												onClick: () => { setMinutes((previous) => Math.min(20, previous + 1)); },
												style: { ...STEPPER_BUTTON, opacity: minutes >= 20 ? 0.35 : 1 },
												children: "+"
											})
										]
									}),
									jsx("button", {
										type: "button",
										disabled: busy || running || chosen === 0,
										style: {
											...controlStyle(), height: "30px",
											opacity: chosen === 0 ? 0.5 : 1,
											color: `rgb(${accent})`, borderColor: `rgba(${accent}, 0.45)`
										},
										onClick: () => { void writeScript(); },
										children: busy && script === null ? (zh ? "写稿中…" : "Writing…") : (zh ? "生成对话稿" : "Write the script")
									}),
									chosen !== 0 ? null : jsx("span", {
										style: { ...FIELD_LABEL, fontSize: "11px" },
										children: zh ? "先加几条信源" : "Add some sources first"
									})
								]
							}),

							script === null ? null : jsxs("div", {
								style: { ...CARD, overflow: "hidden", boxShadow: "none" },
								children: [
									jsxs("div", {
										style: {
											display: "flex", alignItems: "center", gap: "10px", flexWrap: "wrap",
											padding: "11px 13px", borderBottom: "1px solid var(--dsw-alias-border-l1)"
										},
										children: [
											jsx("span", { style: { flex: 1, minWidth: "140px", fontSize: "13px", fontWeight: 600, color: "var(--dsw-alias-label-primary)" }, children: script.title }),
											voices === null || hosts === null ? null : jsxs("span", {
												style: { display: "flex", gap: "6px" },
												children: [
													jsx("select", {
														value: hosts.a,
														"aria-label": zh ? "主持人 A 的声音" : "Host A voice",
														onChange: (event) => { setHosts((previous) => ({ ...previous, a: event.target.value })); },
														style: { ...controlStyle(), height: "27px", fontSize: "11px", padding: "0 6px" },
														children: voices.map((voice) => jsx("option", { value: voice.id, children: `A · ${voice.label}` }, voice.id))
													}),
													jsx("select", {
														value: hosts.b,
														"aria-label": zh ? "主持人 B 的声音" : "Host B voice",
														onChange: (event) => { setHosts((previous) => ({ ...previous, b: event.target.value })); },
														style: { ...controlStyle(), height: "27px", fontSize: "11px", padding: "0 6px" },
														children: voices.map((voice) => jsx("option", { value: voice.id, children: `B · ${voice.label}` }, voice.id))
													})
												]
											}),
											jsx("button", {
												type: "button",
												disabled: busy || running,
												style: { ...controlStyle(), height: "27px", fontSize: "12px", color: `rgb(${accent})`, borderColor: `rgba(${accent}, 0.45)` },
												onClick: () => { void render(); },
												children: running
													? (zh ? `合成中 ${job.done}/${job.total}` : `Rendering ${job.done}/${job.total}`)
													: (zh ? "合成音频" : "Render audio")
											})
										]
									}),
									// Progress where the render was started. Forty
									// synthesis round trips is long enough that a page
									// showing nothing reads as a page that has hung.
									!running ? null : jsx("div", {
										style: { height: "3px", background: "var(--dsw-alias-border-l2)" },
										children: jsx("div", {
											style: {
												height: "100%", width: `${job.total > 0 ? (job.done / job.total) * 100 : 0}%`,
												background: `rgb(${accent})`, transition: "width 240ms ease"
											}
										})
									}),
									jsx("div", {
										style: { maxHeight: "260px", overflowY: "auto", padding: "11px 13px" },
										children: script.turns.map((turn, at) => jsxs("div", {
											style: { display: "flex", gap: "10px", marginBottom: "9px", fontSize: "12px", lineHeight: "19px" },
											children: [
												jsx("span", {
													style: {
														flex: "none", width: "18px", height: "18px", borderRadius: "50%",
														display: "inline-flex", alignItems: "center", justifyContent: "center",
														fontSize: "10px", fontWeight: 600,
														background: turn.speaker === "a" ? `rgba(${accent}, 0.12)` : "var(--dsw-alias-interactive-bg-hover)",
														color: turn.speaker === "a" ? `rgb(${accent})` : "var(--dsw-alias-label-secondary)"
													},
													children: turn.speaker.toUpperCase()
												}),
												jsx("span", { style: { flex: 1, minWidth: 0, color: "var(--dsw-alias-label-primary)" }, children: turn.text })
											]
										}, `t${at}`))
									})
								]
							}),

							job !== null && job.state === "error" ? jsx("div", {
								style: { ...NOTE_STYLE, minHeight: 0, padding: "10px 13px", marginTop: "12px", color: "rgb(220,38,38)" },
								children: (zh ? "合成失败：" : "Render failed: ") + job.error
							}) : null
						]
					}),

					// ── the list ─────────────────────────────────────────────
					// One episode open with a player, the rest as dense rows.
					// This is how a podcast app is shaped, and for the same
					// reason: a back catalogue is scanned by title and date, and
					// a stack of full-height cards stops working at about the
					// second screenful. A daily schedule reaches that in a week.
					episodes.length === 0
						? jsx("div", {
							style: { ...CARD, padding: "22px", fontSize: "12px", lineHeight: "19px", color: "var(--dsw-alias-label-secondary)" },
							children: armed
								? (zh ? `还没有节目。第一集会在明天 ${schedule.publishAt} 自动生成，或者现在按「新建一集」做一集。` : `No episodes yet. The first one arrives tomorrow at ${schedule.publishAt}, or make one now with “New episode”.`)
								: (zh ? "还没有节目。按「新建一集」做一集，或者在上面设一个每天的时间。" : "No episodes yet. Make one with “New episode”, or set a daily time above.")
						})
						: jsxs("div", {
							children: [
								jsx("div", {
									style: { ...CARD, overflow: "hidden" },
									children: episodes.map((episode, at) => jsx(EpisodeRow, {
										episode,
										open: active !== undefined && episode.id === active.id,
										accent, zh,
										onOpen: () => { setActiveId(episode.id); },
										onDelete: () => { void remove(episode.id); },
										last: at === episodes.length - 1
									}, episode.id))
								}),

								episodes.length >= episodeTotal ? null : jsx("div", {
									style: { display: "flex", justifyContent: "center", padding: "12px 0 2px" },
									children: jsx("button", {
										type: "button",
										style: { ...controlStyle(), height: "28px", fontSize: "12px" },
										onClick: () => { void loadEpisodes(episodes.length + EPISODE_PAGE); },
										children: zh
											? `再显示 ${Math.min(EPISODE_PAGE, episodeTotal - episodes.length)} 集`
											: `Show ${Math.min(EPISODE_PAGE, episodeTotal - episodes.length)} more`
									})
								}),

								// The feed is where a back catalogue actually belongs:
								// a podcast client is built to hold hundreds of
								// episodes and this panel is not, so the last thing
								// on the page is the way out of it.
								jsxs("div", {
									style: {
										display: "flex", alignItems: "center", gap: "10px", flexWrap: "wrap",
										marginTop: "16px", padding: "11px 14px",
										border: "1px dashed var(--dsw-alias-border-l2)", borderRadius: "12px"
									},
									children: [
										jsx("span", { style: FIELD_LABEL, children: zh ? "在播客 App 里订阅：" : "Subscribe in a podcast app:" }),
										jsx("code", {
											style: {
												flex: 1, minWidth: "170px", fontSize: "11px", overflow: "hidden",
												textOverflow: "ellipsis", whiteSpace: "nowrap", color: "var(--dsw-alias-label-secondary)"
											},
											children: feedUrl
										}),
										jsx("button", {
											type: "button",
											style: { ...controlStyle(), height: "26px", fontSize: "11px" },
											onClick: () => { void navigator.clipboard?.writeText(feedUrl); },
											children: zh ? "复制" : "Copy"
										})
									]
								})
							]
						}),

					error === "" ? null : jsx("div", {
						style: { ...NOTE_STYLE, minHeight: 0, padding: "11px 14px", marginTop: "14px", color: "rgb(220,38,38)" },
						children: error
					})
				]
			});
		}
		/**
		* 发布 is a group, not a page.
		*
		* Publishing is not one shape. The same selection of sources becomes a
		* podcast for the commute, a digest for the two minutes before a
		* meeting, or a report for the afternoon that needs the synthesis — and
		* all three share everything up to the last step: choose sources, gather
		* their substance, ask a model, store the artefact, list it, schedule
		* it. Only the ending differs.
		*
		* Formats are discovered from the Host rather than listed here, so
		* adding one is a change in one place. The podcast is not among them
		* because it is not a written document: it has voices, a render job,
		* and an RSS feed, and folding it into the same component would mean a
		* component with two unrelated halves and a flag choosing between them.
		*/
		function PublishTab({ zh }) {
			const [formats, setFormats] = useState([]);
			const [active, setActive] = useState("podcast");

			useEffect(() => {
				let live = true;
				fetch(`${apiBase()}/publish/formats`)
					.then((response) => response.json())
					.then((payload) => {
						if (!live || payload?.success !== true) return;
						setFormats(payload.data.formats);
					})
					.catch(() => {
						// Without the list the podcast still works, which is the
						// format that has an audience waiting on a feed.
					});
				return () => { live = false; };
			}, []);

			const entries = [
				{ id: "podcast", label: zh ? "播客" : "Podcast", accent: KINDS.find((k) => k.id === "youtube")?.hue ?? "220,38,38" },
				...formats.map((format, at) => ({
					id: format.id,
					label: zh ? format.zh : format.en,
					// A colour per format, taken from the palette the source
					// kinds already use, so the whole panel stays one family.
					accent: (KINDS[(at + 1) % KINDS.length] ?? KINDS[0]).hue,
					format,
				})),
			];
			const current = entries.find((entry) => entry.id === active) ?? entries[0];

			return jsxs("div", {
				children: [
					// A segmented control rather than a second row of underlined
					// tabs: these sit directly below the panel's own tab bar, and
					// two rows of the same treatment read as one confused
					// navigation with no hierarchy between them.
					jsx("div", {
						role: "tablist",
						style: {
							display: "inline-flex", gap: "2px", padding: "3px", marginBottom: "16px",
							background: "var(--dsw-alias-interactive-bg-hover)", borderRadius: "10px"
						},
						children: entries.map((entry) => jsx("button", {
							type: "button",
							role: "tab",
							"aria-selected": entry.id === current.id,
							onClick: () => { setActive(entry.id); },
							style: {
								appearance: "none", border: "none", cursor: "pointer", font: "inherit",
								padding: "0 14px", height: "28px", borderRadius: "8px", fontSize: "12px",
								fontWeight: entry.id === current.id ? 600 : 400,
								background: entry.id === current.id ? "var(--dsw-specific-menu)" : "transparent",
								color: entry.id === current.id ? `rgb(${entry.accent})` : "var(--dsw-alias-label-secondary)",
								boxShadow: entry.id === current.id ? "var(--dsw-shadow-lv1)" : "none",
								transition: "background 140ms ease, color 140ms ease"
							},
							children: entry.label
						}, entry.id))
					}),

					current.id === "podcast"
						? jsx(PodcastFormat, { zh })
						// Keyed by format so switching between digest and report
						// remounts rather than carrying one format's selection and
						// document list into the other.
						: jsx(DocumentFormat, { zh, format: current.format, accent: current.accent }, current.id)
				]
			});
		}

		//#endregion

		//#region page tabs
		/**
		* The four stages of the swarm pipeline, in the order work moves
		* through them: raw material, what it means, what to dig into, and
		* what follows from it. The stage names match the gens.team backend
		* modules `explore / insight / research / simulation`.
		*/
		const TABS = [
			{
				id: "sources", en: "Sources", zh: "信源",
				ledeEn: "Feeds the swarm reads from.", ledeZh: "蜂群读取的信息来源。",
				emptyEn: "", emptyZh: ""
			},
			{
				id: "insights", en: "Insights", zh: "洞察",
				ledeEn: "Missions the swarm ran against a topic: what it read, what verified, and the report it signed.",
				ledeZh: "蜂群针对一个课题跑完的调研任务：读了什么、哪些引语通过了核验、最后签署的报告。",
				// No `soon`, and no empty text: this tab has a component of
				// its own now, and both fields are read ONLY by the placeholder
				// branch below. Left as they were, they would be a not-built
				// notice with no way to reach the screen — waiting for the day
				// somebody edits that branch and puts the lie back. 信源 carries
				// them empty for the same reason.
				emptyEn: "", emptyZh: ""
			},
			{
				id: "research", en: "Research", zh: "研究",
				ledeEn: "Deep-dive tasks opened against an insight, and their findings.",
				ledeZh: "针对某条洞察展开的深度调研任务及其发现。",
				soon: true,
				emptyEn: "Research tasks are not built yet.", emptyZh: "调研任务尚未实现。"
			},
			{
				id: "simulation", en: "Simulation", zh: "推演",
				ledeEn: "Scenarios played forward from the research, with their assumptions stated.",
				ledeZh: "基于研究结论向前推演的情景，并显式列出所依赖的假设。",
				soon: true,
				emptyEn: "Scenarios are not built yet.", emptyZh: "情景推演尚未实现。"
			},
			{
				id: "publish", en: "Publish", zh: "发布",
				ledeEn: "Selected sources spoken as a two-host conversation, and the feed they publish to.",
				ledeZh: "把选中的信源讲成一段双人对话，并汇成可订阅的播客。",
				emptyEn: "No episode yet.", emptyZh: "还没有生成过节目。"
			}
		];
		//#endregion

		//#region sidebar trigger
		/**
		* The Agents entry, always present in the sidebar foot. Geometry
		* matches the Settings seat below it: a 36px row with no extra wrapper
		* height, so the two entries sit at the same rhythm.
		*/
		function SwarmTrigger({ wide }) {
			const open = useOpen();
			return jsx("div", {
				style: {
					flex: "none", display: "flex", alignItems: "center",
					width: wide ? "100%" : "36px", height: "36px"
				},
				children: jsxs("button", {
					type: "button",
					"aria-label": swarmLabel(),
					"aria-pressed": open,
					// Marks this as the toggle, so the page's click-away handler
					// leaves it alone rather than closing what this is about to open.
					"data-swarm-trigger": "true",
					onClick: () => { setOpen(!openState); },
					style: {
						appearance: "none", border: "none",
						background: open ? "var(--dsw-alias-interactive-bg-hover)" : "transparent",
						display: "inline-flex", alignItems: "center",
						justifyContent: wide ? "flex-start" : "center",
						gap: wide ? "8px" : 0, width: wide ? "100%" : "36px", height: "36px",
						padding: wide ? "0 8px" : 0, borderRadius: wide ? "8px" : "50%",
						color: "var(--dsw-alias-label-primary)", font: "inherit", fontSize: "13px",
						cursor: "pointer"
					},
					children: [
						jsx(SwarmMark, { size: wide ? 16 : 18 }),
						wide ? jsx("span", { style: { whiteSpace: "nowrap" }, children: swarmLabel() }) : null
					]
				})
			});
		}
		//#endregion

		//#region overlay page
		/**
		* The Agents page.
		*
		* `conversation` — the centre column — is a `single` slot, so occupying
		* it would REPLACE the whole conversation surface and take its declared
		* seats with it. `shell.overlay` is the frame's documented additive seat
		* for a surface of your own, so the page renders there and is inset to
		* the right of the sidebar: the navigation column stays visible and
		* interactive while the page is up.
		*/
		function SwarmPage() {
			const open = useOpen();
			const [tab, setTab] = useState(TABS[0].id);
			const [left, setLeft] = useState(0);
			useLayoutEffect(() => {
				if (!open) return;
				const measure = () => { setLeft(centreColumnLeft()); };
				measure();
				const layer = document.querySelector("[data-shell-overlay]");
				const frame = layer?.parentElement;
				const observer = new ResizeObserver(measure);
				if (frame != null) observer.observe(frame);
				const anchor = document.querySelector('[data-slot="sidebar"]');
				const node = anchor?.firstElementChild;
				if (node != null) observer.observe(node);
				window.addEventListener("resize", measure);
				// The sidebar collapse is animated, so the final width lands
				// after the click that started it. One delayed re-measure
				// settles that; a standing interval would re-render ten times a
				// second for as long as the page is open.
				const settle = setTimeout(measure, 400);
				return () => {
					observer.disconnect();
					window.removeEventListener("resize", measure);
					clearTimeout(settle);
				};
			}, [open]);

			useLayoutEffect(() => {
				if (!open) return;
				const onKeyDown = (event) => { if (event.key === "Escape") setOpen(false); };
				document.addEventListener("keydown", onKeyDown);
				return () => { document.removeEventListener("keydown", onKeyDown); };
			}, [open]);

			// The page covers the conversation but deliberately leaves the
			// sidebar reachable, and that combination had a trap in it: starting
			// a new session put the new session BEHIND this page, so the click
			// appeared to do nothing and there was no way to reach what had just
			// been created.
			//
			// Collapsing the sidebar is NOT one of those requests, and treating
			// it as one threw the reader back to the home page mid-article: the
			// toggle lives in the shell, so it matched the rule, but it
			// navigates nowhere — it only changes how wide the sidebar is. The
			// page re-measures for that (the frame's ResizeObserver) and stays.
			//
			// Any click in the shell around this page is a request for the shell
			// — a new session, another workspace, settings — so the page steps
			// aside for it. Capture phase, so the decision is made before the
			// shell's own handler runs and the two do not race. The trigger in
			// the footer is excluded: it owns the toggle, and closing here would
			// fight its own re-open.
			useLayoutEffect(() => {
				if (!open) return;
				const onPointerDown = (event) => {
					const target = event.target;
					if (!(target instanceof Element)) return;
					if (target.closest("[data-swarm-left]") !== null) return;
					if (target.closest("[data-swarm-trigger]") !== null) return;
					if (isLayoutToggle(target)) return;
					setOpen(false);
				};
				document.addEventListener("pointerdown", onPointerDown, true);
				return () => { document.removeEventListener("pointerdown", onPointerDown, true); };
			}, [open]);

			if (!open) return null;

			const zh = isChinese();
			const active = TABS.find((candidate) => candidate.id === tab) ?? TABS[0];
			// The tabs that carry their own scroller and their own reader.
			const reads = active.id === "sources" || active.id === "insights";

			return jsxs("section", {
				"aria-label": swarmLabel(),
				// Inspectable in devtools: if the page ever goes missing again, this
				// attribute says whether the geometry or the mount is at fault.
				"data-swarm-left": String(left),
				style: {
					position: "fixed", left: left + "px", top: 0, right: 0, bottom: 0, zIndex: 40,
					display: "flex", flexDirection: "column",
					background: "var(--dsw-alias-bg-base)"
				},
				children: [
					jsxs("header", {
						style: HEADER_STYLE,
						children: [
							jsx(SwarmMark, { size: 18 }),
							jsx("span", { style: { flex: "none" }, children: swarmLabel() }),
							// Where you glance. The number is small and quiet until the
							// two halves disagree, at which point it is the only thing
							// on this row worth reading — a stale far machine otherwise
							// presents as a feature that was written and deployed and
							// is simply not there.
							jsx(VersionBadge, { zh }),
							jsx("span", { style: { flex: 1 } }),
							jsx("button", {
								type: "button",
								"aria-label": zh ? "关闭" : "Close",
								onClick: () => { setOpen(false); },
								style: {
									appearance: "none", border: "none", background: "transparent",
									width: "28px", height: "28px", borderRadius: "50%",
									color: "var(--dsw-alias-label-secondary)", font: "inherit",
									fontSize: "16px", lineHeight: "28px", cursor: "pointer"
								},
								children: "✕"
							})
						]
					}),
					jsx("div", {
						style: TABBAR_STYLE,
						role: "tablist",
						children: TABS.map((candidate) => jsxs("button", {
							type: "button",
							role: "tab",
							"aria-selected": candidate.id === active.id,
							style: { ...tabStyle(candidate.id === active.id), display: "inline-flex", alignItems: "center", gap: "6px" },
							onClick: () => { setTab(candidate.id); },
							children: [
								jsx(TabIcon, { id: candidate.id }),
								jsx("span", { children: zh ? candidate.zh : candidate.en }),
								candidate.soon
									? jsx("span", { style: SOON_STYLE, children: zh ? "待建" : "planned" })
									: null
							]
						}, candidate.id))
					}),
					jsx("div", {
						// 信源 and 洞察 both switch views IN PLACE — 信源 into its
						// reader, 洞察 into a mission and then into that mission's
						// report — so both are handed the whole frame and scroll
						// inside it. Under the padded, 1080px-capped body the
						// reader's `height: 100%` resolves against a box that is
						// only as tall as its own content, which renders a two-pane
						// reader with no panes.
						style: reads ? READER_BODY_STYLE : BODY_STYLE,
						role: "tabpanel",
						"aria-label": zh ? active.zh : active.en,
						children: jsx("div", {
							style: reads ? { ...WIDE_STYLE, height: "100%", minHeight: 0 } : CONTENT_STYLE,
							children: active.id === "sources"
								? jsx(ExploreTab, { zh })
								: active.id === "insights"
								? jsx(MissionsTab, { zh })
								: active.id === "publish"
								? jsx(PublishTab, { zh })
								: jsxs("div", {
									children: [
										jsx("p", { style: LEDE_STYLE, children: zh ? active.ledeZh : active.ledeEn }),
										jsx("div", { style: NOTE_STYLE, children: zh ? active.emptyZh : active.emptyEn })
									]
								})
						})
					})
				]
			});
		}
		//#endregion

		//#region settings section
		/**
		* The source-library settings page.
		*
		* It registers into `settings.section` — the shell's own Settings panel —
		* rather than growing a config screen inside the swarm page. Two reasons:
		* a person looks for settings in one place, and `settings.section` is a
		* `list` slot, so the page is ADDED beside Models, Appearance, and the
		* rest instead of shadowing any of them.
		*
		* The provider key is write-only across the wire: the Host half reports
		* whether one is stored, never its value, and an untouched field is not
		* sent back, so saving a feed cannot silently clear a secret.
		*/
		let versionAnswer = null;
		let versionAt = 0;
		let versionPending = null;

		/**
		* How long a version answer is worth reusing.
		*
		* Cached at all so the header badge and the settings line share one
		* request rather than each asking the far machine for a label. Cached
		* only briefly because the answer CHANGES: a page left open across a
		* deploy kept reporting the version from before it, which showed as a
		* mismatch warning about a machine that had already been updated. A
		* cache with no expiry is not a cache, it is a snapshot.
		*/
		const VERSION_TTL_MS = 30_000;

		/**
		* The version answer, fetched at most once per {@link VERSION_TTL_MS}.
		* @returns `{ host, failed }`, both null until an answer arrives.
		*/
		function useHostVersion() {
			const [host, setHost] = useState(() => versionAnswer);
			const [failed, setFailed] = useState("");

			useEffect(() => {
				let live = true;
				if (versionAnswer !== null && Date.now() - versionAt < VERSION_TTL_MS) {
					setHost(versionAnswer);
					return;
				}
				versionPending ??= fetch(`${apiBase()}/version`)
					.then((response) => response.json())
					.then((payload) => {
						if (payload?.success !== true) throw new Error(payload?.error ?? "no version");
						versionAnswer = payload.data;
						versionAt = Date.now();
						return payload.data;
					})
					.finally(() => { versionPending = null; });
				versionPending
					.then((data) => { if (live) setHost(data); })
					.catch((cause) => { if (live) setFailed(String(cause?.message ?? cause)); });
				return () => { live = false; };
			}, []);

			return { host, failed };
		}

		/**
		* Which build is running, in as few words as it takes.
		* @param host - the `/version` payload, or null.
		* @returns `{ label, release }`.
		*/
		function versionVerdict(host) {
			const proxied = host?.library === "remote";
			// The machine that serves the routes is the one whose build matters.
			const channel = proxied ? host?.remoteChannel : host?.channel;
			const number = proxied ? host?.remoteVersion : host?.version;
			return {
				label: number ?? CLIENT_VERSION,
				release: channel === "release",
			};
		}

		/**
		* The header badge: the version, and whether it is a release.
		*
		* Nothing else. It used to explain the difference between two machines
		* and name the command to reconcile them, which is a deployment system
		* wearing a badge — and a disagreement between the two halves is not
		* something to report to a reader, it is something to prevent.
		* @param zh - whether to write Chinese.
		*/
		function VersionBadge({ zh }) {
			const { host } = useHostVersion();
			const { label, release } = versionVerdict(host);
			return jsx("span", {
				style: {
					marginLeft: "8px", padding: "1px 7px", borderRadius: "999px",
					fontSize: "11px", fontVariantNumeric: "tabular-nums", cursor: "default",
					background: "var(--dsw-alias-interactive-bg-hover)",
					color: "var(--dsw-alias-label-tertiary)"
				},
				children: release || host === null ? `v${label}` : `v${label}-dev`
			});
		}

		/**
		* The same fact, with room for the node version beside it.
		* @param zh - whether to write Chinese.
		*/
		/**
		* Where the library lives, said in one line.
		*
		* The machine holding the data is decided by one value — a pointer file
		* and an environment variable — and nothing on screen ever mentioned it.
		* A workstation proxying to a box that had gone down looked exactly like
		* a workstation with an empty library: same page, same empty lists, no
		* error anywhere. The far end's own version is shown for the same
		* reason: two machines both claiming to be fine while running different
		* code is the failure this whole display was built for.
		*/
		function libraryLine(host, zh) {
			if (host === null) return null;
			if (host.library !== "remote") {
				return {
					what: zh ? "本地" : "local",
					detail: host.libraryPath ?? (zh ? "本机" : "this machine"),
					trouble: ""
				};
			}
			// A remote with a version is reachable; that is the whole check, and
			// it is the answer to "is the other machine up" without leaving here.
			const where = String(host.remote ?? "").replace(/^https?:\/\//, "").replace(/\/swarm-api$/, "");
			return {
				what: zh ? "远端" : "remote",
				detail: where + (host.remoteLabel ? `  ·  v${host.remoteLabel}` : ""),
				trouble: host.remoteError ? String(host.remoteError) : ""
			};
		}

		function VersionLine({ zh }) {
			const { host } = useHostVersion();
			const { label, release } = versionVerdict(host);
			const where = libraryLine(host, zh);
			const cell = { display: "flex", alignItems: "center", gap: "10px" };
			const key = { flex: "none", width: "44px", fontWeight: 600, color: "var(--dsw-alias-label-primary)" };
			return jsxs("div", {
				style: {
					display: "flex", flexDirection: "column", gap: "5px",
					padding: "8px 12px", marginBottom: "18px",
					border: "1px solid var(--dsw-alias-border-l1)", borderRadius: "10px",
					fontSize: "11px", color: "var(--dsw-alias-label-secondary)",
					fontVariantNumeric: "tabular-nums"
				},
				children: [
					jsxs("div", {
						style: cell,
						children: [
							jsx("span", { style: key, children: zh ? "智能体" : "Agents" }),
							jsx("span", {
								children: release || host === null
									? (zh ? `v${label} 发布版` : `v${label} release`)
									: (zh ? `v${label} 开发版` : `v${label} dev`)
							}),
							jsx("span", { style: { flex: 1 } }),
							host === null ? null : jsx("span", { children: `node ${host.node}` })
						]
					}),
					where === null ? null : jsxs("div", {
						style: cell,
						children: [
							jsx("span", { style: key, children: zh ? "信源库" : "Library" }),
							jsx("span", { style: { flex: "none" }, children: where.what }),
							jsx("span", {
								style: {
									flex: 1, minWidth: 0, overflow: "hidden",
									textOverflow: "ellipsis", whiteSpace: "nowrap",
									// The path is direction-neutral text that reads
									// left-to-right; ellipsis at the end would cut the
									// filename, which is the half worth keeping.
									direction: "rtl", textAlign: "left"
								},
								title: where.detail,
								children: where.detail
							}),
							where.trouble === "" ? null : jsx("span", {
								style: { flex: "none", fontWeight: 600, color: hue(KINDS[0], 1) },
								title: where.trouble,
								children: zh ? "连不上" : "unreachable"
							})
						]
					})
				]
			});
		}

		function SourcesSettings() {
			const zh = isChinese();
			const [config, setConfig] = useState(null);
			const [error, setError] = useState("");
			const [notice, setNotice] = useState("");
			const [busy, setBusy] = useState(false);
			const [keyDraft, setKeyDraft] = useState("");
			const [feedUrl, setFeedUrl] = useState("");
			const [feedType, setFeedType] = useState("BLOG");
			const [status, setStatus] = useState(null);
			// Feeds first: it is the pane with something to decide in it. The
			// other two are a log you read when something looks wrong and a key
			// you set once.
			const [pane, setPane] = useState("feeds");
			// The settings page belongs to no one kind, so the log borrows a
			// single accent for failures rather than tinting itself at random.
			const alert = KINDS[0];

			const reload = useCallback(async () => {
				try {
					const response = await fetch(`${apiBase()}/config`);
					const payload = await response.json();
					if (payload?.success !== true) throw new Error(payload?.error ?? "HTTP " + response.status);
					setConfig(payload.data);
					setError("");
				} catch (cause) {
					setError(String(cause?.message ?? cause));
				}
			}, []);

			const loadStatus = useCallback(async () => {
				try {
					const response = await fetch(`${apiBase()}/collect/status`);
					const payload = await response.json();
					if (payload?.success === true) setStatus(payload.data);
				} catch {
					// The log is diagnostics; failing to read it must not take the
					// settings page down with it.
				}
			}, []);

			useEffect(() => { void reload(); void loadStatus(); }, [reload, loadStatus]);

			const save = useCallback(async (patch, message) => {
				setBusy(true);
				setNotice("");
				try {
					const response = await fetch(`${apiBase()}/config`, {
						method: "PUT",
						headers: { "content-type": "application/json" },
						body: JSON.stringify(patch)
					});
					const payload = await response.json();
					if (payload?.success !== true) throw new Error(payload?.error ?? "HTTP " + response.status);
					setNotice(message);
					await reload();
				} catch (cause) {
					setError(String(cause?.message ?? cause));
				} finally {
					setBusy(false);
				}
			}, [reload]);

			const collect = useCallback(async () => {
				setBusy(true);
				setNotice("");
				try {
					const response = await fetch(`${apiBase()}/collect`, {
						method: "POST",
						headers: { "content-type": "application/json" },
						body: JSON.stringify({})
					});
					const payload = await response.json();
					if (payload?.success !== true) throw new Error(payload?.error ?? "collect failed");
					const written = payload.data.results.reduce((sum, row) => sum + (row.written ?? 0), 0);
					const failed = payload.data.results.filter((row) => row.error !== undefined);
					setNotice(
						(zh ? `采集完成：新增 ${written} 条，库共 ${payload.data.total} 条。` : `Collected ${written} new row(s); the library holds ${payload.data.total}.`)
						+ (failed.length === 0 ? "" : ` ${failed.map((row) => `${row.collector}: ${row.error}`).join("; ")}`)
					);
				} catch (cause) {
					setError(String(cause?.message ?? cause));
				} finally {
					setBusy(false);
				}
			}, [zh]);

			if (config === null) {
				return jsx("div", { style: { padding: "20px", color: "var(--dsw-alias-label-secondary)", fontSize: "13px" },
					children: error === "" ? (zh ? "加载中…" : "Loading…") : error });
			}

			const heading = { margin: "24px 0 8px", fontSize: "13px", fontWeight: 600, color: "var(--dsw-alias-label-primary)" };
			const hint = { margin: "0 0 12px", fontSize: "12px", lineHeight: "18px", color: "var(--dsw-alias-label-secondary)" };
			const rowStyle = {
				display: "flex", alignItems: "center", gap: "10px", padding: "10px 12px",
				border: "1px solid var(--dsw-alias-border-l1)", borderRadius: "10px", marginBottom: "8px",
				background: "var(--dsw-specific-menu)"
			};

			// Three panes, because these are three jobs.
			//
			// This was one column: the collection log, the collectors, seventy-two
			// feeds spelled out in full, the transcript key, and the run button,
			// in that order. Adding a feed meant scrolling past the log, and
			// reading the log meant scrolling past the feeds — it was a list of
			// everything the word "sources" can mean, in the order the features
			// happened to be written. Nothing here changed except which third of
			// it you are looking at.
			const PANES = [
				{ id: "feeds", zh: "订阅源", en: "Feeds", count: config.feeds.length },
				{ id: "collect", zh: "采集", en: "Collection" },
				{ id: "keys", zh: "密钥", en: "Keys" }
			];

			return jsxs("div", {
				style: { padding: "4px 4px 32px", maxWidth: "720px" },
				children: [
					jsx(VersionLine, { zh }),
					jsx("div", {
						role: "tablist",
						style: {
							display: "flex", gap: "2px", marginBottom: "18px",
							borderBottom: "1px solid var(--dsw-alias-border-l1)"
						},
						children: PANES.map((candidate) => jsxs("button", {
							type: "button",
							role: "tab",
							"aria-selected": pane === candidate.id,
							onClick: () => { setPane(candidate.id); },
							style: {
								appearance: "none", background: "transparent", cursor: "pointer",
								padding: "7px 12px", marginBottom: "-1px", border: "none",
								borderBottom: "2px solid " + (pane === candidate.id ? "var(--dsw-alias-label-primary)" : "transparent"),
								color: pane === candidate.id ? "var(--dsw-alias-label-primary)" : "var(--dsw-alias-label-secondary)",
								fontSize: "12px", fontWeight: pane === candidate.id ? 600 : 500
							},
							children: [
								jsx("span", { children: zh ? candidate.zh : candidate.en }),
								candidate.count === undefined ? null : jsx("span", {
									// The count belongs on the tab. How many feeds there
									// are is the first thing anyone wants from this pane,
									// and putting it here saves opening it to find out.
									style: {
										marginLeft: "6px", fontSize: "11px", fontVariantNumeric: "tabular-nums",
										color: "var(--dsw-alias-label-secondary)"
									},
									children: candidate.count
								})
							]
						}, candidate.id))
					}),
					jsx("div", {
						role: "tabpanel",
						"aria-label": zh ? PANES.find((p) => p.id === pane).zh : PANES.find((p) => p.id === pane).en,
						children: pane === "feeds"
							? jsxs("div", { children: [
							// ── feeds ─────────────────────────────────────────────────
							jsx("p", {
								style: hint,
								children: zh
									? "每次采集都会拉取这些订阅源。URL 归一化去重，重复条目不会入库。"
									: "Pulled on every collection run. Rows are deduplicated by normalized URL, so re-runs cost nothing."
							}),
							config.feeds.length === 0
								? jsx("p", { style: { ...hint, fontStyle: "italic" }, children: zh ? "尚未添加订阅源。" : "No feed configured yet." })
								: null,
							// Grouped by kind, and named.
							//
							// Seventy-two rows of raw URL, in the order they were added,
							// is not a list anybody reads -- and the names were right
							// there in the config, unused. A row now leads with what the
							// source is called and carries its URL underneath, and the
							// rows sit under the kind they belong to, so finding whether
							// a paper feed is already configured is a glance rather than
							// a scan. `index` stays the position in the ORIGINAL array,
							// because that is what Remove splices.
							...config.feeds
								.map((feed, index) => ({ feed, index }))
								.sort((a, b) =>
									(a.feed.type ?? "BLOG").localeCompare(b.feed.type ?? "BLOG")
									|| (a.feed.name ?? a.feed.url).localeCompare(b.feed.name ?? b.feed.url))
								.flatMap((entry, at, all) => {
									const kind = entry.feed.type ?? "BLOG";
									const first = at === 0 || (all[at - 1].feed.type ?? "BLOG") !== kind;
									const count = all.filter((other) => (other.feed.type ?? "BLOG") === kind).length;
									return first
										? [jsxs("div", {
											style: {
												display: "flex", alignItems: "baseline", gap: "8px",
												margin: "16px 0 6px", fontSize: "11px", letterSpacing: "0.04em",
												color: "var(--dsw-alias-label-secondary)"
											},
											children: [
												jsx("span", { style: { fontWeight: 600 }, children: kind }),
												jsx("span", { style: { fontVariantNumeric: "tabular-nums" }, children: count })
											]
										}, "kind" + kind), entry]
										: [entry];
								})
								.map((entry) => (entry.feed === undefined ? entry : (({ feed, index }) => jsxs("div", {
								style: rowStyle,
								children: [
									jsxs("span", {
										style: { flex: 1, minWidth: 0, display: "flex", flexDirection: "column", gap: "2px" },
										children: [
											jsx("span", {
												style: { fontSize: "13px", color: "var(--dsw-alias-label-primary)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" },
												children: feed.name ?? hostOf(feed.url) ?? feed.url
											}),
											jsx("span", {
												style: { fontSize: "11px", color: "var(--dsw-alias-label-secondary)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" },
												children: feed.url
											})
										]
									}),
									jsx("button", {
										type: "button",
										disabled: busy,
										style: { ...controlStyle(), height: "28px", fontSize: "12px" },
										onClick: () => {
											void save({ feeds: config.feeds.filter((_, at) => at !== index) }, zh ? "已移除。" : "Removed.");
										},
										children: zh ? "移除" : "Remove"
									})
								]
							}, "feed" + index))(entry))),
							jsxs("div", {
								style: { display: "flex", gap: "8px", marginTop: "10px" },
								children: [
									jsx("select", {
										value: feedType,
										onChange: (event) => { setFeedType(event.target.value); },
										style: controlStyle(),
										children: config.resourceTypes.map((type) => jsx("option", { value: type, children: type }, type))
									}, "type"),
									jsx("input", {
										type: "url",
										value: feedUrl,
										placeholder: "https://example.com/feed.xml",
										onChange: (event) => { setFeedUrl(event.target.value); },
										style: { ...SEARCH_STYLE, height: "34px", flex: 1 }
									}, "url"),
									jsx("button", {
										type: "button",
										disabled: busy || feedUrl.trim() === "",
										style: controlStyle(),
										onClick: () => {
											void save(
												{ feeds: config.feeds.concat([{ url: feedUrl.trim(), type: feedType }]) },
												zh ? "已添加。" : "Added."
											);
											setFeedUrl("");
										},
										children: zh ? "添加" : "Add"
									}, "add")
								]
							}),

							] })
							: pane === "collect"
							? jsxs("div", { children: [
							// ── collectors ────────────────────────────────────────────
							jsx("h3", { style: { ...heading, marginTop: "8px" }, children: zh ? "采集任务" : "Collectors" }),
							jsx("p", {
								style: hint,
								children: zh
									? "确定性采集：定时抓取并写入本地信源库，不经过模型。"
									: "Deterministic intake: fetched and written to the local library without a model in the loop."
							}),
							...config.jobs.map((job, index) => jsx("div", {
								style: rowStyle,
								children: jsxs("span", {
									style: { flex: 1, fontSize: "13px", color: "var(--dsw-alias-label-primary)" },
									children: [job.collector, jsx("span", {
										style: { marginLeft: "8px", fontSize: "12px", color: "var(--dsw-alias-label-secondary)" },
										children: JSON.stringify(job.options ?? {})
									}, "opt")]
								})
							}, "job" + index)),

							// ── collection log ────────────────────────────────────────
							// What the scheduler has actually been doing. Until now the only
							// record was `ctx.logger`, whose output does not reach this
							// harness's stdout, so a run left no trace anyone could read and
							// diagnosing one meant inferring it from timestamps on the rows.
							jsx("h3", { style: { ...heading, marginTop: "8px" }, children: zh ? "采集记录" : "Collection log" }),
							status === null ? jsx("p", { style: hint, children: zh ? "读取中…" : "Loading…" }) : jsxs("div", {
								style: { marginBottom: "16px" },
								children: [
									jsx("p", {
										style: hint,
										children: status.intervalMinutes > 0
											? (zh ? `每 ${status.intervalMinutes} 分钟自动采集一次。` : `Collecting every ${status.intervalMinutes} minutes.`)
											: (zh ? "自动采集已关闭（间隔为 0）。" : "Automatic collection is off (interval is 0).")
									}),
									status.runs.length === 0
										? jsx("div", { style: { ...rowStyle, color: "var(--dsw-alias-label-secondary)", fontSize: "12px" }, children: zh ? "服务启动后还没有跑过。" : "No run since this process started." })
										: jsxs("div", {
											children: status.runs.slice(0, 8).map((run, at) => jsxs("div", {
												style: {
													...rowStyle, alignItems: "flex-start", flexDirection: "column", gap: "4px",
													borderColor: run.failures.length === 0 ? "var(--dsw-alias-border-l1)" : hue(alert, 0.45)
												},
												children: [
													jsxs("div", {
														style: { display: "flex", flexWrap: "wrap", gap: "10px", fontSize: "12px", width: "100%" },
														children: [
															jsx("span", { style: { fontWeight: 600, color: "var(--dsw-alias-label-primary)" }, children: formatStamp(run.startedAt) }),
															jsx("span", { style: { color: "var(--dsw-alias-label-secondary)" }, children: (zh ? "作业 " : "jobs ") + run.jobs }),
															jsx("span", { style: { color: "var(--dsw-alias-label-secondary)" }, children: (zh ? "抓取 " : "fetched ") + run.fetched }),
															jsx("span", {
																style: { color: run.added > 0 ? hue(alert) : "var(--dsw-alias-label-secondary)", fontWeight: run.added > 0 ? 600 : 400 },
																children: (zh ? "新增 " : "added ") + run.added
															}),
															run.thumbnails === undefined || run.thumbnails === null ? null : jsx("span", {
																style: { color: "var(--dsw-alias-label-secondary)" },
																children: (zh ? "补图 " : "thumbnails ") + run.thumbnails.found + "/" + run.thumbnails.looked
															}),
															jsx("span", { style: { color: "var(--dsw-alias-label-secondary)" }, children: run.seconds + "s" }),
															jsx("span", { style: { flex: 1 } }, "spacer"),
															jsx("span", {
																style: { color: run.failures.length === 0 ? "var(--dsw-alias-label-secondary)" : hue(alert), fontWeight: run.failures.length === 0 ? 400 : 600 },
																children: run.failures.length === 0 ? (zh ? "全部成功" : "all ok") : (zh ? `${run.failures.length} 个源失败` : `${run.failures.length} failed`)
															})
														]
													}),
													...run.failures.slice(0, 4).map((failure, index) => jsx("div", {
														style: { fontSize: "11px", color: "var(--dsw-alias-label-secondary)" },
														children: `${failure.source} — ${failure.error}`
													}, `f${index}`))
												]
											}, `run${at}`))
										}),
									status.nextExpectedAt === null ? null : jsx("p", {
										style: { ...hint, marginTop: "8px" },
										children: (zh ? "下次预计 " : "Next expected ") + formatStamp(status.nextExpectedAt)
									})
								]
							}),
							// ── run ───────────────────────────────────────────────────
							jsx("h3", { style: heading, children: zh ? "立即采集" : "Run now" }),
							jsxs("div", {
								style: { display: "flex", alignItems: "center", gap: "10px" },
								children: [
									jsx("button", {
										type: "button",
										disabled: busy,
										style: controlStyle(),
										onClick: () => { void collect(); },
										children: busy ? (zh ? "采集中…" : "Collecting…") : (zh ? "运行全部采集任务" : "Run every collector")
									})
								]
							}),
							] })
							: jsxs("div", { children: [
							// ── provider key ──────────────────────────────────────────
							jsx("p", {
								style: hint,
								children: zh
									? "YouTube 已加固 timedtext 接口，服务端直取多数视频会返回空。官方 Data API 的 captions.download 只授权视频所属频道，无法读第三方视频。因此需要 Supadata 密钥作为兜底 —— 免费通道优先，密钥只在它失败时才消耗。"
									: "YouTube has hardened timedtext, so a server-side fetch returns an empty body for most videos, and the official Data API authorizes captions.download only for the owning channel. A Supadata key is the fallback; the free route is always tried first, so the key is spent only where it must be."
							}),
							jsxs("div", {
								style: { display: "flex", gap: "8px", alignItems: "center" },
								children: [
									jsx("input", {
										type: "password",
										value: keyDraft,
										placeholder: config.supadataKeySet
											? (zh ? "已配置（留空则保持不变）" : "Configured (leave blank to keep)")
											: (zh ? "尚未配置" : "Not configured"),
										onChange: (event) => { setKeyDraft(event.target.value); },
										style: { ...SEARCH_STYLE, height: "34px", flex: 1 }
									}, "key"),
									jsx("button", {
										type: "button",
										disabled: busy || keyDraft.trim() === "",
										style: controlStyle(),
										onClick: () => {
											void save({ supadataKey: keyDraft.trim() }, zh ? "密钥已保存。" : "Key saved.");
											setKeyDraft("");
										},
										children: zh ? "保存" : "Save"
									}, "save"),
									config.supadataKeySet
										? jsx("button", {
											type: "button",
											disabled: busy,
											style: controlStyle(),
											onClick: () => { void save({ supadataKey: "" }, zh ? "密钥已清除。" : "Key cleared."); },
											children: zh ? "清除" : "Clear"
										}, "clear")
										: null
								]
							}),
							] })
					}),
					// One line for both, below the panes: a save made on Feeds is
					// confirmed where the reader is, rather than under the Run button
					// on a pane they are not looking at.
					notice === "" ? null : jsx("p", {
						style: { marginTop: "14px", fontSize: "12px", color: "var(--dsw-alias-label-secondary)" },
						children: notice
					}),
					error === "" ? null : jsx("p", {
						style: { marginTop: "14px", fontSize: "12px", color: "var(--dsw-alias-label-secondary)" },
						children: error
					})
				]
			});
		}
		//#endregion

		//#region plugin
		/** Required service: the UI slot registry. */
		const inject = ["slots"];
		/**
		* Register the sidebar entry and its frame page as one declaration-aware
		* set. Both slots are `list`, so a fresh `id` is ADDED beside the
		* shipped entries rather than replacing one.
		*/
		function apply(ctx) {
			// The trigger and the page ARE one set: a trigger with no page to
			// open is a dead control, so they install and withdraw together.
			ctx.slots.inject("sidebar.footer.action", () => ctx.slots.inject("shell.overlay", function* () {
				yield ctx.slots.register({
					name: "sidebar.footer.action", id: "agents-swarm", order: 10, label: swarmLabel
				}, SwarmTrigger);
				yield ctx.slots.register({ name: "shell.overlay", id: "agents-swarm-page" }, SwarmPage);
			}));
			// The settings page is a SEPARATE registration, the way every
			// shipped section registers its own (`ui-settings-models` makes two
			// sibling `inject` calls, not a nested pair). Folding it into the
			// set above made the whole set wait on `settings.section`, so a
			// declaration that had not landed yet took the sidebar entry and
			// the page down with it.
			ctx.slots.inject("settings.section", () => ctx.slots.register({
				name: "settings.section",
				id: "swarm-sources",
				order: 60,
				label: () => (isChinese() ? "信源" : "Sources")
			}, SourcesSettings));
		}
		//#endregion
		exports.apply = apply;
		exports.inject = inject;
		// Exported for the bundle's own test harness: pure helpers, and the
		// components themselves. The components are here because a check that
		// never CALLS one cannot see a ReferenceError inside it, and that is
		// exactly how this file has failed — a page that renders nothing at all,
		// with the bundle served, the plugin registered, and every other check
		// green. tests/settings.test.mjs calls them.
		exports.__test__ = {
			KINDS, SORTS, youTubeVideoId, thumbnailOf, hostOf, sourceNameOf,
			authorLine, descriptionOf, formatDate, resourcesUrl, unwrapFeed,
			renderMarkdown, mergeBySentence, formatTime, displayModeOf, buildExport, stampFor,
			missionFace, missionHue, missionPillFace, missionDuration, missionMeterLine,
			missionVerifyRows, missionEventDetail, missionNoEvidence, missionActionNote,
			missionTierLine, MISSION_FILTERS, MISSION_STAGE_FACES, MISSION_VERIFY_FACES,
			missionClock, missionLatency, missionOkFace, missionRowTitle, missionRowState,
			missionTraceSignature, missionFindingsSignature,
			MISSION_ROLE_FACES, MISSION_TRACE_KINDS, MISSION_TRACE_TABS,
			SourcesSettings, SwarmPage, PublishTab, ExploreTab,
			MissionsTab, MissionStarter, MissionListRow, MissionDetail, MissionPanel,
			MissionStageStrip, MissionCostMeters, MissionDimensionCard, MissionTried,
			MissionDetailTabs, MissionTaskBoard, MissionSources, MissionEmptyPane,
			MissionStageSpend, MissionToolTable, MissionDegradeNote, MissionReferenceList,
			missionReferences, missionMarkerCount, missionCompact,
			MissionTimeline, MissionReport, MissionEvidenceRow,
			MissionTrace, MissionTraceRow, MissionTraceDetail,
			MissionDimensions, MissionDimensionFindings, MissionFindingRow,
			MissionSourceReader,
			VersionLine, libraryLine
		};
		return module.exports;
	}
});
