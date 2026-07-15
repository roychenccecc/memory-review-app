(function attachDataProtection(global) {
  "use strict";

  const DATA_STORE_NAMES = Object.freeze(["settings", "tags", "study", "mistakes", "logs", "tasks"]);
  const ARRAY_STORE_NAMES = Object.freeze(["tags", "study", "mistakes", "logs", "tasks"]);

  function isPlainObject(value) {
    return Boolean(value) && typeof value === "object" && !Array.isArray(value);
  }

  function assertRecord(store, row, index) {
    if (!isPlainObject(row) || typeof row.id !== "string" || !row.id.trim()) {
      throw new Error(`${store} 的第 ${index + 1} 条记录缺少有效 id。`);
    }
    return row;
  }

  function normalizeBackupPayload(input) {
    if (!isPlainObject(input)) throw new Error("备份文件不是有效的 JSON 对象。");
    const source = isPlainObject(input.state) ? input.state : input;
    if (!isPlainObject(source.settings)) throw new Error("备份缺少 settings 设置数据。");

    for (const store of ARRAY_STORE_NAMES) {
      if (!Array.isArray(source[store])) throw new Error(`备份缺少 ${store} 数组。`);
    }

    const settings = {
      ...source.settings,
      id: typeof source.settings.id === "string" && source.settings.id.trim()
        ? source.settings.id
        : "main",
    };
    const normalized = { settings };
    for (const store of ARRAY_STORE_NAMES) {
      normalized[store] = source[store].map((row, index) => assertRecord(store, row, index));
    }
    return normalized;
  }

  function dataCounts(payload) {
    const source = isPlainObject(payload) ? payload : {};
    return {
      settings: isPlainObject(source.settings) ? 1 : 0,
      tags: Array.isArray(source.tags) ? source.tags.length : 0,
      study: Array.isArray(source.study) ? source.study.length : 0,
      mistakes: Array.isArray(source.mistakes) ? source.mistakes.length : 0,
      logs: Array.isArray(source.logs) ? source.logs.length : 0,
      tasks: Array.isArray(source.tasks) ? source.tasks.length : 0,
    };
  }

  function hasMeaningfulData(countsOrPayload) {
    const counts = "study" in (countsOrPayload || {}) && Number.isFinite(Number(countsOrPayload.study))
      ? countsOrPayload
      : dataCounts(countsOrPayload);
    return Number(counts.tags || 0)
      + Number(counts.study || 0)
      + Number(counts.mistakes || 0)
      + Number(counts.logs || 0) > 0;
  }

  function stablePayload(payload) {
    const normalized = normalizeBackupPayload(payload);
    const stable = { settings: normalized.settings };
    for (const store of ARRAY_STORE_NAMES) {
      stable[store] = [...normalized[store]].sort((a, b) => a.id.localeCompare(b.id));
    }
    return JSON.stringify(stable);
  }

  function backupFingerprint(payload) {
    const text = stablePayload(payload);
    let hash = 2166136261;
    for (let index = 0; index < text.length; index += 1) {
      hash ^= text.charCodeAt(index);
      hash = Math.imul(hash, 16777619);
    }
    return `${text.length}-${(hash >>> 0).toString(16).padStart(8, "0")}`;
  }

  function shouldFlagUnexpectedEmpty(currentCounts, guardHint, snapshotCount = 0) {
    return !hasMeaningfulData(currentCounts)
      && Boolean(guardHint?.hadData)
      && Number(snapshotCount) === 0;
  }

  global.DataProtection = Object.freeze({
    ARRAY_STORE_NAMES,
    DATA_STORE_NAMES,
    backupFingerprint,
    dataCounts,
    hasMeaningfulData,
    normalizeBackupPayload,
    shouldFlagUnexpectedEmpty,
  });
})(globalThis);
