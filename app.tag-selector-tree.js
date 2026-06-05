const DB_NAME = "adaptive-memory-review";
const DB_VERSION = 1;
const STORES = ["settings", "tags", "study", "mistakes", "logs", "tasks"];
const BASE_INTERVALS = [1, 2, 4, 7, 15, 30];
const IMPORTANCE_WEIGHT = { veryHigh: 45, high: 30, medium: 15, low: 0 };
const NEW_STUDY_PRIORITY_BONUS = 18;
const TAG_SCORE_WEIGHT = { veryHigh: 5, high: 3, medium: 2, low: 1 };
const TAG_STUDY_RATIO = 0.6;
const TAG_MISTAKE_RATIO = 0.4;
const MISTAKE_COUNT_PENALTY = 3;
const MAX_MISTAKE_PENALTY = 18;
const RESULT_LABEL = { remembered: "熟记", unclear: "模糊", forgotten: "完全忘了" };
const TYPE_LABEL = { study: "学习", mistake: "错题" };
const STUDY_KIND_LABEL = { new: "新学", review: "复习" };
const DEFAULT_QUESTION_TYPES = ["选择题", "简答题", "综合题", "计算题"];

let db;
let pastedMistakeImage = "";
let lastChainTagId = "";
let tagMapZoom = 1;
let tagGestureStartZoom = 1;
let activeMistakeTagFilterId = "";
let activeTagDetailId = "";
let selectedPickerTagIds = { study: "", mistake: "" };
let selectedTreeParentIds = { study: "", mistake: "" };
let tagPickerCollapsedIds = { study: new Set(), mistake: new Set() };
let state = {
  settings: {
    id: "main",
    examDate: "",
    cramWindow: 14,
    dailyCramLimit: 20,
    dailyReviewLimit: 6,
    questionTypes: DEFAULT_QUESTION_TYPES,
  },
  tags: [],
  study: [],
  mistakes: [],
  logs: [],
  tasks: [],
};
const treeLevelCounters = { study: 0, mistake: 0 };
let collapsedTagIds = new Set();

document.addEventListener("DOMContentLoaded", async () => {
  db = await openDb();
  await loadState();
  const repairedLegacyTags = await repairLegacySplitEnumerationTags();
  await refreshSchedule();
  bindEvents();
  setDefaultDates();
  render();
  if (repairedLegacyTags) toast(`已修复 ${repairedLegacyTags} 条旧的顿号误拆标签。`);
});

function openDb() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const database = request.result;
      for (const store of STORES) {
        if (!database.objectStoreNames.contains(store)) {
          database.createObjectStore(store, { keyPath: "id" });
        }
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function tx(store, mode = "readonly") {
  return db.transaction(store, mode).objectStore(store);
}

function all(store) {
  return new Promise((resolve, reject) => {
    const request = tx(store).getAll();
    request.onsuccess = () => resolve(request.result || []);
    request.onerror = () => reject(request.error);
  });
}

function put(store, value) {
  return new Promise((resolve, reject) => {
    const request = tx(store, "readwrite").put(value);
    request.onsuccess = () => resolve(value);
    request.onerror = () => reject(request.error);
  });
}

function remove(store, id) {
  return new Promise((resolve, reject) => {
    const request = tx(store, "readwrite").delete(id);
    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error);
  });
}

function clearStore(store) {
  return new Promise((resolve, reject) => {
    const request = tx(store, "readwrite").clear();
    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error);
  });
}

async function loadState() {
  const [settings, tags, study, mistakes, logs, tasks] = await Promise.all([
    all("settings"),
    all("tags"),
    all("study"),
    all("mistakes"),
    all("logs"),
    all("tasks"),
  ]);

  state.settings = {
    ...state.settings,
    ...(settings[0] || {}),
    dailyReviewLimit: clamp(Number(settings[0]?.dailyReviewLimit ?? state.settings.dailyReviewLimit ?? 6), 1, 80),
    questionTypes: normalizeQuestionTypes(settings[0]?.questionTypes),
  };
  state.tags = tags.sort(byCreated);
  state.study = study.sort(byDateDesc);
  state.mistakes = mistakes.sort(byDateDesc);
  state.logs = logs.sort(byDateDesc);
  state.tasks = tasks.sort((a, b) => a.scheduledDate.localeCompare(b.scheduledDate));
}

function bindEvents() {
  document.querySelectorAll(".nav-item").forEach((button) => {
    button.addEventListener("click", () => switchView(button.dataset.view));
  });

  document.querySelectorAll("[data-open-modal]").forEach((button) => {
    button.addEventListener("click", () => {
      if (button.dataset.openModal === "studyModal") prepareNewStudyForm();
      if (button.dataset.openModal === "mistakeModal") prepareNewMistakeForm();
      document.getElementById(button.dataset.openModal).showModal();
    });
  });

  document.querySelectorAll("[data-close-modal]").forEach((button) => {
    button.addEventListener("click", () => button.closest("dialog").close());
  });

  document.getElementById("studyForm").addEventListener("submit", saveStudy);
  document.getElementById("mistakeForm").addEventListener("submit", saveMistake);
  document.getElementById("tagForm").addEventListener("submit", saveTag);
  document.getElementById("settingsForm").addEventListener("submit", saveSettings);
  document.getElementById("reviewForm").addEventListener("submit", saveReview);
  document.getElementById("studyRecordForm").addEventListener("submit", saveStudyRecord);
  document.getElementById("studyRecordPercentRange").addEventListener("input", syncStudyRecordRecallFromRange);
  document.getElementById("studyRecordPercentInput").addEventListener("input", syncStudyRecordRecallFromInput);
  document.getElementById("studySectionScores").addEventListener("input", syncStudySectionScore);
  document.getElementById("mistakeRecordForm").addEventListener("submit", saveMistakeRecord);
  document.getElementById("questionTypeForm").addEventListener("submit", saveQuestionTypes);
  document.getElementById("addQuestionTypeBtn").addEventListener("click", addQuestionType);
  document.getElementById("saveTagDetailBtn").addEventListener("click", saveTagDetail);
  document.getElementById("mistakeRecordPercentRange").addEventListener("input", syncMistakeRecordRecallFromRange);
  document.getElementById("mistakeRecordPercentInput").addEventListener("input", syncMistakeRecordRecallFromInput);
  document.getElementById("reviewFilter").addEventListener("change", renderDashboard);
  document.getElementById("historyFilter").addEventListener("change", renderHistory);
  document.getElementById("studySearch").addEventListener("input", renderStudy);
  document.getElementById("studyViewMode").addEventListener("change", renderStudy);
  document.getElementById("mistakeSearch").addEventListener("input", renderMistakes);
  document.getElementById("clearMistakeTagFilterBtn").addEventListener("click", clearMistakeTagFilter);
  document.getElementById("tagSearch").addEventListener("input", renderTags);
  document.getElementById("expandAllTagsBtn").addEventListener("click", expandAllTags);
  document.getElementById("collapseAllTagsBtn").addEventListener("click", collapseAllTags);
  document.getElementById("resetTagZoomBtn").addEventListener("click", resetTagMapZoom);
  document.getElementById("tagList").addEventListener("wheel", handleTagMapWheel, { passive: false });
  document.getElementById("tagList").addEventListener("gesturestart", handleTagMapGestureStart, { passive: false });
  document.getElementById("tagList").addEventListener("gesturechange", handleTagMapGestureChange, { passive: false });
  document.getElementById("exportJsonBtn").addEventListener("click", exportJson);
  document.getElementById("exportCsvBtn").addEventListener("click", exportCsv);
  document.getElementById("exportIcsBtn").addEventListener("click", exportIcs);
  document.getElementById("syncAppleCalendarBtn").addEventListener("click", syncAppleCalendar);
  document.getElementById("importJsonInput").addEventListener("change", importJson);
  document.getElementById("seedBtn").addEventListener("click", addSeedData);
  document.getElementById("addStudyManualTagBtn").addEventListener("click", () => addManualSimpleTags("study"));
  document.getElementById("studyManualTagInput").addEventListener("keydown", handleManualTagInputKeydown);
  document.getElementById("addStudyTreeLevelBtn").addEventListener("click", () => addStudyTreeLevel());
  document.getElementById("createStudyTreeTagBtn").addEventListener("click", createStudyTreeTag);
  document.getElementById("addMistakeManualTagBtn").addEventListener("click", () => addManualSimpleTags("mistake"));
  document.getElementById("mistakeManualTagInput").addEventListener("keydown", handleManualTagInputKeydown);
  document.getElementById("addMistakeTreeLevelBtn").addEventListener("click", () => addMistakeTreeLevel());
  document.getElementById("createMistakeTreeTagBtn").addEventListener("click", createMistakeTreeTag);
  document.getElementById("addExistingStudyTagBtn").addEventListener("click", addExistingStudyTag);
  document.getElementById("deleteExistingStudyTagBtn").addEventListener("click", () => deleteExistingTagFromSelect("study"));
  document.getElementById("setStudyTreeParentBtn").addEventListener("click", () => setTreeParentFromSelected("study"));
  document.getElementById("clearStudyTagPickerSearchBtn").addEventListener("click", () => clearTagPickerSearch("study"));
  document.getElementById("expandStudyTagPickerBtn").addEventListener("click", () => expandTagPicker("study"));
  document.getElementById("collapseStudyTagPickerBtn").addEventListener("click", () => collapseTagPicker("study"));
  document.getElementById("clearStudyTreeParentBtn").addEventListener("click", () => clearTreeParent("study"));
  document.getElementById("studyTagPickerSearch").addEventListener("input", () => renderTagPicker("study"));
  document.getElementById("addExistingMistakeTagBtn").addEventListener("click", addExistingMistakeTag);
  document.getElementById("deleteExistingMistakeTagBtn").addEventListener("click", () => deleteExistingTagFromSelect("mistake"));
  document.getElementById("setMistakeTreeParentBtn").addEventListener("click", () => setTreeParentFromSelected("mistake"));
  document.getElementById("clearMistakeTagPickerSearchBtn").addEventListener("click", () => clearTagPickerSearch("mistake"));
  document.getElementById("expandMistakeTagPickerBtn").addEventListener("click", () => expandTagPicker("mistake"));
  document.getElementById("collapseMistakeTagPickerBtn").addEventListener("click", () => collapseTagPicker("mistake"));
  document.getElementById("clearMistakeTreeParentBtn").addEventListener("click", () => clearTreeParent("mistake"));
  document.getElementById("mistakeTagPickerSearch").addEventListener("input", () => renderTagPicker("mistake"));
  document.getElementById("deleteSelectedTagBtn").addEventListener("click", deleteSelectedTag);
  document.getElementById("addTagChainBtn").addEventListener("click", addTagChain);
  document.getElementById("continueTagBranchBtn").addEventListener("click", continueTagBranch);
  document.querySelector("#studyForm [name='tags']").addEventListener("input", renderSelectedTagChips);
  document.querySelector("#mistakeForm [name='tags']").addEventListener("input", renderSelectedTagChips);
  document.getElementById("mistakePasteZone").addEventListener("click", (event) => event.currentTarget.focus());
  document.getElementById("mistakePasteZone").addEventListener("paste", pasteMistakeImage);
  document.getElementById("mistakeModal").addEventListener("paste", (event) => {
    const hasImage = [...(event.clipboardData?.items || [])].some((item) => item.type.startsWith("image/"));
    if (hasImage) pasteMistakeImage(event);
  });
  document.querySelector("#mistakeForm [name='image']").addEventListener("change", previewMistakeFile);
  document.getElementById("clearMistakeImageBtn").addEventListener("click", () => clearMistakeImage(true));
  document.getElementById("recallPercentRange").addEventListener("input", syncRecallFromRange);
  document.getElementById("recallPercentInput").addEventListener("input", syncRecallFromInput);
  document.getElementById("mistakeModal").addEventListener("close", () => {
    if (!document.getElementById("mistakeForm").matches(":focus-within")) clearMistakeImage();
  });
}

function setDefaultDates() {
  const today = toDateInput(new Date());
  document.querySelector("#studyForm [name='date']").value = today;
  document.querySelector("#settingsForm [name='examDate']").value = state.settings.examDate || "";
  document.querySelector("#settingsForm [name='cramWindow']").value = state.settings.cramWindow || 14;
  document.querySelector("#settingsForm [name='dailyCramLimit']").value = state.settings.dailyCramLimit || 20;
  document.querySelector("#settingsForm [name='dailyReviewLimit']").value = state.settings.dailyReviewLimit || 6;
}

function switchView(view) {
  document.querySelectorAll(".nav-item").forEach((button) => {
    button.classList.toggle("active", button.dataset.view === view);
  });
  document.querySelectorAll(".view").forEach((section) => {
    section.classList.toggle("active", section.id === view);
  });
  const titles = {
    dashboard: "今日复习",
    study: "学习记录",
    mistakes: "错题库",
    tags: "知识点",
    history: "记忆记录",
    settings: "设置/导出",
  };
  document.getElementById("viewTitle").textContent = titles[view] || "复习管理器";
}

function render() {
  document.getElementById("todayText").textContent = `${formatDate(toDateInput(new Date()))} · 本地离线数据`;
  document.getElementById("calendarSubscribeUrl").textContent = `${window.location.origin}/calendar.ics`;
  renderTagOptions();
  renderTagParentOptions();
  renderExistingTagSelectors();
  renderDeleteTagSelector();
  renderSimpleTagChoices();
  renderStudyTreeBuilder();
  renderMistakeTreeBuilder();
  renderSelectedTagChips();
  renderDashboard();
  renderStudy();
  renderMistakes();
  renderTags();
  renderHistory();
  setDefaultDates();
}

function renderDashboard() {
  const tasks = buildDisplayTasks();
  const visibleTasks = tasks.filter((task) => !wasTaskReviewedToday(task));
  const today = toDateInput(new Date());
  const due = visibleTasks.filter((task) => task.scheduledDate <= today && task.status === "pending");
  const overdue = due.filter((task) => task.scheduledDate < today);
  const cram = visibleTasks.filter((task) => task.isCram && task.status === "pending" && task.scheduledDate <= today);
  const future = visibleTasks
    .filter((task) => task.status === "pending" && task.scheduledDate > today)
    .sort(taskSort)
    .slice(0, 40);
  const reviewedToday = buildReviewedTodayTasks();
  const weak = getAllItems().filter((item) => currentScore(item) < 60);

  document.getElementById("statsGrid").innerHTML = [
    stat("待复习", due.length),
    stat("今日已复习", reviewedToday.length),
    stat("考前重点", cram.length),
    stat("薄弱内容", weak.length),
  ].join("");

  const filter = document.getElementById("reviewFilter").value;
  let visible = due;
  if (filter === "overdue") visible = overdue;
  if (filter === "cram") visible = cram;
  if (filter === "all") visible = due;
  visible = visible.sort(taskSort).slice(0, 80);

  document.getElementById("taskList").innerHTML = `
    <div class="task-section">
      <div class="section-title">
        <h4>待复习</h4>
        <span>${visible.length} 项</span>
      </div>
      ${visible.length ? visible.map(renderTaskCard).join("") : empty("现在没有符合条件的待复习任务。")}
    </div>
    <div class="task-section reviewed">
      <div class="section-title">
        <h4>今日已复习</h4>
        <span>${reviewedToday.length} 项</span>
      </div>
      ${reviewedToday.length ? reviewedToday.map(renderReviewedTaskCard).join("") : empty("今天还没有记录复习结果。")}
    </div>
    <div class="task-section future">
      <div class="section-title">
        <h4>未来复习计划</h4>
        <span>${future.length} 项</span>
      </div>
      ${future.length ? future.map(renderTaskCard).join("") : empty("还没有未来复习计划。")}
    </div>
  `;

  document.getElementById("weakTags").innerHTML = renderWeakTags();
}

function renderReviewedTaskCard(task) {
  const item = findItem(task.sourceType, task.sourceId);
  if (!item) return "";
  const score = Number(task.afterScore ?? currentScore(item));
  const tags = tagsFor(item.tagIds);
  const title = task.sourceType === "study" ? item.title : item.location || firstLine(item.question) || "未命名错题";
  return `
    <article class="task-card reviewed-card">
      <div class="memory-strip ${scoreClass(score)}"></div>
      <div>
        <h4 class="card-title">${escapeHtml(title)}</h4>
        <div class="meta">
          <span>${TYPE_LABEL[task.sourceType]}</span>
          <span>已复习: ${formatDate(task.date)}</span>
          <span>已复习 ${reviewCount(task.sourceType, task.sourceId)} 次</span>
          <span>记住 ${Number(task.recallPercent ?? score)}%</span>
          <span>记忆分: ${score}</span>
        </div>
        ${renderTagRow(tags)}
        ${task.notes ? `<p class="body-text">${escapeHtml(truncate(task.notes, 120))}</p>` : ""}
      </div>
      <div class="card-actions">
        <button class="small-button" onclick="openEditItem('${task.sourceType}','${task.sourceId}')">编辑内容</button>
        <button class="small-button" onclick="${task.sourceType === "mistake" ? `openMistakeRecord('${task.sourceId}')` : `openStudyRecord('${task.sourceId}')`}">${task.sourceType === "mistake" ? "错题记录" : "学习记录"}</button>
        <button class="small-button" onclick="openEditReview('${task.id}')">修改记录</button>
      </div>
    </article>
  `;
}

