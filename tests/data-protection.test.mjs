import test from "node:test";
import assert from "node:assert/strict";

await import("../data-protection.js");

const protection = globalThis.DataProtection;

function validBackup() {
  return {
    settings: { id: "main", dailyReviewLimit: 6 },
    tags: [{ id: "tag-1", name: "感觉" }],
    study: [{ id: "study-1", title: "普心 感觉" }],
    mistakes: [],
    logs: [{ id: "log-1", sourceId: "study-1" }],
    tasks: [{ id: "task-1", sourceId: "study-1" }],
  };
}

test("backup validation accepts direct exports and auto-sync state wrappers", () => {
  assert.deepEqual(protection.normalizeBackupPayload(validBackup()), validBackup());
  assert.deepEqual(protection.normalizeBackupPayload({ state: validBackup() }), validBackup());
});

test("backup validation rejects partial files before current data can be replaced", () => {
  const partial = validBackup();
  delete partial.logs;
  assert.throws(() => protection.normalizeBackupPayload(partial), /logs/);

  const invalidId = validBackup();
  invalidId.study = [{ title: "missing id" }];
  assert.throws(() => protection.normalizeBackupPayload(invalidId), /id/);
});

test("meaningful data ignores settings-only empty databases", () => {
  const empty = {
    settings: { id: "main" },
    tags: [],
    study: [],
    mistakes: [],
    logs: [],
    tasks: [],
  };
  assert.equal(protection.hasMeaningfulData(protection.dataCounts(empty)), false);
  assert.equal(protection.hasMeaningfulData(protection.dataCounts(validBackup())), true);
});

test("unexpected empty guard only blocks a previously populated database without a snapshot", () => {
  const emptyCounts = protection.dataCounts({ settings: { id: "main" } });
  assert.equal(protection.shouldFlagUnexpectedEmpty(emptyCounts, { hadData: true }, 0), true);
  assert.equal(protection.shouldFlagUnexpectedEmpty(emptyCounts, { hadData: true }, 1), false);
  assert.equal(protection.shouldFlagUnexpectedEmpty(emptyCounts, { hadData: false }, 0), false);
});

test("backup fingerprints are order independent and change with content", () => {
  const first = validBackup();
  first.tags.push({ id: "tag-2", name: "知觉" });
  const reordered = { ...first, tags: [...first.tags].reverse() };
  assert.equal(protection.backupFingerprint(first), protection.backupFingerprint(reordered));

  const changed = structuredClone(first);
  changed.study[0].title = "普心 知觉";
  assert.notEqual(protection.backupFingerprint(first), protection.backupFingerprint(changed));
});
