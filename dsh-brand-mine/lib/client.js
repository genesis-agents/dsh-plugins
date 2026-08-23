window.__ModuleLoader__.load({
	id: "dsh-brand-mine",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		let react_jsx_runtime = require("react/jsx-runtime");
		const jsx = react_jsx_runtime.jsx;
		const jsxs = react_jsx_runtime.jsxs;
		const Fragment = react_jsx_runtime.Fragment;

		//#region Brand
		/**
		* Badge styling mirrors the sidebar's own `.buildRevision` rule, including
		* its theme tokens, so the corner mark tracks light/dark with the rest of
		* the column. The occupant cannot reach the owner's CSS module, so the
		* rule is restated rather than imported.
		*/
		const BADGE_STYLE = {
			display: "inline-flex",
			alignItems: "center",
			height: "16px",
			padding: "0 4px",
			borderRadius: "3px",
			color: "var(--dsw-alias-label-primary-inverted)",
			background: "var(--dsw-alias-label-primary)",
			fontFamily: "var(--ds-font-family-code)",
			fontSize: "8px",
			fontWeight: 500,
			lineHeight: "16px",
			letterSpacing: 0
		};
		/** Matches the shell's `.fallbackBrandName` metrics so the row keeps its height. */
		const NAME_STYLE = {
			fontSize: "17px",
			fontWeight: 600,
			letterSpacing: 0,
			whiteSpace: "nowrap"
		};
		/** Render the Genesis mark at the size its host surface requests. */
		function MyBrandMark({ size = 24, className }) {
			return jsxs("svg", {
				width: size,
				height: size,
				viewBox: "0 0 32 32",
				fill: "none",
				className,
				"aria-hidden": "true",
				children: [
					jsx("path", {
						d: "M16 3 L27.26 9.5 L27.26 22.5 L16 29 L4.74 22.5 L4.74 9.5 Z",
						stroke: "currentColor",
						strokeWidth: 2.2,
						strokeLinejoin: "round"
					}),
					jsx("circle", { cx: 16, cy: 11.6, r: 2.5, fill: "currentColor" }),
					jsx("circle", { cx: 11.4, cy: 19.6, r: 2.5, fill: "currentColor" }),
					jsx("circle", { cx: 20.6, cy: 19.6, r: 2.5, fill: "currentColor" })
				]
			});
		}
		/** Render the product name with its origin badge, without the slotted mark. */
		function MyBrandName() {
			return jsxs(Fragment, {
				children: [
					jsx("span", { style: NAME_STYLE, children: "Genesis Harness" }),
					jsx("span", { style: BADGE_STYLE, children: "deepseek" })
				]
			});
		}
		//#endregion

		//#region plugin
		/** Required service: the UI slot registry. */
		const inject = ["slots"];
		/**
		* Rank that wins a contested brand seat. Lower renders; these are single
		* slots, so an equal rank is a COLLISION that takes the whole UI down
		* rather than a second occupant. `@linxin666/dsh-liangshen` claims
		* `sidebar.brand.mark` from 0.2.9, which a `^0.2.1` profile picks up on a
		* fresh install — this is what that looked like.
		*/
		const SHADOW = -1;
		/** Fill every shipped brand slot as one declaration-aware registration set. */
		function apply(ctx) {
			ctx.slots.inject("sidebar.brand.mark", () => ctx.slots.inject("sidebar.brand.name", () => ctx.slots.inject("conversation.hero.brand.mark", function* () {
				yield ctx.slots.register({ name: "sidebar.brand.mark", priority: SHADOW }, MyBrandMark);
				yield ctx.slots.register({ name: "sidebar.brand.name", priority: SHADOW }, MyBrandName);
				yield ctx.slots.register({ name: "conversation.hero.brand.mark", priority: SHADOW }, MyBrandMark);
			})));
		}
		//#endregion
		exports.apply = apply;
		exports.inject = inject;
		return module.exports;
	}
});
