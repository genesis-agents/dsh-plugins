window.__ModuleLoader__.load({
	id: "dsh-agents-swarm",
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
		const INLINE_PATTERN = /(`[^`]+`)|(\*\*[^*]+\*\*)|(\*[^*\n]+\*)|(\[[^\]]+\]\([^)\s]+\))/g;

		/**
		* Split one line into React children, honouring inline Markdown.
		* @param text - the raw line.
		* @param keyPrefix - key namespace for the produced nodes.
		* @returns an array of strings and elements.
		*/
		function renderInline(text, keyPrefix) {
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
		* @returns an array of block elements.
		*/
		function renderMarkdown(source, variant = "chat") {
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
					children: renderInline(text, `p${key}`)
				}, `p${key++}`));
				paragraph = [];
			};
			const flushList = () => {
				if (list === null) return;
				const items = list.items.map((item, at) => jsx("li", {
					style: article ? { margin: "0 0 8px", lineHeight: "1.7" } : { margin: "0 0 5px" },
					children: renderInline(item, `l${key}-${at}`)
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
						children: renderInline(heading[2], `h${key}`)
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
						setEpisodes(payload.data.episodes);
						setEpisodeTotal(payload.data.total ?? payload.data.episodes.length);
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
												onBlur: (event) => { void saveSchedule({ publishAt: event.target.value }); },
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
				ledeEn: "Claims the swarm extracted from those sources, with provenance.",
				ledeZh: "蜂群从信源中提炼出的结论，附出处。",
				emptyEn: "No insight extracted yet.", emptyZh: "暂无洞察产出。"
			},
			{
				id: "research", en: "Research", zh: "研究",
				ledeEn: "Deep-dive tasks opened against an insight, and their findings.",
				ledeZh: "针对某条洞察展开的深度调研任务及其发现。",
				emptyEn: "No research task open.", emptyZh: "暂无进行中的研究任务。"
			},
			{
				id: "simulation", en: "Simulation", zh: "推演",
				ledeEn: "Scenarios played forward from the research, with their assumptions stated.",
				ledeZh: "基于研究结论向前推演的情景，并显式列出所依赖的假设。",
				emptyEn: "No scenario built yet.", emptyZh: "尚未建立推演情景。"
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
							jsx("span", { style: { flex: 1 }, children: swarmLabel() }),
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
								jsx("span", { children: zh ? candidate.zh : candidate.en })
							]
						}, candidate.id))
					}),
					jsx("div", {
						style: active.id === "sources" ? READER_BODY_STYLE : BODY_STYLE,
						role: "tabpanel",
						"aria-label": zh ? active.zh : active.en,
						children: jsx("div", {
							style: active.id === "sources" ? { ...WIDE_STYLE, height: "100%", minHeight: 0 } : CONTENT_STYLE,
							children: active.id === "sources"
								? jsx(ExploreTab, { zh })
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

			return jsxs("div", {
				style: { padding: "4px 4px 32px", maxWidth: "720px" },
				children: [
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

					// ── feeds ─────────────────────────────────────────────────
					jsx("h3", { style: heading, children: zh ? "RSS / Atom 订阅源" : "RSS / Atom feeds" }),
					jsx("p", {
						style: hint,
						children: zh
							? "每次采集都会拉取这些订阅源。URL 归一化去重，重复条目不会入库。"
							: "Pulled on every collection run. Rows are deduplicated by normalized URL, so re-runs cost nothing."
					}),
					config.feeds.length === 0
						? jsx("p", { style: { ...hint, fontStyle: "italic" }, children: zh ? "尚未添加订阅源。" : "No feed configured yet." })
						: null,
					...config.feeds.map((feed, index) => jsxs("div", {
						style: rowStyle,
						children: [
							jsx("span", {
								style: {
									padding: "1px 8px", borderRadius: "999px", fontSize: "11px",
									background: "var(--dsw-alias-interactive-bg-hover)", color: "var(--dsw-alias-label-secondary)"
								},
								children: feed.type ?? "BLOG"
							}),
							jsx("span", {
								style: { flex: 1, minWidth: 0, fontSize: "13px", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", color: "var(--dsw-alias-label-primary)" },
								children: feed.url
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
					}, "feed" + index)),
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

					// ── provider key ──────────────────────────────────────────
					jsx("h3", { style: heading, children: zh ? "字幕服务密钥" : "Transcript provider key" }),
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
							}),
							notice === "" ? null : jsx("span", {
								style: { fontSize: "12px", color: "var(--dsw-alias-label-secondary)" },
								children: notice
							})
						]
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
		// Pure helpers, exported for the bundle's own test harness.
		exports.__test__ = {
			KINDS, SORTS, youTubeVideoId, thumbnailOf, hostOf, sourceNameOf,
			authorLine, descriptionOf, formatDate, resourcesUrl, unwrapFeed,
			renderMarkdown, mergeBySentence, formatTime, displayModeOf, buildExport, stampFor
		};
		return module.exports;
	}
});
