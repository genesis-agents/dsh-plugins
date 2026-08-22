window.__ModuleLoader__.load({
	id: "dsh-brand-mine",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		let react_jsx_runtime = require("react/jsx-runtime");
		const jsx = react_jsx_runtime.jsx;
		const jsxs = react_jsx_runtime.jsxs;

		//#region Brand
		/** Render the custom mark at the size its host surface requests. */
		function MyBrandMark({ size = 24, className }) {
			return jsxs("svg", {
				width: size,
				height: size,
				viewBox: "0 0 32 32",
				fill: "none",
				className,
				"aria-hidden": "true",
				children: [
					jsx("rect", {
						x: 1.5, y: 1.5, width: 29, height: 29, rx: 8.5,
						stroke: "currentColor", strokeWidth: 2.2
					}),
					jsx("path", {
						d: "M9 22.5V10.5L16 18l7-7.5v12",
						stroke: "currentColor", strokeWidth: 2.6,
						strokeLinecap: "round", strokeLinejoin: "round"
					})
				]
			});
		}
		/** Render the custom name artwork without its independently slotted mark. */
		function MyBrandName() {
			return jsx("span", {
				style: { fontWeight: 650, letterSpacing: "-0.01em" },
				children: "My Harness"
			});
		}
		//#endregion

		//#region plugin
		/** Required service: the UI slot registry. */
		const inject = ["slots"];
		/** Fill every shipped brand slot as one declaration-aware registration set. */
		function apply(ctx) {
			ctx.slots.inject("sidebar.brand.mark", () => ctx.slots.inject("sidebar.brand.name", () => ctx.slots.inject("conversation.hero.brand.mark", function* () {
				yield ctx.slots.register({ name: "sidebar.brand.mark" }, MyBrandMark);
				yield ctx.slots.register({ name: "sidebar.brand.name" }, MyBrandName);
				yield ctx.slots.register({ name: "conversation.hero.brand.mark" }, MyBrandMark);
			})));
		}
		//#endregion
		exports.apply = apply;
		exports.inject = inject;
		return module.exports;
	}
});