function renderTaskCard(task) {
  const item = findItem(task.sourceType, task.sourceId);
  if (!item) return "";
  const score = currentScore(item);
  const tags = tagsFor(item.tagIds);
  const title = task.sourceType === "study" ? item.title : item.location || firstLine(item.question) || "未命名错题";
  const detail = task.sourceType === "study" ? item.notes : item.reason;
  const dateLabel = task.scheduledDate < toDateInput(new Date()) ? "逾期" : "计划";
  return `
    <article class="task-card">
      <div class="memory-strip ${scoreClass(score)}"></div>
      <div>
        <h4 class="card-title">${escapeHtml(title)}</h4>
        <div class="meta">
          <span>${TYPE_LABEL[task.sourceType]}</span>
          <span>${dateLabel}: ${formatDate(task.scheduledDate)}</span>
          <span>已复习 ${reviewCount(task.sourceType, task.sourceId)} 次</span>
          <span>记忆分: ${score}</span>
          ${task.isCram ? '<span class="badge cram">考前重点</span>' : ""}
        </div>
        ${renderTagRow(tags)}
        ${detail ? `<p class="body-text">${escapeHtml(truncate(detail, 160))}</p>` : ""}
      </div>
      <div class="card-actions">
        <button class="small-button" onclick="openEditItem('${task.sourceType}','${task.sourceId}')">编辑内容</button>
        <button class="small-button" onclick="${task.sourceType === "mistake" ? `openMistakeRecord('${task.sourceId}','${task.id || ""}')` : `openStudyRecord('${task.sourceId}','${task.id || ""}')`}">${task.sourceType === "mistake" ? "错题记录" : "学习记录"}</button>
        <button class="small-button" onclick="postponeTask('${task.id || ""}', '${task.sourceType}', '${task.sourceId}')">延后1天</button>
      </div>
    </article>
  `;
}

function renderStudy() {
  const query = document.getElementById("studySearch").value.trim().toLowerCase();
  const rows = state.study.filter((item) => matchesStudy(item, query));
  const mode = document.getElementById("studyViewMode").value;
  if (mode === "tree") {
    document.getElementById("studyList").innerHTML = renderStudyTreeView(rows);
    return;
  }
  document.getElementById("studyList").innerHTML = rows.length
    ? rows.map((item) => renderItemCard("study", item)).join("")
    : empty("还没有学习记录。");
}

function renderStudyTreeView(rows) {
  if (!rows.length) return empty("还没有符合条件的学习记录。");
  const used = new Set();
  const roots = tagTreeRows().filter((row) => row.depth === 0).map((row) => row.tag);
  const treeHtml = roots
    .map((tag) => renderStudyTagNode(tag, rows, used))
    .filter(Boolean)
    .join("");
  const untagged = rows.filter((item) => !(item.tagIds || []).length);
  const untaggedHtml = untagged.length
    ? `<section class="study-tree-node">
        <article class="tag-card">
          <div class="meta"><span class="badge">未分类</span><span>${untagged.length} 条记录</span></div>
          <div class="study-tree-items">${untagged.map(renderStudyMiniCard).join("")}</div>
        </article>
      </section>`
    : "";
  return treeHtml || untaggedHtml
    ? `<div class="study-tree-view">${treeHtml}${untaggedHtml}</div>`
    : empty("这些学习记录还没有关联到当前知识树。");
}

function renderStudyTagNode(tag, rows, used) {
  const children = state.tags
    .filter((child) => child.parentId === tag.id)
    .sort((a, b) => tagPath(a).localeCompare(tagPath(b), "zh-CN"));
  const direct = rows.filter((item) => (item.tagIds || []).includes(tag.id));
  direct.forEach((item) => used.add(item.id));
  const childHtml = children.map((child) => renderStudyTagNode(child, rows, used)).filter(Boolean).join("");
  if (!direct.length && !childHtml) return "";
  const descendantIds = descendantTagIds(tag.id);
  const total = rows.filter((item) => (item.tagIds || []).some((tagId) => descendantIds.includes(tagId))).length;
  return `
    <section class="study-tree-node">
      <article class="tag-card">
        <div class="meta">
          ${renderTagPill(tag)}
          <span>${direct.length} 条直接记录</span>
          <span>${total} 条含子知识点</span>
        </div>
        ${direct.length ? `<div class="study-tree-items">${direct.map(renderStudyMiniCard).join("")}</div>` : ""}
      </article>
      ${childHtml ? `<div class="tag-tree-children">${childHtml}</div>` : ""}
    </section>
  `;
}

function renderStudyMiniCard(item) {
  const score = currentScore(item);
  return `
    <article class="mini-study-card">
      <div>
        <strong>${escapeHtml(item.title)}</strong>
        <div class="meta">
          <span class="badge">${studyKindLabel(item)}</span>
          <span>${formatDate(item.date)}</span>
          <span>已复习 ${reviewCount("study", item.id)} 次</span>
          <span>下次: ${formatDate(nextTaskDate("study", item.id))}</span>
          <span>记忆分: ${score}</span>
        </div>
      </div>
      <div class="card-actions">
        <button class="small-button" onclick="openEditItem('study','${item.id}')">编辑</button>
        <button class="small-button" onclick="openStudyRecord('${item.id}')">学习记录</button>
      </div>
    </article>
  `;
}

function renderMistakes() {
  const query = document.getElementById("mistakeSearch").value.trim().toLowerCase();
  const activeTag = activeMistakeTagFilterId ? state.tags.find((tag) => tag.id === activeMistakeTagFilterId) : null;
  const tagIds = activeTag ? descendantTagIds(activeTag.id) : [];
  const taggedRows = activeTag
    ? state.mistakes.filter((item) => (item.tagIds || []).some((tagId) => tagIds.includes(tagId)))
    : state.mistakes;
  const rows = taggedRows.filter((item) => matchesMistake(item, query));
  renderMistakeTagFilterBar(activeTag);
  document.getElementById("mistakeList").innerHTML = rows.length
    ? rows.map((item) => renderItemCard("mistake", item)).join("")
    : empty(activeTag ? (query ? "这个知识点下没有匹配搜索的错题。" : "这个知识点下还没有错题记录。") : "还没有错题记录。");
}

function renderItemCard(type, item) {
  const score = currentScore(item);
  const tags = tagsFor(item.tagIds);
  const title = type === "study" ? item.title : item.location || firstLine(item.question) || "未命名错题";
  const body = type === "study"
    ? item.notes
    : [item.question && `题干：${item.question}`, item.answer && `答案：${item.answer}`, `初次错因：${item.reason}`].filter(Boolean).join("\n\n");
  const date = item.date || item.createdAt.slice(0, 10);
  return `
    <article class="item-card">
      <div class="meta">
        <span class="badge">${type === "study" ? studyKindLabel(item) : TYPE_LABEL[type]}</span>
        <span>${formatDate(date)}</span>
        <span>已复习 ${reviewCount(type, item.id)} 次</span>
        <span>记忆分: ${score}</span>
        <span>下次: ${formatDate(nextTaskDate(type, item.id))}</span>
      </div>
      ${renderTagRow(tags)}
      <h4 class="card-title">${escapeHtml(title)}</h4>
      ${body ? `<p class="body-text">${escapeHtml(body)}</p>` : ""}
      ${type === "mistake" && item.image ? `<img class="mistake-image" src="${item.image}" alt="错题图片" />` : ""}
      <div class="card-actions">
        <button class="small-button" onclick="openEditItem('${type}','${item.id}')">编辑</button>
        ${type === "mistake" ? `<button class="small-button" onclick="openMistakeRecord('${item.id}')">错题记录</button>` : `<button class="small-button" onclick="openStudyRecord('${item.id}')">学习记录</button>`}
        <button class="small-button danger" onclick="deleteItem('${type}','${item.id}')">删除</button>
      </div>
    </article>
  `;
}

function renderTags() {
  const query = document.getElementById("tagSearch").value.trim().toLowerCase();
  const roots = tagTreeRows().filter((row) => row.depth === 0).map((row) => row.tag);
  const tagScoreCache = new Map();
  const branches = roots.map((tag) => renderTagMindNode(tag, query, tagScoreCache)).filter(Boolean).join("");
  document.getElementById("tagList").innerHTML = roots.length
    ? branches
      ? `<div class="mind-map-canvas" style="--mind-map-zoom: ${tagMapZoom}">
          <div class="mind-map-content">
            <div class="mind-map-branches">${branches}</div>
          </div>
        </div>`
      : empty("没有找到匹配的知识点。")
    : empty("还没有知识点。先在左侧新增，之后错题可直接从知识点树里选择。");
  updateTagZoomText();
}

function renderTagMindNode(tag, query = "", tagScoreCache = new Map()) {
  const children = state.tags
    .filter((child) => child.parentId === tag.id)
    .sort((a, b) => tagPath(a).localeCompare(tagPath(b), "zh-CN"));
  const childrenHtml = children.map((child) => renderTagMindNode(child, query, tagScoreCache)).filter(Boolean).join("");
  const isMatch = !query || tagMatchesSearch(tag, query);
  if (query && !isMatch && !childrenHtml) return "";
  const hasChildren = children.length > 0;
  const collapsed = collapsedTagIds.has(tag.id) && !query;
  const tagSummary = tagMemorySummary(tag, tagScoreCache);
  return `
    <div class="mind-node ${isMatch && query ? "search-hit" : ""}">
      <article class="mind-card">
        <div class="mind-card-main">
          ${hasChildren
            ? `<button class="mind-toggle" onclick="toggleTagNode('${tag.id}')" type="button" aria-label="${collapsed ? "展开" : "收起"}">${collapsed ? "+" : "-"}</button>`
            : '<span class="mind-toggle placeholder"></span>'}
          <div class="mind-detail-trigger" onclick="openTagDetail('${tag.id}')" onkeydown="handleTagDetailKey(event, '${tag.id}')" role="button" tabindex="0" title="查看知识点详情">
            <strong>${escapeHtml(tag.name)}</strong>
            <div class="mind-meta">
              <span class="badge ${tag.importance}">${importanceLabel(tag.importance)}</span>
              ${renderTagMemoryScore(tagSummary.score)}
            </div>
            ${renderQuestionTypeBadges(tag)}
          </div>
        </div>
        ${tagSummary.mistakeCount ? `<button class="mistake-count-badge" onclick="jumpToTagMistakes('${tag.id}')" type="button">错题 ${tagSummary.mistakeCount}</button>` : ""}
        <div class="card-actions mind-actions">
          <button class="small-button" onclick="renameTag('${tag.id}')">重命名</button>
          <button class="small-button danger" onclick="deleteTag('${tag.id}')">删除</button>
        </div>
      </article>
      ${hasChildren && !collapsed ? `<div class="mind-children">${query ? childrenHtml : children.map((child) => renderTagMindNode(child, query, tagScoreCache)).join("")}</div>` : ""}
    </div>
  `;
}

function tagMatchesSearch(tag, query) {
  return [tag.name, tagPath(tag), importanceLabel(tag.importance), ...(tag.questionTypes || [])]
    .join(" ")
    .toLowerCase()
    .includes(query);
}

function renderQuestionTypeBadges(tag) {
  const types = Array.isArray(tag.questionTypes) ? tag.questionTypes : [];
  if (!types.length) return "";
  return `<div class="question-type-row">${types.map((type) => `<span>${escapeHtml(type)}</span>`).join("")}</div>`;
}

function handleTagDetailKey(event, tagId) {
  if (event.key !== "Enter" && event.key !== " ") return;
  event.preventDefault();
  openTagDetail(tagId);
}

function openTagDetail(tagId) {
  const tag = state.tags.find((row) => row.id === tagId);
  if (!tag) {
    toast("没有找到这个知识点。");
    return;
  }
  activeTagDetailId = tag.id;
  renderTagDetail(tag);
  openModal("tagDetailModal");
}

function renderTagDetail(tag) {
  const tagIds = descendantTagIds(tag.id);
  const tagScoreCache = new Map();
  const summary = tagMemorySummary(tag, tagScoreCache);
  const studyItems = state.study
    .filter((item) => (item.tagIds || []).some((tagId) => tagIds.includes(tagId)))
    .sort(byDateDesc);
  const mistakeItems = state.mistakes
    .filter((item) => (item.tagIds || []).some((tagId) => tagIds.includes(tagId)))
    .sort(byDateDesc);
  const logs = relatedTagReviewLogs(studyItems, mistakeItems);

  setText("tagDetailTitle", `知识点详情：${tag.name}`);
  document.getElementById("tagDetailPath").textContent = tagPath(tag);
  document.getElementById("tagDetailMeta").innerHTML = `
    <span class="tag-pill" style="border-left: 5px solid ${escapeHtml(tag.color || "#64748b")}">${escapeHtml(tagPath(tag))}</span>
    ${renderTagMemoryScore(summary.score)}
    <span class="badge ${tag.importance}">${importanceLabel(tag.importance)}</span>
    <span class="badge neutral">错题 ${summary.mistakeCount || 0}</span>
    <span class="badge neutral">学习 ${studyItems.length}</span>
    <span class="badge neutral">含子知识点 ${Math.max(tagIds.length - 1, 0)}</span>
  `;
  const importanceSelect = document.getElementById("tagDetailImportance");
  importanceSelect.innerHTML = importanceOptions(tag.importance);
  importanceSelect.value = tag.importance || "medium";
  document.getElementById("tagDetailQuestionTypes").innerHTML = (tag.questionTypes || []).length
    ? renderQuestionTypeBadges(tag)
    : '<span class="muted">还没有设置考察题型。</span>';
  document.getElementById("tagDetailNotes").value = tag.reviewNotes || "";
  document.getElementById("tagDetailStudyList").innerHTML = studyItems.length
    ? studyItems.map(renderTagDetailStudyItem).join("")
    : empty("这个知识点范围下还没有学习记录。");
  document.getElementById("tagDetailMistakeList").innerHTML = mistakeItems.length
    ? mistakeItems.map(renderTagDetailMistakeItem).join("")
    : empty("这个知识点范围下还没有错题记录。");
  document.getElementById("tagDetailLogList").innerHTML = logs.length
    ? logs.map(renderTagDetailLog).join("")
    : empty("这个知识点范围下还没有复习记录。");
}

function relatedTagReviewLogs(studyItems, mistakeItems) {
  const studyIds = new Set(studyItems.map((item) => item.id));
  const mistakeIds = new Set(mistakeItems.map((item) => item.id));
  return state.logs
    .filter((log) => (log.sourceType === "study" && studyIds.has(log.sourceId)) || (log.sourceType === "mistake" && mistakeIds.has(log.sourceId)))
    .sort((a, b) => (b.createdAt || b.date || "").localeCompare(a.createdAt || a.date || ""))
    .slice(0, 20);
}

function renderTagDetailStudyItem(item) {
  const nextDate = nextTaskDate("study", item.id);
  return `
    <article class="tag-detail-item">
      <div class="tag-detail-item-head">
        <div>
          <strong>${escapeHtml(item.title || "未命名学习")}</strong>
          <div class="meta">
            <span>${studyKindLabel(item)}</span>
            <span>${formatDate(item.date || item.createdAt?.slice(0, 10))}</span>
            <span>已复习 ${reviewCount("study", item.id)} 次</span>
            <span>记忆分 ${currentScore(item)}</span>
            ${nextDate ? `<span>下次 ${formatDate(nextDate)}</span>` : ""}
          </div>
        </div>
        <button class="small-button" onclick="openStudyRecordFromTagDetail('${item.id}')" type="button">学习记录</button>
      </div>
      ${item.notes ? `<p class="body-text">${escapeHtml(truncate(item.notes, 120))}</p>` : ""}
      ${renderTagRow(tagsFor(item.tagIds || []).filter(isTreeKnowledgeTag))}
    </article>
  `;
}

