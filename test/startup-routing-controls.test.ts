import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { extensionConfigDir, extensionConfigPath } from "@henryqw/pi-config-store";
import { ModelRuntime, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { builtinProviders } from "@earendil-works/pi-ai/providers/all";
import multiCodex, {
	ACCOUNT_VAULT_MARKER,
	parseCodexUsage,
	wrapCodexOAuth,
} from "../extensions/multi-codex.ts";

type Handler = (event: any, ctx: any) => unknown;
type Command = (args: string, ctx: any) => Promise<void>;
type App = {
	agentDir: string;
	handlers: Map<string, Handler>;
	commands: Map<string, Command>;
	ctx: any;
	providers: any[];
	setModels: ReturnType<typeof model>[];
	statuses: (string | undefined)[];
	notices: string[];
	sessionEntries: any[];
	selectModel: (next: ReturnType<typeof model>) => Promise<void>;
};

const model = (provider = "openai-codex") => ({
	id: "gpt-5.3-codex",
	name: "Codex",
	api: "openai-codex-responses",
	provider,
	reasoning: true,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 128_000,
	maxTokens: 16_384,
});

const credential = (accountId: string) => ({
	type: "oauth" as const,
	access: `access-${accountId}`,
	refresh: `refresh-${accountId}`,
	expires: Date.now() + 60_000,
	accountId,
});

const assistantError = (provider = "openai-codex") => ({
	role: "assistant",
	content: [],
	api: "openai-codex-responses",
	provider,
	model: "gpt-5.3-codex",
	usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
	stopReason: "error",
	errorMessage: "You have hit your ChatGPT usage limit.",
	timestamp: Date.now(),
});

const hash = (accountId: string) => createHash("sha256").update(accountId).digest("hex");
const usagePath = (agentDir: string) => join(extensionConfigDir("pi-multi-codex", agentDir), "usage.json");
const vaultPath = (agentDir: string) => join(extensionConfigDir("pi-multi-codex", agentDir), "accounts.json");
const readVault = async (agentDir: string) => JSON.parse(await readFile(vaultPath(agentDir), "utf8"));
const activeIndex = (vault: { activeAccountId?: string; accounts: { id: string; index: number }[] }) =>
	vault.accounts.find((account) => account.id === vault.activeAccountId)?.index;

async function writeFreshCache(agentDir: string, remaining: Record<number, number>): Promise<void> {
	const now = Date.now();
	const directory = extensionConfigDir("pi-multi-codex", agentDir);
	await mkdir(directory, { recursive: true });
	await writeFile(join(directory, "usage.json"), JSON.stringify({
		slots: Object.entries(remaining).map(([slot, value]) => ({
			slot: Number(slot),
			accountHash: hash(`account-${slot}`),
			checkedAt: now,
			fetchedAt: now,
			remaining: value,
			reset: Date.now() + 3_600_000,
			limitedUntil: null,
		})),
		locks: [],
	}));
}

test("parses a reached five-hour limit without changing seven-day quota", () => {
	const now = Date.parse("2026-03-13T12:00:00Z");
	assert.deepEqual(parseCodexUsage({
		plan_type: "plus",
		rate_limit: {
			primary_window: { used_percent: 100, limit_window_seconds: 5 * 60 * 60, reset_after_seconds: 600 },
			secondary_window: { used_percent: 20, limit_window_seconds: 7 * 24 * 60 * 60, reset_after_seconds: 3600 },
		},
	}, now), {
		remaining: 80,
		reset: now + 3_600_000,
		fiveHourReset: now + 600_000,
		limitedUntil: now + 600_000,
		tier: "plus",
	});
});

async function withApp(
	remaining: Record<number, number>,
	scopedModels: readonly { model: ReturnType<typeof model> }[] = [],
	check: (app: App) => Promise<void>,
	setModel = async (next: ReturnType<typeof model>, apply: () => void) => {
		apply();
		return true;
	},
): Promise<void> {
	const agentDir = await mkdtemp(join(tmpdir(), "pi-multi-codex-routing-"));
	const prior = process.env.PI_CODING_AGENT_DIR;
	const priorFetch = globalThis.fetch;
	process.env.PI_CODING_AGENT_DIR = agentDir;
	globalThis.fetch = async () => { throw new Error("fresh cache must not fetch"); };
	try {
		await writeFile(join(agentDir, "auth.json"), JSON.stringify(Object.fromEntries(
			Object.keys(remaining).map((slot) => [Number(slot) === 1 ? "openai-codex" : `openai-codex-${slot}`, credential(`account-${slot}`)]),
		)));
		await writeFreshCache(agentDir, remaining);

		let activeModel = model();
		const handlers = new Map<string, Handler>();
		const commands = new Map<string, Command>();
		const providers: any[] = [];
		const setModels: ReturnType<typeof model>[] = [];
		const statuses: (string | undefined)[] = [];
		const notices: string[] = [];
		const sessionEntries: any[] = [];
		const ctx = {
			get model() { return activeModel; },
			modelRegistry: {
				getProviderAuth: async (provider: string) => ({ auth: { apiKey: `token-${provider}` } }),
				getApiKeyForProvider: async (provider: string) => {
					const oauth = providers[0]?.auth?.oauth;
					if (provider !== "openai-codex" || !oauth) return undefined;
					return (await oauth.toAuth({
						type: "oauth",
						access: "carrier-token",
						refresh: "carrier-token",
						expires: 1,
					})).apiKey;
				},
			},
			scopedModels,
			sessionManager: { getBranch() { return sessionEntries; } },
			ui: {
				notify(message: string) { notices.push(message); },
				setStatus(_key: string, text: string | undefined) { statuses.push(text); },
				theme: { fg(color: string, text: string) { return `<${color}>${text}</${color}>`; } },
				async select(_title: string, choices: string[]) { return choices[1]; },
			},
		};
		await multiCodex({
			on(event: string, handler: Handler) { handlers.set(event, handler); },
			registerCommand(name: string, command: { handler: Command }) { commands.set(name, command.handler); },
			registerProvider(provider: { id: string }) { providers.push(provider); },
			appendEntry(customType: string) { sessionEntries.push({ type: "custom", customType }); },
			async setModel(next: ReturnType<typeof model>) {
				const previousModel = activeModel;
				setModels.push(next);
				const selected = await setModel(next, () => { activeModel = next; });
				if (selected) await handlers.get("model_select")?.({ type: "model_select", model: next, previousModel, source: "set" }, ctx);
				return selected;
			},
		} as unknown as ExtensionAPI);
		await check({
			agentDir,
			handlers,
			commands,
			ctx,
			providers,
			setModels,
			statuses,
			notices,
			sessionEntries,
			async selectModel(next) {
				const previousModel = activeModel;
				activeModel = next;
				await handlers.get("model_select")?.({ type: "model_select", model: next, previousModel, source: "set" }, ctx);
			},
		});
		await handlers.get("session_shutdown")?.({ type: "session_shutdown" }, ctx);
	} finally {
		globalThis.fetch = priorFetch;
		if (prior === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = prior;
		await rm(agentDir, { recursive: true, force: true });
	}
}

test("registers exactly one openai-codex provider with the host catalog and APIs", async () => {
	await withApp({ 1: 40, 2: 70 }, [], async ({ handlers, ctx, providers }) => {
		await handlers.get("session_start")?.({ type: "session_start" }, ctx);
		assert.equal(providers.length, 1);
		const expected = builtinProviders().find((provider) => provider.id === "openai-codex");
		assert.ok(expected);
		assert.equal(providers[0].id, expected.id);
		assert.equal(providers[0].baseUrl, expected.baseUrl);
		assert.equal(providers[0].auth.oauth.name, expected.auth.oauth?.name);
		assert.deepEqual(providers[0].getModels(), expected.getModels());
		assert.equal(typeof providers[0].stream, "function");
		assert.equal(typeof providers[0].streamSimple, "function");
		assert.equal(typeof providers[0].auth?.oauth?.toAuth, "function");
	});
});

test("replaces the builtin provider in ModelRuntime and follows vault switches", async () => {
	const agentDir = await mkdtemp(join(tmpdir(), "pi-multi-codex-runtime-"));
	const prior = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = agentDir;
	try {
		await writeFile(join(agentDir, "auth.json"), JSON.stringify({
			"openai-codex": credential("account-1"),
			"openai-codex-2": credential("account-2"),
		}));
		const runtime = await ModelRuntime.create({
			authPath: join(agentDir, "auth.json"),
			modelsPath: null,
			refreshOnCreate: false,
		});
		const provider = builtinProviders().find((candidate) => candidate.id === "openai-codex");
		assert.ok(provider?.auth.oauth);
		runtime.registerNativeProvider({
			...provider,
			auth: { ...provider.auth, oauth: wrapCodexOAuth(provider.auth.oauth) },
		});

		assert.equal((await runtime.getAuth("openai-codex"))?.auth.apiKey, "access-account-1");
		const vault = await readVault(agentDir);
		vault.activeAccountId = vault.accounts.find((account: { index: number }) => account.index === 2).id;
		await writeFile(vaultPath(agentDir), `${JSON.stringify(vault)}\n`);
		assert.equal((await runtime.getAuth("openai-codex"))?.auth.apiKey, "access-account-2");
		assert.ok(runtime.getModels("openai-codex").length > 0);
	} finally {
		if (prior === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = prior;
		await rm(agentDir, { recursive: true, force: true });
	}
});

test("migrates legacy auth entries idempotently without copying secrets into usage", async () => {
	await withApp({ 1: 40, 2: 70 }, [], async ({ agentDir, handlers, ctx }) => {
		await handlers.get("session_start")?.({ type: "session_start" }, ctx);
		const first = await readVault(agentDir);
		assert.equal(first.accounts.length, 2);
		assert.equal(activeIndex(first), 1);
		assert.equal(first.accounts[0].credential.access, "access-account-1");
		assert.equal(first.accounts[1].index, 2);
		const auth = JSON.parse(await readFile(join(agentDir, "auth.json"), "utf8"));
		assert.ok(auth["openai-codex-2"]);
		const usage = await readFile(usagePath(agentDir), "utf8");
		assert.doesNotMatch(usage, /access-account|refresh-account/);

		await handlers.get("session_start")?.({ type: "session_start" }, ctx);
		const second = await readVault(agentDir);
		assert.deepEqual(second.accounts.map((account: { id: string }) => account.id), first.accounts.map((account: { id: string }) => account.id));
		assert.equal(second.accounts.length, 2);
	});
});

test("toAuth ignores the carrier token and follows the active vault account", async () => {
	await withApp({ 1: 40, 2: 70 }, [], async ({ agentDir, handlers, ctx, commands, setModels }) => {
		await handlers.get("session_start")?.({ type: "session_start" }, ctx);
		assert.equal(await ctx.modelRegistry.getApiKeyForProvider("openai-codex"), "access-account-1");

		await commands.get("codex-switch")?.("", ctx);
		assert.equal(setModels.length, 0);
		assert.equal(ctx.model.provider, "openai-codex");
		assert.equal(activeIndex(await readVault(agentDir)), 2);
		assert.equal(await ctx.modelRegistry.getApiKeyForProvider("openai-codex"), "access-account-2");
	});
});

test("oauth login stores the pending account and returns a marker", async () => {
	const agentDir = await mkdtemp(join(tmpdir(), "pi-multi-codex-login-"));
	const prior = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = agentDir;
	try {
		const directory = extensionConfigDir("pi-multi-codex", agentDir);
		await mkdir(directory, { recursive: true, mode: 0o700 });
		await writeFile(vaultPath(agentDir), `${JSON.stringify({
			version: 1,
			pendingAccountId: "pending-1",
			accounts: [{ id: "pending-1", index: 2, revision: 0 }],
		})}\n`);
		const oauth = wrapCodexOAuth({
			name: "OpenAI Codex",
			login: async () => credential("account-new"),
			refresh: async (value) => value,
			toAuth: async (value) => ({ apiKey: value.access }),
		});
		const result = await oauth.login({ prompt: async () => "", notify() {} } as never);
		assert.equal(result.access, ACCOUNT_VAULT_MARKER);
		assert.equal(result.refresh, ACCOUNT_VAULT_MARKER);
		const vault = await readVault(agentDir);
		assert.equal(vault.pendingAccountId, undefined);
		assert.equal(activeIndex(vault), 2);
		assert.equal(vault.accounts[0].credential.access, "access-account-new");
		assert.equal((await oauth.refresh(result, AbortSignal.timeout(1000))).access, ACCOUNT_VAULT_MARKER);
		assert.equal((await oauth.toAuth(result)).apiKey, "access-account-new");
	} finally {
		if (prior === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = prior;
		await rm(agentDir, { recursive: true, force: true });
	}
});

test("rejects duplicate or inconsistent vault identities without rewriting the file", async () => {
	const agentDir = await mkdtemp(join(tmpdir(), "pi-multi-codex-invalid-vault-"));
	const prior = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = agentDir;
	try {
		const directory = extensionConfigDir("pi-multi-codex", agentDir);
		await mkdir(directory, { recursive: true, mode: 0o700 });
		const duplicate = {
			version: 1,
			activeAccountId: "first",
			accounts: [
				{ id: "first", index: 1, accountId: "account-1", accountHash: hash("account-1"), credential: credential("account-1"), revision: 0 },
				{ id: "second", index: 2, accountId: "account-1", accountHash: hash("account-1"), credential: credential("account-1"), revision: 0 },
			],
		};
		const original = `${JSON.stringify(duplicate)}\n`;
		await writeFile(vaultPath(agentDir), original);
		const oauth = wrapCodexOAuth({
			name: "OpenAI Codex",
			login: async () => credential("account-new"),
			refresh: async (value) => value,
			toAuth: async (value) => ({ apiKey: value.access }),
		});
		await assert.rejects(oauth.toAuth({ type: "oauth", access: ACCOUNT_VAULT_MARKER, refresh: ACCOUNT_VAULT_MARKER, expires: Number.MAX_SAFE_INTEGER }), /No Codex OAuth accounts/i);
		assert.equal(await readFile(vaultPath(agentDir), "utf8"), original);
	} finally {
		if (prior === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = prior;
		await rm(agentDir, { recursive: true, force: true });
	}
});

test("serializes credential refresh across independent extension instances", async () => {
	const agentDir = await mkdtemp(join(tmpdir(), "pi-multi-codex-refresh-"));
	const prior = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = agentDir;
	try {
		const directory = extensionConfigDir("pi-multi-codex", agentDir);
		await mkdir(directory, { recursive: true, mode: 0o700 });
		const expired = { ...credential("account-1"), expires: Date.now() - 1 };
		await writeFile(vaultPath(agentDir), `${JSON.stringify({
			version: 1,
			activeAccountId: "account",
			accounts: [{ id: "account", index: 1, accountId: "account-1", accountHash: hash("account-1"), credential: expired, revision: 0 }],
		})}\n`);
		let refreshCalls = 0;
		const base = {
			name: "OpenAI Codex",
			login: async () => credential("account-1"),
			refresh: async () => {
				refreshCalls += 1;
				await new Promise((resolve) => setTimeout(resolve, 25));
				return credential("account-1");
			},
			toAuth: async (value: ReturnType<typeof credential>) => ({ apiKey: value.access }),
		};
		const firstModule = await import(new URL("../extensions/multi-codex.ts?refresh=first", import.meta.url).href) as { wrapCodexOAuth: typeof wrapCodexOAuth };
		const secondModule = await import(new URL("../extensions/multi-codex.ts?refresh=second", import.meta.url).href) as { wrapCodexOAuth: typeof wrapCodexOAuth };
		const carrier = { type: "oauth" as const, access: ACCOUNT_VAULT_MARKER, refresh: ACCOUNT_VAULT_MARKER, expires: Number.MAX_SAFE_INTEGER };
		const [first, second] = await Promise.all([
			firstModule.wrapCodexOAuth(base).toAuth(carrier),
			secondModule.wrapCodexOAuth(base).toAuth(carrier),
		]);
		assert.equal(first.apiKey, "access-account-1");
		assert.equal(second.apiKey, "access-account-1");
		assert.equal(refreshCalls, 1);
		assert.equal((await readVault(agentDir)).accounts[0].revision, 1);
	} finally {
		if (prior === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = prior;
		await rm(agentDir, { recursive: true, force: true });
	}
});

test("routes once at first agent boundary from fresh seven-day cache", async () => {
	await withApp({ 1: 40, 2: 70, 3: 70 }, [], async ({ agentDir, handlers, ctx, setModels, statuses }) => {
		await handlers.get("session_start")?.({ type: "session_start" }, ctx);
		assert.equal(setModels.length, 0);
		assert.equal(activeIndex(await readVault(agentDir)), 1);
		assert.equal(statuses.at(-1), "<warning>Codex #1 · 40% · 7d 1h</warning>");

		await handlers.get("before_agent_start")?.({ type: "before_agent_start" }, ctx);
		assert.equal(setModels.length, 0);
		assert.equal(ctx.model.provider, "openai-codex");
		assert.equal(activeIndex(await readVault(agentDir)), 2);
		handlers.get("agent_start")?.({ type: "agent_start" }, ctx);
		await handlers.get("before_agent_start")?.({ type: "before_agent_start" }, ctx);
		assert.equal(activeIndex(await readVault(agentDir)), 2);
	});
});

test("legacy config keeps startup ranking enabled", async () => {
	await withApp({ 1: 40, 2: 90 }, [], async ({ agentDir, handlers, ctx, notices }) => {
		await writeFile(extensionConfigPath("pi-multi-codex", agentDir), '{"autoSwitchOn429":false}\n');
		await handlers.get("session_start")?.({ type: "session_start" }, ctx);
		await handlers.get("before_agent_start")?.({ type: "before_agent_start" }, ctx);
		assert.equal(activeIndex(await readVault(agentDir)), 2);
		assert.doesNotMatch(notices.join("\n"), /config is invalid/);
	});
});

test("autoSelectOnStartup true ranks accounts independently of 429 switching", async () => {
	await withApp({ 1: 40, 2: 90 }, [], async ({ agentDir, handlers, ctx, notices }) => {
		await writeFile(extensionConfigPath("pi-multi-codex", agentDir), JSON.stringify({ autoSelectOnStartup: true, autoSwitchOn429: false }));
		await handlers.get("session_start")?.({ type: "session_start" }, ctx);
		await handlers.get("before_agent_start")?.({ type: "before_agent_start" }, ctx);
		assert.equal(activeIndex(await readVault(agentDir)), 2);
		assert.doesNotMatch(notices.join("\n"), /config is invalid/);
	});
});

test("autoSelectOnStartup false keeps the active account across starts and five-hour blocks but allows manual switching", async () => {
	await withApp({ 1: 40, 2: 90 }, [], async ({ agentDir, handlers, commands, ctx, notices, statuses }) => {
		await writeFile(extensionConfigPath("pi-multi-codex", agentDir), JSON.stringify({ autoSelectOnStartup: false, autoSwitchOn429: true }));
		await handlers.get("session_start")?.({ type: "session_start" }, ctx);
		await handlers.get("before_agent_start")?.({ type: "before_agent_start" }, ctx);
		assert.equal(activeIndex(await readVault(agentDir)), 1);
		assert.match(statuses.at(-1) ?? "", /Codex #1.*40%/);
		handlers.get("agent_start")?.({ type: "agent_start" }, ctx);

		const cache = usagePath(agentDir);
		const state = JSON.parse(await readFile(cache, "utf8"));
		state.slots.find((snapshot: { slot: number }) => snapshot.slot === 1).limitedUntil = Date.now() + 60_000;
		await writeFile(cache, JSON.stringify(state));
		await handlers.get("before_agent_start")?.({ type: "before_agent_start" }, ctx);
		assert.equal(activeIndex(await readVault(agentDir)), 1);

		await commands.get("codex-switch")?.("", ctx);
		await handlers.get("before_agent_start")?.({ type: "before_agent_start" }, ctx);
		assert.equal(activeIndex(await readVault(agentDir)), 2);
		assert.equal(ctx.model.provider, "openai-codex");
		assert.equal(ctx.model.id, "gpt-5.3-codex");
		assert.doesNotMatch(notices.join("\n"), /config is invalid/);
	});
});

test("autoSelectOnStartup false does not disable HTTP 429 failover", async () => {
	await withApp({ 1: 40, 2: 90 }, [], async ({ agentDir, handlers, ctx, notices }) => {
		await writeFile(extensionConfigPath("pi-multi-codex", agentDir), JSON.stringify({ autoSelectOnStartup: false, autoSwitchOn429: true }));
		await handlers.get("session_start")?.({ type: "session_start" }, ctx);
		await handlers.get("before_agent_start")?.({ type: "before_agent_start" }, ctx);
		assert.equal(activeIndex(await readVault(agentDir)), 1);

		handlers.get("before_provider_request")?.({ type: "before_provider_request", payload: {} }, ctx);
		handlers.get("after_provider_response")?.({ type: "after_provider_response", status: 429, headers: {} }, ctx);
		const retry = await handlers.get("message_end")?.({ type: "message_end", message: assistantError() }, ctx) as any;
		assert.equal(activeIndex(await readVault(agentDir)), 2);
		assert.match(retry.message.errorMessage, /account switched/);
		assert.doesNotMatch(notices.join("\n"), /config is invalid/);
	});
});

test("invalid startup config is preserved and disables both automatic routes", async () => {
	for (const config of [
		{ autoSwitchOn429: true, autoSelectOnStartup: "false" },
		{ autoSwitchOn429: true, autoSelectOnStartup: false, unknown: true },
	]) {
		await withApp({ 1: 40, 2: 90 }, [], async ({ agentDir, handlers, ctx, notices }) => {
			const path = extensionConfigPath("pi-multi-codex", agentDir);
			const original = JSON.stringify(config);
			await writeFile(path, original);
			await handlers.get("session_start")?.({ type: "session_start" }, ctx);
			await handlers.get("before_agent_start")?.({ type: "before_agent_start" }, ctx);
			assert.equal(activeIndex(await readVault(agentDir)), 1);
			assert.match(notices.join("\n"), /config is invalid/);
			assert.equal(await readFile(path, "utf8"), original);

			handlers.get("before_provider_request")?.({ type: "before_provider_request", payload: {} }, ctx);
			handlers.get("after_provider_response")?.({ type: "after_provider_response", status: 429, headers: {} }, ctx);
			const result = await handlers.get("message_end")?.({ type: "message_end", message: assistantError() }, ctx);
			assert.equal(result, undefined);
			assert.equal(activeIndex(await readVault(agentDir)), 1);
		});
	}
});

test("explicit Codex model selection does not disable account ranking", async () => {
	await withApp({ 1: 0, 2: 70 }, [], async ({ agentDir, handlers, ctx, selectModel, setModels }) => {
		await handlers.get("session_start")?.({ type: "session_start" }, ctx);
		await selectModel(model());
		await handlers.get("before_agent_start")?.({ type: "before_agent_start" }, ctx);
		assert.equal(setModels.length, 0);
		assert.equal(ctx.model.provider, "openai-codex");
		assert.equal(activeIndex(await readVault(agentDir)), 2);
	});
});

test("does not route from or rewrite a legacy snapshot lacking five-hour observation", async () => {
	await withApp({ 1: 40, 2: 90 }, [], async ({ agentDir, handlers, ctx, setModels }) => {
		const cache = usagePath(agentDir);
		const state = JSON.parse(await readFile(cache, "utf8"));
		for (const snapshot of state.slots) delete snapshot.limitedUntil;
		const original = JSON.stringify(state);
		await writeFile(cache, original);

		await handlers.get("session_start")?.({ type: "session_start" }, ctx);
		await handlers.get("before_agent_start")?.({ type: "before_agent_start" }, ctx);
		await new Promise((resolve) => setTimeout(resolve, 20));
		assert.equal(setModels.length, 0);
		assert.equal(activeIndex(await readVault(agentDir)), 1);
		assert.equal(await readFile(cache, "utf8"), original);
	});
});

test("revalidates cached candidate at agent boundary", async () => {
	await withApp({ 1: 40, 2: 90 }, [], async ({ agentDir, handlers, ctx, setModels }) => {
		await handlers.get("session_start")?.({ type: "session_start" }, ctx);
		const cache = usagePath(agentDir);
		const state = JSON.parse(await readFile(cache, "utf8"));
		state.slots.find((snapshot: { slot: number }) => snapshot.slot === 2).reset = Date.now() - 1;
		await writeFile(cache, JSON.stringify(state));
		await handlers.get("before_agent_start")?.({ type: "before_agent_start" }, ctx);
		assert.equal(setModels.length, 0);
		assert.equal(activeIndex(await readVault(agentDir)), 1);
	});
});

test("does not select a five-hour-limited slot until reset", async () => {
	for (const [resetOffset, expectedIndex] of [[60_000, 2], [-1, 1]] as const) {
		await withApp({ 1: 90, 2: 70 }, [], async ({ agentDir, handlers, ctx, setModels }) => {
			const cache = usagePath(agentDir);
			const state = JSON.parse(await readFile(cache, "utf8"));
			state.slots.find((snapshot: { slot: number }) => snapshot.slot === 1).limitedUntil = Date.now() + resetOffset;
			await writeFile(cache, JSON.stringify(state));

			await handlers.get("session_start")?.({ type: "session_start" }, ctx);
			await handlers.get("before_agent_start")?.({ type: "before_agent_start" }, ctx);
			assert.equal(setModels.length, 0);
			assert.equal(activeIndex(await readVault(agentDir)), expectedIndex);
		});
	}
});

test("moves off the active slot when its five-hour limit is reached", async () => {
	await withApp({ 1: 23, 2: 84 }, [], async ({ agentDir, handlers, ctx, setModels }) => {
		await handlers.get("session_start")?.({ type: "session_start" }, ctx);
		await handlers.get("before_agent_start")?.({ type: "before_agent_start" }, ctx);
		assert.equal(activeIndex(await readVault(agentDir)), 2);
		handlers.get("agent_start")?.({ type: "agent_start" }, ctx);

		const cache = usagePath(agentDir);
		const state = JSON.parse(await readFile(cache, "utf8"));
		state.slots.find((snapshot: { slot: number }) => snapshot.slot === 2).limitedUntil = Date.now() + 60_000;
		await writeFile(cache, JSON.stringify(state));

		await handlers.get("before_agent_start")?.({ type: "before_agent_start" }, ctx);
		assert.equal(setModels.length, 0);
		assert.equal(ctx.model.provider, "openai-codex");
		assert.equal(activeIndex(await readVault(agentDir)), 1);
	});
});

test("does not route when the current model is outside Codex", async () => {
	await withApp({ 1: 40, 2: 90 }, [], async ({ agentDir, handlers, ctx, setModels, selectModel }) => {
		await handlers.get("session_start")?.({ type: "session_start" }, ctx);
		await selectModel({ ...model("google"), id: "gemini-pro" });
		await handlers.get("before_agent_start")?.({ type: "before_agent_start" }, ctx);
		assert.equal(setModels.length, 0);
		assert.equal(activeIndex(await readVault(agentDir)), 1);
	});
});

test("does not reopen automatic routing after session reload", async () => {
	await withApp({ 1: 40, 2: 90 }, [], async ({ agentDir, handlers, ctx, setModels }) => {
		await handlers.get("session_start")?.({ type: "session_start", reason: "new" }, ctx);
		handlers.get("agent_start")?.({ type: "agent_start" }, ctx);
		await handlers.get("session_start")?.({ type: "session_start", reason: "reload" }, ctx);
		await handlers.get("before_agent_start")?.({ type: "before_agent_start" }, ctx);
		assert.equal(setModels.length, 0);
		assert.equal(activeIndex(await readVault(agentDir)), 1);
	});
});

test("manual switch keeps the openai-codex model id and provider", async () => {
	await withApp({ 1: 75, 2: 20 }, [], async ({ agentDir, handlers, commands, ctx, setModels }) => {
		await handlers.get("session_start")?.({ type: "session_start" }, ctx);
		await commands.get("codex-switch")?.("", ctx);
		await handlers.get("before_agent_start")?.({ type: "before_agent_start" }, ctx);
		assert.equal(setModels.length, 0);
		assert.equal(ctx.model.provider, "openai-codex");
		assert.equal(ctx.model.id, "gpt-5.3-codex");
		assert.equal(activeIndex(await readVault(agentDir)), 2);
	});
});

test("manual switch works outside Codex and shows cached quota", async () => {
	await withApp({ 1: 75, 2: 20 }, [], async ({ agentDir, handlers, commands, ctx, notices, selectModel }) => {
		await handlers.get("session_start")?.({ type: "session_start" }, ctx);
		await selectModel({ ...model("google"), id: "gemini-pro" });
		let choices: string[] = [];
		ctx.ui.select = async (_title: string, nextChoices: string[]) => {
			choices = nextChoices;
			return nextChoices[1];
		};

		await commands.get("codex-switch")?.("", ctx);

		assert.match(choices[0] ?? "", /Codex #1.*75%/);
		assert.match(choices[1] ?? "", /Codex #2.*20%/);
		assert.doesNotMatch(notices.join("\n"), /Select an OpenAI Codex model/);
		assert.equal(activeIndex(await readVault(agentDir)), 2);
	});
});

test("manual account selection before first turn wins even when limited", async () => {
	await withApp({ 1: 40, 2: 90 }, [], async ({ agentDir, handlers, commands, ctx, setModels }) => {
		const cache = usagePath(agentDir);
		const state = JSON.parse(await readFile(cache, "utf8"));
		state.slots.find((snapshot: { slot: number }) => snapshot.slot === 2).limitedUntil = Date.now() + 60_000;
		await writeFile(cache, JSON.stringify(state));

		await handlers.get("session_start")?.({ type: "session_start" }, ctx);
		await commands.get("codex-switch")?.("", ctx);
		await handlers.get("before_agent_start")?.({ type: "before_agent_start" }, ctx);
		assert.equal(setModels.length, 0);
		assert.equal(activeIndex(await readVault(agentDir)), 2);
	});
});

test("codex-add creates a pending vault account for /login OpenAI Codex", async () => {
	await withApp({ 1: 50 }, [], async ({ agentDir, handlers, commands, ctx, notices, providers }) => {
		await handlers.get("session_start")?.({ type: "session_start" }, ctx);
		await commands.get("codex-add")?.("", ctx);
		assert.equal(providers.length, 1);
		assert.match(notices.at(-1) ?? "", /Run \/login and select OpenAI Codex/);
		const vault = await readVault(agentDir);
		assert.ok(vault.pendingAccountId);
		assert.equal(vault.accounts.find((account: { id: string }) => account.id === vault.pendingAccountId)?.index, 2);
		assert.equal(vault.accounts.find((account: { id: string }) => account.id === vault.pendingAccountId)?.credential, undefined);
	});
});

test("switches on final HTTP 429 and stops after every eligible account was tried", async () => {
	await withApp({ 1: 80, 2: 60 }, [], async ({ agentDir, handlers, ctx, setModels, notices }) => {
		await handlers.get("session_start")?.({ type: "session_start" }, ctx);
		await handlers.get("before_agent_start")?.({ type: "before_agent_start" }, ctx);
		assert.equal(activeIndex(await readVault(agentDir)), 1);

		handlers.get("before_provider_request")?.({ type: "before_provider_request", payload: {} }, ctx);
		handlers.get("after_provider_response")?.({ type: "after_provider_response", status: 429, headers: {} }, ctx);
		const retry = await handlers.get("message_end")?.({ type: "message_end", message: assistantError() }, ctx) as any;
		assert.equal(setModels.length, 0);
		assert.equal(ctx.model.provider, "openai-codex");
		assert.equal(activeIndex(await readVault(agentDir)), 2);
		assert.equal(retry.message.errorMessage, "HTTP 429: Codex account switched; retry the request with the active account.");
		assert.doesNotMatch(retry.message.errorMessage, /quota exceeded|insufficient_quota|billing/i);
		assert.match(notices.at(-1) ?? "", /Retrying with Codex #2/);

		handlers.get("before_provider_request")?.({ type: "before_provider_request", payload: {} }, ctx);
		handlers.get("after_provider_response")?.({ type: "after_provider_response", status: 429, headers: {} }, ctx);
		const exhausted = await handlers.get("message_end")?.({ type: "message_end", message: assistantError() }, ctx) as any;
		assert.equal(setModels.length, 0);
		assert.equal(activeIndex(await readVault(agentDir)), 2);
		assert.match(exhausted.message.errorMessage, /quota exceeded.*all eligible account slots.*failover stopped/i);
	});
});

test("does not switch when an internal 429 retry finishes successfully", async () => {
	await withApp({ 1: 80, 2: 60 }, [], async ({ agentDir, handlers, ctx, setModels }) => {
		await handlers.get("session_start")?.({ type: "session_start" }, ctx);
		handlers.get("before_provider_request")?.({ type: "before_provider_request", payload: {} }, ctx);
		handlers.get("after_provider_response")?.({ type: "after_provider_response", status: 429, headers: {} }, ctx);
		handlers.get("after_provider_response")?.({ type: "after_provider_response", status: 200, headers: {} }, ctx);
		const result = await handlers.get("message_end")?.({ type: "message_end", message: assistantError() }, ctx);
		assert.equal(result, undefined);
		assert.equal(setModels.length, 0);
		assert.equal(activeIndex(await readVault(agentDir)), 1);
	});
});

test("autoSwitchOn429 false leaves normal 429 handling unchanged", async () => {
	await withApp({ 1: 80, 2: 60 }, [], async ({ agentDir, handlers, ctx, setModels }) => {
		await writeFile(extensionConfigPath("pi-multi-codex", agentDir), '{"autoSwitchOn429":false}\n');
		await handlers.get("session_start")?.({ type: "session_start" }, ctx);
		handlers.get("before_provider_request")?.({ type: "before_provider_request", payload: {} }, ctx);
		handlers.get("after_provider_response")?.({ type: "after_provider_response", status: 429, headers: {} }, ctx);
		const result = await handlers.get("message_end")?.({ type: "message_end", message: assistantError() }, ctx);
		assert.equal(result, undefined);
		assert.equal(setModels.length, 0);
		assert.equal(activeIndex(await readVault(agentDir)), 1);
	});
});

test("malformed config is preserved, warns once, and disables 429 switching", async () => {
	await withApp({ 1: 80, 2: 60 }, [], async ({ agentDir, handlers, ctx, setModels, notices }) => {
		const path = extensionConfigPath("pi-multi-codex", agentDir);
		const malformed = '{"autoSwitchOn429":"yes"}\n';
		await writeFile(path, malformed);
		await handlers.get("session_start")?.({ type: "session_start" }, ctx);
		await handlers.get("session_start")?.({ type: "session_start" }, ctx);
		assert.equal(notices.filter((notice) => notice.includes("config is invalid")).length, 1);
		assert.equal(await readFile(path, "utf8"), malformed);

		handlers.get("before_provider_request")?.({ type: "before_provider_request", payload: {} }, ctx);
		handlers.get("after_provider_response")?.({ type: "after_provider_response", status: 429, headers: {} }, ctx);
		const result = await handlers.get("message_end")?.({ type: "message_end", message: assistantError() }, ctx);
		assert.equal(result, undefined);
		assert.equal(setModels.length, 0);
	});
});

test("shows the five-hour reset below Pro Lite and the seven-day reset at Pro Lite", async () => {
	for (const [tier, footerWindow, status] of [
		["plus", "5h 30m", "Codex slot 1 (plus): 50% of the seven-day quota remaining; five-hour reset in 30m (measured)"],
		["prolite", "7d 1h", "Codex slot 1 (prolite): 50% of the seven-day quota remaining; seven-day reset in 1h (measured)"],
	] as const) {
		await withApp({ 1: 50 }, [], async ({ agentDir, commands, handlers, ctx, notices, statuses }) => {
			const cache = usagePath(agentDir);
			const state = JSON.parse(await readFile(cache, "utf8"));
			state.slots[0].tier = tier;
			state.slots[0].fiveHourReset = Date.now() + 30 * 60_000;
			await writeFile(cache, JSON.stringify(state));

			await handlers.get("session_start")?.({ type: "session_start" }, ctx);
			assert.equal(statuses.at(-1), `<success>Codex #1 · 50% · ${footerWindow}</success>`);
			await commands.get("codex-status")?.("", ctx);
			assert.equal(notices.at(-1), status);
		});
	}
});

test("colors fresh footer at every quota threshold", async () => {
	for (const [remaining, color] of [[50, "success"], [25, "warning"], [24, "error"]] as const) {
		await withApp({ 1: remaining }, [], async ({ handlers, ctx, statuses }) => {
			await handlers.get("session_start")?.({ type: "session_start" }, ctx);
			assert.equal(statuses.at(-1), `<${color}>Codex #1 · ${remaining}% · 7d 1h</${color}>`);
		});
	}
});
