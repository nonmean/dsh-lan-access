window.__ModuleLoader__.load({
	id: "dsh-lan-access",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		let react = require("react");
		let react_jsx_runtime = require("react/jsx-runtime");
		//#region src/client/api.ts
		/** One wire failure (network errors carry code 'network'). */
		var LanAccessApiError = class extends Error {
			code;
			constructor(code, message) {
				super(message);
				this.code = code;
			}
		};
		async function call(path, init) {
			let response;
			try {
				response = await fetch(path, init);
			} catch (error) {
				throw new LanAccessApiError("network", error instanceof Error ? error.message : String(error));
			}
			let body;
			try {
				body = await response.json();
			} catch {
				throw new LanAccessApiError("bad-response", "lan-access: response is not JSON");
			}
			const envelope = body;
			if (envelope.ok !== true || envelope.value === void 0 || typeof envelope.value !== "object") throw new LanAccessApiError(envelope.error?.code ?? "unknown", envelope.error?.message ?? "lan-access: request failed");
			return envelope.value;
		}
		/** Read the current state. */
		function getState(signal) {
			return call("/lan-access", {
				signal,
				headers: { accept: "application/json" }
			});
		}
		/** Persist and apply one enabled value (the host restarts the web server). */
		function setEnabled(enabled) {
			return call("/lan-access", {
				method: "POST",
				headers: {
					"content-type": "application/json",
					accept: "application/json"
				},
				body: JSON.stringify({ enabled })
			});
		}
		//#endregion
		//#region src/client/locales.ts
		/** Simplified Chinese copy. */
		const zh = {
			title: "局域网访问",
			desc: "允许同一网络中的其他设备打开此界面（绑定 0.0.0.0）。",
			urlLabel: "其他设备可访问",
			copy: "复制",
			copied: "已复制",
			applying: "正在应用更改，连接会短暂中断…",
			loading: "加载中…",
			loadFailed: "无法读取访问状态",
			saveFailed: "更改失败",
			timeout: "服务器重启后未能重新连接，请刷新页面重试"
		};
		/** English copy. */
		const en = {
			title: "LAN access",
			desc: "Let other devices on the same network open this GUI (bind 0.0.0.0).",
			urlLabel: "Other devices can open",
			copy: "Copy",
			copied: "Copied",
			applying: "Applying change — the connection will drop briefly…",
			loading: "Loading…",
			loadFailed: "Failed to read the access state",
			saveFailed: "Failed to apply the change",
			timeout: "Could not reconnect after the server restart — refresh the page"
		};
		/** The plugin's locale namespace (dictionary registry key). */
		const LOCALE_NS = "lan-access";
		let service;
		/** Bind the locale service (apply time); the row re-renders on locale switches. */
		function attachLocale(locale) {
			service = locale;
		}
		/** Current active locale id ('zh' | 'en'), or a browser-language guess. */
		function activeLocale() {
			if (service !== void 0) return service.getSnapshot().active;
			if (typeof navigator !== "undefined") {
				if ((navigator.language ?? "").toLowerCase().split("-")[0] === "zh") return "zh";
			}
			return "en";
		}
		/** Resolve one copy key in the active locale. */
		function translate(key) {
			return (activeLocale() === "zh" ? zh : en)[key] ?? String(key);
		}
		/** React subscription seam for the active locale (useSyncExternalStore). */
		function subscribeLocale(fn) {
			return service?.subscribe(fn) ?? (() => {});
		}
		//#endregion
		//#region src/client/LanAccessRow.tsx
		/**
		* LAN-access preference row in the General settings section (the DSH
		* settings-row recipe: title/description left, control right, hairline
		* separator; the section column strips the trailing one).
		*
		* The row talks to the fenced /lan-access host route directly. Flipping the
		* switch persists the namespace and restarts the web server to rebind, so
		* the in-flight request (and any follow-up read) can drop mid-restart: after
		* a write the row polls the route until the server answers again, then
		* reflects the fresh state. Disabling from a remote machine intentionally
		* cuts that machine off — the row then reports the timeout message instead
		* of silently lying about the state.
		*/
		/** Poll cadence while the web server restarts. */
		const POLL_INTERVAL_MS = 600;
		/** Give up after this long without a reachable server. */
		const POLL_TIMEOUT_MS = 15e3;
		/** Re-render on locale switches (the DSH locale service is uSES-safe). */
		function useLocale() {
			return (0, react.useSyncExternalStore)(subscribeLocale, activeLocale);
		}
		/** Custom switch: a real checkbox (native semantics + focus) driving a styled track/thumb. */
		function Switch(props) {
			const { checked, disabled, label, onChange } = props;
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("label", {
				style: {
					position: "relative",
					display: "inline-flex",
					flex: "none",
					cursor: disabled ? "default" : "pointer",
					opacity: disabled ? .6 : 1
				},
				children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("input", {
					type: "checkbox",
					className: "lan-access-switch-input",
					style: {
						position: "absolute",
						width: 1,
						height: 1,
						margin: 0,
						opacity: 0
					},
					checked,
					disabled,
					"aria-label": label,
					onChange: (event) => {
						onChange(event.currentTarget.checked);
					}
				}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
					"aria-hidden": "true",
					style: {
						display: "inline-flex",
						alignItems: "center",
						width: 36,
						height: 20,
						padding: 2,
						boxSizing: "border-box",
						borderRadius: 10,
						border: "1px solid " + (checked ? "var(--dsw-alias-button-primary-fill)" : "var(--dsw-alias-border-l2)"),
						background: checked ? "var(--dsw-alias-button-primary-fill)" : "var(--dsw-alias-bg-layer-1)",
						transition: "background 0.15s ease, border-color 0.15s ease"
					},
					children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { style: {
						display: "block",
						width: 14,
						height: 14,
						borderRadius: "50%",
						background: checked ? "var(--dsw-alias-bg-layer-3)" : "var(--dsw-alias-label-secondary)",
						transform: checked ? "translateX(16px)" : "none",
						transition: "transform 0.15s ease, background 0.15s ease"
					} })
				})]
			});
		}
		/** Map one failure to copy: network errors and the timeout get friendly text
		*  instead of the raw "Failed to fetch" the browser reports mid-restart. */
		function messageOf(error, fallback) {
			if (error instanceof LanAccessApiError) {
				if (error.code === "timeout") return translate("timeout");
				if (error.code === "network") return fallback;
			}
			return error instanceof Error && error.message !== "" ? error.message : fallback;
		}
		/** Sleep helper. */
		function sleep(ms) {
			return new Promise((resolve) => setTimeout(resolve, ms));
		}
		/**
		* Render the LAN-access preference row.
		* @returns the row element tree.
		*/
		function LanAccessRow(_props) {
			useLocale();
			const [state, setState] = (0, react.useState)(null);
			const [busy, setBusy] = (0, react.useState)(false);
			const [error, setError] = (0, react.useState)(null);
			const [copied, setCopied] = (0, react.useState)(false);
			const load = (0, react.useCallback)(async () => {
				for (let attempt = 0; attempt < 6; attempt += 1) try {
					setState(await getState());
					setError(null);
					return;
				} catch (error) {
					if (!(error instanceof LanAccessApiError && (error.code === "network" || error.code === "not-ready"))) {
						setError(messageOf(error, translate("loadFailed")));
						return;
					}
					if (attempt < 5) await sleep(700 + attempt * 500);
				}
				setError(translate("loadFailed"));
			}, []);
			(0, react.useEffect)(() => {
				load();
			}, [load]);
			/** Apply one toggle; poll through the server restart, then re-read. */
			const toggle = (0, react.useCallback)(async (next) => {
				setBusy(true);
				setError(null);
				try {
					try {
						await setEnabled(next);
					} catch (error) {
						if (!(error instanceof LanAccessApiError) || error.code !== "network") throw error;
					}
					const deadline = Date.now() + POLL_TIMEOUT_MS;
					for (;;) {
						try {
							const fresh = await getState();
							if (fresh.ready) {
								setState(fresh);
								break;
							}
						} catch {}
						if (Date.now() > deadline) throw new LanAccessApiError("timeout", translate("timeout"));
						await sleep(POLL_INTERVAL_MS);
					}
					setError(null);
				} catch (error) {
					setError(messageOf(error, translate("saveFailed")));
				} finally {
					setBusy(false);
				}
			}, []);
			const enabled = state?.enabled ?? false;
			const ready = state?.ready === true && !busy;
			const copyUrl = () => {
				if (state?.url === null || state?.url === void 0) return;
				navigator.clipboard?.writeText(state.url).then(() => {
					setCopied(true);
					setTimeout(() => {
						setCopied(false);
					}, 1200);
				}).catch(() => {});
			};
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
				style: {
					display: "flex",
					alignItems: "center",
					gap: 8,
					padding: "16px 0",
					borderBottom: "1px solid var(--dsw-alias-border-l2)"
				},
				children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
					style: {
						flex: 1,
						minWidth: 0,
						display: "flex",
						flexDirection: "column",
						gap: 4,
						paddingRight: 48
					},
					children: [
						/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
							style: {
								fontSize: 14,
								fontWeight: 400,
								lineHeight: "22px",
								color: "var(--dsw-alias-label-primary)"
							},
							children: translate("title")
						}),
						/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
							style: {
								fontSize: 12,
								fontWeight: 400,
								lineHeight: "18px",
								color: "var(--dsw-alias-label-tertiary)"
							},
							children: translate("desc")
						}),
						state?.ready === true && state.enabled && state.url !== null && state.url !== void 0 && /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
							style: {
								display: "flex",
								alignItems: "center",
								flexWrap: "wrap",
								gap: 8,
								marginTop: 2
							},
							children: [
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
									style: {
										fontSize: 12,
										lineHeight: "18px",
										color: "var(--dsw-alias-label-tertiary)"
									},
									children: translate("urlLabel")
								}),
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)("code", {
									style: {
										fontSize: 12,
										lineHeight: "18px",
										color: "var(--dsw-alias-label-primary)",
										background: "var(--dsw-alias-bg-module-platform)",
										padding: "2px 8px",
										borderRadius: 6
									},
									children: state.url
								}),
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
									type: "button",
									onClick: copyUrl,
									style: {
										border: "none",
										background: "transparent",
										padding: 0,
										font: "inherit",
										fontSize: 12,
										lineHeight: "18px",
										color: "var(--dsw-alias-state-business-primary)",
										cursor: "pointer"
									},
									children: copied ? translate("copied") : translate("copy")
								})
							]
						}),
						state === null && !busy && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
							style: {
								fontSize: 12,
								lineHeight: "18px",
								color: "var(--dsw-alias-label-tertiary)"
							},
							children: translate("loading")
						}),
						busy && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
							style: {
								fontSize: 12,
								lineHeight: "18px",
								color: "var(--dsw-alias-label-tertiary)"
							},
							children: translate("applying")
						}),
						error !== null && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
							role: "alert",
							style: {
								fontSize: 12,
								lineHeight: "18px",
								color: "var(--dsw-alias-label-danger, #d92d20)"
							},
							children: error
						})
					]
				}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)(Switch, {
					checked: enabled,
					disabled: !ready,
					label: translate("title"),
					onChange: (next) => {
						toggle(next);
					}
				})]
			});
		}
		//#endregion
		//#region src/client/polyfill.ts
		/** Format 16 random bytes as a UUID v4 string. */
		function uuidV4FromBytes(bytes) {
			bytes[6] = bytes[6] & 15 | 64;
			bytes[8] = bytes[8] & 63 | 128;
			const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
			return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
		}
		/** Install the polyfill when the platform lacks crypto.randomUUID. */
		function installRandomUUIDPolyfill() {
			const cryptoObj = globalThis.crypto;
			if (cryptoObj === void 0 || typeof cryptoObj.randomUUID === "function") return;
			try {
				const buffer = new Uint8Array(16);
				Object.defineProperty(cryptoObj, "randomUUID", {
					configurable: true,
					value: () => {
						cryptoObj.getRandomValues(buffer);
						return uuidV4FromBytes(buffer);
					}
				});
			} catch {}
		}
		//#endregion
		//#region src/client/connection-patch.ts
		/**
		* Whether a WHATWG hostname is a served (non-loopback) authority. This is the
		* client-side twin of the server's browser-trust fence: the page only runs
		* this code because the DSH webserver itself served it, and the server fence
		* refuses unknown Hosts — so any non-loopback hostname that served this page
		* (an IPv4 LAN literal, a DNS name, a Tailscale name, ...) is a served
		* authority. Covers plain-HTTP LAN access and HTTPS via a reverse proxy
		* (IP or hostname).
		*/
		function isServedLanHostname(hostname) {
			if (hostname === "" || hostname === "localhost" || hostname === "[::1]") return false;
			const parts = hostname.split(".");
			if (parts.length === 4 && parts.every((part) => /^\d{1,3}$/.test(part) && Number(part) <= 255)) return parts[0] !== "127";
			return true;
		}
		/**
		* Widen `connection.isLoopback` to "loopback OR served LAN authority", so
		* settingsScope-bound surfaces use host persistence on LAN pages.
		* @param connection - the ctx.connection handle (patched in place).
		* @returns the disposer restoring every patched member (HMR-safe).
		*/
		function installConnectionPatch(connection) {
			const restorers = [];
			if (typeof location !== "undefined" && new URLSearchParams(location.search).has("fixture")) return () => {};
			const originalIsLoopback = connection.isLoopback;
			try {
				Object.defineProperty(connection, "__lanAccessPatched", {
					configurable: true,
					writable: true,
					value: true
				});
			} catch {}
			try {
				Object.defineProperty(connection, "isLoopback", {
					configurable: true,
					get: () => originalIsLoopback || typeof location !== "undefined" && isServedLanHostname(location.hostname)
				});
				restorers.push(() => {
					Object.defineProperty(connection, "isLoopback", {
						configurable: true,
						writable: true,
						value: originalIsLoopback
					});
				});
			} catch {}
			return () => {
				for (const restore of restorers) try {
					restore();
				} catch {}
			};
		}
		//#endregion
		//#region src/client/index.tsx
		installRandomUUIDPolyfill();
		/**
		* Services required before mounting: only the connection, so this plugin's
		* apply runs after the connection row provides its handle but still before
		* the settings surfaces (which wait on `remote` / `settingsScope`). That
		* ordering is what lets the isLoopback widening below land before ui-settings
		* reads `remote.$host.isLoopback` for the settingsScope persistence decision
		* — a non-loopback page would otherwise degrade settings to memory mode, and
		* the Models page / Plugins cards would render nothing.
		*/
		const inject = ["connection"];
		/**
		* Client plugin body.
		* @param ctx - the client cordis context (slots/locale via child fiber).
		*/
		function apply(ctx) {
			installRandomUUIDPolyfill();
			ctx.effect(() => installConnectionPatch(ctx.get("connection")), "dsh-lan-access: connection patch");
			ctx.inject(["slots", "locale"], (uiCtx) => {
				let connection;
				try {
					connection = ctx.get("connection");
				} catch {}
				attachLocale(uiCtx.locale);
				uiCtx.effect(() => {
					const offZh = uiCtx.locale.register(LOCALE_NS, "zh", zh);
					const offEn = uiCtx.locale.register(LOCALE_NS, "en", en);
					return () => {
						offZh();
						offEn();
					};
				}, "dsh-lan-access: dictionaries");
				uiCtx.slots.inject("settings.general.item", () => uiCtx.slots.register({
					name: "settings.general.item",
					id: "lan-access",
					order: 15,
					inject: () => ({})
				}, LanAccessRow));
				const report = () => {
					const count = (key) => uiCtx.slots.entries(key).length;
					fetch("/lan-access/diag", {
						method: "POST",
						headers: { "content-type": "application/json" },
						body: JSON.stringify({
							slots: {
								"settings.section": count("settings.section"),
								"settings.general.item": count("settings.general.item"),
								"settings.plugins.tab": count("settings.plugins.tab"),
								"settings.plugin.item": count("settings.plugin.item")
							},
							isLoopback: connection?.isLoopback === true,
							patched: connection?.__lanAccessPatched === true,
							origin: typeof location !== "undefined" ? location.origin : "no-location",
							ua: typeof navigator !== "undefined" ? navigator.userAgent.slice(0, 100) : "no-navigator"
						})
					}).catch(() => {});
				};
				report();
				setTimeout(report, 1500);
				const settingsScope = ctx.get("settingsScope");
				let probe;
				if (settingsScope !== void 0) {
					probe = settingsScope.bind({ namespace: "shell" });
					setTimeout(() => {
						fetch("/lan-access/diag", {
							method: "POST",
							headers: { "content-type": "application/json" },
							body: JSON.stringify({ scopeProbe: probe?.getSnapshot() })
						}).catch(() => {});
					}, 2500);
				}
				const wideSlots = uiCtx.slots;
				const cardFace = (entry) => {
					try {
						const hooks = (entry.inject?.())?.hooks;
						return (hooks !== void 0 ? Object.values(hooks)[0] : void 0)?.getSnapshot() ?? null;
					} catch (error) {
						return { threw: String(error) };
					}
				};
				const poll = () => {
					const entries = wideSlots.entries("settings.plugin.item");
					const cardEntries = entries.map((entry) => ({
						id: entry.options?.id ?? "?",
						state: cardFace(entry)
					}));
					fetch("/lan-access/diag", {
						method: "POST",
						headers: { "content-type": "application/json" },
						body: JSON.stringify({ poll: {
							entries: entries.map((entry) => entry.options?.id ?? "?"),
							entriesOfSlot: (wideSlots.entriesOfSlot?.("settings.plugin.item") ?? []).map((entry) => entry.options?.id ?? "?"),
							spec: wideSlots.specDynamic?.("settings.plugin.item") ?? null,
							cards: cardEntries,
							isLoopback: connection?.isLoopback === true,
							patched: connection?.__lanAccessPatched === true,
							probe: probe?.getSnapshot?.() ?? null
						} })
					}).catch(() => {});
				};
				const pollStop = setInterval(poll, 2e3);
				poll();
				setTimeout(() => {
					clearInterval(pollStop);
				}, 6e4);
				uiCtx.effect(() => () => {
					clearInterval(pollStop);
				}, "dsh-lan-access: diag poll");
			});
		}
		//#endregion
		exports.apply = apply;
		exports.inject = inject;
		return module.exports;
	}
});

//# sourceMappingURL=client.js.map