function renderTagDetailMistakeItem(item) {
  const title = item.location || firstLine(item.question) || "未命名错题";
  const nextDate = nextTaskDate("mistake", item.id);
  return `
    <article class="tag-detail-item">
      <div class="tag-detail-item-head">
        <div>
          <strong>${escapeHtml(title)}</strong>
          <div class="meta">
            <span>错题</span>
            <span>${formatDate(item.date || item.createdAt?.slice(0, 10))}</span>
            <span>已复习 ${reviewCount("mistake", item.id)} 次</span>
            <span>记忆分 ${currentScore(item)}</span>
            ${nextDate ? `<span>下次 ${formatDate(nextDate)}</span>` : ""}
          </div>
        </div>
        <button class="small-button" onclick="openMistakeRecordFromTagDetail('${item.id}')" type="button">错题记录</button>
      </div>
      ${item.reason ? `<p class="body-text">错因：${escapeHtml(truncate(item.reason, 120))}</p>` : ""}
      ${renderTagRow(tagsFor(item.tagIds || []).filter(isTreeKnowledgeTag))}
    </article>
  `;
}

function renderTagDetailLog(log) {
  const item = findItem(log.sourceType, log.sourceId);
  const title = item
    ? (log.sourceType === "study" ? item.title : item.location || firstLine(item.question) || "未命名错题")
    : "已删除内容";
  return `
    <article class="history-card compact-history-card">
      <div class="meta">
        <span>${formatDate(log.date)}</span>
        <span>${TYPE_LABEL[log.sourceType]}</span>
        <span>记住 ${Number(log.recallPercent ?? log.afterScore ?? 0)}%</span>
        <span>分数 ${Number(log.beforeScore ?? 0)} → ${Number(log.afterScore ?? 0)}</span>
      </div>
      <strong>${escapeHtml(title || "未命名内容")}</strong>
      ${log.notes ? `<p class="body-text">${escapeHtml(truncate(log.notes, 140))}</p>` : ""}
      ${renderSectionScoreSummary(log.sectionScores)}
    </article>
  `;
}

function openStudyRecordFromTagDetail(studyId) {
  document.getElementById("tagDetailModal").close();
  openStudyRecord(studyId);
}

function openMistakeRecordFromTagDetail(mistakeId) {
  document.getElementById("tagDetailModal").close();
  openMistakeRecord(mistakeId);
}

function openQuestionTypesFromTagDetail() {
  const tagId = activeTagDetailId;
  document.getElementById("tagDetailModal").close();
  openQuestionTypes(tagId);
}

async function saveTagDetail() {
  const tag = state.tags.find((row) => row.id === activeTagDetailId);
  if (!tag) {
    toast("没有找到这个知识点。");
    return;
  }
  tag.importance = document.getElementById("tagDetailImportance").value || "medium";
  tag.reviewNotes = document.getElementById("tagDetailNotes").value.trim();
  tag.updatedAt = now();
  await put("tags", tag);
  await loadState();
  const updatedTag = state.tags.find((row) => row.id === activeTagDetailId);
  if (updatedTag) renderTagDetail(updatedTag);
  render();
  toast("知识点详情已保存。");
}

function toggleTagNode(idValue) {
  if (collapsedTagIds.has(idValue)) {
    collapsedTagIds.delete(idValue);
  } else {
    collapsedTagIds.add(idValue);
  }
  renderTags();
}

function expandAllTags() {
  collapsedTagIds.clear();
  renderTags();
}

function collapseAllTags() {
  collapsedTagIds = new Set(state.tags.filter((tag) => state.tags.some((child) => child.parentId === tag.id)).map((tag) => tag.id));
  renderTags();
}

function handleTagMapWheel(event) {
  const list = document.getElementById("tagList");
  if (event.ctrlKey) {
    event.preventDefault();
    const nextZoom = clamp(tagMapZoom - event.deltaY * 0.002, 0.45, 1.8);
    setTagMapZoom(nextZoom, event);
    return;
  }

  event.preventDefault();
  list.scrollLeft += event.shiftKey && !event.deltaX ? event.deltaY : event.deltaX;
  list.scrollTop += event.deltaY;
}

function handleTagMapGestureStart(event) {
  event.preventDefault();
  tagGestureStartZoom = tagMapZoom;
}

function handleTagMapGestureChange(event) {
  event.preventDefault();
  setTagMapZoom(clamp(tagGestureStartZoom * event.scale, 0.45, 1.8), event);
}

function setTagMapZoom(nextZoom, event) {
  const list = document.getElementById("tagList");
  const canvas = list.querySelector(".mind-map-canvas");
  const before = tagMapZoom;
  tagMapZoom = Math.round(nextZoom * 100) / 100;
  if (canvas) {
    const rect = list.getBoundingClientRect();
    const focusX = event ? event.clientX - rect.left + list.scrollLeft : list.scrollLeft + rect.width / 2;
    const focusY = event ? event.clientY - rect.top + list.scrollTop : list.scrollTop + rect.height / 2;
    canvas.style.setProperty("--mind-map-zoom", tagMapZoom);
    if (before !== tagMapZoom) {
      const ratio = tagMapZoom / before;
      list.scrollLeft = focusX * ratio - (event ? event.clientX - rect.left : rect.width / 2);
      list.scrollTop = focusY * ratio - (event ? event.clientY - rect.top : rect.height / 2);
    }
  }
  updateTagZoomText();
}

function resetTagMapZoom() {
  setTagMapZoom(1);
}

function updateTagZoomText() {
  const label = document.getElementById("tagZoomText");
  if (label) label.textContent = `${Math.round(tagMapZoom * 100)}%`;
}

function renderHistory() {
  const filter = document.getElementById("historyFilter").value;
  const logs = state.logs.filter((log) => filter === "all" || log.result === filter);
  document.getElementById("historyList").innerHTML = logs.length
    ? logs.map((log) => {
      const item = findItem(log.sourceType, log.sourceId);
      const title = item ? (log.sourceType === "study" ? item.title : item.location || firstLine(item.question) || "未命名错题") : "已删除内容";
      return `
        <article class="history-card">
          <div class="meta">
            <span>${formatDate(log.date)}</span>
            <span>${TYPE_LABEL[log.sourceType]}</span>
            <span>${log.recallPercent != null ? `记住 ${log.recallPercent}%` : RESULT_LABEL[log.result]}</span>
            <span>分数 ${log.beforeScore} → ${log.afterScore}</span>
          </div>
          <h4 class="card-title">${escapeHtml(title)}</h4>
          ${log.notes ? `<p class="body-text">${escapeHtml(log.notes)}</p>` : ""}
        </article>
      `;
    }).join("")
    : empty("还没有复习记录。");
}

function openStudyRecord(studyId, taskId = "") {
  const study = state.study.find((item) => item.id === studyId);
  if (!study) {
    toast("没有找到这条学习记录。");
    return;
  }
  document.getElementById("studyRecordTitle").textContent = `学习记录：${study.title || "未命名学习"}`;
  const form = document.getElementById("studyRecordForm");
  form.reset();
  formField(form, "sourceType").value = "study";
  formField(form, "sourceId").value = study.id;
  formField(form, "taskId").value = taskId || "";
  formField(form, "logId").value = "";
  setStudyRecordRecallPercent(80);
  document.getElementById("studySectionScores").innerHTML = renderStudySectionScoreInputs(study);
  updateStudyRecordAggregateFromSections();
  document.getElementById("studyRecordHistoryList").innerHTML = renderStudyHistoryList(study);
  openModal("studyRecordModal");
}

function renderStudySectionScoreInputs(study) {
  const sections = studySectionTags(study);
  setText("studyRecordRecallLabel", sections.length ? "章节加权记忆分" : "这次记住了多少？");
  if (!sections.length) return "";
  return `
    <div class="section-score-head">
      <strong>分小节记录</strong>
      <span>按知识点重要性加权</span>
    </div>
    ${sections.map((tag) => {
      const score = latestStudySectionScore(study.id, tag.id) ?? currentScore(study);
      const safeScore = clamp(Number(score) || 0, 0, 100);
      const weight = tagImportanceScoreWeight(tag);
      return `
        <div class="section-score-row" data-tag-id="${tag.id}" data-weight="${weight}">
          <div class="section-score-main">
            ${renderTagPill(tag)}
            <div class="section-score-controls">
              <label>
                重要性
                <select class="section-importance-select">
                  ${importanceOptions(tag.importance)}
                </select>
              </label>
              <span class="muted">权重 ${weight}</span>
            </div>
          </div>
          <label>
            <input class="section-score-number" type="number" min="0" max="100" step="1" value="${safeScore}" />
            %
          </label>
          <input class="section-score-range" type="range" min="0" max="100" step="1" value="${safeScore}" />
        </div>
      `;
    }).join("")}
  `;
}

function studySectionTags(study) {
  return tagsFor(study.tagIds).filter(isTreeKnowledgeTag);
}

function isTreeKnowledgeTag(tag) {
  return Boolean(tag?.parentId) || state.tags.some((child) => child.parentId === tag?.id);
}

function latestStudySectionScore(studyId, tagId) {
  const log = state.logs
    .filter((row) => row.sourceType === "study" && row.sourceId === studyId && Array.isArray(row.sectionScores))
    .sort((a, b) => (b.createdAt || b.date || "").localeCompare(a.createdAt || a.date || ""))
    .find((row) => row.sectionScores.some((section) => section.tagId === tagId));
  const section = log?.sectionScores.find((row) => row.tagId === tagId);
  return section ? Number(section.score) : null;
}

function tagImportanceScoreWeight(tag) {
  return TAG_SCORE_WEIGHT[tag?.importance] || TAG_SCORE_WEIGHT.medium;
}

function importanceOptions(selected = "medium") {
  return ["veryHigh", "high", "medium", "low"]
    .map((value) => `<option value="${value}" ${value === selected ? "selected" : ""}>${importanceLabel(value)}</option>`)
    .join("");
}

function renderStudyHistoryList(study) {
  const logs = state.logs
    .filter((log) => log.sourceType === "study" && log.sourceId === study.id)
    .sort((a, b) => (b.createdAt || b.date || "").localeCompare(a.createdAt || a.date || ""));
  const initialRecord = `
    <article class="history-card compact-history-card">
      <div class="meta">
        <span>初次记录</span>
        <span>${formatDate(study.date || study.createdAt?.slice(0, 10))}</span>
        <span>${studyKindLabel(study)}</span>
      </div>
      <p class="body-text">${escapeHtml(study.notes || "没有备注。")}</p>
    </article>
  `;
  const logRows = logs.map((log, index) => `
    <article class="history-card compact-history-card">
      <div class="meta">
        <span>第 ${logs.length - index} 次复习</span>
        <span>${formatDate(log.date)}</span>
        <span>记住 ${Number(log.recallPercent ?? log.afterScore ?? 0)}%</span>
        <span>分数 ${Number(log.beforeScore ?? 0)} → ${Number(log.afterScore ?? 0)}</span>
      </div>
      ${log.notes ? `<p class="body-text">${escapeHtml(log.notes)}</p>` : '<p class="body-text muted">没有填写本次备注。</p>'}
      ${renderSectionScoreSummary(log.sectionScores)}
      <div class="card-actions">
        <button class="small-button" onclick="openEditReview('${log.id}')">修改记录</button>
      </div>
    </article>
  `).join("");
  return `${logRows}${initialRecord}`;
}

function renderSectionScoreSummary(sectionScores = []) {
  if (!Array.isArray(sectionScores) || !sectionScores.length) return "";
  return `
    <div class="section-score-summary">
      ${sectionScores.map((section) => {
        const tag = state.tags.find((row) => row.id === section.tagId);
        const label = tag ? tagPath(tag) : "已删除知识点";
        return `<span>${escapeHtml(label)}：${Number(section.score)}%</span>`;
      }).join("")}
    </div>
  `;
}

function openMistakeRecord(mistakeId, taskId = "") {
  const mistake = state.mistakes.find((item) => item.id === mistakeId);
  if (!mistake) {
    toast("没有找到这道错题。");
    return;
  }
  document.getElementById("mistakeRecordTitle").textContent = `错题记录：${mistake.location || firstLine(mistake.question) || "未命名错题"}`;
  const form = document.getElementById("mistakeRecordForm");
  form.reset();
  formField(form, "sourceType").value = "mistake";
  formField(form, "sourceId").value = mistake.id;
  formField(form, "taskId").value = taskId || "";
  formField(form, "logId").value = "";
  setMistakeRecordRecallPercent(80);
  document.getElementById("mistakeRecordHistoryList").innerHTML = renderMistakeHistoryList(mistake);
  openModal("mistakeHistoryModal");
}

function renderMistakeHistoryList(mistake) {
  const logs = state.logs
    .filter((log) => log.sourceType === "mistake" && log.sourceId === mistake.id)
    .sort((a, b) => (b.createdAt || b.date || "").localeCompare(a.createdAt || a.date || ""));
  const initialReason = `
    <article class="history-card compact-history-card">
      <div class="meta">
        <span>初次记录</span>
        <span>${formatDate(mistake.date || mistake.createdAt?.slice(0, 10))}</span>
      </div>
      <p class="body-text">${escapeHtml(mistake.reason || "没有填写错因。")}</p>
    </article>
  `;
  const logRows = logs.map((log, index) => `
    <article class="history-card compact-history-card">
      <div class="meta">
        <span>第 ${logs.length - index} 次再错/复盘</span>
        <span>${formatDate(log.date)}</span>
        <span>记住 ${Number(log.recallPercent ?? log.afterScore ?? 0)}%</span>
        <span>分数 ${Number(log.beforeScore ?? 0)} → ${Number(log.afterScore ?? 0)}</span>
      </div>
      ${log.notes ? `<p class="body-text">${escapeHtml(log.notes)}</p>` : '<p class="body-text muted">没有填写本次错因。</p>'}
      <div class="card-actions">
        <button class="small-button" onclick="openEditReview('${log.id}')">修改记录</button>
      </div>
    </article>
  `).join("");
  return `${logRows}${initialReason}`;
}

function jumpToTagMistakes(tagId) {
  const tag = state.tags.find((row) => row.id === tagId);
  if (!tag) return;
  activeMistakeTagFilterId = tag.id;
  switchView("mistakes");
  renderMistakes();
}

function clearMistakeTagFilter() {
  activeMistakeTagFilterId = "";
  renderMistakes();
}

function renderMistakeTagFilterBar(tag) {
  const bar = document.getElementById("mistakeTagFilterBar");
  const text = document.getElementById("mistakeTagFilterText");
  if (!bar || !text) return;
  bar.classList.toggle("hidden", !tag);
  text.textContent = tag ? `当前知识点：${tagPath(tag)}，包含子知识点` : "";
}

function renderWeakTags() {
  const tagScoreCache = new Map();
  const summaries = state.tags.map((tag) => {
    const descendantIds = descendantTagIds(tag.id);
    const linked = getAllItems().filter((item) => (item.tagIds || []).some((tagId) => descendantIds.includes(tagId)));
    if (!linked.length) return null;
    const summary = tagMemorySummary(tag, tagScoreCache);
    if (summary.score == null) return null;
    const weakCount = linked.filter((item) => currentScore(item) < 60).length;
    return { tag, avg: summary.score, weakCount, mistakeCount: summary.mistakeCount || 0 };
  }).filter(Boolean)
    .sort((a, b) => a.avg - b.avg || b.weakCount - a.weakCount)
    .slice(0, 8);

  return summaries.length
    ? summaries.map(({ tag, avg, weakCount, mistakeCount }) => `
      <article class="tag-card">
        <div class="meta">
          ${renderTagPill(tag)}
          <span class="badge ${tag.importance}">${importanceLabel(tag.importance)}</span>
        </div>
        <p class="body-text">综合记忆分 ${avg}，薄弱内容 ${weakCount} 条${mistakeCount ? `，错题 ${mistakeCount} 道` : ""}</p>
      </article>
    `).join("")
    : empty("还没有可分析的知识点。");
}

function renderTagOptions() {
  document.getElementById("tagOptions").innerHTML = "";
}

function renderTagParentOptions() {
  const options = [
    '<option value="">无上级</option>',
    ...tagTreeRows()
      .map(({ tag, depth }) => `<option value="${escapeHtml(tag.id)}">${escapeHtml(treeOptionLabel(tag, depth))}</option>`),
  ].join("");
  document.querySelectorAll(".tag-parent-select").forEach((select) => {
    const previous = select.value;
    select.innerHTML = options;
    if ([...select.options].some((option) => option.value === previous)) select.value = previous;
  });
}

function renderExistingTagSelectors() {
  renderTagPicker("study");
  renderTagPicker("mistake");
}

