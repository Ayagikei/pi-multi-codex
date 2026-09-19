import { createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { createConfigStore, extensionConfigDir, writePrivateTextFileAtomically } from "@henryqw/pi-config-store";
import { lock } from "proper-lockfile";
import {
	type Model,
	type Provider,
} from "@earendil-works/pi-ai";
import { builtinProviders } from "@earendil-works/pi-ai/providers/all";
import {
	getAgentDir,
	type ExtensionAPI,
	type ExtensionContext,
} from "@earendil-works/pi-coding-agent";

type CodexProvider = Provider<"openai-codex-responses">;
type CodexOAuth = NonNullable<CodexProvider["auth"]["oauth"]>;
type JsonRecord = Record<string, unknown>;
type Timer = ReturnType<typeof setInterval>;

type CodexOAuthCredential = JsonRecord & {
	type: "oauth";
	access: string;
	refresh: string;
	expires: number;
	accountId?: string;
};

type SlotIdentity = {
	accountId: string;
	accountHash: string;
};

type SlotAuthResolver = (slot: number) => Promise<string | undefined>;
type QuotaRefresh = { session: AbortController; resolveSlotAuth: SlotAuthResolver };

type UsageSnapshot = {
	slot: number;
	accountHash: string;
	tier?: string;
	checkedAt: number;
	fetchedAt?: number;
	remaining?: number;
	reset?: number;
	fiveHourReset?: number;
	limitedUntil?: number | null;
};

type UsageLock = {
	slot: number;
	owner: string;
	accountHash: string;
	heartbeatAt: number;
};

type UsageState = {
	slots: Map<number, UsageSnapshot>;
	locks: Map<number, UsageLock>;
	untrusted?: true;
};

type VaultAccount = {
	id: string;
	index: number;
	accountId?: string;
	accountHash?: string;
	credential?: CodexOAuthCredential;
	revision: number;
};

type AccountVault = {
	version: 1;
	activeAccountId?: string;
	pendingAccountId?: string;
	accounts: VaultAccount[];
	untrusted?: true;
};

type ParsedUsage = { remaining: number; reset: number; fiveHourReset?: number; limitedUntil?: number; tier?: string };
type Config = { autoSwitchOn429: boolean };

const NATIVE_PROVIDER_ID = "openai-codex";
const CODEX_ALIAS_PATTERN = /^openai-codex-([2-9]|[1-9]\d+)$/;
export const ACCOUNT_VAULT_MARKER = "pi-multi-codex-account-vault-v1";
const NO_ACCOUNTS_MESSAGE = "No Codex OAuth accounts found. Run /login and select OpenAI Codex.";
const AGENT_STARTED_ENTRY = "pi-multi-codex:agent-started";
const USAGE_URL = "https://chatgpt.com/backend-api/wham/usage";
const REFRESH_MS = 5 * 60_000;
const LOCK_STALE_MS = 45_000;
const HEARTBEAT_MS = 5_000;
const OPERATION_TIMEOUT_MS = 10_000;
const CACHE_MUTEX_RETRY_MS = 20;
const CLEANUP_TIMEOUT_MS = 250;
const cachePath = () => join(extensionConfigDir("pi-multi-codex"), "usage.json");
const vaultPath = () => join(extensionConfigDir("pi-multi-codex"), "accounts.json");
const mutexPath = (file: string) => `${file}.mutex`;

const refreshes = new Map<string, Promise<CodexOAuthCredential | undefined>>();
const migratingByDir = new Map<string, Promise<void>>();
function parseConfig(value: unknown): Config {
	if (!isRecord(value) || Object.keys(value).length !== 1 || typeof value.autoSwitchOn429 !== "boolean") {
		throw new Error("Config must contain only autoSwitchOn429:boolean.");
	}
	return { autoSwitchOn429: value.autoSwitchOn429 };
}

function isRecord(value: unknown): value is JsonRecord {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isOAuthCredential(value: unknown): value is CodexOAuthCredential {
	return (
		isRecord(value) &&
		value.type === "oauth" &&
		typeof value.access === "string" &&
		typeof value.refresh === "string" &&
		typeof value.expires === "number" &&
		Number.isFinite(value.expires)
	);
}

function isMarker(value: { access: string; refresh: string }): boolean {
	return value.access === ACCOUNT_VAULT_MARKER || value.refresh === ACCOUNT_VAULT_MARKER;
}

function markerCredential(): CodexOAuthCredential {
	return {
		type: "oauth",
		access: ACCOUNT_VAULT_MARKER,
		refresh: ACCOUNT_VAULT_MARKER,
		expires: Number.MAX_SAFE_INTEGER,
	};
}

function storedCredential(value: CodexOAuthCredential): CodexOAuthCredential {
	return {
		type: "oauth",
		access: value.access,
		refresh: value.refresh,
		expires: value.expires,
		...(typeof value.accountId === "string" && value.accountId ? { accountId: value.accountId } : {}),
	};
}

function slotForProvider(providerId: string): number | undefined {
	if (providerId === NATIVE_PROVIDER_ID) return 1;
	const match = CODEX_ALIAS_PATTERN.exec(providerId);
	const slot = match ? Number(match[1]) : undefined;
	return validSlot(slot) ? slot : undefined;
}

function readLegacyCodexCredentials(): Map<number, CodexOAuthCredential> {
	let parsed: unknown;
	try {
		parsed = JSON.parse(readFileSync(join(getAgentDir(), "auth.json"), "utf8"));
	} catch {
		return new Map();
	}
	if (!isRecord(parsed)) return new Map();

	const credentials = new Map<number, CodexOAuthCredential>();
	for (const [providerId, credential] of Object.entries(parsed)) {
		const slot = slotForProvider(providerId);
		if (slot && isOAuthCredential(credential) && !isMarker(credential)) credentials.set(slot, storedCredential(credential));
	}
	return credentials;
}

function accountIdFromAccessToken(access: string): string | undefined {
	try {
		const encoded = access.split(".")[1];
		if (!encoded) return undefined;
		const payload: unknown = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8"));
		if (!isRecord(payload)) return undefined;
		const auth = payload["https://api.openai.com/auth"];
		if (!isRecord(auth) || typeof auth.chatgpt_account_id !== "string" || !auth.chatgpt_account_id) return undefined;
		return auth.chatgpt_account_id;
	} catch {
		return undefined;
	}
}

function identityFor(credential: CodexOAuthCredential | undefined): SlotIdentity | undefined {
	if (!credential || isMarker(credential)) return undefined;
	const accountId = typeof credential.accountId === "string" && credential.accountId
		? credential.accountId
		: accountIdFromAccessToken(credential.access);
	if (!accountId) return undefined;
	return {
		accountId,
		accountHash: createHash("sha256").update(accountId).digest("hex"),
	};
}

function accountHashFor(credential: CodexOAuthCredential): string {
	return identityFor(credential)?.accountHash ?? createHash("sha256").update(credential.refresh).digest("hex");
}

function currentIdentity(slot: number): SlotIdentity | undefined {
	return identityFor(credentialMap().get(slot));
}

function validHash(value: unknown): value is string {
	return typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
}

function validSlot(value: unknown): value is number {
	return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function validTime(value: unknown): value is number {
	return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function validTier(value: unknown): value is string {
	return typeof value === "string" && /^[a-zA-Z0-9._-]{1,64}$/.test(value);
}

function readSnapshot(value: unknown): UsageSnapshot | undefined {
	if (!isRecord(value) || !validSlot(value.slot) || !validHash(value.accountHash) || !validTime(value.checkedAt)) return undefined;
	const successful = value.fetchedAt !== undefined || value.remaining !== undefined || value.reset !== undefined;
	if (successful && (
		!validTime(value.fetchedAt) ||
		typeof value.remaining !== "number" ||
		!Number.isFinite(value.remaining) ||
		!validTime(value.reset) ||
		(value.fiveHourReset !== undefined && !validTime(value.fiveHourReset)) ||
		(value.limitedUntil !== null && !validTime(value.limitedUntil))
	)) return undefined;
	if (!successful && (value.fiveHourReset !== undefined || value.limitedUntil !== undefined)) return undefined;
	return {
		slot: value.slot,
		accountHash: value.accountHash,
		...(validTier(value.tier) ? { tier: value.tier } : {}),
		checkedAt: value.checkedAt,
		...(successful
			? {
				fetchedAt: value.fetchedAt as number,
				remaining: Math.max(0, Math.min(100, value.remaining as number)),
				reset: value.reset as number,
				...(validTime(value.fiveHourReset) ? { fiveHourReset: value.fiveHourReset } : {}),
				limitedUntil: value.limitedUntil as number | null,
			}
			: {}),
	};
}

function readLock(value: unknown): UsageLock | undefined {
	if (!isRecord(value) || !validSlot(value.slot) || typeof value.owner !== "string" || !value.owner || !validHash(value.accountHash) || !validTime(value.heartbeatAt)) {
		return undefined;
	}
	return { slot: value.slot, owner: value.owner, accountHash: value.accountHash, heartbeatAt: value.heartbeatAt };
}

function parseState(value: unknown): UsageState | undefined {
	if (!isRecord(value) || !Array.isArray(value.slots) || !Array.isArray(value.locks)) return undefined;
	const state = emptyState();
	for (const snapshot of value.slots) {
		const parsed = readSnapshot(snapshot);
		if (!parsed || state.slots.has(parsed.slot)) return undefined;
		state.slots.set(parsed.slot, parsed);
	}
	for (const lock of value.locks) {
		const parsed = readLock(lock);
		if (!parsed || state.locks.has(parsed.slot)) return undefined;
		state.locks.set(parsed.slot, parsed);
	}
	return state;
}

function emptyState(untrusted = false): UsageState {
	return { slots: new Map(), locks: new Map(), ...(untrusted ? { untrusted: true } : {}) };
}

function emptyVault(untrusted = false): AccountVault {
	return { version: 1, accounts: [], ...(untrusted ? { untrusted: true } : {}) };
}

function isMissingCacheFile(error: unknown): boolean {
	return Boolean(error && typeof error === "object" && "code" in error && String(error.code) === "ENOENT");
}

function loadStateSync(): UsageState {
	try {
		return parseState(JSON.parse(readFileSync(cachePath(), "utf8"))) ?? emptyState(true);
	} catch (error) {
		return emptyState(!isMissingCacheFile(error));
	}
}

async function loadState(signal?: AbortSignal): Promise<UsageState> {
	try {
		return parseState(JSON.parse(await readFile(cachePath(), { encoding: "utf8", signal }))) ?? emptyState(true);
	} catch (error) {
		signal?.throwIfAborted();
		return emptyState(!isMissingCacheFile(error));
	}
}

async function saveState(state: UsageState, signal?: AbortSignal): Promise<void> {
	signal?.throwIfAborted();
	if (state.untrusted) return;
	const file = cachePath();
	const data = `${JSON.stringify({
		slots: [...state.slots.values()].sort((a, b) => a.slot - b.slot),
		locks: [...state.locks.values()].sort((a, b) => a.slot - b.slot),
	})}\n`;
	await writePrivateTextFileAtomically(file, data, { signal });
}

function parseVaultAccount(value: unknown): VaultAccount | undefined {
	if (
		!isRecord(value) ||
		typeof value.id !== "string" ||
		!value.id ||
		!validSlot(value.index) ||
		typeof value.revision !== "number" ||
		!Number.isSafeInteger(value.revision) ||
		value.revision < 0
	) return undefined;
	if (value.accountId !== undefined && (typeof value.accountId !== "string" || !value.accountId)) return undefined;
	if (value.accountHash !== undefined && !validHash(value.accountHash)) return undefined;
	if (value.credential !== undefined && (!isOAuthCredential(value.credential) || isMarker(value.credential))) return undefined;
	const credential = value.credential ? storedCredential(value.credential) : undefined;
	return {
		id: value.id,
		index: value.index,
		...(typeof value.accountId === "string" ? { accountId: value.accountId } : {}),
		...(validHash(value.accountHash) ? { accountHash: value.accountHash } : {}),
		...(credential ? { credential } : {}),
		revision: value.revision,
	};
}

function parseVault(value: unknown): AccountVault | undefined {
	if (!isRecord(value) || value.version !== 1 || !Array.isArray(value.accounts)) return undefined;
	const accounts: VaultAccount[] = [];
	const ids = new Set<string>();
	const indexes = new Set<number>();
	const accountIds = new Set<string>();
	const accountHashes = new Set<string>();
	for (const entry of value.accounts) {
		const account = parseVaultAccount(entry);
		if (!account || ids.has(account.id) || indexes.has(account.index)) return undefined;
		if (account.credential) {
			const identity = identityFor(account.credential);
			const accountHash = accountHashFor(account.credential);
			if (account.accountHash !== accountHash || accountHashes.has(accountHash)) return undefined;
			if (identity) {
				if (account.accountId !== identity.accountId || accountIds.has(identity.accountId)) return undefined;
				accountIds.add(identity.accountId);
			} else if (account.accountId !== undefined) {
				return undefined;
			}
			accountHashes.add(accountHash);
		} else if (account.accountId !== undefined || account.accountHash !== undefined) {
			return undefined;
		}
		ids.add(account.id);
		indexes.add(account.index);
		accounts.push(account);
	}
	if (value.activeAccountId !== undefined) {
		if (typeof value.activeAccountId !== "string" || !accounts.some((account) => account.id === value.activeAccountId && account.credential)) {
			return undefined;
		}
	}
	if (value.pendingAccountId !== undefined) {
		if (typeof value.pendingAccountId !== "string" || !accounts.some((account) => account.id === value.pendingAccountId)) {
			return undefined;
		}
	}
	return {
		version: 1,
		...(typeof value.activeAccountId === "string" ? { activeAccountId: value.activeAccountId } : {}),
		...(typeof value.pendingAccountId === "string" ? { pendingAccountId: value.pendingAccountId } : {}),
		accounts,
	};
}

function cloneVault(vault: AccountVault): AccountVault {
	return {
		version: 1,
		...(vault.activeAccountId ? { activeAccountId: vault.activeAccountId } : {}),
		...(vault.pendingAccountId ? { pendingAccountId: vault.pendingAccountId } : {}),
		accounts: vault.accounts.map((account) => ({
			...account,
			...(account.credential ? { credential: storedCredential(account.credential) } : {}),
		})),
		...(vault.untrusted ? { untrusted: true } : {}),
	};
}

function loadVaultSync(): AccountVault {
	try {
		return parseVault(JSON.parse(readFileSync(vaultPath(), "utf8"))) ?? emptyVault(true);
	} catch (error) {
		return emptyVault(!isMissingCacheFile(error));
	}
}

async function loadVault(signal?: AbortSignal): Promise<AccountVault> {
	try {
		return parseVault(JSON.parse(await readFile(vaultPath(), { encoding: "utf8", signal }))) ?? emptyVault(true);
	} catch (error) {
		signal?.throwIfAborted();
		return emptyVault(!isMissingCacheFile(error));
	}
}

async function saveVault(vault: AccountVault, signal?: AbortSignal): Promise<void> {
	signal?.throwIfAborted();
	if (vault.untrusted) return;
	const validated = parseVault(vault);
	if (!validated) throw new Error("Codex account vault failed validation.");
	await writePrivateTextFileAtomically(vaultPath(), `${JSON.stringify({
		version: 1,
		...(validated.activeAccountId ? { activeAccountId: validated.activeAccountId } : {}),
		...(validated.pendingAccountId ? { pendingAccountId: validated.pendingAccountId } : {}),
		accounts: validated.accounts,
	})}\n`, { signal });
}

async function withFileMutex<T>(file: string, operation: (signal: AbortSignal) => Promise<T>, signal?: AbortSignal): Promise<T> {
	signal?.throwIfAborted();
	await mkdir(extensionConfigDir("pi-multi-codex"), { recursive: true, mode: 0o700 });
	let release: (() => Promise<void>) | undefined;
	while (!release) {
		signal?.throwIfAborted();
		try {
			const compromised = new AbortController();
			release = await lock(file, {
				lockfilePath: mutexPath(file),
				realpath: false,
				stale: LOCK_STALE_MS,
				update: HEARTBEAT_MS,
				retries: 0,
				onCompromised: (error) => compromised.abort(error),
			});
			const operationSignal = signal ? AbortSignal.any([signal, compromised.signal]) : compromised.signal;
			try {
				operationSignal.throwIfAborted();
				return await raceWithSignal(operation(operationSignal), operationSignal);
			} finally {
				await release().catch(() => undefined);
			}
		} catch (error) {
			if (!(error && typeof error === "object" && "code" in error && String(error.code) === "ELOCKED")) throw error;
			await delay(CACHE_MUTEX_RETRY_MS, undefined, { signal, ref: false });
		}
	}
	throw new Error("File mutex acquisition ended unexpectedly.");
}

const withCacheMutex = <T>(operation: (signal: AbortSignal) => Promise<T>, signal?: AbortSignal) =>
	withFileMutex(cachePath(), operation, signal);

const withVaultMutex = <T>(operation: (signal: AbortSignal) => Promise<T>, signal?: AbortSignal) =>
	withFileMutex(vaultPath(), operation, signal);

async function mutateVault<T>(change: (vault: AccountVault) => T, signal?: AbortSignal): Promise<T | undefined> {
	return withVaultMutex(async (operationSignal) => {
		const vault = await loadVault(operationSignal);
		if (vault.untrusted) return undefined;
		const next = cloneVault(vault);
		const value = change(next);
		delete next.untrusted;
		await saveVault(next, operationSignal);
		return value;
	}, signal);
}

function credentialMap(): Map<number, CodexOAuthCredential> {
	const credentials = new Map<number, CodexOAuthCredential>();
	for (const account of loadVaultSync().accounts) {
		if (account.credential && !isMarker(account.credential)) credentials.set(account.index, account.credential);
	}
	return credentials;
}

function activeIndexSync(): number | undefined {
	const vault = loadVaultSync();
	return vault.accounts.find((account) => account.id === vault.activeAccountId)?.index;
}

function nextIndex(vault: AccountVault): number {
	let index = 1;
	const used = new Set(vault.accounts.map((account) => account.index));
	while (used.has(index)) index++;
	return index;
}

async function migrateLegacyAccounts(): Promise<void> {
	await mutateVault((vault) => {
		const legacy = readLegacyCodexCredentials();
		for (const [index, credential] of [...legacy.entries()].sort(([left], [right]) => left - right)) {
			const identity = identityFor(credential);
			const accountHash = accountHashFor(credential);
			if (vault.accounts.some((account) => account.accountHash === accountHash)) continue;
			const used = new Set(vault.accounts.map((account) => account.index));
			let slot = index;
			if (used.has(slot)) slot = nextIndex(vault);
			vault.accounts.push({
				id: randomUUID(),
				index: slot,
				...(identity ? { accountId: identity.accountId } : {}),
				accountHash,
				credential,
				revision: 0,
			});
		}
		if (!vault.activeAccountId) {
			const selected = vault.accounts.find((account) => account.index === 1 && account.credential)
				?? vault.accounts.find((account) => account.credential);
			if (selected) vault.activeAccountId = selected.id;
		}
	});
}

function ensureMigrated(): Promise<void> {
	const dir = getAgentDir();
	const pending = migratingByDir.get(dir) ?? migrateLegacyAccounts().catch((error) => {
		migratingByDir.delete(dir);
		throw error;
	});
	migratingByDir.set(dir, pending);
	return pending;
}

async function storeLoginCredential(credential: CodexOAuthCredential): Promise<void> {
	const identity = identityFor(credential);
	const accountHash = accountHashFor(credential);
	const stored = storedCredential(credential);
	const written = await mutateVault((vault) => {
		const pending = vault.pendingAccountId
			? vault.accounts.find((account) => account.id === vault.pendingAccountId)
			: undefined;
		const existing = vault.accounts.find((account) => account.accountHash === accountHash);
		const target = existing ?? pending;
		if (target) {
			target.credential = stored;
			if (identity) {
				target.accountId = identity.accountId;
				target.accountHash = identity.accountHash;
			} else {
				target.accountHash = accountHash;
			}
			target.revision += 1;
			vault.activeAccountId = target.id;
			if (pending && existing && pending.id !== existing.id && !pending.credential) {
				vault.accounts = vault.accounts.filter((account) => account.id !== pending.id);
			}
			delete vault.pendingAccountId;
			return true;
		}
		const id = randomUUID();
		vault.accounts.push({
			id,
			index: nextIndex(vault),
			...(identity ? { accountId: identity.accountId } : {}),
			accountHash,
			credential: stored,
			revision: 0,
		});
		vault.activeAccountId = id;
		delete vault.pendingAccountId;
		return true;
	});
	if (!written) throw new Error("Codex account vault is invalid.");
}

async function refreshVaultCredential(
	base: CodexOAuth,
	accountId: string,
	revision: number,
	_credential: CodexOAuthCredential,
	signal?: AbortSignal,
): Promise<CodexOAuthCredential | undefined> {
	const key = `${accountId}:${revision}`;
	const pending = refreshes.get(key) ?? withVaultMutex(async (mutexSignal) => {
		const vault = await loadVault(mutexSignal);
		if (vault.untrusted) return undefined;
		const account = vault.accounts.find((candidate) => candidate.id === accountId);
		if (!account?.credential) return undefined;
		if (account.revision !== revision && Date.now() < account.credential.expires) return account.credential;

		const refreshSignal = AbortSignal.any([mutexSignal, AbortSignal.timeout(OPERATION_TIMEOUT_MS)]);
		const value = await base.refresh(account.credential, refreshSignal);
		if (!isOAuthCredential(value) || isMarker(value)) throw new Error("OpenAI Codex refresh did not return an OAuth credential.");
		const refreshed = storedCredential(value);
		const identity = identityFor(refreshed);
		account.credential = refreshed;
		account.accountHash = identity?.accountHash ?? accountHashFor(refreshed);
		if (identity) account.accountId = identity.accountId;
		else delete account.accountId;
		account.revision += 1;
		await saveVault(vault, mutexSignal);
		return account.credential;
	}, signal);
	refreshes.set(key, pending);
	try {
		return await pending;
	} finally {
		if (refreshes.get(key) === pending) refreshes.delete(key);
	}
}

async function resolveAccountCredential(
	base: CodexOAuth,
	accountId: string,
	signal?: AbortSignal,
): Promise<CodexOAuthCredential | undefined> {
	const account = loadVaultSync().accounts.find((candidate) => candidate.id === accountId);
	if (!account?.credential) return undefined;
	if (Date.now() < account.credential.expires) return account.credential;
	return refreshVaultCredential(base, account.id, account.revision, account.credential, signal);
}

async function resolveActiveCredential(base: CodexOAuth, signal?: AbortSignal): Promise<CodexOAuthCredential> {
	const vault = loadVaultSync();
	const active = vault.accounts.find((account) => account.id === vault.activeAccountId && account.credential)
		?? vault.accounts.find((account) => account.credential);
	if (!active?.credential) throw new Error(NO_ACCOUNTS_MESSAGE);
	if (vault.activeAccountId !== active.id) {
		await mutateVault((latest) => {
			if (latest.accounts.some((account) => account.id === active.id && account.credential)) {
				latest.activeAccountId = active.id;
			}
		});
	}
	const resolved = await resolveAccountCredential(base, active.id, signal);
	if (!resolved) throw new Error(NO_ACCOUNTS_MESSAGE);
	return resolved;
}

export function wrapCodexOAuth(base: CodexOAuth): CodexOAuth {
	return {
		...base,
		async login(interaction) {
			await ensureMigrated();
			const result = await base.login(interaction);
			if (!isOAuthCredential(result) || isMarker(result)) throw new Error("OpenAI Codex login did not return an OAuth credential.");
			await storeLoginCredential(result);
			return markerCredential();
		},
		async refresh() {
			await ensureMigrated();
			return markerCredential();
		},
		async toAuth() {
			await ensureMigrated();
			return base.toAuth(await resolveActiveCredential(base));
		},
	};
}

function wrapCodexProvider(native: CodexProvider): CodexProvider {
	const oauth = native.auth.oauth;
	if (!oauth) return native;
	return {
		...native,
		auth: {
			...native.auth,
			oauth: wrapCodexOAuth(oauth),
		},
	};
}

function isFresh(snapshot: UsageSnapshot | undefined, identity: SlotIdentity, now: number): boolean {
	return Boolean(
		snapshot &&
		snapshot.accountHash === identity.accountHash &&
		validTime(snapshot.fetchedAt) &&
		validTime(snapshot.reset) &&
		snapshot.fetchedAt <= now &&
		snapshot.reset > now &&
		now - snapshot.fetchedAt < REFRESH_MS,
	);
}

function isFiveHourLimited(snapshot: UsageSnapshot, now: number): boolean {
	return validTime(snapshot.limitedUntil) && snapshot.limitedUntil > now;
}

function displayedReset(snapshot: UsageSnapshot, now: number): { label: "5h" | "7d"; time: number } {
	if (["free", "go", "plus"].includes(snapshot.tier ?? "") && validTime(snapshot.fiveHourReset) && snapshot.fiveHourReset > now) {
		return { label: "5h", time: snapshot.fiveHourReset };
	}
	return { label: "7d", time: snapshot.reset! };
}

function checkedRecently(snapshot: UsageSnapshot | undefined, identity: SlotIdentity, now: number): boolean {
	return Boolean(
		snapshot &&
		snapshot.accountHash === identity.accountHash &&
		snapshot.checkedAt <= now &&
		now - snapshot.checkedAt < REFRESH_MS &&
		(!validTime(snapshot.fetchedAt) || (validTime(snapshot.reset) && snapshot.reset > now)),
	);
}

function owns(lock: UsageLock | undefined, slot: number, owner: string, accountHash: string): boolean {
	return lock?.slot === slot && lock.owner === owner && lock.accountHash === accountHash;
}

function numberValue(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function resetTime(window: JsonRecord, now: number): number | undefined {
	const resetAt = window.reset_at;
	if (typeof resetAt === "number" && Number.isFinite(resetAt)) return resetAt < 10_000_000_000 ? resetAt * 1000 : resetAt;
	if (typeof resetAt === "string") {
		const parsed = Date.parse(resetAt);
		if (Number.isFinite(parsed)) return parsed;
	}
	const resetAfter = numberValue(window.reset_after_seconds);
	return resetAfter === undefined || resetAfter < 0 ? undefined : now + resetAfter * 1000;
}

/** Extract seven-day quota and the five-hour window. */
export function parseCodexUsage(value: unknown, now = Date.now()): ParsedUsage | undefined {
	if (!isRecord(value)) return undefined;
	const rateLimit = isRecord(value.rate_limit) ? value.rate_limit : value;
	const windows = Object.values(rateLimit).flatMap((entry) => {
		if (!isRecord(entry)) return [];
		const used = numberValue(entry.used_percent);
		const reset = resetTime(entry, now);
		return used === undefined || reset === undefined ? [] : [{ value: entry, used, reset }];
	});
	const sevenDay = windows.find((window) => numberValue(window.value.limit_window_seconds) === 7 * 24 * 60 * 60)
		?? (windows.length === 1 && numberValue(windows[0].value.limit_window_seconds) === undefined ? windows[0] : undefined);
	if (!sevenDay || sevenDay.reset <= now) return undefined;
	const fiveHour = windows.find((window) => numberValue(window.value.limit_window_seconds) === 5 * 60 * 60);
	const fiveHourReset = fiveHour && fiveHour.reset > now ? fiveHour.reset : undefined;
	const limitedUntil = fiveHour && fiveHour.used >= 100 ? fiveHourReset : undefined;
	const tier = validTier(value.plan_type) ? value.plan_type : validTier(value.tier) ? value.tier : undefined;
	return {
		remaining: Math.max(0, Math.min(100, 100 - sevenDay.used)),
		reset: sevenDay.reset,
		...(fiveHourReset ? { fiveHourReset } : {}),
		...(limitedUntil ? { limitedUntil } : {}),
		...(tier ? { tier } : {}),
	};
}

function raceWithSignal<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
	if (signal.aborted) return Promise.reject(signal.reason);
	return new Promise((resolve, reject) => {
		const abort = () => reject(signal.reason);
		signal.addEventListener("abort", abort, { once: true });
		operation.then(
			(value) => {
				signal.removeEventListener("abort", abort);
				resolve(value);
			},
			(error: unknown) => {
				signal.removeEventListener("abort", abort);
				reject(error);
			},
		);
	});
}

function formatPercent(value: number): string {
	return Number.isInteger(value) ? String(value) : value.toFixed(1).replace(/\.0$/, "");
}

function formatDuration(ms: number): string {
	if (ms <= 0) return "now";
	const minutes = Math.ceil(ms / 60_000);
	const days = Math.floor(minutes / (24 * 60));
	const hours = Math.floor((minutes % (24 * 60)) / 60);
	const mins = minutes % 60;
	return [days ? `${days}d` : "", hours ? `${hours}h` : "", mins || (!days && !hours) ? `${mins}m` : ""].filter(Boolean).join(" ");
}

class CodexQuotaStatus {
	private refreshContext: QuotaRefresh | undefined;
	private timer: Timer | undefined;
	private readonly heartbeats = new Map<number, { owner: string; timer: Timer }>();
	private readonly active = new Map<number, Promise<void>>();
	private writes: Promise<void> = Promise.resolve();
	private onChange: () => void = () => undefined;

	setOnChange(onChange: () => void): void {
		this.onChange = onChange;
	}

	snapshot(slot: number): UsageSnapshot | undefined {
		return loadStateSync().slots.get(slot);
	}

	private async state(): Promise<UsageState> {
		await this.writes;
		return loadState();
	}

	private change<T>(change: (state: UsageState) => { value: T; write: boolean }, signal?: AbortSignal): Promise<T | undefined> {
		const operation = this.writes.then(() => withCacheMutex(async (operationSignal) => {
			operationSignal.throwIfAborted();
			const state = await loadState(operationSignal);
			operationSignal.throwIfAborted();
			if (state.untrusted) return undefined;
			const result = change(state);
			if (result.write) {
				operationSignal.throwIfAborted();
				await saveState(state, operationSignal);
			}
			return result.value;
		}, signal));
		this.writes = operation.then(() => undefined, () => undefined);
		return operation;
	}

	start(resolveSlotAuth: SlotAuthResolver): void {
		this.stop();
		this.refreshContext = { session: new AbortController(), resolveSlotAuth };
		this.requestRefresh();
	}

	stop(): void {
		this.refreshContext?.session.abort();
		this.refreshContext = undefined;
		if (this.timer) clearTimeout(this.timer);
		this.timer = undefined;
		for (const heartbeat of this.heartbeats.values()) clearInterval(heartbeat.timer);
		this.heartbeats.clear();
	}

	requestRefresh(): void {
		const refresh = this.refreshContext;
		if (!refresh) return;
		void this.refreshDue(refresh)
			.catch(() => undefined)
			.then(() => {
				if (this.refreshContext === refresh) this.scheduleRefresh();
			});
	}

	private scheduleRefresh(): void {
		const refresh = this.refreshContext;
		if (!refresh) return;
		if (this.timer) clearTimeout(this.timer);
		this.timer = undefined;

		const now = Date.now();
		const state = loadStateSync();
		if (state.untrusted) return;
		let dueAt: number | undefined;
		for (const [slot, credential] of credentialMap()) {
			if (this.active.has(slot)) continue;
			const identity = identityFor(credential);
			if (!identity) continue;
			const snapshot = state.slots.get(slot);
			const lock = state.locks.get(slot);
			const lockDue = lock && lock.accountHash === identity.accountHash && lock.heartbeatAt <= now && now - lock.heartbeatAt < LOCK_STALE_MS
				? lock.heartbeatAt + LOCK_STALE_MS + 1
				: undefined;
			const snapshotDue = isFresh(snapshot, identity, now)
				? Math.min(snapshot!.fetchedAt! + REFRESH_MS, snapshot!.reset!) + 1
				: checkedRecently(snapshot, identity, now)
					? snapshot!.checkedAt + REFRESH_MS + 1
					: now;
			const next = lockDue ?? snapshotDue;
			dueAt = dueAt === undefined ? next : Math.min(dueAt, next);
		}
		if (dueAt === undefined) return;
		const wait = Math.max(0, dueAt - now);
		this.timer = setTimeout(() => {
			this.timer = undefined;
			if (this.refreshContext === refresh) this.requestRefresh();
		}, wait);
		this.timer.unref?.();
	}

	private async refreshDue(refresh: QuotaRefresh): Promise<void> {
		const credentials = credentialMap();
		const state = await this.state();
		await Promise.all([...credentials.entries()].map(async ([slot, credential]) => {
			if (this.refreshContext !== refresh || this.active.has(slot)) return;
			const identity = identityFor(credential);
			if (!identity) return;
			const snapshot = state.slots.get(slot);
			if (isFresh(snapshot, identity, Date.now()) || checkedRecently(snapshot, identity, Date.now())) return;
			this.launch(slot, identity, refresh);
		})).catch(() => undefined);
	}

	private launch(slot: number, identity: SlotIdentity, refresh: QuotaRefresh): void {
		if (this.active.has(slot)) return;
		const task = this.refreshSlot(slot, identity, refresh);
		this.active.set(slot, task);
		const cleanup = () => {
			if (this.active.get(slot) !== task) return;
			this.active.delete(slot);
			if (this.refreshContext === refresh) this.scheduleRefresh();
			else this.requestRefresh();
		};
		void task.then(cleanup, cleanup);
	}

	private async claim(slot: number, identity: SlotIdentity, signal: AbortSignal): Promise<string | undefined> {
		const owner = randomUUID();
		const claimed = await this.change((state) => {
			const now = Date.now();
			const snapshot = state.slots.get(slot);
			if (isFresh(snapshot, identity, now) || checkedRecently(snapshot, identity, now)) {
				return { value: false, write: false };
			}
			const lock = state.locks.get(slot);
			if (lock && lock.accountHash === identity.accountHash && lock.heartbeatAt <= now && now - lock.heartbeatAt < LOCK_STALE_MS) {
				return { value: false, write: false };
			}
			if (snapshot?.accountHash !== identity.accountHash) state.slots.delete(slot);
			state.locks.set(slot, { slot, owner, accountHash: identity.accountHash, heartbeatAt: now });
			return { value: true, write: true };
		}, signal);
		if (!claimed) return undefined;

		const lock = (await this.state()).locks.get(slot);
		return owns(lock, slot, owner, identity.accountHash) ? owner : undefined;
	}

	private startHeartbeat(slot: number, owner: string, accountHash: string, signal: AbortSignal): void {
		const timer = setInterval(() => {
			void this.change((state) => {
				const lock = state.locks.get(slot);
				if (!lock || !owns(lock, slot, owner, accountHash)) return { value: false, write: false };
				state.locks.set(slot, { ...lock, heartbeatAt: Date.now() });
				return { value: true, write: true };
			}, signal).then((kept) => {
				if (!kept) this.stopHeartbeat(slot, owner);
			}).catch(() => this.stopHeartbeat(slot, owner));
		}, HEARTBEAT_MS);
		timer.unref?.();
		this.heartbeats.set(slot, { owner, timer });
	}

	private stopHeartbeat(slot: number, owner: string): void {
		const heartbeat = this.heartbeats.get(slot);
		if (!heartbeat || heartbeat.owner !== owner) return;
		clearInterval(heartbeat.timer);
		this.heartbeats.delete(slot);
	}

	private async stillOwn(slot: number, owner: string, accountHash: string): Promise<boolean> {
		return owns((await this.state()).locks.get(slot), slot, owner, accountHash);
	}

	private identityStillCurrent(slot: number, accountHash: string): boolean {
		return currentIdentity(slot)?.accountHash === accountHash;
	}

	private async finish(
		slot: number,
		owner: string,
		identity: SlotIdentity,
		outcome: ParsedUsage | undefined,
		refresh: QuotaRefresh,
	): Promise<boolean> {
		if (this.refreshContext !== refresh) return false;
		const finished = await this.change((state) => {
			if (this.refreshContext !== refresh || !this.identityStillCurrent(slot, identity.accountHash)) {
				return { value: false, write: false };
			}
			const lock = state.locks.get(slot);
			if (!owns(lock, slot, owner, identity.accountHash)) return { value: false, write: false };
			const previous = state.slots.get(slot);
			const checkedAt = Date.now();
			if (outcome && outcome.reset > checkedAt) {
				state.slots.set(slot, {
					slot,
					accountHash: identity.accountHash,
					...(outcome.tier ? { tier: outcome.tier } : {}),
					checkedAt,
					fetchedAt: checkedAt,
					remaining: outcome.remaining,
					reset: outcome.reset,
					...(outcome.fiveHourReset && outcome.fiveHourReset > checkedAt ? { fiveHourReset: outcome.fiveHourReset } : {}),
					limitedUntil: outcome.limitedUntil && outcome.limitedUntil > checkedAt ? outcome.limitedUntil : null,
				});
			} else {
				state.slots.set(slot, previous?.accountHash === identity.accountHash && (!validTime(previous.reset) || previous.reset > checkedAt)
					? { ...previous, checkedAt }
					: { slot, accountHash: identity.accountHash, checkedAt });
			}
			state.locks.delete(slot);
			return { value: true, write: true };
		}, refresh.session.signal);
		if (finished) this.onChange();
		return finished ?? false;
	}

	private async release(slot: number, owner: string, signal: AbortSignal): Promise<void> {
		await this.change((state) => {
			const lock = state.locks.get(slot);
			if (!lock || lock.owner !== owner) return { value: undefined, write: false };
			state.locks.delete(slot);
			return { value: undefined, write: true };
		}, signal);
	}

	private async refreshSlot(slot: number, identity: SlotIdentity, refresh: QuotaRefresh): Promise<void> {
		let owner: string | undefined;
		let discard = false;
		try {
			owner = await this.claim(slot, identity, refresh.session.signal);
			if (!owner || this.refreshContext !== refresh) return;
			this.startHeartbeat(slot, owner, identity.accountHash, refresh.session.signal);

			const authSignal = AbortSignal.any([refresh.session.signal, AbortSignal.timeout(OPERATION_TIMEOUT_MS)]);
			const apiKey = await raceWithSignal(refresh.resolveSlotAuth(slot), authSignal);
			if (!apiKey) throw new Error("Codex OAuth auth did not provide a bearer token.");
			if (this.refreshContext !== refresh || !this.identityStillCurrent(slot, identity.accountHash) || !(await this.stillOwn(slot, owner, identity.accountHash))) {
				discard = true;
				return;
			}

			const fetchSignal = AbortSignal.any([refresh.session.signal, AbortSignal.timeout(OPERATION_TIMEOUT_MS)]);
			const response = await fetch(USAGE_URL, {
				headers: {
					Authorization: `Bearer ${apiKey}`,
					"ChatGPT-Account-Id": identity.accountId,
				},
				signal: fetchSignal,
			});
			if (!response.ok) throw new Error(`Codex usage request failed (${response.status}).`);
			const usage = parseCodexUsage(await raceWithSignal(response.json(), fetchSignal));
			if (!usage) throw new Error("Codex usage response has no usable seven-day window.");
			if (!this.identityStillCurrent(slot, identity.accountHash) || !(await this.stillOwn(slot, owner, identity.accountHash))) {
				discard = true;
				return;
			}
			await this.finish(slot, owner, identity, usage, refresh);
		} catch {
			if (!refresh.session.signal.aborted && !discard && owner) await this.finish(slot, owner, identity, undefined, refresh);
		} finally {
			if (owner) {
				this.stopHeartbeat(slot, owner);
				await this.release(slot, owner, refresh.session.signal.aborted ? AbortSignal.timeout(CLEANUP_TIMEOUT_MS) : refresh.session.signal).catch(() => undefined);
			}
		}
	}

	async statusLines(): Promise<string[]> {
		const credentials = credentialMap();
		const state = await this.state();
		const now = Date.now();
		return [...credentials.entries()]
			.sort(([left], [right]) => left - right)
			.map(([slot, credential]) => {
				const identity = identityFor(credential);
				const snapshot = state.slots.get(slot);
				if (!identity || !snapshot || snapshot.accountHash !== identity.accountHash || !validTime(snapshot.fetchedAt) || typeof snapshot.remaining !== "number" || !validTime(snapshot.reset)) {
					return `Codex slot ${slot}: unavailable`;
				}
				const tier = snapshot.tier ? ` (${snapshot.tier})` : "";
				const status = isFresh(snapshot, identity, now) ? "measured" : "stale";
				if (isFiveHourLimited(snapshot, now)) {
					return `Codex slot ${slot}${tier}: five-hour limit reached, resets in ${formatDuration(snapshot.limitedUntil! - now)} (${status})`;
				}
				const display = displayedReset(snapshot, now);
				const resetWindow = display.label === "5h" ? "five-hour" : "seven-day";
				return `Codex slot ${slot}${tier}: ${formatPercent(snapshot.remaining)}% of the seven-day quota remaining; ${resetWindow} reset in ${formatDuration(display.time - now)} (${status})`;
			});
	}
}

function isManagedProvider(provider: string | undefined): boolean {
	return provider === NATIVE_PROVIDER_ID;
}

function sessionHasAgentWork(ctx: ExtensionContext): boolean {
	return ctx.sessionManager?.getBranch?.().some((entry) =>
		entry.type === "message" || (entry.type === "custom" && entry.customType === AGENT_STARTED_ENTRY),
	) ?? false;
}

export default function multiCodex(pi: ExtensionAPI): void {
	const native = builtinProviders().find((provider) => provider.id === NATIVE_PROVIDER_ID) as CodexProvider | undefined;
	const oauth = native?.auth.oauth;
	if (!native || !oauth) return;
	const quota = new CodexQuotaStatus();
	const configStore = createConfigStore<Config>({
		extensionId: "pi-multi-codex",
		defaults: () => ({ autoSwitchOn429: true }),
		parse: parseConfig,
	});
	const triedSlots = new Set<number>();
	let sessionContext: ExtensionContext | undefined;
	let automaticOpen = false;
	let automaticIndex: number | undefined;
	let preserveModelChoice = false;
	let autoSwitchOn429 = true;
	let configWarned = false;
	let providerRequest: { provider?: string; model?: string; index?: number; status?: number } | undefined;

	pi.registerProvider(wrapCodexProvider(native));

	const allowsModel = (ctx: ExtensionContext, model: Model<any>): boolean => {
		const scopedModels = ctx.scopedModels ?? [];
		return scopedModels.length === 0 || scopedModels.some(({ model: scoped }) => scoped.provider === NATIVE_PROVIDER_ID && scoped.id === model.id);
	};

	const freshSlots = (ctx: ExtensionContext, model: Model<any>): { slot: number; remaining: number }[] => {
		if (!allowsModel(ctx, model)) return [];
		const state = loadStateSync();
		const now = Date.now();
		return [...credentialMap().entries()]
			.flatMap(([slot, credential]) => {
				const identity = identityFor(credential);
				const snapshot = state.slots.get(slot);
				if (!identity || !isFresh(snapshot, identity, now) || typeof snapshot?.remaining !== "number" || isFiveHourLimited(snapshot, now)) return [];
				return [{ slot, remaining: snapshot.remaining }];
			});
	};

	const selectFreshSlot = (ctx: ExtensionContext, model: Model<any>): number | undefined => {
		const candidates = freshSlots(ctx, model);
		if (candidates.length === 0) return undefined;
		const currentSlot = activeIndexSync();
		const remaining = Math.max(...candidates.map((candidate) => candidate.remaining));
		const tied = candidates.filter((candidate) => candidate.remaining === remaining);
		return tied.find((candidate) => candidate.slot === currentSlot)?.slot
			?? Math.min(...tied.map((candidate) => candidate.slot));
	};

	const failoverSlots = (ctx: ExtensionContext, model: Model<any>): number[] => {
		if (!allowsModel(ctx, model)) return [];
		const state = loadStateSync();
		const now = Date.now();
		return [...credentialMap().entries()]
			.flatMap(([slot, credential]) => {
				if (triedSlots.has(slot)) return [];
				const identity = identityFor(credential);
				const snapshot = state.slots.get(slot);
				if (identity && snapshot?.accountHash === identity.accountHash && isFiveHourLimited(snapshot, now)) return [];
				const remaining = identity && isFresh(snapshot, identity, now) ? snapshot?.remaining : undefined;
				return [{ slot, remaining }];
			})
			.sort((left, right) => (right.remaining ?? -1) - (left.remaining ?? -1) || left.slot - right.slot)
			.map(({ slot }) => slot);
	};

	const setActiveIndex = async (index: number): Promise<boolean> => {
		await ensureMigrated();
		return await mutateVault((vault) => {
			const account = vault.accounts.find((candidate) => candidate.index === index && candidate.credential);
			if (!account) return false;
			if (vault.activeAccountId === account.id) return false;
			vault.activeAccountId = account.id;
			return true;
		}) ?? false;
	};

	const footerText = (ctx: ExtensionContext): string | undefined => {
		const model = ctx.model;
		const slot = activeIndexSync();
		if (!model || !isManagedProvider(model.provider) || !slot) return undefined;
		const identity = currentIdentity(slot);
		const snapshot = quota.snapshot(slot);
		const prefix = `Codex #${slot}`;
		if (!identity || !snapshot || snapshot.accountHash !== identity.accountHash || !validTime(snapshot.fetchedAt) || typeof snapshot.remaining !== "number" || !validTime(snapshot.reset)) {
			return `${prefix} · unavailable`;
		}
		const now = Date.now();
		if (isFiveHourLimited(snapshot, now)) {
			const text = `${prefix} · 5h limit · ${formatDuration(snapshot.limitedUntil! - now)}`;
			return ctx.ui.theme?.fg ? ctx.ui.theme.fg("error", text) : text;
		}
		if (!isFresh(snapshot, identity, now)) return `${prefix} · stale`;
		const display = displayedReset(snapshot, now);
		const text = `${prefix} · ${formatPercent(snapshot.remaining)}% · ${display.label} ${formatDuration(display.time - now)}`;
		const color = snapshot.remaining >= 50 ? "success" : snapshot.remaining >= 25 ? "warning" : "error";
		return ctx.ui.theme?.fg ? ctx.ui.theme.fg(color, text) : text;
	};

	const updateFooter = (ctx: ExtensionContext | undefined = sessionContext): void => {
		if (ctx) ctx.ui.setStatus?.("pi-multi-codex", footerText(ctx));
	};

	const updatePendingCandidate = (ctx: ExtensionContext): void => {
		if (!ctx.model || !isManagedProvider(ctx.model.provider)) return;
		automaticIndex = selectFreshSlot(ctx, ctx.model);
	};

	quota.setOnChange(() => {
		if (!sessionContext) return;
		updatePendingCandidate(sessionContext);
		updateFooter();
	});

	pi.on("session_start", async (_event, ctx) => {
		await ensureMigrated();
		sessionContext = ctx;
		triedSlots.clear();
		providerRequest = undefined;
		preserveModelChoice = false;
		try {
			autoSwitchOn429 = configStore.loadSync().value.autoSwitchOn429;
		} catch {
			autoSwitchOn429 = false;
			if (!configWarned) {
				configWarned = true;
				ctx.ui.notify("Pi Multi Codex config is invalid. Automatic 429 switching is disabled; the file was left unchanged.", "warning");
			}
		}
		automaticOpen = isManagedProvider(ctx.model?.provider) && !sessionHasAgentWork(ctx);
		automaticIndex = activeIndexSync();
		updatePendingCandidate(ctx);
		updateFooter(ctx);
		quota.start(async (slot) => {
			await ensureMigrated();
			const account = loadVaultSync().accounts.find((candidate) => candidate.index === slot);
			if (!account) return undefined;
			const credential = await resolveAccountCredential(oauth, account.id);
			if (!credential) return undefined;
			return (await oauth.toAuth(credential)).apiKey;
		});
		if (credentialMap().size === 0) ctx.ui.notify(NO_ACCOUNTS_MESSAGE, "warning");
	});

	pi.on("before_agent_start", async (_event, ctx) => {
		triedSlots.clear();
		providerRequest = undefined;
		const model = ctx.model;
		const slot = activeIndexSync();
		const identity = slot ? currentIdentity(slot) : undefined;
		const snapshot = slot ? quota.snapshot(slot) : undefined;
		if (!automaticOpen && (preserveModelChoice || !identity || snapshot?.accountHash !== identity.accountHash || !isFiveHourLimited(snapshot, Date.now()))) return;
		updatePendingCandidate(ctx);
		automaticOpen = false;
		const candidate = automaticIndex;
		if (!model || candidate === undefined || !isManagedProvider(model.provider) || candidate === activeIndexSync()) return;
		await setActiveIndex(candidate);
		updateFooter(ctx);
	});

	pi.on("before_provider_request", (_event, ctx) => {
		providerRequest = { provider: ctx.model?.provider, model: ctx.model?.id, index: activeIndexSync() };
	});
	pi.on("after_provider_response", (event) => {
		if (providerRequest) providerRequest.status = event.status;
	});
	pi.on("message_end", async (event, ctx) => {
		const request = providerRequest;
		providerRequest = undefined;
		if (
			!autoSwitchOn429
			|| request?.status !== 429
			|| event.message.role !== "assistant"
			|| event.message.stopReason !== "error"
		) return;
		const model = ctx.model;
		const failedSlot = request.index;
		if (
			!model
			|| !failedSlot
			|| request.provider !== NATIVE_PROVIDER_ID
			|| event.message.provider !== NATIVE_PROVIDER_ID
			|| model.provider !== NATIVE_PROVIDER_ID
			|| request.model !== model.id
			|| model.id !== event.message.model
		) return;

		triedSlots.add(failedSlot);
		for (const slot of failoverSlots(ctx, model)) {
			if (!await setActiveIndex(slot)) continue;
			ctx.ui.notify(`Codex #${failedSlot} returned HTTP 429. Retrying with Codex #${slot}.`, "warning");
			updateFooter(ctx);
			return { message: { ...event.message, errorMessage: "HTTP 429: Codex account switched; retry the request with the active account." } };
		}

		return {
			message: {
				...event.message,
				errorMessage: "Codex quota exceeded: all eligible account slots returned HTTP 429; automatic failover stopped.",
			},
		};
	});

	pi.on("agent_start", (_event, ctx) => {
		automaticOpen = false;
		preserveModelChoice = false;
		if (!sessionHasAgentWork(ctx)) pi.appendEntry(AGENT_STARTED_ENTRY);
	});
	pi.on("agent_settled", () => {
		triedSlots.clear();
		providerRequest = undefined;
	});
	pi.on("session_shutdown", () => {
		automaticOpen = false;
		sessionContext = undefined;
		triedSlots.clear();
		providerRequest = undefined;
		quota.stop();
	});
	pi.on("model_select", (_event, ctx) => {
		quota.requestRefresh();
		updateFooter(ctx);
	});

	pi.registerCommand("codex-add", {
		description: "enroll another OpenAI Codex OAuth account",
		handler: async (_args, ctx) => {
			await ensureMigrated();
			const index = await mutateVault((vault) => {
				if (vault.pendingAccountId) {
					const pending = vault.accounts.find((account) => account.id === vault.pendingAccountId);
					if (pending) return pending.index;
				}
				const id = randomUUID();
				const created = nextIndex(vault);
				vault.accounts.push({ id, index: created, revision: 0 });
				vault.pendingAccountId = id;
				return created;
			});
			if (index === undefined) {
				ctx.ui.notify("Codex account vault is invalid. The file was left unchanged.", "warning");
				return;
			}
			ctx.ui.notify(`Codex account ${index} ready. Run /login and select OpenAI Codex.`, "info");
		},
	});

	pi.registerCommand("codex-status", {
		description: "show shared Codex quota status",
		handler: async (_args, ctx: ExtensionContext) => {
			await ensureMigrated();
			const lines = await quota.statusLines();
			ctx.ui.notify(lines.length ? lines.join("\n") : NO_ACCOUNTS_MESSAGE, "info");
		},
	});

	pi.registerCommand("codex-switch", {
		description: "switch the active Codex account",
		handler: async (_args, ctx) => {
			await ensureMigrated();
			const accounts = loadVaultSync().accounts
				.filter((account) => account.credential)
				.sort((left, right) => left.index - right.index);
			if (accounts.length === 0) {
				ctx.ui.notify("No authenticated Codex accounts found. Run /login and select OpenAI Codex.", "warning");
				return;
			}

			const now = Date.now();
			const choices = accounts.map((account) => {
				const identity = identityFor(account.credential);
				const snapshot = quota.snapshot(account.index);
				const prefix = `Codex #${account.index}`;
				if (!identity || !snapshot || snapshot.accountHash !== identity.accountHash || !validTime(snapshot.fetchedAt) || typeof snapshot.remaining !== "number" || !validTime(snapshot.reset)) {
					return `${prefix} · quota unavailable`;
				}
				const freshness = isFresh(snapshot, identity, now) ? "" : " · stale";
				if (isFiveHourLimited(snapshot, now)) {
					return `${prefix} · 5h limit · resets in ${formatDuration(snapshot.limitedUntil! - now)}${freshness}`;
				}
				const display = displayedReset(snapshot, now);
				return `${prefix} · ${formatPercent(snapshot.remaining)}% · ${display.label} reset in ${formatDuration(display.time - now)}${freshness}`;
			});
			const selected = await ctx.ui.select("Switch Codex account", choices);
			const index = selected ? choices.indexOf(selected) : -1;
			if (index < 0) return;
			const account = accounts[index];
			try {
				if (!await resolveAccountCredential(oauth, account.id)) {
					ctx.ui.notify(`Codex #${account.index} has no usable credential.`, "warning");
					return;
				}
			} catch {
				ctx.ui.notify(`Could not refresh Codex #${account.index}. Try /login and select OpenAI Codex.`, "warning");
				return;
			}
			automaticOpen = false;
			preserveModelChoice = true;
			await setActiveIndex(account.index);
			updateFooter(ctx);
		},
	});
}
