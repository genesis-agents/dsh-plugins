/**
 * `dsh-web-search`, browser half: the web-search settings page.
 *
 * A table of backends, one row each, after the reference's tool-management
 * page: name, key state, which one is active, and a test button. The reference
 * can enable many at once because its model picks a tool per call; `ctx.web`
 * selects ONE provider, so here the column is a choice rather than a set of
 * switches — showing toggles that cannot all be on would misrepresent what the
 * seam does.
 *
 * It registers into `settings.section` because the shipped Plugins tab renders
 * a hand-picked set of first-party namespaces. `settings.section` is a `list`
 * slot, so this page is ADDED beside Models and the rest rather than shadowing
 * any of them.
 */
window.__ModuleLoader__.load({
	id: "@ai4gensteam/dsh-web-search",
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
			return `${window.location.origin}/web-search-api`;
		}

		/** Whether the document is presenting Chinese. */
		function isChinese() {
			return document.documentElement.lang.toLowerCase().startsWith("zh");
		}

		const HEADING = { margin: "24px 0 8px", fontSize: "13px", fontWeight: 600, color: "var(--dsw-alias-label-primary)" };
		const HINT = { margin: "0 0 14px", fontSize: "12px", lineHeight: "18px", color: "var(--dsw-alias-label-secondary)" };
		const FIELD = {
			appearance: "none", width: "100%", height: "32px", padding: "0 10px", borderRadius: "8px",
			border: "1px solid var(--dsw-alias-border-l2)", background: "transparent",
			color: "var(--dsw-alias-label-primary)", font: "inherit", fontSize: "13px", outline: "none",
			boxSizing: "border-box",
		};
		const BUTTON = {
			appearance: "none", height: "30px", padding: "0 12px", borderRadius: "8px",
			border: "1px solid var(--dsw-alias-border-l2)", background: "transparent",
			color: "var(--dsw-alias-label-secondary)", font: "inherit", fontSize: "12px", cursor: "pointer",
			whiteSpace: "nowrap",
		};
		const GREEN = "rgb(5,150,105)";
		const AMBER = "rgb(217,119,6)";
		const RED = "rgb(220,38,38)";

		/** A small state pill. */
		function Pill({ tone, children }) {
			return jsx("span", {
				style: {
					display: "inline-flex", alignItems: "center", height: "20px", padding: "0 8px",
					borderRadius: "999px", fontSize: "11px", fontWeight: 500,
					color: tone, background: tone.replace("rgb(", "rgba(").replace(")", ",0.1)"),
					whiteSpace: "nowrap",
				},
				children,
			});
		}

		/** One backend's row. */
		function BackendRow({ row, active, zh, busy, onActivate, onSave, onTest, result }) {
			const [keyDraft, setKeyDraft] = useState("");
			const [open, setOpen] = useState(false);
			const isActive = row.id === active;
			const keyState = row.savedKey
				? { tone: GREEN, label: zh ? "已保存" : "saved" }
				: row.envKey
					? { tone: GREEN, label: zh ? `环境变量 ${row.keyEnv}` : row.keyEnv }
					: { tone: AMBER, label: zh ? "未配置" : "not set" };

			return jsxs("div", {
				style: {
					border: "1px solid " + (isActive ? "var(--dsw-alias-border-l2)" : "var(--dsw-alias-border-l1)"),
					borderRadius: "12px", marginBottom: "10px",
					background: "var(--dsw-specific-menu)",
					boxShadow: isActive ? "var(--dsw-shadow-lv1)" : "none",
				},
				children: [
					jsxs("div", {
						style: { display: "flex", alignItems: "center", gap: "10px", padding: "12px 14px" },
						children: [
							// The choice, not a switch: the seam runs one provider, and
							// a row of toggles would suggest several can be on at once.
							jsx("input", {
								type: "radio",
								name: "web-search-active",
								checked: isActive,
								"aria-label": (zh ? "使用 " : "Use ") + row.label,
								onChange: () => { onActivate(row.id); },
								style: { flex: "none", cursor: "pointer" },
							}),
							jsxs("div", {
								style: { flex: 1, minWidth: 0 },
								children: [
									jsxs("div", {
										style: { display: "flex", alignItems: "center", gap: "8px" },
										children: [
											jsx("span", { style: { fontSize: "13px", fontWeight: 600, color: "var(--dsw-alias-label-primary)" }, children: row.label }),
											isActive ? jsx(Pill, { tone: GREEN, children: zh ? "使用中" : "in use" }) : null,
										],
									}),
									jsx("div", {
										style: { marginTop: "3px", fontSize: "11px", color: "var(--dsw-alias-label-secondary)" },
										children: zh ? row.note.zh : row.note.en,
									}),
								],
							}),
							jsx(Pill, { tone: keyState.tone, children: keyState.label }),
							jsx("button", {
								type: "button",
								disabled: busy,
								style: BUTTON,
								onClick: () => { onTest(row.id); },
								children: zh ? "测试" : "Test",
							}),
							jsx("button", {
								type: "button",
								style: { ...BUTTON, border: "none" },
								"aria-label": (zh ? "展开 " : "Configure ") + row.label,
								onClick: () => { setOpen((value) => !value); },
								children: open ? "▾" : "▸",
							}),
						],
					}),
					result === undefined ? null : jsx("div", {
						style: {
							padding: "0 14px 12px", fontSize: "11px",
							color: result.ok ? GREEN : RED,
						},
						children: result.text,
					}),
					!open ? null : jsxs("div", {
						style: { padding: "0 14px 14px", borderTop: "1px solid var(--dsw-alias-border-l1)", paddingTop: "12px" },
						children: [
							jsxs("div", {
								style: { display: "flex", gap: "8px", marginBottom: "10px" },
								children: [
									jsx("input", {
										type: "password",
										value: keyDraft,
										placeholder: row.savedKey ? (zh ? "已保存，留空则保持" : "saved; blank keeps it") : (zh ? `粘贴 ${row.label} API Key` : `Paste a ${row.label} API key`),
										onChange: (event) => { setKeyDraft(event.target.value); },
										style: { ...FIELD, flex: 1 },
									}),
									jsx("button", {
										type: "button",
										disabled: busy || keyDraft.trim() === "",
										style: { ...BUTTON, opacity: keyDraft.trim() === "" ? 0.5 : 1 },
										onClick: () => { onSave(row.id, { apiKey: keyDraft.trim() }); setKeyDraft(""); },
										children: zh ? "保存" : "Save",
									}),
									!row.savedKey ? null : jsx("button", {
										type: "button",
										disabled: busy,
										style: BUTTON,
										// An empty string is the explicit clear; the Host
										// distinguishes it from an absent field.
										onClick: () => { onSave(row.id, { apiKey: "" }); },
										children: zh ? "清除" : "Clear",
									}),
								],
							}),
							jsxs("div", {
								style: { display: "flex", gap: "8px" },
								children: [
									jsx("input", {
										defaultValue: row.country,
										placeholder: zh ? "国家 gl，如 cn" : "country gl, e.g. cn",
										onBlur: (event) => { if (event.target.value !== row.country) onSave(row.id, { country: event.target.value }); },
										style: FIELD,
									}),
									jsx("input", {
										defaultValue: row.locale,
										placeholder: zh ? "语言 hl，如 zh-cn" : "language hl, e.g. zh-cn",
										onBlur: (event) => { if (event.target.value !== row.locale) onSave(row.id, { locale: event.target.value }); },
										style: FIELD,
									}),
								],
							}),
							jsxs("div", {
								style: { marginTop: "8px", fontSize: "11px", color: "var(--dsw-alias-label-secondary)" },
								children: [
									zh ? "环境变量 " : "Environment variable ",
									jsx("code", { style: { fontFamily: "var(--ds-font-family-code)" }, children: row.keyEnv }),
									zh ? "；也可在此保存。写在文件里的 Key 会跟着备份一起走。 " : "; or save one here. A key in a config file is a key in a backup. ",
									jsx("a", {
										href: row.docs, target: "_blank", rel: "noreferrer noopener",
										style: { color: "var(--dsw-alias-label-link)" },
										children: zh ? "获取 Key ↗" : "Get a key ↗",
									}),
								],
							}),
						],
					}),
				],
			});
		}

		/** The web-search settings page. */
		function WebSearchSettings() {
			const zh = isChinese();
			const [state, setState] = useState(null);
			const [error, setError] = useState("");
			const [busy, setBusy] = useState(false);
			const [results, setResults] = useState({});

			const reload = useCallback(async () => {
				try {
					const response = await fetch(`${apiBase()}/config`);
					const payload = await response.json();
					if (payload?.success !== true) throw new Error(payload?.error ?? "HTTP " + response.status);
					setState(payload.data);
					setError("");
				} catch (cause) {
					setError(String(cause?.message ?? cause));
				}
			}, []);

			useEffect(() => { void reload(); }, [reload]);

			const put = useCallback(async (body) => {
				setBusy(true);
				try {
					const response = await fetch(`${apiBase()}/config`, {
						method: "PUT",
						headers: { "content-type": "application/json" },
						body: JSON.stringify(body),
					});
					const payload = await response.json();
					if (payload?.success !== true) throw new Error(payload?.error ?? "HTTP " + response.status);
					await reload();
					setError("");
				} catch (cause) {
					setError(String(cause?.message ?? cause));
				} finally {
					setBusy(false);
				}
			}, [reload]);

			const test = useCallback(async (id) => {
				setBusy(true);
				setResults((previous) => ({ ...previous, [id]: { ok: true, text: zh ? "测试中…" : "Testing…" } }));
				try {
					const response = await fetch(`${apiBase()}/test`, {
						method: "POST",
						headers: { "content-type": "application/json" },
						body: JSON.stringify({ backend: id }),
					});
					const payload = await response.json();
					setResults((previous) => ({
						...previous,
						[id]: payload?.success === true
							? {
								ok: true,
								text: zh
									? `成功：${payload.data.sources} 条结果，${payload.data.ms}ms${payload.data.sample === "" ? "" : `，例如「${payload.data.sample}」`}`
									: `OK: ${payload.data.sources} result(s) in ${payload.data.ms}ms${payload.data.sample === "" ? "" : `, e.g. "${payload.data.sample}"`}`,
							}
							: { ok: false, text: (zh ? "失败：" : "Failed: ") + (payload?.error ?? "unknown") },
					}));
				} catch (cause) {
					setResults((previous) => ({ ...previous, [id]: { ok: false, text: String(cause?.message ?? cause) } }));
				} finally {
					setBusy(false);
				}
			}, [zh]);

			if (state === null) {
				return jsx("div", {
					style: { padding: "16px", fontSize: "13px", color: "var(--dsw-alias-label-secondary)" },
					children: error === "" ? (zh ? "读取中…" : "Loading…") : error,
				});
			}

			return jsxs("div", {
				style: { padding: "4px 4px 32px", maxWidth: "680px" },
				children: [
					jsx("h3", { style: { ...HEADING, marginTop: "8px" }, children: zh ? "搜索" : "Search" }),
					jsx("p", {
						style: HINT,
						children: zh
							? "agent 的 web_search 工具通过下面选中的服务检索。一次只有一个生效 —— harness 的 web 能力按 id 选定单一提供方；其余的配置会保留，随时可切换。"
							: "The agent's web_search tool retrieves through the selected service. Exactly one is in use — the harness's web capability selects a single provider by id; the others keep their configuration and can be switched to at any time.",
					}),
					...state.backends.map((row) => jsx(BackendRow, {
						row,
						active: state.active,
						zh,
						busy,
						result: results[row.id],
						onActivate: (id) => { void put({ active: id }); },
						onSave: (id, patch) => { void put({ backend: id, ...patch }); },
						onTest: (id) => { void test(id); },
					}, row.id)),
					!state.writable ? jsx("p", {
						style: { ...HINT, marginTop: "12px" },
						children: zh
							? "没有挂载设置存储，此页只读；请改用环境变量或 profile 配置。"
							: "No settings provider is mounted, so this page is read-only; use the environment variables or the profile config.",
					}) : null,
					error === "" ? null : jsx("p", { style: { ...HINT, marginTop: "12px", color: RED }, children: error }),
				],
			});
		}

		/** Services this browser half needs. */
		const inject = ["slots"];

		/** Register the settings page. */
		function apply(ctx) {
			ctx.slots.inject("settings.section", () => ctx.slots.register({
				name: "settings.section",
				id: "web-search",
				order: 61,
				// Short, like every sibling in that column. The others are 模型 /
				// 插件 / 信源; a two-word label reads as a different kind of thing.
				label: () => (isChinese() ? "搜索" : "Search"),
			}, WebSearchSettings));
		}

		exports.apply = apply;
		exports.inject = inject;
		return module.exports;
	},
});