function renderTagPicker(kind) {
  const tree = document.getElementById(`${kind}ExistingTagTree`);
  const current = document.getElementById(`${kind}TagPickerCurrent`);
  if (!tree || !current) return;
  const selected = state.tags.find((tag) => tag.id === selectedPickerTagIds[kind]);
  current.innerHTML = selected
    ? `已选择：<strong>${escapeHtml(tagPath(selected))}</strong>`
    : "尚未选择知识点";
  const query = document.getElementById(`${kind}TagPickerSearch`)?.value.trim().toLowerCase() || "";
  const roots = uniqueTagTreeRows().filter(({ depth }) => depth === 0).map(({ tag }) => tag);
  const visibleIds = query ? visibleTagIdsForQuery(query) : null;
  const html = roots.map((tag) => renderTagPickerNode(kind, tag, query, visibleIds)).filter(Boolean).join("");
  tree.innerHTML = state.tags.length ? (html || empty("没有找到匹配的知识点。")) : empty("还没有知识点。");
  renderTreeParentHint(kind);
}

function renderTagPickerNode(kind, tag, query = "", visibleIds = null) {
  if (visibleIds && !visibleIds.has(tag.id)) return "";
  const children = state.tags
    .filter((child) => child.parentId === tag.id)
    .sort((a, b) => a.name.localeCompare(b.name, "zh-CN"));
  const childHtml = children.map((child) => renderTagPickerNode(kind, child, query, visibleIds)).filter(Boolean).join("");
  const hasChildren = children.length > 0;
  const isCollapsed = tagPickerCollapsedIds[kind]?.has(tag.id) && !query;
  const selected = selectedPickerTagIds[kind] === tag.id;
  const parentSelected = selectedTreeParentIds[kind] === tag.id;
  const match = query && tagMatchesPickerQuery(tag, query);
  const encodedId = encodeURIComponent(tag.id);
  return `
    <div class="knowledge-picker-node ${selected ? "selected" : ""} ${parentSelected ? "parent-selected" : ""}">
      <div class="knowledge-picker-row">
        ${hasChildren ? `<button class="picker-toggle" onclick="toggleTagPickerNode('${kind}', decodeURIComponent('${encodedId}'))" type="button" aria-label="${isCollapsed ? "展开" : "收起"}">${isCollapsed ? "+" : "-"}</button>` : '<span class="picker-toggle placeholder"></span>'}
        <button class="picker-node-main ${match ? "search-hit" : ""}" onclick="selectKnowledgeTag('${kind}', decodeURIComponent('${encodedId}'))" type="button">
          <span>${escapeHtml(tag.name)}</span>
          ${parentSelected ? '<em>添加位置</em>' : ""}
        </button>
      </div>
      ${hasChildren && (!isCollapsed || query) && childHtml ? `<div class="knowledge-picker-children">${childHtml}</div>` : ""}
    </div>
  `;
}

function visibleTagIdsForQuery(query) {
  const ids = new Set();
  for (const tag of state.tags) {
    if (!tagMatchesPickerQuery(tag, query)) continue;
    for (const chainTag of tagAncestorChain(tag).reverse()) ids.add(chainTag.id);
  }
  return ids;
}

function tagMatchesPickerQuery(tag, query) {
  return [tag.name, tagPath(tag), importanceLabel(tag.importance), ...(tag.questionTypes || [])]
    .join(" ")
    .toLowerCase()
    .includes(query);
}

function renderDeleteTagSelector() {
  const options = [
    '<option value="">选择要删除的知识点</option>',
    ...tagTreeRows()
      .map(({ tag, depth }) => `<option value="${escapeHtml(tag.id)}">${escapeHtml(treeOptionLabel(tag, depth))}</option>`),
  ].join("");
  const select = document.getElementById("deleteTagSelect");
  if (!select) return;
  const previous = select.value;
  select.innerHTML = options;
  if ([...select.options].some((option) => option.value === previous)) select.value = previous;
}

function renderSelectedTagChips() {
  renderSelectedTagChipsFor("#studyForm [name='tags']", "studySelectedTags");
  renderSelectedTagChipsFor("#mistakeForm [name='tags']", "mistakeSelectedTags");
}

function renderSimpleTagChoices() {
  const tags = simpleTagChoices();
  ["study", "mistake"].forEach((kind) => {
    const container = document.getElementById(`${kind}SimpleTagChoices`);
    if (!container) return;
    container.innerHTML = tags.length
      ? tags.map((tag) => `
        <span class="simple-tag-choice">
          <button type="button" onclick="addSimpleTagChoice('${kind}', '${tag.id}')">${escapeHtml(tag.name)}</button>
          <button class="simple-tag-delete" type="button" aria-label="删除 ${escapeHtml(tag.name)}" onclick="deleteSimpleTagChoice('${tag.id}')">×</button>
        </span>
      `).join("")
      : '<span class="muted">还没有普通标签，输入后会自动保存到这里。</span>';
  });
}

function simpleTagChoices() {
  const parentIds = new Set(state.tags.map((tag) => tag.parentId).filter(Boolean));
  return state.tags
    .filter((tag) => !tag.parentId && !parentIds.has(tag.id))
    .sort((a, b) => a.name.localeCompare(b.name, "zh-CN"));
}

function renderSelectedTagChipsFor(inputSelector, containerId) {
  const input = document.querySelector(inputSelector);
  const container = document.getElementById(containerId);
  if (!input || !container) return;
  const tags = uniqueTagNames(parseTags(input.value));
  if (input.value !== tags.join("，")) input.value = tags.join("，");
  container.innerHTML = tags.length
    ? tags.map((tag) => `
      <span class="selected-tag">
        ${escapeHtml(tag)}
        <button type="button" aria-label="移除 ${escapeHtml(tag)}" onclick="removeTagFromField('${containerId}', decodeURIComponent('${encodeURIComponent(tag)}'))">×</button>
      </span>
    `).join("")
    : '<span class="muted">尚未添加标签</span>';
}

function renderStudyTreeBuilder() {
  renderTreeBuilder("study");
}

function renderMistakeTreeBuilder() {
  renderTreeBuilder("mistake");
}

function renderTreeBuilder(kind) {
  const builder = document.getElementById(`${kind}TreeBuilder`);
  if (!builder) return;
  if (!builder.children.length) addTreeLevel(kind, "", false);
  renderTreeParentHint(kind);
  updateTreeLevelLabels(kind);
}

function addStudyTreeLevel(value = "", shouldFocus = true) {
  addTreeLevel("study", value, shouldFocus);
}

function addMistakeTreeLevel(value = "", shouldFocus = true) {
  addTreeLevel("mistake", value, shouldFocus);
}

function addTreeLevel(kind, value = "", shouldFocus = true) {
  const builder = document.getElementById(`${kind}TreeBuilder`);
  if (!builder) return;
  treeLevelCounters[kind] = (treeLevelCounters[kind] || 0) + 1;
  const row = document.createElement("div");
  row.className = "tree-builder-row";
  row.dataset.levelId = String(treeLevelCounters[kind]);
  row.innerHTML = `
    <span class="level-index"></span>
    <input class="${kind}-tree-level-input" placeholder="输入本级知识点或完整链条" value="${escapeHtml(value)}" />
    <button class="small-button danger remove-level-button" type="button">删除这级</button>
  `;
  row.querySelector(".remove-level-button").addEventListener("click", () => {
    if (builder.children.length === 1) {
      row.querySelector(`.${kind}-tree-level-input`).value = "";
    } else {
      row.remove();
    }
    updateTreeLevelLabels(kind);
  });
  builder.append(row);
  updateTreeLevelLabels(kind);
  if (shouldFocus) row.querySelector(`.${kind}-tree-level-input`).focus();
}

function clearStudyTreeBuilder() {
  clearTreeBuilder("study");
}

function clearMistakeTreeBuilder() {
  clearTreeBuilder("mistake");
}

function clearTreeBuilder(kind) {
  const builder = document.getElementById(`${kind}TreeBuilder`);
  if (!builder) return;
  builder.innerHTML = "";
  addTreeLevel(kind, "", false);
}

function updateTreeLevelLabels(kind) {
  document.querySelectorAll(`#${kind}TreeBuilder .tree-builder-row`).forEach((row, index) => {
    row.querySelector(".level-index").textContent = `第 ${index + 1} 级`;
  });
}

function collectStudyTreeParts() {
  return collectTreeParts("study");
}

function collectMistakeTreeParts() {
  return collectTreeParts("mistake");
}

function collectTreeParts(kind) {
  return [...document.querySelectorAll(`#${kind}TreeBuilder .${kind}-tree-level-input`)]
    .flatMap((input) => splitTagPath(input.value))
    .map((part) => part.trim())
    .filter(Boolean);
}

async function saveStudy(event) {
  event.preventDefault();
  const form = event.currentTarget;
  const data = new FormData(form);
  const editId = data.get("id");
  const existing = editId ? state.study.find((item) => item.id === editId) : null;
  const tagIds = await ensureTags(parseTags(data.get("tags")));
  const item = {
    ...(existing || {}),
    id: existing?.id || id("study"),
    title: data.get("title").trim(),
    date: data.get("date"),
    studyKind: data.get("studyKind") || "new",
    notes: data.get("notes").trim(),
    tagIds,
    memoryScore: existing?.memoryScore ?? 70,
    currentIntervalIndex: existing?.currentIntervalIndex ?? 0,
    currentInterval: existing?.currentInterval ?? 1,
    lastRecallPercent: existing?.lastRecallPercent,
    lastReviewedAt: existing?.lastReviewedAt,
    createdAt: existing?.createdAt || now(),
    updatedAt: now(),
  };
  await put("study", item);
  if (!existing) await createNextTask("study", item, item.date);
  await refreshSchedule();
  form.reset();
  setDefaultDates();
  form.closest("dialog").close();
  toast(existing ? "学习记录已更新。" : "学习记录已保存，并生成复习计划。");
  render();
}

async function saveMistake(event) {
  event.preventDefault();
  const form = event.currentTarget;
  const data = new FormData(form);
  const editId = data.get("id");
  const existing = editId ? state.mistakes.find((item) => item.id === editId) : null;
  const selectedImage = data.get("image") && data.get("image").size ? await fileToDataUrl(data.get("image")) : "";
  const image = pastedMistakeImage || selectedImage || (data.get("removeImage") === "1" ? "" : existing?.image || "");
  const tagIds = await ensureTags(parseTags(data.get("tags")));
  const item = {
    ...(existing || {}),
    id: existing?.id || id("mistake"),
    location: data.get("location").trim(),
    question: data.get("question").trim(),
    answer: data.get("answer").trim(),
    reason: data.get("reason").trim(),
    image,
    tagIds,
    memoryScore: existing?.memoryScore ?? 60,
    currentIntervalIndex: existing?.currentIntervalIndex ?? 0,
    currentInterval: existing?.currentInterval ?? 1,
    lastRecallPercent: existing?.lastRecallPercent,
    lastReviewedAt: existing?.lastReviewedAt,
    date: existing?.date || toDateInput(new Date()),
    createdAt: existing?.createdAt || now(),
    updatedAt: now(),
  };
  await put("mistakes", item);
  if (!existing) await createNextTask("mistake", item, item.date);
  await refreshSchedule();
  form.reset();
  clearMistakeImage();
  form.closest("dialog").close();
  toast(existing ? "错题已更新。" : "错题已保存，并加入复习计划。");
  render();
}

async function addManualSimpleTags(kind) {
  const input = document.getElementById(`${kind}ManualTagInput`);
  const target = document.querySelector(`#${kind}Form [name='tags']`);
  const names = parseTags(input.value);
  if (!names.length) {
    toast("先输入普通标签名。");
    return;
  }
  for (const name of names) {
    const tag = await createOrUpdateTag({ name, parentId: "", importance: "medium" });
    appendTagToInput(target, tag.name);
  }
  input.value = "";
  await refreshAfterTagChange();
  toast("普通标签已添加并保存到备选。");
}

function handleManualTagInputKeydown(event) {
  if (event.key !== "Enter") return;
  event.preventDefault();
  const kind = event.currentTarget.id.startsWith("study") ? "study" : "mistake";
  addManualSimpleTags(kind);
}

function addSimpleTagChoice(kind, tagId) {
  const tag = state.tags.find((row) => row.id === tagId);
  if (!tag) return;
  appendTagToInput(document.querySelector(`#${kind}Form [name='tags']`), tag.name);
}

async function deleteSimpleTagChoice(tagId) {
  const tag = state.tags.find((row) => row.id === tagId);
  if (!tag) return;
  removeTagValueFromOpenForms(tag.name);
  await deleteTag(tag.id);
}

async function createStudyTreeTag() {
  await createTreeTag({
    kind: "study",
    importanceId: "studyTreeImportance",
    targetSelector: "#studyForm [name='tags']",
    emptyMessage: "先填写至少一级树状标签。",
    successLabel: "树状标签",
  });
}

async function createMistakeTreeTag() {
  await createTreeTag({
    kind: "mistake",
    importanceId: "mistakeTreeImportance",
    targetSelector: "#mistakeForm [name='tags']",
    emptyMessage: "先填写至少一级错题树状标签。",
    successLabel: "错题树状标签",
  });
}

async function createTreeTag({ kind, importanceId, targetSelector, emptyMessage, successLabel }) {
  const parts = collectTreeParts(kind);
  if (!parts.length) {
    toast(emptyMessage);
    return;
  }
  const importance = document.getElementById(importanceId).value;
  const parentId = selectedTreeParentIds[kind] || "";
  const tag = await createTagChain(parts, parentId, importance);
  appendTagToInput(document.querySelector(targetSelector), tagPath(tag));
  clearTreeBuilder(kind);
  await refreshAfterTagChange();
  toast(`已添加${successLabel}“${tagPath(tag)}”。`);
}

function addExistingStudyTag() {
  const tag = state.tags.find((row) => row.id === selectedPickerTagIds.study);
  if (!tag) {
    toast("先选择一个已有知识点。");
    return;
  }
  appendTagToInput(document.querySelector("#studyForm [name='tags']"), tagPath(tag));
  toast("已添加到学习记录。");
}

function addExistingMistakeTag() {
  const tag = state.tags.find((row) => row.id === selectedPickerTagIds.mistake);
  if (!tag) {
    toast("先选择一个已有知识点。");
    return;
  }
  appendTagToInput(document.querySelector("#mistakeForm [name='tags']"), tagPath(tag));
  toast("已添加到错题关联知识点。");
}

function selectKnowledgeTag(kind, tagId) {
  const tag = state.tags.find((row) => row.id === tagId);
  if (!tag) return;
  selectedPickerTagIds[kind] = tag.id;
  selectedTreeParentIds[kind] = tag.id;
  renderTagPicker(kind);
  toast(`已设为添加位置：${tagPath(tag)}`);
}

function setTreeParentFromSelected(kind) {
  const tag = state.tags.find((row) => row.id === selectedPickerTagIds[kind]);
  if (!tag) {
    toast("先选择一个已有知识点。");
    return;
  }
  selectedTreeParentIds[kind] = tag.id;
  renderTagPicker(kind);
  toast(`已设为添加位置：${tagPath(tag)}`);
}

function clearTreeParent(kind) {
  selectedTreeParentIds[kind] = "";
  renderTagPicker(kind);
}

function renderTreeParentHint(kind) {
  const hint = document.getElementById(`${kind}TreeParentHint`);
  if (!hint) return;
  const tag = state.tags.find((row) => row.id === selectedTreeParentIds[kind]);
  hint.querySelector("span").innerHTML = tag
    ? `添加位置：<strong>${escapeHtml(tagPath(tag))}</strong>`
    : "添加位置：无上级";
}

function clearTagPickerSearch(kind) {
  const input = document.getElementById(`${kind}TagPickerSearch`);
  if (input) input.value = "";
  renderTagPicker(kind);
}

function toggleTagPickerNode(kind, tagId) {
  const set = tagPickerCollapsedIds[kind] || new Set();
  if (set.has(tagId)) set.delete(tagId);
  else set.add(tagId);
  tagPickerCollapsedIds[kind] = set;
  renderTagPicker(kind);
}

function expandTagPicker(kind) {
  tagPickerCollapsedIds[kind] = new Set();
  renderTagPicker(kind);
}

function collapseTagPicker(kind) {
  const parentIds = new Set(state.tags.map((tag) => tag.parentId).filter(Boolean));
  tagPickerCollapsedIds[kind] = parentIds;
  renderTagPicker(kind);
}

function resetTagPicker(kind) {
  selectedPickerTagIds[kind] = "";
  selectedTreeParentIds[kind] = "";
  const input = document.getElementById(`${kind}TagPickerSearch`);
  if (input) input.value = "";
  renderTagPicker(kind);
}

