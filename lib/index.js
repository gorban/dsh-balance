import { credentialRef } from "@deepseek-ai/dsh-credentials";
import { launchEnvironmentOf } from "@deepseek-ai/dsh-launch-environment";
//#region src/index.ts
/** Cordis plugin name (matches the profile patch row id). */
const name = "dsh-balance";
/** Required services: the web route registry. Credentials are resolved lazily via ctx.get. */
const inject = ["webServer"];
/** The route the browser half polls (an exact route beside the /plugins/events dev channel). */
const BALANCE_ENDPOINT = "/plugins/balance";
/** The supported provider set; a request naming an unknown kind serves DeepSeek. */
const PROVIDER_SPECS = {
	deepseek: {
		apiKeyEnvs: ["DEEPSEEK_API_KEY"],
		urls: ["https://api.deepseek.com/user/balance"],
		fallbackToEnv: false,
		authScheme: "bearer"
	},
	openrouter: {
		apiKeyEnvs: ["OPENROUTER_API_KEY"],
		urls: ["https://openrouter.ai/api/v1/credits"],
		fallbackToEnv: true,
		authScheme: "bearer"
	},
	moonshot: {
		apiKeyEnvs: ["MOONSHOT_API_KEY"],
		urls: ["https://api.moonshot.ai/v1/users/me/balance", "https://api.moonshot.cn/v1/users/me/balance"],
		fallbackToEnv: true,
		authScheme: "bearer"
	},
	zhipu: {
		apiKeyEnvs: [
			"ZAI_API_KEY",
			"GLM_API_KEY",
			"ZHIPU_API_KEY"
		],
		urls: ["https://open.bigmodel.cn/api/biz/account/query-customer-account-report", "https://api.z.ai/api/biz/account/query-customer-account-report"],
		fallbackToEnv: true,
		authScheme: "raw"
	},
	minimax: {
		apiKeyEnvs: [
			"MINIMAX_API_KEY",
			"MINIMAX_CN_API_KEY",
			"MINIMAX_API_TOKEN"
		],
		urls: ["https://www.minimax.io/v1/token_plan/remains", "https://api.minimaxi.com/v1/token_plan/remains"],
		fallbackToEnv: true,
		authScheme: "bearer"
	}
};
/** Upstream call timeout. */
const UPSTREAM_TIMEOUT_MS = 1e4;
/**
* Dev-only canned upstream bodies for each provider kind, used when mock mode is
* enabled (see {@link mockEnabled}). Handy for previewing the chip rendering a
* real balance without holding an account on every provider. Kept in the raw
* upstream shape so the same {@link unwrapBalance} normalization runs.
*/
const MOCK_BODY = {
	deepseek: {
		is_available: true,
		balance_infos: [{
			currency: "CNY",
			total_balance: "88.00",
			granted_balance: "0.00",
			topped_up_balance: "88.00"
		}]
	},
	openrouter: { data: {
		total_credits: 12.5,
		total_usage: 2.5
	} },
	moonshot: { data: {
		available_balance: 49.59,
		voucher_balance: 46.59,
		cash_balance: 3
	} },
	zhipu: { data: {
		balance: 142.5,
		availableBalance: 132.5,
		currency: "CNY"
	} },
	minimax: {
		base_resp: { status_code: 0 },
		model_remains: [{
			current_interval_remaining_count: 88,
			current_interval_total_count: 100,
			current_subscribe_title: "Pro"
		}]
	}
};
/**
* Whether this request runs in dev mock mode. Off by default; enabled by the
* `DSH_BALANCE_MOCK=1` environment variable or a `?mock=1` query param. When on,
* {@link handleBalance} serves {@link MOCK_BODY} for any known kind without
* resolving a credential or calling the provider, so the chip can be previewed
* without an account on that platform.
*/
function mockEnabled(req) {
	if (process.env.DSH_BALANCE_MOCK === "1") return true;
	return new URL(req.url ?? "/", "http://internal").searchParams.get("mock") === "1";
}
function json(res, status, body) {
	res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
	res.end(JSON.stringify(body));
}
/** The known provider kinds, derived from the spec map so a new entry is picked up automatically. */
const KNOWN_KINDS = new Set(Object.keys(PROVIDER_SPECS));
/** Read `kind` from the request query; an absent or unknown value serves DeepSeek. */
function kindOf(req) {
	const kind = new URL(req.url ?? "/", "http://internal").searchParams.get("kind");
	return kind !== null && KNOWN_KINDS.has(kind) ? kind : "deepseek";
}
/**
* Resolve one provider's API key: the credentials seam first, then — for a
* provider configured to authenticate from the ambient environment — the
* launch environment (process, then the invoking project's .env, then the
* Harness home's .env). Each candidate credential reference is tried in order.
* Failures surface as an `undefined` return, which the caller reports as the
* `no-key` chip state.
* @param ctx - host plugin context carrying `credentials`/`launchEnvironment`.
* @param spec - the provider descriptor.
* @returns the key, or `undefined` when no layer supplies one.
*/
async function resolveApiKey(ctx, spec) {
	const credentials = ctx.get("credentials");
	if (credentials !== void 0) for (const env of spec.apiKeyEnvs) {
		const value = (await credentials.resolve(credentialRef(env)))?.value;
		if (value !== void 0 && value !== "") return value;
	}
	if (spec.fallbackToEnv) for (const env of spec.apiKeyEnvs) {
		const value = launchEnvironmentOf(ctx).get(env)?.value;
		if (value !== void 0 && value !== "") return value;
	}
}
/**
* Handle one balance request: resolve the key for the requested provider, call
* the provider, relay the normalized result. Failures are reported to the
* chip, never thrown into the server (the chip shows a retry affordance).
*/
async function handleBalance(ctx, req, res) {
	if (req.method !== "GET" && req.method !== "HEAD") {
		res.writeHead(405);
		res.end();
		return;
	}
	const kind = kindOf(req);
	const spec = PROVIDER_SPECS[kind];
	if (mockEnabled(req)) {
		json(res, 200, {
			ok: true,
			provider: kind,
			balance: unwrapBalance(kind, MOCK_BODY[kind])
		});
		return;
	}
	const apiKey = await resolveApiKey(ctx, spec);
	if (apiKey === void 0) {
		json(res, 200, {
			ok: false,
			provider: kind,
			error: "no-key",
			message: `Set ${spec.apiKeyEnvs.join(" or ")} in ~/.dsh/.credentials.yaml (or the environment)`
		});
		return;
	}
	const authorization = spec.authScheme === "raw" ? apiKey : `Bearer ${apiKey}`;
	let lastError;
	for (const url of spec.urls) try {
		const upstream = await fetch(url, {
			headers: { authorization },
			signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS)
		});
		if (!upstream.ok) {
			if ((upstream.status === 401 || upstream.status === 403) && spec.urls.length > 1) {
				lastError = `${kind} answered ${upstream.status}`;
				continue;
			}
			json(res, 200, {
				ok: false,
				provider: kind,
				error: "upstream",
				message: `${kind} answered ${upstream.status}`
			});
			return;
		}
		const body = await upstream.json();
		if (spec.urls.length > 1 && isRecord(body) && body.success === false) {
			const code = typeof body.code === "number" ? body.code : void 0;
			if (code === 401 || code === 1001) {
				lastError = `${kind} rejected the key`;
				continue;
			}
		}
		json(res, 200, {
			ok: true,
			provider: kind,
			balance: unwrapBalance(kind, body)
		});
		return;
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		if (spec.urls.length === 1) {
			json(res, 200, {
				ok: false,
				provider: kind,
				error: "upstream",
				message
			});
			return;
		}
		lastError = message;
	}
	json(res, 200, {
		ok: false,
		provider: kind,
		error: "upstream",
		message: lastError ?? "unreachable"
	});
}
/**
* Normalize one upstream body to the "balance facts" object the client
* renderers read. DeepSeek and MiniMax return their facts at the top level;
* OpenRouter, Moonshot, and Zhipu wrap them in a `data` key.
*/
function unwrapBalance(kind, body) {
	return (kind === "openrouter" || kind === "moonshot" || kind === "zhipu") && isRecord(body) && isRecord(body.data) ? body.data : body;
}
/** Narrow a runtime value to a non-null object record. */
function isRecord(value) {
	return typeof value === "object" && value !== null;
}
/**
* Mount the balance route.
* @param ctx - host plugin context carrying `webServer`.
*/
function apply(ctx) {
	ctx.effect(() => ctx.webServer.register({
		kind: "exact",
		path: BALANCE_ENDPOINT,
		handler: (req, res) => {
			handleBalance(ctx, req, res);
		}
	}), "dsh-balance: balance route");
}
//#endregion
export { BALANCE_ENDPOINT, apply, inject, name };
