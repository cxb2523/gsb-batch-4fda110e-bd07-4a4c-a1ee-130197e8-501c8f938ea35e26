import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Project } from "ts-morph";
import ts from "typescript";
import { patchBrowserContext } from "../client_patches/browserContextPatch.ts";
import { getInjectRouteStatus, type InjectRouteTarget } from "../client_patches/injectRouteStatus.ts";
import { patchPage } from "../client_patches/pagePatch.ts";
import * as packageEntry from "../index.ts";

const PAGE_SOURCE_PATH = "packages/playwright-core/src/client/page.ts";
const CONTEXT_SOURCE_PATH = "packages/playwright-core/src/client/browserContext.ts";

// Minimal stubs standing in for the real Playwright client classes. They only need the
// shape that patchPage / patchBrowserContext navigate; route() is controllable so success,
// failure and retry can be driven deterministically. Written as plain JS so the transpiled
// output needs no Playwright runtime.
const PAGE_STUB = `
function assertMaxArguments(callable, count) {
	if (callable === undefined || count === undefined) throw new Error("assertMaxArguments");
}

class Page {
	routeCalls = 0;
	lastRouteUrl;
	#routeBehavior;
	#contextState;

	constructor(options) {
		this.#routeBehavior = options?.routeBehavior;
		this.#contextState = options?.contextState ?? { routeInjecting: false, injectRouteError: undefined };
	}

	context() {
		return this.#contextState;
	}

	async route(url, handler) {
		this.routeCalls++;
		this.lastRouteUrl = url;
		if (this.#routeBehavior) await this.#routeBehavior(handler);
	}

	async addInitScript() {}
	async exposeBinding() {}
	async exposeFunction() {}

	async evaluate(pageFunction, arg) {
		assertMaxArguments(pageFunction, 2);
		return this._mainFrame.evaluate(pageFunction, arg);
	}

	async evaluateHandle(pageFunction, arg) {
		assertMaxArguments(pageFunction, 2);
		return this._mainFrame.evaluateHandle(pageFunction, arg);
	}

	_mainFrame = {
		evaluate(...args) {
			return args;
		},
		evaluateHandle(...args) {
			return args;
		},
	};
}

module.exports = { Page };
`;

const CONTEXT_STUB = `
class BrowserContext {
	routeCalls = 0;
	lastRouteUrl;
	#routeBehavior;

	constructor(options) {
		this.#routeBehavior = options?.routeBehavior;
	}

	async route(url, handler) {
		this.routeCalls++;
		this.lastRouteUrl = url;
		if (this.#routeBehavior) await this.#routeBehavior(handler);
	}

	async addInitScript() {}
	async exposeBinding() {}
	async exposeFunction() {}
}

module.exports = { BrowserContext };
`;

type RouteBehavior = (handler: unknown) => Promise<void> | void;

type PatchedRouteTarget = InjectRouteTarget & {
	routeCalls: number;
	lastRouteUrl: string | undefined;
	installInjectRoute: () => Promise<void>;
	addInitScript: () => Promise<void>;
	exposeBinding: () => Promise<void>;
	exposeFunction: () => Promise<void>;
	context: () => InjectRouteTarget;
};

type PatchedCtor = new (options?: {
	routeBehavior?: RouteBehavior;
	contextState?: InjectRouteTarget;
}) => PatchedRouteTarget;

