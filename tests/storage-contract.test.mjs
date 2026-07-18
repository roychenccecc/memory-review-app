import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const appSource = await readFile(new URL("../app.js", import.meta.url), "utf8");
const indexSource = await readFile(new URL("../index.html", import.meta.url), "utf8");

test("database identity stays stable and upgrades add protection stores", () => {
  assert.match(appSource, /const DB_NAME = "adaptive-memory-review";/);
  assert.match(appSource, /const DB_VERSION = 2;/);
  assert.match(appSource, /const INTERNAL_STORES = \["snapshots", "meta"\];/);
  assert.doesNotMatch(appSource, /indexedDB\.deleteDatabase/);
});

test("JSON import validates and snapshots before the atomic replacement", () => {
  const start = appSource.indexOf("async function importJson");
  const end = appSource.indexOf("function getAllItems", start);
  const importSource = appSource.slice(start, end);
  const validateIndex = importSource.indexOf("normalizeBackupPayload");
  const snapshotIndex = importSource.indexOf("createLocalSnapshot");
  const replaceIndex = importSource.indexOf("replaceAllDataAtomically");
  assert.ok(validateIndex >= 0 && validateIndex < replaceIndex);
  assert.ok(snapshotIndex >= 0 && snapshotIndex < replaceIndex);
  assert.doesNotMatch(importSource, /clearStore/);
});

test("data protection loads before the application entrypoint", () => {
  const protectionIndex = indexSource.indexOf("data-protection.js");
  const appIndex = indexSource.indexOf("app.js?v=");
  assert.ok(protectionIndex >= 0 && protectionIndex < appIndex);
});

test("the local guard preserves recovery and external-backup state", () => {
  const start = appSource.indexOf("function writeLocalDataGuard");
  const end = appSource.indexOf("function applyDataGuardStatus", start);
  const guardSource = appSource.slice(start, end);
  assert.match(guardSource, /externalBackupRequired/);
  assert.match(guardSource, /lastSnapshotReason/);
  assert.match(guardSource, /snapshotError/);
});

test("snapshot failure cannot prevent an existing database from starting", () => {
  const start = appSource.indexOf("async function initializeDataProtection");
  const end = appSource.indexOf("function scheduleDataProtectionSnapshot", start);
  const initializationSource = appSource.slice(start, end);
  assert.match(initializationSource, /try\s*{[\s\S]*createLocalSnapshot/);
  assert.match(initializationSource, /catch \(error\)/);
  assert.match(initializationSource, /recordSnapshotFailure/);
});

test("normal application updates silently refresh recovery points", () => {
  const start = appSource.indexOf("async function initializeDataProtection");
  const end = appSource.indexOf("async function recordSnapshotFailure", start);
  const initializationSource = appSource.slice(start, end);
  assert.match(initializationSource, /force: firstProtectionRun \|\| buildChanged \|\| !snapshots\.length/);
  assert.doesNotMatch(initializationSource, /requireExternalBackup/);

  const snapshotStart = appSource.indexOf("async function createLocalSnapshot");
  const snapshotEnd = appSource.indexOf("function replaceAllDataAtomically", snapshotStart);
  const snapshotSource = appSource.slice(snapshotStart, snapshotEnd);
  assert.match(snapshotSource, /externalBackupRequired: false/);
  assert.match(snapshotSource, /snapshotError: ""/);
});

test("non-blocking data protection warnings can be dismissed", () => {
  assert.match(indexSource, /id="dismissDataProtectionNoticeBtn"/);
  assert.match(appSource, /function dismissDataProtectionNotice/);
  assert.match(appSource, /if \(dataProtectionStatus\.blocked\) return;/);
  assert.match(appSource, /dismissDataProtectionNoticeBtn"\)\.addEventListener\("click", dismissDataProtectionNotice\)/);
});