async function deleteExistingTagFromSelect(kind) {
  const tag = state.tags.find((row) => row.id === selectedPickerTagIds[kind]);
  if (!tag) {
    toast("先选择要删除的知识点。");
    return;
  }
  removeTagValueFromOpenForms(tagPath(tag));
  selectedPickerTagIds[kind] = "";
  if (selectedTreeParentIds[kind] === tag.id) selectedTreeParentIds[kind] = "";
  await deleteTag(tag.id);
}

async function addTagChain() {
  const input = document.getElementById("tagChainInput");
  const importance = document.getElementById("tagChainImportance").value;
  const parts = splitTagPath(input.value);
  if (!parts.length) {
    toast("先输入知识点链条。");
    return;
  }
  const tag = await createTagChain(parts, "", importance);
  lastChainTagId = tag.id;
  input.value = "";
  await refreshAfterTagChange();
  document.getElementById("continueTagParent").value = tag.id;
  document.getElementById("lastChainHint").textContent = `已添加：${tagPath(tag)}。可以继续在它下面添加分支。`;
  toast(`已添加整条链“${tagPath(tag)}”。`);
}

async function continueTagBranch() {
  const parentSelect = document.getElementById("continueTagParent");
  const nameInput = document.getElementById("continueTagName");
  const parentId = parentSelect.value || lastChainTagId;
  const parts = splitTagPath(nameInput.value);
  if (!parentId) {
    toast("先选择一个要继续添加分支的知识点。");
    return;
  }
  if (!parts.length) {
    toast("先输入要添加的分支名称。");
    return;
  }
  const parent = state.tags.find((tag) => tag.id === parentId);
  const tag = await createTagChain(parts, parentId, parent?.importance || "medium");
  lastChainTagId = tag.id;
  nameInput.value = "";
  await refreshAfterTagChange();
  document.getElementById("continueTagParent").value = tag.id;
  document.getElementById("lastChainHint").textContent = `已继续添加：${tagPath(tag)}。`;
  toast(`已添加分支“${tagPath(tag)}”。`);
}

async function refreshAfterTagChange() {
  await loadState();
  renderTagOptions();
  renderTagParentOptions();
  renderExistingTagSelectors();
  renderDeleteTagSelector();
  renderSimpleTagChoices();
  renderStudyTreeBuilder();
  renderMistakeTreeBuilder();
  renderSelectedTagChips();
  renderTags();
  renderDashboard();
}

async function pasteMistakeImage(event) {
  const items = [...(event.clipboardData?.items || [])];
  const imageItem = items.find((item) => item.type.startsWith("image/"));
  if (!imageItem) {
    toast("剪贴板里没有图片。");
    return;
  }
  event.preventDefault();
  event.stopPropagation();
  pastedMistakeImage = await fileToDataUrl(imageItem.getAsFile());
  document.querySelector("#mistakeForm [name='image']").value = "";
  document.querySelector("#mistakeForm [name='removeImage']").value = "";
  showMistakeImagePreview(pastedMistakeImage);
  toast("图片已粘贴。");
}

async function previewMistakeFile(event) {
  const file = event.target.files[0];
  if (!file) return;
  pastedMistakeImage = "";
  document.querySelector("#mistakeForm [name='removeImage']").value = "";
  showMistakeImagePreview(await fileToDataUrl(file));
}

function showMistakeImagePreview(dataUrl) {
  document.getElementById("mistakeImagePreviewImg").src = dataUrl;
  document.getElementById("mistakeImagePreview").classList.remove("hidden");
}

function clearMistakeImage(markRemoval = false) {
  pastedMistakeImage = "";
  const fileInput = document.querySelector("#mistakeForm [name='image']");
  if (fileInput) fileInput.value = "";
  const removeInput = document.querySelector("#mistakeForm [name='removeImage']");
  if (removeInput && markRemoval) removeInput.value = "1";
  document.getElementById("mistakeImagePreviewImg").removeAttribute("src");
  document.getElementById("mistakeImagePreview").classList.add("hidden");
}

async function saveTag(event) {
  event.preventDefault();
  const form = event.currentTarget;
  const data = new FormData(form);
  const name = data.get("name").trim();
  if (!name) return;
  const branchMode = data.get("branchMode");
  const parentId = branchMode === "child" ? data.get("parentId") : "";
  if (branchMode === "child" && !parentId) {
    toast("选择子分支时，需要先选一个上级知识点。");
    return;
  }
  const parts = splitTagPath(name);
  const savedTag = parts.length > 1
    ? await createTagChain(parts, parentId, data.get("importance"), data.get("color"))
    : await createOrUpdateTag({
      name,
      parentId,
      color: data.get("color"),
      importance: data.get("importance"),
    });
  lastChainTagId = savedTag.id;
  await loadState();
  form.reset();
  toast(`知识点“${tagPath(savedTag)}”已保存。`);
  render();
}

async function saveSettings(event) {
  event.preventDefault();
  const data = new FormData(event.currentTarget);
  state.settings = {
    ...state.settings,
    id: "main",
    examDate: data.get("examDate"),
    cramWindow: Number(data.get("cramWindow")) || 14,
    dailyCramLimit: Number(data.get("dailyCramLimit")) || 20,
    dailyReviewLimit: clamp(Number(data.get("dailyReviewLimit")) || 6, 1, 80),
    updatedAt: now(),
  };
  await put("settings", state.settings);
  await refreshSchedule();
  toast("设置已保存。");
  render();
}

async function saveReview(event) {
  event.preventDefault();
  const form = event.currentTarget;
  const saved = await persistReviewForm(form);
  if (!saved) return;
  form.reset();
  form.closest("dialog").close();
  toast(saved.updated ? "复习记录已修改。" : `已记录为“记住 ${saved.recallPercent}%”，下一次复习已更新。`);
  render();
}

async function saveStudyRecord(event) {
  event.preventDefault();
  const form = event.currentTarget;
  const saved = await persistReviewForm(form);
  if (!saved) return;
  formField(form, "logId").value = "";
  formField(form, "notes").value = "";
  setStudyRecordRecallPercent(80);
  const study = findItem("study", saved.sourceId);
  if (study) document.getElementById("studyRecordHistoryList").innerHTML = renderStudyHistoryList(study);
  toast(saved.updated ? "学习记录已修改。" : `已保存学习记录，记住 ${saved.recallPercent}%。`);
  render();
}

async function saveMistakeRecord(event) {
  event.preventDefault();
  const form = event.currentTarget;
  const saved = await persistReviewForm(form);
  if (!saved) return;
  formField(form, "logId").value = "";
  formField(form, "notes").value = "";
  setMistakeRecordRecallPercent(80);
  const mistake = findItem("mistake", saved.sourceId);
  if (mistake) document.getElementById("mistakeRecordHistoryList").innerHTML = renderMistakeHistoryList(mistake);
  toast(saved.updated ? "错题记录已修改。" : `已保存错题记录，记住 ${saved.recallPercent}%。`);
  render();
}

async function persistReviewForm(form) {
  const data = new FormData(form);
  const sourceType = data.get("sourceType");
  const sourceId = data.get("sourceId");
  const taskId = data.get("taskId");
  const logId = data.get("logId");
  const sectionScores = collectStudySectionScores(form, sourceType);
  const recallPercent = sectionScores.length
    ? weightedSectionScore(sectionScores)
    : clamp(Number(data.get("recallPercent") || 0), 0, 100);
  const result = resultFromPercent(recallPercent);
  const item = findItem(sourceType, sourceId);
  if (!item) return null;

  if (logId) {
    await updateReviewLog({ logId, sourceType, sourceId, taskId, recallPercent, result, notes: data.get("notes").trim(), sectionScores });
    return { updated: true, sourceType, sourceId, recallPercent };
  }

  const logCreatedAt = now();
  const logDate = toDateInput(new Date());
  const newLogId = id("log");
  const beforeScore = currentScore(item);
  const beforeIntervalIndex = item.currentIntervalIndex || 0;
  const beforeInterval = item.currentInterval || BASE_INTERVALS[beforeIntervalIndex] || 1;
  const afterScore = memoryScoreFromReview(sourceType, sourceId, {
    id: newLogId,
    recallPercent,
    sectionScores,
    createdAt: logCreatedAt,
    date: logDate,
  });
  const delta = afterScore - beforeScore;
  const nextIntervalState = intervalStateAfterReview(item, recallPercent, beforeScore);

  item.memoryScore = afterScore;
  item.currentIntervalIndex = nextIntervalState.index;
  item.currentInterval = nextIntervalState.interval;
  item.lastRecallPercent = recallPercent;
  item.lastReviewedAt = toDateInput(new Date());
  item.updatedAt = now();

  await put(sourceType === "study" ? "study" : "mistakes", item);
  if (taskId && !taskId.startsWith("cram-")) {
    const task = state.tasks.find((row) => row.id === taskId);
    if (task) {
      task.status = "done";
      task.completedAt = now();
      task.result = result;
      task.recallPercent = recallPercent;
      await put("tasks", task);
    }
  }
  for (const task of state.tasks.filter((row) => row.status === "pending" && row.sourceType === sourceType && row.sourceId === sourceId && row.scheduledDate <= toDateInput(new Date()))) {
    task.status = "done";
    task.completedAt = now();
    task.result = result;
    task.recallPercent = recallPercent;
    await put("tasks", task);
  }

  await put("logs", {
    id: newLogId,
    sourceType,
    sourceId,
    taskId,
    result,
    recallPercent,
    sectionScores,
    notes: data.get("notes").trim(),
    beforeScore,
    afterScore,
    delta,
    beforeIntervalIndex,
    beforeInterval,
    afterIntervalIndex: nextIntervalState.index,
    afterInterval: nextIntervalState.interval,
    date: logDate,
    createdAt: logCreatedAt,
  });

  await createNextTask(sourceType, item, toDateInput(new Date()), result);
  await refreshSchedule();
  return { updated: false, sourceType, sourceId, recallPercent };
}

function collectStudySectionScores(form, sourceType) {
  if (sourceType !== "study" || form.id !== "studyRecordForm") return [];
  return [...document.querySelectorAll("#studySectionScores .section-score-row")]
    .map((row) => ({
      tagId: row.dataset.tagId,
      score: clamp(Number(row.querySelector(".section-score-number")?.value || 0), 0, 100),
      weight: Number(row.dataset.weight) || TAG_SCORE_WEIGHT.medium,
    }))
    .filter((section) => section.tagId);
}

function weightedSectionScore(sectionScores = []) {
  const totalWeight = sectionScores.reduce((sum, section) => sum + (Number(section.weight) || 0), 0);
  if (!totalWeight) return 0;
  return Math.round(sectionScores.reduce((sum, section) => sum + Number(section.score) * Number(section.weight), 0) / totalWeight);
}

async function updateReviewLog({ logId, sourceType, sourceId, taskId, recallPercent, result, notes, sectionScores = [] }) {
  const log = state.logs.find((row) => row.id === logId);
  const item = findItem(sourceType, sourceId);
  if (!log || !item) return;
  const beforeScore = Number(log.beforeScore ?? currentScore(item));
  const afterScore = memoryScoreFromReview(sourceType, sourceId, {
    ...log,
    recallPercent,
    result,
    notes,
    sectionScores: sectionScores.length ? sectionScores : log.sectionScores,
  });
  const isLatestLog = latestLogFor(sourceType, sourceId)?.id === log.id;
  const intervalBase = {
    ...item,
    currentIntervalIndex: log.beforeIntervalIndex ?? item.currentIntervalIndex,
    currentInterval: log.beforeInterval ?? item.currentInterval,
  };
  const intervalState = isLatestLog ? intervalStateAfterReview(intervalBase, recallPercent, beforeScore) : null;
  item.memoryScore = afterScore;
  if (intervalState) {
    item.currentIntervalIndex = intervalState.index;
    item.currentInterval = intervalState.interval;
    item.lastRecallPercent = recallPercent;
  }
  item.updatedAt = now();
  if (log.date === toDateInput(new Date())) item.lastReviewedAt = log.date;
  await put(sourceType === "study" ? "study" : "mistakes", item);

  log.result = result;
  log.recallPercent = recallPercent;
  if (sectionScores.length) log.sectionScores = sectionScores;
  log.notes = notes;
  log.afterScore = afterScore;
  log.delta = afterScore - beforeScore;
  if (intervalState) {
    log.afterIntervalIndex = intervalState.index;
    log.afterInterval = intervalState.interval;
  }
  log.updatedAt = now();
  await put("logs", log);

  const doneTaskId = taskId || log.taskId;
  if (doneTaskId && !doneTaskId.startsWith("cram-")) {
    const task = state.tasks.find((row) => row.id === doneTaskId);
    if (task) {
      task.result = result;
      task.recallPercent = recallPercent;
      task.updatedAt = now();
      await put("tasks", task);
    }
  }

  for (const task of state.tasks.filter((row) => row.status === "pending" && row.sourceType === sourceType && row.sourceId === sourceId)) {
    task.priority = priorityScore(item, Boolean(task.isCram));
    if (intervalState && log.date === toDateInput(new Date())) {
      task.earliestDate = capAtExam(addDays(log.date, intervalState.interval)) || task.earliestDate || task.scheduledDate;
      task.scheduledDate = task.earliestDate || task.scheduledDate;
      task.intervalDays = intervalState.interval;
    }
    task.updatedAt = now();
    await put("tasks", task);
  }
  await refreshSchedule();
}

async function createNextTask(sourceType, item, fromDate, result = "") {
  if (state.settings.examDate && fromDate >= state.settings.examDate) return;
  const interval = Math.max(1, Number(item.currentInterval || 1));
  const earliestDate = capAtExam(addDays(fromDate, interval));
  if (!earliestDate) return;
  const priority = priorityScore(item, false);
  await put("tasks", {
    id: id("task"),
    sourceType,
    sourceId: item.id,
    earliestDate,
    scheduledDate: earliestDate,
    status: "pending",
    priority,
    isCram: false,
    intervalDays: interval,
    createdByResult: result,
    createdAt: now(),
  });
}

function buildDisplayTasks() {
  const pending = state.tasks
    .filter((task) => task.status === "pending" && findItem(task.sourceType, task.sourceId))
    .map((task) => {
      const item = findItem(task.sourceType, task.sourceId);
      return {
        ...task,
        earliestDate: task.earliestDate || task.scheduledDate,
        priority: priorityScore(item, Boolean(task.isCram)),
      };
    });
  for (const cramTask of buildCramTasks()) {
    const existing = pending.find((task) => task.sourceType === cramTask.sourceType && task.sourceId === cramTask.sourceId);
    if (existing) {
      existing.isCram = true;
      existing.priority = Math.max(existing.priority || 0, cramTask.priority || 0);
      existing.earliestDate = minDate(existing.earliestDate || existing.scheduledDate, cramTask.earliestDate || cramTask.scheduledDate);
    } else {
      pending.push(cramTask);
    }
  }
  return applyDailyCapacity(pending);
}

function applyDailyCapacity(tasks) {
  const today = toDateInput(new Date());
  const limit = dailyReviewLimit();
  const counts = new Map();
  return tasks
    .map((task) => ({
      ...task,
      earliestDate: task.earliestDate || task.scheduledDate || today,
    }))
    .filter((task) => !state.settings.examDate || task.earliestDate <= state.settings.examDate)
    .sort(taskQueueSort)
    .map((task) => {
      let scheduledDate = maxDate(task.earliestDate, today);
      while ((counts.get(scheduledDate) || 0) >= limit) {
        scheduledDate = addDays(scheduledDate, 1);
        if (state.settings.examDate && scheduledDate > state.settings.examDate) break;
      }
      if (state.settings.examDate && scheduledDate > state.settings.examDate) {
        return { ...task, scheduledDate: "" };
      }
      counts.set(scheduledDate, (counts.get(scheduledDate) || 0) + 1);
      return { ...task, scheduledDate };
    })
    .filter((task) => task.scheduledDate);
}

function taskQueueSort(a, b) {
  const today = toDateInput(new Date());
  const aEarliest = a.earliestDate || a.scheduledDate || today;
  const bEarliest = b.earliestDate || b.scheduledDate || today;
  const aDue = aEarliest <= today;
  const bDue = bEarliest <= today;
  if (aDue && bDue && (a.priority || 0) !== (b.priority || 0)) return (b.priority || 0) - (a.priority || 0);
  if (aDue !== bDue) return aDue ? -1 : 1;
  if (aEarliest !== bEarliest) return aEarliest.localeCompare(bEarliest);
  return (b.priority || 0) - (a.priority || 0);
}

function dailyReviewLimit() {
  return clamp(Number(state.settings.dailyReviewLimit) || 6, 1, 80);
}

async function refreshSchedule() {
  await loadState();
  await migratePendingTaskEarliestDates();
  await loadState();
  await rebalanceReviewQueue();
  await loadState();
}