async function buildPatchedClasses(): Promise<{ Page: PatchedCtor; BrowserContext: PatchedCtor }> {
	const project = new Project({ useInMemoryFileSystem: true });
	project.createSourceFile(PAGE_SOURCE_PATH, PAGE_STUB);
	project.createSourceFile(CONTEXT_SOURCE_PATH, CONTEXT_STUB);

	patchPage(project);
	patchBrowserContext(project);

	const dir = await mkdtemp(join(tmpdir(), "patchright-inject-route-test-"));
	const require = createRequire(import.meta.url);
	try {
		const loaded: Record<string, PatchedCtor> = {};
		for (const [exportName, virtualPath] of [
			["Page", PAGE_SOURCE_PATH],
			["BrowserContext", CONTEXT_SOURCE_PATH],
		] as const) {
			const patchedSource = project.getSourceFileOrThrow(virtualPath).getFullText();
			const transpiled = ts.transpileModule(patchedSource, {
				compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
			});
			const fileName = join(dir, `${exportName}.cjs`);
			await writeFile(fileName, transpiled.outputText);
			loaded[exportName] = require(fileName)[exportName] as PatchedCtor;
		}
		return { Page: loaded.Page, BrowserContext: loaded.BrowserContext };
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
}

const tests: Array<[string, () => void | Promise<void>]> = [];
function test(name: string, fn: () => void | Promise<void>) {
	tests.push([name, fn]);
}

const { Page, BrowserContext } = await buildPatchedClasses();
const succeed: RouteBehavior = () => undefined;
const failWith = (message: string): RouteBehavior => () => {
	throw new Error(message);
};
const failWithString: RouteBehavior = () => {
	throw "string failure";
};

// ---------- BrowserContext ----------

test("BrowserContext: never attempted reports uninstalled without error", () => {
	const context = new BrowserContext();
	assert.deepEqual(getInjectRouteStatus(context), { installed: false, lastError: undefined });
});

test("BrowserContext: successful installation marks installed and registers the route once", async () => {
	const context = new BrowserContext({ routeBehavior: succeed });
	await context.installInjectRoute();
	assert.equal(context.routeCalls, 1);
	assert.equal(context.lastRouteUrl, "**/*");
	assert.deepEqual(getInjectRouteStatus(context), { installed: true, lastError: undefined });
});

test("BrowserContext: failed installation stays uninstalled, keeps the error and allows a successful retry", async () => {
	let shouldFail = true;
	const context = new BrowserContext({
		routeBehavior: () => {
			if (shouldFail) throw new Error("register boom");
		},
	});

	await assert.rejects(() => context.installInjectRoute(), /register boom/);
	assert.equal(context.routeCalls, 1);
	assert.deepEqual(getInjectRouteStatus(context), { installed: false, lastError: "register boom" });

	shouldFail = false;
	await context.installInjectRoute();
	assert.equal(context.routeCalls, 2);
	assert.deepEqual(getInjectRouteStatus(context), { installed: true, lastError: undefined });
});

test("BrowserContext: repeated calls after success return early without registering again", async () => {
	const context = new BrowserContext({ routeBehavior: succeed });
	await context.installInjectRoute();
	await context.installInjectRoute();
	await context.installInjectRoute();
	assert.equal(context.routeCalls, 1);
	assert.equal(getInjectRouteStatus(context).installed, true);
});

test("BrowserContext: non-Error failures are coerced into an error message", async () => {
	const context = new BrowserContext({ routeBehavior: failWithString });
	await assert.rejects(() => context.installInjectRoute());
	assert.deepEqual(getInjectRouteStatus(context), { installed: false, lastError: "string failure" });
});

// ---------- Page ----------

test("Page: never attempted reports uninstalled without error", () => {
	const page = new Page();
	assert.deepEqual(getInjectRouteStatus(page), { installed: false, lastError: undefined });
});

test("Page: successful installation marks installed and registers the route once", async () => {
	const page = new Page({ routeBehavior: succeed });
	await page.installInjectRoute();
	assert.equal(page.routeCalls, 1);
	assert.equal(page.lastRouteUrl, "**/*");
	assert.deepEqual(getInjectRouteStatus(page), { installed: true, lastError: undefined });
});

test("Page: failed installation stays uninstalled, keeps the error and allows a successful retry", async () => {
	let shouldFail = true;
	const page = new Page({
		routeBehavior: () => {
			if (shouldFail) throw new Error("page register boom");
		},
	});

	await assert.rejects(() => page.installInjectRoute(), /page register boom/);
	assert.equal(page.routeCalls, 1);
	assert.deepEqual(getInjectRouteStatus(page), { installed: false, lastError: "page register boom" });

	shouldFail = false;
	await page.installInjectRoute();
	assert.equal(page.routeCalls, 2);
	assert.deepEqual(getInjectRouteStatus(page), { installed: true, lastError: undefined });
});

test("Page: repeated calls after success return early without registering again", async () => {
	const page = new Page({ routeBehavior: succeed });
	await page.installInjectRoute();
	await page.installInjectRoute();
	assert.equal(page.routeCalls, 1);
});

test("Page: skips registration when the page itself is already installed", async () => {
	const page = new Page({ routeBehavior: succeed });
	page.routeInjecting = true;
	await page.installInjectRoute();
	assert.equal(page.routeCalls, 0);
	assert.equal(getInjectRouteStatus(page).installed, true);
});

test("Page: skips registration when the owning context is already installed", async () => {
	const page = new Page({
		routeBehavior: succeed,
		contextState: { routeInjecting: true, injectRouteError: undefined },
	});
	await page.installInjectRoute();
	assert.equal(page.routeCalls, 0);
	assert.equal(getInjectRouteStatus(page).installed, false);
});

test("Page: addInitScript triggers the installation through the patched method body", async () => {
	const page = new Page({ routeBehavior: succeed });
	await page.addInitScript();
	assert.equal(page.routeCalls, 1);
	assert.deepEqual(getInjectRouteStatus(page), { installed: true, lastError: undefined });
});

test("Page: addInitScript propagates a failed installation and remains retryable", async () => {
	const page = new Page({ routeBehavior: failWith("addInitScript boom") });
	await assert.rejects(() => page.addInitScript(), /addInitScript boom/);
	assert.deepEqual(getInjectRouteStatus(page), { installed: false, lastError: "addInitScript boom" });
});

test("query entry point is re-exported from the package index", () => {
	assert.equal(typeof packageEntry.getInjectRouteStatus, "function");
});

let failures = 0;
for (const [name, fn] of tests) {
	try {
		await fn();
		console.log(`ok - ${name}`);
	} catch (error) {
		failures++;
		console.error(`not ok - ${name}`);
		console.error(error);
	}
}

if (failures > 0) {
	console.error(`\n${failures}/${tests.length} tests failed`);
	process.exitCode = 1;
} else {
	console.log(`\nAll ${tests.length} tests passed`);
}
