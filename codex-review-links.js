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

    const lines = [
      "请带我完成这条 312 心理学复习任务。",
      "",
      "开始前先阅读并严格遵守当前项目的 AGENTS.md。",
      "先通过 Chrome 检查复习管理器中的原任务仍属于今日待复习；若已完成或已不在今日待复习中，请停止并说明原因，避免重复记录。",
      "",
      `任务 ID：${value.taskId || "无"}`,
      `来源：学习记录 (${value.sourceType})`,
      `来源记录 ID：${value.sourceId || "无"}`,
      `标题：${value.title}`,
      `计划日期：${value.scheduledDate || "无"}`,
      `当前记忆分：${value.memoryScore === "" ? "暂无" : value.memoryScore}`,
      `知识点：${value.tagPaths.length ? value.tagPaths.join("；") : "未关联"}`,
      `备注：${value.detail || "无"}`,
      "",
      "请按项目现有的章节复习流程进行提问、纠错和评分。",
      "复习完成后使用现有 312-review-manager-handoff 流程，将最终确认的分数和下次重点回写到上述来源记录。",
      "不得重复新建学习记录、知识点或错题。",
    ];

    if (options.extraInstruction) lines.push("", String(options.extraInstruction));
    return lines.join("\n");
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