async function migratePendingTaskEarliestDates() {
  for (const task of state.tasks.filter((row) => row.status === "pending" && !row.isCram && findItem(row.sourceType, row.sourceId))) {
    const item = findItem(task.sourceType, task.sourceId);
    const nextIntervalState = migratedIntervalStateForTask(task, item);
    if (!nextIntervalState) continue;
    const earliestDate = capAtExam(addDays(nextIntervalState.fromDate, nextIntervalState.interval));
    if (!earliestDate) continue;
    if (item.currentIntervalIndex !== nextIntervalState.index || item.currentInterval !== nextIntervalState.interval) {
      await put(task.sourceType === "study" ? "study" : "mistakes", {
        ...item,
        currentIntervalIndex: nextIntervalState.index,
        currentInterval: nextIntervalState.interval,
        lastRecallPercent: nextIntervalState.recallPercent,
        updatedAt: now(),
      });
    }
    if (task.earliestDate === earliestDate && task.intervalDays === nextIntervalState.interval) continue;
    await put("tasks", {
      ...task,
      earliestDate,
      scheduledDate: earliestDate,
      intervalDays: nextIntervalState.interval,
      priority: priorityScore(item, false),
      updatedAt: now(),
    });
  }
}

function migratedIntervalStateForTask(task, item) {
  const latest = latestLogFor(task.sourceType, task.sourceId);
  const fromDate = latest?.date || item.lastReviewedAt;
  if (!fromDate) return null;
  const recallPercent = clamp(Number(latest?.recallPercent ?? latest?.afterScore ?? item.lastRecallPercent ?? item.memoryScore ?? 70), 0, 100);
  const historicalScore = Number(latest?.beforeScore ?? item.memoryScore ?? currentScore(item));
  const baseIndex = legacyIntervalBaseIndex(task.sourceType, task.sourceId, item, latest);
  const migrated = intervalStateAfterReview({ ...item, currentIntervalIndex: baseIndex, currentInterval: BASE_INTERVALS[baseIndex] || 1 }, recallPercent, historicalScore);
  return {
    ...migrated,
    fromDate,
    recallPercent,
  };
}

function legacyIntervalBaseIndex(sourceType, sourceId, item, latest) {
  if (Number.isFinite(Number(latest?.beforeIntervalIndex))) {
    return clamp(Number(latest.beforeIntervalIndex), 0, BASE_INTERVALS.length - 1);
  }
  const currentIndex = clamp(Number(item.currentIntervalIndex ?? 0), 0, BASE_INTERVALS.length - 1);
  const count = reviewCount(sourceType, sourceId);
  if (!count) return currentIndex;
  return clamp(Math.max(currentIndex, count - 1), 0, BASE_INTERVALS.length - 1);
}

async function rebalanceReviewQueue() {
  const queued = applyDailyCapacity(state.tasks
    .filter((task) => task.status === "pending" && !task.isCram && findItem(task.sourceType, task.sourceId))
    .map((task) => {
      const item = findItem(task.sourceType, task.sourceId);
      return {
        ...task,
        earliestDate: task.earliestDate || task.scheduledDate,
        priority: priorityScore(item, false),
      };
    }));
  for (const task of queued) {
    const original = state.tasks.find((row) => row.id === task.id);
    if (!original) continue;
    if (original.scheduledDate === task.scheduledDate && original.earliestDate === task.earliestDate && original.priority === task.priority) continue;
    await put("tasks", {
      ...original,
      earliestDate: task.earliestDate,
      scheduledDate: task.scheduledDate,
      priority: task.priority,
      updatedAt: now(),
    });
  }
}

