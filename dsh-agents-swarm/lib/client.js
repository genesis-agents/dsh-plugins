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

		//#region design tokens
		/**
		* The one place a colour is decided, and the only place a literal one
		* may be written.
		*
		* WHAT THIS REPLACES. Every vocabulary table in this file used to carry
		* its own `hue: TONE.success` — eight literals across sixty-two
		* occurrences, all of them Tailwind's palette transcribed from the
		* reference rather than taken from the host. Three consequences, and not
		* one of them throws:
		*
		*   1. NO DARK MODE. The harness flips its entire alias layer on
		*      `body[data-ds-dark-theme]`. A literal triple does not flip. The
		*      chip tint this file draws everywhere — `rgba(hue,0.08)` — is 8%
		*      of a mid-tone over `rgb(35,35,36)` in the dark theme, which is
		*      invisible, while the same rule carries the whole stage strip in
		*      the light one. A strip that silently loses its colour is the
		*      class of failure docs/architecture.md §9 names: the check that
		*      passes is not the check that matters.
		*   2. NOT THE HOST'S GREEN. The harness has a success colour and this
		*      was not it, so a verified chip here and a success dot elsewhere
		*      in the same window were two different greens — close enough to
		*      read as a rendering fault rather than as a choice.
		*   3. ONE DECISION, SIX COPIES. `running` was declared in five tables
		*      and once inline. Changing it is five edits and a miss.
		*
		* THREE LAYERS, AND THE MIDDLE ONE IS THE POINT. `PALETTE` is the ramp
		* and carries no meaning; `TONE` says what a STATE looks like; `KIND`
		* and `ROLE_TONE` say what a CATEGORY looks like. Collapsing the last
		* two into the first is the mistake this file already made once: source
		* kinds were drawn in the same red as a failed stage, so the eye learned
		* that red means "bad" on one tab and "YouTube" on the next. A category
		* ramp and a state ramp must be separable even when they share a hue.
		*
		* WHY THE VARS HOLD TRIPLES AND NOT COLOURS. `--swm-h-green` is
		* `34,197,94`, not `rgb(34,197,94)`, because every consumer builds a tint
		* from it: `rgb(var(--swm-h-green))` is a chip's text and
		* `rgba(var(--swm-h-green),0.12)` its background. A var holding a
		* finished colour cannot do the second, and a second var holding the
		* tint would put the alpha decision back in sixty-two places. The triple
		* substitutes into legacy `rgb()`/`rgba()` syntax, which is why every
		* `rgb(${hue})` template already in this file kept working unchanged
		* when the literals were swapped for these names.
		*
		* WHERE THE VALUES COME FROM. The five the harness itself defines are
		* the harness's, read from its `design-platform.css` and named beside
		* each, so this tab's success is the shell's success. The four it has no
		* equivalent for exist only to keep seven agent roles and six source
		* kinds apart, and follow the harness's own convention for a hue: a
		* 600-weight in light, a 400-weight in dark.
		*/
		const SWM_STYLE_ID = "dsw-swarm-tokens";
		const SWM_CSS = [
			"body{",
			"--swm-h-green:34,197,94;",       // = --dsw-static-green-500
			"--swm-h-amber:221,134,41;",      // = --dsw-static-amber-600
			"--swm-h-red:236,19,19;",         // = --dsw-static-red-600
			"--swm-h-blue:65,118,230;",       // = --dsw-static-deepseek-500
			"--swm-h-slate:97,102,107;",      // = --dsw-static-neutral-bluish-700
			"--swm-h-slate-dim:129,133,140;", // = --dsw-static-neutral-bluish-600
			"--swm-h-violet:124,58,237;",
			"--swm-h-indigo:79,70,229;",
			"--swm-h-cyan:8,145,178;",
			"--swm-h-rose:225,29,72;",
			"--swm-a-soft:0.10;",
			"--swm-a-ring:0.28;",
			"--swm-a-fill:0.90;",
			"}",
			"body[data-ds-dark-theme]{",
			"--swm-h-green:78,209,126;",      // = --dsw-static-green-400
			"--swm-h-amber:247,173,49;",      // = --dsw-static-amber-400
			"--swm-h-red:242,90,90;",         // = --dsw-static-red-400
			"--swm-h-blue:103,158,254;",      // = --dsw-static-deepseek-400
			"--swm-h-slate:207,211,214;",     // = --dsw-static-neutral-bluish-300
			"--swm-h-slate-dim:173,178,184;", // = --dsw-static-neutral-bluish-400
			"--swm-h-violet:167,139,250;",
			"--swm-h-indigo:129,140,248;",
			"--swm-h-cyan:34,211,238;",
			"--swm-h-rose:251,113,133;",
			// THE ALPHAS ARE THEME-AWARE TOO, and this is the half that is easy
			// to miss: a tint is a hue AND an alpha, so making only the hue flip
			// leaves the tint half-corrected. 8% of a mid-tone over white is a
			// visible wash; 8% of the same tone over rgb(35,35,36) is nothing.
			// The dark values are raised, not the hues.
			"--swm-a-soft:0.16;",
			"--swm-a-ring:0.36;",
			"--swm-a-fill:0.92;",
			"}"
		].join("");

		/**
		* Put a stylesheet in the document, at most once, and never throw.
		*
		* Guarded rather than assumed: this module is executed in Node by
		* tests/settings.test.mjs against a hand-written `document` stub, and a
		* bundle that throws at load time there is a bundle nobody can test. The
		* trajectory sheet and the token sheet are two callers of ONE injector,
		* because a second copy of this function is where the two would drift on
		* which host to append to.
		* @param id - the element id, so a second call is a no-op.
		* @param css - the sheet's text.
		*/
		function ensureStyle(id, css) {
			try {
				if (typeof document?.getElementById !== "function") return;
				if (document.getElementById(id) !== null) return;
				const node = document.createElement("style");
				node.id = id;
				node.textContent = css;
				const host = document.head ?? document.documentElement;
				if (typeof host?.appendChild === "function") host.appendChild(node);
			} catch {
				// A host that will not take a stylesheet still gets a working
				// page: every name below carries the light-theme triple as its
				// var fallback, so the chips keep their colours and only the
				// dark-theme correction is lost.
			}
		}

		/**
		* The ramp. Ten hues, no meanings.
		*
		* THE FALLBACKS ARE NOT DECORATION. Each name is `var(--x, <triple>)`
		* with the light-theme value inline, so a page whose style injection was
		* refused still renders coloured chips rather than `rgb()` with an empty
		* argument — which is a chip with no text on a background of nothing.
		*/
		const PALETTE = {
			green: "var(--swm-h-green,34,197,94)",
			amber: "var(--swm-h-amber,221,134,41)",
			red: "var(--swm-h-red,236,19,19)",
			blue: "var(--swm-h-blue,65,118,230)",
			slate: "var(--swm-h-slate,97,102,107)",
			slateDim: "var(--swm-h-slate-dim,129,133,140)",
			violet: "var(--swm-h-violet,124,58,237)",
			indigo: "var(--swm-h-indigo,79,70,229)",
			cyan: "var(--swm-h-cyan,8,145,178)",
			rose: "var(--swm-h-rose,225,29,72)"
		};

		/**
		* What a STATE looks like. Six, and every status vocabulary in this file
		* resolves into these rather than choosing a hue of its own.
		*
		* `muted` is separate from `neutral` because "not started" and "we do not
		* know" are drawn at different weights: a pending stage should recede,
		* an unknown status should not.
		*/
		const TONE = {
			success: PALETTE.green,
			warn: PALETTE.amber,
			danger: PALETTE.red,
			info: PALETTE.blue,
			neutral: PALETTE.slate,
			muted: PALETTE.slateDim,
			accent: PALETTE.violet
		};

		/**
		* The seven agents, each with a colour that is only ever theirs.
		*
		* The reference gives every role a hue and prints it on the roster, on
		* the task board and on every trajectory row, which is what makes "who
		* is working" answerable at a glance. This tab printed role names in
		* body text and nothing else, so the same answer cost a read of every
		* row.
		*
		* Assignments follow the reference where the roles coincide — Leader
		* violet, Researcher blue, Analyst amber, Writer rose — and the two it
		* does not have are placed by meaning: the Verifier is the agent that
		* checks evidence, so it takes green, and the Reviewer is the critic, so
		* it takes red. `mission` is the fallback for a row belonging to no
		* agent, and is the only neutral one.
		*/
		const ROLE_TONE = {
			leader: PALETTE.violet,
			researcher: PALETTE.blue,
			analyst: PALETTE.amber,
			reconciler: PALETTE.cyan,
			writer: PALETTE.rose,
			reviewer: PALETTE.red,
			verifier: PALETTE.green,
			mission: PALETTE.slate
		};

		/**
		* The colour of an agent id, which is not always a bare role.
		*
		* Researchers are minted per dimension — `researcher:d3` — so an exact
		* lookup answers `mission` for the one role that appears most often on
		* screen. The prefix before the colon is the role.
		* @param agentId - a role, an instance id, or null.
		* @returns a colour triple, never undefined.
		*/
		function roleTone(agentId) {
			const key = String(agentId ?? "").split(":")[0].trim().toLowerCase();
			return Object.hasOwn(ROLE_TONE, key) ? ROLE_TONE[key] : ROLE_TONE.mission;
		}

		/**
		* What a PUBLISHED FORMAT looks like, and why it is a table rather than
		* an index.
		*
		* The publish switcher took each format's colour from the SOURCE-KIND
		* ramp by rotating through it — `KINDS[(at + 1) % KINDS.length]` — so a
		* format's identity was decided by the order the Host happened to return
		* it in, and adding one format shifted the colour of every format after
		* it. A colour that moves when its neighbour changes is not an identity;
		* it is a position. Worse, it was the SOURCE ramp: a written digest was
		* drawn in the hue that means "YouTube" two tabs away, which is the
		* category-against-category mixing the docblock above forbids one layer
		* along.
		*
		* Keyed by format id, which is the Host's own stable name for the thing.
		* A format this table has never heard of falls back to TONE.accent — the
		* product's own colour — rather than to a rotation, so an unlisted
		* format looks unlisted instead of looking like one of the four.
		*/
		const FORMAT_TONE = {
			podcast: PALETTE.rose,
			digest: PALETTE.blue,
			report: PALETTE.indigo,
			brief: PALETTE.cyan
		};

		/**
		* The colour of a publish format.
		* @param id - a format id, or null.
		* @returns a colour triple, never undefined.
		*/
		function formatTone(id) {
			const key = String(id ?? "").trim().toLowerCase();
			return Object.hasOwn(FORMAT_TONE, key) ? FORMAT_TONE[key] : TONE.accent;
		}

		/**
		* The type scale, which is the harness's and not ours.
		*
		* MEASURED BEFORE IT WAS WRITTEN. This file declared ten distinct font
		* sizes as raw pixels — 10, 11, 12, 13, 14, 15, 16, 18, 20 and 30 — and
		* reached the harness's own scale exactly seven times out of roughly
		* three hundred declarations. Ten sizes is not a scale; it is the
		* residue of each region deciding locally, and the visible result is
		* that two panels side by side set their labels one pixel apart, which
		* reads as a rendering fault rather than as a hierarchy.
		*
		* Each name below is a `font` SHORTHAND, so it carries family, size,
		* weight and line height together. That is the point: a size chosen here
		* and a line height chosen at the call site is how this file ended up
		* with 11px text on a 19px line in one panel and a 17px line in the next.
		*
		* THE STRONG VARIANTS ARE 500, NOT 600. The harness's emphasis weight is
		* 500 at every step below 24px, and this file used 600 forty-eight times,
		* 650 twice and 700 twice. Those are heavier than anything the shell
		* draws, which is why the tab reads as slightly shouty next to the rest
		* of the app. Use `*Strong` for emphasis and let the shell decide what
		* emphasis weighs.
		*
		* `display` is the only 600 in the set because the harness's own 24px
		* step is 600 — the exception is the shell's, not ours.
		*/
		const FONT = {
			micro: "var(--dsw-font-xxxs-11)",
			microStrong: "var(--dsw-font-xxxs-strong-11)",
			small: "var(--dsw-font-xxs-12)",
			smallStrong: "var(--dsw-font-xxs-strong-12)",
			body: "var(--dsw-font-xs-13)",
			bodyStrong: "var(--dsw-font-xs-strong-13)",
			base: "var(--dsw-font-s-14)",
			baseStrong: "var(--dsw-font-s-strong-14)",
			large: "var(--dsw-font-base-16)",
			largeStrong: "var(--dsw-font-base-strong-16)",
			title: "var(--dsw-font-l-20)",
			display: "var(--dsw-font-xl-24)"
		};

		/**
		* Mono where the text is DATA rather than prose, HOISTED OUT OF THE
		* MISSIONS REGION.
		*
		* A tool name, a JSON argument and a source host are things a person
		* compares character by character across rows, and a proportional face
		* makes two nearly-identical queries look identical.
		*
		* It was declared beside the trajectory table, four thousand lines below
		* this one, which is harmless for a function body — a body is only
		* evaluated when it is called — and fatal for a top-level `const`.
		* `COUNT_CHIP` below reads it at module evaluation, so leaving the
		* declaration down there is not a style bug: it is a TDZ
		* `ReferenceError` at load and a blank tab.
		*
		* A stack that thirteen places in this file already reach for belongs
		* beside the type scale anyway. `var(--ds-font-family-code)` is the
		* harness's own name for the same thing and is used by the trajectory
		* sheet; this is the JavaScript-side spelling, with the fallbacks
		* written out because a `font-family` cannot carry a var fallback list
		* through a `font` shorthand.
		*/
		const MONO = "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace";

		/**
		* The spacing rhythm: five steps, all multiples of four.
		*
		* This file used sixteen distinct gap values — including 1, 3, 7, 9, 11
		* and 18 — and roughly thirty distinct padding strings. A 9px gap beside
		* a 10px gap is not a decision anybody made; it is two people typing.
		* Five steps is enough for every layout in this tab and few enough that
		* choosing between them is a real choice.
		*/
		const SPACE = { xs: "4px", sm: "8px", md: "12px", lg: "16px", xl: "24px" };

		/**
		* Corner radii: four, plus the two shapes that are not radii at all.
		*
		* Thirteen values were in use, nine of them within six pixels of each
		* other. `pill` and `circle` are separate names because they are shapes
		* — a 999px radius on a rectangle and a 50% radius on a square are
		* different intentions, and spelling both as numbers is how a chip ends
		* up almost round.
		*/
		const RADIUS = { sm: "6px", md: "8px", lg: "12px", pill: "999px", circle: "50%" };

		/**
		* A STATE's shape, which is not a CATEGORY's shape.
		*
		* Six literals drew one status pill: `1px 7px` on a 5px radius in the
		* list, `1px 8px` on a 6px radius in the header, and four more between
		* them. None of the six was round, so the shape that was meant to
		* separate "what this is" from "how it is going" said nothing at all,
		* and the 5px/6px difference is a pixel nobody chose — visible only when
		* the list and the header are on screen together, which is always.
		*
		* THE RING IS AN INSET SHADOW, not a border, for the reason
		* `pressedStyle` gives one paragraph over: a border grows the box, so a
		* pill that gains or loses one as its state changes nudges everything
		* beside it along the row.
		*
		* CATEGORIES STAY ON `RADIUS.sm` — the stage strip, the task board's
		* origin, every tally. A category is not a state, and collapsing the two
		* ramps into one shape is the mistake the tokens docblock above names:
		* the eye learns a shape faster than it reads a word.
		*
		* Reads TINT and TONE, which are declared below it. That is safe because
		* a function body is evaluated when it is called and this is only ever
		* called from a render — the same reason `COUNT_CHIP`, which is an
		* object literal, could NOT be written here.
		* @param tone - the colour triple.
		* @param size - "md" beside a title, otherwise the 11px default.
		* @returns a style object to spread.
		*/
		function pillStyle(tone, size) {
			const step = size === "md"
				? { font: FONT.smallStrong, padding: `1px ${SPACE.sm}`, gap: SPACE.xs }
				: { font: FONT.microStrong, padding: "1px 6px", gap: SPACE.xs };
			return {
				...step,
				display: "inline-flex", alignItems: "center", boxSizing: "border-box",
				borderRadius: RADIUS.pill,
				background: `rgba(${tone ?? TONE.neutral},${TINT.soft})`,
				color: `rgb(${tone ?? TONE.neutral})`,
				boxShadow: `inset 0 0 0 1px rgba(${tone ?? TONE.neutral},${TINT.ring})`,
				whiteSpace: "nowrap"
			};
		}

		/** Icon box sizes: inline, default, and section-header. Three, as the reference has three. */
		const ICON = { xs: "12px", sm: "14px", md: "16px" };

		/**
		* The three strengths a tinted surface may have.
		*
		* Twelve distinct alphas were in use — 0.035, 0.05, 0.06, 0.08, 0.09,
		* 0.10, 0.12, 0.13, 0.25, 0.35, 0.45, 0.9 — and the eight at the bottom
		* were all trying to be the same thing: a chip's background. Three steps
		* with names is enough, and naming them is what lets the dark theme raise
		* all of them at once.
		*
		* `soft` is a fill you read text on top of, `ring` is a border you read
		* the fill through, `fill` is the tone itself standing in for a surface.
		*/
		const TINT = {
			soft: "var(--swm-a-soft,0.10)",
			ring: "var(--swm-a-ring,0.28)",
			fill: "var(--swm-a-fill,0.90)"
		};

		/**
		* Five surface roles over the harness's ten background variables.
		*
		* The count is the finding: ten names were in use for what is really
		* base / card / subtle / hover / code, so two panels meant to sit at the
		* same depth were drawn a layer apart.
		*/
		const SURFACE = {
			base: "var(--dsw-alias-bg-base)",
			card: "var(--dsw-specific-menu)",
			subtle: "var(--dsw-alias-bg-layer-2)",
			hover: "var(--dsw-alias-interactive-bg-hover)",
			code: "var(--dsw-alias-markdown-code-block)"
		};

		/** Three depths. `raised` is a card, `floating` is something over a card. */
		const ELEVATION = {
			flat: "none",
			raised: "var(--dsw-shadow-lv1)",
			floating: "var(--dsw-shadow-lv3)"
		};

		/**
		* Two line weights, and WHICH ONE TO USE IS A RULE, not a preference.
		*
		* `hair` is a container's OUTER edge. It sits under a shadow, so it only
		* has to define the top edge the shadow cannot reach, and it may be
		* nearly invisible.
		*
		* `rule` is an INNER divider between siblings. Nothing helps it — there
		* is no shadow on a table row — so it has to read on its own.
		*
		* This file alternated between the two with no rule at all, which is why
		* two adjacent panels drew the same separator at two different weights.
		* A test cannot check this one: both are legal references and the choice
		* is semantic. The docblock is the guard.
		*/
		const LINE = {
			hair: "var(--dsw-alias-border-l1)",
			rule: "var(--dsw-alias-border-l2)"
		};

		/**
		* Three text weights, and `quiet` HAS A CONTRAST BUDGET.
		*
		* `--dsw-alias-label-tertiary` resolves to rgb(129,133,140): 3.71:1 on
		* white, under the 4.5:1 that normal-size text needs. So `quiet` is for
		* text that is decoration — a row ordinal, a unit suffix, a timestamp
		* beside the thing it stamps — and never for a value the reader has to
		* read. Thirteen meta lines in this file were on `quiet` at 11px, which
		* is the combination that fails hardest.
		*/
		const INK = {
			primary: "var(--dsw-alias-label-primary)",
			secondary: "var(--dsw-alias-label-secondary)",
			quiet: "var(--dsw-alias-label-tertiary)"
		};

		/**
		* A bare quantity, drawn as a badge instead of as grey text.
		*
		* Counts in this file were printed as 10px monospace in `INK.quiet` —
		* the decoration weight, at the size that fails contrast hardest — with
		* no background and no padding, so "6" beside a pane name read as a
		* rendering artefact rather than as the answer to "how many". It is a
		* neutral fill because a count is not a state: it must not compete with
		* the tinted chips beside it.
		*
		* `--dsw-alias-fill-tertiary` is the harness's own neutral fill and had
		* exactly one consumer in this file. It follows the theme; a hand-mixed
		* grey does not.
		*
		* `font` FIRST, then the family and the figures. The shorthand resets
		* both, so a `fontVariantNumeric` written above it is discarded and the
		* digits stop aligning in the one place alignment is the point.
		*/
		const COUNT_CHIP = {
			font: FONT.micro,
			fontFamily: MONO,
			fontVariantNumeric: "tabular-nums",
			display: "inline-flex", alignItems: "center",
			height: "16px", padding: "0 5px", borderRadius: RADIUS.sm,
			background: "var(--dsw-alias-fill-tertiary)",
			color: INK.secondary
		};

		/**
		* ONE table cell, and ONE table header cell, for all three tables.
		*
		* THE MEASUREMENT. Three tables on three panes of the same tab drew the
		* same object three ways. Headers: `6px 9px` at 500 in `INK.secondary`,
		* `7px 10px` at 500 in `INK.secondary`, and — in the roster — no padding
		* at all, at the plain weight, right-aligned. Cells: an 18px line here,
		* an 18px line and `verticalAlign:"top"` there, a 26px line and NO
		* padding whatsoever in the third. Three heights, three paddings, two
		* header weights. None of the differences was decided; each is what one
		* person typed on one afternoon, and they are only visible when a reader
		* moves between the cost pane's three tables in the space of a minute,
		* which is the whole reason those tables are on one pane.
		*
		* `fontVariantNumeric` IS UNCONDITIONAL, and that is the point of
		* putting it here. Every one of these tables is mostly figures, and the
		* three that carried tabular-nums carried it per cell — so a column added
		* later got proportional digits and the ones above it did not, which is
		* how a total stops lining up under the column it totals. A cell with no
		* digits in it is unaffected by the property, so the blanket setting
		* costs nothing and closes the hole for good.
		*
		* `font` FIRST in both, for the reason FONT's docblock gives: the
		* shorthand resets weight, leading AND font-variant, so a
		* `fontVariantNumeric` written above it is silently discarded. Anything
		* that spreads `TD` and then overrides `font` must write the variant
		* again after it — the spread carries the old order, not the new one.
		*
		* WHY THEY ARE HERE AND NOT BESIDE `RADIUS`, where the batch spec put
		* them: they read `INK`, `LINE` and `SURFACE`, all of which are declared
		* below `RADIUS`. An object literal is evaluated where it is written, so
		* up there this is not a style bug — it is the same TDZ `ReferenceError`
		* at load, and the same blank tab, that moved `MONO` up here in the
		* first place.
		*
		* `LINE.rule` and not `LINE.hair` for the divider, against the spec's
		* `border-l1`: LINE's own docblock names a table row as the example of
		* an inner divider with no shadow helping it, and two of the three
		* tables had already reached for `rule`.
		*/
		const TH = {
			font: FONT.smallStrong,
			boxSizing: "border-box",
			height: "30px", padding: `0 ${SPACE.sm}`,
			// INK.secondary, not the spec's `label-tertiary`. A column header is
			// a word the reader has to read to know what the column is, and
			// INK's docblock puts tertiary at 3.71:1 — the decoration budget.
			// All three tables already used secondary; the spec was reading the
			// roster's `INK.secondary` as tertiary.
			color: INK.secondary,
			background: SURFACE.subtle,
			textAlign: "left", whiteSpace: "nowrap",
			overflow: "hidden", textOverflow: "ellipsis",
			userSelect: "none"
		};

		const TD = {
			font: FONT.small,
			fontVariantNumeric: "tabular-nums",
			boxSizing: "border-box",
			height: "30px", padding: `0 ${SPACE.sm}`,
			color: INK.primary,
			overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
			borderBottom: `1px solid ${LINE.rule}`
		};

		/**
		* THE GROUND A BAR IS MEASURED AGAINST.
		*
		* All four progress tracks in this file painted themselves with a LINE
		* token. Those resolve to `--dsw-alias-border-l1` and `-l2`, which are
		* black overlays at 4% and 10%: a sensible hairline on a white page, and
		* literally nothing on the dark theme's own dark ground. Three of the
		* four bars therefore had no track at all on dark — a coloured sliver
		* floating in the page with nothing behind it to say how much of the run
		* it stood for, which is the entire information a bar carries.
		*
		* A LINE TOKEN IS AN EDGE, NOT A FILL, and that is the rule the four
		* sites broke. `SURFACE.hover` is the harness's own neutral interactive
		* fill, declared in both themes, so it lifts on dark instead of
		* disappearing.
		*
		* `pill`, because a 6px bar with a 3px radius IS a pill spelled as a
		* number — and the three radii in use (2px, 3px, none) were three
		* spellings of that one intention.
		*/
		const TRACK = {
			background: SURFACE.hover,
			borderRadius: RADIUS.pill,
			overflow: "hidden"
		};

		/**
		* Two recedes. `disabled` is a control that cannot be used; `quiet` is
		* content that is present and secondary.
		*
		* Twenty-five controls in this file set `disabled` and seven showed it,
		* in five different opacities. A button that is refused and looks
		* pressable is a click the user makes twice.
		*/
		const OPACITY = { disabled: 0.45, quiet: 0.65 };

		/**
		* Three durations on one curve.
		*
		* Nine hand-typed durations across three values, all of them on the
		* browser's default `ease`, which is the one curve no design system
		* chooses: it accelerates out of rest too slowly and arrives too fast.
		*/
		const MOTION = {
			fast: "150ms cubic-bezier(.4,0,.2,1)",
			base: "200ms cubic-bezier(.4,0,.2,1)",
			slow: "300ms cubic-bezier(.4,0,.2,1)"
		};

		/**
		* The interaction sheet, and why it is a SECOND string.
		*
		* It has to be declared here rather than beside the variables, because
		* every rule below interpolates a token — MOTION, SURFACE, INK, RADIUS,
		* TINT — and `SWM_CSS` is initialised at the top of this module, before
		* any of them exist. Written up there it is not a style bug, it is a
		* `ReferenceError` at load and a blank tab.
		*/
		const SWM_RULES = [

			// ── interaction ──────────────────────────────────────────────
			// AN INLINE STYLE OBJECT CANNOT EXPRESS A STATE. `:hover`,
			// `:focus-visible`, `:disabled`, `::after` and `@media` are all
			// unreachable from a `style: {}`, which is why this file — 590
			// style objects deep — had a focus ring on exactly the 44 elements
			// that happened to carry a `.swt-*` class, and none anywhere else.
			// Keyboard users could not see where they were on sixty buttons.
			//
			// These ship on THIS sheet rather than the trajectory's, because
			// TRACE_CSS mounts only when the trace pane opens while SWM_CSS is
			// injected by the page itself, before first paint.
			`.swm-focus:focus-visible{outline:2px solid var(--dsw-alias-state-business-primary);outline-offset:2px;border-radius:inherit}`,
			// A mouse click focuses too. Without this the ring fires on every
			// press and reads as a stuck selection rather than as a keyboard
			// position.
			`.swm-focus:focus:not(:focus-visible){outline:none}`,
			// THE RESTING BACKGROUND AND THE RESTING INK LIVE HERE, NOT IN THE
			// BUILDER, and that is the whole reason the two hover rules under
			// them do anything. `controlStyle()` used to return
			// `background: "transparent", color: INK.secondary` as inline keys,
			// and an inline declaration beats a stylesheet whatever the
			// selector — so both halves of `.swm-ctl:hover` were overridden on
			// every one of the fifty-odd controls that wear the class, and the
			// failure had no symptom to search for. Same defect, same fix as
			// `.swm-tr` and `.swm-tab` before it: the reset moves to the rule.
			`.swm-ctl{background:transparent;color:${INK.secondary};transition:background ${MOTION.fast},border-color ${MOTION.fast},color ${MOTION.fast}}`,
			`.swm-ctl:hover:not(:disabled){background:${SURFACE.hover};color:${INK.primary}}`,
			// The chip carries its own hue as a custom property so one rule can
			// serve six categories. React passes `--`-prefixed style keys
			// through unchanged, which is the whole mechanism.
			//
			// The INACTIVE chip is painted here for the same reason: `chipStyle`
			// wrote `background: "transparent"` inline and its own comment said
			// that was what kept the hover reachable. It was the opposite.
			`.swm-chip{background:transparent;color:${INK.secondary}}`,
			`.swm-chip:hover{background:rgba(var(--swm-chip-h,var(--swm-h-slate)),${TINT.soft})}`,
			`.swm-iconbtn{display:inline-flex;align-items:center;justify-content:center;border:0;background:transparent;color:${INK.quiet};cursor:pointer;border-radius:${RADIUS.sm};transition:background ${MOTION.fast},color ${MOTION.fast}}`,
			`.swm-iconbtn:hover{color:${INK.primary};background:${SURFACE.hover}}`,
			`.swm-iconbtn:focus-visible{outline:1px solid var(--dsw-alias-state-business-primary);outline-offset:-1px}`,
			// Leaving a screen is not aborting one. The back control used to
			// take the same hover as a destructive button. The resting pair is
			// on the class rather than in `backStyle()` for the reason above:
			// inline beats the sheet, so a builder that writes them is a
			// builder that switches its own hover off.
			`.swm-back{background:transparent;color:${INK.secondary}}`,
			`.swm-back:hover{background:${SURFACE.hover};color:${INK.primary}}`,

			// ── motion ───────────────────────────────────────────────────
			// The first animation in 11,248 lines, and it arrives WITH its
			// opt-out rather than after a complaint. A spinner that cannot be
			// stopped is a vestibular trigger, and `prefers-reduced-motion` is
			// the setting that says so.
			`@keyframes swm-spin{to{transform:rotate(360deg)}}`,
			`.swm-spin{animation:swm-spin 900ms linear infinite;transform-origin:50% 50%}`,
			`@keyframes swm-pulse{0%,100%{opacity:1}50%{opacity:.45}}`,
			`.swm-live{animation:swm-pulse 1600ms ease-in-out infinite}`,
			// THE SHAPE OF AN ANSWER THAT HAS NOT ARRIVED YET. Every screen-level
			// wait in this file drew the SAME dashed box as "there is nothing here"
			// and as "the read failed", so the three states a person most needs to
			// tell apart at a glance were one picture — and the worst of the three
			// confusions is between an emptiness and a failure, because they call
			// for opposite reactions.
			//
			// It REUSES `swm-pulse` rather than declaring a second set of keyframes
			// at a second rate. A live dot and a skeleton make the same statement —
			// this is not finished — and two curves for one statement is how a page
			// ends up breathing at two speeds.
			//
			// The fill is the meter's own track colour, because a skeleton block and
			// an empty track are the same drawing: a box with nothing in it yet.
			`.swm-skel{background:${SURFACE.hover};border-radius:${RADIUS.sm};animation:swm-pulse 1600ms ease-in-out infinite}`,
			`@media (prefers-reduced-motion:reduce){.swm-spin,.swm-live,.swm-skel{animation:none}.swm-ctl,.swm-iconbtn{transition:none}}`,

			// ── layout a style object cannot express ─────────────────────
			// The twelve-stage ruler is a GRID at three widths, and a width is a
			// media query. The strip carries the twelve-column base inline too,
			// so the ruler is a ruler even in the frame that renders before a
			// sheet lands; these three only ever narrow it.
			//
			// TWELVE, SIX, FOUR — factors of twelve, on purpose. A ruler that
			// reflowed to five columns would put s6 under s1 on one screen and
			// under s2 on the next, and the whole value of a fixed strip is that
			// the shape is the same every time you look at it.
			// The event stream's spine, as a pseudo-element because a wrapper
			// div with a left border would draw the line past the first and last
			// dot instead of between them.
			`.swm-rail{position:relative;padding-left:16px}`,
			`.swm-rail:before{content:"";position:absolute;left:3px;top:8px;bottom:8px;width:1px;background:${LINE.rule}}`,
			// One event row. The hover is the reason it is a rule at all: the
			// border is transparent at rest so the row does not move by a pixel
			// when it lights up, which is what a hover drawn by adding a border
			// does.
			`.swm-ev{position:relative;display:flex;align-items:flex-start;gap:${SPACE.sm};padding:3px ${SPACE.sm};border-radius:${RADIUS.sm};border:1px solid transparent}`,
			`.swm-ev:hover{border-color:${LINE.rule}}`,
			// A TABLE ROW LIGHTING UP UNDER THE POINTER, which none of the three
			// tables had, because a `<tr>` styled from a `style: {}` cannot
			// express `:hover` at all. Two of these tables are clickable — the
			// task board opens a drawer, the tool table is read across — and a
			// row you can click that does not answer the pointer reads as text.
			//
			// AN INLINE `background` BEATS THIS RULE. The task board used to
			// write `background: "transparent"` on every unselected row, which
			// is an inline declaration and therefore wins over a stylesheet: the
			// hover would have been dead on arrival and nothing would have said
			// so. The unselected row now leaves `background` undefined.
			`.swm-tr{transition:background ${MOTION.fast}}`,
			`.swm-tr:hover{background:${SURFACE.hover}}`,
			// A SOURCE IS A CARD, and a card that does not answer the pointer is a
			// paragraph with a border round it. Both steps are colour — the edge and
			// the surface — rather than a shadow, because twenty of these stack down
			// one column and a card that LIFTS under the cursor makes the whole
			// column ripple as the pointer crosses it.
			//
			// THE TITLE UNDERLINES, NOT THE BOX. The card itself is the anchor, so
			// painting every word inside it in the link colour would make the host,
			// the tally chips and the verdict each look separately pressable when
			// only the box is.
			// THE EDGE AND THE GROUND ARE HERE, NOT IN THE STYLE OBJECT. They
			// were written inline on the card — `border: 1px solid ${LINE.hair}`
			// and `background: SURFACE.card` — and an inline declaration beats a
			// stylesheet whatever the selector, so BOTH halves of the hover below
			// were overridden and the card sat inert under the pointer. The guard
			// that checks this rule's declaration could not see it: the rule was
			// there, on the right sheet, on the right element, and dead.
			`.swm-source{border:1px solid ${LINE.hair};background:${SURFACE.card};transition:border-color ${MOTION.fast},background ${MOTION.fast}}`,
			`.swm-source:hover{border-color:${LINE.rule};background:${SURFACE.hover}}`,
			`.swm-source:hover .swm-source-title{text-decoration:underline}`,

			// ── the ONE tab vocabulary ───────────────────────────────────
			// THREE STRIPS DID THIS JOB THREE WAYS: the page strip underlined
			// in `label-primary` with no hover at all, the mission detail strip
			// was a segmented pill track with `aria-pressed` on it, and the
			// trajectory drawer had the complete underline treatment — colour,
			// a 2px `::after`, a hover, a focus ring — sitting on TRACE_CSS
			// where only the drawer could reach it.
			//
			// THE RULES MOVED SHEETS, and that is what makes the reconciliation
			// possible rather than cosmetic: TRACE_CSS mounts when the trace
			// pane opens, so a detail strip wearing `.swt-tab` would have been
			// an unstyled row of buttons until somebody clicked 轨迹, and then
			// styled for the rest of the session. This sheet is injected by the
			// page before first paint AND by `ensureTraceStyle`, so all three
			// strips are painted wherever they render.
			//
			// GEOMETRY STAYS INLINE, state lives here: the three strips sit in
			// three boxes and want three paddings, but they must agree about
			// what "selected" and "hovered" look like. `--swm-tab-inset` is how
			// the underline learns each strip's padding — the same custom
			// property trick `.swm-chip` uses to serve six hues from one rule.
			`.swm-tab{position:relative;flex:none;appearance:none;border:0;background:transparent;cursor:pointer;white-space:nowrap;border-radius:${RADIUS.sm} ${RADIUS.sm} 0 0;transition:background ${MOTION.fast},color ${MOTION.fast}}`,
			// THE HOVER IS A BACKGROUND, NOT A COLOUR, and that is forced: every
			// strip sets its label colour inline (resting, selected) and an
			// inline declaration beats a stylesheet, so a `:hover{color}` rule
			// would be dead on arrival with nothing to say so. `background` is
			// deliberately NOT set inline anywhere, which is what leaves this
			// rule somewhere to land.
			`.swm-tab:hover{background:${SURFACE.hover}}`,
			`.swm-tab:focus-visible{outline:1px solid var(--dsw-alias-state-business-primary);outline-offset:-1px}`,
			// The underline as a pseudo-element rather than a border, because a
			// border changes the box: a 2px line switching on under the active
			// tab would push the whole strip up two pixels as the reader moves
			// along it, which is the same defect `pressedStyle` exists to avoid
			// one widget along.
			`.swm-tab[aria-selected="true"]::after{position:absolute;right:var(--swm-tab-inset,0);bottom:0;left:var(--swm-tab-inset,0);height:2px;border-radius:1px 1px 0 0;background:var(--dsw-alias-state-business-primary);content:""}`,
			// A TAB BAR THAT CANNOT SCROLL CLIPS ITS LAST TAB, and the scrollbar
			// that lets it scroll is itself chrome nobody asked for. Hidden the
			// way `.swt-tabs` already hides its own, which is where this pattern
			// was taken from rather than invented beside it.
			`.swm-tabbar::-webkit-scrollbar{display:none}`,

			// ── the centred overlay ──────────────────────────────
			// ONE OVERLAY DEPTH, TWO SHAPES. The product had a right slide-over
			// and nothing else, so the only place to put a form that is not a
			// page was the page — which is how the create form came to sit
			// permanently expanded above every mission in the list. The scrim's
			// colour and blur are COPIED from `.swt-drawer`'s rather than chosen
			// again: two overlays a shade apart read as two products, and a
			// source test now holds the two alphas equal so they cannot drift.
			//
			// `swm-`, NOT `swt-`, AND THAT IS WHY IT IS ON THIS SHEET. TRACE_CSS
			// is injected by `ensureTraceStyle`, which runs only when the
			// trajectory pane or the stage drawer opens — a modal wearing
			// `.swt-modal` would have been an unstyled div in the page flow until
			// somebody clicked 轨迹, and correctly positioned for the rest of the
			// session. That is the defect B14 found in the tab strip one widget
			// along, and the missions list never calls `ensureTraceStyle` at all.
			`.swm-modal-scrim{position:fixed;inset:0;z-index:40;display:flex;align-items:center;justify-content:center;padding:${SPACE.lg};background:rgba(0,0,0,0.30);backdrop-filter:blur(2px)}`,
			// `--dsw-shadow-lv3` is what the drawer already wears. A hand-mixed
			// `0 10px 34px rgba(0,0,0,0.20)` would be a second elevation for the
			// same altitude, and it is the exact literal the segmented control's
			// guard was written to keep out of this file.
			`.swm-modal{display:flex;flex-direction:column;width:100%;max-width:640px;max-height:90vh;overflow:hidden;border-radius:${RADIUS.lg};border:1px solid ${LINE.rule};background:var(--dsw-alias-bg-layer-2);box-shadow:var(--dsw-shadow-lv3)}`,
			`.swm-modalhead{display:flex;flex:none;align-items:flex-start;gap:${SPACE.md};padding:14px ${SPACE.lg};border-bottom:1px solid ${LINE.rule}}`,
			// THE BODY IS THE ONLY THING THAT SCROLLS. `max-height:90vh` on the
			// box with the scroll on the body is what keeps the title and the way
			// out reachable on a short window — a dialog that scrolls as a whole
			// puts its close control off the bottom of a laptop screen.
			`.swm-modalbody{min-height:0;overflow-y:auto;padding:${SPACE.lg}}`
				].join("");

		/**
		* Control heights: three, over the TWELVE this file had in it.
		*
		* 18, 19, 20, 22, 24, 26, 27, 28, 30, 32, 34, 36, 38 and 42 pixels were
		* all in use, most of them within two pixels of a neighbour. Two buttons
		* a pixel apart in a row do not read as two sizes; they read as one size
		* rendered badly.
		*
		* The steps are the file's own centre of mass rather than a fresh
		* invention: 28 was already the most common by three to one, 24 is the
		* dense in-row control, and 34 is what `controlStyle` has always been.
		* Anything under 24 in this file is a badge or a dot, not a control, and
		* is left alone.
		*/
		const CONTROL = { xs: "24px", sm: "28px", md: "34px" };

		/** Variables and rules, in the order the cascade needs them. */
		const SWM_SHEET = SWM_CSS + SWM_RULES;
		//#endregion

		//#region ui primitives
		/**
		* The glyphs, as path data on a 24x24 box.
		*
		* HAND-WRITTEN, AND THAT IS NOT A COMPROMISE. This plugin has no build
		* step — `lib/client.js` is what the harness loads — so an icon library
		* is not a dependency this file can take. What it CAN take is a table of
		* strings, which is what a library ships anyway.
		*
		* Every glyph is stroked rather than filled, at the same width, on the
		* same box, so they sit on a line of text at one weight instead of five.
		* The two paths already in this file — a trash can and a close cross —
		* were drawn at different weights on different boxes, which is what a
		* set of glyphs looks like when each one arrives on its own.
		*/
		const ICON_PATHS = {
			chevronDown: "M6 9l6 6 6-6",
			chevronRight: "M9 6l6 6-6 6",
			arrowRight: "M5 12h14M13 6l6 6-6 6",
			arrowLeft: "M19 12H5M11 18l-6-6 6-6",
			check: "M20 6L9 17l-5-5",
			close: "M18 6L6 18M6 6l12 12",
			plus: "M12 5v14M5 12h14",
			alert: "M10.3 3.9L1.8 18a2 2 0 001.7 3h17a2 2 0 001.7-3L13.7 3.9a2 2 0 00-3.4 0zM12 9v4M12 17h.01",
			external: "M18 13v6a2 2 0 01-2 2H5a2 2 0 01-2-2V8a2 2 0 012-2h6M15 3h6v6M10 14L21 3",
			trash: "M3 6h18M8 6V4a1 1 0 011-1h6a1 1 0 011 1v2M19 6l-1 14a2 2 0 01-2 2H8a2 2 0 01-2-2L5 6",
			refresh: "M23 4v6h-6M1 20v-6h6M3.5 9a9 9 0 0114.9-3.4L23 10M1 14l4.6 4.4A9 9 0 0020.5 15",
			search: "M11 19a8 8 0 100-16 8 8 0 000 16zM21 21l-4.4-4.4",
			clock: "M12 22a10 10 0 100-20 10 10 0 000 20zM12 6v6l4 2",
			spinner: "M21 12a9 9 0 11-6.2-8.6",
			pause: "M10 4H6v16h4zM18 4h-4v16h4z",
			play: "M5 3l14 9-14 9z",
			// THE TWO MARKS A STATE TABLE NEEDS, and the reason they are worth two
			// more lines of path data. MISSION_STAGE_STATUS_FACES gives `pending`
			// and `skipped-by-tier` the SAME TONE.muted on adjacent lines, and that
			// is deliberate — a skip is not a failure and must not be drawn as one —
			// so once the tint is shared the glyph is the ONLY thing left that can
			// separate "not run yet" from "this tier never runs it".
			circle: "M12 22a10 10 0 100-20 10 10 0 000 20z",
			minus: "M5 12h14",
			// THE ROLE GLYPHS, and the reason there are eight of them. A role is
			// a CATEGORY, and a category chip that carries only a word is read at
			// the speed of reading; the mark is what makes a roster scannable at
			// 11px. They are drawn to the same box and the same stroke as the
			// fifteen above so a role mark and a status tick sit on one line at
			// one weight — which is the whole reason this table exists rather
			// than each site pasting its own <svg>.
			brain: "M12 5a3 3 0 10-5.9.8A2.5 2.5 0 004 9.5 2.5 2.5 0 005.5 12 2.5 2.5 0 004 14.5c0 1.6 1.4 2.5 3 2.5v2M12 5a3 3 0 115.9.8A2.5 2.5 0 0120 9.5a2.5 2.5 0 01-1.5 2.5 2.5 2.5 0 011.5 2.5c0 1.6-1.4 2.5-3 2.5v2M12 5v14",
			gitBranch: "M6 3v12M18 6a3 3 0 100-6 3 3 0 000 6zM6 21a3 3 0 100-6 3 3 0 000 6zM15 6a9 9 0 01-9 9",
			scanSearch: "M3 7V5a2 2 0 012-2h2M17 3h2a2 2 0 012 2v2M21 17v2a2 2 0 01-2 2h-2M7 21H5a2 2 0 01-2-2v-2M13.5 12.5a2.5 2.5 0 11-5 0 2.5 2.5 0 015 0zM16 16l-1.9-1.9",
			penLine: "M12 20h9M16.5 3.5a2.12 2.12 0 013 3L7 19l-4 1 1-4z",
			gavel: "M14.5 12.5l-8 8a2.1 2.1 0 11-3-3l8-8M16 16l6-6M8 8l6-6M9 7l8 8M21 11l-8-8",
			shieldAlert: "M20 13c0 5-3.5 7.5-7.7 9a1 1 0 01-.6 0C7.5 20.5 4 18 4 13V6a1 1 0 011-1c2 0 4.5-1.2 6.2-2.7a1 1 0 011.5 0C14.5 3.8 17 5 19 5a1 1 0 011 1z",
			sparkles: "M12 3l1.9 5.1L19 10l-5.1 1.9L12 17l-1.9-5.1L5 10l5.1-1.9zM19 15l.9 2.1L22 18l-2.1.9L19 21l-.9-2.1L16 18l2.1-.9z",
			// The tool glyphs. `wrench` is the fallback the tool table leans on:
			// the Host half registers its own ids and an unlisted one has to draw
			// as SOMETHING, or a row loses its mark and reads as a different kind
			// of row.
			globe: "M12 22a10 10 0 100-20 10 10 0 000 20zM2 12h20M12 2a15.3 15.3 0 014 10 15.3 15.3 0 01-4 10 15.3 15.3 0 01-4-10 15.3 15.3 0 014-10z",
			book: "M4 19.5A2.5 2.5 0 016.5 17H20M6.5 2H20v20H6.5A2.5 2.5 0 014 19.5v-15A2.5 2.5 0 016.5 2z",
			wrench: "M14.7 6.3a1 1 0 000 1.4l1.6 1.6a1 1 0 001.4 0l3.8-3.8a6 6 0 01-8 8l-6.9 6.9a2.1 2.1 0 01-3-3l6.9-6.9a6 6 0 018-8l-3.8 3.8z"
		};

		/**
		* A mark per role, keyed EXACTLY as ROLE_TONE is keyed.
		*
		* Two tables that have to agree and are four hundred lines apart is what
		* a source test is for, and there is one: a role that gains a colour here
		* and no glyph there draws a chip with a hole in it, which is the one
		* failure a reader reports as "the icon is broken" rather than as a
		* missing role.
		*
		* `mission` is the fallback and takes the sparkle, because a row that
		* belongs to no agent belongs to the run itself.
		*/
		const ROLE_ICON = {
			leader: "brain",
			researcher: "search",
			analyst: "gitBranch",
			reconciler: "scanSearch",
			writer: "penLine",
			reviewer: "gavel",
			verifier: "shieldAlert",
			mission: "sparkles"
		};

		/**
		* One glyph, sized from ICON.
		*
		* An unknown name renders NOTHING rather than throwing, matching
		* `missionFace`'s fallthrough: a glyph nobody has drawn yet is a gap in
		* a row, and a thrown render is a blank tab.
		* @param props - `{name, size, spin, title}`.
		*/
		function Icon({ name, size, spin, title }) {
			const d = ICON_PATHS[name];
			if (d === undefined) return null;
			const box = size ?? ICON.sm;
			return jsx("svg", {
				className: spin === true ? "swm-spin" : undefined,
				width: box, height: box, viewBox: "0 0 24 24",
				fill: "none", stroke: "currentColor",
				strokeWidth: "2", strokeLinecap: "round", strokeLinejoin: "round",
				// Decorative by default. A glyph that repeats the word beside it
				// is read twice by a screen reader, which is worse than silence.
				"aria-hidden": title === undefined ? "true" : undefined,
				role: title === undefined ? undefined : "img",
				"aria-label": title,
				style: { flex: "none", display: "block" },
				children: jsx("path", { d })
			});
		}

		/**
		* One small tinted surface: the chip, at two sizes and in two shapes.
		*
		* WHAT THIS REPLACES. Ten sites drew this box by hand — seven radii,
		* five paddings and three font sizes for one thing — and none of the
		* differences was a decision. A 5px corner in the list beside a 6px
		* corner in the header is not a hierarchy; it is two people typing, and
		* it is visible precisely when both are on screen.
		*
		* THE SHAPE CARRIES THE MEANING. A CATEGORY takes the default
		* rounded-rect: the stage strip, the task board's origin, every tally.
		* A STATE takes `pill`, which routes the geometry through `pillStyle`.
		* The eye learns a shape faster than it reads a word, so two kinds of
		* thing drawn in one shape is a hierarchy that has to be re-read every
		* time.
		*
		* THE COUNT RIDES INSIDE. What the task board had was three sibling
		* spans in three colours in one cell, with the figure the row exists to
		* report drawn in `INK.quiet` — decoration weight for the load-bearing
		* number. A count belongs in the chip whose subject it counts.
		* IT CAN BE PRESSED, AND THAT IS STILL ONE CHIP. `onClick` swaps the
		* `span` for a `button` and nothing else: same tint, same corner, same
		* mark. The alternative was a second component for the one place a chip
		* is a control — the stage ruler, where every cell opens that step in the
		* trajectory — and a second component is a second geometry the moment
		* either one is touched. What the button DOES need is the three
		* resets no chip ever wanted (`appearance`, `border`, `textAlign`) and
		* the focus ring, which arrives as `.swm-focus` rather than as a style
		* object because `:focus-visible` is not reachable from one.
		*
		* Only a chip in a grid cell wants that — a chip in a row is `flex:none`
		* precisely so a long label cannot squash its neighbours — and in a cell
		* the opposite is true: twelve chips that each sized to their own word
		* would not be a ruler.
		* @param props - `{tone, label, icon, count, size, title, solid, pill, onClick, className}`.
		* @param key - React's key, so a chip can be called straight into a list.
		*/
		function Chip({ tone, label, icon, count, size, title, solid, pill, onClick, className }, key) {
			const hue = tone ?? TONE.neutral;
			const wide = size === "sm";
			const pressable = typeof onClick === "function";
			const shape = pill === true ? pillStyle(hue, wide ? "md" : "sm") : {
				font: wide ? FONT.smallStrong : FONT.microStrong,
				display: "inline-flex", alignItems: "center", boxSizing: "border-box",
				gap: SPACE.xs, padding: wide ? "2px 8px" : "1px 6px",
				borderRadius: RADIUS.sm,
				background: `rgba(${hue},${TINT.soft})`,
				color: `rgb(${hue})`,
				boxShadow: `inset 0 0 0 1px rgba(${hue},${TINT.ring})`,
				whiteSpace: "nowrap"
			};
			return jsxs(pressable ? "button" : "span", {
				type: pressable ? "button" : undefined,
				onClick,
				// The ring rides on the class, never on the style object: a chip
				// that drew its own focus outline inline would draw it always.
				className: pressable
					? (className === undefined ? "swm-focus" : `swm-focus ${className}`)
					: className,
				title,
				style: {
					...shape,
					// A chip sizes to its text unless it is filling a cell it was
					// given. `minWidth: 0` is the half that is easy to miss: a flex
					// or grid item refuses to shrink below its content by default,
					// so without it the label below ellipsises never.
					flex: "none",
					...(pressable
						? { appearance: "none", border: "none", cursor: "pointer", textAlign: "left" }
						: {}),
					// A chip on a surface of its own tone — the header row of a
					// Callout — is 10% over 10% and disappears. `solid` is the
					// same chip with the tone standing in for the surface, which
					// is the one case where a tint cannot separate the two.
					...(solid === true
						? { background: `rgba(${hue},${TINT.fill})`, color: SURFACE.base, boxShadow: "none" }
						: {}),
					// AFTER the shorthand, never before it. `font` resets
					// font-variant, so a chip that declared this first lost it
					// silently — and half the chips in this file are a version, a
					// fraction or a tally, which is exactly where a figure that
					// changes width is read as the box twitching.
					fontVariantNumeric: "tabular-nums"
				},
				children: [
					icon === undefined ? null : jsx(Icon, { name: icon, size: ICON.xs, spin: icon === "spinner" }, "glyph"),
					// THE LABEL IS THE PART THAT GIVES. A chip is `nowrap` by
					// definition, so in a box narrower than its text something has
					// to lose: the mark is the fastest thing to read and the count
					// is the figure the chip exists to report, which leaves the
					// word. With room this is invisible — an unconstrained span
					// sizes to its content either way.
					label === undefined || label === null || label === "" ? null : jsx("span", {
						style: { minWidth: 0, overflow: "hidden", textOverflow: "ellipsis" },
						children: label
					}, "label"),
					count === undefined || count === null || count === "" ? null : jsx("span", {
						style: {
							font: FONT.micro,
							fontVariantNumeric: "tabular-nums",
							flex: "none",
							marginLeft: "2px", padding: "0 4px", borderRadius: RADIUS.pill,
							// A stronger step of the SAME hue, not white: white is
							// a colour in one theme and a hole in the other.
							background: `rgba(${hue},${TINT.ring})`
						},
						children: count
					}, "count")
				]
			}, key);
		}

		/**
		* WHO DID IT, drawn instead of spelled.
		*
		* ROLE_TONE and `roleTone()` shipped with the tokens region and had ONE
		* caller — `roleTone`'s own body. Every agent identity on screen was bare
		* text: the roster, the task board's owner column, the stage detail's
		* 负责人 row and every one of the hundred rows on the trajectory. The ramp
		* existed and had no pixels. This is the component that spends it.
		*
		* THE ID IS NOT ALWAYS A ROLE. Researchers are minted per dimension —
		* `researcher:${dimensionId}`, where the id is a slug the planner chose,
		* so a real one reads `researcher:regulatory-landscape` — and the whole
		* string is what the store holds. `roleTone` already cuts at the colon;
		* this does the same cut once more for the glyph rather than
		* re-implementing the normalisation a third time.
		*
		* THE SUFFIX IS A SEPARATE SPAN, and it is the reason this is not just a
		* `Chip`. A chip is `whiteSpace: nowrap` by definition — that is what
		* keeps a row of them from breaking mid-word — so a dimension slug inside
		* one makes the chip as wide as the slug, in a 96px column. The role
		* stays fixed-width and coloured; the instance ellipsises beside it in the
		* decoration weight, which is what it is.
		*
		* Reads MISSION_AGENT_FACES and `missionFace`, declared three thousand
		* lines below. Safe for the same reason `pillStyle` may read TINT: a
		* function body is evaluated when it is CALLED, and this is only ever
		* called from a render. The vocabulary stays with the other vocabularies
		* rather than being copied up here, because a second table of role words
		* is a second table to keep in step.
		* @param props - `{agentId, role, label, zh, size, iconOnly, title}`.
		* @param key - React's key, so a chip can be called straight into a list.
		*/
		function RoleChip({ agentId, role, label, zh, size, iconOnly, title }, key) {
			const raw = String(agentId ?? role ?? "").trim();
			// An absence renders as null, not as an empty chip: a tinted box with
			// no text in it looks like a role whose word failed to load, which is
			// a bug report about a row that simply has no agent yet.
			if (raw === "") return null;
			const base = raw.split(":")[0].trim().toLowerCase();
			const hue = roleTone(raw);
			const glyph = Object.hasOwn(ROLE_ICON, base) ? ROLE_ICON[base] : ROLE_ICON.mission;
			const at = raw.indexOf(":");
			// NO `suffix` OVERRIDE. It shipped as a prop with no caller — "pass a
			// resolved dimension name instead of the raw slug" — and a prop nobody
			// passes is the next geometry, added by whoever first needs something
			// near it. Same rule that kept `dot` off Chip, `accent` off
			// MissionPanel, `mono` off MetricStat and `hits` off SourceLink.
			const instance = at === -1 ? "" : raw.slice(at + 1);
			const word = label ?? missionFace(MISSION_AGENT_FACES, base, zh);
			// The chip carries the caller's key when it IS the whole component, and
			// a local one when it is a child of the wrapper below. A React key is a
			// position among siblings, so the same key on both would be a warning in
			// one shape and a wrong reconciliation in the other.
			const chip = Chip({
				tone: hue,
				icon: glyph,
				label: iconOnly === true ? undefined : word,
				size,
				// The raw id, always, even when the chip is showing the word: it is
				// the string a log grep uses and the string the trajectory's search
				// box matches, and it must stay reachable from the pixels.
				title: title ?? (word === raw ? raw : `${word} · ${raw}`)
			}, instance === "" ? key : "role");
			if (instance === "") return chip;
			return jsxs("span", {
				style: { display: "inline-flex", alignItems: "center", gap: SPACE.xs, minWidth: 0, maxWidth: "100%" },
				children: [
					chip,
					jsx("span", {
						// DECORATION WEIGHT, deliberately. The dimension a researcher was
						// minted for is context for the role beside it, not a value the
						// reader has to read — the dimension's own card says it in full.
						style: { font: FONT.micro, color: INK.quiet, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" },
						title: instance,
						children: instance
					}, "instance")
				]
			}, key);
		}

		/**
		* A tinted box with something to say, and optionally a name for it.
		*
		* Three of these were hand-built — the run-elsewhere note, the failure
		* banner, the degraded-archive note — in three alphas, three paddings
		* and three type sizes, and only one of the three tinted its lead line.
		* Three more sat one region away as bare coloured text with no box at
		* all, which is how a 409's response body came to reflow the entire
		* mission header.
		*
		* THE RING IS INSET rather than a border, so the three stop differing in
		* OUTER box size: a `1px solid` box is two pixels wider than its
		* content, and the untinted blocks above and below it are not.
		*
		* THE LEAD IS A LINE, NOT A CHIP. Every lead this file has is a
		* SENTENCE — "这次运行失败了。", "This version was stored degraded." —
		* and a sentence inside a badge is a badge the width of the box. The
		* glyph is the chip: one solid mark that says which of the three tones
		* this is without the reader having to name the colour.
		* @param props - `{tone, label, meta, icon, children}`.
		* @param key - React's key.
		*/
		function Callout({ tone, label, meta, icon, children }, key) {
			const hue = tone ?? TONE.neutral;
			const named = (label ?? "") !== "" || (meta ?? null) !== null;
			return jsxs("div", {
				style: {
					font: FONT.small,
					display: "flex", alignItems: "flex-start", gap: SPACE.sm,
					margin: `0 0 ${SPACE.md}`, padding: `${SPACE.sm} ${SPACE.md}`,
					borderRadius: RADIUS.md,
					background: `rgba(${hue},${TINT.soft})`,
					boxShadow: `inset 0 0 0 1px rgba(${hue},${TINT.ring})`,
					color: INK.primary
				},
				children: [
					// SOLID, because a 10% tint on a 10% tint is nothing. This is
					// the one place a chip sits on a surface of its own tone, and
					// it is why `Chip` has a `solid` at all.
					icon === undefined ? null : Chip({ tone: hue, icon, solid: true }, "glyph"),
					jsxs("div", {
						style: { flex: 1, minWidth: 0, display: "flex", flexDirection: "column", gap: SPACE.xs },
						children: [
							!named ? null : jsxs("div", {
								style: { display: "flex", alignItems: "baseline", gap: SPACE.sm },
								children: [
									// TINTED, which only one of the three hand-built
									// copies did. A lead drawn in body colour is a
									// first line, not a lead.
									(label ?? "") === "" ? null : jsx("span", {
										style: { font: FONT.smallStrong, color: `rgb(${hue})` },
										children: label
									}, "lead"),
									(meta ?? null) === null ? null : jsx("span", { style: { marginLeft: "auto" }, children: meta }, "meta")
								]
							}, "head"),
							jsx("div", {
								// THE CAP IS THE LOAD-BEARING PART. A runtime error
								// is one sentence and a 409 body is a page of them,
								// and the second used to push every control under it
								// off the screen. Capped and scrolled, the banner
								// keeps its size and the text stays reachable.
								style: {
									minWidth: 0, maxHeight: "128px", overflowY: "auto",
									whiteSpace: "pre-wrap", wordBreak: "break-word"
								},
								children
							}, "body")
						]
					}, "col")
				]
			}, key);
		}

		/**
		* ONE BAR, for every proportion this tab draws.
		*
		* Four of them existed and no two were the same object: 3px with no
		* radius at all, 4px and 5px and 6px on a 6px radius. Nobody chose the
		* differences; they are what four people typed on four afternoons, and
		* they are only visible when two of the bars are on screen together —
		* which, since the stage-spend rows and the ceiling meters share a pane,
		* is most of the time.
		*
		* `max` DEFAULTS TO 100 so a percentage goes straight in, and the fill is
		* clamped at BOTH ends. Over-100 is a real state here — a mission can
		* spend past a soft ceiling — and an unclamped bar renders 140% wide,
		* pushing its own row out of the panel it is measuring.
		*
		* THE REST SPREADS ONTO THE TRACK. The audio seek is a `role="slider"`
		* carrying an `onClick`, an `aria-valuenow` and a `tabIndex`, and it is
		* the same bar; without a way to pass those through, giving it a copy of
		* its own is exactly how the fifth geometry would have arrived.
		* @param props - `{value, max, tone, style}` plus anything the track itself should carry.
		* @param key - React's key, so a bar can be called straight into a list.
		*/
		function Meter({ value, max, tone, style, ...rest }, key) {
			// A zero or absent ceiling is a percentage, not a divide by zero. The
			// `/0` this file refuses everywhere else renders here as either NaN —
			// which CSS drops, leaving the fill at its full width — or as a
			// confident 100% about a door nobody has opened.
			const ceiling = Number(max) > 0 ? Number(max) : 100;
			const share = Math.max(0, Math.min(100, ((Number(value) || 0) / ceiling) * 100));
			return jsx("div", {
				...rest,
				style: { ...TRACK, height: "6px", ...style },
				children: jsx("div", {
					style: {
						width: `${share}%`, height: "100%",
						borderRadius: RADIUS.pill,
						background: `rgb(${tone ?? TONE.info})`,
						transition: `width ${MOTION.base}`
					}
				})
			}, key);
		}

		/**
		* ONE FIGURE, given the room a figure needs.
		*
		* Every number on this tab was either a table cell or a clause. The
		* mission header stated seven of them as one dot-joined string —
		* 标准 · 第 1 次运行 · 阶段 7/12 · 维度 3/4 · 章节 2/6 · 已用 12 分 · … —
		* and a dimension card stated three more the same way, in the same weight
		* as the sentence two elements below it. A reader looking for one of
		* those figures has to read the whole clause to find out it is not the
		* one they wanted.
		*
		* FONT.title AND NO LARGER. 20px is the biggest step this file declares
		* anywhere; the batch spec asked for 24px, and a 24px numeral here would
		* be the one thing in the tab that outweighs the mission's own title.
		*
		* `mono` IS NOT A PROP, against the spec's signature. Every value that
		* reaches this component is a figure or a fraction, which is precisely
		* what MONO exists for, and a prop with no caller is the next geometry
		* waiting for whoever first needs something near it — the same reason
		* `Chip` has no `dot` and `MissionPanel` has no `accent`.
		*
		* THE HINT IS `INK.secondary`, not the spec's tertiary. A hint here is
		* 412,000 / 1,500,000 · 27% — the ceiling the figure above it is being
		* measured against — and INK's own docblock puts tertiary at 3.71:1, the
		* decoration budget. The label and the hint separate by SHAPE instead:
		* one is an uppercase tracked eyebrow, the other is a sentence.
		* @param props - `{label, value, hint, tone, meter}`; `meter` is a ratio, or null for no bar.
		* @param key - React's key.
		*/
		function MetricStat({ label, value, hint, tone, meter }, key) {
			const hue = tone ?? null;
			// The file's own empty convention. `0` is a value and must survive:
			// `value || "—"` would print an em dash over a real zero, which is
			// the difference between "none verified" and "not measured".
			const shown = value === null || value === undefined || value === "" ? "—" : value;
			const clipped = { whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" };
			return jsxs("div", {
				style: {
					display: "flex", flexDirection: "column", gap: SPACE.xs,
					minWidth: 0,
					padding: `${SPACE.sm} ${SPACE.md}`,
					borderRadius: RADIUS.lg,
					border: `1px solid ${LINE.hair}`,
					background: hue === null ? SURFACE.subtle : `rgba(${hue},${TINT.soft})`
				},
				children: [
					jsx("div", {
						style: { font: FONT.micro, letterSpacing: "0.04em", textTransform: "uppercase", color: INK.secondary, ...clipped },
						children: label
					}, "label"),
					jsx("div", {
						style: {
							// `font` FIRST. It is a shorthand and it resets the family,
							// the leading AND font-variant-numeric, so a tabular-nums
							// written above it is discarded — in the one component whose
							// whole subject is a column of figures.
							font: FONT.title,
							fontFamily: MONO,
							fontVariantNumeric: "tabular-nums",
							color: hue === null ? INK.primary : `rgb(${hue})`,
							...clipped
						},
						children: shown
					}, "value"),
					// A ratio the figure above is a fraction OF. Absent unless the
					// caller has one: a tile whose value is a bare count has nothing
					// to be a proportion of, and a bar at 0% under it would say it
					// had failed to reach a bar nobody set.
					meter === null || meter === undefined ? null : Meter({ value: meter * 100, tone: hue ?? TONE.info }, "meter"),
					hint === null || hint === undefined || hint === "" ? null : jsx("div", {
						style: { font: FONT.micro, color: INK.secondary, ...clipped },
						children: hint
					}, "hint")
				]
			}, key);
		}

		/**
		* A row of them, on the grid that fixes itself.
		*
		* `auto-fit` with a `minmax` floor rather than a fixed column count, for
		* the reason MissionCostMeters already reached for the same shape: the
		* detail header is inset inside an overlay whose width is the window's,
		* and four fixed columns are four 90px tiles on a narrow screen with the
		* label ellipsised down to nothing. Four, three, two and one all work;
		* nobody has to pick.
		*
		* A NULL TILE IS DROPPED, not rendered empty. Two of the call sites have
		* a tile that only exists on some runs — a dimension with no chapters has
		* no chapter fraction — and `null` in the array is how a caller says so
		* without building the array twice.
		* @param props - `{tiles}`, an array of MetricStat props; nulls are dropped.
		* @param key - React's key.
		*/
		function MissionStatTiles({ tiles }, key) {
			const shown = (Array.isArray(tiles) ? tiles : []).filter((tile) => tile !== null && tile !== undefined);
			// An absence renders as nothing, with the reason: a grid with no
			// children still spends its bottom margin, which on the dimension card
			// is a gap under a header that nothing follows.
			if (shown.length === 0) return null;
			return jsx("div", {
				style: {
					display: "grid",
					gridTemplateColumns: "repeat(auto-fit, minmax(150px, 1fr))",
					gap: SPACE.sm, margin: `0 0 ${SPACE.md}`
				},
				children: shown.map((tile, at) => MetricStat(tile, tile.label ?? `tile-${at}`))
			}, key);
		}

		/**
		* A bare URL, in a sentence nobody wrote as markdown.
		*
		* It travels with `linkify` rather than staying with the description
		* parser it was first written for: a pattern and its only reader are one
		* thing, and leaving it behind would have left the reader a ReferenceError
		* away from a blank tab.
		*/
		const BARE_URL = /https?:\/\/[^\s<>()[\]]+[^\s<>()[\].,;:!?'"]/g;

		/**
		* Render one line, turning bare URLs into links.
		*
		* MOVED OUT OF THE VIDEO-DESCRIPTION REGION, where it sat with exactly two
		* call sites in the one component that happened to need it first. Nothing
		* in it knows about a video: it takes a string and returns children, which
		* is what a primitive is. Everything an agent writes on the mission screens
		* — a degrade note, a refusal, a researcher's closing sentence — can carry
		* a URL, and every one of them was printing it as dead text because the
		* function that fixes it was quarantined in another feature's region.
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

		/**
		* Cap a block of text at N lines.
		*
		* The three properties are useless apart and meaningless in any other
		* combination — `-webkit-line-clamp` does nothing without the box display
		* and the vertical orientation, and the whole thing does nothing without
		* the overflow — so they are one call rather than four keys that a fifth
		* site gets three-quarters right.
		* @param lines - how many lines survive.
		* @returns a style fragment to spread.
		*/
		function clampBox(lines) {
			return { display: "-webkit-box", WebkitLineClamp: lines, WebkitBoxOrient: "vertical", overflow: "hidden" };
		}

		/**
		* A paragraph an agent wrote, capped at a few lines with a way to read the rest.
		*
		* THE TWO TREATMENTS THIS REPLACES WERE BOTH WRONG. Half the mission prose
		* was `whiteSpace:"nowrap"` with an ellipsis — one line, with the sentence
		* that says what went wrong hidden behind a native tooltip — and the other
		* half was printed uncapped, so one long refusal pushed the rest of the
		* pane off the screen. A clamp with a control is the only arrangement
		* where a long sentence costs a fixed amount of room AND stays readable.
		*
		* IT IS A COMPONENT, NOT A DIRECT CALL, unlike Chip / Callout / Meter
		* beside it: it holds state and measures itself in a layout effect, so it
		* must go through `jsx(MissionClamp, …)` and get its own hook slots. A
		* direct call would run its hooks inside whichever component called it,
		* which is the rule-of-hooks break that surfaces as somebody else's state.
		* @param text - the sentence, verbatim.
		* @param lines - how many lines to show collapsed; 2 by default.
		* @param zh - whether to write Chinese.
		*/
		function MissionClamp({ text, lines, zh }) {
			const body = String(text ?? "");
			const want = Number(lines);
			const cap = Number.isFinite(want) && want > 0 ? want : 2;
			const box = useRef(null);
			const [open, setOpen] = useState(false);
			// THREE VALUES, and `null` is the one that earns the comment: it means
			// the box has not been measured — nothing has laid out yet, an ancestor
			// is hidden, or this is running in a renderer with no DOM at all — and
			// it must never be read as "it fits". An unmeasured box still clamps,
			// because a clamped box is the only one whose `scrollHeight` can answer
			// the question, but it KEEPS ITS TOGGLE. The cost of that is an
			// expander on a sentence that did not need one; the cost of the
			// opposite default is text hidden behind a control that is not there.
			const [overflows, setOverflows] = useState(null);
			useLayoutEffect(() => {
				// Only while collapsed. An expanded box has `scrollHeight ===
				// clientHeight` by construction, so measuring it would answer "it
				// fits", drop the toggle, and strand the reader with no way back.
				if (open) return;
				const node = box.current;
				if (node === null || node === undefined) return;
				const full = Number(node.scrollHeight);
				const shown = Number(node.clientHeight);
				// A zero-height box has not been laid out. Leave the state at
				// whatever it was rather than writing `false` into it.
				if (!Number.isFinite(full) || !Number.isFinite(shown) || shown === 0) return;
				setOverflows(full > shown + 1);
			}, [body, cap, open]);
			// An absence renders as nothing, not as an empty two-line box with a
			// control under it. Every call site guards its own field for "" as
			// well; this is the floor under all of them.
			if (body === "") return null;
			return jsxs("div", {
				style: { display: "flex", flexDirection: "column", alignItems: "flex-start", gap: SPACE.xs, minWidth: 0 },
				children: [
					jsx("div", {
						ref: box,
						style: open
							? { minWidth: 0, whiteSpace: "pre-wrap", wordBreak: "break-word" }
							: { ...clampBox(cap), minWidth: 0, wordBreak: "break-word" },
						// LINKS, because these sentences are written by agents that
						// quote addresses inside them. This is the reason linkify moved.
						children: linkify(body, `${cap}c`)
					}, "text"),
					overflows === false ? null : jsx("button", {
						type: "button",
						className: "swm-focus",
						style: { font: FONT.micro,
							appearance: "none", border: "none", background: "transparent", padding: 0,
							color: "var(--dsw-alias-state-business-primary)", cursor: "pointer"
						},
						// STOPPED, and it is not defensive noise: several of these sit
						// inside a row that is itself a control, and without this the
						// press that expands a sentence also opens the drawer over it.
						onClick: (event) => { event.stopPropagation?.(); setOpen((value) => !value); },
						// THE FILE'S OWN WORDS, taken from the description expander
						// that was the precedent for this one. A third phrasing for
						// "there is more of this" is a third thing to learn for no gain.
						children: open ? (zh ? "收起" : "Show less") : (zh ? "展开全部" : "Show more")
					}, "toggle")
				]
			});
		}

		/**
		* What to call a page when the page did not say.
		*
		* FOUR STEPS, in the order of how much a human actually chose the name.
		* A stored `<title>` is the publisher's own words; the first sentence of
		* a snippet is the extractor's; a decoded path segment is at least the
		* URL author's filing decision — `/scaling-test-time-compute` is a worse
		* name than the title and a far better one than
		* `https://deepmind.google/discover/scaling-test-time-compute` — and the
		* hostname is the last thing that is still a NAME rather than an address.
		*
		* WHAT THIS REPLACES: `(source.title ?? "") === "" ? source.url : source.title`,
		* written out three times in three components. On any run where the
		* fetcher could not read a title that renders a column of raw addresses,
		* which is unreadable in the specific way that is easy to miss in review:
		* every row starts with the same eight characters and the part that
		* differs is off the right edge behind the ellipsis.
		*
		* THE LAST RESORT IS THE ADDRESS ITSELF, below the hostname, and it is
		* deliberately not `""`. A card with no name at all is a card the reader
		* cannot tell from a rendering fault; a bare URL is a bad name and no
		* name is worse.
		* @param title - the stored title, where the fetch kept one.
		* @param snippet - any prose that travelled with the row; "" is fine.
		* @param url - the address.
		* @returns a name.
		*/
		function sourceTitleOf(title, snippet, url) {
			const stored = String(title ?? "").trim();
			if (stored !== "") return stored;
			// THE FIRST SENTENCE, not the whole snippet. A snippet is a paragraph,
			// and a paragraph in a title slot is a two-line clamp with no title
			// visible in it — the clamp would be doing the naming.
			const prose = String(snippet ?? "").trim();
			if (prose !== "") {
				const stop = prose.search(/[。！？]|[.!?]\s/u);
				const first = (stop === -1 ? prose : prose.slice(0, stop + 1)).trim();
				if (first !== "") return first.length > 120 ? `${first.slice(0, 119)}…` : first;
			}
			const address = String(url ?? "").trim();
			try {
				const path = new URL(address).pathname.split("/").filter((piece) => piece !== "");
				const last = path[path.length - 1];
				if (last !== undefined) {
					// Decoded and de-slugged, because `%E5%9C%B0%E5%9D%80` is not a
					// name in any language and `scaling-test-time.html` is one once
					// the extension and the hyphens come off.
					const word = decodeURIComponent(last).replace(/\.[a-z0-9]{1,5}$/i, "").replace(/[-_]+/g, " ").trim();
					if (word !== "") return word;
				}
			} catch {
				// An unparseable address has no path to read, and a malformed URI
				// escape makes decodeURIComponent throw. Either way the host is the
				// next step down, not a crash on a list of a hundred rows.
			}
			const host = hostOf(address);
			return host !== "" ? host : address;
		}

		/**
		* ONE SOURCE, as a card rather than as a line.
		*
		* WHAT WAS HERE. Three components drew a page the reader had read, and
		* not one of them drew it as a thing you could point at: a bare `<a>`
		* over a single 11px mono line that `.join(" · ")`-ed the host, the
		* finding count, the verified count, the dimension names and a
		* timestamp. Five differing signals at one weight in one grey — this
		* file's signature for "nobody decided which of these matters" — and the
		* one a reader is actually on this pane for, whether what the page
		* carried held up, was the third clause of five.
		*
		* THE HOVER IS A CLASS. `:hover` is unreachable from an inline
		* `style: {}`, so the card's whole affordance — edge and surface stepping
		* up under the pointer, title underlining — ships as `.swm-source` in
		* SWM_RULES and the element carries the class.
		*
		* A ROW WITH NO ADDRESS IS A `div`, NOT A DEAD ANCHOR. An `<a>` without
		* an `href` is not focusable and announces as plain text, so it would
		* look pressable and answer nothing. The card still renders, because the
		* finding it carried is real even on the runs where the address did not
		* survive.
		*
		* NO TYPE ICON AND NO CREDIBILITY GRADE, against the reference this was
		* drawn from. There is no `kind` field and no score on a source row
		* anywhere in this projection, and a grade with no data behind it is a
		* number the screen would be inventing.
		*
		* THERE IS NO `hits` PROP, also against the reference. The two callers'
		* counts are different facts — findings taken OFF a page, versus markers
		* in the prose that lean ON it — so a shared count chip would have to
		* invent a third phrasing that is wrong in both places. Each caller says
		* its own words through `meta`, the same reason `Chip` has no `dot` and
		* `MetricStat` no `mono`.
		* @param props - `{title, url, host, verifyState, meta, zh}`; `meta` is extra children for the bottom row.
		* @param key - React's key, so a card can be called straight into a list.
		*/
		function SourceLink({ title, url, host, verifyState, meta, zh }, key) {
			const address = String(url ?? "").trim();
			const openable = address !== "";
			return jsxs(openable ? "a" : "div", {
				href: openable ? address : undefined,
				target: openable ? "_blank" : undefined,
				rel: openable ? "noreferrer noopener" : undefined,
				className: openable ? "swm-source swm-focus" : "swm-source",
				// NO `title` WITH THE ADDRESS IN IT. The browser already shows an
				// anchor's href in the status bar on hover, so a tooltip repeating
				// it buys nothing — and it costs something real: `textOf` walks
				// every prop value, so the address would be in this card's text
				// twice, and the guard that proves a six-times-cited page is listed
				// ONCE counts occurrences of that address.
				style: {
					font: FONT.body,
					display: "block", minWidth: 0,
					padding: `${SPACE.sm} ${SPACE.md}`,
					// NO `border` AND NO `background` HERE: `.swm-source` carries both, so
					// that `.swm-source:hover` has something it can outrank. Written here
					// they are inline declarations, which beat every rule on the sheet.
					borderRadius: RADIUS.md,
					color: INK.primary,
					textDecoration: "none"
				},
				children: [
					jsxs("div", {
						style: { display: "flex", alignItems: "flex-start", gap: SPACE.sm },
						children: [
							jsx("span", {
								className: "swm-source-title",
								style: { flex: 1, minWidth: 0, color: INK.primary, wordBreak: "break-word", ...clampBox(2) },
								children: title
							}, "title"),
							// THE ONE MARK THAT SAYS "this opens somewhere else". The
							// card carries no link colour — see the rule — so without
							// this glyph a card with an address and a card whose address
							// did not survive are the same card.
							!openable ? null : jsx("span", {
								style: { flex: "none", color: "var(--dsw-alias-state-business-primary)" },
								children: jsx(Icon, {
									name: "external", size: ICON.xs,
									title: zh ? "在新标签页打开" : "Opens in a new tab"
								})
							}, "out")
						]
					}, "head"),
					jsxs("div", {
						style: {
							font: FONT.micro,
							display: "flex", alignItems: "center", flexWrap: "wrap",
							gap: SPACE.xs, margin: `${SPACE.xs} 0 0`, color: INK.quiet
						},
						children: [
							(host ?? "") === "" ? null : jsx("span", {
								style: {
									fontFamily: MONO, flex: "none", maxWidth: "100%",
									overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap"
								},
								children: host
							}, "host"),
							// THE VERDICT, IN ITS OWN COLOUR. MISSION_VERIFY_FACES gained
							// its hues one batch ago and this row was still spelling the
							// state as the third clause of a grey sentence — 已核验 and
							// 查无此文 in the same ink, on the one screen where the
							// difference between them is the whole point.
							verifyState === null || verifyState === undefined || verifyState === "" ? null : Chip({
								tone: missionHue(MISSION_VERIFY_FACES, verifyState),
								label: missionFace(MISSION_VERIFY_FACES, verifyState, zh)
							}, "state"),
							meta
						]
					}, "meta")
				]
			}, key);
		}
		//#endregion

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
					jsx("circle", { cx: 7.5, cy: 22, r: 3.4, fill: SURFACE.card }),
					jsx("circle", { cx: 24.5, cy: 22, r: 3.4, fill: SURFACE.card })
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
			// PALETTE, not TONE: these are six categories, not six states. A
			// source kind drawn in `TONE.danger` teaches the eye that red means
			// "bad" on this tab and "YouTube" on the next.
			{ id: "youtube", type: "YOUTUBE_VIDEO", en: "YouTube", zh: "YouTube", hue: PALETTE.red },
			{ id: "papers", type: "PAPER", en: "Papers", zh: "论文", hue: PALETTE.blue },
			{ id: "blogs", type: "BLOG", en: "Blogs", zh: "博客", hue: PALETTE.violet },
			{ id: "reports", type: "REPORT", en: "Reports", zh: "报告", hue: PALETTE.amber },
			{ id: "policy", type: "POLICY", en: "Policy", zh: "政策", hue: PALETTE.indigo },
			{ id: "news", type: "NEWS", en: "News", zh: "新闻", hue: PALETTE.green }
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
		/**
		* The header carries NO type of its own, and that is the change.
		*
		* It used to set `font: FONT.largeStrong` on the container, which was
		* fine while the header was one word — and it was one word: a mark, the
		* product name, a version badge and a close button, with nothing saying
		* what the tab under it is for. Two text lines cannot inherit one font,
		* so the size lives on each line and the row only does layout.
		*
		* NO BOTTOM HAIRLINE HERE. The tab bar below already draws one, and it
		* has to: it is the rail the active tab's underline sits on. Two rules
		* fourteen pixels apart read as a double border round an empty strip.
		*/
		const HEADER_STYLE = {
			flex: "none", display: "flex", alignItems: "center", gap: SPACE.md,
			padding: "10px 24px",
			color: INK.primary
		};
		/**
		* The subtitle, which every tab has always had and only two could show.
		*
		* All five TABS entries carry a written `lede`, and the `<p>` that
		* rendered one lived inside the PLACEHOLDER branch — the path only 研究
		* and 推演 ever take. So the three tabs that are built, which are the
		* three a reader actually spends time on, said nothing about themselves.
		*
		* ONE LINE, ellipsised, because it sits on the header row beside the
		* product name: a lede that wraps pushes the tab bar down by a line when
		* the window narrows, and a chrome that changes height as you resize
		* reads as the page reloading.
		*/
		const HERO_LEDE_STYLE = {
			font: FONT.body,
			margin: 0, maxWidth: "62ch",
			overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
			color: INK.secondary
		};
		/**
		* THE TAB BAR SCROLLS RATHER THAN CLIPPING. It could do neither: five
		* icon-bearing tabs, two of them carrying a 待建 chip, in a row with no
		* `flexWrap` and no `overflow` — so inset beside a wide sidebar the last
		* tab was simply not there, and nothing on the page said a tab was
		* missing. The scrollbar itself is hidden by `.swm-tabbar`, the way
		* `.swt-tabs` has always hidden its own.
		*
		* The gap fell from 24px to 8px in the same change that gave each tab
		* 8px of side padding, so the rhythm between two labels is the 24px it
		* has always been and the hit target grew by sixteen pixels.
		*/
		const TABBAR_STYLE = {
			flex: "none", display: "flex", alignItems: "center", gap: SPACE.sm,
			padding: "0 24px", borderBottom: `1px solid ${LINE.rule}`,
			minWidth: 0, overflowX: "auto", overflowY: "hidden", scrollbarWidth: "none"
		};
		const BODY_STYLE = { flex: 1, minHeight: 0, overflowY: "auto", padding: "14px 24px 20px" };
		/** The detail view scrolls inside its own panes, so the body must not. */
		// No horizontal padding: the sources tab scrolls inside this box, and any
		// padding here insets the scrollbar from the window edge. The two views
		// underneath carry their own side padding instead.
		const READER_BODY_STYLE = { flex: 1, minHeight: 0, overflow: "hidden", padding: "6px 0 10px" };
		/**
		* The feed reads as a column, so it is capped. The detail view is a
		* two-pane reader and must use the whole frame — capping it left a band
		* of dead space down the right of the page.
		*/
		const CONTENT_STYLE = { maxWidth: "1080px" };
		const WIDE_STYLE = { maxWidth: "none" };
		const LEDE_STYLE = {
			font: FONT.base,
			margin: `0 0 ${SPACE.lg}`, maxWidth: "62ch",
			color: INK.secondary
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
			font: FONT.microStrong,
			marginLeft: SPACE.xs, padding: "0 5px", borderRadius: RADIUS.sm,
			border: `1px solid ${LINE.rule}`,
			color: "var(--dsw-alias-label-tertiary, var(--dsw-alias-label-secondary))",
			whiteSpace: "nowrap"
		};
		const NOTE_STYLE = {
			font: FONT.body,
			display: "flex", alignItems: "center", justifyContent: "center",
			minHeight: "140px", padding: SPACE.xl,
			border: `1px dashed ${LINE.rule}`, borderRadius: RADIUS.md,
			color: INK.secondary, textAlign: "center"
		};

		/**
		* A SCREEN with nothing on it, saying WHICH nothing — and it is not the
		* dashed box above.
		*
		* NOTE_STYLE was one vocabulary doing three jobs. "加载中…", "读不到这个
		* 任务" and "还没有跑过任何任务" were the same 140px dashed rectangle
		* with one centred sentence in it, so the three answers a person most
		* needs to tell apart were drawn identically — and the two that matter
		* most are the emptiness and the failure, because they call for opposite
		* reactions: wait, versus go and look at the server.
		*
		* A MARK, A HEADING, A SENTENCE, AN ACTION, in that order, because the
		* mark is read before the words are, the heading answers the question
		* and the sentence explains it. `action` is what to do about it: an
		* empty screen that names no next step is a dead end with a border round
		* it, and this tab had three of them while the control that fixes two of
		* them sat on the same page.
		*
		* NOTE_STYLE STAYS, for genuinely inline notes. A one-line status inside
		* a panel that is already built is not a screen state and must not grow
		* a 260px box under it.
		* @param props - `{mark, title, note, action, tone}`; `mark` is an ICON_PATHS name.
		* @param key - the React key, as the second argument, mirroring jsx(type, props, key).
		* @returns the element, or null when there is nothing at all to say.
		*/
		function EmptyBox({ mark, title, note, action, tone }, key) {
			// An absence with no words is not an empty state, it is a blank
			// rectangle — which is also what a crashed component draws. Same
			// rule MissionEmptyPane is built on one region over.
			if ((title ?? "") === "" && (note ?? "") === "" && (action ?? null) === null) return null;
			const hue = tone ?? TONE.muted;
			return jsxs("div", {
				style: {
					display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center",
					gap: SPACE.md, minHeight: "260px", padding: SPACE.xl, textAlign: "center"
				},
				children: [
					mark === undefined ? null : jsx("div", {
						style: {
							flex: "none", width: "40px", height: "40px", borderRadius: RADIUS.lg,
							display: "flex", alignItems: "center", justifyContent: "center",
							background: `rgba(${hue},${TINT.soft})`, color: `rgb(${hue})`
						},
						children: jsx(Icon, { name: mark, size: ICON.md }, "glyph")
					}, "mark"),
					(title ?? "") === "" ? null : jsx("div", {
						style: { font: FONT.baseStrong, color: INK.primary },
						children: title
					}, "title"),
					(note ?? "") === "" ? null : jsx("div", {
						style: { font: FONT.body, maxWidth: "42ch", color: INK.secondary },
						children: note
					}, "note"),
					action ?? null
				]
			}, key);
		}

		/**
		* A read that failed, with the two things the dashed box never had.
		*
		* THE RETRY IS THE POINT. All three screen-level load failures in this
		* file offered no control at all: the only way to re-issue the read was
		* to leave the tab and come back, and on the mission detail the only
		* button on the screen was the one that leaves it. A failure a person
		* cannot act on is a failure they have to work around.
		*
		* The endpoint stays, and stays LEGIBLE. It is the line that separates
		* "the server said no" from "this build is pointed at a host that is not
		* there", which is why it is INK.secondary in MONO rather than the
		* INK.quiet the brief suggested — an address is read character by
		* character, and `quiet` is 3.71:1 and is for decoration.
		*
		* No dev-only stack trace: this file has no build-time environment flag,
		* so a `<details>` here would ship the stack to everybody.
		* @param props - `{title, message, endpoint, onRetry, zh}`.
		* @param key - the React key, as the second argument.
		*/
		function ErrorBox({ title, message, endpoint, onRetry, zh }, key) {
			return EmptyBox({
				mark: "alert",
				tone: TONE.danger,
				title: (title ?? "") === "" ? (zh ? "这一次读取失败了" : "That read failed") : title,
				note: message,
				action: jsxs("div", {
					style: { display: "flex", flexDirection: "column", alignItems: "center", gap: SPACE.sm },
					children: [
						onRetry === null || onRetry === undefined ? null : jsxs("button", {
							type: "button",
							className: "swm-ctl swm-focus",
							style: { ...controlStyle(), display: "inline-flex", alignItems: "center", gap: SPACE.xs },
							onClick: onRetry,
							children: [jsx(Icon, { name: "refresh", size: ICON.xs }, "glyph"), zh ? "重试" : "Retry"]
						}, "retry"),
						(endpoint ?? "") === "" ? null : jsx("div", {
							style: { font: FONT.micro, fontFamily: MONO, color: INK.secondary },
							children: (zh ? "接口：" : "Endpoint: ") + endpoint
						}, "endpoint")
					]
				}, "actions")
			}, key);
		}

		/**
		* One block of a loading screen: the shape of a thing, before the thing.
		*
		* WHY A SHAPE AND NOT A SENTENCE. "加载中…" in a dashed box says a read
		* is in flight and nothing else, and when the answer lands the page
		* jumps from one 140px box to a screenful of rows. A skeleton says how
		* much is coming and where it will be, so the arrival is a fill rather
		* than a relayout.
		*
		* THE SKELETON SCREEN KEEPS THE WORD, on the container rather than in
		* the middle of it: each of the four sites wraps its blocks in a
		* `role="status"` box labelled 加载中…, because a pile of grey divs says
		* nothing at all to a screen reader and the sentence it replaced said
		* the one thing that mattered.
		*
		* NOT FOR AN INLINE STATUS. The one-line "读取中…" strings inside
		* already-built panels stay text: replacing a working answer with a grey
		* bar is a worse screen, not a better one.
		* @param props - `{w, h, r}` — width, height, and an optional radius.
		* @param key - the React key, as the second argument.
		*/
		function Skeleton({ w, h, r }, key) {
			return jsx("div", {
				className: "swm-skel",
				style: { flex: "none", width: w ?? "100%", height: h ?? "14px", borderRadius: r ?? RADIUS.sm }
			}, key);
		}

		/**
		* The box the four skeleton screens are drawn in.
		*
		* One place, so the word a screen reader gets and the word the dashed
		* box used to show cannot drift apart across four sites, and so a
		* skeleton cannot be shipped without one.
		* @param props - `{zh, style, children}`.
		* @param key - the React key, as the second argument.
		*/
		function SkeletonScreen({ zh, style, children }, key) {
			return jsx("div", {
				role: "status",
				"aria-label": zh ? "加载中…" : "Loading…",
				style: style ?? undefined,
				children
			}, key);
		}

		/**
		* One page tab. State comes from `.swm-tab`; this is the geometry and
		* the identity colour.
		*
		* THREE THINGS CHANGED AND EACH WAS ITS OWN SMALL FAILURE.
		*
		* The active colour was `label-primary`, which is the colour of every
		* other word on the page — so "which tab am I on" was carried by a
		* weight and a 2px line and nothing else. It is `state-business-primary`
		* now, which is what this file already treats as its selected colour on
		* the trajectory strip, on a markdown link and on a pressed row.
		*
		* The padding was `10px 0`, so the hit target was exactly as wide as the
		* word: a five-pixel miss to either side landed on the bar. TABBAR_STYLE
		* gave up sixteen pixels of gap to pay for eight pixels of padding on
		* each side, so nothing moved and the target grew.
		*
		* The underline is `::after` on the class rather than a `borderBottom`
		* here, so it can inset itself to the padding — the line hugs the label
		* instead of running the full width of a target that is deliberately
		* wider than its label. `--swm-tab-inset` is how the rule learns this
		* strip's padding; `marginBottom: -1px` stays, so the 2px line sits ON
		* the bar's hairline rather than above it.
		* @param active - whether this is the tab being shown.
		* @returns a style object to spread.
		*/
		function tabStyle(active) {
			return {
				// The WHOLE shorthand swaps rather than a weight riding beside a
				// size — `FONT.body` and `FONT.bodyStrong` are 13px on the same
				// leading, so a tab does not physically move when it becomes the
				// active one. All three strips in this product now take this
				// pair; they used to take three sizes and three weights.
				font: active ? FONT.bodyStrong : FONT.body,
				padding: `10px ${SPACE.sm} 12px`, marginBottom: "-1px",
				"--swm-tab-inset": SPACE.sm,
				color: active ? "var(--dsw-alias-state-business-primary)" : INK.secondary
			};
		}
		//#endregion

		//#region explore styling
		const SEARCH_STYLE = {
			width: "100%", boxSizing: "border-box", height: "42px", padding: "0 14px",
			border: `1px solid ${LINE.rule}`, borderRadius: RADIUS.md,
			background: "transparent", color: INK.primary,
			font: FONT.base
		};
		const TOOLBAR_STYLE = {
			display: "flex", alignItems: "center", gap: SPACE.sm, flexWrap: "wrap", margin: "12px 0 18px"
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
		/**
		* The panel recipe, in one place.
		*
		* This object was typed out three times — here at a 14px radius, and
		* twice more as byte-identical `const CARD` objects declared INSIDE two
		* component bodies, where nothing could see that they matched. Three
		* copies of a surface is how a tab ends up with cards that are two
		* pixels apart in the corner and one shadow step apart in depth.
		*/
		const PANEL_STYLE = {
			border: `1px solid ${LINE.hair}`,
			borderRadius: RADIUS.lg,
			background: SURFACE.card,
			boxShadow: ELEVATION.raised
		};

		const CARD_STYLE = {
			...PANEL_STYLE,
			display: "flex", gap: SPACE.lg, padding: SPACE.lg, marginBottom: SPACE.lg,
			transition: `box-shadow ${MOTION.base}, transform ${MOTION.base}`
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
			boxShadow: ELEVATION.floating,
			transform: "translateY(-2px)"
		};
		// `label-tertiary` resolves to rgb(129,133,140) — 3.71:1 on white, under
		// the 4.5:1 that normal-size text needs, and it was carrying the dates,
		// sources, and counts at 11-12px across 101 places. `label-secondary`
		// is 5.8:1. Hierarchy still reads: size and weight separate these rows
		// from the title without asking the reader to squint.
		const META_STYLE = {
			display: "flex", alignItems: "center", gap: SPACE.md, flexWrap: "wrap",
			font: FONT.small, color: INK.secondary
		};
		const ACTIONS_STYLE = {
			display: "flex", alignItems: "center", gap: SPACE.lg,
			font: FONT.small, color: INK.secondary
		};

		/**
		* Kind chip: the active kind takes its own colour as a tinted fill with
		* a matching border, which is the reference nav's active treatment.
		*/
		function chipStyle(kind, active) {
			return {
				// THE HUE RIDES ON THE ELEMENT as a custom property, so ONE
				// hover rule in SWM_CSS can serve six categories instead of six
				// rules or none. React passes `--`-prefixed style keys straight
				// through — that is the whole mechanism, and it is the only way
				// an inline-styled element can take a state it did not compute.
				"--swm-chip-h": kind.hue,
				appearance: "none", display: "inline-flex", alignItems: "center",
				height: CONTROL.md, padding: `0 ${SPACE.lg}`, borderRadius: RADIUS.md,
				border: "1px solid " + (active ? hue(kind, TINT.ring) : LINE.rule),
				// INACTIVE IS `undefined`, NOT "transparent". The comment that
				// stood here said an inline background would put the chip out of
				// the hover rule’s reach and then wrote one — `transparent` is an
				// inline declaration like any other, and it beat
				// `.swm-chip:hover` on all six category chips. An undefined key is
				// not emitted at all, so the class paints the resting state and
				// the hover can win. The ACTIVE fill stays inline on purpose: a
				// chip already filled with its own hue must not lighten under the
				// pointer as though it were unpressed.
				background: active ? hue(kind, TINT.soft) : undefined,
				color: active ? hue(kind) : undefined,
				// The WHOLE shorthand swaps, rather than a weight riding beside
				// a size: swapping only the weight reflows the label when it
				// becomes active, because the two weights have different
				// advances at the same size.
				font: active ? FONT.bodyStrong : FONT.body,
				cursor: "pointer", whiteSpace: "nowrap"
			};
		}

		/**
		* The pressed look, as an INSET ring rather than a border.
		*
		* A border changes the box. A control that grows one pixel when it is
		* selected pushes its neighbours, so a row of chips reflows as the eye
		* moves along it — which reads as the layout being unstable rather than
		* as one chip being chosen. An inset shadow paints inside the same box.
		*
		* Composes rather than replaces: several call sites already carry an
		* `inset 3px 0 0 0` left bar, and this appends to it.
		* @param on - whether the control is the selected one.
		* @param tone - the colour triple to draw the ring in.
		* @param existing - a boxShadow already on the element, or "".
		* @returns a style fragment to spread AFTER the base style.
		*/
		function pressedStyle(on, tone, existing) {
			const ring = `inset 0 0 0 2px rgb(${tone ?? TONE.info})`;
			if (on !== true) return existing ? { boxShadow: existing } : {};
			return { boxShadow: existing ? `${existing},${ring}` : ring };
		}

		/**
		* Leaving a screen is not aborting one.
		*
		* Every back control in this tab took `controlStyle`, which is the same
		* box as 取消 and 停止 — so the way out of a report looked like the way
		* to kill the mission that wrote it. This is quieter: no border, and the
		* hover comes from `.swm-back`.
		* @returns the style object.
		*/
		function backStyle() {
			return {
				font: FONT.body,
				appearance: "none", display: "inline-flex", alignItems: "center", gap: SPACE.xs,
				height: CONTROL.sm, padding: `0 ${SPACE.sm}`, borderRadius: RADIUS.sm,
				// The resting background and ink are on `.swm-back`, not here:
				// written inline they override `.swm-back:hover` and the control
				// stops answering the pointer.
				border: "none",
				cursor: "pointer", whiteSpace: "nowrap"
			};
		}

		/**
		* A glyph-only button, with the one thing a glyph-only button always
		* forgets: a name.
		*
		* Four of these in this file were bare `<button>`s with 2px of padding,
		* no hover, no focus ring and no accessible name — a screen reader read
		* them as "button". The class carries hover and focus from SWM_CSS,
		* because an inline style object cannot express either.
		* THE SECOND ARGUMENT IS THE REACT KEY, the way it is on Chip, RoleChip,
		* Callout, Meter and SourceLink — this primitive was written without one
		* and had no call site to notice, so its first use inside a children
		* array would have been a keyed-list warning in the console and a wrong
		* reconciliation on the page.
		* @param props - `{label, onClick, size, tone, title, children}`.
		* @param key - this button's key among its siblings.
		*/
		function IconButton({ label, onClick, size, tone, title, children }, key) {
			const box = size ?? "24px";
			return jsx("button", {
				type: "button",
				className: "swm-iconbtn",
				"aria-label": label,
				title: title ?? label,
				onClick,
				style: { width: box, height: box, color: tone === undefined ? undefined : `rgb(${tone})` },
				children
			}, key);
		}

		/**
		* THE SEGMENTED CONTROL, once, for the two places that draw one.
		*
		* A segmented strip is not a tab strip and stays segmented — tabs say
		* "these are different pages", a segment says "this is the same content
		* arranged differently" — but the file's two of them were built out of
		* different surfaces, different radii and different shadows, so the one
		* widget looked like two widgets one pane apart: `fill-tertiary` on a 9px
		* track with a 7px thumb and a hand-mixed `rgba(0,0,0,0.06)` shadow in
		* the detail strip, `interactive-bg-hover` on a 10px track with an 8px
		* thumb in the publish switcher.
		*
		* THE WEIGHT CHANGES AND THE METRICS DO NOT. `FONT.body` and
		* `FONT.bodyStrong` are 13px at the same leading, so pressing a segment
		* does not reflow the strip — which is what a `fontWeight` swap between
		* two differently-metricked steps does, and it reads as the label
		* physically moving away from the pointer.
		*
		* DECLARED HERE, beside `chipStyle`, `pressedStyle`, `backStyle` and
		* `controlStyle` — every other style builder in this file is in this
		* block, whatever the region comment above says. `//#region explore
		* styling` is where the control vocabulary actually lives and `//#region
		* page chrome styling` is seventy lines of layout constants; the label is
		* wrong and predates all of them. Not renamed here, because a region
		* rename is a diff across every batch still in flight — but do not go
		* looking in the other one.
		*/
		const SEGMENT_TRACK = {
			display: "inline-flex", alignItems: "center",
			gap: SPACE.xs, padding: "3px",
			background: SURFACE.hover,
			borderRadius: RADIUS.lg,
			width: "fit-content", maxWidth: "100%",
			overflowX: "auto", scrollbarWidth: "none"
		};

		/**
		* One segment of that strip.
		* @param on - whether this is the chosen one.
		* @returns a style object.
		*/
		function segmentStyle(on) {
			return {
				font: on === true ? FONT.bodyStrong : FONT.body,
				appearance: "none", border: "none", cursor: "pointer",
				display: "flex", alignItems: "center", gap: SPACE.xs,
				flex: "none",
				height: CONTROL.sm, padding: `0 ${SPACE.md}`,
				borderRadius: RADIUS.md,
				background: on === true ? SURFACE.card : "transparent",
				color: on === true ? INK.primary : INK.secondary,
				// THE RAISED STEP IS THE HARNESS'S, not `0 1px 2px rgba(0,0,0,0.06)`
				// typed at the call site. A hand-mixed black shadow is a shadow that
				// does not exist in the dark theme, where the surface under it is
				// already darker than the shadow.
				boxShadow: on === true ? ELEVATION.raised : "none",
				transition: `background ${MOTION.fast},color ${MOTION.fast}`,
				whiteSpace: "nowrap"
			};
		}

		/** Small neutral control used by the sort selector and the retry button. */
		function controlStyle(off) {
			return {
				appearance: "none", height: CONTROL.md, padding: "0 10px", borderRadius: RADIUS.md,
				border: `1px solid ${LINE.rule}`, font: FONT.body,
				// NO `background` AND NO `color` HERE. Both used to be written as
				// inline keys, and an inline declaration beats a stylesheet — so
				// `.swm-ctl:hover` was dead on every control in the file, with
				// nothing on screen to say so. The resting pair is on `.swm-ctl`.
				// A REFUSED CONTROL THAT LOOKS PRESSABLE IS A CLICK MADE TWICE.
				// Twenty-five controls in this file set `disabled` and seven
				// showed it, so most of them sat at full contrast under a
				// `cursor: pointer` and answered nothing. `pointerEvents: none`
				// as well as the cursor, because a `disabled` attribute stops
				// the click but not the hover, and a hover that lights up on a
				// dead button is the same lie one layer down.
				opacity: off === true ? OPACITY.disabled : 1,
				cursor: off === true ? "not-allowed" : "pointer",
				pointerEvents: off === true ? "none" : undefined
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
						style: { font: FONT.largeStrong,
							flex: "none", width: thumbWidth, height: "104px", borderRadius: RADIUS.md,
							overflow: "hidden", display: "flex", alignItems: "center", justifyContent: "center",
							background: hue(kind, TINT.soft), color: hue(kind), border: "none", padding: 0, cursor: "pointer"
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
						style: { flex: 1, minWidth: 0, display: "flex", flexDirection: "column", gap: SPACE.sm },
						children: [
							jsxs("div", {
								style: META_STYLE,
								children: [
									jsx("span", { children: formatDate(row.publishedAt) }),
									sourceName === "" ? null : jsx("span", {
										style: { font: FONT.microStrong,
											padding: "1px 8px", borderRadius: RADIUS.pill,
											background: hue(kind, TINT.soft), color: hue(kind),
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
								style: { font: FONT.baseStrong,
									appearance: "none", border: "none", background: "transparent",
									padding: 0, textAlign: "left", font: "inherit", cursor: "pointer",
									color: hue(kind),
									overflow: "hidden", display: "-webkit-box",
									WebkitLineClamp: 2, WebkitBoxOrient: "vertical"
								},
								children: row.title
							}),
							description.text === "" ? null : jsx("p", {
								style: { font: FONT.small,
									margin: 0,
									color: INK.secondary,
									overflow: "hidden", display: "-webkit-box",
									WebkitLineClamp: 2, WebkitBoxOrient: "vertical"
								},
								children: description.text
							}),
							jsx("div", { style: { height: "1px", background: LINE.hair, margin: "6px 0 2px" } }),
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
		/**
		* What is behind `[7]`, without leaving the sentence it is in.
		*
		* THE CLICK WAS THE ONLY AFFORDANCE, and it is the expensive one: it
		* scrolls the page to the reference list, which loses the reader's place
		* in the prose to answer a question — "is this a real source or a
		* rate-limited stub" — that takes three lines to answer. Everything in the
		* card is already in memory one render away: `missionReferences` built it
		* for the list at the bottom of the same page.
		*
		* IT IS A COMPONENT, and it has to be. `missionCitationMark` is called
		* from inside `renderInline`'s loop — once per marker, conditionally —
		* so a hook in there would be a hook in a loop, which is the rule-of-hooks
		* break that hands one marker another marker's state. The button itself is
		* unchanged and still carries its `title`, so a reader with no pointer
		* loses nothing.
		* @param token - the raw `[N]`.
		* @param index - the citation number.
		* @param refs - `{has, jump, peek, zh}` from the report.
		* @param zh - whether to write Chinese.
		*/
		function MissionCitationPeek({ token, index, refs, zh }) {
			const [open, setOpen] = useState(false);
			const timer = useRef(null);
			const stop = () => {
				if (timer.current === null) return;
				clearTimeout(timer.current);
				timer.current = null;
			};
			const hold = () => { stop(); setOpen(true); };
			// A GRACE PERIOD ON THE WAY OUT, and it is not a flourish. The card
			// floats six pixels above the marker, so a pointer travelling from the
			// number to the card crosses a strip where neither element is hovered;
			// closing on the first `mouseleave` makes the card unreachable by the
			// only input that can open it. Re-entering cancels the timer.
			const release = () => {
				stop();
				timer.current = setTimeout(() => { timer.current = null; setOpen(false); }, 150);
				// Unref'd for the reason the other timers in this file are: this
				// module is rendered in Node by tests/settings.test.mjs, which never
				// unmounts anything.
				timer.current?.unref?.();
			};
			useEffect(() => stop, []);
			const source = typeof refs?.peek === "function" ? refs.peek(index) : null;
			const mark = jsx("button", {
				type: "button",
				title: zh ? `跳到参考文献第 ${index} 条` : `Jump to reference ${index}`,
				onClick: () => { refs.jump?.(index); },
				// FOCUS OPENS IT TOO. The card is reachable by pointer and by tab,
				// because a preview only a mouse can see is a preview half the
				// people reading a report cannot.
				onFocus: hold,
				onBlur: release,
				style: { font: FONT.micro,
					appearance: "none", border: "none", background: "transparent",
					padding: "0 1px", margin: 0, cursor: "pointer", font: "inherit", lineHeight: 1, verticalAlign: "super",
					color: "var(--dsw-alias-state-business-primary)"
				},
				children: token
			}, "mark");
			// NO CARD WITHOUT A SOURCE TO PUT IN IT. `peek` is optional — a chat
			// answer threads `has`/`jump` and nothing else — and an empty floating
			// box on hover is worse than no box, so the marker stays exactly what
			// it was.
			if (source === null || source === undefined) return mark;
			return jsxs("span", {
				style: { position: "relative", display: "inline-block" },
				onMouseEnter: hold,
				onMouseLeave: release,
				children: [
					mark,
					!open ? null : jsxs("span", {
						role: "note",
						style: {
							font: FONT.small,
							position: "absolute", bottom: "calc(100% + 6px)", left: "50%", transform: "translateX(-50%)",
							zIndex: 40, width: "320px", boxSizing: "border-box",
							display: "flex", flexDirection: "column", gap: SPACE.xs,
							padding: "10px 12px", borderRadius: RADIUS.lg,
							border: `1px solid ${LINE.hair}`, background: SURFACE.card, boxShadow: ELEVATION.floating,
							textAlign: "left", whiteSpace: "normal", cursor: "default"
						},
						children: [
							jsxs("span", {
								style: { display: "flex", alignItems: "center", gap: SPACE.sm },
								children: [
									jsx("span", { style: COUNT_CHIP, children: String(index) }, "n"),
									// THE VERDICT, in the state's own colour, because it is
									// the reason to look: a citation whose source was never
									// fetched and one that was quoted verbatim off a live
									// page are the same blue number in the prose.
									Chip({
										tone: missionHue(MISSION_VERIFY_FACES, source.verifyState),
										icon: missionIcon(MISSION_VERIFY_FACES, source.verifyState),
										label: missionFace(MISSION_VERIFY_FACES, source.verifyState, zh)
									}, "state")
								]
							}, "head"),
							(source.title ?? "") === "" ? null : jsx("span", {
								style: { font: FONT.smallStrong, color: INK.primary, ...clampBox(2) },
								children: source.title
							}, "title"),
							(source.host ?? "") === "" ? null : jsx("span", {
								style: { font: FONT.micro, fontFamily: MONO, color: INK.secondary },
								children: source.host
							}, "host"),
							(source.quote ?? "") === "" ? null : jsx("span", {
								// CAPPED AND SCROLLED, not clamped: a frozen quote is
								// sometimes half an article, and this box floats over the
								// prose — one that grew with its quote would cover the
								// paragraph the reader is checking.
								style: { color: INK.secondary, maxHeight: "120px", overflowY: "auto" },
								children: `“${source.quote}”`
							}, "quote")
						]
					}, "card")
				]
			});
		}

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
					style: { font: FONT.micro, verticalAlign: "super", padding: "0 1px",
						color: INK.quiet, cursor: "help"
					},
					children: token
				}, key);
			}
			// The button and its hover card, which is a component because it
			// holds state — see MissionCitationPeek. The `title` goes with it, so
			// the no-pointer fallback is the same string it always was.
			return jsx(MissionCitationPeek, { token, index, refs, zh }, key);
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
						style: { font: FONT.small,
							padding: "1px 5px", borderRadius: RADIUS.sm,
							background: SURFACE.code,
							fontFamily: "var(--ds-font-family-code)"
						},
						children: token.slice(1, -1)
					}, key));
				} else if (token.startsWith("**")) {
					nodes.push(jsx("strong", {
						style: { fontWeight: 500, color: INK.primary },
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
					style: { ...block, color: article ? INK.primary : INK.secondary },
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
					style: { ...block, paddingLeft: "24px", color: article ? INK.primary : INK.secondary },
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
								...MD_BLOCK, font: FONT.small, padding: "10px 12px", borderRadius: RADIUS.md, overflowX: "auto",
								background: SURFACE.code,
								fontFamily: "var(--ds-font-family-code)",
								color: INK.secondary
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
							color: INK.primary
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
						...MD_BLOCK, font: FONT.small, padding: "10px 12px", borderRadius: RADIUS.md, overflowX: "auto",
						background: SURFACE.code,
						fontFamily: "var(--ds-font-family-code)"
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
						className: "swm-ctl swm-focus", style: { ...controlStyle(), font: FONT.micro, height: CONTROL.xs, padding: "0 8px" },
						onClick: () => { setOpen((value) => !value); },
						children: zh ? "导出" : "Export"
					}),
					!open ? null : jsxs("div", {
						style: {
							position: "absolute", right: 0, top: "28px", zIndex: 5, width: "230px",
							padding: "10px", borderRadius: RADIUS.md,
							border: `1px solid ${LINE.rule}`,
							background: SURFACE.card, boxShadow: ELEVATION.floating
						},
						children: [
							jsxs("label", {
								style: { font: FONT.small, display: "flex", alignItems: "center", gap: SPACE.sm, marginBottom: "6px", color: INK.secondary, cursor: "pointer" },
								children: [
									jsx("input", { type: "checkbox", checked: withTimestamps, onChange: (event) => { setWithTimestamps(event.target.checked); } }),
									jsx("span", { children: zh ? "包含时间戳" : "Include timestamps" })
								]
							}),
							jsxs("label", {
								style: { font: FONT.small, display: "flex", alignItems: "center", gap: SPACE.sm, marginBottom: "10px", color: INK.secondary, cursor: "pointer" },
								children: [
									jsx("input", { type: "checkbox", checked: withHeader, onChange: (event) => { setWithHeader(event.target.checked); } }),
									jsx("span", { children: zh ? "包含标题与链接" : "Include title and link" })
								]
							}),
							jsx("div", {
								style: { display: "grid", gridTemplateColumns: "1fr 1fr", gap: SPACE.sm },
								children: EXPORT_FORMATS.map((entry) => jsx("button", {
									type: "button",
									className: "swm-ctl swm-focus", style: { ...controlStyle(), font: FONT.small, height: CONTROL.sm, color: hue(kind) },
									onClick: () => { run(entry.id); },
									children: entry.label
								}, entry.id))
							}),
							jsx("p", {
								style: { font: FONT.micro, margin: "10px 0 0", color: INK.secondary },
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
									style: { fontWeight: 500, color: INK.secondary },
									children: zh ? "暂无字幕" : "No transcript"
								}),
								jsx("div", {
									style: { marginTop: "6px", maxWidth: "48ch" },
									children: state.error ?? (zh ? "该视频可能没有字幕，或字幕暂时无法获取。" : "This video may publish no captions, or they could not be fetched.")
								}),
								jsxs("div", {
									style: { marginTop: "12px", display: "flex", gap: SPACE.sm, justifyContent: "center" },
									children: [
										jsx("button", {
											type: "button",
											className: "swm-ctl swm-focus", style: { ...controlStyle(), font: FONT.small, height: CONTROL.sm },
											onClick: () => { void load(true); },
											children: zh ? "重试" : "Retry"
										}),
										jsx("a", {
											href: row.sourceUrl,
											target: "_blank",
											rel: "noreferrer noopener",
											className: "swm-ctl swm-focus", style: {
												...controlStyle(), font: FONT.small, height: CONTROL.sm,
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
						style: { font: FONT.micro,
							flex: "none", display: "flex", flexDirection: "column", gap: SPACE.sm,
							padding: "8px 12px", borderBottom: `1px solid ${LINE.rule}`, color: INK.secondary
						},
						children: [
							jsxs("span", {
								style: { minWidth: 0, display: "flex", alignItems: "center", gap: SPACE.sm, overflow: "hidden" },
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
										className: "swm-ctl swm-focus", style: { ...controlStyle(), font: FONT.micro, height: "20px", padding: "0 6px", color: hue(kind) },
										onClick: () => { setRetryTick((tick) => tick + 1); },
										children: zh ? "重译" : "Retry"
									})
								]
							}),
							jsxs("div", {
								style: { display: "flex", alignItems: "center", gap: SPACE.md, flexWrap: "wrap" },
								children: [
									jsxs("label", {
										style: { display: "inline-flex", alignItems: "center", gap: SPACE.sm, cursor: "pointer" },
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
										style: { display: "inline-flex", alignItems: "center", gap: SPACE.sm },
										children: [
											jsx("span", { children: zh ? "翻译" : "Translate" }),
											jsx("select", {
												value: target,
												"aria-label": zh ? "字幕翻译语言" : "Transcript translation language",
												onChange: (event) => { setTarget(event.target.value); },
												className: "swm-ctl swm-focus", style: { ...controlStyle(), font: FONT.micro, height: CONTROL.xs, padding: "0 4px" },
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
										className: "swm-ctl swm-focus", style: { ...controlStyle(), font: FONT.micro, height: CONTROL.xs, padding: "0 8px" },
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
								style: { font: FONT.body,
									cursor: "pointer",
									padding: "12px",
									background: isActive ? hue(kind, TINT.soft) : tint,
									borderLeft: `4px solid ${isActive ? hue(kind) : "transparent"}`,
									transition: `background ${MOTION.base}`
								},
								children: jsxs("div", {
									style: { display: "flex", alignItems: "flex-start", gap: SPACE.md },
									children: [
										jsx("span", {
											style: { font: FONT.microStrong,
												flex: "none",
												color: isActive ? hue(kind) : INK.secondary
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
														color: isActive ? INK.primary : INK.secondary
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
														color: hue(kind, TINT.fill)
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
							flex: "none", display: "flex", alignItems: "center", gap: SPACE.sm,
							padding: "12px 16px", borderBottom: `1px solid ${LINE.rule}`
						},
						children: [
							jsx("span", {
								style: { font: FONT.bodyStrong, flex: 1, color: INK.primary },
								children: zh ? "AI 助手" : "Assistant"
							}),
							...QUICK_ACTIONS.map((action) => jsx("button", {
								type: "button",
								disabled: busy,
								className: "swm-ctl swm-focus", style: { ...controlStyle(busy), font: FONT.small, height: CONTROL.sm, padding: "0 10px" },
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
									style: { font: FONT.body, margin: 0, color: INK.secondary },
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
										style: { font: FONT.bodyStrong,
											marginBottom: "12px",
											whiteSpace: "pre-wrap",
											color: INK.primary
										},
										children: message.text
									}, String(index));
								}
								return jsx("div", {
									style: { font: FONT.body, marginBottom: "16px", color: INK.secondary },
									children: pending
										? jsx("span", { style: { color: INK.secondary }, children: zh ? "思考中…" : "Thinking…" })
										: renderMarkdown(message.text)
								}, String(index));
							}),
							jsx("div", { ref: tailRef })
						]
					}),
					jsxs("div", {
						style: {
							flex: "none", display: "flex", gap: SPACE.sm, padding: "12px 16px",
							borderTop: `1px solid ${LINE.rule}`
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
								className: "swm-focus", style: { ...SEARCH_STYLE, height: CONTROL.md, flex: 1 }
							}),
							jsx("button", {
								type: "button",
								disabled: busy || draft.trim() === "",
								className: "swm-ctl swm-focus", style: { ...controlStyle(busy || draft.trim() === ""), height: CONTROL.md },
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
					border: `1px solid ${LINE.hair}`,
					borderRadius: RADIUS.lg, background: SURFACE.card,
					boxShadow: ELEVATION.raised, padding: "14px 16px"
				},
				children: [
					jsxs("div", {
						style: { display: "flex", alignItems: "center", gap: SPACE.md, marginBottom: text === "" ? 0 : "10px" },
						children: [
							jsx("span", {
								style: { font: FONT.bodyStrong, color: INK.primary },
								children: zh ? "视频介绍" : "About this video"
							}),
							meta === undefined ? jsx("span", { style: { flex: 1 } }) : jsx("span", {
								style: { font: FONT.micro, flex: 1, color: INK.secondary },
								children: [
									meta.lengthSeconds > 0 ? formatTime(meta.lengthSeconds) : "",
									meta.viewCount > 0 ? `${meta.viewCount.toLocaleString()} ${zh ? "次观看" : "views"}` : ""
								].filter((part) => part !== "").join(" · ")
							}),
							jsx("button", {
								type: "button",
								disabled: state.status === "loading",
								className: "swm-ctl swm-focus", style: { ...controlStyle(state.status === "loading"), font: FONT.micro, height: CONTROL.sm, padding: "0 10px" },
								onClick: () => { void load(true); },
								children: state.status === "loading" ? (zh ? "获取中…" : "Fetching…") : (zh ? "刷新" : "Refresh")
							})
						]
					}),
					text === ""
						? jsx("p", {
							style: { font: FONT.small, margin: 0, color: INK.secondary },
							children: state.status === "error"
								? state.error
								: state.status === "loading"
									? (zh ? "正在从视频页读取简介…" : "Reading the description from the watch page…")
									: (zh ? "该视频没有简介。" : "This video carries no description.")
						})
						: jsxs("div", {
							children: [
								jsx("div", {
									style: { font: FONT.body, color: INK.secondary },
									children: describeVideo(shown).map((piece, at) => {
										if (piece.kind === "section") {
											return jsx("div", {
												style: { font: FONT.smallStrong,
													margin: at === 0 ? "0 0 6px" : "14px 0 6px", color: INK.primary
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
													style: { font: FONT.small,
														appearance: "none", display: "flex", gap: SPACE.md, width: "100%",
														padding: "3px 6px", border: "none", borderRadius: RADIUS.sm,
														background: "transparent", font: "inherit",
														textAlign: "left", cursor: onSeek === undefined ? "default" : "pointer",
														color: INK.secondary
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
									style: { font: FONT.small,
										appearance: "none", border: "none", background: "transparent", padding: "8px 0 0",
										font: "inherit", color: hue(kind), cursor: "pointer"
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
								style: { font: FONT.body, margin: 0, color: INK.secondary },
								children: zh ? "还没有笔记。记下的内容存在本地信源库里，跟着这条信源走。" : "No notes yet. What you write is stored in the local library beside this source."
							})
							: notes.map((note) => jsxs("article", {
								style: {
									marginBottom: "10px", padding: "10px 12px",
									border: `1px solid ${LINE.rule}`, borderRadius: RADIUS.md
								},
								children: [
									jsxs("div", {
										style: { font: FONT.micro, display: "flex", alignItems: "center", gap: SPACE.sm, marginBottom: "6px", color: INK.secondary },
										children: [
											note.atSeconds === null ? null : jsx("span", { children: formatTime(note.atSeconds) }),
											jsx("span", { style: { flex: 1 }, children: formatDate(note.createdAt) }),
											jsx("button", {
												type: "button",
												className: "swm-ctl swm-focus", style: { ...controlStyle(), font: FONT.micro, height: "22px", padding: "0 8px" },
												onClick: async () => {
													await fetch(`${apiBase()}/notes?id=${encodeURIComponent(note.id)}`, { method: "DELETE" });
													await reload();
												},
												children: zh ? "删除" : "Delete"
											})
										]
									}),
									jsx("div", {
										style: { font: FONT.body, whiteSpace: "pre-wrap", color: INK.secondary },
										children: note.body
									})
								]
							}, note.id))
					}),
					jsxs("div", {
						style: { flex: "none", padding: "10px 12px", borderTop: `1px solid ${LINE.rule}` },
						children: [
							jsx("textarea", {
								value: draft,
								rows: 3,
								placeholder: zh ? "写点什么…" : "Write a note…",
								onChange: (event) => { setDraft(event.target.value); },
								className: "swm-focus", style: { font: FONT.body,
									width: "100%", boxSizing: "border-box", resize: "vertical",
									padding: "8px 10px", borderRadius: RADIUS.md,
									border: `1px solid ${LINE.rule}`, background: "transparent",
									color: INK.primary, font: "inherit"
								}
							}),
							jsxs("div", {
								style: { display: "flex", alignItems: "center", gap: SPACE.md, marginTop: "8px" },
								children: [
									jsxs("label", {
										style: { font: FONT.micro, display: "inline-flex", alignItems: "center", gap: SPACE.sm, flex: 1, color: INK.secondary, cursor: "pointer" },
										children: [
											jsx("input", { type: "checkbox", checked: pin, onChange: (event) => { setPin(event.target.checked); } }),
											jsx("span", { children: zh ? `记录时间点 ${formatTime(currentTime)}` : `Pin at ${formatTime(currentTime)}` })
										]
									}),
									jsx("button", {
										type: "button",
										disabled: draft.trim() === "",
										className: "swm-ctl swm-focus", style: controlStyle(draft.trim() === ""),
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
				width: "100%", height: "100%", border: `1px solid ${LINE.hair}`,
				borderRadius: RADIUS.lg, boxShadow: ELEVATION.raised,
				background: SURFACE.card
			};

			return jsxs("div", {
				style: { display: "flex", flexDirection: "column", height: "100%", minHeight: 0, gap: SPACE.md },
				children: [
					mode !== "html" ? null : jsxs("div", {
						style: { flex: "none", display: "flex", gap: SPACE.sm },
						children: [
							jsx("button", {
								type: "button",
								className: "swm-ctl swm-focus", style: view === "reader" ? { ...controlStyle(), borderColor: hue(kind, TINT.ring), color: hue(kind) } : controlStyle(),
								onClick: () => { setView("reader"); },
								children: zh ? "阅读视图" : "Reader"
							}),
							jsx("button", {
								type: "button",
								className: "swm-ctl swm-focus", style: view === "page" ? { ...controlStyle(), borderColor: hue(kind, TINT.ring), color: hue(kind) } : controlStyle(),
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
							alignItems: "center", justifyContent: "center", gap: SPACE.md,
							padding: "32px", textAlign: "center",
							border: `1px dashed ${LINE.rule}`, borderRadius: RADIUS.lg
						},
						children: [
							jsx("div", {
								style: { font: FONT.bodyStrong, color: INK.primary },
								children: zh ? "该站点拒绝了抓取" : "This site refused the fetch"
							}),
							jsx("div", {
								style: { font: FONT.small, color: INK.secondary, maxWidth: "52ch" },
								children: (zh ? "在你自己的浏览器里通常可以正常打开。" : "It usually opens normally in your own browser. ") + error
							}),
							jsx("a", {
								href: url, target: "_blank", rel: "noreferrer noopener",
								style: { font: FONT.bodyStrong,
									display: "inline-flex", alignItems: "center", height: CONTROL.md, padding: "0 16px",
									borderRadius: RADIUS.md, border: "1px solid " + hue(kind, TINT.ring),
									background: hue(kind, TINT.soft), color: hue(kind), textDecoration: "none"
								},
								children: zh ? "在浏览器中打开原文 ↗" : "Open the original ↗"
							}),
							summaryOf(row) === "" ? null : jsxs("div", {
								style: { font: FONT.body,
									marginTop: "8px", paddingTop: "16px", maxWidth: "72ch", textAlign: "left",
									borderTop: `1px solid ${LINE.hair}`, color: INK.secondary
								},
								children: [
									jsx("div", {
										style: { font: FONT.microStrong, marginBottom: "6px", color: INK.secondary },
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
										style: { font: FONT.large,
											maxWidth: wide ? "860px" : "720px",
											margin: "0 auto",
											padding: "8px 24px 40px",
											boxSizing: "border-box",
											color: INK.primary
										},
										children: [
											// An article opens with its own title. The header row above
											// truncates to fit beside the controls; here it has room.
											jsxs("header", {
												style: { marginBottom: "24px" },
												children: [
													jsx("h1", {
														style: { font: FONT.displayStrong,
															margin: "0 0 12px", fontFamily: ARTICLE_SERIF,
															letterSpacing: "-0.025em", color: INK.primary
														},
														children: typeof reader.title === "string" && reader.title !== "" ? reader.title : row.title
													}),
													jsx("div", {
														style: { font: FONT.base,
															display: "flex", flexWrap: "wrap", alignItems: "center", gap: SPACE.sm, color: INK.secondary
														},
														children: bylineParts(row, reader, zh).flatMap((part, at) => (at === 0
															? [jsx("span", { style: { fontWeight: 500 }, children: part }, `by${at}`)]
															: [jsx("span", { children: "·" }, `dot${at}`), jsx("span", { children: part }, `by${at}`)]))
													}),
													articleLead(row, reader) === "" ? null : jsx("p", {
														style: { font: FONT.large,
															margin: "16px 0 0", paddingLeft: "16px",
															borderLeft: `4px solid ${hue(kind)}`, fontStyle: "italic",
															color: INK.secondary
														},
														children: articleLead(row, reader)
													}),
													jsx("div", { style: { marginTop: "24px", borderBottom: `1px solid ${LINE.rule}` } })
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
				style: { display: "flex", gap: SPACE.xl, height: "100%", minHeight: 0, padding: "0 24px", boxSizing: "border-box" },
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
									gap: SPACE.md, marginBottom: "10px", minWidth: 0
								},
								children: [
									jsx("button", {
										type: "button",
										className: "swm-back swm-focus", style: { ...backStyle(), font: FONT.small, flex: "none", height: CONTROL.sm, padding: "0 10px" },
										onClick: onBack,
										children: [jsx(Icon, { name: "arrowLeft", size: ICON.xs }, "glyph"), zh ? "返回" : "Back"]
									}),
									jsx("span", {
										style: { font: FONT.smallStrong,
											flex: "none", padding: "2px 10px", borderRadius: RADIUS.pill,
											background: hue(kind, TINT.soft), color: hue(kind)
										},
										children: zh ? kind.zh : kind.en
									}),
									jsx("h1", {
										title: row.title,
										style: { font: FONT.largeStrong,
											flex: 1, minWidth: 0, margin: 0,
											color: INK.primary,
											overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap"
										},
										children: row.title
									}),
									jsx("span", {
										style: { font: FONT.micro, flex: "none", color: INK.secondary },
										children: [formatDate(row.publishedAt), sourceNameOf(row)].filter((part) => part !== "").join(" · ")
									}),
									jsx("a", {
										href: row.sourceUrl, target: "_blank", rel: "noreferrer noopener",
										style: { font: FONT.small, flex: "none", color: hue(kind), textDecoration: "none" },
										children: zh ? "打开原文 ↗" : "Open original ↗"
									})
								]
							}),
							isVideo
								? jsx("div", {
									style: {
										flex: "none", position: "relative", width: "100%", aspectRatio: "16 / 9",
										boxSizing: "border-box", borderRadius: RADIUS.lg, overflow: "hidden",
										border: `1px solid ${LINE.hair}`
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
							border: `1px solid ${LINE.hair}`, borderRadius: RADIUS.lg,
							boxShadow: ELEVATION.raised,
							background: SURFACE.card
						},
						children: jsx("button", {
							type: "button",
							title: zh ? "展开阅读栏" : "Expand the reading column",
							"aria-label": zh ? "展开阅读栏" : "Expand the reading column",
							"aria-expanded": false,
							onClick: () => { setCollapsed(false); },
							style: { font: FONT.small,
								appearance: "none", border: "none", borderRadius: RADIUS.md,
								background: hue(kind, TINT.soft), color: hue(kind),
								padding: "10px 4px", font: "inherit", cursor: "pointer",
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
							border: `1px solid ${LINE.hair}`, borderRadius: RADIUS.lg,
							boxShadow: ELEVATION.raised,
							background: SURFACE.card, overflow: "hidden"
						},
						children: [
							jsx("div", {
								style: {
									flex: "none", display: "flex", alignItems: "center", gap: SPACE.sm,
									padding: "8px", borderBottom: `1px solid ${LINE.rule}`,
									// The same omission the page tab bar had: this row is
									// three tabs and a 折叠 button inside a column capped
									// at 400px and floored at 260px, so at the floor it
									// had nowhere to put the fourth control and no way to
									// reach it. It scrolls rather than shrinking its own
									// labels to nothing.
									minWidth: 0, overflowX: "auto", overflowY: "hidden", scrollbarWidth: "none"
								},
								className: "swm-tabbar",
								role: "tablist",
								children: [
									...activeTabs.map((entry) => jsx("button", {
										type: "button",
										role: "tab",
										"aria-selected": entry.id === tab,
										onClick: () => { setTab(entry.id); },
										style: {
											// The whole shorthand swaps rather than a weight
											// riding beside a size: two weights at one size
											// have different advances, so the label moved
											// under the pointer as its tab was pressed. First
											// key, because `font` resets what follows it.
											font: entry.id === tab ? FONT.bodyStrong : FONT.body,
											appearance: "none", border: "none", borderRadius: RADIUS.md,
											flex: "none",
											padding: "7px 14px", cursor: "pointer",
											background: entry.id === tab ? hue(kind, TINT.soft) : "transparent",
											color: entry.id === tab ? hue(kind) : INK.secondary
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
										className: "swm-ctl swm-focus", style: {
											...controlStyle(), font: FONT.small, height: CONTROL.sm, padding: "0 10px",
											display: "inline-flex", alignItems: "center", gap: SPACE.sm
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
						className: "swm-focus", style: SEARCH_STYLE
					}),
					jsxs("div", {
						style: TOOLBAR_STYLE,
						children: [
							...KINDS.map((candidate) => jsx("button", {
								type: "button",
								role: "tab",
								"aria-selected": candidate.id === kindId,
								className: "swm-chip swm-focus", style: chipStyle(candidate, candidate.id === kindId),
								onClick: () => { setKindId(candidate.id); },
								children: zh ? candidate.zh : candidate.en
							}, candidate.id)),
							jsx("span", { style: { flex: 1 } }, "spacer"),
							jsx("select", {
								"aria-label": zh ? "排序" : "Sort",
								value: sortBy,
								onChange: (event) => { setSortBy(event.target.value); },
								className: "swm-ctl swm-focus", style: controlStyle(),
								children: SORTS.map((option) => jsx("option", {
									value: option.id,
									children: zh ? option.zh : option.en
								}, option.id))
							}, "sort")
						]
					}),
					status === "error"
						? ErrorBox({
							title: zh ? "信源加载失败" : "Could not load the sources",
							message: error,
							endpoint: apiBase(),
							// A NUDGE TO THE TICK, not a call to `load`. `load` is the
							// APPEND path and closes over `rows`; calling it here
							// would be a second definition of "read the first page"
							// sitting beside the effect that already owns one. The
							// tick re-runs that effect, which is also what the seed
							// does when it finishes.
							onRetry: () => { setReloadTick((tick) => tick + 1); },
							zh
						}, "error")
						: null,
					status === "loading"
						? SkeletonScreen({
							zh,
							children: [0, 1, 2].map((at) => jsxs("div", {
								// BUILT OUT OF CARD_STYLE ITSELF, so a change to the
								// card moves its placeholder with it. Nothing in a
								// source test can compare a skeleton with the thing it
								// becomes — the correspondence is per-pixel across two
								// render paths — so the only defence against drift is
								// to give both the same constant.
								style: { ...CARD_STYLE, alignItems: "flex-start" },
								children: [
									Skeleton({ w: "168px", h: "104px", r: RADIUS.md }, "thumb"),
									jsxs("div", {
										style: { flex: 1, minWidth: 0, display: "flex", flexDirection: "column", gap: SPACE.sm },
										children: [
											Skeleton({ w: "40%", h: "12px" }, "meta"),
											Skeleton({ w: "72%", h: "16px" }, "title"),
											Skeleton({ w: "100%", h: "12px" }, "line1"),
											Skeleton({ w: "86%", h: "12px" }, "line2")
										]
									}, "text")
								]
							}, `card${at}`))
						}, "loading")
						: null,
					status !== "loading" && status !== "error" && rows.length === 0
						? EmptyBox({
							mark: "book",
							title: zh ? "本地信源库中该类别为空。" : "The local library holds no source of this kind.",
							note: zh
								? "可从云端导入一批做种，之后由蜂群自行采集。"
								: "Seed a batch from the upstream, then let the swarm collect on its own.",
							// The seed button was already here and was already the
							// answer to this screen; it moves into the slot the
							// primitive keeps for it rather than being re-typed.
							action: jsx("button", {
								type: "button",
								className: "swm-ctl swm-focus", style: controlStyle(seeding),
								disabled: seeding,
								onClick: () => { void runSeed(); },
								children: seeding
									? (zh ? "导入中…" : "Seeding…")
									: (zh ? "从云端导入" : "Seed from upstream")
							}, "seed")
						}, "empty")
						: null,
					seedReport === "" ? null : jsx("div", {
						style: { font: FONT.small, margin: "10px 0", color: INK.secondary },
						children: seedReport
					}),
					rows.length === 0 ? null : jsxs("div", {
						children: [
							jsx("div", {
								style: { font: FONT.small, margin: "0 0 10px", color: INK.secondary },
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
								className: "swm-ctl swm-focus", style: controlStyle(),
								onClick: () => { void load(true); },
								children: zh ? "加载更多" : "Load more"
							})
						})
						: null,
					status === "loading-more"
						? jsx("div", {
							style: { font: FONT.small, textAlign: "center", padding: "8px", color: INK.secondary },
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
			{ id: "", en: "All", zh: "全部", hue: TONE.neutral },
			{ id: "running", en: "Running", zh: "运行中", hue: TONE.info },
			{ id: "completed", en: "Completed", zh: "已完成", hue: TONE.success },
			{ id: "quality-failed", en: "Not signed", zh: "未签署", hue: TONE.warn },
			{ id: "resumable", en: "Resumable", zh: "可继续", hue: TONE.accent },
			{ id: "failed", en: "Failed", zh: "失败", hue: TONE.danger },
			{ id: "cancelled", en: "Cancelled", zh: "已取消", hue: TONE.neutral }
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
			// AND A MARK BESIDE THE COLOUR, on every one. `cancelled` and `unknown`
			// share TONE.neutral and `failed` and `unknown-terminal` share
			// TONE.danger, so on this table too the hue alone answers a question
			// this table exists to answer precisely. The glyph is what carries the
			// difference to a reader who cannot tell two tints apart — which is
			// roughly one man in twelve, not an edge case.
			running: { zh: "运行中", en: "Running", hue: TONE.info, icon: "spinner" },
			resumable: { zh: "可继续", en: "Resumable", hue: TONE.accent, icon: "play" },
			completed: { zh: "完成", en: "Completed", hue: TONE.success, icon: "check" },
			failed: { zh: "失败", en: "Failed", hue: TONE.danger, icon: "close" },
			cancelled: { zh: "已取消", en: "Cancelled", hue: TONE.neutral, icon: "minus" },
			"quality-failed": { zh: "未签署", en: "Not signed off", hue: TONE.warn, icon: "alert" },
			unknown: { zh: "未知", en: "Unknown", hue: TONE.neutral, icon: "circle" },
			"unknown-terminal": { zh: "未知（已结束）", en: "Unknown (ended)", hue: TONE.danger, icon: "circle" }
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

		/**
		* The same twelve, as positions.
		*
		* `Object.keys` on a literal returns the order it was written in, so this
		* is the table above read a second way rather than a second table — which
		* is the whole point: a thirteenth stage added to the catalogue lands here
		* too, and a list row cannot start measuring against a denominator the
		* detail screen has never heard of.
		*/
		const MISSION_STAGE_ORDER = Object.keys(MISSION_STAGE_FACES);

		/**
		* The seven agents and the run itself, in the reader's language.
		*
		* Keyed exactly as ROLE_TONE is keyed, and it carries NO `hue`. That is
		* the decision worth recording: every other table here declares its own
		* colour, but a role's colour is ROLE_TONE's and `roleTone()` is the
		* lookup — copying the eight hues down here would be a second place for
		* "researcher is blue" to be true, and the file already paid for that
		* once when `running` was declared in five tables and changing it was
		* five edits and a miss.
		*
		* The words are chosen not to collide with a STAGE's word: the reviewer
		* is 评审员 rather than 复盘, which is s10's name, because an owner column
		* and a stage column sit side by side on the task board and two things
		* reading 复盘 in one row is a row that has to be re-read.
		*/
		const MISSION_AGENT_FACES = {
			leader: { zh: "领队", en: "Leader" },
			researcher: { zh: "研究员", en: "Researcher" },
			analyst: { zh: "分析员", en: "Analyst" },
			reconciler: { zh: "归一员", en: "Reconciler" },
			writer: { zh: "撰稿人", en: "Writer" },
			reviewer: { zh: "评审员", en: "Reviewer" },
			verifier: { zh: "核验员", en: "Verifier" },
			mission: { zh: "任务", en: "Mission" }
		};

		/**
		* WHAT KIND OF STEP a stage is, which the catalogue declares and nothing drew.
		*
		* Every stage carries a `mode` — it is on the projection at
		* lib/mission-view.js:321 and on the synthesised rows beside it — and the
		* board answered "why does this row exist" only for CHILD rows. For a
		* stage the answer is always "the pipeline declares twelve", which says
		* why the row is there and not what it does.
		*
		* ALL NINE, not the five that are obvious. `missionFace` falls through to
		* the raw value, so a mode this table has never heard of prints
		* `fan-out` — an English identifier on a Chinese screen — rather than
		* nothing. The nine are lib/mission-runtime.js's own, read off the STAGES
		* catalogue, and a source test holds this key set to that file's so a
		* tenth mode cannot arrive silently.
		*/
		const MISSION_STAGE_MODE_FACES = {
			gate: { zh: "闸门", en: "Gate", hue: TONE.warn },
			plan: { zh: "规划", en: "Plan", hue: TONE.accent },
			"fan-out": { zh: "并行分发", en: "Fan-out", hue: TONE.info },
			review: { zh: "评审", en: "Review", hue: TONE.neutral },
			synthesize: { zh: "综合", en: "Synthesize", hue: PALETTE.cyan },
			draft: { zh: "起草", en: "Draft", hue: PALETTE.rose },
			verify: { zh: "核验", en: "Verify", hue: TONE.success },
			signoff: { zh: "签署", en: "Sign-off", hue: TONE.accent },
			persist: { zh: "归档", en: "Persist", hue: TONE.muted }
		};

		/**
		* Stage statuses. `skipped-by-tier` is not a failure and must not be drawn as one.
		*
		* WHICH IS EXACTLY WHY EVERY ROW ALSO CARRIES A GLYPH. Holding that line
		* on the colour costs something: `pending` and `skipped-by-tier` end up
		* on the same TONE.muted two lines apart, and a twelve-cell ruler drawn in
		* tint alone then says the same grey about "has not started" and "will
		* never start here". The fix is NOT to give the skip a colour — that would
		* draw it as an outcome — it is to give both a mark, so the ruler is
		* readable in one glance and still readable with the colour taken away.
		*/
		const MISSION_STAGE_STATUS_FACES = {
			pending: { zh: "待运行", en: "Pending", hue: TONE.muted, icon: "circle" },
			running: { zh: "运行中", en: "Running", hue: TONE.info, icon: "spinner" },
			done: { zh: "完成", en: "Done", hue: TONE.success, icon: "check" },
			degraded: { zh: "降级完成", en: "Degraded", hue: TONE.warn, icon: "alert" },
			failed: { zh: "失败", en: "Failed", hue: TONE.danger, icon: "close" },
			"skipped-by-tier": { zh: "本档跳过", en: "Skipped at this tier", hue: TONE.muted, icon: "minus" }
		};

		/**
		* Dimension states, from `mission_dimensions.state`.
		*
		* Keyed to overlap MISSION_STAGE_STATUS_FACES where the two mean the same
		* thing (`pending`, `degraded`, `failed`) and to differ where they do
		* not, which is what lets the task board draw a stage row and a dimension
		* row in one column: it looks here only when the stage table has never
		* heard of the value. Same marks for the same meanings, for the same
		* reason — a 采集中 row and a 运行中 row are the same shape of fact.
		*/
		const MISSION_DIMENSION_FACES = {
			pending: { zh: "待采集", en: "Pending", hue: TONE.muted, icon: "circle" },
			collecting: { zh: "采集中", en: "Collecting", hue: TONE.info, icon: "spinner" },
			collected: { zh: "已采集", en: "Collected", hue: TONE.success, icon: "check" },
			degraded: { zh: "降级", en: "Degraded", hue: TONE.warn, icon: "alert" },
			failed: { zh: "失败", en: "Failed", hue: TONE.danger, icon: "close" }
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
			// AND THE HUES SAY THE SAME SPLIT. This was the one vocabulary in the
			// file with no colour at all, so `missionHue` answered TONE.neutral for
			// all nine and 已核验 and 查无此文 were drawn as the same grey chip —
			// which undoes the whole reason the column has nine values, on the one
			// screen where it matters.
			"verified-source-text": { zh: "已核验", en: "Verified", hue: TONE.success },
			"verified-adjacent-spans": { zh: "跨段核验", en: "Verified across spans", hue: TONE.success },
			// Verified against an ABSTRACT is not verified against the paper. Amber
			// rather than green: it is a real check with a named limit, and drawing
			// it green is the claim the limit exists to refuse.
			"verified-abstract": { zh: "仅摘要核验", en: "Verified against an abstract", hue: TONE.warn },
			misattributed: { zh: "出处不符", en: "Found in another source", hue: TONE.danger },
			unverifiable: { zh: "查无此文", en: "Found nowhere we hold", hue: TONE.danger },
			"too-short": { zh: "引语过短", en: "Below the quote floor", hue: TONE.warn },
			// MUTED, NOT DANGER, and this is the half a colour ramp gets wrong. A
			// fetch that 429'd is a quote NOBODY CHECKED; an unverifiable one is a
			// quote that was checked and found nowhere. Drawing them alike says
			// four invented citations and four rate-limited ones are the same
			// result, which is exactly what the split above exists to prevent.
			"unchecked-fetch-failed": { zh: "抓取失败", en: "Fetch failed", hue: TONE.muted },
			"unchecked-rate-limited": { zh: "被限流", en: "Rate limited", hue: TONE.muted },
			"unchecked-stale": { zh: "页面过期", en: "Page too old", hue: TONE.muted }
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

		/**
		* The tool doors, named and marked.
		*
		* Tool ids reached the screen as raw mono slugs — `web`, `fetch` — in a
		* table whose whole subject is which door is failing, and once as the
		* middle term of a `stamp · stage · tool · pace · code` sentence where
		* the one word a reader is scanning for had nothing to make it findable.
		*
		* SEEDED FROM THE CEILINGS, deliberately: MISSION_METER_FACES above
		* already names `web`, `fetch` and `arxiv`, and they are the closest
		* thing to a tool vocabulary this half holds. The Host's registration is
		* the authority and this list does NOT block on enumerating it, because
		* it does not have to: `missionFace` returns the raw key for a tool it
		* has never heard of and `missionHue` returns TONE.neutral, so an
		* unlisted door degrades to its own slug under a wrench rather than
		* rendering blank. Reconcile against lib/index.js when the ids are known;
		* keep the fallback either way.
		*/
		const MISSION_TOOL_FACES = {
			web: { zh: "网页搜索", en: "Web search", icon: "search", hue: TONE.info },
			fetch: { zh: "抓取页面", en: "Page fetch", icon: "globe", hue: TONE.info },
			arxiv: { zh: "arXiv", en: "arXiv", icon: "book", hue: PALETTE.violet },
			"knowledge-base": { zh: "知识库", en: "Knowledge base", icon: "book", hue: TONE.success }
		};

		/**
		* Every event type the Host half registers, in the reader's language — and,
		* since this batch, in its colour.
		*
		* THIS WAS THE ONE VOCABULARY WITH NO HUE. `missionHue` (below) answers
		* TONE.neutral for any entry whose `hue` is not a string, so 闸门拒绝 and
		* 阶段完成 came out of it as the same grey and the event stream was a
		* colourless log — on the screen that is shown exactly when the trajectory
		* has failed and the log is all a person has left.
		*
		* A TABLE, NOT A REGEX, and it is worth recording why so it is not
		* re-argued. The alternative on the table was to derive the tone in the
		* renderer from the type string's own suffix — `/failed|refused/` → danger
		* and so on. It reads as less to maintain and is not: the suffixes are the
		* Host half's identifiers, not a designed vocabulary, so `postlude:pending`
		* and `evidence:none` only match by accident, a new event type gets a
		* colour nobody chose, and nothing in the source can be tested key by key.
		* Every other vocabulary here declares its own colour beside its own words.
		* This one now does too, and the source test counts the two columns.
		*/
		const MISSION_EVENT_FACES = {
			// Bookkeeping: the row exists, and that is all it says. A mission is
			// CREATED by the form and STARTED by the runtime, and only the second
			// one is news.
			"mission:created": { zh: "任务建立", en: "Mission created", hue: TONE.muted },
			"mission:claimed": { zh: "接管本次运行", en: "Run claimed", hue: TONE.info },
			"mission:parked": { zh: "已挂起", en: "Parked", hue: TONE.muted },
			"mission:finalized": { zh: "任务收尾", en: "Mission finalized", hue: TONE.success },
			"mission:started": { zh: "开始运行", en: "Mission started", hue: TONE.info },
			"mission:resumed": { zh: "从检查点继续", en: "Resumed from a checkpoint", hue: TONE.info },
			"stages:opened": { zh: "阶段表建立", en: "Stage rows opened", hue: TONE.info },
			"stage:started": { zh: "阶段开始", en: "Stage started", hue: TONE.info },
			"stage:done": { zh: "阶段完成", en: "Stage done", hue: TONE.success },
			"stage:degraded": { zh: "阶段降级完成", en: "Stage degraded", hue: TONE.warn },
			"stage:failed": { zh: "阶段失败", en: "Stage failed", hue: TONE.danger },
			// Muted, exactly as MISSION_STAGE_STATUS_FACES mutes it: a tier that
			// does not run a stage has not failed to run it.
			"stage:skipped-by-tier": { zh: "本档跳过", en: "Skipped at this tier", hue: TONE.muted },
			"stage:stalled": { zh: "阶段停滞", en: "Stage stalled", hue: TONE.warn },
			"gate:passed": { zh: "闸门通过", en: "Gate passed", hue: TONE.success },
			"gate:soft-warning": { zh: "预算软警告", en: "Soft budget warning", hue: TONE.warn },
			"gate:hard-warning": { zh: "硬闸门告警", en: "Hard gate warning", hue: TONE.warn },
			"gate:refused": { zh: "闸门拒绝", en: "Gate refused", hue: TONE.danger },
			"artifact:written": { zh: "报告已归档", en: "Artefact written", hue: TONE.success },
			"evidence:none": { zh: "没有任何可核验的证据", en: "No verifiable evidence", hue: TONE.danger },
			"evidence:thin": { zh: "证据偏薄", en: "Evidence is thin", hue: TONE.warn },
			"recollect:allowed": { zh: "允许补采", en: "Recollect allowed", hue: TONE.success },
			"recollect:refused": { zh: "拒绝补采", en: "Recollect refused", hue: TONE.warn },
			"recollect:no-gain": { zh: "补采没有新增", en: "Recollect gained nothing", hue: TONE.warn },
			"checkpoint:divergence": { zh: "检查点分歧", en: "Checkpoint divergence", hue: TONE.danger },
			// WARN, not muted. The batch text listed this one with the quiet
			// bookkeeping events, and its own regex sketch put `orphan` in the
			// amber band; the amber sketch is right. A reclaim means a previous
			// process abandoned this run mid-flight and something else picked it
			// up — routine to the runtime, never routine to the person reading
			// why a mission has two starts in its log.
			"runtime:orphan-reclaimed": { zh: "回收了孤儿任务", en: "Orphan reclaimed", hue: TONE.warn },
			"runtime:owner-conflict": { zh: "归属冲突", en: "Owner conflict", hue: TONE.danger },
			"runtime:reclaim-limit": { zh: "回收次数到顶", en: "Reclaim limit reached", hue: TONE.warn },
			"postlude:pending": { zh: "收尾待办", en: "Postlude pending", hue: TONE.warn },
			"postlude:handoff-failed": { zh: "收尾交接失败", en: "Postlude handoff failed", hue: TONE.warn }
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
			return Object.hasOwn(faces, key) && typeof faces[key].hue === "string" ? faces[key].hue : TONE.neutral;
		}

		/**
		* The MARK a vocabulary value carries, undefined for one this page does not know.
		*
		* Undefined rather than a fallback glyph, because `Chip` takes undefined
		* to mean "no mark" and a placeholder tick on a state nobody named would
		* be a claim about that state. Own-property for the same reason
		* `missionFace` is: these tables are keyed by whatever a TEXT column
		* holds, and `faces["constructor"].icon` is not undefined — it is a
		* lookup on the prototype dressed as a glyph name.
		* @param faces - the label table.
		* @param value - the stored value.
		* @returns an ICON_PATHS name, or undefined.
		*/
		function missionIcon(faces, value) {
			const key = String(value ?? "");
			return Object.hasOwn(faces, key) && typeof faces[key].icon === "string" ? faces[key].icon : undefined;
		}

		/**
		* WHAT KIND OF STEP this is, badged — but only when it says something new.
		*
		* SUPPRESSION IS THE WHOLE DESIGN. Six of the twelve stages are named
		* after their own mode: s6-synthesize is 综合 and its mode is
		* `synthesize`, and s2/s9/s11/s12 collide the same way. Drawn
		* unconditionally, half the board would print the stage's name twice in
		* two shapes, which is worse than not drawing it — a badge that repeats
		* the word beside it teaches the reader to stop looking at badges.
		*
		* The comparison is on the RESOLVED LABEL rather than on a hard-coded
		* list of stage ids, because the collision is a fact about the words and
		* the words are per-language. A list would be right in Chinese and wrong
		* in English the first time one of the twelve is renamed.
		* @param props - `{mode, stepId, zh}`.
		* @param key - React's key.
		* @returns the badge, or null when it would only repeat the stage's name.
		*/
		function StageModeChip({ mode, stepId, zh }, key) {
			const id = String(mode ?? "").trim();
			if (id === "") return null;
			const label = missionFace(MISSION_STAGE_MODE_FACES, id, zh);
			if (label === missionFace(MISSION_STAGE_FACES, stepId, zh)) return null;
			return Chip({
				tone: missionHue(MISSION_STAGE_MODE_FACES, id),
				label,
				title: label === id ? id : `${label} · ${id}`
			}, key);
		}

		/**
		* One tool door as a chip: its word, its mark, its colour and its tally.
		*
		* An unlisted id keeps its slug and takes the wrench, which is the same
		* fallthrough `missionFace` gives every other vocabulary here — a door
		* the Host registered after this table was written must draw as itself,
		* not as nothing.
		*
		* THE COUNT ONLY RIDES ALONG WHEN THERE IS MORE THAN ONE. "web 1" is a
		* badge that says nothing and takes the width of one that does.
		* @param props - `{toolId, count, zh, size}`.
		* @param key - React's key.
		*/
		function ToolChip({ toolId, count, zh, size }, key) {
			const id = String(toolId ?? "").trim();
			if (id === "") return null;
			const label = missionFace(MISSION_TOOL_FACES, id, zh);
			const n = Number(count ?? 0);
			return Chip({
				tone: missionHue(MISSION_TOOL_FACES, id),
				icon: Object.hasOwn(MISSION_TOOL_FACES, id) ? MISSION_TOOL_FACES[id].icon : "wrench",
				label,
				count: Number.isFinite(n) && n > 1 ? String(n) : undefined,
				size,
				// The raw id stays reachable: it is what the Host logs and what a
				// support question quotes, and the word above it is ours.
				title: label === id ? id : `${label} · ${id}`
			}, key);
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
		* @returns `{ label, hue, icon, note }`; `note` is "" when nothing is degraded.
		*/
		function missionPillFace(pill, zh) {
			const code = String(pill?.code ?? "unknown");
			const degraded = code.endsWith("-degraded");
			const base = degraded ? code.slice(0, -"-degraded".length) : code;
			const label = missionFace(MISSION_PILL_FACES, base, zh);
			if (!degraded) {
				return { label, hue: missionHue(MISSION_PILL_FACES, base), icon: missionIcon(MISSION_PILL_FACES, base), note: "" };
			}
			const total = Number(pill?.totalDimensions ?? 0);
			const bad = Number(pill?.degradedDimensions ?? 0);
			return {
				label,
				// Degradation is amber whatever the base outcome was, because the
				// question it answers — can I trust all of this — is the same
				// whether the mission completed or failed.
				hue: TONE.warn,
				// AND THE MARK MOVES WITH THE COLOUR. The base outcome's glyph —
				// a tick for 完成 — over an amber pill would be a tick and a
				// warning on one badge, which is the reading this whole branch
				// exists to refuse.
				icon: "alert",
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
		* The degrade ladder the Host half froze, turned into a colour.
		*
		* It was a ternary inside MissionCostMeters' map, with the rungs read off
		* `cost.ladder` so the meter and the runtime could not disagree. The
		* header's token tile needs the same answer, and re-typing `0.9` and
		* `0.7` up there is precisely how the two start disagreeing — the second
		* copy is the one nobody edits.
		* @param ratio - used over limit, or null.
		* @param ladder - `cost.ladder`; the defaults are the contract's.
		* @returns a TONE triple.
		*/
		function missionLadderHue(ratio, ladder) {
			const at = Number(ratio) || 0;
			const rungs = ladder ?? {};
			return at >= (rungs.warn ?? 0.9) ? TONE.danger
				: at >= (rungs.soften ?? 0.7) ? TONE.warn
				: TONE.success;
		}

		/**
		* The rungs a VERIFICATION rate is graded on, named once.
		*
		* `missionLadderHue` above grades a ratio where MORE IS WORSE — tokens
		* against a ceiling — and three places on this tab grade one where more
		* is better: the report's scorecard, the sources pane's coverage tile and
		* the reference list's verified tile. Reading the spend ladder for those
		* would paint a fully verified section red.
		*
		* All three typed `>= 0.8 ? … : >= 0.5 ? …` by hand in the reference this
		* was drawn from, which is one decision in three copies and two of them
		* are the copies nobody edits.
		*/
		const MISSION_RATE_GOOD = 0.8;
		const MISSION_RATE_FAIR = 0.5;

		/**
		* How much of a population held up, as a share.
		*
		* `null` FOR AN EMPTY POPULATION, never 0 and never 1. `verified / total`
		* at 0/0 is NaN — which CSS drops, leaving a bar at its full width — and
		* `verified >= total` is TRUE at nought, which is the clean bill this
		* file refuses to give in four other places.
		* @param verified - how many passed.
		* @param total - how many there were.
		* @returns the share in 0..1, or null when there was nothing to check.
		*/
		function missionRate(verified, total) {
			const all = Number(total) || 0;
			if (all <= 0) return null;
			return Math.max(0, Math.min(1, (Number(verified) || 0) / all));
		}

		/**
		* The same share, as a colour.
		* @param verified - how many passed.
		* @param total - how many there were.
		* @returns a TONE triple; neutral when nothing was checked at all.
		*/
		function missionRateHue(verified, total) {
			const rate = missionRate(verified, total);
			// NOT GREEN AT NOUGHT. A section nobody checked satisfies every
			// threshold above, and drawing it green is the reading the whole
			// scorecard exists to refuse.
			if (rate === null) return TONE.neutral;
			return rate >= MISSION_RATE_GOOD ? TONE.success
				: rate >= MISSION_RATE_FAIR ? TONE.warn
				: TONE.danger;
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
			quick: { zh: "快速", en: "Quick", hue: TONE.success },
			standard: { zh: "标准", en: "Standard", hue: TONE.info },
			deep: { zh: "深度", en: "Deep", hue: TONE.accent }
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
		* @param topicRef - optional, so the empty list can put the cursor here.
		*/
		function MissionStarter({ zh, onStarted, topicRef }) {
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

			// NO CARD. This was a `CARD_STYLE` box because it was a card on a
			// page of cards; it is the body of a dialog now, and a bordered,
			// shadowed, 16px-margined panel inside a bordered, shadowed dialog
			// is the same edge drawn twice. The dialog's body carries the
			// padding, so the form is just its own column.
			return jsxs("div", {
				style: { display: "flex", flexDirection: "column", gap: SPACE.md },
				children: [
					jsx("input", {
						type: "text",
						// The empty list's call to action lands HERE. An empty state
						// that names the next step and cannot take you to it is a
						// sentence, not an action.
						ref: topicRef,
						value: topic,
						placeholder: zh ? "要调研什么？写一个问题，越具体越好。" : "What should the swarm research? A question, as specific as you can make it.",
						"aria-label": zh ? "任务课题" : "Mission topic",
						onChange: (event) => { setTopic(event.target.value); },
						onKeyDown: (event) => { if (event.key === "Enter" && ready) void start(); },
						className: "swm-focus", style: SEARCH_STYLE
					}, "topic"),
					jsxs("div", {
						style: { display: "flex", alignItems: "center", gap: SPACE.sm, flexWrap: "wrap" },
						children: [
							...depths.map((id) => jsx("button", {
								type: "button",
								role: "tab",
								"aria-selected": id === depth,
								title: missionTierLine(table[id], zh),
								onClick: () => { setDepth(id); },
								className: "swm-chip swm-focus", style: chipStyle({ hue: missionHue(MISSION_TIER_FACES, id) }, id === depth),
								children: missionFace(MISSION_TIER_FACES, id, zh)
							}, id)),
							jsx("span", { style: { flex: 1 } }, "spacer"),
							jsx("button", {
								type: "button",
								disabled: !ready,
								onClick: () => { void start(); },
								className: "swm-ctl swm-focus", style: { ...controlStyle(!ready) },
								children: busy ? (zh ? "正在建立…" : "Starting…") : (zh ? "开始调研" : "Start")
							}, "go")
						]
					}, "controls"),
					depth === "" ? null : jsx("div", {
						style: { font: FONT.small, color: INK.secondary },
						children: missionTierLine(table[depth], zh)
					}, "tier"),
					tiersError === "" ? null : jsx("div", {
						style: { font: FONT.small, color: `rgb(${TONE.danger})` },
						children: (zh ? "读不到档位表，暂时不能新建任务：" : "The tier table did not answer, so a mission cannot be started: ")
							+ tiersError + ` (${apiBase()}/missions/budget-tiers)`
					}, "tiersError"),
					error === "" ? null : jsx("div", {
						style: { font: FONT.small, color: `rgb(${TONE.danger})` },
						children: error
					}, "error"),
					notice === "" ? null : jsx("div", {
						style: { font: FONT.small, color: `rgb(${TONE.warn})` },
						children: notice
					}, "notice")
				]
			});
		}
		//#endregion

		//#region missions list
		/**
		* THE LIST IS A GRID, and the placeholder is drawn in the same one.
		*
		* It was a single column: a card holding a topic, a state pill and a
		* five-part meta line, stretched across whatever the window gave it. On
		* a wide overlay most of every row was empty and four missions filled
		* the screen, which is the one thing a list of runs must not do — the
		* whole value of it is how many you can compare at once.
		*
		* 340px AND NOT 320. `MissionListRow`'s meta line joins five pieces into
		* one string; below 340 it wraps to four lines and the card stops being
		* a card.
		*
		* `auto-fill` RATHER THAN `auto-fit`. With `auto-fit` an empty track
		* collapses, so a filter matching one mission draws one card as wide as
		* the window — the exact layout this replaces, arriving again on the
		* screen where it looks most like a mistake.
		*
		* Declared here rather than inline because the loading skeleton is laid
		* out in it too: the placeholder and the list have to agree about the
		* shape or the page jumps when the answer lands, and two copies of a
		* grid definition is how they stop agreeing.
		*/
		const MISSION_LIST_GRID = {
			display: "grid", gap: SPACE.lg, alignItems: "stretch",
			gridTemplateColumns: "repeat(auto-fill, minmax(340px, 1fr))"
		};

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
			// HOW FAR ALONG, in the list — where a running mission carried no
			// ratio and no bar at all, only a start stamp and a spinner.
			//
			// AND IT IS NOT `progress.percent`. The list route hands back the raw
			// mission row: `listMissions` attaches a verified count and a spend
			// sum and nothing else, and the twelve-stage roll-up the projector
			// computes lives one route over, on the detail view. So the fraction
			// here is the ORDINAL of the stage the row says it is on, out of the
			// twelve the catalogue freezes — the same denominator the detail
			// screen draws against, deliberately, so the two bars cannot be read
			// as measuring different things.
			//
			// It can sit ONE STAGE AHEAD of `stagesResolved`: a stage that is
			// running counts here and does not count there. Named rather than
			// smoothed over, because the alternative is a second definition of
			// "done" that disagrees with the first without saying so.
			// ONE NUMBER, drawn and announced. Written twice — once as the bar's
			// value and once as its `aria-valuenow` — it is two numbers, and a
			// mutation test proved it: the fill can be moved off by one while the
			// screen reader keeps saying the old figure, and nothing on the page
			// disagrees with anything a person can see.
			//
			// `null` for a stage the catalogue has never heard of, which includes
			// a row that has not reached s1 yet.
			const stageAt = MISSION_STAGE_ORDER.indexOf(mission.lastStage ?? "");
			const stageOrdinal = stageAt < 0 ? null : stageAt + 1;
			const meta = [
				missionFace(MISSION_TIER_FACES, mission.depth, zh),
				zh ? `第 ${mission.runCount} 次运行` : `run ${mission.runCount}`,
				zh ? `已核验 ${mission.verifiedFindings ?? 0} 条` : `${mission.verifiedFindings ?? 0} verified`,
				// SHORT, like everywhere else the same quantity is drawn. This was
				// the site where the list and the detail header disagreed about one
				// run: `412,000 令牌` here and `412k` four inches away on the screen
				// the row opens. There is no per-figure hover to hang the exact
				// number on — this meta line is one joined sentence — and it does
				// not need one: the detail header's token tile prints the exact
				// figure against its ceiling in its own hint.
				zh ? `${missionCompact(mission.spend?.tokens ?? 0)} 令牌` : `${missionCompact(mission.spend?.tokens ?? 0)} tokens`,
				formatStamp(mission.startedAt)
			].filter((piece) => piece !== "").join(" · ");

			// The topic is the control, the way a 信源 card's title is: a whole
			// card wrapped in one button puts flow content inside phrasing
			// content and hands a screen reader one enormous label.
			return jsx("article", {
				// THE CARD'S OWN MARGIN IS OVERRIDDEN HERE AND NOT REMOVED FROM
				// CARD_STYLE. That margin has four consumers — the 信源 feed, the
				// starter, this row and MissionPanel — and stripping it re-flows
				// two screens this batch never looked at. In a grid the gap is
				// the rhythm, so the margin is cancelled at the one site that
				// sits in one.
				style: { ...(hover ? CARD_HOVER_STYLE : CARD_STYLE), marginBottom: 0, height: "100%", flexDirection: "column" },
				onMouseEnter: () => { setHover(true); },
				onMouseLeave: () => { setHover(false); },
				children: jsxs("div", {
					style: { flex: 1, minWidth: 0, display: "flex", flexDirection: "column", gap: SPACE.sm },
					children: [
						jsxs("div", {
							style: { display: "flex", alignItems: "center", gap: SPACE.md, width: "100%" },
							children: [
								jsx("button", {
									type: "button",
									onClick: () => { onOpen(mission.id); },
									style: { font: FONT.baseStrong,
										appearance: "none", border: "none", background: "transparent", padding: 0,
										flex: 1, minWidth: 0, textAlign: "left", font: "inherit", cursor: "pointer",
										color: INK.primary
									},
									children: mission.topic
								}, "topic"),
								// The mission's STATE, so it takes the pill shape rather
								// than the chip's. It was drawn at `1px 7px` on a 5px
								// radius here and at `1px 8px` on a 6px one in the
								// header of the screen this row opens.
								//
								// AND A MARK BESIDE THE WORD. 已取消 and 未知 are both
								// TONE.neutral and 失败 and 未知（已结束） are both
								// TONE.danger, so in a scanned list the colour narrows
								// the answer to two and the glyph finishes it. A running
								// mission gets the spinner, which is the one row in the
								// list that is still moving.
								Chip({ tone: face.hue, pill: true, icon: face.icon, label: face.label }, "pill")
							]
						}, "head"),
						// Only while running, and only once a stage has been recorded.
						// A row that has not reached s1 yet has nothing to measure —
						// an empty track under it would say the mission is a twelfth
						// of the way through nothing.
						mission.status !== "running" || stageOrdinal === null ? null : Meter({
							value: stageOrdinal, max: MISSION_STAGE_ORDER.length, tone: face.hue,
							role: "progressbar",
							"aria-valuenow": stageOrdinal,
							"aria-valuemin": 0,
							"aria-valuemax": MISSION_STAGE_ORDER.length,
							"aria-label": zh
								? `阶段 ${stageOrdinal}/${MISSION_STAGE_ORDER.length}`
								: `stage ${stageOrdinal} of ${MISSION_STAGE_ORDER.length}`
						}, "progress"),
						jsx("div", { style: META_STYLE, children: meta }, "meta"),
						// A row that says running while nothing is running it is the
						// symptom of a process that died mid-mission. Named here
						// rather than left for the person to infer from a clock that
						// never moves.
						!stale ? null : jsx("div", {
							style: { font: FONT.small, color: `rgb(${TONE.warn})` },
							children: zh
								? "这一条写着运行中，但本进程没有在跑它 —— 多半是上次进程退出时留下的，打开后可以继续或重跑。"
								: "This row says running, but this process is not running it — most likely left behind by an earlier exit. Open it to resume or rerun."
						}, "stale"),
						mission.errorMessage === null || mission.errorMessage === undefined || mission.errorMessage === "" ? null : jsx("div", {
							style: { font: FONT.small, color: INK.secondary },
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
								style: { font: FONT.micro,
									appearance: "none", background: "transparent", cursor: "pointer",
									border: `1px solid ${LINE.hair}`, borderRadius: RADIUS.md,
									padding: "3px 10px",
									color: INK.secondary
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
							style: { font: FONT.small, color: `rgb(${TONE.danger})` },
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
			// The empty list's call to action puts the cursor in the starter's
			// topic field. Held here rather than inside MissionStarter because
			// the control and the field are in two different components.
			const topicRef = useRef(null);
			// Whether the create form is open. It was not a state at all: the
			// form was a permanently expanded card above the toolbar and above
			// every mission, so the first thing this tab said on every visit was
			// "ask a new question" — to a person who almost always came here to
			// read an answer to an old one.
			const [startOpen, setStartOpen] = useState(false);
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

			// THE CURSOR FOLLOWS THE FORM. The empty list's call to action used
			// to focus the topic field directly, which worked because the field
			// was always mounted four inches up the same screen. It is behind a
			// control now, so the focus has to wait for the dialog to render —
			// hence an effect on `startOpen` rather than a call in the handler,
			// which would run one frame too early against a ref that is still
			// null.
			useEffect(() => {
				if (!startOpen) return;
				topicRef.current?.focus?.();
			}, [startOpen]);

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
					// THE FRAME, not the 1080px measure. CONTENT_STYLE was written
					// for a column of prose read on its own; a grid of cards under
					// it stops growing at three columns and leaves a band of dead
					// page down the right. The detail view already made exactly this
					// swap for exactly this reason.
					style: { ...WIDE_STYLE, padding: "0 24px" },
					children: [
						jsxs("div", {
							style: TOOLBAR_STYLE,
							children: [
								...MISSION_FILTERS.map((entry) => jsx("button", {
									type: "button",
									role: "tab",
									"aria-selected": entry.id === filterId,
									className: "swm-chip swm-focus", style: chipStyle(entry, entry.id === filterId),
									onClick: () => { setFilterId(entry.id); },
									children: entry.id === "" || counts[entry.id] === undefined
										? (zh ? entry.zh : entry.en)
										: `${zh ? entry.zh : entry.en} ${counts[entry.id]}`
								}, entry.id === "" ? "all" : entry.id)),
								jsx("span", { style: { flex: 1 } }, "spacer"),
								jsx("button", {
									type: "button",
									className: "swm-ctl swm-focus", style: controlStyle(),
									onClick: () => { setTick((value) => value + 1); },
									children: zh ? "刷新" : "Refresh"
								}, "refresh"),
								// THE ONE THING ON THIS SCREEN THAT MAKES SOMETHING,
								// and it is the last control in the row rather than a
								// card above it. A tinted `controlStyle` rather than a
								// tenth button geometry: the accent wash and ring are
								// the same pair every chip in this file wears, spread
								// over the control the row's other button already is.
								//
								// IT IS NOT IN THE PAGE HEADER, which is where the
								// brief put it. That header is the shell's — it serves
								// all five tabs, TABS carries no action for any of
								// them, and B14 wrote the reason down: a slot with one
								// tab's button in it either shows on the four tabs it
								// means nothing on, or teaches the header to know
								// which tab is open and hold that tab's state. This
								// row is the list's own actions, and the state stays
								// where the form's `onStarted` already lives.
								jsx("button", {
									type: "button",
									className: "swm-ctl swm-focus",
									style: {
										...controlStyle(),
										display: "inline-flex", alignItems: "center", gap: SPACE.xs,
										border: `1px solid rgba(${TONE.accent},${TINT.ring})`,
										background: `rgba(${TONE.accent},${TINT.soft})`,
										color: `rgb(${TONE.accent})`
									},
									onClick: () => { setStartOpen(true); },
									children: [
										jsx(Icon, { name: "plus", size: ICON.xs }, "glyph"),
										jsx("span", { children: zh ? "新建任务" : "New mission" }, "label")
									]
								}, "new")
							]
						}, "toolbar"),
						state !== "error" ? null : ErrorBox({
							title: zh ? "任务列表加载失败" : "Could not load the missions",
							message: error,
							endpoint: apiBase() + "/missions/list",
							// THE SAME TICK THE TOOLBAR'S 刷新 NUDGES, deliberately. A
							// retry that re-read the list some other way would be a
							// second answer to "read the list again" a few lines from
							// the first.
							onRetry: () => { setTick((value) => value + 1); },
							zh
						}, "error"),
						state !== "loading" ? null : SkeletonScreen({
							zh,
							// The same grid the list is laid out in, so nothing moves
							// sideways when the answer lands.
							style: MISSION_LIST_GRID,
							children: [0, 1, 2].map((at) => jsxs("div", {
								style: { ...CARD_STYLE, marginBottom: 0, flexDirection: "column", gap: SPACE.sm },
								children: [
									jsxs("div", {
										style: { display: "flex", alignItems: "center", gap: SPACE.md },
										children: [
											Skeleton({ w: "58%", h: "15px" }, "topic"),
											jsx("span", { style: { flex: 1 } }, "spacer"),
											Skeleton({ w: "64px", h: "18px", r: RADIUS.pill }, "pill")
										]
									}, "head"),
									Skeleton({ w: "76%", h: "12px" }, "meta")
								]
							}, "row" + at))
						}, "loading"),
						// TWO DIFFERENT EMPTIES, two different sentences, two
						// different next steps. A chip with nothing under it is a
						// filter to undo; a library with nothing in it is waiting for
						// somebody to ask a question.
						//
						// THE COLD ARM NOW OPENS THE FORM RATHER THAN SCROLLING TO
						// IT. When the starter was a card four inches up this same
						// screen, the note said so and left the reader to go and find
						// it; the form is behind 新建任务 now, so the only honest
						// action here is the one that opens it — and the effect above
						// puts the cursor in the topic field once it has.
						state !== "ready" || missions.length > 0 ? null : EmptyBox({
							mark: filterId !== "" && known > 0 ? "search" : "sparkles",
							title: filterId !== "" && known > 0
								? (zh ? "这个筛选下没有任务。" : "No mission under this chip.")
								: (zh ? "还没有跑过任何任务。" : "No mission has been run yet."),
							note: filterId !== "" && known > 0
								? (zh ? "换成“全部”看看。" : "Try All.")
								// "在上面" IS GONE WITH THE CARD IT POINTED AT. The form
								// is behind 新建任务 now, so a sentence telling the
								// reader to look up the page describes a screen that
								// no longer exists — and this note's own button is
								// what opens it.
								: (zh ? "写一个课题，选一个档位，按“开始调研”。" : "Pick a topic, pick a tier, and press Start."),
							action: jsx("button", {
								type: "button",
								className: "swm-ctl swm-focus", style: controlStyle(),
								onClick: filterId !== "" && known > 0
									? () => { setFilterId(""); }
									// It OPENS the form now rather than scrolling to
									// it; the effect above puts the cursor in the topic
									// field once the dialog has rendered. Optional
									// chaining stays where the focus went, because this
									// module is also executed in Node, where a ref's
									// `current` stays null for ever.
									: () => { setStartOpen(true); },
								children: filterId !== "" && known > 0
									? (zh ? "清除筛选" : "Clear the filter")
									: (zh ? "去写一个课题" : "Write a topic")
							}, "cta")
						}, "empty"),
						missions.length === 0 ? null : jsxs("div", {
							children: [
								// A SECTION, not a stray sentence. The count was a 12px
								// grey line floating between the toolbar and the cards
								// with nothing beside it saying what it was counting —
								// the only heading on this screen belonged to the form
								// above it. The figure keeps its place on the right,
								// where a count belongs, and gains a subject.
								jsxs("div", {
									style: {
										display: "flex", alignItems: "baseline", justifyContent: "space-between",
										gap: SPACE.md, margin: `0 0 ${SPACE.md}`
									},
									children: [
										jsx("h2", {
											style: { font: FONT.baseStrong, margin: 0, color: INK.primary },
											children: zh ? "我的任务" : "Missions"
										}, "title"),
										jsx("span", {
											style: { font: FONT.small, color: INK.secondary },
											children: (zh ? `共 ${total} 个任务` : `${total} mission(s)`)
												+ (live.length === 0 ? "" : (zh ? ` · 本进程正在跑 ${live.length} 个` : ` · ${live.length} running in this process`))
										}, "tally")
									]
								}, "head"),
								jsx("div", { style: MISSION_LIST_GRID, children: missions.map((mission) => jsx(MissionListRow, {
									mission, zh, live: live.includes(mission.id),
									onOpen: (id) => { setOpenId(id); },
									// The list refreshes on a tick rather than through a
									// loader, so a delete nudges the tick instead of
									// calling one that does not exist.
									onRemoved: () => { setTick((value) => value + 1); }
								}, mission.id)) }, "grid")
							]
						}, "rows"),
						// LAST IN THE FRAME, not first. The scrim is fixed and
						// z-indexed so paint order is settled either way, but a
						// dialog written above the list is a dialog that reads, in
						// source and to a screen reader walking the tree, as the
						// first thing on the page — which is exactly the mistake the
						// expanded card was.
						jsx(SwarmModal, {
							open: startOpen,
							onClose: () => { setStartOpen(false); },
							zh,
							title: zh ? "新建任务" : "New mission",
							note: zh
								? "写下要调研的问题，挑一个档位 —— 档位决定这次能花多少"
								: "Write the question to research and pick a tier; the tier is what it may spend",
							children: jsx(MissionStarter, {
								zh, topicRef,
								// CLOSED, AND THEN OPENED ONTO THE RUN. Without the
								// first half the dialog is still open behind the
								// detail view, and it is what the reader comes back
								// to when they press 返回.
								onStarted: (id) => { setStartOpen(false); setOpenId(id); }
							}, "form")
						}, "starter")
					]
				})
			});
		}
		//#endregion

		//#region missions detail panels
		/**
		* A section heading that is actually a header: a rule, a count and a
		* slot for whatever the panel wants on the right.
		*
		* THREE THINGS WERE WRONG WITH IT, and they compound.
		*
		*   1. IT DROPPED THE TITLE WHEN `bare`. `bare` was meant to say "no
		*      card chrome" and was implemented as "no card chrome AND no
		*      heading", so the four panes that use it — tasks, sources,
		*      dimensions, trajectory, which are the four densest screens in the
		*      tab — each arrived as an unlabelled slab. The task board had to
		*      grow a header of its own to compensate, which is the copy this
		*      component exists to prevent. `bare` now means only what its name
		*      says.
		*   2. THE HEADER WRAPPED. `flexWrap:"wrap"` with `alignItems:"baseline"`
		*      and a `note` holding a whole sentence — "上限在建立任务时冻结，
		*      之后每个阶段都读同一行" — means that on a narrow pane the
		*      paragraph drops under the title and the header becomes three
		*      lines tall. A header must not wrap. The note is prose, so it moves
		*      out of the header entirely and becomes the first line of the body,
		*      which is where a reader looks for prose anyway.
		*   3. A COUNT WAS PROSE TOO. Six call sites buried a number in a
		*      sentence — `已核验 9 条 · 共 23 条发现` — so the one fact a person
		*      scans a panel header for was the one thing they had to read a
		*      clause to find. `count` renders as the neutral badge `COUNT_CHIP`
		*      already declares, beside the title where it is looked for.
		*
		* `accent`, `collapsible` and `defaultOpen` are NOT in this signature,
		* though the batch spec named them. No call site in this file wants any
		* of the three, and B7 already retired `dot` from `Chip` for exactly that
		* reason: a prop nobody passes is not a head start, it is the next
		* geometry, added by whoever first needs something near it.
		* @param title - the heading word. Rendered as an eyebrow, always.
		* @param count - a finite number renders as a badge; anything else renders nothing.
		* @param note - a sentence, rendered as the first line of the BODY.
		* @param action - a node for the right-hand end of the header row.
		* @param children - the panel's content.
		* @param bare - drop the card chrome, and only the card chrome.
		*/
		function MissionPanel({ title, count, note, action, children, bare }) {
			return jsxs("section", {
				// `bare` drops the CARD. A pane whose only child is a panel is a
				// border and 32px of padding spent drawing a box around the whole
				// screen; it does not drop the panel's own heading.
				style: bare === true
					? { display: "flex", flexDirection: "column", gap: SPACE.sm }
					: { ...CARD_STYLE, display: "flex", flexDirection: "column", gap: SPACE.sm, padding: SPACE.md },
				children: [
					jsxs("div", {
						// NO `flexWrap`, and `center` rather than `baseline`. Wrapping
						// is what made this three lines tall, and baseline-aligning a
						// 16px badge to an 11px eyebrow sits the badge low.
						style: {
							display: "flex", alignItems: "center", gap: SPACE.sm,
							padding: `0 0 ${SPACE.xs}`,
							borderBottom: `1px solid ${LINE.rule}`
						},
						children: [
							jsx("h3", {
								style: {
									font: FONT.smallStrong, margin: 0,
									letterSpacing: "0.04em", textTransform: "uppercase",
									color: INK.secondary,
									whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis"
								},
								children: title
							}, "title"),
							// ZERO IS A COUNT. `Number.isFinite` and not `count > 0`,
							// because the panels that survive an empty run are exactly
							// the ones whose zero is the news — 0 anomalies repaired is
							// a different statement from a panel that chose not to say.
							!Number.isFinite(count) ? null : jsx("span", {
								style: COUNT_CHIP, children: String(count)
							}, "count"),
							jsx("span", { style: { flex: 1, minWidth: SPACE.sm } }, "spacer"),
							action === undefined || action === null ? null : jsx("div", {
								style: { display: "flex", alignItems: "center", gap: SPACE.sm, flex: "none" },
								children: action
							}, "action")
						]
					}, "head"),
					jsxs("div", {
						children: [
							// THE PROSE, out of the header and into the body. It reads as
							// a lead line under the rule rather than as a caption
							// competing with the title for the same baseline.
							note === "" || note === undefined || note === null ? null : jsx("p", {
								style: { font: FONT.small, color: INK.secondary, margin: `0 0 ${SPACE.md}` },
								children: note
							}, "note"),
							jsx("div", { children }, "content")
						]
					}, "body")
				]
			});
		}


		/**
		* HOW FAR ALONG, drawn.
		*
		* `progress.percent` has been computed by the projector since the view
		* route was written — stagesResolved over stagesTotal, deliberately NOT
		* blended with the dimension and chapter fractions — and it was read by
		* nothing. The mission's entire progress display was the phrase
		* `阶段 7/12` inside a dot-joined grey string, which is a figure a person
		* has to find before they can read it.
		*
		* IT READS `percent` RATHER THAN DIVIDING AGAIN. The two integers are
		* here for the label anyway and the temptation is to compute the width
		* from them, which is a second answer to a question the projector has
		* already answered — and the projector's answer is the one the route
		* documents, the one the blend was deliberately left out of, and the one
		* that will still be right when "resolved" grows a case.
		*
		* THE HUE IS THE PILL'S. It already carries degraded-amber and
		* failed-red, so one mark says outcome and progress together — a bar that
		* picked its own three colours would be a second opinion about a state
		* the header states one line above.
		*
		* IT RECOMPUTES the ratio from stagesResolved/stagesTotal rather than
		* taking `percent`, because it needs the two integers for the label
		* anyway and `percent` is those two integers rounded. Reading both would
		* be two sources for one number, which is what this component was added
		* to end.
		*
		* NO PILL CHIP INSIDE IT, against the spec's flex row. The one mount is
		* directly under a header row that already carries that chip beside the
		* mission's title, one size up; drawing it again eight pixels lower is
		* the double-statement the tiles below were added to stop.
		* @param progress - `mission.progress` from the view route.
		* @param face - the `missionPillFace` the header already resolved.
		* @param elapsedMs - how long it has been running, for the estimate.
		* @param zh - whether to write Chinese.
		*/
		function MissionProgressBar({ progress, face, elapsedMs, zh }) {
			const total = Number(progress?.stagesTotal) || 0;
			// A run whose stage catalogue has not been read yet has NOTHING to
			// draw, and it renders as null with the reason rather than as an
			// empty track: the projector answers `percent: 0` for a mission with
			// no stages, and a 0% bar over the words 阶段 0/0 is a mission that
			// reads as stalled at the start line rather than as one whose stages
			// have not been read.
			if (total <= 0) return null;
			const resolved = Math.max(0, Math.min(total, Number(progress?.stagesResolved) || 0));
			const percent = Math.max(0, Math.min(100, Number(progress?.percent) || 0));
			const ratio = percent / 100;
			const hue = face?.hue ?? TONE.info;
			// The estimate, and only where it means something. At ratio 0 the
			// division is infinite and at ratio 1 the answer is zero, and both
			// are worse than saying nothing: "约还要 0 秒" beside a bar that is
			// full is a countdown to an event that has already happened.
			const left = ratio > 0 && ratio < 1 && Number(elapsedMs) > 0
				? missionDuration((Number(elapsedMs) / ratio) * (1 - ratio), zh)
				: "";
			return jsxs("div", {
				style: { display: "flex", flexDirection: "column", gap: SPACE.xs, margin: `0 0 ${SPACE.md}` },
				children: [
					jsxs("div", {
						style: { font: FONT.small, display: "flex", alignItems: "baseline", gap: SPACE.sm, color: INK.secondary },
						children: [
							jsx("span", {
								style: { flex: 1, minWidth: 0 },
								children: zh ? `阶段 ${resolved}/${total}` : `stages ${resolved}/${total}`
							}, "stages"),
							jsx("span", {
								style: { flex: "none", fontVariantNumeric: "tabular-nums", color: `rgb(${hue})` },
								children: `${percent}%`
							}, "percent"),
							left === "" ? null : jsx("span", {
								style: { font: FONT.micro, flex: "none", color: INK.secondary },
								children: zh ? `大约还要 ${left}` : `~${left} left`
							}, "left")
						]
					}, "head"),
					Meter({
						value: percent, tone: hue,
						role: "progressbar",
						"aria-valuenow": percent,
						"aria-valuemin": 0,
						"aria-valuemax": 100,
						"aria-label": zh ? "任务进度" : "Mission progress"
					}, "bar")
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
				style: { display: "flex", flexDirection: "column", gap: SPACE.sm },
				children: [
					jsx("div", {
						style: { display: "flex", flexDirection: "column", gap: SPACE.sm },
						children: rows.map((row) => {
							const tokens = Number(row.tokens) || 0;
							const calls = Number(row.calls) || 0;
							const missing = calls > 0 && tokens === 0;
							return jsxs("div", {
								// The raw step id where a raw step id belongs: on the hover, beside
								// the name a person reads. The strip above does the same.
								title: `${row.stepId}${(row.role ?? null) === null ? "" : ` · ${row.role}`}`,
								style: { display: "flex", flexDirection: "column", gap: SPACE.xs },
								children: [
									jsxs("div", {
										style: { font: FONT.small, display: "flex", alignItems: "baseline", gap: SPACE.sm, color: INK.secondary },
										children: [
											jsx("span", { style: { flex: 1, minWidth: 0 }, children: missionFace(MISSION_STAGE_FACES, row.stepId, zh) }, "name"),
											jsx("span", {
												style: { flex: "none", fontFamily: MONO, fontVariantNumeric: "tabular-nums", color: missing ? `rgb(${TONE.warn})` : undefined },
												children: (missing ? (zh ? "未记账" : "not billed") : (zh ? `${missionCompact(tokens)} 令牌` : `${missionCompact(tokens)} tokens`))
													+ (zh ? ` · ${calls} 次调用` : ` · ${calls} calls`)
											}, "spend")
										]
									}, "head"),
									// THE FLOOR OF 1% SURVIVES the move to the primitive: a
									// stage that spent a thousandth of the peak still spent,
									// and a bar rounded to 0% is the "not billed" state drawn
									// over a stage that WAS billed.
									//
									// The amber is solid now rather than `rgba(warn, ring)`.
									// That 28% was doing the track's job — separating the fill
									// from the ground — and TRACK does it properly, in both
									// themes, so the tint was only making the one bar that
									// reports a defect the faintest bar on the pane.
									Meter({
										value: peak === 0 ? 0 : Math.max(1, Math.round((tokens / peak) * 100)),
										tone: missing ? TONE.warn : TONE.info
									}, "bar")
								]
							}, row.stepId);
						})
					}, "rows"),
					unbilled.length === 0 ? null : jsx("div", {
						style: { font: FONT.micro, color: `rgb(${TONE.warn})` },
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
			// EVERY COLUMN DECLARES A WIDTH, which is the half of the clipping
			// fix that is not the scroller. Without `tableLayout:"fixed"` the
			// browser resolves the table to its content's min-content width, and
			// inside an `overflow:hidden` frame that means a long tool id pushes
			// the mean-latency column off the right edge of the card and takes it
			// with it — no scrollbar, no ellipsis, just a column that is not
			// there. The task board avoided this from the start by declaring
			// percentages; this table never did.
			const columns = [
				{ id: "tool", label: zh ? "工具" : "Tool", width: "30%", align: "left" },
				{ id: "calls", label: zh ? "调用" : "Calls", width: "12%", align: "right" },
				{ id: "failures", label: zh ? "失败" : "Failed", width: "12%", align: "right" },
				{ id: "rate", label: zh ? "成功率" : "Success", width: "18%", align: "right" },
				{ id: "cached", label: zh ? "缓存" : "Cached", width: "12%", align: "right" },
				{ id: "latency", label: zh ? "平均延迟" : "Mean latency", width: "16%", align: "right" }
			];
			return jsx("div", {
				// TWO BOXES, not one, and all three tables now have the same two.
				// The frame owns the rounded corner, so it must clip; a scroller
				// that clips cannot scroll. Putting the overflow on one element
				// makes the two requirements the same property, and the corner
				// wins silently.
				style: {
					border: `1px solid ${LINE.rule}`, borderRadius: RADIUS.md,
					overflow: "hidden", background: "var(--dsw-alias-bg-layer-1)"
				},
				children: jsx("div", {
					style: { overflowX: "auto" },
					children: jsxs("table", {
					style: { width: "100%", minWidth: "560px", borderCollapse: "collapse", tableLayout: "fixed" },
					children: [
						jsx("thead", {
							children: jsx("tr", {
								style: { borderBottom: `1px solid ${LINE.rule}` },
								children: columns.map((column) => jsx("th", {
									style: { ...TH, width: column.width, textAlign: column.align },
									children: column.label
								}, column.id))
							})
						}, "head"),
						jsx("tbody", {
							children: rows.map((row) => {
								const calls = Number(row.calls) || 0;
								const failures = Number(row.failures) || 0;
								const unmeasured = Number(row.unmeasured) || 0;
								// NULL, NOT ZERO, for a tool nobody called. `calls === 0`
								// through the arithmetic is a division by nought; through
								// `?? 0` it is a 0% bar, which draws a door that has never
								// been opened as a door that fails every time.
								const pct = calls === 0 ? null : Math.round(((calls - failures) / calls) * 100);
								// The SAME two thresholds the trajectory's duration column
								// reads, from the same two names. A mean is not a call, so
								// a tool whose average is over ten seconds is not one slow
								// call — it is the door itself.
								const mean = row.avgLatencyMs === null || row.avgLatencyMs === undefined
									? null : Number(row.avgLatencyMs);
								const latency = row.avgLatencyMs === null || row.avgLatencyMs === undefined
									? (zh ? "未测量" : "not measured")
									: `${row.avgLatencyMs}ms` + (unmeasured > 0
										? (zh ? ` · ${unmeasured} 次未测量` : ` · ${unmeasured} not measured`)
										: "");
								return jsxs("tr", {
									className: "swm-tr",
									children: [
										// THE SUBJECT OF THE TABLE, drawn as one. Every other cell
										// in this row is a figure and this one is a name, and as a
										// bare mono slug it read as the smallest thing on the line.
										jsx("td", { style: TD, children: ToolChip({ toolId: row.tool, zh }) ?? "—" }, "tool"),
										jsx("td", { style: { ...TD, textAlign: "right" }, children: String(calls) }, "calls"),
										jsx("td", {
											style: { ...TD, textAlign: "right", color: failures > 0 ? `rgb(${TONE.danger})` : INK.primary },
											children: String(failures)
										}, "failures"),
										// A SHARE, DRAWN AS A SHARE. It was the string "92%",
										// right-aligned in the same grey as the count beside it,
										// which makes "which door is failing" a question you
										// answer by reading six numbers and holding them in your
										// head. The bar answers it at a glance and the figure
										// stays for the reader who needs the exact value; the
										// grading is the same three-band ladder the latency
										// column two cells along already uses.
										jsx("td", {
											style: { ...TD, textAlign: "right" },
											// A tool with no calls keeps the em dash and gets NO
											// bar. An empty track reads as 0% — the one reading
											// that is certainly wrong about a door nobody opened.
											children: pct === null ? "—" : jsxs("div", {
												style: {
													display: "flex", alignItems: "center",
													justifyContent: "flex-end", gap: SPACE.xs
												},
												children: [
													// THE FIFTH TRACK, which the batch spec counted as
													// four because this one was drawn a batch later —
													// same shape, same `LINE.rule` fill, same defect on
													// the dark theme. A `div` rather than the `span`
													// pair it was, because `Meter` is a div and
													// phrasing content is not allowed to hold flow
													// content; a `td` is happy with either.
													Meter({
														value: pct,
														tone: pct >= 90 ? TONE.success : pct >= 60 ? TONE.warn : TONE.danger,
														style: { width: "56px", flex: "none" }
													}, "track"),
													// A FIXED-WIDTH FIGURE. Without it the bars step
													// left and right by a digit between rows and the
													// column stops being a column.
													jsx("span", {
														style: { width: "34px", flex: "none", textAlign: "right" },
														children: `${pct}%`
													}, "n")
												]
											})
										}, "rate"),
										jsx("td", { style: { ...TD, textAlign: "right" }, children: String(Number(row.cached) || 0) }, "cached"),
										jsx("td", {
											style: {
												...TD, textAlign: "right",
												// The unmeasured branch SURVIVES the banding: a
												// partial mean is amber whatever it says, because
												// the figure is being computed over fewer calls
												// than the row counts and that is a caveat about
												// the number rather than a reading of it.
												color: mean !== null && mean >= MISSION_SLOW_MS
													? `rgb(${TONE.danger})`
													: (unmeasured > 0 || (mean !== null && mean >= MISSION_WARN_MS))
													? `rgb(${TONE.warn})`
													: INK.primary
											},
											children: latency
										}, "latency")
									]
								}, String(row.tool));
							})
						}, "body")
					]
					})
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
			// THE FIVE REWORK COUNTERS ARE NOT HERE ANY MORE. They were built into
			// one dot-joined grey sentence — five figures welded into prose, in the
			// same weight as the caption under a meter — and they are a panel of
			// their own now; see MissionRework.
			return jsxs("div", {
				style: { display: "flex", flexDirection: "column", gap: SPACE.md },
				children: [
					jsx("div", {
						style: { display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))", gap: SPACE.md },
						children: order.map((key) => {
							const meter = cost[key] ?? { dimension: key, used: 0, limit: null, ratio: null };
							const ratio = meter.ratio ?? 0;
							// The ladder the Host half froze, passed through on the
							// cost object. Reading a second copy of 0.70 / 0.85 here
							// is how the meter and the degrade steps start disagreeing
							// — which is why the ternary that used to sit inline is now
							// `missionLadderHue`, shared with the header's token tile.
							const hue = missionLadderHue(ratio, cost.ladder);
							const tight = cost.tight?.dimension === key;
							return jsxs("div", {
								style: { display: "flex", flexDirection: "column", gap: SPACE.xs },
								children: [
									jsxs("div", {
										style: { font: FONT.small, display: "flex", alignItems: "baseline", gap: SPACE.sm, color: INK.secondary },
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
									Meter({ value: ratio * 100, tone: hue }, "bar"),
									jsx("div", {
										style: { font: FONT.micro, color: INK.secondary },
										children: missionMeterLine(meter, zh)
									}, "line")
								]
							}, key);
						})
					}, "meters"),
					// Two quantities, reported as a disagreement rather than
					// reconciled into whichever one is to hand. The exact figure is
					// the ledger; the estimate is what the live pool was steering by.
					cost.drift?.exceeds !== true ? null : jsx("div", {
						style: { font: FONT.small, color: `rgb(${TONE.warn})` },
						children: zh
							? `预估用量与实际账本相差 ${Math.round((cost.drift.ratio ?? 0) * 100)}%（预估 ${cost.drift.estimated}，实际 ${cost.drift.exact}），超过 ${Math.round((cost.drift.tolerance ?? 0) * 100)}% 的容差 —— 运行中的预算表是估算，账本才是准的。`
							: `The live estimate and the ledger differ by ${Math.round((cost.drift.ratio ?? 0) * 100)}% (estimated ${cost.drift.estimated}, exact ${cost.drift.exact}), past the ${Math.round((cost.drift.tolerance ?? 0) * 100)}% tolerance. The meter is an estimate; the ledger is the truth.`
					}, "drift")
				]
			});
		}

		/**
		* What this run spent twice.
		*
		* IT WAS A SENTENCE, and a sentence is the wrong shape for five counters:
		* 阶段重试 2 次 · 章节重写 1 次 · 命中缓存 40 次 is three figures a reader
		* has to parse out of punctuation, in the tertiary grey that means "you
		* may skip this" — under a row of meters that are nothing but figures.
		*
		* TWO CORRECTIONS COME WITH THE SHAPE.
		*
		* A CACHE HIT IS A SAVING. `toolCached` was the fifth phrase in a list of
		* four failures, so a run that avoided forty fetches read as a run that
		* went wrong forty times. It is the one green counter here.
		*
		* AND ZERO REWORK IS AN ANSWER. The sentence rendered nothing at all when
		* every counter was nought, which is the same blank space as a mission
		* whose waste data never arrived — so the cleanest run this pipeline can
		* produce had exactly as much to say for itself as a broken projection.
		* @param waste - `cost.waste`, or null on an older Host half.
		* @param zh - whether to write Chinese.
		*/
		function MissionRework({ waste, zh }) {
			const counts = waste ?? {};
			const n = (key) => Number(counts[key] ?? 0);
			// ONLY THE NON-ZERO ONES, the same rule the dimension card's chapter
			// chips follow: five tiles reading 0 on every healthy run is five tiles
			// saying nothing happened, which is what the absence already says.
			const cells = [
				{
					id: "stageRetries", n: n("stageRetries"), tone: TONE.warn,
					label: zh ? "阶段重试" : "Stage retries",
					hint: zh ? "整步重跑" : "whole steps re-run"
				},
				{
					id: "chapterRewrites", n: n("chapterRewrites"), tone: TONE.warn,
					label: zh ? "章节重写" : "Chapter rewrites",
					hint: zh ? "写了不止一遍" : "written more than once"
				},
				{
					id: "underDeliveredChapters", n: n("underDeliveredChapters"), tone: TONE.warn,
					label: zh ? "字数不足" : "Under length",
					hint: zh ? "没写到约定字数" : "short of the agreed length"
				},
				{
					id: "toolFailures", n: n("toolFailures"), tone: TONE.danger,
					label: zh ? "工具失败" : "Tool failures",
					hint: zh ? "花了额度，没拿到东西" : "spent the allowance, returned nothing"
				},
				{
					// GREEN, and this is the correction. A cache hit did not cost a
					// fetch — it is the only line here that made the run cheaper.
					id: "toolCached", n: n("toolCached"), tone: TONE.success,
					label: zh ? "命中缓存" : "Cache hits",
					hint: zh ? "省下的调用" : "calls that were saved"
				}
			].filter((cell) => cell.n > 0);

			if (cells.length === 0) {
				// The clean bill, SAID. Stated as the five counters it is derived
				// from rather than as a verdict, because "no rework" on a mission
				// that has not started yet is true of the counters and not of the
				// run — and the hint is what keeps those two readings apart.
				return MissionStatTiles({ tiles: [{
					label: zh ? "返工" : "Rework",
					value: "0",
					tone: TONE.success,
					hint: zh ? "没有重试、重写或失败的调用" : "no retries, rewrites or failed calls"
				}] }, "clean");
			}
			return MissionStatTiles({
				tiles: cells.map((cell) => ({ label: cell.label, value: String(cell.n), tone: cell.tone, hint: cell.hint }))
			}, "rework");
		}

		/**
		* What the Leader set out to do, in the Leader's own words.
		*
		* `goals` has been projected onto every mission for as long as the view
		* route has existed and READ BY NOTHING — `grep goals lib/client.js`
		* returned zero before this. It is the brief: the thing every stage under
		* it is being judged against, and the screen showed the judging and not
		* the brief.
		*
		* ITERATED, NEVER NAMED. The shape is `parseJson(row.goals, null)` — it is
		* whatever the Leader wrote — so naming keys here would render exactly the
		* three this file happened to see once and silently drop the fourth. An
		* array is a list, a sentence is a sentence, and anything else is printed
		* as the JSON it is rather than as `[object Object]`.
		* @param goals - `mission.goals`.
		* @param zh - whether to write Chinese.
		*/
		function MissionGoals({ goals, zh }) {
			if (typeof goals !== "object" || goals === null) return null;
			const entries = Object.entries(goals)
				.filter(([, value]) => value !== null && value !== undefined && value !== "" && !(Array.isArray(value) && value.length === 0));
			if (entries.length === 0) return null;
			return jsxs("div", {
				style: { display: "flex", flexDirection: "column", gap: SPACE.md },
				children: entries.map(([name, value]) => jsxs("div", {
					style: { display: "flex", flexDirection: "column", gap: SPACE.xs },
					children: [
						// THE KEY, VERBATIM. A lookup table would translate the three
						// keys somebody once saw and leave the rest raw, which is worse
						// than raw everywhere: it makes the untranslated ones look like
						// a bug rather than like the Leader's own vocabulary.
						jsx("div", {
							style: { font: FONT.micro, letterSpacing: "0.04em", textTransform: "uppercase", color: INK.secondary },
							children: name
						}, "key"),
						Array.isArray(value)
							? jsx("ul", {
								style: { margin: 0, padding: 0, listStyle: "none", display: "flex", flexDirection: "column", gap: SPACE.xs },
								children: value.map((item, at) => jsxs("li", {
									style: { font: FONT.small, display: "flex", gap: SPACE.sm, color: INK.primary },
									children: [
										jsx("span", {
											style: {
												flex: "none", width: "4px", height: "4px", marginTop: "7px",
												borderRadius: RADIUS.circle, background: `rgb(${TONE.accent})`
											}
										}, "dot"),
										jsx("span", { style: { minWidth: 0 }, children: linkify(String(item), `g${at}-`) }, "text")
									]
								}, `i${at}`))
							}, "list")
							: jsx("div", {
								style: { font: FONT.small, color: INK.primary },
								// Clamped, because a goal is a sentence somebody wrote to
								// be read and sometimes a paragraph somebody wrote to be
								// thorough.
								children: jsx(MissionClamp, {
									text: typeof value === "object" ? JSON.stringify(value) : String(value),
									lines: 3, zh
								})
							}, "value")
					]
				}, name))
			});
		}

		/**
		* Whether anybody put their name to this.
		*
		* THE MOST CONSEQUENTIAL LINE ON THE SCREEN WAS THE SAME GREY SENTENCE AS
		* THE LEAST. Sign-off sat between the failure note and the no-artefact
		* note, all three 13px `label-primary` prose — so "the Leader read this
		* report and refused to sign it" had the visual weight of "no report yet".
		*
		* THE THREE-WAY GUARD IS UNCHANGED and lives at the call site: `null`
		* means s11 never ran, and a run that was never judged must not be handed
		* a verdict card at all — an unsigned report and a refused one are
		* different failures with different next actions.
		* @param mission - the projected mission.
		* @param zh - whether to write Chinese.
		*/
		function MissionSignoffCard({ mission, zh }) {
			const score = Number(mission.score);
			const scored = Number.isFinite(score);
			// A refusal is red whatever it scored. A signature is green only if the
			// score backs it up: `signed: true` at 44 is a signature on a report
			// the Leader itself graded badly, and drawing that green would be this
			// screen endorsing something nobody endorsed.
			const hue = mission.signed === false ? TONE.danger : scored && score >= 80 ? TONE.success : TONE.warn;
			return jsxs("div", {
				style: {
					display: "flex", alignItems: "center", gap: SPACE.md,
					padding: "10px 12px", borderRadius: RADIUS.lg,
					border: `1px solid rgba(${hue},${TINT.ring})`, background: `rgba(${hue},${TINT.soft})`,
					margin: `0 0 ${SPACE.md}`
				},
				children: [
					jsx("span", {
						style: { font: FONT.title, flex: "none", display: "flex", color: `rgb(${hue})` },
						children: jsx(Icon, { name: mission.signed ? "check" : "close", size: ICON.md })
					}, "mark"),
					jsx("span", {
						// THE SCORE IS NOT IN THE SENTENCE ANY MORE. It was 评分 88 in
						// the prose and it is a 20px figure four inches to the right;
						// the same figure twice in one row is the reader checking
						// whether they are the same figure. The verdict — the Leader's
						// own word for it — stays in the sentence, because it is the
						// only place it appears at all.
						style: { font: FONT.body, flex: 1, minWidth: 0, color: INK.primary },
						children: mission.signed
							? (zh ? `领队已签署${(mission.verdict ?? "") === "" ? "" : `（${mission.verdict}）`}。` : `Signed off by the leader${(mission.verdict ?? "") === "" ? "" : ` (${mission.verdict})`}.`)
							: (zh ? "领队读过报告后拒绝签署。报告仍然可读。" : "The leader read the report and declined to sign it. The report is still readable.")
					}, "words"),
					jsxs("span", {
						style: { flex: "none", display: "flex", flexDirection: "column", alignItems: "flex-end" },
						children: [
							jsx("span", {
								style: { font: FONT.title, fontFamily: MONO, fontVariantNumeric: "tabular-nums", color: `rgb(${hue})` },
								// The file's own em dash for "not measured". `score ?? 0`
								// here would hand a run nobody graded a zero it never got.
								children: scored ? String(score) : "—"
							}, "n"),
							jsx("span", { style: { font: FONT.micro, color: INK.quiet }, children: "/100" }, "of")
						]
					}, "score")
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
				style: { display: "flex", flexDirection: "column", gap: SPACE.md },
				children: [
					report.why === "" ? null : jsx("div", {
						style: { font: FONT.body, color: INK.primary },
						// The evidence gate's own sentence. Reused rather than
						// re-worded: two wordings of one refusal is the same defect
						// as two names for one method. Three lines, because it is the
						// first thing on this panel and the diagnostics under it are
						// what the panel is for.
						children: jsx(MissionClamp, { text: report.why, lines: 3, zh })
					}, "why"),
					diagnostics === null ? jsx("div", {
						style: { font: FONT.small, color: INK.secondary },
						children: zh
							? "这次运行没有留下采集诊断，或者它已经滚出了事件尾部。事件是完整存着的：用 /events?since=0 可以从头读。"
							: "No collection diagnostics were recorded for this run, or they have scrolled out of the event tail. The log itself is complete — read it from the beginning with /events?since=0."
					}, "none") : null,
					typeof diagnostics?.unavailable === "string" ? jsx("div", {
						style: { font: FONT.small, color: `rgb(${TONE.warn})` },
						children: (zh ? "采集诊断本身失败了：" : "The diagnostics query itself failed: ") + diagnostics.unavailable
					}, "unavailable") : null,
					toolRows.length === 0 ? null : jsxs("div", {
						children: [
							jsx("div", {
								style: { font: FONT.smallStrong, marginBottom: "4px", color: INK.primary },
								children: zh ? "调用过的工具" : "Tools called"
							}, "head"),
							jsx("div", {
								style: { display: "flex", flexWrap: "wrap", gap: SPACE.sm },
								// The tool is the subject and the calls are the count, so
								// the two stop being one run-on string. The tone follows
								// the tally: a tool that failed at all is the reason
								// anybody opens this block.
								children: toolRows.map(([tool, tally]) => Chip({
									tone: tally.failed > 0 ? TONE.warn : TONE.neutral,
									label: tool,
									count: zh
										? `${tally.calls} 次 · 成功 ${tally.ok} · 失败 ${tally.failed}`
										: `${tally.calls} · ${tally.ok} ok · ${tally.failed} failed`
								}, tool))
							}, "tools")
						]
					}, "toolBlock"),
					hosts.length === 0 ? null : jsx("div", {
						style: { font: FONT.small, color: INK.secondary },
						children: (zh ? "已核验证据来自这些站点：" : "Verified evidence came from these hosts: ") + hosts.join("、")
					}, "hosts"),
					findings.length === 0 ? null : jsx("div", {
						style: { font: FONT.small, color: INK.secondary },
						children: (zh ? "写下来的发现按核验结果分：" : "Recorded findings by verify state: ")
							+ findings.map((row) => `${row.label} ${row.n}`).join(" · ")
					}, "findings"),
					failed.length === 0 ? null : jsxs("div", {
						children: [
							jsx("div", {
								style: { font: FONT.smallStrong, marginBottom: "4px", color: INK.primary },
								children: zh ? `失败或被拒绝的工具调用（最近 ${failed.length} 条）` : `Tool calls that failed or were refused (latest ${failed.length})`
							}, "head"),
							jsx("div", {
								style: { display: "flex", flexDirection: "column", gap: SPACE.xs },
								// THE TOOL COMES OUT OF THE SENTENCE. It was the middle term of
								// a five-part join, which is the one word a reader scanning a
								// failure list is actually looking for — "is it always fetch?"
								// — and a join cannot be scanned. The rest stays a sentence,
								// because the rest is context and not a category.
								children: failed.map((row, at) => jsxs("div", {
									style: { font: FONT.small, display: "flex", alignItems: "center", gap: SPACE.sm, color: INK.secondary },
									children: [
										ToolChip({ toolId: row.tool, zh }, "tool"),
										jsx("span", {
											style: { minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" },
											children: `${formatStamp(row.at)} · ${missionFace(MISSION_STAGE_FACES, row.stepId, zh)}`
												+ (row.paceKey === null || row.paceKey === undefined ? "" : ` · ${row.paceKey}`)
												+ ` · ${row.errorCode ?? (zh ? "未记录错误码" : "no error code recorded")}`
										}, "rest")
									]
								}, `${row.tool}-${row.at}-${at}`))
							}, "list"),
							jsx("div", {
								style: { font: FONT.micro, marginTop: "6px", color: INK.secondary },
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
		*
		* WHERE THIS IS SEEN, which is worth knowing before deciding how much it
		* deserves: exactly one mount, the trajectory's ERROR FALLBACK. When the
		* trace route answers and this component never renders. When it does
		* render, the richest screen in the tab has just failed and this log is
		* the only account of the run a person has left — which is an argument
		* for more care here, not less. It also means nothing else in the tab
		* becomes tonal because this did: the trajectory's own rows are coloured
		* by MISSION_ROLE_FACES at their own call site.
		* @param timeline - `timeline` from the view route.
		* @param zh - whether to write Chinese.
		*/
		function MissionTimeline({ timeline, zh }) {
			const events = Array.isArray(timeline?.events) ? timeline.events : [];
			const shown = events.slice(-60).reverse();
			// The zero this stream measures against is the earliest event IT HOLDS,
			// which on a long run is the start of the window and not the start of
			// the mission. Said here rather than silently: the view route hands
			// over a tail, and an offset computed against a tail is honest about
			// distance between rows and makes no claim about distance from s1.
			const anchor = events.length === 0 ? null : events[0].ts;
			if (shown.length === 0) {
				return jsx("div", {
					style: { font: FONT.small, color: INK.secondary },
					children: zh ? "这一段窗口里还没有事件。" : "No events in this window yet."
				});
			}
			return jsxs("div", {
				style: { display: "flex", flexDirection: "column", gap: SPACE.sm },
				children: [
					// HOW MUCH THERE IS, above how much is shown. The window is
					// bounded at sixty and said nothing about it, so a run with four
					// hundred events and a run with sixty looked identical — and the
					// difference is whether the line you are looking for is missing
					// or simply never happened.
					jsx("div", {
						style: { font: FONT.micro, color: INK.quiet },
						children: events.length > shown.length
							? (zh ? `共 ${events.length} 条 · 显示最近 ${shown.length} 条` : `${events.length} events · showing the last ${shown.length}`)
							: (zh ? `共 ${events.length} 条` : `${events.length} event(s)`)
					}, "tally"),
					jsx("div", {
						// The rail and its dots are what turn a list of lines into a
						// stream you can read the shape of: five amber dots in a row
						// is a stalling run, visible before a single word is read.
						// The line itself is a `::before`, which is why the class
						// carries it rather than a style object.
						className: "swm-rail",
						style: { display: "flex", flexDirection: "column", gap: SPACE.xs },
						children: shown.map((event) => {
							const hue = missionHue(MISSION_EVENT_FACES, event.type);
							const detail = missionEventDetail(event, zh);
							return jsxs("div", {
								className: "swm-ev",
								style: { font: FONT.small, background: `rgba(${hue},${TINT.soft})`, color: INK.secondary },
								children: [
									jsx("span", {
										style: {
											position: "absolute", left: "-16px", top: "9px",
											width: "7px", height: "7px", flex: "none",
											borderRadius: RADIUS.circle, background: `rgb(${hue})`
										}
									}, "dot"),
									// THE CLOCK, NOT THE STAMP. `formatStamp` prints to the
									// minute, and a tail is read at the moment six things
									// happened inside one minute — where a column of
									// identical stamps says nothing about which came
									// first. The date is not lost, it is on the hover.
									jsxs("span", {
										title: formatStamp(event.ts),
										style: {
											font: FONT.micro, fontFamily: MONO, fontVariantNumeric: "tabular-nums",
											flex: "none", width: "64px", textAlign: "right", color: INK.quiet,
											display: "flex", flexDirection: "column"
										},
										children: [
											// The same two lines the trajectory row draws, in the
											// same order, because this stream is the fallback that
											// renders when the trajectory cannot be read — and a
											// fallback that reorders the facts is a second screen
											// to learn at the worst possible moment.
											jsx("span", { children: missionSince(event.ts, anchor, zh) }, "since"),
											jsx("span", { style: { opacity: OPACITY.quiet }, children: missionClock(event.ts) }, "clock")
										]
									}, "at"),
									jsx("span", {
										style: { font: FONT.smallStrong, flex: "none", color: `rgb(${hue})` },
										children: missionFace(MISSION_EVENT_FACES, event.type, zh)
									}, "type"),
									// ONE LINE, with the whole of it on the hover. The
									// detail used to wrap, so a single event carrying a
									// long refusal reason pushed every row under it down
									// the page and the stream stopped being scannable at
									// the exact moment it mattered most.
									detail === "" ? null : jsx("span", {
										title: detail,
										style: { flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" },
										children: detail
									}, "detail")
								]
							}, String(event.seq));
						})
					}, "rail")
				]
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
		* And how much of it the STAGE DRAWER asks for.
		*
		* Twenty, not a hundred and twenty: the drawer is a 320px column beside a
		* board, and it is answering "what did this step do" rather than "show me
		* everything". The route caps and orders the slice, so the twenty are the
		* first twenty of the step, and the jump button under them opens the same
		* rows in the pane that is built to hold four hundred.
		*/
		const MISSION_STAGE_TRACE_TAKE = 20;

		/**
		* When a duration stops being a figure and starts being the answer.
		*
		* TWO NAMES, NOT TWO NUMBERS PER SITE. The trajectory's trailing column
		* and the tool table's mean latency both answer "which door is slow", and
		* both drew every duration in the same tertiary grey — a 12-second call
		* and a 4ms one rendered identically, in the column that exists to tell
		* them apart. Banding them each against a number typed at its own call
		* site is how two screens end up disagreeing about what slow means, which
		* is worse than neither of them saying.
		*
		* 3s is where a person notices a wait; 10s is where a tool call is
		* usually a retry, a rate limit or a hang rather than work. Both are
		* thresholds for DRAWING, never for behaviour: nothing here retries,
		* fails or refuses on them.
		*/
		const MISSION_WARN_MS = 3000;
		const MISSION_SLOW_MS = 10000;

		/**
		* How many findings one dimension shows before it says there are more.
		*
		* Bounded because a `deep` mission's dimension can hold hundreds and this
		* list lives inside a card. The route's `hasMore` is printed rather than
		* hidden, so a truncated list reads as truncated instead of complete.
		*/
		const MISSION_FINDINGS_TAKE = 50;

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
			STAGE: { zh: "阶段", en: "STAGE", hue: TONE.info },
			TOOL: { zh: "工具", en: "TOOL", hue: TONE.accent },
			EVIDENCE: { zh: "证据", en: "EVIDENCE", hue: TONE.success },
			GATE: { zh: "闸门", en: "GATE", hue: TONE.warn },
			SYSTEM: { zh: "系统", en: "SYSTEM", hue: TONE.neutral }
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
			{ id: "", zh: "全部记录", en: "All rows", hue: TONE.neutral },
			{ id: "stage", zh: "阶段", en: "Stages", hue: TONE.info },
			{ id: "tool", zh: "工具", en: "Tools", hue: TONE.accent },
			{ id: "finding", zh: "发现", en: "Findings", hue: TONE.success },
			{ id: "event", zh: "事件", en: "Events", hue: TONE.warn }
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
		* How far into the run this happened.
		*
		* WALL-CLOCK ANSWERS A DIFFERENT QUESTION. `14:02:11` is what you need to
		* line a row up against a log on another machine; what a person reading a
		* trajectory wants is "the collect stage started four minutes in and the
		* fetch that hung came eleven minutes after that", and getting there from
		* a column of absolute stamps is subtraction done by hand, once per row.
		*
		* Same guard style as `missionClock` and `missionLatency`: an instant that
		* will not parse is "" rather than `NaN`. So is a NEGATIVE offset, and
		* that branch is the load-bearing one — a row recorded before the anchor
		* is not "-3s into the run", it is a row whose anchor is wrong, and a
		* minus sign would present a broken anchor as a measurement.
		* @param iso - the instant.
		* @param anchorIso - the run's own zero.
		* @param zh - whether to write Chinese.
		* @returns `+2m 14s`, or "" when either end is missing.
		*/
		function missionSince(iso, anchorIso, zh) {
			const at = Date.parse(iso);
			const zero = Date.parse(anchorIso);
			if (Number.isNaN(at) || Number.isNaN(zero)) return "";
			const ms = at - zero;
			if (ms < 0) return "";
			// Sub-second, for the same reason missionLatency exists: a dozen tool
			// calls inside one second are a dozen rows reading `+0s` otherwise.
			if (ms < 1000) return `+${Math.round(ms)}ms`;
			const seconds = Math.round(ms / 1000);
			if (seconds < 60) return `+${seconds}s`;
			const minutes = Math.floor(seconds / 60);
			return zh ? `+${minutes} 分 ${seconds % 60} 秒` : `+${minutes}m ${seconds % 60}s`;
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
			if (ok === true) return { mark: "✓", hue: TONE.success, label: zh ? "通过" : "Passed" };
			if (ok === false) return { mark: "✗", hue: TONE.danger, label: zh ? "未通过" : "Failed" };
			return { mark: "·", hue: TONE.neutral, label: zh ? "没有判定" : "No verdict was recorded" };
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
			`.swt-row{display:flex;align-items:center;box-sizing:border-box;height:38px;padding:0 8px 0 10px;gap:12px;border-radius:8px;border:1px solid ${LINE.rule};background:var(--dsw-alias-bg-layer-3);min-width:0;width:100%;appearance:none;font:inherit;text-align:left;cursor:pointer;color:var(--dsw-alias-label-primary)}`,
			".swt-row:hover{background:var(--dsw-alias-interactive-bg-hover)}",
			'.swt-row[aria-pressed="true"]{border-color:transparent;box-shadow:inset 0 0 0 2px var(--dsw-alias-state-business-primary)}',
			".swt-row:focus-visible{outline:1px solid var(--dsw-alias-state-business-primary);outline-offset:-1px}",
			".swt-idx{flex:none;width:24px;font:var(--dsw-font-xs-13);font-variant-numeric:tabular-nums;color:var(--dsw-alias-label-tertiary)}",
			// TWO LINES IN THE SAME SLOT: the offset from the run's start over
			// the wall clock. 58px held one `14:02:11`; `+11m 4s` needs the extra
			// six. The line-height comes AFTER the `font` shorthand, which sets
			// one of its own — written before it, it is silently discarded and the
			// two lines sit 32px apart in a 38px row.
			".swt-clock{flex:none;width:64px;display:flex;flex-direction:column;justify-content:center;font:11px/16px var(--ds-font-family-code,monospace);line-height:13px;font-variant-numeric:tabular-nums;color:var(--dsw-alias-label-tertiary)}",
			// 96px, up from 64. The slot now carries TWO marks — what kind of record
			// this is, and who made it — because either one alone answers half of
			// what a person scanning a hundred rows is asking.
			".swt-tagslot{flex:none;width:96px;display:flex;align-items:center;gap:4px;min-width:0}",
			// THE GEOMETRY IS THE CHIP'S; THE COLOUR NOW IS TOO. This kept the
			// harness's state-token pairs for one batch longer than the rest of the
			// file, on the argument that `missionTagFace` chose them deliberately.
			// It did — and what it chose them BY was `row.ok` and `row.kind`, so
			// every row on the densest screen in the tab was one of four colours
			// and the tag repeated in colour what its own word already said. It is
			// tinted from MISSION_ROLE_FACES's `hue` at the call site now, which
			// the table has carried since it was written and nothing ever read.
			// It ELLIPSISES now, because it is no longer alone in the slot. A tag that
			// only shrank would push the role mark past the slot's right edge and
			// into the name column — and the mark is fixed-width, so it is the tag
			// that has to give. EVIDENCE is the long one and it fits; a longer role
			// word added later clips instead of breaking the row.
			`.swt-tag{display:inline-flex;align-items:center;box-sizing:border-box;height:22px;min-width:0;max-width:100%;padding:0 6px;border-radius:${RADIUS.sm};font:${FONT.microStrong};white-space:nowrap;overflow:hidden;text-overflow:ellipsis}`,
			".swt-title{flex:none;width:132px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font:500 12px/16px var(--ds-font-family-code,monospace);color:var(--dsw-alias-label-primary)}",
			".swt-text{flex:2 1 0;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font:var(--dsw-font-xs-13);color:var(--dsw-alias-label-secondary)}",
			".swt-arrow{flex:none;color:var(--dsw-alias-label-caption)}",
			".swt-res{flex:1 1 0;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font:var(--dsw-font-xs-13);color:var(--dsw-alias-label-secondary)}",
			".swt-trail{flex:none;display:flex;align-items:center;justify-content:flex-end;width:72px;min-width:0}",
			".swt-metric{flex:none;width:69px;text-align:right;font:var(--dsw-font-xs-13);font-variant-numeric:tabular-nums;color:var(--dsw-alias-label-tertiary);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}",
			`.swt-band{flex:none;border:1px solid ${LINE.rule};border-radius:8px;overflow:hidden;user-select:none;margin-bottom:10px}`,
			".swt-plot{display:grid;grid-template-columns:44px minmax(0,1fr);height:50px;overflow:hidden;background:var(--dsw-alias-bg-layer-2)}",
			`.swt-lanelabels{position:relative;border-right:1px solid ${LINE.rule};color:var(--dsw-alias-label-caption);font-size:10px;line-height:1}`,
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
			`.swt-wrap{display:flex;align-items:stretch;border:1px solid ${LINE.rule};border-radius:10px;overflow:hidden;background:var(--dsw-alias-bg-layer-1)}`,
			".swt-list{flex:1 1 0;min-width:0;display:flex;flex-direction:column;gap:2px;padding:8px}",
			`.swt-pane{position:relative;display:flex;flex:none;flex-direction:column;width:clamp(300px,32%,392px);min-width:0;min-height:0;border-left:1px solid ${LINE.rule};background:var(--dsw-alias-bg-layer-1)}`,
			`.swt-panehead{display:flex;flex:none;align-items:center;justify-content:space-between;box-sizing:border-box;height:42px;padding:0 8px 0 12px;border-bottom:1px solid ${LINE.rule};gap:8px}`,
			".swt-panetitle{display:flex;align-items:center;min-width:0;gap:8px;color:var(--dsw-alias-label-primary)}",
			".swt-dot{flex:none;width:5px;height:5px;border-radius:50%;background:var(--dsw-alias-label-secondary)}",
			".swt-panename{flex:none;font:500 12px/16px var(--ds-font-family-code,monospace)}",
			".swt-paneref{min-width:0;overflow:hidden;color:var(--dsw-alias-label-tertiary);font:11px/16px var(--ds-font-family-code,monospace);text-overflow:ellipsis;white-space:nowrap}",
			`.swt-tabs{display:flex;flex:none;box-sizing:border-box;width:100%;height:34px;padding:0 8px;overflow-x:auto;overflow-y:hidden;gap:1px;border-bottom:1px solid ${LINE.rule};white-space:nowrap;scrollbar-width:none}`,
			".swt-tabs::-webkit-scrollbar{display:none}",
			// `.swt-tab` IS GONE AND IS NOW `.swm-tab`, on SWM_RULES. The rules
			// were complete and they were on the wrong sheet: this one mounts
			// only when the trace pane opens, so the two OTHER tab strips in this
			// product could not wear them without being unstyled until somebody
			// happened to open a trajectory. The drawer loses nothing — every
			// caller of this sheet injects SWM_SHEET in the same breath.
			".swt-panebody{flex:1;min-height:0;overflow-x:hidden;overflow-y:auto;padding-bottom:12px}",
			".swt-kv{margin:0;padding:8px 0;font:var(--dsw-font-xs-13)}",
			".swt-kv>div{display:grid;grid-template-columns:94px minmax(0,1fr);min-height:22px;padding:0 14px;align-items:center;gap:8px}",
			".swt-kv dt{color:var(--dsw-alias-label-tertiary);margin:0}",
			".swt-kv dd{min-width:0;margin:0;overflow:hidden;color:var(--dsw-alias-label-primary);text-overflow:ellipsis;white-space:nowrap}",
			".swt-secthead{margin:0;padding:6px 14px 2px;color:var(--dsw-alias-label-secondary);font-size:13px;font-weight:600;user-select:none}",
			// A DIFFERENT MATERIAL FROM THE PROSE ABOVE IT. Layer 2 is what the
			// pane itself is drawn on, so a payload block sat on its own
			// background with no edge — a wall of monospace that began and ended
			// nowhere. Layer 3 and a hairline give it a lid.
			`.swt-code{margin:0 14px;padding:8px 10px;border-radius:6px;overflow:auto;max-height:340px;color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-layer-3);border:1px solid ${LINE.rule};font:11px/17px var(--ds-font-family-code,monospace);white-space:pre-wrap;word-break:break-word}`,
			// THE THREE RULES THAT WERE NEVER WRITTEN. `missionColourJson` has
			// been emitting `k`, `s` and `n` on every payload since it was
			// added and no stylesheet in this file defined any of them, so the
			// tokeniser ran, allocated a span per token, and produced a block of
			// one colour. Dead code with a cost — and invisible to every test in
			// the repo, because the classes were emitted exactly as intended.
			//
			// SCOPED UNDER `.swt-code`, without exception. These are one-letter
			// names on a sheet shared with the whole tab; unscoped, `.k` would
			// paint anything anyone ever gives that class.
			`.swt-code .k{color:rgb(${PALETTE.blue})}`,
			`.swt-code .s{color:rgb(${PALETTE.green})}`,
			`.swt-code .n{color:rgb(${PALETTE.amber})}`,
			".swt-scrim{position:fixed;inset:0;z-index:40;display:flex;justify-content:flex-end;background:rgba(0,0,0,0.30);backdrop-filter:blur(2px)}",
			`.swt-drawer{display:flex;height:100%;width:100%;max-width:672px;flex-direction:column;overflow:hidden;border-left:1px solid ${LINE.rule};background:var(--dsw-alias-bg-layer-2);box-shadow:var(--dsw-shadow-lv3)}`,
			".swt-drawer .swt-pane{width:100%;max-width:none;border-left:0;height:100%}",
			// `currentColor`, WHERE THIS HARD-CODED THE SUCCESS GREEN. One rule
			// with one colour served two opposite things: the verbatim quote
			// behind a finding — which may be REFUTED — and the sentence a stage
			// wrote about why it degraded. Both were drawn behind a green rule,
			// which is a verdict, and in both of those cases the wrong one.
			//
			// The rule now inherits, and each call site passes `borderLeftColor`
			// for what it actually is. With no override it resolves to the text
			// colour, which is a neutral rule rather than a claim.
			".swt-quote{margin:0 14px;padding:10px 12px;border-radius:6px;border-left:2px solid currentColor;background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary);font:var(--dsw-font-xs-13);line-height:19px;white-space:pre-wrap;word-break:break-word}"
		].join("\n");

		/**
		* Put the stylesheet in the document, at most once.
		*
		* Guarded rather than assumed: this module is executed in Node by
		* tests/settings.test.mjs against a hand-written `document` stub, and a
		* bundle that throws at load time there is a bundle nobody can test.
		*/
		function ensureTraceStyle() {
			// Both sheets, in one call, because the trajectory's own rules use
			// the tone vars: a drawer that got its geometry and not its colours
			// is the half-styled state this pairing exists to make unreachable.
			ensureStyle(SWM_STYLE_ID, SWM_SHEET);
			ensureStyle(TRACE_STYLE_ID, TRACE_CSS);
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
		function MissionTraceRow({ row, zh, active, onOpen, anchor }) {
			const name = missionRowTitle(row, zh);
			// The KIND's colour, from the table that has always carried it. Five
			// hues over five kinds, rather than four over "did it fail".
			const kindHue = missionHue(MISSION_ROLE_FACES, row.role);
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
					jsxs("span", {
						className: "swt-clock",
						children: [
							// THE OFFSET ON TOP, because it is the one a reader of this
							// screen is actually asking for. It is "" when there is no
							// anchor — an empty span in a flex column takes no room, so
							// the slot falls back to exactly what it drew before.
							jsx("span", { children: missionSince(row.at, anchor, zh) }, "since"),
							// The wall clock keeps its place and steps back a shade. It
							// is what a person greps a server log with, so it stays
							// readable; it is not what they are scanning the column for.
							jsx("span", { style: { opacity: OPACITY.quiet }, children: missionClock(row.at) }, "clock")
						]
					}, "at"),
					jsxs("span", {
						className: "swt-tagslot",
						children: [
							jsx("span", {
								className: "swt-tag",
								style: { color: `rgb(${kindHue})`, background: `rgba(${kindHue},${TINT.soft})` },
								children: missionFace(MISSION_ROLE_FACES, row.role, zh)
							}, "tag"),
							// WHO, at last, and only as a mark. The agent id reached the
							// DOM in the `title` attribute and nowhere else, so the one
							// screen that shows every step of a run could not answer which
							// researcher took it without a hover per row. Icon-only
							// because the word does not fit and the colour is the answer:
							// a column of blue sparks and one amber is a handoff, visible
							// without reading a word.
							RoleChip({ agentId: row.agentId, zh, size: "xs", iconOnly: true }, "who")
						]
					}, "role"),
					jsx("span", {
						className: "swt-title",
						style: name.mono ? undefined : { fontFamily: "inherit", fontWeight: 500 },
						children: name.text
					}, "title"),
					jsx("span", { className: "swt-text", children: row.detail }, "detail"),
					jsx("span", { className: "swt-arrow", children: jsx(Icon, { name: "arrowRight", size: ICON.xs }) }, "arrow"),
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
						children: jsx("span", {
							className: "swt-metric",
							// GEOMETRY ON THE CLASS, TONE AT THE CALL SITE. `.swt-metric`
							// owns the width, the alignment and the tabular figures for
							// every row; only this row knows how long it took. `undefined`
							// leaves the class's tertiary grey in place, which is the
							// right answer for the majority of rows — a band that
							// coloured everything would be a band that says nothing.
							style: Number(row.ms) >= MISSION_SLOW_MS
								? { color: `rgb(${TONE.danger})` }
								: Number(row.ms) >= MISSION_WARN_MS
								? { color: `rgb(${TONE.warn})` }
								: undefined,
							children: took
						}, "took")
					}, "trail")
				]
			});
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
		function MissionTraceDetail({ missionId, traceRef, zh, onClose, onOpenSource, anchor }) {
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
						className: "swm-iconbtn",
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
							className: "swm-tab",
							"aria-selected": entry.id === tab,
							onClick: () => { setTab(entry.id); },
							// Geometry inline, state on the class. The resting
							// colour is `secondary` rather than the `tertiary`
							// the old rule used: a tab label is a word the reader
							// has to read, and INK's own docblock puts tertiary at
							// 3.71:1 — the decoration budget.
							style: {
								font: entry.id === tab ? FONT.bodyStrong : FONT.body,
								padding: `0 ${SPACE.sm}`,
								"--swm-tab-inset": SPACE.sm,
								color: entry.id === tab ? "var(--dsw-alias-state-business-primary)" : INK.secondary
							},
							children: zh ? entry.zh : entry.en
						}, entry.id))
					}, "tabs"),
					jsx("div", { className: "swt-panebody", children: body }, "body")
				]
			});

			if (held === null || held.ref !== traceRef) {
				return shell(jsx("div", {
					style: { font: FONT.small, color: error === "" ? INK.secondary : `rgb(${TONE.warn})` },
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
			// The same row for a value that is a NODE. `line` calls `String()` on
			// what it is handed, which is what keeps a number, a duration and a
			// timestamp on one grid — and is also why a chip passed to it renders
			// "[object Object]". The two are one row with one difference, so the
			// `title` is passed separately: a `dd` whose text is a chip still owes
			// the reader the raw string on hover.
			const node = (label, value, title) => (value === null || value === undefined ? null : jsxs("div", {
				children: [
					jsx("dt", { children: label }, "k"),
					jsx("dd", { title: title === null || title === undefined ? undefined : String(title), children: value }, "v")
				]
			}, label));
			// An instant, said both ways: where it sits on the wall and how far
			// into the run it is. The offset is the half a person can act on —
			// this panel is opened FROM a list that is now ordered by it — and it
			// disappears silently when there is no anchor to measure against.
			const when = (iso) => {
				if (iso === null || iso === undefined || iso === "") return "";
				const offset = missionSince(iso, anchor, zh);
				return `${formatStamp(iso)} ${missionClock(iso)}${offset === "" ? "" : ` · ${offset}`}`;
			};

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
						// `display: block`, and it is not cosmetic. These three divs
						// are children of the `.swt-kv` list, and `.swt-kv>div` makes
						// every direct child a two-column grid whose first column is
						// 94px — so the claim, which has no `dt`, was being laid out
						// INSIDE that 94px column while the rest of the panel sat
						// empty beside it. The grid is for label/value rows; these are
						// not label/value rows.
						style: { font: FONT.bodyStrong,
							display: "block", padding: "10px 14px 6px", color: INK.primary
						},
						children: finding.claim
					}, "claim"),
					finding === null ? null : jsx("div", {
						className: "swt-quote",
						// THE TONE OF THE VERDICT, not of success. A quote that was
						// checked and REFUTED was drawn behind the same green rule as
						// one that was confirmed — the single most confident-looking
						// element on the panel, saying the opposite of what the panel
						// says. `verdict` is already computed above from the row's
						// own `ok`.
						style: { display: "block", borderLeftColor: `rgb(${verdict.hue})` },
						// Verbatim and whole. The list clips it and this is the only
						// place it can be read, which is the point of the panel.
						children: `“${finding.quote}”`
					}, "quote"),
					finding === null ? null : jsxs("div", {
						style: { font: FONT.micro, display: "flex", alignItems: "center", gap: SPACE.md, flexWrap: "wrap", margin: "0 0 6px" },
						children: [
							!openable ? jsx("span", {
								style: { color: INK.secondary },
								children: zh ? "这条发现没有带回可打开的地址" : "no openable address travelled with this finding"
							}, "noUrl") : jsx("button", {
								type: "button",
								onClick: () => { onOpenSource?.(finding); },
								style: { font: FONT.micro,
									appearance: "none", border: "none", background: "transparent", padding: 0,
									color: `rgb(${verdict.hue})`, font: "inherit", cursor: "pointer"
								},
								// 信源's own reader: the Host half re-fetches the page
								// and extracts it, which is the only thing that can
								// answer "does that page still say this".
								children: (zh ? "在阅读器里打开 · " : "Open in the reader · ")
									+ ((finding.sourceHost ?? "") === "" ? hostOf(finding.sourceUrl) : finding.sourceHost)
							}, "open"),
							!openable ? null : jsx("a", {
								href: finding.sourceUrl, target: "_blank", rel: "noreferrer noopener",
								style: { color: INK.secondary, textDecoration: "none" },
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
					line(zh ? "时刻" : "At", when(detail.at)),
					detail.stepId === null || detail.stepId === undefined ? null
						: line(zh ? "阶段" : "Stage", `${missionFace(MISSION_STAGE_FACES, detail.stepId, zh)} (${detail.stepId})`),
					// A NODE, not a string. `line` stringifies its value — that is what
					// keeps a number and a timestamp on one grid — so the one row whose
					// value is a person goes through `node` instead, which is the same
					// row with the `String()` taken off the `dd`.
					detail.agentId === null || detail.agentId === undefined ? null
						: node(zh ? "执行者" : "Agent", RoleChip({ agentId: detail.agentId, zh }), detail.agentId),
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
						style: { font: FONT.small, marginTop: "4px", color: `rgb(${TONE.warn})` },
						children: detail.stage.degradeNote
					}, "degrade"),
					// A position, said to be a position. The trajectory is assembled
					// from bounded windows over three tables, so `seq` slides when the
					// oldest end falls off; the `ref` above is what survives.
					jsx("div", {
						style: { font: FONT.micro, marginTop: "6px", color: INK.secondary },
						children: zh
							? `第 ${detail.seq} 行 —— 这是当前这份快照里的位置，不是身份；身份是上面那个 ref。`
							: `Row ${detail.seq} — a position in this snapshot, not an identity. The identity is the ref above.`
					}, "seqNote")
				]
			});

			const result = detail.result ?? {};
			const timing = detail.timing ?? {};

			return shell(jsxs("div", {
				style: { display: "flex", flexDirection: "column", gap: SPACE.sm },
				children: [
					tab !== "summary" ? null : summary,
					tab !== "payload" ? null : jsxs("div", {
						style: { display: "flex", flexDirection: "column", gap: SPACE.sm },
						children: [
							block(JSON.stringify(detail.payload ?? null, null, 2)),
							detail.kind !== "tool" ? null : jsx("div", {
								style: { font: FONT.micro, color: INK.secondary },
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
						style: { display: "flex", flexDirection: "column", gap: SPACE.sm },
						children: [
							result.text === null || result.text === undefined || result.text === ""
								? jsx("div", {
									style: { font: FONT.small, color: INK.secondary },
									children: zh ? "这一行没有留下结果文本。" : "This row recorded no result text."
								}, "empty")
								: block(result.text),
							result.note === null || result.note === undefined || result.note === "" ? null : jsx("div", {
								style: { font: FONT.micro, color: INK.secondary },
								// The route's own sentence about what the column does and
								// does not hold. Re-worded here it would become a second
								// answer to the same question.
								children: result.note
							}, "note")
						]
					}, "resultTab"),
					tab !== "timing" ? null : jsxs("div", {
						style: { display: "flex", flexDirection: "column", gap: SPACE.xs },
						children: [
							line(zh ? "记录于" : "Recorded", when(timing.at)),
							line(zh ? "开始" : "Started", when(timing.startedAt)),
							line(zh ? "结束" : "Ended", when(timing.endedAt)),
							line(zh ? "用时" : "Duration", detail.kind === "tool" ? missionLatency(timing.ms, zh) : missionDuration(timing.ms, zh)),
							timing.source === null || timing.source === undefined || timing.source === "" ? null : jsx("div", {
								style: { font: FONT.micro, marginTop: "4px", color: INK.secondary },
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
			// THE RUN'S OWN ZERO, for the offset the rows now print.
			//
			// NOT `rows[0].at`, which is what it looks like it should be: this
			// list defaults to NEWEST FIRST, so row zero is the last thing that
			// happened and every offset under it would come out negative — which
			// `missionSince` renders as nothing at all, so the column would be
			// blank on one sort order and full on the other. The stage rows come
			// out of the same event log and carry `startedAt` regardless of how
			// the list is ordered, so the earliest of those is the zero; a
			// trajectory with no stage rows yet falls back to the earliest instant
			// among the rows it does have.
			const anchor = [
				...stages.map((stage) => stage.startedAt),
				...rows.map((row) => row.at)
			].filter((at) => typeof at === "string" && at !== "").sort()[0] ?? null;
			const saturated = ["events", "toolCalls", "findings"].filter((stream) => bounds[stream]?.saturated === true);
			const gained = Math.max(0, Number(fresh?.data?.page?.total ?? 0) - Number(paging.total ?? 0));

			const selectStyle = {
				appearance: "none", height: CONTROL.sm, padding: "0 8px", borderRadius: RADIUS.md,
				border: `1px solid ${LINE.rule}`, background: "transparent",
				color: INK.secondary, font: FONT.small, cursor: "pointer"
			};

			const filters = jsxs("div", {
				style: { display: "flex", alignItems: "center", gap: SPACE.sm, flexWrap: "wrap", marginBottom: "8px" },
				children: [
					...MISSION_TRACE_KINDS.map((entry) => jsx("button", {
						type: "button",
						role: "tab",
						"aria-selected": entry.id === kind,
						className: "swm-chip swm-focus", style: { ...chipStyle(entry, entry.id === kind), font: FONT.small, height: CONTROL.sm, padding: "0 10px" },
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
						className: "swm-focus", style: { font: FONT.small,
							flex: "1 1 180px", minWidth: "140px", boxSizing: "border-box",
							height: CONTROL.sm, padding: "0 10px", borderRadius: RADIUS.md,
							border: `1px solid ${LINE.rule}`, background: "transparent",
							color: INK.primary, font: "inherit"
						},
						onChange: (event) => { setSearch(event.target.value); }
					}, "search"),
					jsx("button", {
						type: "button",
						className: "swm-ctl swm-focus", style: { ...controlStyle(), font: FONT.small, height: CONTROL.sm, padding: "0 10px" },
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
					style: { font: FONT.small, color: INK.secondary },
					children: zh ? "正在读取轨迹…" : "Reading the trajectory…"
				}, "loading")
				: error !== "" && data === null
				? jsxs("div", {
					style: { display: "flex", flexDirection: "column", gap: SPACE.sm },
					children: [
						jsx("div", {
							style: { font: FONT.small, color: `rgb(${TONE.warn})` },
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
									style: { font: FONT.small, color: INK.secondary },
									// "0" and "0 of 431" are different sentences: the first
									// says the mission did nothing, the second says this
									// filter matches nothing.
									children: Number(paging.unfiltered ?? 0) > 0
										? (zh ? `这个筛选下没有记录 —— 轨迹里一共有 ${paging.unfiltered} 条。` : `Nothing matches this filter — the trajectory holds ${paging.unfiltered} row(s).`)
										: (zh ? "这个任务还没有留下任何轨迹。" : "This mission has not recorded a trajectory yet.")
								}, "empty")
								: rows.map((row) => jsx(MissionTraceRow, {
									row, zh, anchor,
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
								missionId, traceRef: selected, zh, anchor,
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
						className: "swm-ctl swm-focus", style: { ...controlStyle(), font: FONT.small, height: CONTROL.sm, marginBottom: "8px", alignSelf: "flex-start" },
						onClick: () => { applied.current = fresh.signature; setPage(fresh); setFresh(null); },
						children: gained > 0
							? (zh ? `又有 ${gained} 条记录 · 点这里更新（正在看的那一行不会动）` : `${gained} more row(s) · load them (the open row stays)`)
							: (zh ? "轨迹有更新 · 点这里加载" : "The trajectory moved · load it")
					}, "pending"),
					// A refresh that failed over a list we already have. Without this
					// the page keeps drawing the last good answer beside a clock that
					// never moves, which is the most convincing wrong screen here.
					error === "" || data === null ? null : jsx("div", {
						style: { font: FONT.small, marginBottom: "8px", color: `rgb(${TONE.warn})` },
						children: (zh ? "这一次刷新失败了，下面是上一次读到的轨迹：" : "The latest refresh failed; what follows is the trajectory as it was last read: ") + error
					}, "stale"),
					rows.length === 0 ? null : jsx(MissionTraceBand, { rows, zh }, "band"),
					body,
					data === null ? null : jsx("div", {
						style: { font: FONT.micro, marginTop: "8px", color: INK.secondary },
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
				style: { height: "100%", minHeight: 0, display: "flex", flexDirection: "column", gap: SPACE.md, padding: "0 24px 16px" },
				children: [
					jsxs("div", {
						style: { flex: "none", display: "flex", alignItems: "center", gap: SPACE.md },
						children: [
							jsx("button", { type: "button", className: "swm-ctl swm-focus", style: controlStyle(), onClick: onBack, children: back }, "back"),
							jsx("span", {
								style: { font: FONT.body, flex: 1, minWidth: 0, color: INK.secondary },
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
		* The centred dialog, for a form that is not a page.
		*
		* NOT A SECOND DRAWER. `MissionDrawer` is the right slide-over and it is
		* the correct shape for a DETAIL — a finding, a stage, a source — because
		* it leaves the table it was opened from in place beside it. A create
		* form has nothing behind it to keep in view; it is a task with a start
		* and an end, and it belongs in the middle of the screen. The file had no
		* such shell at all, which is why the starter was a permanently expanded
		* card sitting above every mission in the list: not a design decision, an
		* absence of one.
		*
		* THE ESCAPE HANDLER IS MissionDrawer's, INCLUDING THE stopPropagation,
		* and that line is the whole reason this is a copy rather than a fresh
		* effect. The host app closes the entire 智能体 panel on Escape, so one
		* press with an overlay open closed the overlay AND the panel behind it —
		* measured once already, on the drawer, at the cost of the whole page.
		* Capture phase, for the same reason: this has to run before the panel's
		* own handler rather than after it has already closed.
		*
		* NO FOCUS TRAP, and it is named here rather than left to be discovered.
		* Tab still walks out of this dialog into the list behind it. Nothing in
		* this file traps focus today, a trap needs a live DOM to be written
		* against and a live DOM to be tested in, and half a trap — a first-node
		* focus with no wrap — is worse than none, because it looks like the
		* behaviour is handled.
		* @param open - whether to render at all.
		* @param onClose - backdrop click, Escape, or the head's own control.
		* @param title - the dialog's name, which is also its accessible name.
		* @param note - one sentence under the title; omitted when empty.
		* @param zh - whether to write Chinese. Taken as a PROP, not read from
		*   `isChinese()`: every caller already has one, and a shell that asks
		*   the document while its caller was handed a language is a dialog
		*   whose close button can disagree with the form inside it.
		* @param children - the body, which scrolls on its own.
		*/
		function SwarmModal({ open, onClose, title, note, zh, children }) {
			useEffect(() => {
				if (open !== true) return undefined;
				const onKey = (event) => {
					if (event.key !== "Escape") return;
					// STOPPED HERE, exactly as the drawer stops it. Without this
					// line one Escape closes this dialog and the whole 智能体
					// panel behind it, and the person who pressed it to abandon a
					// half-typed topic loses the page.
					event.stopPropagation();
					if (typeof event.preventDefault === "function") event.preventDefault();
					onClose?.();
				};
				// Guarded: this module is executed in Node by the render tests
				// against a hand-written window stub.
				if (typeof window?.addEventListener !== "function") return undefined;
				window.addEventListener("keydown", onKey, true);
				return () => { window.removeEventListener("keydown", onKey, true); };
			}, [open, onClose]);

			if (open !== true) return null;
			return jsx("div", {
				className: "swm-modal-scrim",
				role: "dialog",
				"aria-modal": "true",
				"aria-label": title,
				onClick: () => { onClose?.(); },
				children: jsxs("div", {
					className: "swm-modal",
					// The backdrop closes and the sheet does not. Without this the
					// first click inside the dialog closes it, which is the most
					// confusing possible answer to "I clicked on the form".
					onClick: (event) => { event.stopPropagation(); },
					children: [
						jsxs("div", {
							className: "swm-modalhead",
							children: [
								jsxs("div", {
									style: { flex: 1, minWidth: 0, display: "flex", flexDirection: "column", gap: SPACE.xs },
									children: [
										jsx("h2", { style: { font: FONT.baseStrong, margin: 0, color: INK.primary }, children: title }, "title"),
										(note ?? "") === "" ? null : jsx("p", {
											style: { font: FONT.small, margin: 0, color: INK.secondary },
											children: note
										}, "note")
									]
								}, "words"),
								IconButton({
									label: zh ? "关闭" : "Close",
									size: CONTROL.xs,
									onClick: () => { onClose?.(); },
									children: jsx(Icon, { name: "close", size: ICON.sm })
								}, "close")
							]
						}, "head"),
						jsx("div", { className: "swm-modalbody", children }, "body")
					]
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
				// THE HEADING SURVIVES THE EMPTY STATE. It used to be dropped twice
				// over — once by `bare`, once by returning the notice bare — so a run
				// with no tasks yet showed a paragraph floating on an unlabelled pane.
				return jsx(MissionPanel, {
					bare: true, title: zh ? "任务" : "Tasks", count: 0,
					children: jsx(MissionEmptyPane, {
					mission, zh,
					waiting: zh
						? "暂无任务：等 Leader 拆完维度，任务会动态出现。"
						: "No tasks yet: the leader is still breaking the topic into dimensions, and tasks appear as it does.",
					finished: zh
						? "这次运行结束时，任务表里暂无任何一条阶段记录 —— 不是没显示，是确实一条也没落下。"
						: "This run ended with nothing in the task table at all — nothing is being hidden; not one stage row was written."
					})
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
			// RESOLVED ONCE, HERE, because two things read it now. The row draws
			// its spine and its status chip from this; the legend above the table
			// counts it. Resolving it twice — once per row and once per tally —
			// is how a header that says 3 完成 ends up over four green rows, and
			// the two copies would be forty lines apart.
			for (const entry of display) {
				// A parent row IS a stage, so it keeps the stage row's timings and
				// attempt count. A child is a decision — a dimension somebody
				// planned, a re-collect the Leader called for — and carries its own.
				entry.stage = entry.depth > 0 ? null : (rows.find((row) => `stage:${row.stepId}` === entry.node.id) ?? null);
				entry.status = entry.stage?.status ?? entry.node.state ?? "pending";
			}

			// BOTH VOCABULARIES, because the rows come from both tables: a parent
			// is a stage and its state is 运行中; a child is a dimension and its
			// state is 采集中, which MISSION_STAGE_STATUS_FACES has never heard
			// of. `missionHue` answers TONE.neutral for a value it does not hold,
			// so before this a 采集中 row drew a grey spine and a grey chip while
			// its own word said it was working.
			const faceOf = (status) => (Object.hasOwn(MISSION_STAGE_STATUS_FACES, String(status))
				? missionFace(MISSION_STAGE_STATUS_FACES, status, zh)
				: missionFace(MISSION_DIMENSION_FACES, status, zh));
			const hueOf = (status) => (Object.hasOwn(MISSION_STAGE_STATUS_FACES, String(status))
				? missionHue(MISSION_STAGE_STATUS_FACES, status)
				: missionHue(MISSION_DIMENSION_FACES, status));
			const iconOf = (status) => (Object.hasOwn(MISSION_STAGE_STATUS_FACES, String(status))
				? missionIcon(MISSION_STAGE_STATUS_FACES, status)
				: missionIcon(MISSION_DIMENSION_FACES, status));

			// What the board adds up to, in the order the pipeline runs — which is
			// the one question a table of thirty rows cannot answer by being read.
			// A tally is printed only when it is non-zero: a legend listing every
			// state a board COULD be in is six greyed words that say nothing about
			// this run.
			const tally = new Map();
			for (const entry of display) tally.set(entry.status, (tally.get(entry.status) ?? 0) + 1);
			const legend = [
				...Object.keys(MISSION_STAGE_STATUS_FACES),
				...Object.keys(MISSION_DIMENSION_FACES).filter((id) => !Object.hasOwn(MISSION_STAGE_STATUS_FACES, id))
			].filter((id) => (tally.get(id) ?? 0) > 0);

			const chosen = rows.find((row) => row.stepId === selected) ?? null;
			const table = jsx("div", {
				style: {
					border: `1px solid ${LINE.rule}`, borderRadius: RADIUS.md,
					overflow: "hidden", background: "var(--dsw-alias-bg-layer-1)"
				},
				children: jsxs("table", {
					style: { width: "100%", borderCollapse: "collapse", tableLayout: "fixed" },
					children: [
						jsx("thead", {
							children: jsx("tr", {
								style: { borderBottom: `1px solid ${LINE.rule}` },
								children: columns.map((column) => jsx("th", {
									style: { ...TH, width: column.width, textAlign: column.align ?? "left" },
									children: column.label
								}, column.id))
							})
						}, "head"),
						jsx("tbody", {
							children: display.map((entry, at) => {
								const node = entry.node;
								const child = entry.depth > 0;
								const stage = entry.stage;
								const status = entry.status;
								const face = faceOf(status);
								const hue = hueOf(status);
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
									className: "swm-tr",
									onClick: () => { onSelect?.(open ? null : key); },
									style: {
										cursor: "pointer",
										// UNDEFINED, NOT "transparent". An inline declaration beats
										// a stylesheet, so writing a colour here for every unselected
										// row would silently kill `.swm-tr:hover` — the rule would be
										// in the sheet, the class would be on the row, and nothing
										// would ever light up. The selected row still writes its own,
										// which is correct: it is already lit.
										background: open ? SURFACE.hover : undefined,
										boxShadow: `inset 3px 0 0 0 rgba(${hue},${ran ? 0.9 : 0.25})`
									},
									children: [
										jsx("td", {
											style: { ...TD, textAlign: "center", color: INK.quiet },
											children: child ? "" : String(at + 1)
										}, "idx"),
										// THE ONE CELL THAT IS NOT A FIGURE, and the only one allowed
										// its own geometry: it is a flex row of a badge, a mode mark,
										// a name and the Leader's sentence about the row. It keeps
										// `TD`'s height and rhythm and overrides only the padding-left
										// that draws the tree indent. `verticalAlign:"top"` is gone
										// with the old local `cell` — it was there for a wrapping cell
										// that has since been made a single ellipsised line, so it was
										// pinning one row's contents a few pixels above its neighbours'
										// for a reason that had stopped existing.
										jsxs("td", {
											style: { ...TD, display: "flex", alignItems: "center", gap: SPACE.sm, minWidth: 0, paddingLeft: child ? "26px" : "10px" },
											children: [
												// The origin, on the child only. "Why does this row
												// exist" is the whole difference between a plan and a
												// progress bar, and for a stage the answer is always
												// "the pipeline declares twelve".
												// A CATEGORY, so it keeps the chip's corner. It also
												// stops mixing vocabularies: this one chip reached
												// for the harness's state tokens by hand while every
												// other chip on the screen took a TONE, which is how
												// one badge ends up a slightly different amber.
												!child ? null : Chip({
													tone: node.origin === "leader-assess-recollect" ? TONE.warn : TONE.info,
													label: node.origin === "leader-assess-recollect"
														? (zh ? "领队要求重采" : "re-collect")
														: (zh ? "维度" : "dimension")
												}, "origin"),
												// And WHAT KIND OF STEP, on the parent. The origin badge
												// above answers "why does this row exist" for a child
												// and deliberately not for a stage, on the grounds that
												// the pipeline declares twelve — which leaves the stage
												// row with nothing saying whether it is a gate, a
												// fan-out or a draft. The catalogue has declared that all
												// along and it reached the projection and stopped there.
												child ? null : StageModeChip({ mode: stage?.mode ?? null, stepId: stage?.stepId ?? null, zh }, "mode"),
												jsx("span", {
													style: {
														fontWeight: child ? 400 : 600,
														color: INK.primary,
														whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis",
														maxWidth: child ? "40%" : "none"
													},
													children: child ? node.title : missionFace(MISSION_STAGE_FACES, stage?.stepId ?? node.title, zh)
												}, "name"),
												note === "" ? null : jsx("span", {
													style: { font: FONT.micro,
														flex: "1 1 0", minWidth: 0,
														overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", color: INK.secondary
													},
													title: note,
													children: note
												}, "note")
											]
										}, "name"),
										// THE ELLIPSIS STAYS ON THE CELL, not on the chip. A chip
										// is `nowrap` by definition and clipping it would cut the
										// role word itself; what has to give in a narrow column is
										// the dimension slug, and RoleChip already ellipsises that
										// half on its own.
										jsx("td", {
											style: { ...TD, color: INK.secondary },
											children: RoleChip({ agentId: who, zh }) ?? "—"
										}, "owner"),
										jsxs("td", {
											style: TD,
											children: [
												// The row's STATE, so it takes the pill — and the
												// attempt count rides INSIDE it. It used to hang off
												// the right as a separate grey span, which made three
												// sibling spans in three colours out of one fact.
												Chip({
													tone: hue,
													pill: true,
													// The same mark the ruler above draws, from the
													// same tables. 待运行 and 本档跳过 share
													// TONE.muted deliberately, so on this column too
													// the glyph is the only thing between "not yet"
													// and "not here".
													icon: iconOf(status),
													label: face,
													count: attempts <= 1 ? undefined : (zh ? `第 ${attempts} 次` : `×${attempts}`)
												}, "pill"),
												// A dimension's own arithmetic, where it is the row's
												// point: 已核验 N/下限 is what says whether this piece
												// of work succeeded, and the status word does not — so
												// it is drawn as a verdict rather than in the tertiary
												// grey that says "ignore me". `floor: null` means s3
												// has not derived the bar yet and MUST NOT render as
												// `/0`, which would read as a bar this row cleared.
												!child || node.counts?.verified === undefined || node.counts?.verified === null ? null : jsx("span", {
													// NO `fontVariantNumeric` HERE ANY MORE, and it was never
													// doing anything: its only child is a Chip, and a Chip
													// sets a `font` shorthand, which resets font-variant on
													// the way past. The cell it sits in carries the figures
													// setting now, from `TD`, where it applies once.
													style: { marginLeft: SPACE.xs },
													children: Chip({
														// A null floor is NEUTRAL, not a bar cleared.
														// `?? 0` here would be the same defect as
														// printing `/0`: a dimension whose bar s3 has
														// not derived yet would be drawn green for
														// having beaten nothing.
														tone: node.counts.floor === null || node.counts.floor === undefined
															? TONE.neutral
															: node.counts.verified >= node.counts.floor ? TONE.success : TONE.warn,
														// The WORD stays in the label rather than being
														// replaced by a tick: the glyph is aria-hidden,
														// so a chip reading only "1/3" is a fraction of
														// nothing to anyone not looking at it.
														label: node.counts.floor === null || node.counts.floor === undefined
															? (zh ? `已核验 ${node.counts.verified}` : `${node.counts.verified} verified`)
															: (zh ? `已核验 ${node.counts.verified}/${node.counts.floor}` : `${node.counts.verified}/${node.counts.floor} verified`)
													})
												}, "verified")
											]
										}, "status"),
										jsx("td", {
											style: { ...TD, textAlign: "right", color: INK.secondary },
											children: stage === null || stage.durationMs === null || stage.durationMs === undefined
												? "—"
												: missionDuration(stage.durationMs, zh)
										}, "took"),
										jsx("td", {
											style: { ...TD, textAlign: "right" },
											children: !ran || stage === null ? null : jsx("button", {
												type: "button",
												style: { font: FONT.micro,
													appearance: "none", border: "none", background: "transparent",
													padding: 0, cursor: "pointer", font: "inherit",
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
			}, "table");
			// THE LEGEND IS THE PANEL'S `action` NOW, which is what B9 left a note
			// asking for: it was a header the board hand-built because MissionPanel
			// had no slot for one, and a second header shape eight pixels above the
			// panel's own is the duplication this batch exists to remove.
			//
			// It WRAPS, alone among the things in that row, and the exception is
			// deliberate. The header must not wrap on PROSE — that is the defect
			// that made it three lines tall — but a legend is six short pairs, each
			// one atomic, and the alternative is clipping a key whose whole job is to
			// say what the colours down the left of the table mean. A key that is
			// cut off says it about four of them.
			const key = jsxs("div", {
				style: {
					display: "flex", alignItems: "center", justifyContent: "flex-end",
					gap: SPACE.md, flexWrap: "wrap", minWidth: 0
				},
				children: legend.map((id) => jsxs("span", {
					style: {
						display: "inline-flex", alignItems: "center", gap: SPACE.xs,
						font: FONT.micro, color: INK.secondary, whiteSpace: "nowrap"
					},
					children: [
						// A DOT, NOT THE ROW'S CHIP. The legend keys the spine
						// down the left of each row, and the spine is a bar of
						// flat colour — so the key is the same flat colour. A
						// tinted chip up here would be a fourth shape for one
						// vocabulary on one screen.
						jsx("span", {
							className: id === "running" || id === "collecting" ? "swm-live" : undefined,
							style: {
								width: "6px", height: "6px", flex: "none",
								borderRadius: RADIUS.circle, background: `rgb(${hueOf(id)})`
							}
						}, "dot"),
						jsx("span", { children: faceOf(id) }, "word"),
						jsx("span", {
							style: { font: FONT.micro, fontVariantNumeric: "tabular-nums", color: INK.primary },
							children: String(tally.get(id) ?? 0)
						}, "n")
					]
				}, id))
			}, "legend");
			// THE BOARD MOUNTS ITS OWN PANEL, against this file's usual shape, where
			// the detail view mounts the panel and passes the component as children.
			// The reason is arithmetic, not taste: the number a reader needs is
			// `display.length` — what SURVIVED grouping, which is not
			// `stages.length` and not `work.length`, because a child whose parent
			// fell outside the window is in neither. Computing it again at the mount
			// would be the second copy of a resolution the comment ninety lines above
			// exists to forbid, and the two would disagree exactly when the board is
			// most worth reading.
			return jsxs(MissionPanel, {
				bare: true,
				title: zh ? "任务" : "Tasks",
				count: display.length,
				action: key,
				children: [
					table,
					jsx(MissionDrawer, {
						open: chosen !== null,
						onClose: () => { onSelect?.(null); },
						children: chosen === null ? null : jsx(MissionStageDetail, {
							stage: chosen, owner: owner.get(chosen.stepId) ?? null, zh,
							missionId: mission?.id ?? null,
							// EFFECTIVE START, not `startedAt`. A mission that was
							// resumed carries both, and measuring this run's stages
							// against the original start prints an offset that includes
							// however long the run sat stopped — which is a number about
							// the outage, not about the step.
							anchor: mission?.effectiveStartAt ?? mission?.startedAt ?? null,
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
		* @param missionId - the mission, for the step's own trajectory.
		* @param anchor - the run's zero, so the timings read as offsets too.
		*/
		function MissionStageDetail({ stage, owner, zh, onClose, onOpenStage, missionId, anchor }) {
			ensureTraceStyle();
			// WHAT THIS STEP DID, which the drawer could not say. It listed seven
			// properties OF the stage — status, attempts, took, owner, tokens,
			// started, ended — and not one thing the stage actually performed,
			// while `/missions/:id/trace` has accepted a `stepId` filter since it
			// was written.
			//
			// `null` is "not read yet" and `[]` is "read, and this step recorded
			// nothing" — the same three-state distinction the trajectory pane
			// draws for the same reason: they are the same list and they must not
			// disagree about what an empty one means.
			const [steps, setSteps] = useState(null);
			const [stepsError, setStepsError] = useState("");
			useEffect(() => {
				if (missionId === null || missionId === undefined || missionId === "") return;
				let alive = true;
				const query = new URLSearchParams();
				query.set("stepId", stage.stepId);
				query.set("take", String(MISSION_STAGE_TRACE_TAKE));
				// OLDEST FIRST, unlike the pane. The pane is a log you watch; this
				// is a step you read through, and a step read backwards is a
				// sequence of consequences before their causes.
				query.set("order", "oldest");
				fetch(`${apiBase()}/missions/${encodeURIComponent(missionId)}/trace?${query.toString()}`)
					.then(missionData)
					.then((data) => {
						if (!alive) return;
						setSteps(Array.isArray(data.rows) ? data.rows : []);
						setStepsError("");
					})
					.catch((cause) => {
						if (!alive) return;
						setStepsError(String(cause?.message ?? cause));
					});
				return () => { alive = false; };
			}, [missionId, stage.stepId]);
			const face = missionFace(MISSION_STAGE_STATUS_FACES, stage.status, zh);
			const note = stage.degradeNote ?? "";
			const line = (label, value) => (value === "" || value === null || value === undefined ? null : jsxs("div", {
				children: [
					jsx("dt", { children: label }, "k"),
					jsx("dd", { title: String(value), children: String(value) }, "v")
				]
			}, label));
			// The same row for a value that is a NODE. `line` calls `String()` on
			// what it is handed, which is what keeps a number, a duration and a
			// timestamp on one grid — and is also why a chip passed to it renders
			// "[object Object]". The two are one row with one difference, so the
			// `title` is passed separately: a `dd` whose text is a chip still owes
			// the reader the raw string on hover.
			const node = (label, value, title) => (value === null || value === undefined ? null : jsxs("div", {
				children: [
					jsx("dt", { children: label }, "k"),
					jsx("dd", { title: title === null || title === undefined ? undefined : String(title), children: value }, "v")
				]
			}, label));
			// The wall clock and the offset from the run's start, in that order,
			// exactly as the trajectory drawer says it. A stage that began `+4m 2s`
			// in is a fact about the run; `14:02:11` is a fact about the machine.
			const when = (iso) => {
				if (iso === null || iso === undefined || iso === "") return null;
				const offset = missionSince(iso, anchor, zh);
				return `${formatStamp(iso)} ${missionClock(iso)}${offset === "" ? "" : ` · ${offset}`}`;
			};
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
									StageModeChip({ mode: stage.mode ?? null, stepId: stage.stepId, zh }, "mode"),
									jsx("span", { className: "swt-paneref", children: stage.stepId }, "ref")
								]
							}, "title"),
							jsx("button", {
								type: "button", className: "swm-iconbtn",
								"aria-label": zh ? "关闭" : "Close",
								onClick: onClose,
								children: "\u00d7"
							}, "close")
						]
					}, "head"),
					jsxs("div", {
						className: "swt-panebody",
						children: [
							// THE THREE FIGURES THIS STEP COST, out of the property list
							// and above it. `calls` is the one that was nowhere: the
							// projector has attached it to every stage since the ledger
							// was wired up and no screen in this file read it, so "this
							// step took four minutes" was on the page and "it took
							// eleven model calls to do it" was not.
							//
							// Padded to 14px, which is `.swt-kv>div`'s own horizontal
							// padding, so the chips start at the same x as the labels
							// under them instead of at a second margin nobody chose.
							jsxs("div", {
								style: { display: "flex", flexWrap: "wrap", gap: SPACE.sm, padding: `${SPACE.sm} 14px 0` },
								children: [
									// SHORT ON THE CHIP, EXACT ON THE HOVER — the same
									// split the roster makes, so one quantity has one
									// shape wherever it is drawn.
									stage.tokens === null || stage.tokens === undefined ? null : Chip({
										tone: TONE.accent, icon: "sparkles",
										label: zh ? "令牌" : "Tokens",
										count: missionCompact(stage.tokens),
										title: String(stage.tokens)
									}, "tokens"),
									// EXACT, because 11 calls and 12 calls is a comparison
									// a person makes between two stages of one run.
									stage.calls === null || stage.calls === undefined ? null : Chip({
										tone: TONE.info, icon: "refresh",
										label: zh ? "模型调用" : "Calls",
										count: String(stage.calls)
									}, "calls"),
									stage.durationMs === null || stage.durationMs === undefined ? null : Chip({
										tone: TONE.neutral, icon: "clock",
										label: zh ? "用时" : "Took",
										count: missionDuration(stage.durationMs, zh)
									}, "took")
								]
							}, "stats"),
							jsxs("dl", {
								className: "swt-kv",
								children: [
									line(zh ? "状态" : "Status", face),
									line(zh ? "尝试" : "Attempts", stage.attempts),
									line(zh ? "用时" : "Took", stage.durationMs === null || stage.durationMs === undefined ? null : missionDuration(stage.durationMs, zh)),
									// The owner is the only value in this panel that is a person
									// rather than a figure, and it was drawn as the same grey
									// string as 令牌 and 尝试.
									owner === null ? null : node(
										zh ? "负责人" : "Owner",
										RoleChip({ agentId: owner.agentId, role: owner.role, zh }),
										owner.agentId ?? owner.role ?? null
									),
									// NO TOKENS ROW. It is a chip four lines above now, and
									// the same figure twice in one panel is the reader
									// checking whether they are the same figure.
									line(zh ? "开始" : "Started", when(stage.startedAt)),
									line(zh ? "结束" : "Ended", when(stage.endedAt))
								]
							}, "kv"),
							note === "" ? null : jsx("p", { className: "swt-secthead", children: zh ? "降级说明" : "Why it degraded" }, "noteHead"),
							// WHOLE, and in a block that is allowed to wrap. This is
							// the sentence a degraded stage wrote about itself, and it
							// was being clipped to two lines inside a table cell.
							// AMBER. A stage that finished by lowering its own bar wrote
							// this sentence, and a green rule beside it read as the
							// stage endorsing itself.
							note === "" ? null : jsx("div", {
								className: "swt-quote",
								style: { borderLeftColor: `rgb(${TONE.warn})` },
								children: note
							}, "note"),
							missionId === null || missionId === undefined || missionId === ""
								? null : jsx("p", { className: "swt-secthead", children: zh ? "这一步做了什么" : "What this step did" }, "didHead"),
							missionId === null || missionId === undefined || missionId === "" ? null : jsx("div", {
								style: { display: "flex", flexDirection: "column", gap: SPACE.xs, padding: "0 14px" },
								// THE SAME RENDERER THE TRAJECTORY PANE USES, filtered to
								// this step. Not a second row component: two renderers for
								// one row is how the drawer and the pane start saying
								// different things about the same call, and this row shape
								// already carries the kind, the agent, the verdict and the
								// latency banding that took three batches to get right.
								children: steps === null
									? jsx("div", {
										style: { font: FONT.small, color: stepsError === "" ? INK.secondary : `rgb(${TONE.warn})` },
										// Three states, not two: a read that has not come
										// back has the same shape as a step that did nothing.
										children: stepsError === ""
											? (zh ? "正在读这一步的轨迹…" : "Reading this step's trajectory…")
											: (zh ? "读不到这一步的轨迹：" : "Could not read this step's trajectory: ") + stepsError
									}, "loading")
									: steps.length === 0
									? jsx("div", {
										style: { font: FONT.small, color: INK.secondary },
										children: zh
											? "这一步没有留下任何轨迹 —— 它没有调用工具，也没有记录事件。"
											: "This step recorded no trajectory at all: no tool calls, no events."
									}, "empty")
									: steps.map((row) => jsx(MissionTraceRow, {
										row, zh, anchor,
										active: false,
										// A ROW IN HERE GOES WHERE THE JUMP BUTTON GOES. The
										// drawer has no panel of its own to open a row into,
										// and a row that does nothing when pressed says there
										// is somewhere to go and then refuses — so it opens
										// the trajectory on this step, which is the pane where
										// that row is selectable.
										onOpen: () => { onOpenStage?.(stage.stepId); }
									}, row.ref))
							}, "did"),
							jsx("div", {
								style: { padding: "10px 14px 0" },
								children: jsx("button", {
									type: "button",
									className: "swm-ctl swm-focus", style: { ...controlStyle(), font: FONT.small, height: CONTROL.sm, padding: "0 10px" },
									onClick: () => { onOpenStage?.(stage.stepId); },
									children: steps !== null && steps.length >= MISSION_STAGE_TRACE_TAKE
										// The list above is capped, and a capped list that
										// does not say so reads as the whole of it.
										? (zh ? `在轨迹里看全部（这里只显示前 ${MISSION_STAGE_TRACE_TAKE} 条）→` : `See all of it in the trajectory (the first ${MISSION_STAGE_TRACE_TAKE} are shown) →`)
										: (zh ? "在轨迹里看这一步 →" : "See this step in the trajectory →")
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

			// THE FIGURES COLUMN, right-aligned, over the shared cell. This table
			// used to declare its own head and cell and get BOTH wrong in the same
			// direction: the header had no padding at all and sat at the plain
			// weight, so it read as a first data row, and the cell bought its height
			// from a 26px line rather than from a height, so the roster's rows were
			// eight pixels taller than the tool table's on the same pane.
			const figure = { ...TD, textAlign: "right" };
			// NOT MONO ANY MORE. The column holds a chip with a word in it now, and
			// mono is for text a person compares character by character — a tool
			// name, a hash, an argument — which is what the figures to its right
			// are and what a role name is not.
			const name = { ...TD, textAlign: "left" };
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

			// THE FRAME THIS TABLE NEVER HAD. It was the one of the three with a
			// scroller and no border, so on the cost pane it sat under two framed
			// cards as a bare list — the same data at a different altitude, which
			// reads as an unfinished panel rather than as a third table.
			return jsx("div", {
				style: {
					border: `1px solid ${LINE.rule}`, borderRadius: RADIUS.md,
					overflow: "hidden", background: "var(--dsw-alias-bg-layer-1)"
				},
				children: jsx("div", {
					style: { overflowX: "auto" },
					children: jsxs("table", {
					style: { width: "100%", borderCollapse: "collapse", minWidth: "620px", tableLayout: "fixed" },
					children: [
						jsx("thead", {
							children: jsxs("tr", {
								style: { borderBottom: `1px solid ${LINE.rule}` },
								children: [
									// THE WIDTHS ARE DECLARED because `tableLayout:"fixed"` with
									// none divides the table into seven equal columns, and two of
									// these hold words while five hold four-digit figures. Left to
									// itself the roster would ellipsise 撰写 · 完成 to make room for
									// whitespace beside a 12.
									jsx("th", { style: { ...TH, width: "18%" }, children: zh ? "执行者" : "Agent" }, "agent"),
									jsx("th", { style: { ...TH, width: "22%" }, children: zh ? "停在" : "Last step" }, "step"),
									...columns.map((column) => jsx("th", { style: { ...TH, width: "12%", textAlign: "right" }, children: column.label }, column.id))
								]
							})
						}, "head"),
						jsx("tbody", {
							children: rows.map((row, at) => jsxs("tr", {
								className: "swm-tr",
								children: [
									// `agentId` is null until an agent actually runs; `role` is
									// what the planner named it. A table of "?" for every
									// agent the tier skipped is a table that looks broken.
									//
									// This is the ROSTER — the one table whose subject is who —
									// and it printed the raw id in the same mono face as the
									// token counts beside it, so the column that names people
									// looked like another column of data.
									jsx("td", {
										style: name,
										children: RoleChip({ agentId: row.agentId, role: row.role, zh, size: "sm" }) ?? "—"
									}, "agent"),
									jsx("td", {
										style: { ...TD, color: INK.secondary },
										children: row.lastStepId === null || row.lastStepId === undefined
											? "—"
											: `${missionFace(MISSION_STAGE_FACES, row.lastStepId, zh)} · ${missionFace(MISSION_STAGE_STATUS_FACES, row.state, zh)}`
									}, "step"),
									// TOKENS SHORT, EVERYTHING ELSE EXACT, and the split is
									// not a matter of column width. 40 calls versus 41 is a
									// comparison a reader actually makes — a researcher that
									// took one more turn than its neighbour is the thing
									// this table is read for — and 412,431 tokens versus
									// 412,208 is not. The exact figure stays one hover away
									// on every cell, so nothing is lost, only unstacked.
									...columns.map((column) => {
										const value = Number(column.of(row) ?? 0);
										return jsx("td", {
											style: {
												...figure,
												color: value === 0
													? INK.quiet
													: column.bad === true
														? "var(--dsw-alias-state-error-primary)"
														: column.good === true
															? "var(--dsw-alias-state-success-primary)"
															: INK.primary
											},
											title: String(value),
											children: column.id === "tokens" ? missionCompact(value) : String(value)
										}, column.id);
									})
								]
							}, `${row.agentId ?? "?"}-${at}`))
						}, "body"),
						jsx("tfoot", {
							children: jsxs("tr", {
								children: [
									jsx("td", { style: { ...TD, color: INK.secondary }, children: zh ? "合计" : "Total" }, "agent"),
									jsx("td", { style: TD, children: "" }, "step"),
									// THE SHORTHAND FIRST, AND THE FIGURES AGAIN AFTER IT. `TD`
									// sets `font` and then `fontVariantNumeric`; overriding `font`
									// on the spread puts a shorthand BELOW that variant in the
									// merged order and silently resets it, so the totals row would
									// stop lining up under the columns it totals — which is the one
									// row where that alignment is the entire point.
									...columns.map((column) => {
										const total = Number(totals[column.id] ?? 0);
										return jsx("td", {
											style: { ...TD, font: FONT.smallStrong, fontVariantNumeric: "tabular-nums", textAlign: "right" },
											title: String(total),
											children: column.id === "tokens" ? missionCompact(total) : String(total)
										}, column.id);
									})
								]
							})
						}, "foot")
					]
					})
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
			// The fourth copy of the tinted box, and the last: what stood here
			// was its own padding, its own alpha and its own type pair, which is
			// how the failure banner and the degrade banner ended up two
			// different widths on the same column. The sentence is the lead, the
			// 详情 toggle is the meta slot, and the raw text is the body.
			return Callout({
				tone: TONE.danger,
				icon: "alert",
				label: what,
				meta: raw === "" ? null : jsx("button", {
					type: "button",
					style: { font: FONT.small,
						appearance: "none", border: "none", background: "transparent", padding: 0,
						cursor: "pointer",
						color: "var(--dsw-alias-state-business-primary)"
					},
					onClick: () => { setOpen((was) => !was); },
					children: open ? (zh ? "收起详情" : "Hide details") : (zh ? "详情" : "Details")
				}),
				children: [
					next === "" ? null : jsx("div", { style: { color: INK.secondary }, children: next }, "next"),
					!open ? null : jsx("pre", {
						// The runtime's own words, verbatim, where the person who can
						// act on them will look. Not re-worded: two phrasings of one
						// failure is the same defect as two names for one method.
						style: { font: FONT.micro,
							fontFamily: MONO,
							margin: `${SPACE.sm} 0 0`, padding: `${SPACE.sm} 10px`, borderRadius: RADIUS.sm,
							background: SURFACE.subtle,
							whiteSpace: "pre-wrap", wordBreak: "break-word",
							color: INK.secondary
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
			// ONE DECIMAL, AND NEVER A TRAILING ZERO. `Math.round(n / 1000)`
			// collapsed 1,499 to `1k` and 1,501 to `2k` — a two-unit jump across
			// two tokens, in the one figure a person reads to compare two runs.
			// One decimal makes both of them `1.5k`.
			//
			// `412.0k` would be the opposite defect: a decimal place of precision
			// on a figure whose last three digits are noise, in a slot that exists
			// because the exact number did not fit. So a round thousand keeps its
			// round shape and the docblock's own example still holds.
			const short = (scale, unit) => {
				const scaled = (n / scale).toFixed(1);
				return (scaled.endsWith(".0") ? scaled.slice(0, -2) : scaled) + unit;
			};
			if (Math.abs(n) >= 1000000) return short(1000000, "M");
			if (Math.abs(n) >= 1000) return short(1000, "k");
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
			const hue = failed ? TONE.danger : terminal ? TONE.neutral : TONE.warn;
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

			// The fifth copy of the tinted box, on its own padding and its own
			// border. The first line is the lead — it is the one that says which
			// nothing this is — and the rest are the body.
			return Callout({
				tone: hue,
				icon: failed ? "alert" : terminal ? "check" : "clock",
				label: lines[0],
				children: jsx("div", {
					style: { display: "flex", flexDirection: "column", gap: SPACE.xs, color: INK.secondary },
					children: lines.slice(1).map((line, at) => jsx("div", { children: line }, `l${at}`))
				})
			});
		}

		/**
		* The four ways to arrange what was read, named once.
		*
		* All four are computable from fields the row already carries — findings,
		* host, verified, firstSeenAt — which is why there are four and not two:
		* the pane had a two-state toggle whose off position was UNNAMED. The
		* button read 按站点分组 while flat and 按引用次数排 while grouped, so
		* the label was always the arrangement you were not looking at, which is
		* the one control shape that cannot be read without pressing it.
		*/
		const MISSION_SOURCE_ORDERS = [
			{ id: "cites", zh: "按引用", en: "By citations" },
			{ id: "host", zh: "按站点", en: "By host" },
			// THE PANE THAT USED TO BE A TAB. 证据 was a sixth pane holding
			// dimension cards over the findings they produced, and every layer of
			// it was a third copy: the per-dimension verified counts are columns
			// in the task table, and a finding's quote is readable in the
			// trajectory and again under the report's own citations, where it is
			// the FROZEN evidence the signature was given against. What it alone
			// carried was this axis — which dimension a page was read for — so
			// the axis moved here and the tab went.
			{ id: "dim", zh: "按维度", en: "By dimension" },
			{ id: "rate", zh: "按核验率", en: "By verified rate" },
			{ id: "seen", zh: "按首次读到", en: "By first read" }
		];

		/**
		* One dimension, opened.
		*
		* THE CARD THAT WAS DELETED, PUT WHERE IT BELONGS. The 证据 pane drew a
		* dimension card per dimension and expanded it in place — two presses to
		* reach a quote, on a pane whose other two layers restated the task board
		* and the report. The pane went; this is the half of it that had no
		* second home: a dimension's rationale, how it stands against its floor,
		* and the findings it actually produced.
		*
		* A DRAWER, NOT AN EXPANSION. The references pane is a list whose rows are
		* already wide; opening one inline pushes every row below it down the
		* page, so the thing you were comparing against moves while you read.
		* `MissionDrawer` is the pattern the task board already uses for exactly
		* this, and reusing it is why the two read the same.
		* @param props - `{missionId, dimension, runCount, zh, onClose, onOpenSource}`.
		*/
		function MissionDimensionDrawer({ missionId, dimension, runCount, zh, onClose, onOpenSource }) {
			const [held, setHeld] = useState(null);
			const [error, setError] = useState("");
			const dimensionId = dimension === null || dimension === undefined ? null : dimension.id;

			useEffect(() => {
				if (dimensionId === null) return undefined;
				let alive = true;
				setHeld(null);
				setError("");
				const query = `?dimensionId=${encodeURIComponent(dimensionId)}`
					+ (runCount === null || runCount === undefined ? "" : `&runCount=${runCount}`);
				fetch(`${apiBase()}/missions/${encodeURIComponent(missionId)}/findings${query}`)
					.then(missionData)
					.then((data) => { if (alive) setHeld(data); })
					.catch((cause) => { if (alive) setError(String(cause?.message ?? cause)); });
				return () => { alive = false; };
			}, [missionId, dimensionId, runCount]);

			const detail = held?.dimension ?? null;
			const counts = held?.counts ?? null;
			const findings = Array.isArray(held?.findings) ? held.findings : [];
			// A null floor is NEUTRAL and prints no denominator. `?? 0` here would
			// be `/0` in another spelling: a dimension whose bar s3 has not derived
			// yet, drawn as having beaten it. The task board's chip makes the same
			// refusal — this is a second READER of that decision, not a second copy.
			const floor = detail?.gradeAxes?.floor ?? null;
			const verified = counts?.verified ?? null;
			const hasFloor = Number.isFinite(floor) && floor > 0;

			const finding = (row) => jsxs("div", {
				style: {
					display: "flex", flexDirection: "column", gap: SPACE.xs,
					paddingBottom: SPACE.md, borderBottom: `1px solid ${LINE.hair}`
				},
				children: [
					jsxs("div", {
						style: { display: "flex", alignItems: "flex-start", gap: SPACE.sm },
						children: [
							jsx("div", {
								style: { font: FONT.small, color: INK.primary, flex: 1, minWidth: 0 },
								children: jsx(MissionClamp, { text: row.claim ?? "", lines: 3, zh })
							}, "claim"),
							Chip({
								tone: missionHue(MISSION_VERIFY_FACES, row.verifyState),
								icon: missionIcon(MISSION_VERIFY_FACES, row.verifyState),
								label: missionFace(MISSION_VERIFY_FACES, row.verifyState, zh)
							}, "state")
						]
					}, "top"),
					(row.quote ?? "") === "" ? null : jsx("div", {
						// The quote is what a person checks the claim against, so it is
						// drawn as a quotation rather than as a second grey sentence
						// under it. The rule takes the verify state's own hue: a quote
						// that did not verify must not look like one that did.
						style: {
							font: FONT.small, color: INK.secondary,
							padding: `${SPACE.xs} ${SPACE.sm}`,
							borderLeft: `2px solid rgba(${missionHue(MISSION_VERIFY_FACES, row.verifyState)},${TINT.ring})`,
							background: SURFACE.subtle
						},
						children: jsx(MissionClamp, { text: row.quote, lines: 3, zh })
					}, "quote"),
					SourceLink({
						zh,
						title: sourceTitleOf(row.sourceTitle, "", row.sourceUrl),
						url: row.sourceUrl,
						host: row.sourceHost,
						verifyState: row.verifyState,
						meta: typeof onOpenSource !== "function" || (row.documentId ?? null) === null ? [] : [
							jsx("button", {
								type: "button",
								className: "swm-ctl swm-focus",
								style: { ...controlStyle(), height: CONTROL.xs, padding: `0 ${SPACE.sm}`, font: FONT.micro },
								onClick: () => { onOpenSource({ documentId: row.documentId, url: row.sourceUrl, title: row.sourceTitle }); },
								children: zh ? "读这一页" : "Read the page"
							}, "read")
						]
					}, "source")
				]
			}, row.id);

			return jsxs("div", {
				style: { display: "flex", flexDirection: "column", minHeight: 0, height: "100%" },
				children: [
					jsxs("div", {
						style: {
							flex: "none", display: "flex", alignItems: "center", gap: SPACE.sm,
							padding: `${SPACE.sm} ${SPACE.md}`, borderBottom: `1px solid ${LINE.rule}`
						},
						children: [
							jsx("div", {
								style: {
									font: FONT.smallStrong, color: INK.primary, flex: 1, minWidth: 0,
									overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap"
								},
								title: dimension?.name ?? "",
								children: dimension?.name ?? ""
							}, "name"),
							verified === null ? null : Chip({
								tone: !hasFloor ? TONE.neutral : verified >= floor ? TONE.success : TONE.warn,
								icon: !hasFloor ? undefined : verified >= floor ? "check" : "alert",
								label: hasFloor
									? (zh ? `已核验 ${verified}/${floor}` : `${verified}/${floor} verified`)
									: (zh ? `已核验 ${verified}` : `${verified} verified`)
							}, "verified"),
							jsx(IconButton, {
								label: zh ? "关闭" : "Close",
								size: CONTROL.xs,
								onClick: onClose,
								children: jsx(Icon, { name: "close", size: ICON.sm })
							}, "close")
						]
					}, "head"),
					jsx("div", {
						style: { flex: 1, minHeight: 0, overflowY: "auto", padding: SPACE.md },
						children: error !== ""
							? jsx("div", {
								style: { font: FONT.small, color: `rgb(${TONE.warn})` },
								children: (zh ? "读不到这个维度的发现：" : "Could not read this dimension's findings: ") + error
							})
							: held === null
								? jsx("div", { style: { font: FONT.small, color: INK.secondary }, children: zh ? "读取中…" : "Reading…" })
								: jsxs("div", {
									style: { display: "flex", flexDirection: "column", gap: SPACE.md },
									children: [
										// WHY THIS DIMENSION EXISTS, which is the one thing about it
										// that no count can say and that no other screen carries.
										(detail?.rationale ?? "") === "" ? null : jsx("div", {
											style: { font: FONT.small, color: INK.secondary },
											children: jsx(MissionClamp, { text: detail.rationale, lines: 3, zh })
										}, "why"),
										(detail?.summary ?? "") === "" ? null : jsx("div", {
											style: { font: FONT.small, color: INK.primary },
											children: detail.summary
										}, "account"),
										findings.length === 0
											? jsx("div", {
												style: { font: FONT.small, color: INK.secondary },
												// An absence WITH A REASON, never an empty box: "we
												// verified nothing" and "we have not looked yet" render
												// as the same blank rectangle and want opposite reactions.
												children: detail?.state === "pending"
													? (zh ? "还没有采集这个维度。" : "This dimension has not been collected yet.")
													: (zh ? "这个维度没有留下任何发现。" : "This dimension recorded no findings.")
											}, "none")
											: jsx("div", {
												style: { display: "flex", flexDirection: "column", gap: SPACE.md },
												children: findings.map(finding)
											}, "findings")
									]
								}, "body")
					}, "scroller")
				]
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
		function MissionSources({ missionId, zh, mission, onOpenSource }) {
			const [held, setHeld] = useState(null);
			// Which dimension the drawer is showing. ABOVE the early return, with
			// the other hooks: this component returns before the list when nothing
			// has been read, and a hook below that point runs on some renders and
			// not others.
			const [openDim, setOpenDim] = useState(null);
			const [error, setError] = useState("");
			const [run, setRun] = useState(null);
			const [order, setOrder] = useState("cites");
			// Grouping is ONE OF THE FOUR arrangements rather than a switch beside
			// them — see MISSION_SOURCE_ORDERS for why the old two-state toggle
			// could not be read without being pressed.
			const byHost = order === "host";

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
					style: { font: FONT.small, color: error === "" ? INK.secondary : `rgb(${TONE.warn})` },
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
				style: { display: "flex", alignItems: "center", gap: SPACE.sm, flexWrap: "wrap", margin: "0 0 10px" },
				children: [
					jsx("span", {
						style: { font: FONT.small, color: INK.secondary },
						children: zh ? "运行：" : "Run:"
					}, "label"),
					...runs.map((entry) => jsx("button", {
						type: "button",
						"aria-pressed": entry.runCount === current,
						className: "swm-ctl swm-focus", style: {
							...controlStyle(), height: CONTROL.xs, padding: "0 9px",
							font: entry.runCount === current ? FONT.microStrong : FONT.micro,
							color: entry.total === 0 ? INK.quiet : undefined,
							...pressedStyle(entry.runCount === current)
						},
						onClick: () => { setRun(entry.runCount); },
						children: zh
							? `第 ${entry.runCount} 次 · ${entry.verified}/${entry.total}`
							: `run ${entry.runCount} · ${entry.verified}/${entry.total}`
					}, `run-${entry.runCount}`))
				]
			}, "runs");

			// EVERY DIMENSION, EVEN WITH NOTHING UNDER IT. A page can feed more
			// than one dimension, so this is a fan-out rather than a partition and
			// the page counts do not sum to the row count; the heading says so
			// rather than hiding it.
			//
			// The empty groups are the reason this is not merely a sort. A
			// dimension that read two pages and verified nothing has no rows, and
			// dropping it would make a mission that half-failed look like a
			// mission that was half as ambitious. This is computed ABOVE the
			// no-sources return for the same reason: a run that read nothing at
			// all is exactly the run whose dimensions most need to say why.
			const byDimension = (Array.isArray(held.dimensions) ? held.dimensions : []).map((dimension) => {
				const rows = sources.filter((source) => (Array.isArray(source.dimensionIds) ? source.dimensionIds : [])
					.includes(dimension.dimensionId));
				return {
					id: dimension.dimensionId,
					name: dimension.name ?? dimension.dimensionId,
					state: dimension.state ?? null,
					summary: String(dimension.summary ?? ""),
					rows,
					findings: rows.reduce((sum, source) => sum + (source.findings ?? 0), 0)
				};
			});

			/** One dimension's group: its heading, and either its pages or its account. */
			const dimensionGroup = (entry) => jsxs("div", {
				children: [
					jsxs("div", {
						style: { display: "flex", alignItems: "center", gap: SPACE.sm, margin: `0 0 ${SPACE.xs}` },
						children: [
							// A BUTTON, because it opens something. It reads as the heading
							// it replaced — no border, no fill — but it takes the focus ring
							// and the pointer, so the one pressable thing in this row says
							// so before it is pressed. Only the NAME: a whole-row control
							// would swallow the source links underneath it.
							jsx("button", {
								type: "button",
								className: "swm-back swm-focus",
								"aria-label": zh ? `打开维度：${entry.name}` : `Open dimension: ${entry.name}`,
								onClick: () => { setOpenDim(entry); },
								style: {
									...backStyle(),
									font: FONT.smallStrong, color: INK.primary,
									height: "auto", padding: 0,
									minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap"
								},
								title: entry.name,
								children: entry.name
							}, "name"),
							jsx("span", {
								style: { ...COUNT_CHIP, flex: "none" },
								children: zh ? `${entry.rows.length} 页` : `${entry.rows.length} page(s)`
							}, "pages"),
							jsx("span", { style: { flex: 1 } }, "spacer"),
							entry.rows.length === 0 ? null : jsx("span", {
								style: { ...COUNT_CHIP, flex: "none" },
								children: zh ? `${entry.findings} 条发现` : `${entry.findings} finding(s)`
							}, "findings")
						]
					}, "head"),
					// THE DIMENSION'S OWN ACCOUNT, WHENEVER IT HAS ONE — not only when
					// the group is empty. The case this sentence exists for is a
					// dimension that READ and verified nothing: it has rows, so an
					// empty-only rule would print pages and say nothing about the
					// fact that none of them survived core-checking. That was the
					// 证据 pane's reason to exist and it must not be what the merge
					// drops.
					//
					// With no summary the fallback still separates the two empties.
					// A dimension nobody has collected yet and one that read and came
					// back with nothing want opposite reactions, and "no pages" says
					// neither.
					entry.summary === "" && entry.rows.length > 0 ? null : jsx("div", {
						style: { font: FONT.small, color: INK.secondary, margin: `0 0 ${SPACE.xs}` },
						children: entry.summary !== ""
							? entry.summary
							: entry.state === "pending"
								? (zh ? "还没有采集这个维度。" : "This dimension has not been collected yet.")
								: (zh ? "这个维度没有留下任何读过的页面。" : "This dimension left no page behind.")
					}, "account"),
					entry.rows.length === 0 ? null : jsx("div", {
						style: { display: "flex", flexDirection: "column", gap: SPACE.sm },
						children: entry.rows.map(row)
					}, "rows")
				]
			}, entry.id);

			if (sources.length === 0) {
				return jsxs("div", { children: [picker, jsx(MissionEmptyPane, {
					mission, zh,
					waiting: zh
						? "还没有读到任何一页 —— 采集阶段一开始，这里就会一条条长出来。"
						: "Nothing has been read yet. Entries appear here one page at a time once collection starts.",
					finished: zh
						? "这次运行结束时，一个来源也没有留下 —— 不是没显示，是确实一页都没读成。"
						: "This run ended with no sources at all — nothing is being hidden; not one page was read."
				}, "empty"),
				// AND WHY, PER DIMENSION. "Not one page was read" is the run's
				// answer; each dimension has its own, and this is the only screen
				// left that carries it. Without this the pane that replaced 证据
				// would be silent in exactly the case 证据 was most worth opening.
				byDimension.length === 0 ? null : jsx("div", {
					style: { display: "flex", flexDirection: "column", gap: SPACE.lg, marginTop: SPACE.lg },
					children: byDimension.map(dimensionGroup)
				}, "dims")] });
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


			// WHEN A PAGE WAS FIRST READ, as a number a comparator can use. A row
			// with no stamp sorts LAST rather than first: NaN in a comparator is a
			// sort that quietly stops sorting, and a page nobody stamped is not
			// the first thing this mission read.
			const seenAt = (value) => {
				const at = Date.parse(String(value ?? ""));
				return Number.isFinite(at) ? at : Number.POSITIVE_INFINITY;
			};
			// `cites` IS THE ROUTE'S OWN ORDER — `ORDER BY findings DESC` in the
			// store — and re-sorting it here would be a second copy of that
			// decision, drifting the first time either side is touched. It is left
			// alone on purpose, not by omission.
			const ordered = order === "rate"
				? [...sources].sort((a, b) => (missionRate(b.verified, b.findings) ?? -1) - (missionRate(a.verified, a.findings) ?? -1))
				: order === "seen"
					? [...sources].sort((a, b) => seenAt(a.firstSeenAt) - seenAt(b.firstSeenAt))
					: sources;

			const row = (source) => {
				const fed = (Array.isArray(source.dimensionIds) ? source.dimensionIds : [])
					.map((id) => names.get(id) ?? id).join(zh ? "、" : ", ");
				return SourceLink({
					zh,
					title: sourceTitleOf(source.title, "", source.url),
					url: source.url,
					// The host is the group's own heading when grouped, so repeating
					// it on every card underneath is the same word twenty times down
					// one column.
					host: byHost ? "" : source.host,
					meta: [
						jsx("span", {
							style: { ...COUNT_CHIP, flex: "none" },
							children: zh ? `${source.findings} 条发现` : `${source.findings} finding(s)`
						}, "findings"),
						// VERIFIED AGAINST THE PAGE, not merely recorded from it — and
						// now a mark rather than the third clause of five. A source
						// that produced six findings of which none verified is a source
						// that carried nothing, and one grey number in a row of grey
						// numbers cannot say that.
						//
						// THE HUE IS AN EQUALITY, not the 0.8/0.5 ladder the tiles use:
						// a page whose every finding held up is a different kind of fact
						// from one that mostly did, and this row is where that
						// difference is the reader's whole question. The GLYPH carries
						// it too — a bare coloured dot, which is what the reference
						// asked for, says nothing at all to a reader who cannot
						// separate the two tints.
						Chip({
							tone: source.verified === 0 ? TONE.muted
								: source.verified >= source.findings ? TONE.success
									: TONE.warn,
							icon: source.verified === 0 ? "minus"
								: source.verified >= source.findings ? "check" : "alert",
							label: zh ? `已核验 ${source.verified} 条` : `${source.verified} verified`
						}, "verified"),
						fed === "" ? null : jsx("span", {
							style: { minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" },
							title: fed,
							children: fed
						}, "dims"),
						source.firstSeenAt === null || source.firstSeenAt === undefined ? null : jsx("span", {
							style: { flex: "none", fontFamily: MONO },
							children: formatStamp(source.firstSeenAt)
						}, "seen")
					]
				}, source.url);
			};

			// THE DRAWER IS A SIBLING OF THE LIST, not a child of a group. Two
			// groups each owning their own open state is two drawers, and the
			// second renders behind the first.
			const drawer = jsx(MissionDrawer, {
				open: openDim !== null,
				onClose: () => { setOpenDim(null); },
				children: openDim === null ? null : jsx(MissionDimensionDrawer, {
					missionId, dimension: openDim, runCount: run, zh,
					onClose: () => { setOpenDim(null); },
					onOpenSource
				})
			}, "dimDrawer");

			return jsxs("div", {
				children: [
					drawer,
					picker,
					// THE FOURTH DOT-JOINED SENTENCE, and the last one this batch
					// reaches. Four figures — findings, sources, hosts, verified —
					// were one 12px grey clause, and the one a reader is actually
					// here for is the last of the four: how much of what was read
					// held up. It is a tile with a rate under it now.
					MissionStatTiles({ tiles: [
						{ label: zh ? "发现" : "Findings", value: String(totals.findings) },
						{
							label: zh ? "已核验" : "Verified",
							value: String(totals.verified),
							// THE COVERAGE LADDER, shared with the report's scorecard and
							// the reference list rather than typed a third time here. Its
							// "not green at nought" rule — nothing recorded means nothing
							// to have verified, and `verified >= total` is true at zero —
							// now lives inside `missionRateHue` where all three readers
							// get it.
							tone: missionRateHue(totals.verified, totals.findings),
							meter: missionRate(totals.verified, totals.findings),
							hint: totals.findings === 0 ? "" : `${Math.round((totals.verified / totals.findings) * 100)}%`
						},
						{ label: zh ? "来源" : "Sources", value: String(totals.sources) },
						{ label: zh ? "站点" : "Hosts", value: String(totals.hosts) }
					] }, "totals"),
					// The spacer that used to push this control away from the totals
					// went with the totals. One element in a row does not need
					// something empty beside it to be on the right.
					jsxs("div", {
						style: { display: "flex", alignItems: "center", justifyContent: "flex-end", gap: SPACE.md, flexWrap: "wrap", margin: `0 0 ${SPACE.sm}` },
						children: [
							jsx("div", {
								style: SEGMENT_TRACK,
								role: "group",
								"aria-label": zh ? "来源排列方式" : "How to arrange the sources",
								children: MISSION_SOURCE_ORDERS.map((mode) => jsx("button", {
									type: "button",
									"aria-pressed": order === mode.id,
									className: "swm-focus",
									style: segmentStyle(order === mode.id),
									onClick: () => { setOrder(mode.id); },
									children: zh ? mode.zh : mode.en
								}, mode.id))
							}, "orders")
						]
					}, "head"),
					order === "dim" ? jsx("div", {
						style: { display: "flex", flexDirection: "column", gap: SPACE.lg },
						children: byDimension.map(dimensionGroup)
					}, "dims") : !byHost ? jsx("div", {
						style: { display: "flex", flexDirection: "column", gap: SPACE.sm },
						children: ordered.map(row)
					}, "flat") : jsx("div", {
						style: { display: "flex", flexDirection: "column", gap: SPACE.lg },
						children: grouped.map((entry) => jsxs("div", {
							children: [
								jsxs("div", {
									style: { display: "flex", alignItems: "center", gap: SPACE.sm, margin: `0 0 ${SPACE.xs}` },
									children: [
										jsx("span", {
											style: {
												font: FONT.smallStrong, fontFamily: MONO, color: INK.primary,
												minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap"
											},
											children: entry.host
										}, "name"),
										jsx("span", {
											style: { ...COUNT_CHIP, flex: "none" },
											children: zh ? `${entry.rows.length} 页` : `${entry.rows.length} page(s)`
										}, "pages"),
										jsx("span", { style: { flex: 1 } }, "spacer"),
										jsx("span", {
											style: { ...COUNT_CHIP, flex: "none" },
											children: zh ? `${entry.findings} 条发现` : `${entry.findings} finding(s)`
										}, "findings")
									]
								}, "host"),
								// THE COMPARISON THE GROUPING EXISTS TO ANSWER, which was a
								// `·` between two numbers. The question on this pane is
								// whether one site is holding the whole report up, and the
								// answer to that is a LENGTH beside the length above it —
								// not two figures three rows apart that the reader has to
								// divide by eye.
								//
								// Measured against the biggest host rather than against the
								// total, because the total is already four tiles up and what
								// is being compared here is hosts to each other.
								Meter({
									value: entry.findings, max: grouped[0].findings, tone: TONE.info,
									style: { margin: `0 0 ${SPACE.sm}` }
								}, "share"),
								jsx("div", {
									style: { display: "flex", flexDirection: "column", gap: SPACE.sm },
									children: entry.rows.map(row)
								}, "rows")
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
		// FIVE, and 证据 is the one that went. It held dimension cards over their
		// findings, and every layer of it was stated somewhere better: the
		// per-dimension verified counts are columns in the task table, and a
		// finding's quote reads in the trajectory and again under the report's own
		// citations — where it is the FROZEN evidence the signature was given
		// against, rather than live rows that a rerun moves. Its one unique axis,
		// which dimension a page was read for, is now an arrangement on 参考文献.
		const MISSION_PANES = ["tasks", "trace", "report", "sources", "cost"];

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
				// The findings count rides on 参考文献 now. It was the evidence
				// tab's count and it is still the same number — what was read is
				// what produced them — so losing the tab must not lose the figure.
				{ id: "sources", label: zh ? "参考文献" : "References", count: findings },
				{ id: "cost", label: zh ? "成本" : "Cost", count: null }
			];
			// THE THIRD TAB VOCABULARY, RETIRED. This strip was a segmented pill
			// track — a `fill-tertiary` rail, a raised thumb, `aria-pressed` — one
			// screen away from a page strip that underlines and a trajectory strip
			// that underlines. A segmented control says "the same content,
			// arranged differently"; these six are six different pages of one
			// mission, which is what a tab says. It underlines now, off the same
			// `.swm-tab` the other two wear.
			//
			// `aria-selected` REPLACES `aria-pressed`, and it is not a rename:
			// `aria-pressed` on a bare button announces a toggle that is down,
			// which is what six mutually exclusive panes are not, and it is also
			// the attribute the shared CSS matches to draw the underline. The
			// row is a real `tablist` of real `tab`s for the same reason.
			const strip = jsx("div", {
				role: "tablist",
				className: "swm-tabbar",
				style: {
					display: "flex", alignItems: "center", gap: SPACE.md,
					flex: 1, minWidth: 0,
					overflowX: "auto", overflowY: "hidden", scrollbarWidth: "none"
				},
				children: panes.map((entry) => {
					const on = entry.id === pane;
					return jsxs("button", {
						type: "button",
						role: "tab",
						className: "swm-tab",
						"aria-selected": on,
						onClick: () => { setPane(entry.id); },
						style: {
							// The same 13px pair as the page strip and the
							// trajectory strip, so a label does not shift under the
							// pointer when its pane opens.
							font: on ? FONT.bodyStrong : FONT.body,
							display: "flex", alignItems: "center", gap: SPACE.xs,
							padding: `${SPACE.sm} 2px 10px`,
							color: on ? "var(--dsw-alias-state-business-primary)" : INK.secondary
						},
						children: [
							jsx("span", { children: entry.label }, "label"),
							// A BADGE, not grey text. "6" beside a pane name in
							// `INK.quiet` reads as an artefact of the label rather
							// than as the answer to how many, and `INK.quiet` is the
							// decoration weight — 3.71:1, under what a value the
							// reader has to read is allowed to be.
							entry.count === null || entry.count === 0 ? null : jsx("span", {
								style: COUNT_CHIP,
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
			// THE RULE RUNS UNDER THE WHOLE ROW, not just under the six tabs,
			// which is why the border is here and not on the tablist: a hairline
			// that stops where the tabs stop draws a line to nowhere with the
			// spend hanging off the end of it. `flex-end` puts the spend on the
			// tabs' baseline instead of on their optical centre.
			//
			// AND THE ROW NO LONGER WRAPS. It could, and the strip is the one
			// thing on this screen that must not: a second line of tabs appearing
			// under the first at a narrow width reads as twelve panes. The strip
			// scrolls instead.
			return jsxs("div", {
				style: {
					display: "flex", alignItems: "flex-end", gap: SPACE.md,
					margin: `0 0 ${SPACE.md}`,
					borderBottom: `1px solid ${LINE.rule}`
				},
				children: [
					strip,
					(spend ?? "") === "" ? null : jsx("span", {
						style: { font: FONT.micro, fontFamily: MONO, fontVariantNumeric: "tabular-nums",
							flex: "none", paddingBottom: "10px", color: INK.quiet
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
			// ABOVE THE EARLY RETURNS, and that is the whole reason it is here
			// rather than beside the flag that reads it. This component returns
			// early three times — loading, error, and the source reader — so a
			// `useState` written further down runs on some renders and not
			// others, and React counts hooks by call order: the render that
			// crosses from loading to ready calls one more than the last one did
			// and throws before it paints. It is not a subtle failure. The tab
			// does not open.
			//
			// The render harness in tests/settings.test.mjs does NOT catch this:
			// it stores hook slots by call order per instance and simply grows
			// the array, so a conditional hook works there and only there. The
			// source guard in tests/design-tokens.test.mjs is what holds it.
			const [failureOpen, setFailureOpen] = useState(false);

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
				// WITH THE BACK CONTROL, not without it. A slow first read that
				// offers no way out is a tab a person has to close the whole page
				// to leave.
				return jsxs("div", {
					// WIDE_STYLE, matching the screen this becomes. It was
					// CONTENT_STYLE — a 1080px cap the built view does not have —
					// so on a wide overlay the whole page slid sideways at the
					// moment the answer landed, which is the one jump a skeleton
					// exists to remove.
					style: { ...WIDE_STYLE, padding: "0 24px" },
					children: [
						jsx("button", {
							type: "button", className: "swm-back swm-focus", style: backStyle(), onClick: onBack,
							children: [jsx(Icon, { name: "arrowLeft", size: ICON.xs }, "glyph"), zh ? "返回任务列表" : "Back to missions"]
						}, "back"),
						// THE REAL FRAME, in the real order: the header row, the meta
						// line, the tab strip on its rule, then the panes. This
						// screen is the one where a dashed box cost the most — the
						// built view is five stacked regions and the read behind it
						// is the slowest in the tab.
						SkeletonScreen({
							zh,
							style: { display: "flex", flexDirection: "column", gap: SPACE.md, marginTop: SPACE.md },
							children: [
								jsxs("div", {
									style: { display: "flex", alignItems: "center", gap: SPACE.sm },
									children: [
										Skeleton({ w: "88px", h: "28px", r: RADIUS.sm }, "back"),
										Skeleton({ w: "220px", h: "20px" }, "topic"),
										Skeleton({ w: "64px", h: "18px", r: RADIUS.pill }, "pill")
									]
								}, "bar"),
								Skeleton({ w: "60%", h: "12px" }, "meta"),
								jsxs("div", {
									// Six labels over the strip's own hairline. The
									// spec asked for six pills in a tinted track,
									// which is what this strip was before it became
									// an underlined tablist; a skeleton drawn to a
									// retired shape is a page that jumps twice.
									style: {
										display: "flex", alignItems: "center", gap: SPACE.lg,
										padding: "0 0 10px", borderBottom: `1px solid ${LINE.rule}`
									},
									children: [0, 1, 2, 3, 4, 5].map((at) => Skeleton({ w: "48px", h: "14px" }, "t" + at))
								}, "tabs"),
								...[0, 1, 2].map((at) => jsx("div", {
									style: { ...CARD_STYLE, marginBottom: 0, height: "96px" }
								}, "card" + at))
							]
						}, "skeleton")
					]
				});
			}
			if (state === "error" && view === null) {
				return jsxs("div", {
					style: { ...WIDE_STYLE, padding: "0 24px" },
					children: [
						jsx("button", {
							type: "button", className: "swm-back swm-focus", style: backStyle(), onClick: onBack,
							children: [jsx(Icon, { name: "arrowLeft", size: ICON.xs }, "glyph"), zh ? "返回任务列表" : "Back to missions"]
						}, "back"),
						// THE ONLY CONTROL ON THIS SCREEN USED TO BE THE ONE THAT
						// LEAVES IT. A mission whose view route blipped could only be
						// re-read by going back to the list and opening it again —
						// two navigations to repeat one GET.
						ErrorBox({
							title: zh ? "读不到这个任务" : "Could not read this mission",
							message: error,
							endpoint: `${apiBase()}/missions/${missionId}/view`,
							onRetry: () => { setTick((value) => value + 1); },
							zh
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

			// SEVEN FIGURES IN ONE SENTENCE was the shape, and two of them have
			// left it. The stage fraction is the bar's now — it is drawn AND
			// spelled there — and the elapsed clock is a tile, where it sits
			// beside the wall-clock ceiling it is running out of. Stating either
			// one twice on the same screen is the defect this whole batch is
			// about.
			//
			// THE DIMENSION AND CHAPTER FRACTIONS STAY. They are not progress in
			// the same sense: they say WHICH of the three ran short, they have no
			// tile and no bar, and nothing else on this screen carries them.
			const meta = [
				missionFace(MISSION_TIER_FACES, mission.depth, zh),
				zh ? `第 ${mission.runCount} 次运行` : `run ${mission.runCount}`,
				progress.dimensionsTotal > 0
					? (zh ? `维度 ${progress.dimensionsResolved}/${progress.dimensionsTotal}` : `dimensions ${progress.dimensionsResolved}/${progress.dimensionsTotal}`)
					: "",
				progress.chaptersTotal > 0
					? (zh ? `章节 ${progress.chaptersDone}/${progress.chaptersTotal}` : `chapters ${progress.chaptersDone}/${progress.chaptersTotal}`)
					: "",
				formatStamp(mission.startedAt)
			].filter((piece) => piece !== "").join(" · ");

			// WHAT IS LEFT of the strip's spend line. Tokens and the score moved
			// up into the tiles, four inches higher and in the same viewport, so
			// keeping them here as well would be the same two figures twice on
			// one screen. Calls is the one spend figure with no tile — a tile for
			// it would be a fifth column of the same fact the token tile already
			// carries a ceiling for — and the strip is where it already lived.
			const spend = zh ? `调用 ${view.cost?.calls?.used ?? 0} 次` : `${view.cost?.calls?.used ?? 0} calls`;

			// THE FOUR FIGURES A PERSON OPENS THIS SCREEN FOR. Every one of them
			// was inside a dot-joined string: two in the meta line above and two
			// on the tab strip below, at 11px, in the decoration weight.
			//
			// The token hue is `missionLadderHue` — the SAME function the six
			// ceiling meters read, not a second copy of 0.9 and 0.7 written up
			// here. That was the whole reason the ternary came out of
			// MissionCostMeters' map.
			const tokenMeter = view.cost?.tokens ?? null;
			const wallLimit = missionDuration(view.cost?.wall?.limit, zh);
			// Whether the reader has asked why this run failed. The STATE is
			// declared with the other hooks at the top of this component; only
			// the derived flag belongs here, where `mission` exists.
			const hasFailure = (mission.errorMessage ?? "") !== "" || (mission.failureCode ?? null) !== null;
			const statTiles = [
				{
					label: zh ? "令牌" : "Tokens",
					value: missionCompact(tokenMeter?.used ?? 0),
					tone: missionLadderHue(tokenMeter?.ratio, view.cost?.ladder),
					hint: tokenMeter === null ? "" : missionMeterLine(tokenMeter, zh)
				},
				{
					label: zh ? "评分" : "Score",
					// null, not 0. `score ?? 0` would hand an unfinished run a
					// failing grade it was never given — MetricStat's em dash is
					// the file's own word for "not measured".
					value: mission.score === null || mission.score === undefined ? null : String(mission.score),
					tone: TONE.accent,
					hint: mission.verdict ?? ""
				},
				{
					label: zh ? "已用" : "Elapsed",
					value: missionDuration(mission.elapsedMs, zh),
					tone: TONE.info,
					hint: wallLimit === "" ? "" : (zh ? `上限 ${wallLimit}` : `ceiling ${wallLimit}`)
				},
				{
					label: zh ? "已核验" : "Verified",
					value: String(evidence.verified ?? 0),
					// GREEN IS NOT THE DEFAULT. A run that recorded nothing at all
					// has a verified count of nought and a total of nought, and
					// painting that success is the clean bill the report tallies
					// were already caught giving. Nothing recorded is neutral;
					// something recorded and none of it verified is red.
					tone: (evidence.total ?? 0) === 0
						? TONE.neutral
						: (evidence.verified ?? 0) > 0 ? TONE.success : TONE.danger,
					hint: zh ? `共 ${evidence.total ?? 0} 条发现` : `of ${evidence.total ?? 0} recorded`
				}
			];

			// The mission's four actions, hoisted so they can sit on the header
			// row rather than under it. They were a row of their own, which cost
			// 34px plus its margin above a list whose value is how many rows fit.
			const missionActions = [
				mission.terminal ? null : jsx("button", {
					type: "button",
					disabled: busy !== "",
					className: "swm-ctl swm-focus", style: { ...controlStyle(busy !== ""), font: FONT.small, height: CONTROL.sm, padding: "0 10px", flex: "none" },
					onClick: () => { void act("cancel"); },
					children: busy === "cancel" ? (zh ? "正在中止…" : "Cancelling…") : (zh ? "中止" : "Cancel")
				}, "cancel"),
				!resume.offered ? null : jsx("button", {
					type: "button",
					disabled: busy !== "",
					title: resume.detail ?? "",
					className: "swm-ctl swm-focus", style: { ...controlStyle(busy !== ""), font: FONT.small, height: CONTROL.sm, padding: "0 10px", flex: "none" },
					onClick: () => { void act("resume"); },
					children: busy === "resume" ? (zh ? "正在继续…" : "Resuming…") : (zh ? "从检查点继续" : "Resume")
				}, "resume"),
				!mission.terminal ? null : jsx("button", {
					type: "button",
					disabled: busy !== "",
					className: "swm-ctl swm-focus", style: { ...controlStyle(busy !== ""), font: FONT.small, height: CONTROL.sm, padding: "0 10px", flex: "none" },
					onClick: () => { void act("rerun", { mode: "fresh" }); },
					children: busy === "rerun" ? (zh ? "正在重跑…" : "Rerunning…") : (zh ? "全新重跑" : "Rerun from scratch")
				}, "rerun"),
				!mission.terminal ? null : jsx("button", {
					type: "button",
					disabled: busy !== "",
					className: "swm-ctl swm-focus", style: { ...controlStyle(busy !== ""), font: FONT.small, height: CONTROL.sm, padding: "0 10px", flex: "none" },
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
					className: "swm-ctl swm-focus", style: { ...controlStyle(), font: FONT.small, height: CONTROL.sm, padding: "0 10px", flex: "none", display: "inline-flex", alignItems: "center", textDecoration: "none" },
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
						padding: "0 16px", height: "100%", minHeight: 0, flex: "1 1 auto",
						display: "flex", flexDirection: "column"
					},
					children: [
						// ONE ROW: back, title, status, actions. This was four stacked
						// blocks, and with the banner and the tab strip under them the
						// first row of actual content began 396px down a 1050px
						// screen — thirty-eight per cent of the window spent on
						// chrome, above a list whose whole value is how many rows fit.
						// A BAND, NOT A ROW FLOATING IN THE GUTTER. This header is the
						// reader's fixed point — which mission this is, how far it got,
						// and how to leave — and it was drawn as four unbordered items
						// on the same background as the pane beneath them, so nothing
						// on the screen said where the chrome stopped and the content
						// began. The negative margin is the escape from the frame's
						// own 24px gutter that the pane scroller already uses further
						// down this component; it is a proven move here, not a new one.
						jsxs("div", {
							style: {
								display: "flex", alignItems: "center", gap: SPACE.md, flexWrap: "wrap",
								padding: `${SPACE.sm} ${SPACE.lg}`, margin: `0 -${SPACE.lg} ${SPACE.sm}`,
								borderBottom: `1px solid ${LINE.rule}`, background: SURFACE.subtle
							},
							children: [
								jsx("button", {
									type: "button",
									className: "swm-back swm-focus", style: { ...backStyle(), font: FONT.small, height: CONTROL.sm, padding: "0 10px", flex: "none" },
									onClick: onBack,
									children: [jsx(Icon, { name: "arrowLeft", size: ICON.xs }, "glyph"), zh ? "任务" : "Missions"]
								}, "back"),
								// THE RUN'S OWN MARK, in the Leader's hue and drawn from
								// the Leader's glyph. This screen is where every role's
								// work is gathered under one owner, and the roster below
								// it already paints that owner this colour — so the
								// mark is the identity ramp doing its job, not a
								// decoration picked to fill the corner.
								jsx("div", {
									style: {
										flex: "none", width: CONTROL.sm, height: CONTROL.sm, borderRadius: RADIUS.md,
										display: "flex", alignItems: "center", justifyContent: "center",
										background: `rgba(${roleTone("leader")},${TINT.soft})`, color: `rgb(${roleTone("leader")})`
									},
									children: jsx(Icon, { name: ROLE_ICON.leader, size: ICON.md }, "glyph")
								}, "mark"),
								// TITLE AND META ARE ONE BLOCK. The meta line used to be
								// a SIBLING of this row — a second line of grey text
								// under it, belonging to neither the header nor the
								// pane — so the two halves of the answer to "which run
								// is this, and when" were separated by an edge.
								jsxs("div", {
									style: { flex: "1 1 200px", minWidth: 0, display: "flex", flexDirection: "column" },
									children: [
										jsx("h2", {
											style: { font: FONT.largeStrong,
												margin: 0, minWidth: 0,
												overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
												color: INK.primary
											},
											title: mission.topic,
											children: mission.topic
										}, "topic"),
										jsx("div", { style: META_STYLE, children: meta }, "meta")
									]
								}, "who"),
								// The same state pill the list row carries, one size up
								// because it sits beside a 16px title — not one radius
								// and one padding away from it, which is what the two
								// literals used to be.
								// A CHIP WHEN THERE IS NOTHING BEHIND IT, A BUTTON WHEN
								// THERE IS. A control that opens nothing is worse than a
								// label — it says there is somewhere to go — so the
								// pressable form exists only for a run that actually
								// recorded a failure to show.
								hasFailure
									? jsx("button", {
										type: "button",
										className: "swm-focus",
										"aria-label": zh ? `失败详情：${face.label}` : `Failure details: ${face.label}`,
										title: zh ? "看这次失败的原始报错" : "Read the raw failure",
										onClick: () => { setFailureOpen(true); },
										style: {
											appearance: "none", border: "none", background: "transparent",
											padding: 0, cursor: "pointer", display: "inline-flex"
										},
										children: Chip({
											tone: face.hue, pill: true, size: "sm", icon: face.icon,
											label: face.note === "" ? face.label : `${face.label} · ${face.note}`
										}, "pill")
									}, "pill")
									: Chip({
										tone: face.hue, pill: true, size: "sm", icon: face.icon,
										label: face.note === "" ? face.label : `${face.label} · ${face.note}`
									}, "pill"),
								...missionActions
							]
						}, "bar"),
						// ONLY WHILE IT IS STILL RUNNING. A finished mission's
						// progress is its outcome, which the pill above states in a
						// word; a full green bar under a completed run is a control
						// surface reporting the obvious, and a bar frozen at 58%
						// under a failed one invites the reader to wait for it.
						mission.terminal === true ? null : jsx(MissionProgressBar, {
							progress, face, elapsedMs: mission.elapsedMs, zh
						}, "progress"),

						// THREE NOTICES THAT WERE NEVER BANNERS. All three were bare
						// coloured text — no box, no mark, no cap — sitting directly
						// under the header while the same file drew a tinted banner
						// three times elsewhere. The one that mattered is the
						// middle: an action error carries a RESPONSE BODY, and a
						// 409's body is a paragraph that used to push the whole
						// header stack down the page. The Callout caps its own body
						// and scrolls it.
						notice === "" ? null : Callout({ tone: TONE.info, icon: "clock", children: notice }, "notice"),
						actionError === "" ? null : Callout({ tone: TONE.danger, icon: "alert", children: actionError }, "actionError"),
						// A refresh that failed over a view we already have. Without
						// this line the page keeps drawing the last good answer with
						// a clock that never moves, which is the most convincing
						// wrong screen this tab can produce.
						state !== "error" ? null : Callout({
							tone: TONE.warn,
							icon: "refresh",
							label: zh ? "这一次刷新失败了，下面是上一次读到的状态：" : "The latest refresh failed; what follows is the last state that was read:",
							children: error
						}, "staleView"),
						// THE FAILURE IS NOT A BAND ACROSS THE TOP. It was: a tinted
						// box with a glyph, a lead, a next-step sentence and a 详情
						// toggle, sitting above the tiles and the ruler on the one
						// screen whose next element is a table. Three of those four
						// lines are the same fact the 失败 pill in the header already
						// states, and the fourth — the provider's own words — is what
						// the reader actually needs, one press away rather than
						// permanently on screen.
						//
						// So the pill became the door. It is where a person looks to
						// answer "did this work"; pressing it opens the diagnosis in
						// the dialog this file already has, and the main window keeps
						// the height for the rows.
						// Sign-off, when there is one. `signed: null` means s11 never
						// ran; `false` means the Leader read the report and refused.
						// Different failures, different next actions.
						mission.signed === null || mission.signed === undefined ? null : jsx(MissionSignoffCard, { mission, zh }, "signature"),
						// Not when the banner above already said why. "The mission
						// ended without a report" under "budget_exhausted: calls
						// reached 40 of 40" is the same sentence twice, and the
						// second one costs a row of the list below it.
						hasReport || (mission.errorMessage ?? "") !== "" ? null : jsx("div", {
							style: { font: FONT.small, margin: "0 0 14px", color: INK.secondary },
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
						// NO TILE ROW HERE, AND THAT IS THE POINT. The four figures it
						// carried — tokens, score, elapsed, verified — are each stated
						// again inside one screen: tokens and elapsed on the 成本 pane,
						// verified as the 证据 count on the tab strip eight pixels below,
						// and the score is a number a failed run does not have (it read
						// 0, which is not "zero quality" but "never graded"). Four
						// tinted boxes restating the row above them cost 100px of a
						// window whose next element is a table, and a table is the one
						// thing on this screen that gets better with height.
						//
						// MissionStatTiles itself stays — six other screens use it for
						// figures that ARE their screen's subject.
						// The diagnosis, out of the flow. `SwarmModal` returns null
						// when it is shut, so a run that did not fail — and a failed
						// run nobody has asked about — renders nothing at all here.
						!hasFailure ? null : jsx(SwarmModal, {
							open: failureOpen,
							onClose: () => { setFailureOpen(false); },
							title: zh ? "这次运行为什么失败" : "Why this run failed",
							zh,
							children: jsx(MissionFailureNote, {
								code: mission.failureCode ?? null,
								message: mission.errorMessage ?? "",
								zh
							})
						}, "failureDialog"),
						// NO RULER HERE EITHER. The twelve-stage strip and the task
						// table under it are the same twelve rows: the table carries
						// each stage's status, its owner, its duration AND a way into
						// its trajectory, and the strip carried the first two in a
						// shape that had to be learned. Two drawings of one list, and
						// the weaker one was on top.
						//
						// The strip survives as a component because the task board's
						// own header is where a ruler earns its place — beside the rows
						// it indexes, not stacked above a copy of them.
						// THE SECOND AXIS, and it starts HERE rather than at the top of
								jsxs("div", {
									// `minWidth: 0` IS LOAD-BEARING. A flex child's default
									// minimum is its content, and the panes hold tables with
									// their own `minWidth` — without it the tables would push
									// this column wider than the frame and the rail would be
									// scrolled off the left of the page instead of the table
									// scrolling inside its own card.
									style: { flex: 1, minWidth: 0, minHeight: 0, display: "flex", flexDirection: "column" },
									children: [
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
										// NO MissionPanel WRAPPER HERE. The board mounts its own, because
										// the count and the status key in that header are arithmetic only
										// the board has done — see the note at its return.
										jsx(MissionTaskBoard, {
											mission,
											stages: view.stages ?? [],
											work: view.work ?? [],
											agents: view.agents ?? [],
											zh,
											selected: task,
											onSelect: (stepId) => { setTask(stepId); },
											onOpenStage: (stepId) => { setFocusStep(stepId); setPane("trace"); }
										}, "board"),
										// THE BRIEF, ABOVE THE JUDGING. Every row on the board is being
										// measured against this and it was on the wire and on no screen.
										mission.goals === null || mission.goals === undefined ? null : jsx(MissionPanel, {
											title: zh ? "立项目标" : "Mission goals",
											note: zh
												? "领队立项时写下的，原样呈现"
												: "written by the leader when the mission was opened, verbatim",
											children: jsx(MissionGoals, { goals: mission.goals, zh })
										}, "goals"),
										preflight === null || (preflight.messages ?? []).length === 0 ? null : jsx(MissionPanel, {
											title: zh ? "核验风险" : "Verification risk",
											count: preflight.messages.length,
											note: preflight.known
												? (zh ? "已经过核验阶段" : "measured after the verify stage")
												: (zh ? "核验阶段还没跑完，这是临时值" : "provisional: the verify stage has not run yet"),
											children: jsx("div", {
												style: { display: "flex", flexDirection: "column", gap: SPACE.sm },
												children: preflight.messages.map((message, at) => jsx("div", {
													style: { font: FONT.small, color: INK.secondary },
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
											count: view.swept.length,
											note: zh ? "这些是显示层的修补，不是任务本身的输出" : "display-time repairs, not the mission's own output",
											children: jsx("div", {
												style: { display: "flex", flexDirection: "column", gap: SPACE.sm },
												children: view.swept.map((entry, at) => jsx("div", {
													style: { font: FONT.small, color: INK.secondary },
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
											// The same reader every other pane opens a page in. A
											// finding in the dimension drawer reaches the page it
											// was verified against without leaving the mission.
											children: jsx(MissionSources, {
												missionId, zh, mission,
												onOpenSource: (entry) => { setSource(entry); }
											})
										}, "sources")
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
										jsx(MissionPanel, {
											title: zh ? "返工" : "Rework",
											note: zh
												? "花了两次的部分 —— 缓存是省下的，所以它是绿的"
												: "what was paid for twice — cache hits are the saving, which is why they are green",
											children: jsx(MissionRework, { waste: view.cost?.waste ?? null, zh })
										}, "rework"),
										(view.cost?.byStage ?? []).length === 0 ? null : jsx(MissionPanel, {
											title: zh ? "哪一步花的" : "Which stage spent it",
											count: view.cost.byStage.length,
											note: zh
												? "按阶段分解 —— 一份总数说不出是哪一步在烧"
												: "broken down by stage — one total cannot say which step is burning it",
											children: jsx(MissionStageSpend, { byStage: view.cost.byStage, zh })
										}, "byStage"),
										(view.cost?.byTool ?? []).length === 0 ? null : jsx(MissionPanel, {
											title: zh ? "哪个工具在失败" : "Which tool is failing",
											count: view.cost.byTool.length,
											note: zh
												? "失败和缓存都算在调用里 —— 一次失败的抓取和一次命中缓存都花了额度"
												: "failures and cache hits are calls too — both spent the allowance",
											children: jsx(MissionToolTable, { byTool: view.cost.byTool, zh })
										}, "byTool"),
										(view.agents ?? []).length === 0 ? null : jsx(MissionPanel, {
											title: zh ? "谁花的" : "Who spent it",
											count: view.agents.length,
											note: zh
												? "按执行者分解 —— 一份总数说不出哪个维度在返工"
												: "broken down by agent — one total cannot say which dimension was redoing its work",
											children: jsx(MissionAgentTable, { agents: view.agents, zh })
										}, "agents")
										])
											]
										}, "paneBody")
									]
								}, "workbench")
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
		const MISSION_SOURCE_KIND = { id: "other", type: "", en: "Source", zh: "信源", hue: TONE.neutral };

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
			const accent = verified ? TONE.success : TONE.warn;
			// THE SAME FOUR-STEP FALLBACK THE SOURCE CARDS USE, so one page named
			// on this row and on the sources pane is named the same thing. This
			// was the third hand-written copy of the ladder, and it was the short
			// one: title, host, host — no path segment at all, so a titleless page
			// on a site with twenty of them was indistinguishable from the other
			// nineteen. `sourceHost` still gets the last word where the address
			// itself did not survive, because the row carries it and `hostOf("")`
			// cannot.
			const name = sourceTitleOf(row.sourceTitle, "", row.sourceUrl) || (row.sourceHost ?? "");
			const openable = typeof row.sourceUrl === "string" && row.sourceUrl !== "";

			return jsxs("div", {
				style: {
					display: "flex", alignItems: "flex-start", gap: SPACE.sm,
					padding: "8px 10px", borderRadius: RADIUS.md, background: `rgba(${accent},${TINT.soft})`
				},
				children: [
					jsx("span", {
						style: { font: FONT.body, flex: "none", color: `rgb(${accent})` },
						children: jsx(Icon, { name: verified ? "check" : "alert", size: ICON.xs })
					}, "mark"),
					jsxs("div", {
						style: { flex: 1, minWidth: 0, display: "flex", flexDirection: "column", gap: SPACE.xs },
						children: [
							jsx("div", {
								style: { font: FONT.body, color: INK.primary },
								children: row.claim
							}, "claim"),
							// THE QUOTE, CAPPED. This row is a div rather than a button,
							// so unlike the finding row above it can carry a real
							// expander — and it needs one: a frozen evidence quote is
							// whatever the extractor pulled off the page, which is
							// sometimes two sentences and sometimes half an article.
							jsx("div", {
								style: { font: FONT.small, color: INK.secondary },
								children: jsx(MissionClamp, { text: `“${row.quote}”`, lines: 3, zh })
							}, "quote"),
							jsxs("div", {
								style: { font: FONT.micro, display: "flex", alignItems: "center", gap: SPACE.sm, flexWrap: "wrap", color: INK.secondary },
								children: [
									// The verdict, as a chip in the state's own colour. It used
									// to be the first of four identical grey spans on one line,
									// which made "this quote was found in another source" and
									// "fetched at 14:02" the same weight of fact.
									Chip({
										tone: missionHue(MISSION_VERIFY_FACES, row.verifyState),
										label: missionFace(MISSION_VERIFY_FACES, row.verifyState, zh)
									}, "state"),
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
										style: { font: FONT.micro,
											appearance: "none", border: "none", background: "transparent", padding: 0,
											color: `rgb(${accent})`, font: "inherit", cursor: "pointer"
										},
										children: (zh ? "在阅读器里打开 · " : "Open in the reader · ") + hostOf(row.sourceUrl)
									}, "open"),
									!openable ? null : jsx("a", {
										href: row.sourceUrl,
										target: "_blank",
										rel: "noreferrer noopener",
										style: { color: INK.secondary, textDecoration: "none" },
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
					// THE ONE LINE IN THIS BOX THAT IS A PERSON'S SENTENCE rather than
					// the runtime's own vocabulary, and the only one that runs to a
					// paragraph. The Callout scrolls its body at 128px, so an
					// uncapped note here pushes the guard's own findings — the lines
					// above it — out of sight inside their own box.
					lines.push(jsx(MissionClamp, {
						text: (zh ? "领队留下的话：" : "The leader's own note: ") + reason.accountabilityNote,
						lines: 3, zh
					}, "note"));
				}
				if ((reason.failureCode ?? null) !== null) {
					lines.push(missionFace(MISSION_FAILURE_FACES, reason.failureCode, zh));
				}
				// Nothing matched, and the flag is still set: print the guard's own
				// sentence rather than an empty warning box.
				if (lines.length === 0) {
					lines.push((reason.guardMessage ?? "") === ""
						? (zh ? "这一版被标成了降级，但归档时没有留下任何原因 —— 这本身是一处缺陷。" : "This version is flagged degraded and no reason was recorded with it, which is itself a defect.")
						// The guard's raw sentence, which is machine-written and
						// unbounded — the only text in this box nobody wrote for a
						// reader. Clamped for the same reason as the note above, and
						// the fallback beside it stays a plain string because this
						// file wrote that one and knows how long it is.
						: jsx(MissionClamp, { text: reason.guardMessage, lines: 3, zh }, "guard"));
				}
			}
			return Callout({
				tone: TONE.warn,
				icon: "alert",
				// The hand-set weight goes with it: this was the only one of the
				// three boxes that tinted its lead, and the tint is the Callout's
				// job now rather than a rule this one site remembered.
				label: zh ? "这一版是降级归档的。" : "This version was stored degraded.",
				children: [
					...lines.map((line, at) => jsx("div", { children: line }, `l${at}`)),
					jsx("div", {
						style: { color: INK.secondary },
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
			// FOUR FIGURES THE LIST ALREADY KNOWS AND NEVER SAID. The pane opened
			// straight onto row [1] with no summary at all, so "how much of what
			// this report cites was actually checked" — the one question a reader
			// brings to a bibliography — could only be answered by counting the
			// chips down the column by eye.
			const hosts = new Set(references.map((entry) => entry.host).filter((host) => host !== ""));
			const verified = references.filter((entry) => String(entry.verifyState ?? "").startsWith("verified")).length;
			const quoted = references.filter((entry) => entry.quote !== "").length;
			const missing = references.filter((entry) => !entry.joined).length;
			return jsxs("div", {
				style: { maxWidth: "760px", margin: "0 0 18px" },
				children: [
					jsx("h3", {
						style: { font: FONT.baseStrong,
							margin: "0 0 10px",
							fontFamily: ARTICLE_SERIF, color: INK.primary
						},
						children: zh ? "参考文献" : "References"
					}, "head"),
					MissionStatTiles({ tiles: [
						{
							label: zh ? "引用" : "References",
							value: String(references.length),
							hint: zh ? `${hosts.size} 个站点` : `${hosts.size} host(s)`
						},
						{
							label: zh ? "已核验" : "Verified",
							value: String(verified),
							tone: missionRateHue(verified, references.length),
							meter: missionRate(verified, references.length)
						},
						{ label: zh ? "有引语" : "Quoted", value: String(quoted) },
						// OMITTED WHEN ZERO, like the scorecard's residuals. A tile
						// reading 元数据缺失 0 is the same defect one size up as the
						// chip that printed 未通过 0，未检查 0，被反驳 0 on a clean
						// section: three zeros read, at a glance, as three problems.
						missing === 0 ? null : {
							label: zh ? "元数据缺失" : "Metadata missing",
							value: String(missing),
							tone: TONE.warn
						}
					] }, "totals"),
					jsx("div", {
						style: { display: "flex", flexDirection: "column", gap: SPACE.sm },
						children: references.map((entry) => jsxs("div", {
							id: `ref-${entry.index}`,
							style: { font: FONT.small,
								display: "flex", alignItems: "flex-start", gap: SPACE.sm, color: INK.secondary
							},
							children: [
								jsx("span", {
									// THE ORDINAL IS DECORATION, and INK's docblock is
									// explicit that tertiary is the decoration budget: `[7]`
									// is how the marker in the prose finds this row, not a
									// value anybody reads for its own sake.
									style: { flex: "none", minWidth: "26px", paddingTop: SPACE.sm, fontFamily: MONO, color: INK.quiet },
									children: `[${entry.index}]`
								}, "index"),
								jsxs("span", {
									style: { flex: 1, minWidth: 0, display: "flex", flexDirection: "column", gap: SPACE.xs },
									children: [
										SourceLink({
											zh,
											// A citation whose address did not survive still gets
											// the card, and the sentence saying so IS its name.
											// Dropping the row would leave a report claiming
											// twelve references and listing eleven.
											title: entry.url === ""
												? (zh ? "这条引用没有留下地址。" : "No address was stored for this citation.")
												: sourceTitleOf(entry.title, "", entry.url),
											url: entry.url,
											host: entry.host,
											verifyState: entry.verifyState,
											meta: [
												jsx("span", {
													style: { ...COUNT_CHIP, flex: "none" },
													children: zh ? `文中 ${entry.inText} 处` : `cited ${entry.inText}× in the text`
												}, "inText"),
												entry.status === null || entry.status === undefined ? null : jsx("span", {
													style: { flex: "none", fontFamily: MONO },
													children: `HTTP ${entry.status}`
												}, "status"),
												entry.fetchedAt === null || entry.fetchedAt === undefined ? null : jsx("span", {
													style: { flex: "none", fontFamily: MONO },
													children: formatStamp(entry.fetchedAt)
												}, "fetched")
											]
										}, "card"),
										!entry.joined ? jsx("div", {
											style: { color: `rgb(${TONE.warn})` },
											children: zh
												? "引用元数据缺失：这个编号没有对上任何一条冻结证据，所以引语和核验状态都查不到。"
												: "Citation metadata missing: this index matched no frozen evidence row, so neither the quote nor its verify state can be shown."
										}, "unjoined") : entry.quote === "" ? null : jsx("div", {
											style: { color: INK.secondary },
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
			// The retry counter behind the failed-read screen. The pane had no
			// way at all to re-issue its own GET: the only route back to this
			// artefact was to leave the mission and open it again.
			const [tick, setTick] = useState(0);
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
			}, [missionId, version, tick]);

			// Null when the report is a PANE rather than a screen: there is
			// nothing to go back to, because the mission is still around it. A
			// back button that unmounts the tab strip it lives under is worse
			// than no back button.
			const back = onBack === null || onBack === undefined ? null : jsx("button", {
				type: "button", className: "swm-back swm-focus", style: backStyle(), onClick: onBack,
				children: [jsx(Icon, { name: "arrowLeft", size: ICON.xs }, "glyph"), zh ? "返回任务" : "Back to the mission"]
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
				// PROSE, SO THE PLACEHOLDER IS PROSE. Six lines at the widths a
				// paragraph actually has — the short one is where a paragraph ends,
				// and a column of six identical bars reads as a table.
				return jsxs("div", {
					style: { ...CONTENT_STYLE, padding: "0 24px" },
					children: [back, SkeletonScreen({
						zh,
						style: { display: "flex", flexDirection: "column", gap: SPACE.md, marginTop: SPACE.lg },
						children: [
							Skeleton({ w: "46%", h: "20px" }, "title"),
							...["100%", "96%", "88%", "100%", "72%", "90%"].map((w, at) => Skeleton({ w, h: "14px" }, "line" + at))
						]
					}, "skeleton")]
				});
			}
			if (state === "error") {
				return jsxs("div", {
					style: { ...CONTENT_STYLE, padding: "0 24px" },
					children: [back, ErrorBox({
						title: zh ? "读不到这份报告" : "Could not read this report",
						message: error,
						endpoint: `${apiBase()}/missions/${missionId}/artifact`,
						onRetry: () => { setTick((value) => value + 1); },
						zh
					}, "note")]
				});
			}
			if (artifact === null || artifact.kind === "empty-artifact") {
				// THREE ABSENCES, THREE MARKS. A write that failed is a failure and
				// takes the danger disc; a version that does not exist is a wrong
				// address; a mission that has not written one yet is simply not
				// finished. Drawn identically — which is what the one dashed box
				// did — the first of the three reads as the third, and a report
				// nobody will ever get looks like a report to wait for.
				const failed = artifact?.reason === "write-failed";
				const missing = artifact?.reason === "no-such-version";
				return jsxs("div", {
					style: { ...CONTENT_STYLE, padding: "0 24px" },
					children: [back, EmptyBox({
						mark: failed ? "alert" : missing ? "search" : "penLine",
						tone: failed ? TONE.danger : undefined,
						title: failed
							? (zh ? "报告写失败了。" : "The artefact write failed.")
							: missing
							? (zh ? "没有这一版报告。" : "There is no such version.")
							: (zh ? "还没有生成报告。" : "No report has been produced yet."),
						note: failed
							? (zh ? "任务已经结束，但没有落下任何一版。" : "The mission ended and no version was stored.")
							: ""
					}, "note")]
				});
			}

			const quality = artifact.quality ?? {};
			// Built once, read twice: the markers in the prose ask whether an index has
			// anything behind it, and the list under the article is the same set.
			const references = missionReferences(artifact);
			const numbered = new Set(references.map((entry) => entry.index));
			const byIndex = new Map(references.map((entry) => [entry.index, entry]));
			const evidence = Array.isArray(artifact.evidence) ? artifact.evidence : [];
			const citations = Array.isArray(artifact.citations) ? artifact.citations : [];
			const tallies = [
				["evidenced", zh ? "有据章节" : "Evidenced"],
				["interpretive", zh ? "解读章节" : "Interpretive"],
				["unplaced", zh ? "无法归章" : "Unplaced"]
			].filter(([key]) => Number(quality[key]?.total ?? 0) > 0);
			// THE SCORECARD, GRADED AND ORDERED. It was up to three neutral
			// outlined chips, each carrying a four-number sentence — 有据章节 ·
			// 3/4 已核验，未通过 1，未检查 0，被反驳 0 — with no hue at all, in
			// declaration order. Three things were wrong with that and all three
			// are fixed here rather than one at a time:
			//
			//   1. NO COLOUR. The one place on the report where a ratio is the
			//      whole point was the one place drawn in the same grey whatever
			//      the ratio said.
			//   2. ALL FOUR REMAINDERS, ALWAYS. A section where everything held
			//      up still printed 未通过 0，未检查 0，被反驳 0 — three zeros
			//      that read at a glance as three problems.
			//   3. DECLARATION ORDER. `evidenced, interpretive, unplaced` is the
			//      order the buckets happen to be written in one file away, so
			//      the worst section type was first on some runs and last on
			//      others for no reason a reader could use. Worst ratio first
			//      now, so the eye lands on the section that needs it.
			//
			// PER SECTION TYPE AND NEVER AVERAGED, which is the property the
			// whole block exists for: "chapter seven cites nothing" has to stay
			// visible instead of disappearing into a healthy-looking total.
			const graded = tallies.map(([key, label]) => {
				const tally = quality[key] ?? {};
				const total = Number(tally.total ?? 0);
				const verified = Number(tally.verified ?? 0);
				const rest = [
					[Number(tally.unverified ?? 0), zh ? "未通过" : "unverified"],
					[Number(tally.unchecked ?? 0), zh ? "未检查" : "unchecked"],
					[Number(tally.contradicted ?? 0), zh ? "被反驳" : "contradicted"]
				].filter(([count]) => count > 0).map(([count, word]) => (zh ? `${word} ${count}` : `${count} ${word}`));
				return {
					// `?? 1` rather than `?? 0` for the SORT KEY only. A bucket with
					// no citations is already filtered out above, so this can only be
					// reached if that filter changes — and an unmeasured section
					// sorting to the front as if it were the worst one is a false
					// alarm at the top of the report.
					rank: missionRate(verified, total) ?? 1,
					tile: {
						label,
						value: `${verified}/${total}`,
						tone: missionRateHue(verified, total),
						meter: missionRate(verified, total),
						hint: rest.length === 0 ? (zh ? "全部通过" : "all clear") : rest.join(zh ? "，" : ", ")
					}
				};
			}).sort((a, b) => a.rank - b.rank).map((entry) => entry.tile);
			// THE WHOLE-REPORT TILE, LAST. The three above it are sorted worst
			// first, and dropping a total into that order would make position mean
			// two different things in one row. `quality` carries no top-level
			// verified count, so it is summed from the same three buckets the
			// tiles are built from rather than from a fourth source.
			const allVerified = ["evidenced", "interpretive", "unplaced"]
				.reduce((sum, key) => sum + Number(quality[key]?.verified ?? 0), 0);
			const scored = Number(quality.total ?? 0) <= 0 ? graded : [...graded, {
				label: zh ? "全部引用" : "All citations",
				value: `${allVerified}/${Number(quality.total)}`,
				tone: missionRateHue(allVerified, quality.total),
				meter: missionRate(allVerified, quality.total)
			}];

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
							style: { display: "flex", alignItems: "center", gap: SPACE.sm, flexWrap: "wrap", margin: "0 0 12px" },
							children: [
								back,
								jsx("span", { style: { flex: 1 } }, "spacer"),
								...versions.map((entry) => jsx("button", {
									type: "button",
									role: "tab",
									"aria-selected": entry.version === artifact.version,
									className: "swm-chip swm-focus", style: chipStyle({ hue: entry.degraded ? TONE.warn : TONE.neutral }, entry.version === artifact.version),
									onClick: () => { setVersion(entry.version); },
									children: (zh ? `第 ${entry.version} 版` : `v${entry.version}`)
										+ (entry.degraded ? (zh ? " · 降级" : " · degraded") : "")
								}, String(entry.version)))
							]
						}, "versions"),
						jsx("h2", {
							style: { font: FONT.titleStrong, margin: "0 0 6px", color: INK.primary },
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
								style: { font: FONT.small, margin: "0 0 12px", color: `rgb(${TONE.danger})` },
								children: zh
									? "核验记分卡是空的：一处引用都没有核验过。这不是“没有发现问题”，这是没有检查过。"
									: "The scorecard is empty: not one citation was checked. That is not a clean bill — nothing was verified at all."
							}, "noScore")
							: MissionStatTiles({ tiles: scored }, "score"),
						jsx("div", {
							style: { maxWidth: "760px", margin: "0 0 18px" },
							children: renderMarkdown(artifact.markdown ?? "", "article", {
								zh,
								has: (index) => numbered.has(index),
								// WHAT IS BEHIND THE NUMBER, for the hover card. Read off
								// the list that is already built for the bottom of this
								// page — a Map rather than a `find` per marker, because a
								// long report draws two hundred of these and every one of
								// them would walk the whole array.
								peek: (index) => byIndex.get(index) ?? null,
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
							style: { display: "flex", alignItems: "center", gap: SPACE.sm, margin: "0 0 10px" },
							children: [
								jsx("h3", {
									style: { font: FONT.bodyStrong, margin: 0, color: INK.primary },
									children: zh ? "证据" : "Evidence"
								}, "title"),
								jsx("button", {
									type: "button",
									className: "swm-ctl swm-focus", style: { ...controlStyle(), font: FONT.small, height: CONTROL.sm },
									onClick: () => { setShowEvidence(!showEvidence); },
									children: showEvidence
										? (zh ? "收起" : "Hide")
										: (zh ? `展开 ${evidence.length} 条` : `Show ${evidence.length}`)
								}, "toggle")
							]
						}, "evidenceHead"),
						!showEvidence ? null : (evidence.length === 0
							? jsx("div", {
								style: { font: FONT.small, color: INK.secondary },
								// An empty blob is only legal on a degraded artefact,
								// and "we looked and found nothing verifiable" is a
								// real answer — as long as it is said rather than
								// rendered as an empty list.
								children: zh
									? "这一版没有冻结任何证据 —— 也就是说这次运行没有产出一条通过核验的引语。"
									: "No evidence was frozen with this version: the run produced no quote that verified."
							}, "noEvidence")
							: jsx("div", {
								style: { display: "flex", flexDirection: "column", gap: SPACE.sm },
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
				style: { display: "flex", alignItems: "center", gap: SPACE.sm, margin: "0 0 10px" },
				children: [
					step === undefined ? null : jsx("span", {
						style: { font: FONT.microStrong,
							flex: "none", width: "19px", height: "19px", borderRadius: RADIUS.circle,
							display: "inline-flex", alignItems: "center", justifyContent: "center", fontVariantNumeric: "tabular-nums",
							background: accent === undefined ? SURFACE.hover : `rgba(${accent},${TINT.soft})`,
							color: accent === undefined ? INK.secondary : `rgb(${accent})`
						},
						children: String(step)
					}),
					jsx("h3", {
						style: { font: FONT.bodyStrong, margin: 0, color: INK.primary },
						children: title
					}),
					jsx("span", { style: { flex: 1 } }),
					hint === undefined || hint === "" ? null : jsx("span", {
						style: { font: FONT.micro, color: INK.secondary, fontVariantNumeric: "tabular-nums" },
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
					borderBottom: last ? "none" : `1px solid ${LINE.hair}`,
					background: open ? `rgba(${accent},${TINT.soft})` : "transparent",
					transition: `background ${MOTION.fast}`
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
						style: { display: "flex", alignItems: "center", gap: SPACE.md, padding: open ? "13px 15px 9px" : "11px 15px" },
						children: [
							jsx("button", {
								type: "button",
								"aria-label": playing ? (zh ? "暂停" : "Pause") : (zh ? "播放" : "Play"),
								disabled: failed,
								onClick: toggle,
								style: {
									flex: "none", width: "30px", height: CONTROL.sm, borderRadius: RADIUS.circle,
									border: "none", cursor: failed ? "not-allowed" : "pointer", padding: 0, lineHeight: 0,
									display: "inline-flex", alignItems: "center", justifyContent: "center",
									background: open ? `rgb(${accent})` : `rgba(${accent},${TINT.soft})`,
									color: open ? "var(--dsw-alias-label-primary-inverted)" : `rgb(${accent})`,
									transition: `background ${MOTION.fast}`
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
									font: open ? FONT.bodyStrong : FONT.body,
									lineHeight: "19px", color: INK.primary,
									// Truncated in the list, wrapped when open: the row
									// being listened to is worth two lines, the forty
									// below it are not.
									...(open ? {} : { overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" })
								},
								children: episode.title
							}),
							jsx("span", {
								style: { font: FONT.micro,
									flex: "none", fontVariantNumeric: "tabular-nums",
									color: INK.secondary
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
									padding: "2px", cursor: "pointer", lineHeight: 0, color: INK.quiet
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
						style: { display: "flex", alignItems: "center", gap: SPACE.md, padding: "0 15px 14px 57px" },
						children: [
							failed ? jsx("span", {
								style: { font: FONT.small, flex: 1, color: `rgb(${TONE.danger})` },
								children: zh ? "音频无法加载" : "This audio would not load"
							}) : Meter({
								// THE SAME BAR the cost pane draws, which is what `Meter`'s
								// rest spread exists for: the role, the value and the click
								// ride onto the track, and the playhead stops being the
								// fourth geometry for one idea.
								//
								// `position: relative` is gone with the absolute fill it was
								// there for. Meter's fill is in flow — a block at `width: n%`
								// and `height: 100%` lands in exactly the same place — so
								// there is no longer anything for it to be relative to.
								value: progress * 100,
								tone: accent,
								role: "slider",
								"aria-label": zh ? "进度" : "Seek",
								"aria-valuenow": Math.round(progress * 100),
								tabIndex: 0,
								onClick: seek,
								style: { flex: 1, cursor: "pointer" }
							}, "seek"),
							jsx("span", {
								style: { font: FONT.micro,
									flex: "none", fontVariantNumeric: "tabular-nums",
									color: INK.secondary
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
			width: "28px", height: CONTROL.sm, cursor: "pointer", font: "inherit",
			font: FONT.base, lineHeight: 1, color: INK.secondary
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
						className: "swm-focus", style: { ...SEARCH_STYLE, font: FONT.body, height: CONTROL.md }
					}),

					!open ? null : jsx("div", {
						style: {
							position: "absolute", top: "42px", left: 0, right: 0, zIndex: 3,
							border: `1px solid ${LINE.hair}`, borderRadius: RADIUS.lg,
							background: SURFACE.card, boxShadow: ELEVATION.floating,
							maxHeight: "290px", overflowY: "auto", overflowX: "hidden"
						},
						children: failed !== ""
							? jsx("div", { style: { font: FONT.small, padding: "14px", color: `rgb(${TONE.danger})` }, children: (zh ? "搜索失败：" : "Search failed: ") + failed })
							: busy && matches.length === 0
							? jsx("div", { style: { font: FONT.small, padding: "14px", color: INK.secondary }, children: zh ? "搜索中…" : "Searching…" })
							: matches.length === 0
							? jsx("div", { style: { font: FONT.small, padding: "14px", color: INK.secondary }, children: zh ? "没有匹配的信源。" : "Nothing matches." })
							: jsxs("div", {
								children: matches.map((row, at) => {
									const already = picked.has(row.id);
									return jsxs("button", {
										type: "button",
										disabled: already,
										onClick: () => { add(row); },
										style: { font: FONT.small,
											display: "flex", width: "100%", alignItems: "flex-start", gap: SPACE.md,
											padding: "10px 13px", textAlign: "left", appearance: "none",
											border: "none", borderBottom: at === matches.length - 1 ? "none" : `1px solid ${LINE.hair}`,
											background: "transparent", font: "inherit",
											cursor: already ? "default" : "pointer", opacity: already ? 0.45 : 1
										},
										children: [
											jsx("span", {
												style: { font: FONT.microStrong,
													flex: "none", marginTop: "1px",
													color: already ? INK.quiet : `rgb(${accent})`
												},
												children: jsx(Icon, { name: already ? "check" : "plus", size: ICON.sm })
											}),
											jsxs("span", {
												style: { flex: 1, minWidth: 0 },
												children: [
													jsx("span", {
														style: { display: "block", color: INK.primary, lineHeight: "18px" },
														children: row.title
													}),
													jsx("span", {
														style: { font: FONT.micro, display: "block", marginTop: "2px", color: INK.secondary },
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


			return jsxs("div", {
				children: [
					jsx("p", {
						style: { ...LEDE_STYLE, marginTop: 0 },
						children: zh ? format.blurb.zh : format.blurb.en
					}),

					jsxs("div", {
						style: { ...PANEL_STYLE, padding: "16px", marginBottom: "22px" },
						children: [
							jsx(StepHeading, {
								step: 1, accent,
								title: zh ? "选择信源" : "Choose the sources",
								hint: chosen === 0 ? "" : (zh ? `已选 ${chosen} 条` : `${chosen} selected`)
							}),
							jsx(SourceField, { zh, picked, onPick: togglePick, accent }),
							chosen === 0 ? null : jsx("div", {
								style: { ...PANEL_STYLE, marginTop: "12px", overflow: "hidden", boxShadow: ELEVATION.flat },
								children: [...picked.values()].map((row, at) => jsxs("div", {
									style: { font: FONT.small,
										display: "flex", alignItems: "flex-start", gap: SPACE.md, padding: "9px 13px",
										borderBottom: at === picked.size - 1 ? "none" : `1px solid ${LINE.hair}`
									},
									children: [
										jsx("span", {
											style: { font: FONT.microStrong,
												flex: "none", marginTop: "1px", width: "15px",
												fontVariantNumeric: "tabular-nums", color: INK.quiet
											},
											children: String(at + 1)
										}),
										jsxs("span", {
											style: { flex: 1, minWidth: 0 },
											children: [
												jsx("span", { style: { color: INK.primary, lineHeight: "18px" }, children: row.title }),
												jsx("span", {
													style: { font: FONT.micro, display: "block", marginTop: "2px", color: INK.secondary },
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
												padding: "2px", cursor: "pointer", lineHeight: 0, color: INK.quiet
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
								style: { display: "flex", alignItems: "center", gap: SPACE.md, flexWrap: "wrap" },
								children: [
									jsx("input", {
										type: "text",
										value: guidance,
										placeholder: zh ? "想让它侧重什么？（可留空）" : "Anything it should focus on? (optional)",
										onChange: (event) => { setGuidance(event.target.value); },
										className: "swm-focus", style: { ...SEARCH_STYLE, font: FONT.small, flex: 1, minWidth: "200px", height: CONTROL.md }
									}),
									jsx("button", {
										type: "button",
										disabled: busy || chosen === 0,
										className: "swm-ctl swm-focus", style: {
											...controlStyle(busy || chosen === 0), height: CONTROL.md,
											opacity: chosen === 0 ? 0.5 : 1,
											color: `rgb(${accent})`, borderColor: `rgba(${accent},${TINT.ring})`
										},
										onClick: () => { void write(); },
										children: busy
											? (zh ? "撰写中…" : "Writing…")
											: (zh ? `生成${format.zh}` : `Write it`)
									}),
									chosen !== 0 ? null : jsx("span", {
										style: { font: FONT.micro, color: INK.secondary },
										children: zh ? "先加几条信源" : "Add some sources first"
									})
								]
							})
						]
					}),

					jsxs("div", {
						style: { display: "flex", alignItems: "center", gap: SPACE.md, margin: "0 0 12px" },
						children: [
							jsx("h3", {
								style: { font: FONT.baseStrong, margin: 0, color: INK.primary },
								children: zh ? `已生成的${format.zh}` : `${format.en}s`
							}),
							// The same count badge the mission panes carry. It was a
							// bare figure beside a heading, which reads as part of
							// the heading rather than as a quantity.
							total === 0 ? null : jsx("span", {
								style: COUNT_CHIP,
								children: String(total)
							})
						]
					}),

					documents.length === 0
						? jsx("div", {
							style: { ...PANEL_STYLE, font: FONT.small, padding: "20px", color: INK.secondary },
							children: zh ? `还没有生成过${format.zh}。` : `Nothing written yet.`
						})
						: jsxs("div", {
							children: [
								jsx("div", {
									style: { ...PANEL_STYLE, overflow: "hidden" },
									children: documents.map((record, at) => {
										const open = record.id === openId;
										return jsxs("div", {
											style: {
												borderBottom: at === documents.length - 1 ? "none" : `1px solid ${LINE.hair}`,
												background: open ? `rgba(${accent},${TINT.soft})` : "transparent"
											},
											children: [
												jsxs("div", {
													style: { display: "flex", alignItems: "center", gap: SPACE.md, padding: "11px 15px" },
													children: [
														jsx("button", {
															type: "button",
															onClick: () => { setOpenId(open ? undefined : record.id); },
															style: {
																flex: 1, minWidth: 0, textAlign: "left", appearance: "none",
																border: "none", background: "transparent", padding: 0, cursor: "pointer",
																font: open ? FONT.bodyStrong : FONT.body,
																lineHeight: "19px", color: INK.primary,
																...(open ? {} : { overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" })
															},
															children: record.title
														}),
														jsx("span", {
															style: { font: FONT.micro,
																flex: "none", fontVariantNumeric: "tabular-nums",
																color: INK.secondary
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
																padding: "2px", cursor: "pointer", lineHeight: 0, color: INK.quiet
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
															? jsx("div", { style: { font: FONT.small, color: INK.secondary }, children: zh ? "读取中…" : "Loading…" })
															: body.missing === true
															// The index and the files can disagree. Saying which
															// beats rendering an empty document that looks like a
															// model that produced nothing.
															? jsx("div", { style: { font: FONT.small, color: `rgb(${TONE.danger})` }, children: zh ? "这篇的文件不见了，只剩记录。" : "The file for this one is gone; only the record remains." })
															: jsx("div", { style: { maxWidth: "760px" }, children: renderMarkdown(body.text, "article") }),
														body === null || body.missing === true ? null : jsx("button", {
															type: "button",
															className: "swm-ctl swm-focus", style: { ...controlStyle(), font: FONT.micro, height: CONTROL.sm, marginTop: "10px" },
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
										className: "swm-ctl swm-focus", style: { ...controlStyle(), font: FONT.small, height: CONTROL.sm },
										onClick: () => { void load(documents.length + DOCUMENT_PAGE); },
										children: zh ? `再显示 ${Math.min(DOCUMENT_PAGE, total - documents.length)} 篇` : `Show ${Math.min(DOCUMENT_PAGE, total - documents.length)} more`
									})
								})
							]
						}),

					error === "" ? null : jsx("div", {
						style: { ...NOTE_STYLE, minHeight: 0, padding: "11px 14px", marginTop: "14px", color: `rgb(${TONE.danger})` },
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
			const FIELD_LABEL = { font: FONT.small, color: INK.secondary, whiteSpace: "nowrap" };
			const NUM_INPUT = { ...SEARCH_STYLE, width: "56px", height: CONTROL.sm, font: FONT.small, textAlign: "center", fontVariantNumeric: "tabular-nums" };
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
						style: { ...PANEL_STYLE, padding: "13px 16px", marginBottom: "24px" },
						children: [
							jsxs("div", {
								style: { display: "flex", alignItems: "center", gap: SPACE.md, flexWrap: "wrap" },
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
											flex: "none", width: "34px", height: "19px", borderRadius: RADIUS.md,
											border: "none", padding: 0, cursor: "pointer", position: "relative",
											background: armed ? `rgb(${accent})` : LINE.rule,
											transition: `background ${MOTION.base}`
										},
										children: jsx("span", {
											style: {
												position: "absolute", top: "2px", left: armed ? "17px" : "2px",
												width: "15px", height: "15px", borderRadius: RADIUS.circle,
												// A STATIC, and deliberately not an alias. The knob always
												// sits on a filled track — the accent when armed, a border
												// tint when not — so it must stay light in BOTH themes.
												// `--dsw-alias-bg-layer-1` is the tempting one and it is
												// wrong: it flips to near-black in the dark theme, which
												// puts a dark knob on a dark track and the control reads
												// as permanently off.
												background: "var(--dsw-static-neutral-00,#fff)",
												boxShadow: ELEVATION.raised,
												transition: `left ${MOTION.base}`
											}
										})
									}),
									jsx("span", {
										style: { font: FONT.bodyStrong, color: INK.primary },
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
										className: "swm-ctl swm-focus", style: { ...controlStyle(busy || watchUntil !== 0), font: FONT.small, height: CONTROL.sm },
										onClick: () => { void runNow(); },
										children: watchUntil !== 0 ? (zh ? "生成中…" : "Running…") : (zh ? "立即生成" : "Run now")
									}),
									!armed ? null : jsx("button", {
										type: "button",
										"aria-expanded": tuning,
										className: "swm-ctl swm-focus", style: { ...controlStyle(busy || watchUntil !== 0), font: FONT.small, height: CONTROL.sm },
										onClick: () => { setTuning((previous) => !previous); },
										children: tuning ? (zh ? "收起" : "Done") : (zh ? "设置" : "Settings")
									})
								]
							}),
							jsx("div", {
								style: { font: FONT.micro, marginTop: "8px", color: INK.secondary },
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
								style: { font: FONT.micro,
									marginTop: "7px",
									color: schedule.publishLastManualRun?.error === undefined
										? INK.secondary
										: `rgb(${TONE.danger})`
								},
								children: manualNote(schedule, zh)
							}),
							!tuning || !armed ? null : jsxs("div", {
								style: {
									display: "flex", alignItems: "flex-end", gap: SPACE.lg, flexWrap: "wrap",
									marginTop: "13px", paddingTop: "13px", borderTop: `1px solid ${LINE.hair}`
								},
								children: [
									jsxs("label", {
										style: { display: "flex", flexDirection: "column", gap: SPACE.xs },
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
												className: "swm-focus", style: { ...SEARCH_STYLE, font: FONT.small, width: "108px", height: CONTROL.sm, fontVariantNumeric: "tabular-nums" }
											})
										]
									}),
									jsxs("label", {
										style: { display: "flex", flexDirection: "column", gap: SPACE.xs },
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
										style: { display: "flex", flexDirection: "column", gap: SPACE.xs },
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
										style: { display: "flex", flexDirection: "column", gap: SPACE.xs },
										children: [
											jsx("span", { style: FIELD_LABEL, children: zh ? "每天生成" : "Produce" }),
											jsx("div", {
												style: { display: "flex", gap: SPACE.sm, flexWrap: "wrap", height: CONTROL.sm, alignItems: "center" },
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
															height: CONTROL.sm, padding: "0 11px", borderRadius: RADIUS.pill, font: FONT.small,
															border: `1px solid ${on ? `rgba(${accent},${TINT.ring})` : LINE.rule}`,
															background: on ? `rgba(${accent},${TINT.soft})` : "transparent",
															color: on ? `rgb(${accent})` : INK.secondary,
															fontWeight: on ? 600 : 400,
															transition: `background ${MOTION.fast}, color ${MOTION.fast}`
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
						style: { display: "flex", alignItems: "center", gap: SPACE.md, margin: "0 0 12px" },
						children: [
							jsx("h3", {
								style: { font: FONT.baseStrong, margin: 0, color: INK.primary },
								children: zh ? "节目" : "Episodes"
							}),
							episodeTotal === 0 ? null : jsx("span", {
								style: COUNT_CHIP,
								children: zh ? `${episodeTotal} 集` : `${episodeTotal}`
							}),
							jsx("span", { style: { flex: 1 } }),
							jsx("button", {
								type: "button",
								"aria-expanded": making,
								className: "swm-ctl swm-focus", style: {
									...controlStyle(), font: FONT.small, height: CONTROL.sm,
									color: making ? INK.secondary : `rgb(${accent})`,
									borderColor: making ? undefined : `rgba(${accent},${TINT.ring})`
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
							...PANEL_STYLE, padding: "16px", marginBottom: "20px",
							borderColor: `rgba(${accent},${TINT.ring})`
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
								style: { ...PANEL_STYLE, marginTop: "12px", overflow: "hidden", boxShadow: ELEVATION.flat },
								children: [
									jsxs("div", {
										style: {
											display: "flex", alignItems: "center", gap: SPACE.md,
											padding: "9px 13px", borderBottom: `1px solid ${LINE.hair}`,
											background: `rgba(${accent},${TINT.soft})`
										},
										children: [
											jsx("span", {
												style: { font: FONT.smallStrong, flex: 1, color: `rgb(${accent})` },
												children: zh ? `这一集要讲的 ${chosen} 条` : `${chosen} source${chosen === 1 ? "" : "s"} in this episode`
											}),
											jsx("button", {
												type: "button",
												className: "swm-ctl swm-focus", style: { ...controlStyle(), font: FONT.micro, height: CONTROL.xs },
												onClick: () => { setPicked(new Map()); },
												children: zh ? "清空" : "Clear"
											})
										]
									}),
									...[...picked.values()].map((row, at) => jsxs("div", {
										style: { font: FONT.small,
											display: "flex", alignItems: "flex-start", gap: SPACE.md, padding: "9px 13px",
											borderBottom: at === picked.size - 1 ? "none" : `1px solid ${LINE.hair}`
										},
										children: [
											jsx("span", {
												style: { font: FONT.microStrong,
													flex: "none", marginTop: "1px", width: "15px",
													fontVariantNumeric: "tabular-nums", color: INK.quiet
												},
												children: String(at + 1)
											}),
											jsxs("span", {
												style: { flex: 1, minWidth: 0 },
												children: [
													jsx("span", { style: { color: INK.primary, lineHeight: "18px" }, children: row.title }),
													jsx("span", {
														style: { font: FONT.micro, display: "block", marginTop: "2px", color: INK.secondary },
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
													padding: "2px", cursor: "pointer", lineHeight: 0, color: INK.quiet
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
								style: { display: "flex", alignItems: "center", gap: SPACE.md, flexWrap: "wrap", marginBottom: script === null ? 0 : "14px" },
								children: [
									jsx("span", { style: FIELD_LABEL, children: zh ? "目标时长" : "Target length" }),
									jsxs("div", {
										style: {
											display: "inline-flex", alignItems: "center", height: CONTROL.sm,
											border: `1px solid ${LINE.rule}`, borderRadius: RADIUS.md, overflow: "hidden"
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
												style: { font: FONT.small,
													minWidth: "58px", textAlign: "center",
													fontVariantNumeric: "tabular-nums", color: INK.primary
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
										className: "swm-ctl swm-focus", style: {
											...controlStyle(busy || running || chosen === 0), height: CONTROL.sm,
											opacity: chosen === 0 ? 0.5 : 1,
											color: `rgb(${accent})`, borderColor: `rgba(${accent},${TINT.ring})`
										},
										onClick: () => { void writeScript(); },
										children: busy && script === null ? (zh ? "写稿中…" : "Writing…") : (zh ? "生成对话稿" : "Write the script")
									}),
									chosen !== 0 ? null : jsx("span", {
										style: { font: FONT.micro, ...FIELD_LABEL },
										children: zh ? "先加几条信源" : "Add some sources first"
									})
								]
							}),

							script === null ? null : jsxs("div", {
								style: { ...PANEL_STYLE, overflow: "hidden", boxShadow: ELEVATION.flat },
								children: [
									jsxs("div", {
										style: {
											display: "flex", alignItems: "center", gap: SPACE.md, flexWrap: "wrap",
											padding: "11px 13px", borderBottom: `1px solid ${LINE.hair}`
										},
										children: [
											jsx("span", { style: { font: FONT.bodyStrong, flex: 1, minWidth: "140px", color: INK.primary }, children: script.title }),
											voices === null || hosts === null ? null : jsxs("span", {
												style: { display: "flex", gap: SPACE.sm },
												children: [
													jsx("select", {
														value: hosts.a,
														"aria-label": zh ? "主持人 A 的声音" : "Host A voice",
														onChange: (event) => { setHosts((previous) => ({ ...previous, a: event.target.value })); },
														className: "swm-ctl swm-focus", style: { ...controlStyle(), font: FONT.micro, height: CONTROL.sm, padding: "0 6px" },
														children: voices.map((voice) => jsx("option", { value: voice.id, children: `A · ${voice.label}` }, voice.id))
													}),
													jsx("select", {
														value: hosts.b,
														"aria-label": zh ? "主持人 B 的声音" : "Host B voice",
														onChange: (event) => { setHosts((previous) => ({ ...previous, b: event.target.value })); },
														className: "swm-ctl swm-focus", style: { ...controlStyle(busy || running), font: FONT.micro, height: CONTROL.sm, padding: "0 6px" },
														children: voices.map((voice) => jsx("option", { value: voice.id, children: `B · ${voice.label}` }, voice.id))
													})
												]
											}),
											jsx("button", {
												type: "button",
												disabled: busy || running,
												className: "swm-ctl swm-focus", style: { ...controlStyle(busy || running), font: FONT.small, height: CONTROL.sm, color: `rgb(${accent})`, borderColor: `rgba(${accent},${TINT.ring})` },
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
									// `job.total` is the denominator and it can be 0 before the
									// first turn is queued, which is why the guard was written
									// here in the first place. It moves INTO the primitive — a
									// zero ceiling is a percentage there — so this reads as
									// what it is: done out of total.
									!running ? null : Meter({ value: job.done, max: job.total, tone: accent }, "progress"),
									jsx("div", {
										style: { maxHeight: "260px", overflowY: "auto", padding: "11px 13px" },
										children: script.turns.map((turn, at) => jsxs("div", {
											style: { font: FONT.small, display: "flex", gap: SPACE.md, marginBottom: "9px" },
											children: [
												jsx("span", {
													style: { font: FONT.microStrong,
														flex: "none", width: "18px", height: "18px", borderRadius: RADIUS.circle,
														display: "inline-flex", alignItems: "center", justifyContent: "center",
														background: turn.speaker === "a" ? `rgba(${accent},${TINT.soft})` : SURFACE.hover,
														color: turn.speaker === "a" ? `rgb(${accent})` : INK.secondary
													},
													children: turn.speaker.toUpperCase()
												}),
												jsx("span", { style: { flex: 1, minWidth: 0, color: INK.primary }, children: turn.text })
											]
										}, `t${at}`))
									})
								]
							}),

							job !== null && job.state === "error" ? jsx("div", {
								style: { ...NOTE_STYLE, minHeight: 0, padding: "10px 13px", marginTop: "12px", color: `rgb(${TONE.danger})` },
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
							style: { ...PANEL_STYLE, font: FONT.small, padding: "22px", color: INK.secondary },
							children: armed
								? (zh ? `还没有节目。第一集会在明天 ${schedule.publishAt} 自动生成，或者现在按「新建一集」做一集。` : `No episodes yet. The first one arrives tomorrow at ${schedule.publishAt}, or make one now with “New episode”.`)
								: (zh ? "还没有节目。按「新建一集」做一集，或者在上面设一个每天的时间。" : "No episodes yet. Make one with “New episode”, or set a daily time above.")
						})
						: jsxs("div", {
							children: [
								jsx("div", {
									style: { ...PANEL_STYLE, overflow: "hidden" },
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
										className: "swm-ctl swm-focus", style: { ...controlStyle(), font: FONT.small, height: CONTROL.sm },
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
										display: "flex", alignItems: "center", gap: SPACE.md, flexWrap: "wrap",
										marginTop: "16px", padding: "11px 14px",
										border: `1px dashed ${LINE.rule}`, borderRadius: RADIUS.lg
									},
									children: [
										jsx("span", { style: FIELD_LABEL, children: zh ? "在播客 App 里订阅：" : "Subscribe in a podcast app:" }),
										jsx("code", {
											style: { font: FONT.micro,
												flex: 1, minWidth: "170px", overflow: "hidden",
												textOverflow: "ellipsis", whiteSpace: "nowrap", color: INK.secondary
											},
											children: feedUrl
										}),
										jsx("button", {
											type: "button",
											className: "swm-ctl swm-focus", style: { ...controlStyle(), font: FONT.micro, height: CONTROL.sm },
											onClick: () => { void navigator.clipboard?.writeText(feedUrl); },
											children: zh ? "复制" : "Copy"
										})
									]
								})
							]
						}),

					error === "" ? null : jsx("div", {
						style: { ...NOTE_STYLE, minHeight: 0, padding: "11px 14px", marginTop: "14px", color: `rgb(${TONE.danger})` },
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
				{ id: "podcast", label: zh ? "播客" : "Podcast", accent: formatTone("podcast") },
				...formats.map((format) => ({
					id: format.id,
					label: zh ? format.zh : format.en,
					accent: formatTone(format.id),
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
						style: { ...SEGMENT_TRACK, marginBottom: SPACE.lg },
						children: entries.map((entry) => jsx("button", {
							type: "button",
							role: "tab",
							"aria-selected": entry.id === current.id,
							onClick: () => { setActive(entry.id); },
							style: {
								...segmentStyle(entry.id === current.id),
								// THE FORMAT'S OWN COLOUR, spread AFTER the state, and
								// the split is the point: the raised surface and the
								// weight say CHOSEN — that is state, and it is the same
								// state in both segmented controls in this file — while
								// the hue says WHICH, which is identity and belongs to
								// the format. Left off the unchosen segments, or four
								// colours compete to look selected.
								color: entry.id === current.id ? `rgb(${entry.accent})` : INK.secondary
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
					width: wide ? "100%" : "36px", height: CONTROL.md
				},
				children: jsxs("button", {
					type: "button",
					"aria-label": swarmLabel(),
					"aria-pressed": open,
					// Marks this as the toggle, so the page's click-away handler
					// leaves it alone rather than closing what this is about to open.
					"data-swarm-trigger": "true",
					onClick: () => { setOpen(!openState); },
					style: { font: FONT.body,
						appearance: "none", border: "none",
						background: open ? SURFACE.hover : "transparent",
						display: "inline-flex", alignItems: "center",
						justifyContent: wide ? "flex-start" : "center",
						gap: wide ? "8px" : 0, width: wide ? "100%" : "36px", height: CONTROL.md,
						padding: wide ? "0 8px" : 0, borderRadius: wide ? "8px" : "50%",
						color: INK.primary, font: "inherit",
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
			// BEFORE the first paint, and from the page rather than from the
			// trajectory drawer that used to be the only caller. Every chip on
			// every tab now resolves `--swm-h-*`, so injecting on the drawer's
			// schedule would mean the sources tab, the stage strip and the
			// dimension cards all rendered on their var fallbacks — the light
			// theme's triples — until somebody happened to open a mission's
			// trajectory. In the dark theme that is not a subtle difference:
			// the fallbacks are the light values, and they are the ones the
			// dark block exists to correct.
			useLayoutEffect(() => { ensureStyle(SWM_STYLE_ID, SWM_SHEET); }, []);
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
					background: SURFACE.base
				},
				children: [
					jsxs("header", {
						style: HEADER_STYLE,
						children: [
							// THE MARK GETS A TILE. At 18px beside a 16px word it read
							// as a bullet in front of the label rather than as the
							// product's mark, and the page opened with nothing that
							// looked like a page.
							//
							// A TINT AND A RING, not the violet-to-indigo gradient the
							// obvious hero tile wants: SwarmMark fills two of its three
							// nodes with `SURFACE.card` so they read as holes, and on a
							// saturated tile those holes are white in the light theme
							// and near-black in the dark one — the same mark saying two
							// different things per theme. Over a 10% wash of its own
							// hue they stay holes in both.
							jsx("div", {
								style: {
									flex: "none", display: "flex", alignItems: "center", justifyContent: "center",
									width: CONTROL.md, height: CONTROL.md, borderRadius: RADIUS.lg,
									background: `rgba(${PALETTE.violet},${TINT.soft})`,
									border: `1px solid rgba(${PALETTE.violet},${TINT.ring})`,
									color: `rgb(${PALETTE.violet})`
								},
								children: jsx(SwarmMark, { size: 18 })
							}, "mark"),
							// The name over the sentence that says what this tab is
							// for. `minWidth: 0` is what lets the lede ellipsise: a
							// flex child's default minimum is its content, so without
							// it a long lede pushes the actions off the row instead of
							// truncating.
							jsxs("div", {
								// ONE LINE, NOT TWO. The name over the lede is what made this
								// band 78px tall on every screen, and the lede is the one
								// sentence on the page that never changes — it describes the
								// tab, so it is read once and is chrome after that. Beside
								// the name it still answers "what is this" for a first
								// visit, and it gives the panes back a line of the window.
								style: { minWidth: 0, display: "flex", alignItems: "baseline", gap: SPACE.sm },
								children: [
									jsx("div", {
										style: { font: FONT.largeStrong, color: INK.primary, whiteSpace: "nowrap" },
										children: swarmLabel()
									}, "name"),
									jsx("p", { style: HERO_LEDE_STYLE, children: zh ? active.ledeZh : active.ledeEn }, "lede")
								]
							}, "title"),
							jsx("span", { style: { flex: 1 } }, "spacer"),
							// The actions, as a cluster rather than as loose children
							// of the row: they are the only pressable things up here
							// and they now sit at a different rhythm from the 12px
							// gap that separates the tile from the title.
							//
							// No per-tab action slot. TABS carries no action for any
							// of the five, and a slot with nothing to put in it is the
							// tenth geometry waiting to happen — the same reason Chip
							// has no `dot` and MetricStat no `mono`.
							jsxs("div", {
								style: { display: "flex", alignItems: "center", gap: SPACE.sm },
								children: [
									// Where you glance. The number is small and quiet until the
									// two halves disagree, at which point it is the only thing
									// on this row worth reading — a stale far machine otherwise
									// presents as a feature that was written and deployed and
									// is simply not there.
									jsx(VersionBadge, { zh }, "version"),
									jsx("button", {
										type: "button",
										className: "swm-iconbtn swm-focus",
										"aria-label": zh ? "关闭" : "Close",
										title: zh ? "关闭" : "Close",
										onClick: () => { setOpen(false); },
										style: {
											width: CONTROL.sm, height: CONTROL.sm,
											borderRadius: RADIUS.circle, color: INK.secondary
										},
										children: jsx(Icon, { name: "close", size: ICON.sm })
									}, "close")
								]
							}, "actions")
						]
					}),
					jsx("div", {
						style: TABBAR_STYLE,
						className: "swm-tabbar",
						role: "tablist",
						children: TABS.map((candidate) => jsxs("button", {
							type: "button",
							role: "tab",
							className: "swm-tab",
							"aria-selected": candidate.id === active.id,
							style: { ...tabStyle(candidate.id === active.id), display: "inline-flex", alignItems: "center", gap: SPACE.sm },
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
								// THE LEDE IS NOT HERE ANY MORE. It used to be the first
								// line of this branch, which is the placeholder path —
								// so the two unbuilt tabs were the only ones that ever
								// showed the sentence describing them, while the three
								// built ones had a written lede that nothing rendered.
								// It is on the header row now, for all five.
								//
								// `emptyZh`/`emptyEn` stay exactly where they are: the
								// comment on TABS records that those two fields are
								// deliberately placeholder-only, and they are read
								// here and nowhere else.
								: jsx("div", { style: NOTE_STYLE, children: zh ? active.emptyZh : active.emptyEn })
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
			// A version IS a state — released or not — so it takes the pill, in
			// the neutral tone rather than in a hand-mixed grey on a hover
			// surface. The margin stays on a wrapper: a chip that carries its
			// own outer spacing is a chip that cannot sit in a flex row.
			return jsx("span", {
				style: { marginLeft: SPACE.sm, cursor: "default" },
				children: Chip({
					tone: TONE.neutral,
					pill: true,
					label: release || host === null ? `v${label}` : `v${label}-dev`
				})
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
			const cell = { display: "flex", alignItems: "center", gap: SPACE.md };
			const key = { flex: "none", width: "44px", fontWeight: 500, color: INK.primary };
			return jsxs("div", {
				style: { font: FONT.micro,
					display: "flex", flexDirection: "column", gap: SPACE.xs,
					padding: "8px 12px", marginBottom: "18px",
					border: `1px solid ${LINE.hair}`, borderRadius: RADIUS.md, color: INK.secondary,
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
								style: { flex: "none", fontWeight: 500, color: hue(KINDS[0], 1) },
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
				return jsx("div", { style: { font: FONT.body, padding: "20px", color: INK.secondary },
					children: error === "" ? (zh ? "加载中…" : "Loading…") : error });
			}

			const heading = { margin: "24px 0 8px", font: FONT.bodyStrong, color: INK.primary };
			const hint = { margin: "0 0 12px", font: FONT.small, color: INK.secondary };
			const rowStyle = {
				display: "flex", alignItems: "center", gap: SPACE.md, padding: "10px 12px",
				border: `1px solid ${LINE.hair}`, borderRadius: RADIUS.md, marginBottom: "8px",
				background: SURFACE.card
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
							borderBottom: `1px solid ${LINE.hair}`
						},
						children: PANES.map((candidate) => jsxs("button", {
							type: "button",
							role: "tab",
							"aria-selected": pane === candidate.id,
							onClick: () => { setPane(candidate.id); },
							style: {
								appearance: "none", background: "transparent", cursor: "pointer",
								padding: "7px 12px", marginBottom: "-1px", border: "none",
								borderBottom: "2px solid " + (pane === candidate.id ? INK.primary : "transparent"),
								color: pane === candidate.id ? INK.primary : INK.secondary,
								font: pane === candidate.id ? FONT.smallStrong : FONT.small
							},
							children: [
								jsx("span", { children: zh ? candidate.zh : candidate.en }),
								candidate.count === undefined ? null : jsx("span", {
									// The count belongs on the tab. How many feeds there
									// are is the first thing anyone wants from this pane,
									// and putting it here saves opening it to find out.
									style: { font: FONT.micro,
										marginLeft: "6px", fontVariantNumeric: "tabular-nums",
										color: INK.secondary
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
											style: { font: FONT.micro,
												display: "flex", alignItems: "baseline", gap: SPACE.sm,
												margin: "16px 0 6px", letterSpacing: "0.04em",
												color: INK.secondary
											},
											children: [
												jsx("span", { style: { fontWeight: 500 }, children: kind }),
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
												style: { font: FONT.body, color: INK.primary, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" },
												children: feed.name ?? hostOf(feed.url) ?? feed.url
											}),
											jsx("span", {
												style: { font: FONT.micro, color: INK.secondary, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" },
												children: feed.url
											})
										]
									}),
									jsx("button", {
										type: "button",
										disabled: busy,
										className: "swm-ctl swm-focus", style: { ...controlStyle(busy), font: FONT.small, height: CONTROL.sm },
										onClick: () => {
											void save({ feeds: config.feeds.filter((_, at) => at !== index) }, zh ? "已移除。" : "Removed.");
										},
										children: zh ? "移除" : "Remove"
									})
								]
							}, "feed" + index))(entry))),
							jsxs("div", {
								style: { display: "flex", gap: SPACE.sm, marginTop: "10px" },
								children: [
									jsx("select", {
										value: feedType,
										onChange: (event) => { setFeedType(event.target.value); },
										className: "swm-ctl swm-focus", style: controlStyle(),
										children: config.resourceTypes.map((type) => jsx("option", { value: type, children: type }, type))
									}, "type"),
									jsx("input", {
										type: "url",
										value: feedUrl,
										placeholder: "https://example.com/feed.xml",
										onChange: (event) => { setFeedUrl(event.target.value); },
										className: "swm-focus", style: { ...SEARCH_STYLE, height: CONTROL.md, flex: 1 }
									}, "url"),
									jsx("button", {
										type: "button",
										disabled: busy || feedUrl.trim() === "",
										className: "swm-ctl swm-focus", style: controlStyle(busy || feedUrl.trim() === ""),
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
									style: { font: FONT.body, flex: 1, color: INK.primary },
									children: [job.collector, jsx("span", {
										style: { font: FONT.small, marginLeft: "8px", color: INK.secondary },
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
										? jsx("div", { style: { ...rowStyle, font: FONT.small, color: INK.secondary }, children: zh ? "服务启动后还没有跑过。" : "No run since this process started." })
										: jsxs("div", {
											children: status.runs.slice(0, 8).map((run, at) => jsxs("div", {
												style: {
													...rowStyle, alignItems: "flex-start", flexDirection: "column", gap: SPACE.xs,
													borderColor: run.failures.length === 0 ? LINE.hair : hue(alert, TINT.ring)
												},
												children: [
													jsxs("div", {
														style: { font: FONT.small, display: "flex", flexWrap: "wrap", gap: SPACE.md, width: "100%" },
														children: [
															jsx("span", { style: { fontWeight: 500, color: INK.primary }, children: formatStamp(run.startedAt) }),
															jsx("span", { style: { color: INK.secondary }, children: (zh ? "作业 " : "jobs ") + run.jobs }),
															jsx("span", { style: { color: INK.secondary }, children: (zh ? "抓取 " : "fetched ") + run.fetched }),
															jsx("span", {
																style: { color: run.added > 0 ? hue(alert) : INK.secondary, fontWeight: run.added > 0 ? 600 : 400 },
																children: (zh ? "新增 " : "added ") + run.added
															}),
															run.thumbnails === undefined || run.thumbnails === null ? null : jsx("span", {
																style: { color: INK.secondary },
																children: (zh ? "补图 " : "thumbnails ") + run.thumbnails.found + "/" + run.thumbnails.looked
															}),
															jsx("span", { style: { color: INK.secondary }, children: run.seconds + "s" }),
															jsx("span", { style: { flex: 1 } }, "spacer"),
															jsx("span", {
																style: { color: run.failures.length === 0 ? INK.secondary : hue(alert), fontWeight: run.failures.length === 0 ? 400 : 600 },
																children: run.failures.length === 0 ? (zh ? "全部成功" : "all ok") : (zh ? `${run.failures.length} 个源失败` : `${run.failures.length} failed`)
															})
														]
													}),
													...run.failures.slice(0, 4).map((failure, index) => jsx("div", {
														style: { font: FONT.micro, color: INK.secondary },
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
								style: { display: "flex", alignItems: "center", gap: SPACE.md },
								children: [
									jsx("button", {
										type: "button",
										disabled: busy,
										className: "swm-ctl swm-focus", style: controlStyle(busy),
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
								style: { display: "flex", gap: SPACE.sm, alignItems: "center" },
								children: [
									jsx("input", {
										type: "password",
										value: keyDraft,
										placeholder: config.supadataKeySet
											? (zh ? "已配置（留空则保持不变）" : "Configured (leave blank to keep)")
											: (zh ? "尚未配置" : "Not configured"),
										onChange: (event) => { setKeyDraft(event.target.value); },
										className: "swm-focus", style: { ...SEARCH_STYLE, height: CONTROL.md, flex: 1 }
									}, "key"),
									jsx("button", {
										type: "button",
										disabled: busy || keyDraft.trim() === "",
										className: "swm-ctl swm-focus", style: controlStyle(busy || keyDraft.trim() === ""),
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
											className: "swm-ctl swm-focus", style: controlStyle(busy),
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
						style: { font: FONT.small, marginTop: "14px", color: INK.secondary },
						children: notice
					}),
					error === "" ? null : jsx("p", {
						style: { font: FONT.small, marginTop: "14px", color: INK.secondary },
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
			missionFace, missionHue, missionIcon, missionPillFace, missionDuration, missionMeterLine,
			missionVerifyRows, missionEventDetail, missionNoEvidence, missionActionNote,
			missionTierLine, MISSION_FILTERS, MISSION_STAGE_FACES, MISSION_VERIFY_FACES,
			missionClock, missionSince, missionLatency, missionOkFace, missionRowTitle, missionRowState,
			missionTraceSignature, missionFindingsSignature,
			MISSION_ROLE_FACES, MISSION_TRACE_KINDS, MISSION_TRACE_TABS,
			SourcesSettings, SwarmPage, PublishTab, ExploreTab,
			MissionsTab, MissionStarter, MissionListRow, MissionDetail, MissionPanel,
			MissionCostMeters, MissionTried,
			MissionDetailTabs, MissionTaskBoard, MissionSources, MissionEmptyPane,
			MissionAgentTable, MissionStageDetail, MissionProgressBar, MissionStatTiles,
			MissionStageSpend, MissionToolTable, MissionDegradeNote, MissionReferenceList,
			missionReferences, missionMarkerCount, missionCompact,
			MissionTimeline, MissionReport, MissionEvidenceRow,
			MissionTrace, MissionTraceRow, MissionTraceDetail,
			MissionSourceReader, MissionClamp, MissionRework, MissionGoals, MissionSignoffCard,
			VersionLine, libraryLine
		};
		return module.exports;
	}
});
