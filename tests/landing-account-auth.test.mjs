import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import test, { after } from "node:test";
import { build } from "esbuild";

const project = join(dirname(fileURLToPath(import.meta.url)), "..");
const directory = mkdtempSync(join(project, "node_modules", "landing-account-test-"));
after(() => rmSync(directory, { recursive: true, force: true }));

const mocks = {
	"next/navigation": 'export function redirect(path) { throw new Error(path); }',
	"@/lib/auth/setup": 'export async function hasAdminAccount() { return globalThis.__landingSetup; }',
	"@/lib/auth/cookies": 'export async function getCurrentUser() { return globalThis.__landingGetUser(); }',
	"@/lib/cloudflare": 'export function getEnv() { return {}; }',
	"@/components/auth/auth-guard": 'export function AuthGuard() {}',
	"./(auth)/login/login-client": 'export function LoginClient() {}',
	"./home-server-utils": 'export async function getHomeBranding() { return { appName: "Test Mail", hasCustomIcon: true }; }',
};

await build({
	entryPoints: [join(project, "src/app/page.tsx")],
	outfile: join(directory, "home.mjs"),
	bundle: true,
	platform: "node",
	format: "esm",
	packages: "external",
	jsx: "automatic",
	logLevel: "silent",
	plugins: [{
		name: "landing-account-mocks",
		setup(builder) {
			builder.onResolve({ filter: /.*/ }, ({ path }) => Object.hasOwn(mocks, path) ? { path, namespace: "mock" } : undefined);
			builder.onLoad({ filter: /.*/, namespace: "mock" }, ({ path }) => ({ contents: mocks[path] }));
		},
	}],
});
const { default: home, generateMetadata } = await import(pathToFileURL(join(directory, "home.mjs")).href);
after(() => {
	delete globalThis.__landingSetup;
	delete globalThis.__landingGetUser;
});

test("the home page sends fresh installations to setup before looking up a session", async () => {
	globalThis.__landingSetup = false;
	globalThis.__landingGetUser = () => assert.fail("unexpected session lookup");
	await assert.rejects(home(), /^Error: \/setup$/);
});

test("a signed-in visitor opens their inbox", async () => {
	globalThis.__landingSetup = true;
	globalThis.__landingGetUser = () => ({ id: "example" });
	await assert.rejects(home(), /^Error: \/inbox$/);
});

test("the public home page shows the centered sign-in form, including after a failed session lookup", async () => {
	globalThis.__landingSetup = true;
	for (const lookup of [() => null, () => { throw new Error("session service unavailable"); }]) {
		globalThis.__landingGetUser = lookup;
		const view = await home();
		assert.equal(view.props.mode, "public");
		assert.equal(view.props.children.props.centered, true);
	}
	assert.deepEqual(await generateMetadata(), { title: "Test Mail", icons: { icon: "/api/branding/icon" } });
});
