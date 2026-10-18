import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { createRequire, findPackageJSON } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const sdkPackage = findPackageJSON("@earendil-works/pi-coding-agent", import.meta.url)!;
const { createJiti } = createRequire(sdkPackage)("jiti");
const extensionPath = fileURLToPath(new URL("../extensions/multi-codex.ts", import.meta.url));

async function loadFixture(mode: "host" | "virtual" | "broken" | "no-resolver", check: (providers: any[], fallbackLoaded: () => Promise<boolean>) => Promise<void>) {
	const root = await mkdtemp(join(tmpdir(), "multi-codex-provider-"));
	try {
		await writeFile(join(root, "package.json"), '{"type":"module"}');
		const sdkEntry = join(root, "sdk.js");
		await writeFile(sdkEntry, `export const getPackageDir = () => ${JSON.stringify(root)}; export const getAgentDir = () => ${JSON.stringify(join(root, "agent"))};`);
		const provider = (id: string) => `({id:"openai-codex",baseUrl:"https://example.invalid",auth:{oauth:{name:"fixture"}},getModels:()=>[{id:${JSON.stringify(id)}}]})`;
		const marker = join(root, "fallback-loaded");
		const fallback = join(root, "fallback.js");
		await writeFile(fallback, `import {writeFileSync} from "node:fs"; writeFileSync(${JSON.stringify(marker)}, "loaded"); export const builtinProviders = () => [${provider("virtual-model")}];`);
		if (mode !== "virtual") {
			const packageDir = join(root, "node_modules/@earendil-works/pi-ai");
			await mkdir(join(packageDir, "dist/providers"), { recursive: true });
			await writeFile(join(packageDir, "package.json"), JSON.stringify({ type: "module", exports: { "./providers/*": { import: "./dist/providers/*.js" } } }));
			await writeFile(join(packageDir, "dist/providers/openai-codex.js"), mode === "broken" ? 'throw new Error("broken host provider");' : `export const openaiCodexProvider = () => ${provider("host-model")};`);
		}
		const aliases: Record<string, string> = {
			"@earendil-works/pi-coding-agent": sdkEntry,
			"@earendil-works/pi-ai/providers/all": fallback,
			"@henryqw/pi-config-store": fileURLToPath(import.meta.resolve("@henryqw/pi-config-store")),
			"proper-lockfile": fileURLToPath(import.meta.resolve("proper-lockfile")),
		};
		let sourceEntry = extensionPath;
		if (mode === "no-resolver") {
			// Jiti always resolves Node built-ins natively, so inject the missing capability via a fixture import.
			const moduleEntry = join(root, "node-module.js");
			await writeFile(moduleEntry, "export const findPackageJSON = undefined;");
			const source = await readFile(extensionPath, "utf8");
			const importLine = 'import * as nodeModule from "node:module";';
			assert.ok(source.includes(importLine));
			sourceEntry = join(root, "extension.ts");
			await writeFile(sourceEntry, source.replace(importLine, `import * as nodeModule from ${JSON.stringify(moduleEntry)};`));
		}
		const jiti = createJiti(import.meta.url, { moduleCache: false, alias: aliases });
		const factory = await jiti.import(sourceEntry, { default: true }) as (api: ExtensionAPI) => Promise<void>;
		const providers: any[] = [];
		const pending = factory({ on() {}, registerCommand() {}, registerProvider(provider: any) { providers.push(provider); } } as unknown as ExtensionAPI);
		if (mode === "broken") await assert.rejects(pending, /broken host provider/);
		else await pending;
		await check(providers, async () => {
			try { await readFile(marker); return true; }
			catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return false; throw error; }
		});
	} finally {
		await rm(root, { recursive: true, force: true });
	}
}

test("loads only the host Codex provider, not the all-provider fallback", async () => {
	await loadFixture("host", async (providers, fallbackLoaded) => {
		assert.equal(providers.length, 1);
		assert.deepEqual(providers[0].getModels(), [{ id: "host-model" }]);
		assert.equal(await fallbackLoaded(), false);
	});
});

test("uses the virtual provider when host package files are unavailable", async () => {
	await loadFixture("virtual", async (providers, fallbackLoaded) => {
		assert.equal(providers.length, 1);
		assert.deepEqual(providers[0].getModels(), [{ id: "virtual-model" }]);
		assert.equal(await fallbackLoaded(), true);
	});
});

test("does not hide a broken host provider by silently loading another catalog", async () => {
	await loadFixture("broken", async (providers, fallbackLoaded) => {
		assert.equal(providers.length, 0);
		assert.equal(await fallbackLoaded(), false);
	});
});

test("uses the virtual provider when the runtime has no package locator", async () => {
	await loadFixture("no-resolver", async (providers, fallbackLoaded) => {
		assert.equal(providers.length, 1);
		assert.deepEqual(providers[0].getModels(), [{ id: "virtual-model" }]);
		assert.equal(await fallbackLoaded(), true);
	});
});
