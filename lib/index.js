import { execFile } from "node:child_process";
import { networkInterfaces } from "node:os";
import { SettingsConflictError } from "@deepseek-ai/dsh-settings";
import { credentialRef } from "@deepseek-ai/dsh-credentials";
import z from "@deepseek-ai/schemastery";
//#region src/index.ts
/**
* dsh-lan-access host half: owns the web GUI's bind host.
*
* The webserver row binds loopback by default. This plugin owns a persisted
* `lan-access` settings namespace (`enabled: true` = bind all interfaces)
* and converges the running webserver to it:
*
* - at boot, after both the settings seam and the webserver exist, the
*   persisted value is applied once (a mismatch restarts the webserver row);
* - every settings commit re-applies it, so the General-settings toggle takes
*   effect immediately;
* - a fenced /lan-access JSON route (GET state, POST set) lets the browser
*   settings row read and flip the switch. The fence accepts loopback or the
*   deployment's trusted authorities, read live from the connection row so
*   LAN clients are admitted exactly when the /api gateway admits them.
*
* Rebinding restarts the webserver fiber, which cascades to every dependent
* row (web-runtime, connection, api gateway…): web-runtime re-samples the
* LAN trust snapshot and the connection row re-reads it, so the /api fence
* admits the LAN authorities after an enable and drops them after a disable.
*
* The webserver is read lazily (`ctx.get`) and never injected, so this
* plugin's own fiber survives the webserver restart it triggers.
*/
/** Settings namespace owned by this plugin. */
const LAN_ACCESS_NAMESPACE = "lan-access";
/** Durable section schema (defaults to loopback — the safe state). */
const LanAccessSchema = z.object({ enabled: z.boolean().default(false) });
/** Stable Cordis plugin name (the loader row mounts this package). */
const name = "dsh-lan-access";
/** Services required before mounting: the loader tree (for the webserver row and the connection row's trusted hosts). */
const inject = ["loader"];
/** The webserver row's plugin name (matched by name — its entry id is group-prefixed). */
const WEBSERVER_PLUGIN = "@deepseek-ai/dsh-host-webserver";
/** The connection row whose resolved `trustedHosts` the /api fence uses. */
const CONNECTION_ROW = "@deepseek-ai/dsh-client-connection";
/** Request-body size bound of the POST write (defense against unbounded reads). */
const MAX_BODY_BYTES = 64 * 1024;
/** An HTTP failure with a wire code and status. */
var LanAccessHttpError = class extends Error {
	code;
	status;
	constructor(code, message, status = 400) {
		super(message);
		this.code = code;
		this.status = status;
	}
};
/** Interface names that never carry the machine's routable LAN address. */
const VIRTUAL_INTERFACE = /^(docker|veth|br-|vmnet|utun|tun|tap|tailscale|wg|vbox|virbr|lo|bridge|ppp)/i;
/** Interface names that typically carry the primary LAN address (physical NICs). */
const PHYSICAL_INTERFACE = /^(en|eth|wlan|ens|enp|wl|awdl)/i;
/**
* The machine's LAN IPv4 literals, primary first. Nothing is hard-coded: every
* address is read live from the OS network interfaces of the machine running
* the DSH server, virtual interfaces (docker/vpn/bridge/loopback) are
* filtered out, and physical NICs (en0, eth0, wlan0, …) rank ahead of the
* rest so the first entry is the address another machine on the LAN should
* open.
* The /api trust fence admits every returned literal, so any of them works.
*/
function lanAddresses() {
	const candidates = [];
	for (const [name, ifaces] of Object.entries(networkInterfaces())) for (const iface of ifaces ?? []) {
		if (iface === void 0 || iface.family !== "IPv4" || iface.internal) continue;
		if (VIRTUAL_INTERFACE.test(name)) continue;
		candidates.push({
			address: iface.address,
			name,
			physical: PHYSICAL_INTERFACE.test(name)
		});
	}
	const byAddress = /* @__PURE__ */ new Map();
	for (const candidate of candidates) {
		const existing = byAddress.get(candidate.address);
		if (existing === void 0 || candidate.physical && !existing.physical) byAddress.set(candidate.address, candidate);
	}
	return [...byAddress.values()].sort((left, right) => Number(right.physical) - Number(left.physical)).map((candidate) => candidate.address);
}
/** Cached primary address (the default-route interface IPv4). */
let primaryCache;
/** How long a resolved primary address stays fresh (routing rarely changes). */
const PRIMARY_TTL_MS = 3e4;
/** The interface owning the default route, from the OS routing table. */
function defaultRouteInterfaceName() {
	return new Promise((resolve) => {
		const [file, args] = process.platform === "linux" ? ["ip", [
			"route",
			"show",
			"default"
		]] : ["route", [
			"-n",
			"get",
			"default"
		]];
		execFile(file, args, {
			timeout: 1500,
			windowsHide: true
		}, (error, stdout) => {
			if (error !== null) {
				resolve(void 0);
				return;
			}
			const text = String(stdout);
			const mac = /interface:\s*(\S+)/.exec(text);
			const linux = /\bdev\s+(\S+)/.exec(text);
			resolve(mac?.[1] ?? linux?.[1]);
		});
	});
}
/**
* The ONE address another machine should open: the IPv4 of the interface that
* owns the default route (the NIC the LAN actually reaches the machine
* through), falling back to the first physical-NIC candidate. The row shows
* only this address; the /api fence still admits every LAN literal.
*/
async function primaryLanAddress() {
	const now = Date.now();
	if (primaryCache !== void 0 && now - primaryCache.at < PRIMARY_TTL_MS) return primaryCache.address;
	const ifaceName = await defaultRouteInterfaceName();
	let address;
	if (ifaceName !== void 0) address = (networkInterfaces()[ifaceName]?.find((candidate) => candidate !== void 0 && candidate.family === "IPv4" && !candidate.internal))?.address;
	address ??= lanAddresses()[0];
	primaryCache = {
		address,
		at: now
	};
	return address;
}
function header(headers, name) {
	const value = headers[name];
	return typeof value === "string" ? value : void 0;
}
/** Normalized URL of a Host-header authority, or undefined when unparsable. */
function parseAuthority(authority) {
	try {
		return new URL(`http://${authority}`);
	} catch {
		return;
	}
}
/** Whether a normalized URL hostname names the local loopback authority. */
function isLoopbackHostname(hostname) {
	if (hostname === "localhost" || hostname === "[::1]") return true;
	const parts = hostname.split(".");
	return parts.length === 4 && parts[0] === "127" && parts.every((part) => /^\d{1,3}$/.test(part) && Number(part) <= 255);
}
/** Canonical authority form: hostname, or hostname:port when a port was written. */
function canonicalAuthority(entry, entryUrl) {
	const port = entryUrl.port !== "" ? entryUrl.port : new URL(`https://${entry}`).port;
	return port === "" ? entryUrl.hostname : `${entryUrl.hostname}:${port}`;
}
/** Whether the request authority matches a trustedHosts entry (exact or port-less). */
function isTrustedAuthority(hostUrl, trustedHosts) {
	return trustedHosts.some((entry) => {
		const entryUrl = parseAuthority(entry);
		if (entryUrl === void 0) return false;
		return canonicalAuthority(entry, entryUrl) === entryUrl.hostname ? entryUrl.hostname === hostUrl.hostname : entryUrl.host === hostUrl.host;
	});
}
/** Decide whether one request may reach the plugin route. */
function isTrustedApiRequest(req, trustedHosts) {
	const host = header(req.headers, "host");
	if (host === void 0) return false;
	const hostUrl = parseAuthority(host);
	if (hostUrl === void 0) return false;
	if (!isLoopbackHostname(hostUrl.hostname) && !isTrustedAuthority(hostUrl, trustedHosts)) return false;
	if (header(req.headers, "sec-fetch-site") === "cross-site") return false;
	const origin = header(req.headers, "origin");
	if (origin === void 0) return true;
	try {
		return new URL(origin).host === hostUrl.host;
	} catch {
		return false;
	}
}
/** Read the connection row's resolved trusted authorities, live. */
function trustedHostsOf(loader) {
	for (const entry of loader.entries()) {
		if (entry.options.name !== CONNECTION_ROW) continue;
		const raw = (entry.fiber?.config)?.trustedHosts;
		if (Array.isArray(raw)) return raw.filter((x) => typeof x === "string");
		return [];
	}
	return [];
}
/** Read a bounded JSON request body. */
async function readJsonBody(req) {
	const chunks = [];
	let total = 0;
	for await (const chunk of req) {
		const buffer = typeof chunk === "string" ? Buffer.from(chunk) : chunk;
		total += buffer.length;
		if (total > MAX_BODY_BYTES) throw new LanAccessHttpError("payload-too-large", "request body too large", 413);
		chunks.push(buffer);
	}
	if (total === 0) return null;
	try {
		return JSON.parse(Buffer.concat(chunks).toString("utf8"));
	} catch {
		throw new LanAccessHttpError("bad-request", "request body is not valid JSON", 400);
	}
}
/** Write one JSON response (the socket may die mid-rebind; never throw). */
function writeJson(res, status, body) {
	try {
		res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
		res.end(JSON.stringify(body));
	} catch {}
}
/** Web-surface settings namespaces the /api proxy exposes (its allowlist mirror). */
const WEB_SETTINGS_NAMESPACES = [
	"agent-loop",
	"shell",
	"locale",
	"permission",
	"ui-conversation",
	"ui-theme",
	"web-search-deepseek"
];
/** Product-owned settings namespaces (the api-proxy's product allowlist mirror). */
const PRODUCT_SETTINGS_NAMESPACES = ["ui-onboarding", "agent-presets"];
/** Open one path with the OS default application (Finder/Explorer/xdg-open). */
function openWithSystem(path) {
	if (process.platform === "darwin") execFile("open", [path], { timeout: 5e3 }, () => {});
	else if (process.platform === "linux") execFile("xdg-open", [path], { timeout: 5e3 }, () => {});
	else execFile("cmd", [
		"/c",
		"start",
		"",
		path
	], { timeout: 5e3 }, () => {});
}
function rpcOk(rpcId, value) {
	return {
		rpcId,
		result: {
			ok: true,
			value
		}
	};
}
function rpcErr(rpcId, code, message, details = {}) {
	return {
		rpcId,
		result: {
			ok: false,
			error: {
				code,
				message,
				details
			}
		}
	};
}
/** The settings namespaces this proxy serves — the api-proxy exposure mirror. */
function exposedSettingsNamespaces(ctx) {
	const exposed = new Set(WEB_SETTINGS_NAMESPACES);
	for (const ns of PRODUCT_SETTINGS_NAMESPACES) exposed.add(ns);
	const llm = ctx.get("llm");
	for (const entry of llm?.listConfigurableProviders() ?? []) exposed.add(entry.settingsNs);
	return exposed;
}
/** Map one redacted settings descriptor to its wire view (api-proxy namespaceView mirror). */
function namespaceViewOf(descriptor) {
	return {
		ns: String(descriptor.ns),
		schema: descriptor.schema,
		value: descriptor.value,
		...descriptor.base === void 0 ? {} : { base: descriptor.base },
		...descriptor.user === void 0 ? {} : { user: descriptor.user },
		applies: descriptor.applies,
		secrets: (descriptor.secrets ?? []).map((secret) => ({
			path: [...secret.path],
			set: secret.set
		})),
		revision: descriptor.revision
	};
}
/** settings.update/replace/mutate with the api-proxy exposure + error mapping. */
async function settingsWriteRpc(ctx, rpcId, ns, mode, section, expectedRevision) {
	const settings = ctx.get("settings");
	if (settings === void 0) return rpcErr(rpcId, "internal", "settings service is absent");
	if (!exposedSettingsNamespaces(ctx).has(ns)) return rpcErr(rpcId, "settings-not-exposed", `settings namespace "${ns}" is not exposed to configuration clients`);
	try {
		if (mode === "update") await settings.update(ns, section, expectedRevision);
		else if (mode === "replace") await settings.replace(ns, section, expectedRevision);
		else await settings.mutate(ns, section, expectedRevision);
	} catch (error) {
		if (error instanceof SettingsConflictError) return rpcErr(rpcId, "settings-conflict", error.message, {
			ns,
			expected: error.expected,
			actual: error.actual
		});
		return rpcErr(rpcId, "settings-rejected", error instanceof Error ? error.message : String(error));
	}
	const descriptor = settings.describe({ redactSecrets: true }).find((candidate) => String(candidate.ns) === ns);
	if (descriptor === void 0) return rpcErr(rpcId, "internal", `settings namespace "${ns}" was disposed after the ${mode}`);
	return rpcOk(rpcId, namespaceViewOf(descriptor));
}
/** Dispatch one proxied settings/credentials method (mirror of the /api domains). */
async function dispatchLanAccessRpc(ctx, method, payload) {
	const record = payload ?? {};
	const rpcId = typeof record.rpcId === "string" ? record.rpcId : "lan-access";
	switch (method) {
		case "settings.describe": {
			const settings = ctx.get("settings");
			if (settings === void 0) return rpcErr(rpcId, "internal", "settings service is absent");
			const exposed = exposedSettingsNamespaces(ctx);
			return rpcOk(rpcId, {
				writable: settings.writable,
				hasDocument: settings.documentPath !== void 0,
				namespaces: settings.describe({ redactSecrets: true }).filter((descriptor) => exposed.has(String(descriptor.ns))).map(namespaceViewOf)
			});
		}
		case "settings.update":
		case "settings.replace":
		case "settings.mutate": {
			const ns = record.ns;
			if (typeof ns !== "string") return rpcErr(rpcId, "bad-request", "expected a string \"ns\"");
			const expectedRevision = typeof record.expectedRevision === "number" ? record.expectedRevision : void 0;
			const section = method === "settings.update" ? record.patch : method === "settings.replace" ? record.section : record.ops;
			return settingsWriteRpc(ctx, rpcId, ns, method.slice(9), section, expectedRevision);
		}
		case "settings.openDocument": {
			const settings = ctx.get("settings");
			if (settings === void 0) return rpcErr(rpcId, "internal", "settings service is absent");
			let path;
			try {
				path = await settings.prepareDocument();
			} catch (error) {
				return rpcErr(rpcId, "internal", `settings document preparation failed: ${error instanceof Error ? error.message : String(error)}`);
			}
			if (path === void 0) return rpcErr(rpcId, "internal", "settings provider has no local document to open");
			openWithSystem(path);
			return rpcOk(rpcId, { opened: true });
		}
		case "credentials.describe": {
			const credentials = ctx.get("credentials");
			if (credentials === void 0) return rpcErr(rpcId, "internal", "credentials service is absent");
			const refs = record.refs;
			if (!Array.isArray(refs) || refs.some((ref) => typeof ref !== "string")) return rpcErr(rpcId, "bad-request", "expected an array of string refs");
			const entries = {};
			for (const ref of refs) try {
				const info = await credentials.describe(credentialRef(ref));
				entries[ref] = {
					configured: info.configured,
					...info.source === void 0 ? {} : { source: info.source },
					writable: info.writable
				};
			} catch (error) {
				return rpcErr(rpcId, "credential-rejected", error instanceof Error ? error.message : String(error), { ref });
			}
			return rpcOk(rpcId, { credentials: entries });
		}
		case "credentials.set":
		case "credentials.unset": {
			const credentials = ctx.get("credentials");
			if (credentials === void 0) return rpcErr(rpcId, "internal", "credentials service is absent");
			const ref = record.ref;
			if (typeof ref !== "string") return rpcErr(rpcId, "bad-request", "expected a string \"ref\"");
			try {
				if (method === "credentials.set") {
					const value = record.value;
					if (typeof value !== "string") return rpcErr(rpcId, "bad-request", "expected a string \"value\"");
					await credentials.set(credentialRef(ref), value);
				} else await credentials.unset(credentialRef(ref));
			} catch (error) {
				return rpcErr(rpcId, "credential-rejected", error instanceof Error ? error.message : String(error), { ref });
			}
			return rpcOk(rpcId, {});
		}
		default: return rpcErr(rpcId, "not-found", `unknown lan-access rpc method "${method}"`);
	}
}
/** The /lan-access/rpc route handler: fenced, POST-only, envelope-mirroring. */
async function handleRpc(ctx, loader, req, res, log) {
	if (!isTrustedApiRequest(req, trustedHostsOf(loader))) {
		writeJson(res, 403, {
			ok: false,
			error: {
				code: "forbidden",
				message: "request origin is not trusted"
			}
		});
		return;
	}
	if (req.method !== "POST") {
		writeJson(res, 405, {
			ok: false,
			error: {
				code: "method-error",
				message: "method not allowed"
			}
		});
		return;
	}
	const record = await readJsonBody(req) ?? {};
	if (typeof record.method !== "string" || typeof record.payload !== "object" || record.payload === null) {
		writeJson(res, 400, {
			ok: false,
			error: {
				code: "bad-request",
				message: "expected {\"method\", \"payload\"}"
			}
		});
		return;
	}
	const rpcId = typeof record.rpcId === "string" ? record.rpcId : "lan-access";
	const response = await dispatchLanAccessRpc(ctx, record.method, {
		rpcId,
		...record.payload
	});
	if (log !== void 0) {
		const ns = record.payload?.ns;
		const namespaces = response.result.ok ? response.result.value?.namespaces?.map((view) => String(view.ns)) : void 0;
		log(record.method, response.result.ok, response.result.ok ? void 0 : response.result.error.code, typeof ns === "string" ? ns : void 0, namespaces);
	}
	writeJson(res, 200, response);
}
/**
* Mount the LAN-access controller.
* @param ctx - host context (loader injected).
*/
function apply(ctx) {
	const loader = ctx.loader;
	ctx.provide("lanAccess", { get host() {
		return scope?.get().enabled === true ? "0.0.0.0" : "127.0.0.1";
	} });
	let scope;
	const diagReports = [];
	const rpcTraffic = [];
	const logRpc = (method, ok, code, ns, namespaces) => {
		rpcTraffic.push({
			at: Date.now(),
			method,
			ok,
			code,
			ns,
			namespaces
		});
		if (rpcTraffic.length > 60) rpcTraffic.shift();
	};
	let applying = Promise.resolve();
	let pendingCount = 0;
	const serverOf = () => ctx.get("webServer");
	const warn = (phase, error) => {
		ctx.logger.warn("[dsh-lan-access] %s: %s", phase, error instanceof Error ? error.message : String(error));
	};
	/** Find the webserver loader entry by plugin name (its id is group-prefixed). */
	const webserverEntry = () => {
		for (const entry of loader.entries()) if (entry.options.name === WEBSERVER_PLUGIN) return entry;
	};
	/** Queue one bind convergence; no-ops when the webserver already binds the desired host. */
	const enqueueApply = (enabled) => {
		pendingCount += 1;
		const task = applying.then(async () => {
			const server = serverOf();
			if (server === void 0) return;
			const desiredHost = enabled ? "0.0.0.0" : "127.0.0.1";
			if (server.host === desiredHost) return;
			const entry = webserverEntry();
			if (entry === void 0) throw new Error("webserver loader entry not found");
			await loader.update(entry.id, { config: {
				host: desiredHost,
				port: server.port
			} });
		});
		applying = task.catch(() => {});
		task.finally(() => {
			pendingCount -= 1;
		}).catch(() => {});
		return task;
	};
	/** Converge the webserver bind to the persisted setting once both sides exist. */
	const align = () => {
		if (scope === void 0 || serverOf() === void 0) return;
		enqueueApply(scope.get().enabled).catch((error) => warn("align", error));
	};
	const stateOf = async () => {
		const server = serverOf();
		const enabled = scope?.get().enabled ?? false;
		const addresses = enabled ? lanAddresses() : [];
		const primary = enabled ? await primaryLanAddress() : void 0;
		return {
			ready: scope !== void 0 && server !== void 0,
			enabled,
			host: server?.host ?? null,
			port: server?.port ?? null,
			pending: pendingCount > 0,
			addresses,
			url: primary !== void 0 && server !== void 0 ? `http://${primary}:${server.port}` : null
		};
	};
	ctx.inject(["settings"], (sctx) => {
		scope = sctx.settings.register(LAN_ACCESS_NAMESPACE, LanAccessSchema);
		scope.watch((next) => {
			enqueueApply(next.enabled).catch((error) => warn("settings change", error));
		});
		align();
	});
	ctx.inject(["webServer"], (httpCtx) => {
		httpCtx.effect(() => httpCtx.webServer.register({
			kind: "exact",
			path: "/lan-access",
			handler: (req, res) => {
				handle(req, res).catch((error) => {
					if (error instanceof LanAccessHttpError) {
						writeJson(res, error.status, {
							ok: false,
							error: {
								code: error.code,
								message: error.message
							}
						});
						return;
					}
					writeJson(res, 500, {
						ok: false,
						error: {
							code: "internal",
							message: error instanceof Error ? error.message : String(error)
						}
					});
				});
			}
		}), "dsh-lan-access: /lan-access route");
		httpCtx.effect(() => httpCtx.webServer.register({
			kind: "exact",
			path: "/lan-access/rpc",
			handler: (req, res) => {
				handleRpc(ctx, loader, req, res, (method, ok, code, ns, namespaces) => logRpc(method, ok, code, ns, namespaces)).catch((error) => {
					writeJson(res, 500, {
						ok: false,
						error: {
							code: "internal",
							message: error instanceof Error ? error.message : String(error)
						}
					});
				});
			}
		}), "dsh-lan-access: /lan-access/rpc route");
		httpCtx.effect(() => httpCtx.webServer.register({
			kind: "exact",
			path: "/lan-access/diag",
			handler: (req, res) => {
				(async () => {
					if (!isTrustedApiRequest(req, trustedHostsOf(loader))) {
						writeJson(res, 403, {
							ok: false,
							error: {
								code: "forbidden",
								message: "request origin is not trusted"
							}
						});
						return;
					}
					if (req.method === "POST") {
						const body = await readJsonBody(req);
						diagReports.push({
							at: Date.now(),
							data: body
						});
						if (diagReports.length > 20) diagReports.shift();
						writeJson(res, 200, { ok: true });
						return;
					}
					writeJson(res, 200, {
						ok: true,
						value: {
							reports: diagReports,
							traffic: rpcTraffic
						}
					});
				})().catch((error) => {
					writeJson(res, 500, {
						ok: false,
						error: {
							code: "internal",
							message: error instanceof Error ? error.message : String(error)
						}
					});
				});
			}
		}), "dsh-lan-access: /lan-access/diag route");
		align();
	});
	/** One /lan-access request: GET reads state, POST persists and applies. */
	async function handle(req, res) {
		if (new URL(req.url ?? "/", "http://dsh.internal").pathname !== "/lan-access") {
			writeJson(res, 404, {
				ok: false,
				error: {
					code: "not-found",
					message: "not found"
				}
			});
			return;
		}
		if (!isTrustedApiRequest(req, trustedHostsOf(loader))) {
			writeJson(res, 403, {
				ok: false,
				error: {
					code: "forbidden",
					message: "request origin is not trusted"
				}
			});
			return;
		}
		if (req.method === "GET") {
			writeJson(res, 200, {
				ok: true,
				value: await stateOf()
			});
			return;
		}
		if (req.method === "POST") {
			const payload = await readJsonBody(req);
			if (payload === null || typeof payload !== "object" || typeof payload.enabled !== "boolean") throw new LanAccessHttpError("bad-request", "expected {\"enabled\": boolean}");
			const enabled = payload.enabled;
			const settings = ctx.get("settings");
			if (settings === void 0 || scope === void 0) throw new LanAccessHttpError("not-ready", "LAN access settings are not ready yet", 503);
			await settings.update(LAN_ACCESS_NAMESPACE, { enabled });
			await enqueueApply(enabled);
			writeJson(res, 200, {
				ok: true,
				value: await stateOf()
			});
			return;
		}
		writeJson(res, 405, {
			ok: false,
			error: {
				code: "method-error",
				message: "method not allowed"
			}
		});
	}
}
//#endregion
export { LAN_ACCESS_NAMESPACE, LanAccessSchema, apply, inject, name };