function buildReviewedTodayTasks() {
  const today = toDateInput(new Date());
  const seen = new Set();
  return state.logs
    .filter((log) => log.date === today && findItem(log.sourceType, log.sourceId))
    .sort((a, b) => (b.createdAt || "").localeCompare(a.createdAt || ""))
    .filter((log) => {
      const key = `${log.sourceType}:${log.sourceId}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
}

function buildCramTasks() {
  const { examDate, cramWindow } = state.settings;
  if (!examDate) return [];
  const today = toDateInput(new Date());
  const daysLeft = diffDays(today, examDate);
  if (daysLeft < 0 || daysLeft > (Number(cramWindow) || 14)) return [];

  return getAllItems()
    .filter((item) => shouldCram(item) && !wasReviewedToday(item))
    .map((item) => ({
      id: `cram-${item.type}-${item.id}`,
      sourceType: item.type,
      sourceId: item.id,
      earliestDate: today,
      scheduledDate: today,
      status: "pending",
      priority: priorityScore(item, true),
      isCram: true,
    }))
    .sort((a, b) => b.priority - a.priority)
    .slice(0, Number(state.settings.dailyCramLimit) || 20);
}

function wasReviewedToday(item) {
  const today = toDateInput(new Date());
  return item.lastReviewedAt === today || state.logs.some((log) => log.sourceType === item.type && log.sourceId === item.id && log.date === today);
}

function wasTaskReviewedToday(task) {
  const today = toDateInput(new Date());
  const item = findItem(task.sourceType, task.sourceId);
  return item?.lastReviewedAt === today || state.logs.some((log) => log.sourceType === task.sourceType && log.sourceId === task.sourceId && log.date === today);
}

function shouldCram(item) {
  const score = currentScore(item);
  const importance = itemImportance(item);
  const lastReviewed = item.lastReviewedAt || item.date || item.createdAt.slice(0, 10);
  const daysSinceReview = diffDays(lastReviewed, toDateInput(new Date()));
  if (score < 40) return true;
  if (score < 60 && ["veryHigh", "high", "medium"].includes(importance)) return true;
  if (score < 80 && ["veryHigh", "high"].includes(importance)) return true;
  return score >= 80 && daysSinceReview > 30;
}

function intervalStateAfterReview(item, recallPercent, historicalScore) {
  const previousIndex = clamp(Number(item.currentIntervalIndex ?? 0), 0, BASE_INTERVALS.length - 1);
  let nextIndex = previousIndex;

  if (recallPercent >= 70) {
    nextIndex = Math.min(previousIndex + 1, BASE_INTERVALS.length - 1);
  } else if (recallPercent >= 50) {
    nextIndex = historicalScore < 60 ? Math.max(0, previousIndex - 1) : previousIndex;
  } else if (recallPercent >= 30) {
    nextIndex = Math.max(0, previousIndex - 2);
  } else {
    nextIndex = 0;
  }

  return {
    index: nextIndex,
    interval: BASE_INTERVALS[nextIndex] || 1,
  };
}

function currentScore(item) {
  const base = Number(item.memoryScore ?? 70);
  const last = item.lastReviewedAt || item.date || item.createdAt?.slice(0, 10) || toDateInput(new Date());
  const decay = Math.floor(Math.max(0, diffDays(last, toDateInput(new Date()))) / 7) * 2;
  return clamp(base - decay, 0, 100);
}

function priorityScore(item, cram) {
  const recencyPenalty = Math.max(0, 12 - diffDays(item.lastReviewedAt || item.date || item.createdAt.slice(0, 10), toDateInput(new Date())));
  const score = currentScore(item);
  const recall = latestRecallPercent(item);
  const stableBonus = score >= 80 && recall >= 85 ? -18 : 0;
  const weakGuard = score < 60 ? 12 : score < 80 ? 6 : 0;
  const mistakeGuard = isMistakeItem(item) && recall < 80 ? 10 : 0;
  const newStudyBonus = isNewStudyItem(item) ? NEW_STUDY_PRIORITY_BONUS : 0;
  return (100 - score) + IMPORTANCE_WEIGHT[itemImportance(item)] + knowledgeWeaknessBonus(item) + weakGuard + mistakeGuard + newStudyBonus + stableBonus + (cram ? 20 : 0) - recencyPenalty;
}

function resultFromPercent(percent) {
  if (percent >= 85) return "remembered";
  if (percent >= 40) return "unclear";
  return "forgotten";
}

function memoryScoreFromReview(sourceType, sourceId, reviewDraft) {
  const scores = recentReviewScores(sourceType, sourceId, reviewDraft);
  if (!scores.length) return clamp(Number(reviewDraft?.recallPercent) || 0, 0, 100);
  if (sourceType === "mistake") return weightedLatestMistakeScore(scores);
  return averageScores(scores);
}

function recentReviewScores(sourceType, sourceId, reviewDraft) {
  const rows = state.logs
    .filter((log) => log.sourceType === sourceType && log.sourceId === sourceId && log.id !== reviewDraft?.id)
    .concat(reviewDraft ? [{ ...reviewDraft, sourceType, sourceId }] : [])
    .sort((a, b) => (b.createdAt || b.date || "").localeCompare(a.createdAt || a.date || ""));
  return rows
    .map((log) => Number(log.recallPercent ?? log.afterScore))
    .filter((score) => Number.isFinite(score))
    .map((score) => clamp(score, 0, 100))
    .slice(0, 10);
}

function weightedLatestMistakeScore(scores) {
  if (scores.length <= 1) return Math.round(scores[0] || 0);
  const latest = scores[0];
  const restAverage = averageScores(scores.slice(1, 10));
  return Math.round(clamp(latest * 0.5 + restAverage * 0.5, 0, 100));
}

function latestLogFor(sourceType, sourceId) {
  return state.logs
    .filter((log) => log.sourceType === sourceType && log.sourceId === sourceId)
    .sort((a, b) => (b.createdAt || b.date || "").localeCompare(a.createdAt || a.date || ""))[0];
}

function latestRecallPercent(item) {
  const stored = Number(item.lastRecallPercent);
  if (Number.isFinite(stored)) return stored;
  const sourceType = isMistakeItem(item) ? "mistake" : "study";
  const latest = latestLogFor(sourceType, item.id);
  const score = Number(latest?.recallPercent ?? latest?.afterScore ?? item.memoryScore ?? 70);
  return Number.isFinite(score) ? clamp(score, 0, 100) : 70;
}

function isMistakeItem(item) {
  if (item?.type) return item.type === "mistake";
  return state.mistakes.some((row) => row.id === item?.id);
}

function isNewStudyItem(item) {
  if (item?.type && item.type !== "study") return false;
  const study = item?.title != null ? item : state.study.find((row) => row.id === item?.id);
  return Boolean(study) && (study.studyKind || "new") === "new";
}

function averageScores(scores) {
  if (!scores.length) return 0;
  const total = scores.reduce((sum, score) => sum + score, 0);
  return Math.round(total / scores.length);
}

function studyKindLabel(item) {
  return STUDY_KIND_LABEL[item.studyKind || "new"] || "新学";
}

function itemImportance(item) {
  const tags = tagsFor(item.tagIds).flatMap(tagWithAncestors);
  if (tags.some((tag) => tag.importance === "veryHigh")) return "veryHigh";
  if (tags.some((tag) => tag.importance === "high")) return "high";
  if (tags.some((tag) => tag.importance === "medium")) return "medium";
  return "low";
}

function knowledgeWeaknessBonus(item) {
  const tags = [...new Map(tagsFor(item.tagIds).flatMap(tagWithAncestors).map((tag) => [tag.id, tag])).values()];
  if (!tags.length) return 0;
  const cache = new Map();
  const scores = tags
    .map((tag) => tagMemoryScore(tag, cache))
    .filter((score) => score != null);
  if (!scores.length) return 0;
  const lowestScore = Math.min(...scores);
  return lowestScore < 70 ? Math.min(20, 70 - lowestScore) : 0;
}

async function ensureTags(names) {
  const ids = [];
  for (const name of names) {
    const tag = await ensureTagPath(name);
    ids.push(tag.id);
  }
  return [...new Set(ids)];
}

async function repairLegacySplitEnumerationTags() {
  let repaired = 0;
  for (const storeName of ["study", "mistakes"]) {
    const rows = storeName === "study" ? state.study : state.mistakes;
    for (const item of rows) {
      const nextTagIds = await mergeLegacySplitTagIds(item.tagIds || []);
      if (!sameArray(nextTagIds, item.tagIds || [])) {
        item.tagIds = nextTagIds;
        item.updatedAt = now();
        await put(storeName, item);
        repaired += 1;
      }
    }
  }
  if (repaired) await loadState();
  return repaired;
}

async function mergeLegacySplitTagIds(tagIds) {
  const mergedIds = [];
  for (let index = 0; index < tagIds.length; index += 1) {
    const baseTag = state.tags.find((tag) => tag.id === tagIds[index]);
    if (!baseTag) continue;

    const following = [];
    let nextIndex = index + 1;
    while (nextIndex < tagIds.length) {
      const nextTag = state.tags.find((tag) => tag.id === tagIds[nextIndex]);
      if (!isLegacySplitEnumerationPart(baseTag, nextTag)) break;
      following.push(nextTag);
      nextIndex += 1;
    }

    if (following.length >= 2) {
      const mergedName = [baseTag.name, ...following.map((tag) => tag.name)].join("、");
      const mergedTag = await createOrUpdateTag({
        name: mergedName,
        parentId: baseTag.parentId,
        importance: baseTag.importance || "medium",
        color: baseTag.color || "",
      });
      upsertStateTag(mergedTag);
      mergedIds.push(mergedTag.id);
      index = nextIndex - 1;
    } else {
      mergedIds.push(baseTag.id);
    }
  }
  return [...new Set(mergedIds)];
}

function isLegacySplitEnumerationPart(baseTag, nextTag) {
  if (!baseTag || !nextTag) return false;
  if (!baseTag.parentId || nextTag.parentId) return false;
  if (baseTag.name.includes("、") || nextTag.name.includes("、")) return false;
  if (isStandaloneTagName(nextTag.name)) return false;
  return tagsWereCreatedTogether(baseTag, nextTag);
}

function isStandaloneTagName(name) {
  return /(题|考点|重点|难点|易错|高频|低频|简答|选择|填空|判断|计算|论述|名词|案例|材料|公式)$/.test(name);
}

function tagsWereCreatedTogether(firstTag, secondTag) {
  const firstTime = Date.parse(firstTag.createdAt || firstTag.updatedAt || "");
  const secondTime = Date.parse(secondTag.createdAt || secondTag.updatedAt || "");
  if (!Number.isFinite(firstTime) || !Number.isFinite(secondTime)) return false;
  return Math.abs(firstTime - secondTime) <= 60 * 1000;
}

function upsertStateTag(tag) {
  const index = state.tags.findIndex((row) => row.id === tag.id);
  if (index >= 0) state.tags[index] = tag;
  else state.tags.push(tag);
}

function sameArray(first = [], second = []) {
  return first.length === second.length && first.every((value, index) => value === second[index]);
}

async function ensureTagPath(rawName) {
  const normalized = normalizeTagToken(rawName);
  const existingByPath = state.tags.find((tag) => canonicalTagPath(tagPath(tag)) === canonicalTagPath(normalized));
  if (existingByPath) return existingByPath;

  const parts = splitTagPath(normalized);
  if (parts.length === 1) {
    const existingByName = state.tags.find((tag) => tag.name === parts[0]);
    if (existingByName) return existingByName;
  }

  let parentId = "";
  let tag;
  for (const part of parts) {
    tag = state.tags.find((row) => row.name === part && (row.parentId || "") === parentId);
    if (!tag) {
      tag = await createOrUpdateTag({ name: part, parentId, importance: "medium" });
      state.tags.push(tag);
    }
    parentId = tag.id;
  }
  return tag;
}

async function createOrUpdateTag({ name, parentId = "", importance = "medium", color = "" }) {
  const cleanName = name.trim();
  const cleanParentId = parentId || "";
  let tag = state.tags.find((row) => row.name === cleanName && (row.parentId || "") === cleanParentId);
  if (!tag) {
    tag = {
      id: id("tag"),
      name: cleanName,
      parentId: cleanParentId,
      color: color || randomTagColor(cleanName),
      importance,
      createdAt: now(),
      updatedAt: now(),
    };
  } else {
    tag = { ...tag };
    tag.parentId = cleanParentId;
    tag.importance = importance || tag.importance || "medium";
    if (color) tag.color = color;
    tag.updatedAt = now();
  }
  await put("tags", tag);
  return tag;
}

async function createTagChain(parts, parentId = "", importance = "medium", color = "") {
  let currentParentId = parentId || "";
  let tag = null;
  for (const part of parts) {
    tag = await createOrUpdateTag({
      name: part,
      parentId: currentParentId,
      importance,
      color: tag ? "" : color,
    });
    const index = state.tags.findIndex((row) => row.id === tag.id);
    if (index >= 0) state.tags[index] = tag;
    else state.tags.push(tag);
    currentParentId = tag.id;
  }
  return tag;
}

function prepareNewStudyForm() {
  const form = document.getElementById("studyForm");
  form.reset();
  formField(form, "id").value = "";
  setText("studyModalTitle", "新增学习记录");
  setText("studySubmitBtn", "保存");
  setDefaultDates();
  renderSelectedTagChips();
  clearTreeBuilder("study");
  resetTagPicker("study");
}

function prepareNewMistakeForm() {
  const form = document.getElementById("mistakeForm");
  form.reset();
  formField(form, "id").value = "";
  formField(form, "removeImage").value = "";
  setText("mistakeModalTitle", "新增错题");
  setText("mistakeSubmitBtn", "保存");
  clearMistakeImage();
  renderSelectedTagChips();
  clearTreeBuilder("mistake");
  resetTagPicker("mistake");
}

function openEditItem(type, idValue) {
  try {
    if (type === "study") {
      openEditStudy(idValue);
    } else {
      openEditMistake(idValue);
    }
  } catch (error) {
    console.error(error);
    toast(`打开编辑失败：${error.message || "请刷新页面后再试。"}`);
  }
}

function openEditStudy(idValue) {
  const item = state.study.find((row) => row.id === idValue);
  if (!item) return;
  const form = document.getElementById("studyForm");
  form.reset();
  formField(form, "id").value = item.id;
  formField(form, "title").value = item.title || "";
  formField(form, "date").value = item.date || toDateInput(new Date());
  formField(form, "studyKind").value = item.studyKind || "new";
  formField(form, "tags").value = tagPathList(item.tagIds).join("，");
  formField(form, "notes").value = item.notes || "";
  setText("studyModalTitle", "编辑学习记录");
  setText("studySubmitBtn", "保存修改");
  renderSelectedTagChips();
  clearTreeBuilder("study");
  resetTagPicker("study");
  openModal("studyModal");
}

function openEditMistake(idValue) {
  const item = state.mistakes.find((row) => row.id === idValue);
  if (!item) return;
  const form = document.getElementById("mistakeForm");
  form.reset();
  formField(form, "id").value = item.id;
  formField(form, "removeImage").value = "";
  formField(form, "location").value = item.location || "";
  formField(form, "question").value = item.question || "";
  formField(form, "answer").value = item.answer || "";
  formField(form, "reason").value = item.reason || "";
  formField(form, "tags").value = tagPathList(item.tagIds).join("，");
  clearMistakeImage();
  if (item.image) showMistakeImagePreview(item.image);
  setText("mistakeModalTitle", "编辑错题");
  setText("mistakeSubmitBtn", "保存修改");
  renderSelectedTagChips();
  clearTreeBuilder("mistake");
  resetTagPicker("mistake");
  openModal("mistakeModal");
}

function formField(form, name) {
  const field = form.elements.namedItem(name) || form.querySelector(`[name="${name}"]`);
  if (field) return field;
  if (["id", "removeImage"].includes(name)) {
    const input = document.createElement("input");
    input.type = "hidden";
    input.name = name;
    form.appendChild(input);
    return input;
  }
  throw new Error(`找不到表单字段：${name}`);
}

function setText(idValue, text) {
  const element = document.getElementById(idValue);
  if (element) element.textContent = text;
}

function openModal(idValue) {
  const dialog = document.getElementById(idValue);
  if (!dialog) throw new Error(`找不到弹窗：${idValue}`);
  if (dialog.open) return;
  if (typeof dialog.showModal === "function") {
    dialog.showModal();
  } else {
    dialog.setAttribute("open", "");
  }
}

function configureReviewModalForType(sourceType) {
  const isMistake = sourceType === "mistake";
  setText("reviewNotesLabel", isMistake ? "本次错因 / 复盘" : "复习备注");
  setText("reviewSubmitBtn", isMistake ? "保存错因记录" : "保存结果");
  const notes = document.querySelector("#reviewForm [name='notes']");
  if (notes) {
    notes.placeholder = isMistake
      ? "这次又错在哪里、卡在哪里、下次怎么避免"
      : "这次卡在哪里、下次重点看什么";
  }
}

function openReview(sourceType, sourceId, taskId) {
  const item = findItem(sourceType, sourceId);
  if (!item) return;
  const title = sourceType === "study" ? item.title : item.location || firstLine(item.question) || "未命名错题";
  document.getElementById("reviewModalTitle").textContent = `${sourceType === "mistake" ? "记录错因" : "记录复习结果"}：${title}`;
  configureReviewModalForType(sourceType);
  const form = document.getElementById("reviewForm");
  form.sourceType.value = sourceType;
  form.sourceId.value = sourceId;
  form.taskId.value = taskId;
  form.logId.value = "";
  formField(form, "notes").value = "";
  setRecallPercent(80);
  document.getElementById("reviewModal").showModal();
}

function openEditReview(logId) {
  const log = state.logs.find((row) => row.id === logId);
  if (!log) return;
  const item = findItem(log.sourceType, log.sourceId);
  if (!item) return;
  const historyModal = document.getElementById("mistakeHistoryModal");
  if (historyModal?.open) historyModal.close();
  const studyRecordModal = document.getElementById("studyRecordModal");
  if (studyRecordModal?.open) studyRecordModal.close();
  const title = log.sourceType === "study" ? item.title : item.location || firstLine(item.question) || "未命名错题";
  document.getElementById("reviewModalTitle").textContent = `${log.sourceType === "mistake" ? "修改错因记录" : "修改复习记录"}：${title}`;
  configureReviewModalForType(log.sourceType);
  const form = document.getElementById("reviewForm");
  form.sourceType.value = log.sourceType;
  form.sourceId.value = log.sourceId;
  form.taskId.value = log.taskId || "";
  form.logId.value = log.id;
  formField(form, "notes").value = log.notes || "";
  setRecallPercent(log.recallPercent ?? log.afterScore ?? currentScore(item));
  document.getElementById("reviewModal").showModal();
}

function syncRecallFromRange(event) {
  setRecallPercent(event.currentTarget.value);
}

function syncRecallFromInput(event) {
  setRecallPercent(event.currentTarget.value);
}

function setRecallPercent(value) {
  const percent = clamp(Number(value) || 0, 0, 100);
  document.getElementById("recallPercentRange").value = percent;
  document.getElementById("recallPercentInput").value = percent;
}

function syncStudyRecordRecallFromRange(event) {
  setStudyRecordRecallPercent(event.currentTarget.value);
}

function syncStudyRecordRecallFromInput(event) {
  setStudyRecordRecallPercent(event.currentTarget.value);
}

function setStudyRecordRecallPercent(value) {
  const percent = clamp(Number(value) || 0, 0, 100);
  document.getElementById("studyRecordPercentRange").value = percent;
  document.getElementById("studyRecordPercentInput").value = percent;
}

async function syncStudySectionScore(event) {
  const row = event.target.closest(".section-score-row");
  if (!row) return;
  if (event.target.classList.contains("section-importance-select")) {
    await updateSectionImportance(row, event.target.value);
    return;
  }
  const percent = clamp(Number(event.target.value) || 0, 0, 100);
  row.querySelector(".section-score-number").value = percent;
  row.querySelector(".section-score-range").value = percent;
  updateStudyRecordAggregateFromSections();
}

async function updateSectionImportance(row, importance) {
  const tag = state.tags.find((item) => item.id === row.dataset.tagId);
  if (!tag) return;
  tag.importance = importance;
  tag.updatedAt = now();
  await put("tags", tag);
  const weight = tagImportanceScoreWeight(tag);
  row.dataset.weight = String(weight);
  row.querySelector(".muted").textContent = `权重 ${weight}`;
  await loadState();
  updateStudyRecordAggregateFromSections();
  render();
  toast("小节重要性已同步更新。");
}

function updateStudyRecordAggregateFromSections() {
  const sectionScores = collectStudySectionScores(document.getElementById("studyRecordForm"), "study");
  if (!sectionScores.length) return;
  setStudyRecordRecallPercent(weightedSectionScore(sectionScores));
}

function syncMistakeRecordRecallFromRange(event) {
  setMistakeRecordRecallPercent(event.currentTarget.value);
}

function syncMistakeRecordRecallFromInput(event) {
  setMistakeRecordRecallPercent(event.currentTarget.value);
}

function setMistakeRecordRecallPercent(value) {
  const percent = clamp(Number(value) || 0, 0, 100);
  document.getElementById("mistakeRecordPercentRange").value = percent;
  document.getElementById("mistakeRecordPercentInput").value = percent;
}

async function postponeTask(taskId, sourceType, sourceId) {
  if (taskId && !taskId.startsWith("cram-")) {
    const task = state.tasks.find((row) => row.id === taskId);
    if (task) {
      task.earliestDate = addDays(toDateInput(new Date()), 1);
      task.scheduledDate = task.earliestDate;
      task.updatedAt = now();
      await put("tasks", task);
    }
  } else {
    const item = findItem(sourceType, sourceId);
    if (item) await createNextTask(sourceType, item, toDateInput(new Date()), "postponed");
  }
  await refreshSchedule();
  toast("已延后 1 天。");
  render();
}

async function deleteItem(type, idValue) {
  const store = type === "study" ? "study" : "mistakes";
  await remove(store, idValue);
  for (const task of state.tasks.filter((row) => row.sourceType === type && row.sourceId === idValue)) {
    await remove("tasks", task.id);
  }
  await loadState();
  toast("已删除。");
  render();
}

async function deleteTag(idValue) {
  const tag = state.tags.find((row) => row.id === idValue);
  if (!tag) return;
  const childCount = state.tags.filter((row) => row.parentId === idValue).length;
  const linkedCount = getAllItems().filter((item) => (item.tagIds || []).includes(idValue)).length;
  const ok = window.confirm(`确定删除“${tagPath(tag)}”吗？\n\n直接关联内容：${linkedCount} 条\n子知识点：${childCount} 个\n\n删除后子知识点会提升为主分支，已有学习/错题会移除这个知识点关联。`);
  if (!ok) return;
  await remove("tags", idValue);
  for (const child of state.tags.filter((tag) => tag.parentId === idValue)) {
    child.parentId = "";
    child.updatedAt = now();
    await put("tags", child);
  }
  for (const item of getAllItems()) {
    if ((item.tagIds || []).includes(idValue)) {
      item.tagIds = item.tagIds.filter((tagId) => tagId !== idValue);
      item.updatedAt = now();
      await put(item.type === "study" ? "study" : "mistakes", item);
    }
  }
  await loadState();
  toast("标签已删除，关联内容已保留。");
  render();
}

async function deleteSelectedTag() {
  const select = document.getElementById("deleteTagSelect");
  if (!select.value) {
    toast("先选择要删除的知识点。");
    return;
  }
  await deleteTag(select.value);
  select.value = "";
}

async function renameTag(idValue) {
  const tag = state.tags.find((row) => row.id === idValue);
  if (!tag) return;
  const nextName = window.prompt("输入新的知识点名称", tag.name);
  if (nextName === null) return;
  const cleanName = nextName.trim();
  if (!cleanName) {
    toast("名称不能为空。");
    return;
  }
  const duplicate = state.tags.find((row) => row.id !== tag.id && row.name === cleanName && (row.parentId || "") === (tag.parentId || ""));
  if (duplicate) {
    toast("同一级下面已经有这个名称。");
    return;
  }
  await put("tags", { ...tag, name: cleanName, updatedAt: now() });
  await loadState();
  toast("知识点已重命名。");
  render();
}

async function cycleImportance(idValue) {
  const tag = state.tags.find((row) => row.id === idValue);
  if (!tag) return;
  const order = ["veryHigh", "high", "medium", "low"];
  tag.importance = order[(order.indexOf(tag.importance) + 1) % order.length];
  tag.updatedAt = now();
  await put("tags", tag);
  await loadState();
  render();
}

function openQuestionTypes(tagId) {
  const tag = state.tags.find((row) => row.id === tagId);
  if (!tag) return;
  const form = document.getElementById("questionTypeForm");
  form.reset();
  formField(form, "tagId").value = tag.id;
  setText("questionTypeTitle", `考察题型：${tagPath(tag)}`);
  renderQuestionTypeOptions(tag);
  openModal("questionTypeModal");
}

function renderQuestionTypeOptions(tag) {
  document.getElementById("questionTypeOptions").innerHTML = availableQuestionTypes().map((type) => `
    <label class="check-option">
      <input type="checkbox" name="questionTypes" value="${escapeHtml(type)}" ${(tag.questionTypes || []).includes(type) ? "checked" : ""} />
      <span>${escapeHtml(type)}</span>
      ${DEFAULT_QUESTION_TYPES.includes(type) ? "" : `<button class="mini-danger" type="button" onclick="deleteQuestionType(decodeURIComponent('${encodeURIComponent(type)}'))">删除</button>`}
    </label>
  `).join("");
}

function availableQuestionTypes() {
  return normalizeQuestionTypes(state.settings.questionTypes);
}

function normalizeQuestionTypes(types = []) {
  return [...new Set([...DEFAULT_QUESTION_TYPES, ...(Array.isArray(types) ? types : [])].map((type) => String(type || "").trim()).filter(Boolean))];
}

async function saveQuestionTypes(event) {
  event.preventDefault();
  const form = event.currentTarget;
  const tag = state.tags.find((row) => row.id === formField(form, "tagId").value);
  if (!tag) return;
  const selected = [...form.querySelectorAll("[name='questionTypes']:checked")].map((input) => input.value);
  tag.questionTypes = selected;
  tag.updatedAt = now();
  await put("tags", tag);
  await loadState();
  form.closest("dialog").close();
  toast("考察题型已保存。");
  render();
}

async function addQuestionType() {
  const input = document.getElementById("newQuestionTypeName");
  const name = input.value.trim();
  if (!name) {
    toast("先输入题型名称。");
    return;
  }
  state.settings.questionTypes = normalizeQuestionTypes([...availableQuestionTypes(), name]);
  state.settings.updatedAt = now();
  await put("settings", state.settings);
  await loadState();
  input.value = "";
  const tag = state.tags.find((row) => row.id === document.querySelector("#questionTypeForm [name='tagId']").value);
  if (tag) renderQuestionTypeOptions(tag);
  toast("题型已添加。");
}

async function deleteQuestionType(type) {
  if (DEFAULT_QUESTION_TYPES.includes(type)) {
    toast("默认题型会保留。");
    return;
  }
  state.settings.questionTypes = availableQuestionTypes().filter((item) => item !== type);
  state.settings.updatedAt = now();
  await put("settings", state.settings);
  for (const tag of state.tags.filter((row) => (row.questionTypes || []).includes(type))) {
    tag.questionTypes = tag.questionTypes.filter((item) => item !== type);
    tag.updatedAt = now();
    await put("tags", tag);
  }
  await loadState();
  const tag = state.tags.find((row) => row.id === document.querySelector("#questionTypeForm [name='tagId']").value);
  if (tag) renderQuestionTypeOptions(tag);
  toast("题型已删除，并从相关知识点移除。");
  renderTags();
}

async function addSeedData() {
  if (state.study.length || state.mistakes.length || state.tags.length) {
    toast("已有数据，示例不会重复加入。");
    return;
  }
  const tagA = { id: id("tag"), name: "高频考点", parentId: "", color: "#dc2626", importance: "veryHigh", createdAt: now(), updatedAt: now() };
  const tagB = { id: id("tag"), name: "易混概念", parentId: tagA.id, color: "#f59e0b", importance: "medium", createdAt: now(), updatedAt: now() };
  await put("tags", tagA);
  await put("tags", tagB);
  const study = {
    id: id("study"),
    title: "示例：艾宾浩斯复习规则",
    date: toDateInput(new Date()),
    notes: "学习后根据熟记、模糊、完全忘了动态调整下一次复习。",
    tagIds: [tagA.id],
    memoryScore: 72,
    currentIntervalIndex: 0,
    currentInterval: 1,
    createdAt: now(),
    updatedAt: now(),
  };
  await put("study", study);
  await createNextTask("study", study, study.date);
  await refreshSchedule();
  toast("示例数据已加入。");
  render();
}

function exportJson() {
  download(`memory-review-backup-${toDateInput(new Date())}.json`, JSON.stringify(state, null, 2), "application/json");
}

function exportCsv() {
  const rows = [
    ["类型", "学习记录类型", "标题/位置", "日期", "标签", "记忆分", "下次复习", "备注/错因"],
    ...state.study.map((item) => ["学习", studyKindLabel(item), item.title, item.date, tagPathList(item.tagIds).join(";"), currentScore(item), nextTaskDate("study", item.id) || "", item.notes || ""]),
    ...state.mistakes.map((item) => ["错题", "", item.location || firstLine(item.question), item.date, tagPathList(item.tagIds).join(";"), currentScore(item), nextTaskDate("mistake", item.id) || "", item.reason || ""]),
  ];
  download(`memory-review-${toDateInput(new Date())}.csv`, rows.map(csvRow).join("\n"), "text/csv;charset=utf-8");
}

function exportIcs() {
  download(`memory-review-calendar-${toDateInput(new Date())}.ics`, buildIcsContent(), "text/calendar");
}

function buildIcsContent() {
  const lines = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//Memory Review//Local App//CN",
    "CALSCALE:GREGORIAN",
    "METHOD:PUBLISH",
    "X-WR-CALNAME:复习提醒",
  ];
  buildDisplayTasks()
    .filter((task) => task.status === "pending")
    .slice(0, 500)
    .forEach((task) => {
      const item = findItem(task.sourceType, task.sourceId);
      if (!item) return;
      const title = task.sourceType === "study" ? item.title : item.location || firstLine(item.question) || "错题复习";
      const date = task.scheduledDate.replaceAll("-", "");
      const endDate = addDays(task.scheduledDate, 1).replaceAll("-", "");
      lines.push("BEGIN:VEVENT");
      lines.push(`UID:${task.id}@memory-review`);
      lines.push(`DTSTAMP:${icsStamp(new Date())}`);
      lines.push(`DTSTART;VALUE=DATE:${date}`);
      lines.push(`DTEND;VALUE=DATE:${endDate}`);
      lines.push(`SUMMARY:${icsText(`${task.isCram ? "考前重点" : "复习"}：${title}`)}`);
      lines.push(`DESCRIPTION:${icsText(`记忆分 ${currentScore(item)}，类型 ${TYPE_LABEL[task.sourceType]}`)}`);
      lines.push("END:VEVENT");
    });
  lines.push("END:VCALENDAR");
  return lines.join("\r\n");
}

async function syncAppleCalendar() {
  const status = document.getElementById("appleCalendarSyncStatus");
  const ics = buildIcsContent();
  status.textContent = "正在同步...";
  try {
    const response = await fetch("/api/calendar", {
      method: "POST",
      headers: { "Content-Type": "text/calendar;charset=utf-8" },
      body: ics,
    });
    if (!response.ok) throw new Error(await response.text());
    const result = await response.json();
    const subscribeUrl = `${window.location.origin}${result.calendarPath || "/calendar.ics"}`;
    document.getElementById("calendarSubscribeUrl").textContent = subscribeUrl;
    status.textContent = `已同步 ${result.eventCount} 条提醒，更新时间 ${new Date(result.updatedAt).toLocaleString("zh-CN")}`;
    toast("已同步到本地日历订阅源。首次使用请在苹果日历中订阅该地址。");
  } catch (error) {
    status.textContent = "同步失败：请用 node server.js 启动本地同步服务器。";
    toast("当前服务器不支持同步。请用 README 里的 node server.js 启动方式。");
  }
}

async function importJson(event) {
  const file = event.target.files[0];
  if (!file) return;
  const data = JSON.parse(await file.text());
  for (const store of STORES) await clearStore(store);
  const imported = {
    settings: data.settings ? [data.settings] : [],
    tags: data.tags || [],
    study: data.study || [],
    mistakes: data.mistakes || [],
    logs: data.logs || [],
    tasks: data.tasks || [],
  };
  for (const [store, rows] of Object.entries(imported)) {
    for (const row of rows) await put(store, row);
  }
  await refreshSchedule();
  event.target.value = "";
  toast("JSON 备份已导入。");
  render();
}

function getAllItems() {
  return [
    ...state.study.map((item) => ({ ...item, type: "study" })),
    ...state.mistakes.map((item) => ({ ...item, type: "mistake" })),
  ];
}

function findItem(type, sourceId) {
  return (type === "study" ? state.study : state.mistakes).find((item) => item.id === sourceId);
}

function reviewCount(type, sourceId) {
  return state.logs.filter((log) => log.sourceType === type && log.sourceId === sourceId).length;
}

function tagsFor(ids = []) {
  return ids.map((tagId) => state.tags.find((tag) => tag.id === tagId)).filter(Boolean);
}

function tagPathList(ids = []) {
  return tagsFor(ids).map((tag) => tagPath(tag));
}

function tagWithAncestors(tag) {
  const chain = [];
  let current = tag;
  const seen = new Set();
  while (current && !seen.has(current.id)) {
    chain.push(current);
    seen.add(current.id);
    current = state.tags.find((row) => row.id === current.parentId);
  }
  return chain;
}

function tagTreeRows() {
  const rows = [];
  const visit = (tag, depth) => {
    rows.push({ tag, depth });
    state.tags
      .filter((child) => child.parentId === tag.id)
      .sort((a, b) => a.name.localeCompare(b.name, "zh-CN"))
      .forEach((child) => visit(child, depth + 1));
  };
  state.tags
    .filter((tag) => !tag.parentId || !state.tags.some((parent) => parent.id === tag.parentId))
    .sort((a, b) => a.name.localeCompare(b.name, "zh-CN"))
    .forEach((tag) => visit(tag, 0));
  return rows;
}

function uniqueTagTreeRows() {
  const seen = new Set();
  return tagTreeRows().filter(({ tag }) => {
    const key = canonicalTagPath(tagPath(tag));
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function treeOptionLabel(tag, depth) {
  return `${"　".repeat(depth)}${depth ? "└ " : ""}${tag.name}`;
}

function tagIdFromSelectValue(value) {
  if (!value) return "";
  if (state.tags.some((tag) => tag.id === value)) return value;
  return findTagByPath(value)?.id || "";
}

function nextTaskDate(type, sourceId) {
  const task = buildDisplayTasks()
    .filter((row) => row.status === "pending" && row.sourceType === type && row.sourceId === sourceId)
    .sort((a, b) => a.scheduledDate.localeCompare(b.scheduledDate))[0];
  return task?.scheduledDate || "";
}

function matchesStudy(item, query) {
  if (!query) return true;
  return [item.title, item.notes, ...tagPathList(item.tagIds)].join(" ").toLowerCase().includes(query);
}

function matchesMistake(item, query) {
  if (!query) return true;
  return [item.location, item.question, item.answer, item.reason, ...tagPathList(item.tagIds)].join(" ").toLowerCase().includes(query);
}

function parseTags(value) {
  return String(value || "")
    .split(/[,，\n]/)
    .map((name) => name.trim())
    .filter(Boolean);
}

function uniqueTagNames(names = []) {
  const seen = new Set();
  const unique = [];
  for (const name of names) {
    const clean = String(name || "").trim();
    if (!clean) continue;
    const key = canonicalTagPath(clean);
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(clean);
  }
  return unique;
}

function appendTagToInput(input, tagName) {
  const tags = uniqueTagNames([...parseTags(input.value), tagName]);
  input.value = tags.join("，");
  renderSelectedTagChips();
}

function removeTagFromField(containerId, tagName) {
  const inputSelector = containerId === "studySelectedTags" ? "#studyForm [name='tags']" : "#mistakeForm [name='tags']";
  const input = document.querySelector(inputSelector);
  input.value = parseTags(input.value).filter((tag) => canonicalTagPath(tag) !== canonicalTagPath(tagName)).join("，");
  renderSelectedTagChips();
}

function removeTagValueFromOpenForms(tagName) {
  document.querySelectorAll("#studyForm [name='tags'], #mistakeForm [name='tags']").forEach((input) => {
    input.value = parseTags(input.value)
      .filter((tag) => canonicalTagPath(tag) !== canonicalTagPath(tagName))
      .join("，");
  });
  renderSelectedTagChips();
}

function renderTagPill(tag) {
  return `<span class="tag-pill" style="border-left: 5px solid ${escapeHtml(tag.color || "#64748b")}">${escapeHtml(tagPath(tag))}</span>`;
}

function renderTagRow(tags = []) {
  return tags.length ? `<div class="tag-row">${tags.map(renderTagPill).join("")}</div>` : "";
}

function importanceLabel(value) {
  return ({ veryHigh: "非常重要", high: "高重要性", medium: "中重要性", low: "低重要性" })[value] || "中重要性";
}

function tagPath(tag, seen = new Set()) {
  if (!tag) return "";
  if (!tag.parentId || seen.has(tag.id)) return tag.name;
  seen.add(tag.id);
  const parent = state.tags.find((row) => row.id === tag.parentId);
  return parent ? `${tagPath(parent, seen)} > ${tag.name}` : tag.name;
}

function splitTagPath(value) {
  return normalizeTagToken(value)
    .split(/\s*(?:>|\/|\\|-)\s*|\s+下\s+/)
    .map((part) => part.trim())
    .filter(Boolean);
}

function normalizeTagToken(value) {
  return String(value || "")
    .replaceAll("＞", ">")
    .replaceAll("→", ">")
    .trim();
}

function canonicalTagPath(value) {
  return normalizeTagToken(value).replace(/\s*>\s*/g, ">");
}

function findTagByPath(value) {
  const target = canonicalTagPath(value);
  return state.tags.find((tag) => canonicalTagPath(tagPath(tag)) === target);
}

function descendantTagIds(tagId) {
  const ids = new Set([tagId]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const tag of state.tags) {
      if (tag.parentId && ids.has(tag.parentId) && !ids.has(tag.id)) {
        ids.add(tag.id);
        changed = true;
      }
    }
  }
  return [...ids];
}

function tagMemoryScore(tag, cache = new Map()) {
  return tagMemorySummary(tag, cache).score;
}

function tagMemorySummary(tag, cache = new Map()) {
  if (!tag) return { score: null, mistakeCount: 0 };
  if (cache.has(tag.id)) return cache.get(tag.id);

  const children = state.tags.filter((child) => child.parentId === tag.id);
  let summary = { score: null, mistakeCount: 0 };
  if (children.length) {
    let weightedTotal = 0;
    let totalWeight = 0;
    let mistakeCount = directMistakeCount(tag.id);
    for (const child of children) {
      const childSummary = tagMemorySummary(child, cache);
      mistakeCount += childSummary.mistakeCount || 0;
      if (childSummary.score == null) continue;
      const weight = TAG_SCORE_WEIGHT[child.importance] || TAG_SCORE_WEIGHT.medium;
      weightedTotal += childSummary.score * weight;
      totalWeight += weight;
    }
    summary = {
      score: totalWeight ? Math.round(weightedTotal / totalWeight) : null,
      mistakeCount,
    };
  } else {
    summary = leafTagMemorySummary(tag.id);
  }

  cache.set(tag.id, summary);
  return summary;
}

function leafTagMemorySummary(tagId) {
  const studyItems = state.study.filter((item) => (item.tagIds || []).includes(tagId));
  const mistakeItems = state.mistakes.filter((item) => (item.tagIds || []).includes(tagId));
  const studyScore = studyItems.length ? averageScores(studyItems.map(currentScore)) : null;
  const mistakeBaseScore = mistakeItems.length ? averageScores(mistakeItems.map(currentScore)) : null;
  const mistakePenalty = Math.min(mistakeItems.length * MISTAKE_COUNT_PENALTY, MAX_MISTAKE_PENALTY);
  const mistakeScore = mistakeBaseScore == null ? null : clamp(mistakeBaseScore - mistakePenalty, 0, 100);

  let score = null;
  if (studyScore != null && mistakeScore != null) {
    score = Math.round(studyScore * TAG_STUDY_RATIO + mistakeScore * TAG_MISTAKE_RATIO);
  } else if (studyScore != null) {
    score = studyScore;
  } else if (mistakeScore != null) {
    score = mistakeScore;
  }

  return {
    score,
    studyScore,
    mistakeBaseScore,
    mistakeScore,
    mistakeCount: mistakeItems.length,
  };
}

function directMistakeCount(tagId) {
  return state.mistakes.filter((item) => (item.tagIds || []).includes(tagId)).length;
}

function renderTagMemoryScore(score) {
  if (score == null) return '<span class="memory-score-badge empty-score">暂无记忆分</span>';
  return `<span class="memory-score-badge ${scoreClass(score)}">记忆分 ${score}</span>`;
}

function scoreClass(score) {
  if (score >= 80) return "score-green";
  if (score >= 60) return "score-yellow";
  if (score >= 40) return "score-orange";
  return "score-red";
}

function stat(label, value) {
  return `<div class="stat"><strong>${value}</strong><span>${label}</span></div>`;
}

function empty(text) {
  return `<div class="empty muted">${escapeHtml(text)}</div>`;
}

function taskSort(a, b) {
  if (a.scheduledDate !== b.scheduledDate) return a.scheduledDate.localeCompare(b.scheduledDate);
  return b.priority - a.priority;
}

function byCreated(a, b) {
  return (a.createdAt || "").localeCompare(b.createdAt || "");
}

function byDateDesc(a, b) {
  return (b.date || b.createdAt || "").localeCompare(a.date || a.createdAt || "");
}

function addDays(dateString, days) {
  const date = new Date(`${dateString}T12:00:00`);
  date.setDate(date.getDate() + Number(days));
  return toDateInput(date);
}

function minDate(a, b) {
  if (!a) return b;
  if (!b) return a;
  return a <= b ? a : b;
}

function maxDate(a, b) {
  if (!a) return b;
  if (!b) return a;
  return a >= b ? a : b;
}

function diffDays(start, end) {
  const a = new Date(`${start}T12:00:00`);
  const b = new Date(`${end}T12:00:00`);
  return Math.round((b - a) / 86400000);
}

function capAtExam(dateString) {
  if (!state.settings.examDate) return dateString;
  return dateString <= state.settings.examDate ? dateString : "";
}

function toDateInput(date) {
  const local = new Date(date.getTime() - date.getTimezoneOffset() * 60000);
  return local.toISOString().slice(0, 10);
}

function formatDate(dateString) {
  if (!dateString) return "无";
  const date = new Date(`${dateString}T12:00:00`);
  if (Number.isNaN(date.getTime())) return "无";
  return new Intl.DateTimeFormat("zh-CN", { month: "2-digit", day: "2-digit", weekday: "short" }).format(date);
}

function now() {
  return new Date().toISOString();
}

function id(prefix) {
  const uuid = globalThis.crypto?.randomUUID?.();
  return `${prefix}_${uuid || `${Date.now()}_${Math.random().toString(16).slice(2)}`}`;
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function firstLine(value = "") {
  return String(value).split("\n").find(Boolean) || "";
}

function truncate(value, length) {
  return value.length > length ? `${value.slice(0, length)}...` : value;
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function escapeAttr(value) {
  return escapeHtml(value).replaceAll("\\", "\\\\").replaceAll("'", "&#039;");
}

function randomTagColor(name) {
  const colors = ["#2563eb", "#0f766e", "#dc2626", "#7c3aed", "#c2410c", "#0891b2"];
  const sum = [...name].reduce((acc, char) => acc + char.charCodeAt(0), 0);
  return colors[sum % colors.length];
}

function fileToDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
}

function download(filename, content, type) {
  const blob = new Blob([content], { type });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  URL.revokeObjectURL(url);
}

function csvRow(values) {
  return values.map((value) => `"${String(value ?? "").replaceAll('"', '""')}"`).join(",");
}

function icsStamp(date) {
  return date.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
}

function icsText(value) {
  return String(value).replaceAll("\\", "\\\\").replaceAll(",", "\\,").replaceAll(";", "\\;").replaceAll("\n", "\\n");
}

function toast(message) {
  const element = document.getElementById("toast");
  element.textContent = message;
  element.classList.add("show");
  window.clearTimeout(toast.timer);
  toast.timer = window.setTimeout(() => element.classList.remove("show"), 2400);
}

window.openReview = openReview;
window.openEditReview = openEditReview;
window.openEditItem = openEditItem;
window.postponeTask = postponeTask;
window.deleteItem = deleteItem;
window.deleteTag = deleteTag;
window.deleteSelectedTag = deleteSelectedTag;
window.renameTag = renameTag;
window.removeTagFromField = removeTagFromField;
window.addSimpleTagChoice = addSimpleTagChoice;
window.deleteSimpleTagChoice = deleteSimpleTagChoice;
window.selectKnowledgeTag = selectKnowledgeTag;
window.toggleTagPickerNode = toggleTagPickerNode;
window.openTagDetail = openTagDetail;
window.handleTagDetailKey = handleTagDetailKey;
window.openStudyRecordFromTagDetail = openStudyRecordFromTagDetail;
window.openMistakeRecordFromTagDetail = openMistakeRecordFromTagDetail;
window.openQuestionTypesFromTagDetail = openQuestionTypesFromTagDetail;
window.cycleImportance = cycleImportance;
window.toggleTagNode = toggleTagNode;
window.jumpToTagMistakes = jumpToTagMistakes;
window.openMistakeRecord = openMistakeRecord;
window.openStudyRecord = openStudyRecord;
window.openQuestionTypes = openQuestionTypes;
window.deleteQuestionType = deleteQuestionType;
