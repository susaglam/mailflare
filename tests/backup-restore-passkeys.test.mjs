import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";
import Database from "better-sqlite3";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const outDir = join(root, "node_modules", ".cache", "backup-restore-passkeys");
const outfile = join(outDir, "backup.mjs");
await build({
	stdin: {
		contents: 'export * from "./src/lib/backups/export";',
		resolveDir: root,
		loader: "ts",
	},
	outfile,
	bundle: true,
	platform: "node",
	format: "esm",
	target: "node22",
	logLevel: "silent",
	alias: { "@": join(root, "src") },
	banner: { js: 'import { createRequire } from "node:module"; const require = createRequire(import.meta.url);' },
});
const { exportDatabaseRecords, restoreDatabaseRecords } = await import(pathToFileURL(outfile).href);
const { migrations } = JSON.parse(readFileSync(join(root, "src/lib/migrations/bundle.json"), "utf8"));

function d1(sqlite) {
	const prepare = (sql) => {
		const statement = {
			values: [],
			bind(...values) {
				statement.values = values;
				return statement;
			},
			async all() {
				return { results: sqlite.prepare(sql).all(...statement.values), success: true, meta: {} };
			},
			async run() {
				const result = sqlite.prepare(sql).run(...statement.values);
				return { results: [], success: true, meta: { changes: result.changes } };
			},
			async first() {
				return sqlite.prepare(sql).get(...statement.values) ?? null;
			},
		};
		return statement;
	};
	return {
		prepare,
		async batch(statements) {
			return Promise.all(statements.map((statement) => statement.run()));
		},
	};
}

function database(stopBefore) {
	const sqlite = new Database(":memory:");
	sqlite.pragma("foreign_keys = ON");
	for (const migration of migrations) {
		if (migration.name === stopBefore) break;
		for (const statement of migration.statements) sqlite.exec(statement);
	}
	return sqlite;
}

function addUser(sqlite) {
	sqlite.prepare(
		`INSERT INTO users (
			id, email, password_hash, name, role, is_primary_admin, disabled, can_manage_mailboxes,
			can_manage_domains, can_manage_users, keyboard_shortcuts_enabled, spam_protection_enabled,
			show_full_recipient_addresses, remote_content_mode, require_second_factor, totp_enabled, created_at
		) VALUES ('u1', 'u1@example.test', '!passkey-only', 'User', 'user', 0, 0, 0, 0, 0, 1, 1, 0, 'allow', 0, 0, 1)`,
	).run();
	sqlite.prepare(
		`INSERT INTO passkey_credentials (id, user_id, credential_id, credential_hash, public_key, counter, device_type, backed_up, name, created_at)
		 VALUES ('p1', 'u1', 'c1', 'h1', 'key', 0, 'singleDevice', 0, 'Test', 1)`,
	).run();
}

test("a backup with a passwordless passkey restores without tripping the last-method guard", async () => {
	const sqlite = database();
	addUser(sqlite);
	const databaseHandle = d1(sqlite);
	const backup = await exportDatabaseRecords(databaseHandle);
	assert.equal(sqlite.prepare("SELECT passkey_count FROM users WHERE id = 'u1'").get().passkey_count, 1);

	await restoreDatabaseRecords(databaseHandle, backup.buffer.slice(backup.byteOffset, backup.byteOffset + backup.byteLength));
	assert.equal(sqlite.prepare("SELECT COUNT(*) AS count FROM users").get().count, 1);
	assert.equal(sqlite.prepare("SELECT COUNT(*) AS count FROM passkey_credentials").get().count, 1);
	assert.equal(sqlite.prepare("SELECT passkey_count FROM users WHERE id = 'u1'").get().passkey_count, 1);
});

test("a newer backup restores into a database that has the passkey table but not the aaguid column", async () => {
	const source = database();
	addUser(source);
	source.prepare("UPDATE passkey_credentials SET aaguid = 'test-aaguid' WHERE id = 'p1'").run();
	const backup = await exportDatabaseRecords(d1(source));

	// Simulates an installation whose passkey table predates the aaguid column.
	const target = database();
	target.exec("ALTER TABLE passkey_credentials DROP COLUMN aaguid");
	await restoreDatabaseRecords(d1(target), backup.buffer.slice(backup.byteOffset, backup.byteOffset + backup.byteLength));
	assert.equal(target.prepare("SELECT COUNT(*) AS count FROM passkey_credentials").get().count, 1);
	assert.equal(target.prepare("PRAGMA table_info(passkey_credentials)").all().some((column) => column.name === "aaguid"), false);
});

test("calendar backups restore before and after the invite migration and protect an older target", async (t) => {
	const before = database("0090_calendar_invite_complete.sql");
	const after = database();
	t.after(() => { before.close(); after.close(); });
	addUser(before);
	before.exec("INSERT INTO calendar_events (id, user_id, title, starts_at, ends_at, created_at, updated_at) VALUES ('event', 'u1', 'Meeting', 1, 2, 1, 1)");

	const legacy = JSON.parse(new TextDecoder().decode(await exportDatabaseRecords(d1(before))));
	for (const table of ["calendar_event_overrides", "calendar_occurrence_responses", "calendar_invite_tombstones"]) {
		assert.deepEqual(legacy.tables[table], []);
		// A backup written by the previous release does not mention the table.
		delete legacy.tables[table];
		legacy.includedTables = legacy.includedTables.filter((name) => name !== table);
	}
	const oldContent = new TextEncoder().encode(JSON.stringify(legacy)).buffer;
	await restoreDatabaseRecords(d1(before), oldContent);
	await restoreDatabaseRecords(d1(after), oldContent);
	assert.equal(after.prepare("SELECT repeat_interval FROM calendar_events").get().repeat_interval, 1);

	after.exec("UPDATE calendar_events SET repeat_interval = 3");
	const updated = await exportDatabaseRecords(d1(after));
	await assert.rejects(restoreDatabaseRecords(d1(before), updated.buffer), /Apply pending database migrations before restoring calendar_events/);
	assert.equal(before.prepare("SELECT title FROM calendar_events").get().title, "Meeting");

	after.exec("INSERT INTO calendar_event_overrides (id, event_id, occurrence_ms, starts_at, ends_at, created_at, updated_at) VALUES ('override', 'event', 1, 2, 3, 1, 1)");
	const withOverride = await exportDatabaseRecords(d1(after));
	await assert.rejects(restoreDatabaseRecords(d1(before), withOverride.buffer), /before restoring calendar_event_overrides/);
	await restoreDatabaseRecords(d1(after), withOverride.buffer);
	assert.equal(after.prepare("SELECT event_id FROM calendar_event_overrides").get().event_id, "event");
	assert.equal(after.prepare("SELECT repeat_interval FROM calendar_events").get().repeat_interval, 3);
});
