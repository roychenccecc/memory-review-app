(function attachCodexReviewLinks(global) {
  "use strict";

  const DEFAULT_WORKSPACE_PATH =
    "/Users/newlife/Documents/Codex/2026-06-11/new-chat/work/312-review-assistant";

  function normalizedTask(task = {}) {
    return {
      taskId: String(task.taskId || task.id || ""),
      sourceType: String(task.sourceType || ""),
      sourceId: String(task.sourceId || ""),
      title: String(task.title || "未命名学习记录"),
      scheduledDate: String(task.scheduledDate || ""),
      memoryScore: Number.isFinite(Number(task.memoryScore)) ? Math.round(Number(task.memoryScore)) : "",
      tagPaths: Array.isArray(task.tagPaths) ? task.tagPaths.filter(Boolean).map(String) : [],
      detail: String(task.detail || "").trim(),
    };
  }

  function buildCodexReviewPrompt(task, options = {}) {
    const value = normalizedTask(task);
    if (value.sourceType !== "study") return "";
    return `带我复习：${value.title}`;
  }

  function buildCodexReviewUrl(task, options = {}) {
    const prompt = buildCodexReviewPrompt(task, options);
    if (!prompt) return "";
    const workspacePath = String(options.workspacePath || DEFAULT_WORKSPACE_PATH);
    return `codex://threads/new?path=${encodeURIComponent(workspacePath)}&prompt=${encodeURIComponent(prompt)}`;
  }

  function buildDailyReviewLinks(tasks = [], options = {}) {
    const limit = Math.max(1, Number(options.limit) || 6);
    const seen = new Set();
    const links = [];
    for (const task of tasks) {
      const value = normalizedTask(task);
      if (value.sourceType !== "study") continue;
      const key = `${value.sourceType}:${value.sourceId}`;
      if (!value.sourceId || seen.has(key)) continue;
      seen.add(key);
      links.push({
        ...value,
        url: buildCodexReviewUrl(value, options),
      });
      if (links.length >= limit) break;
    }
    return links;
  }

  global.CodexReviewLinks = Object.freeze({
    DEFAULT_WORKSPACE_PATH,
    buildCodexReviewPrompt,
    buildCodexReviewUrl,
    buildDailyReviewLinks,
  });
})(globalThis);
