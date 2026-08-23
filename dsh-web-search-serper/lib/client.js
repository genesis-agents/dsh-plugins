/**
 * `dsh-web-search-serper`, browser half: the Serper settings page.
 *
 * It registers into `settings.section` — the shell's own Settings panel —
 * because the shipped Plugins tab renders a hand-picked set of first-party
 * namespaces. Thirteen namespaces are registered on this deployment and three
 * get a card; a third-party provider is not one of them. Registering the
 * namespace makes the section readable and writable through the settings
 * document, but a key that can only be entered by editing YAML is a key most
 * people will never enter. `settings.section` is a `list` slot, so this page is
 * ADDED beside Models and the rest rather than shadowing any of them.
 *
 * The key is write-only across the wire: the Host reports whether one is
 * stored and where it comes from, never its value, and an untouched field is
 * not sent back — so saving a country code cannot silently clear a secret.
 */
window.__ModuleLoader__.load({
	id: "dsh-web-search-serper",
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
		const useState = react.useState;

		/** Where the Host half serves this page's data. */
		function apiBase() {
			return `${window.location.origin}/serper-api`;
		}

		/** Whether the document is presenting Chinese. */
		function isChinese() {
			return document.documentElement.lang.toLowerCase().startsWith("zh");
		}

		const HEADING = { margin: "24px 0 8px", fontSize: "13px", fontWeight: 600, color: "var(--dsw-alias-label-primary)" };
		const HINT = { margin: "0 0 12px", fontSize: "12px", lineHeight: "18px", color: "var(--dsw-alias-label-secondary)" };
		const FIELD = {
			appearance: "none", width: "100%", height: "34px", padding: "0 10px", borderRadius: "8px",
			border: "1px solid var(--dsw-alias-border-l2)", background: "transparent",
			color: "var(--dsw-alias-label-primary)", font: "inherit", fontSize: "13px", outline: "none",
			boxSizing: "border-box",
		};
		const BUTTON = {
			appearance: "none", height: "34px", padding: "0 14px", borderRadius: "8px",
			border: "1px solid var(--dsw-alias-border-l2)", background: "transparent",
			color: "var(--dsw-alias-label-secondary)", font: "inherit", fontSize: "13px", cursor: "pointer",
		};
		const ROW = { display: "flex", alignItems: "center", gap: "10px", marginBottom: "10px" };

		/** One labelled field. */
		function Field({ label, hint, children }) {
			return jsxs("div", {
				style: { marginBottom: "14px" },
				children: [
					jsx("div", { style: { marginBottom: "6px", fontSize: "12px", fontWeight: 500, color: "var(--dsw-alias-label-primary)" }, children: label }),
					children,
					hint === undefined ? null : jsx("div", { style: { marginTop: "5px", fontSize: "11px", color: "var(--dsw-alias-label-secondary)" }, children: hint }),
				],
			});
		}

		/** The Serper settings page. */
		function SerperSettings() {
			const zh = isChinese();
			const [state, setState] = useState(null);
			const [error, setError] = useState("");
			const [notice, setNotice] = useState("");
			const [busy, setBusy] = useState(false);
			const [keyDraft, setKeyDraft] = useState("");
			const [country, setCountry] = useState("");
			const [locale, setLocale] = useState("");

			const reload = useCallback(async () => {
				try {
					const response = await fetch(`${apiBase()}/config`);
					const payload = await response.json();
					if (payload?.success !== true) throw new Error(payload?.error ?? "HTTP " + response.status);
					setState(payload.data);
					setCountry(payload.data.country ?? "");
					setLocale(payload.data.locale ?? "");
					setError("");
				} catch (cause) {
					setError(String(cause?.message ?? cause));
				}
			}, []);

			useEffect(() => { void reload(); }, [reload]);

			const save = useCallback(async (patch, message) => {
				setBusy(true);
				setNotice("");
				try {
					const response = await fetch(`${apiBase()}/config`, {
						method: "PUT",
						headers: { "content-type": "application/json" },
						body: JSON.stringify(patch),
					});
					const payload = await response.json();
					if (payload?.success !== true) throw new Error(payload?.error ?? "HTTP " + response.status);
					setNotice(message);
					setKeyDraft("");
					await reload();
				} catch (cause) {
					setError(String(cause?.message ?? cause));
				} finally {
					setBusy(false);
				}
			}, [reload]);

			const test = useCallback(async () => {
				setBusy(true);
				setNotice("");
				setError("");
				try {
					const response = await fetch(`${apiBase()}/test`, { method: "POST" });
					const payload = await response.json();
					if (payload?.success !== true) {
						setError((zh ? "搜索失败：" : "Search failed: ") + (payload?.error ?? "unknown"));
						return;
					}
					setNotice(zh
						? `搜索成功：返回 ${payload.data.sources} 条结果${payload.data.sample === "" ? "" : `，例如「${payload.data.sample}」`}`
						: `Search succeeded: ${payload.data.sources} result(s)${payload.data.sample === "" ? "" : `, e.g. "${payload.data.sample}"`}`);
				} catch (cause) {
					setError(String(cause?.message ?? cause));
				} finally {
					setBusy(false);
				}
			}, [zh]);

			if (state === null) {
				return jsx("div", { style: { padding: "16px", fontSize: "13px", color: "var(--dsw-alias-label-secondary)" }, children: error === "" ? (zh ? "读取中…" : "Loading…") : error });
			}

			// Say which of the three states the key is in, not merely whether one
			// exists. "Configured" without saying where would leave an operator
			// guessing why a search still fails.
			const keyState = state.savedKey
				? (zh ? "已保存在设置中" : "saved in settings")
				: state.envKey
					? (zh ? `来自环境变量 ${state.keyEnv}` : `from ${state.keyEnv}`)
					: (zh ? "未配置" : "not configured");
			const hasKey = state.savedKey || state.envKey;

			return jsxs("div", {
				style: { padding: "4px 4px 32px", maxWidth: "620px" },
				children: [
					jsx("h3", { style: { ...HEADING, marginTop: "8px" }, children: zh ? "Serper 网页搜索" : "Serper web search" }),
					jsx("p", {
						style: HINT,
						children: zh
							? "Serper 把 Google 的搜索结果以 JSON 返回。填入 API Key 后，agent 的 web_search 工具即通过它检索。"
							: "Serper returns Google's results as JSON. With a key, the agent's web_search tool retrieves through it.",
					}),

					jsxs("div", {
						style: {
							display: "flex", alignItems: "center", gap: "8px", marginBottom: "16px",
							padding: "10px 12px", borderRadius: "10px",
							border: "1px solid var(--dsw-alias-border-l1)", background: "var(--dsw-specific-menu)",
							fontSize: "12px",
						},
						children: [
							jsx("span", {
								style: {
									width: "8px", height: "8px", borderRadius: "50%", flex: "none",
									background: hasKey ? "rgb(5,150,105)" : "rgb(217,119,6)",
								},
							}),
							jsx("span", { style: { color: "var(--dsw-alias-label-primary)", fontWeight: 500 }, children: zh ? "API Key" : "API key" }),
							jsx("span", { style: { color: "var(--dsw-alias-label-secondary)" }, children: keyState }),
							jsx("span", { style: { flex: 1 } }),
							jsx("button", {
								type: "button",
								disabled: busy || !hasKey,
								style: { ...BUTTON, height: "28px", fontSize: "12px", opacity: hasKey ? 1 : 0.5 },
								onClick: () => { void test(); },
								children: zh ? "测试搜索" : "Test search",
							}),
						],
					}),

					jsx(Field, {
						label: zh ? "API Key" : "API key",
						hint: zh
							? "保存后不会再显示。留空表示保持当前值。也可以改用环境变量，见下。"
							: "Never shown again once saved. Leave blank to keep the current value, or use the environment variable below.",
						children: jsxs("div", {
							style: ROW,
							children: [
								jsx("input", {
									type: "password",
									value: keyDraft,
									placeholder: state.savedKey ? (zh ? "已保存" : "saved") : (zh ? "粘贴 Serper API Key" : "Paste a Serper API key"),
									onChange: (event) => { setKeyDraft(event.target.value); },
									style: { ...FIELD, flex: 1 },
								}),
								jsx("button", {
									type: "button",
									disabled: busy || keyDraft.trim() === "",
									style: { ...BUTTON, opacity: keyDraft.trim() === "" ? 0.5 : 1 },
									onClick: () => { void save({ apiKey: keyDraft.trim() }, zh ? "API Key 已保存。" : "API key saved."); },
									children: zh ? "保存" : "Save",
								}),
								!state.savedKey ? null : jsx("button", {
									type: "button",
									disabled: busy,
									style: BUTTON,
									// An empty string is the explicit clear; the Host
									// distinguishes it from an absent field.
									onClick: () => { void save({ apiKey: "" }, zh ? "已清除保存的 Key。" : "Saved key cleared."); },
									children: zh ? "清除" : "Clear",
								}),
							],
						}),
					}),

					jsx(Field, {
						label: zh ? "环境变量名" : "Environment variable",
						hint: zh
							? `当前为 ${state.keyEnv}。写在文件里的 Key 会跟着备份一起走，用环境变量更稳妥。`
							: `Currently ${state.keyEnv}. A key in a config file is a key in a backup; the environment is safer.`,
						children: jsx("div", { style: { ...ROW, marginBottom: 0 }, children: jsx("code", {
							style: { ...FIELD, display: "flex", alignItems: "center", fontFamily: "var(--ds-font-family-code)", color: "var(--dsw-alias-label-secondary)" },
							children: state.keyEnv,
						}) }),
					}),

					jsx("h3", { style: HEADING, children: zh ? "检索偏好" : "Retrieval" }),
					jsxs("div", {
						style: { display: "flex", gap: "10px" },
						children: [
							jsx("div", { style: { flex: 1 }, children: jsx(Field, {
								label: zh ? "国家 (gl)" : "Country (gl)",
								hint: zh ? "例如 cn、us。留空则由 Serper 决定。" : "e.g. cn, us. Blank lets Serper decide.",
								children: jsx("input", {
									value: country,
									placeholder: "cn",
									onChange: (event) => { setCountry(event.target.value); },
									onBlur: () => { if (country !== (state.country ?? "")) void save({ country }, zh ? "已保存。" : "Saved."); },
									style: FIELD,
								}),
							}) }),
							jsx("div", { style: { flex: 1 }, children: jsx(Field, {
								label: zh ? "语言 (hl)" : "Language (hl)",
								hint: zh ? "例如 zh-cn、en。" : "e.g. zh-cn, en.",
								children: jsx("input", {
									value: locale,
									placeholder: "zh-cn",
									onChange: (event) => { setLocale(event.target.value); },
									onBlur: () => { if (locale !== (state.locale ?? "")) void save({ locale }, zh ? "已保存。" : "Saved."); },
									style: FIELD,
								}),
							}) }),
						],
					}),

					!state.writable ? jsx("p", {
						style: { ...HINT, marginTop: "12px" },
						children: zh
							? "没有挂载设置存储，此页只读；请改用环境变量或 profile 配置。"
							: "No settings provider is mounted, so this page is read-only; use the environment variable or the profile config.",
					}) : null,
					notice === "" ? null : jsx("p", { style: { ...HINT, marginTop: "12px", color: "rgb(5,150,105)" }, children: notice }),
					error === "" ? null : jsx("p", { style: { ...HINT, marginTop: "12px", color: "rgb(220,38,38)" }, children: error }),
				],
			});
		}

		/** Services this browser half needs. */
		const inject = ["slots"];

		/** Register the settings page. */
		function apply(ctx) {
			ctx.slots.inject("settings.section", () => ctx.slots.register({
				name: "settings.section",
				id: "web-search-serper",
				order: 61,
				label: () => (isChinese() ? "网页搜索" : "Web search"),
			}, SerperSettings));
		}

		exports.apply = apply;
		exports.inject = inject;
		return module.exports;
	},
});
