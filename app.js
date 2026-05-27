const DB_NAME = "adaptive-memory-review";
const DB_VERSION = 1;
const STORES = ["settings", "tags", "study", "mistakes", "logs", "tasks"];
const BASE_INTERVALS = [1, 2, 4, 7, 15, 30];
const IMPORTANCE_MULTIPLIER = { veryHigh: 0.55, high: 0.7, medium: 1, low: 1.3 };
const IMPORTANCE_WEIGHT = { veryHigh: 45, high: 30, medium: 15, low: 0 };
const RESULT_LABEL = { remembered: "熟记", unclear: "模糊", forgotten: "完全忘了" };
const TYPE_LABEL = { study: "学习", mistake: "错题" };
const STUDY_KIND_LABEL = { new: "新学", review: "复习" };

let db;
let pastedMistakeImage = "";
let lastChainTagId = "";
let state = {
  settings: {
    id: "main",
    examDate: "",
    cramWindow: 14,
    dailyCramLimit: 20,
  },
  tags: [],
  study: [],
  mistakes: [],
  logs: [],
  tasks: [],
};
const treeLevelCounters = { study: 0, mistake: 0 };

document.addEventListener("DOMContentLoaded", async () => {
  db = await openDb();
  await loadState();
  bindEvents();
  setDefaultDates();
  render();
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

  state.settings = settings[0] || state.settings;
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
  document.getElementById("reviewFilter").addEventListener("change", renderDashboard);
  document.getElementById("historyFilter").addEventListener("change", renderHistory);
  document.getElementById("studySearch").addEventListener("input", renderStudy);
  document.getElementById("studyViewMode").addEventListener("change", renderStudy);
  document.getElementById("mistakeSearch").addEventListener("input", renderMistakes);
  document.getElementById("exportJsonBtn").addEventListener("click", exportJson);
  document.getElementById("exportCsvBtn").addEventListener("click", exportCsv);
  document.getElementById("exportIcsBtn").addEventListener("click", exportIcs);
  document.getElementById("syncAppleCalendarBtn").addEventListener("click", syncAppleCalendar);
  document.getElementById("importJsonInput").addEventListener("change", importJson);
  document.getElementById("seedBtn").addEventListener("click", addSeedData);
  document.getElementById("createStudySimpleTagBtn").addEventListener("click", createStudySimpleTag);
  document.getElementById("addStudyTreeLevelBtn").addEventListener("click", () => addStudyTreeLevel());
  document.getElementById("createStudyTreeTagBtn").addEventListener("click", createStudyTreeTag);
  document.getElementById("createMistakeSimpleTagBtn").addEventListener("click", createMistakeSimpleTag);
  document.getElementById("addMistakeTreeLevelBtn").addEventListener("click", () => addMistakeTreeLevel());
  document.getElementById("createMistakeTreeTagBtn").addEventListener("click", createMistakeTreeTag);
  document.getElementById("addExistingStudyTagBtn").addEventListener("click", addExistingStudyTag);
  document.getElementById("deleteExistingStudyTagBtn").addEventListener("click", () => deleteExistingTagFromSelect("studyExistingTagSelect"));
  document.getElementById("addExistingMistakeTagBtn").addEventListener("click", addExistingMistakeTag);
  document.getElementById("deleteExistingMistakeTagBtn").addEventListener("click", () => deleteExistingTagFromSelect("mistakeExistingTagSelect"));
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
  const cram = visibleTasks.filter((task) => task.isCram && task.status === "pending");
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
          <span>记住 ${Number(task.recallPercent ?? score)}%</span>
          <span>记忆分: ${score}</span>
          ${tags.map(renderTagPill).join("")}
        </div>
        ${task.notes ? `<p class="body-text">${escapeHtml(truncate(task.notes, 120))}</p>` : ""}
      </div>
      <div class="card-actions">
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
          <span>记忆分: ${score}</span>
          ${task.isCram ? '<span class="badge cram">考前重点</span>' : ""}
          ${tags.map(renderTagPill).join("")}
        </div>
        ${detail ? `<p class="body-text">${escapeHtml(truncate(detail, 160))}</p>` : ""}
      </div>
      <div class="card-actions">
        <button class="small-button" onclick="openEditItem('${task.sourceType}','${task.sourceId}')">编辑内容</button>
        <button class="small-button" onclick="openReview('${task.sourceType}','${task.sourceId}','${task.id || ""}')">记录结果</button>
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
          <span>下次: ${formatDate(nextTaskDate("study", item.id))}</span>
          <span>记忆分: ${score}</span>
        </div>
      </div>
      <div class="card-actions">
        <button class="small-button" onclick="openEditItem('study','${item.id}')">编辑</button>
        <button class="small-button" onclick="openReview('study','${item.id}','')">记录复习</button>
      </div>
    </article>
  `;
}

function renderMistakes() {
  const query = document.getElementById("mistakeSearch").value.trim().toLowerCase();
  const rows = state.mistakes.filter((item) => matchesMistake(item, query));
  document.getElementById("mistakeList").innerHTML = rows.length
    ? rows.map((item) => renderItemCard("mistake", item)).join("")
    : empty("还没有错题记录。");
}

function renderItemCard(type, item) {
  const score = currentScore(item);
  const tags = tagsFor(item.tagIds);
  const title = type === "study" ? item.title : item.location || firstLine(item.question) || "未命名错题";
  const body = type === "study"
    ? item.notes
    : [item.question && `题干：${item.question}`, item.answer && `答案：${item.answer}`, `错因：${item.reason}`].filter(Boolean).join("\n\n");
  const date = item.date || item.createdAt.slice(0, 10);
  return `
    <article class="item-card">
      <div class="meta">
        <span class="badge">${type === "study" ? studyKindLabel(item) : TYPE_LABEL[type]}</span>
        <span>${formatDate(date)}</span>
        <span>记忆分: ${score}</span>
        <span>下次: ${formatDate(nextTaskDate(type, item.id))}</span>
        ${tags.map(renderTagPill).join("")}
      </div>
      <h4 class="card-title">${escapeHtml(title)}</h4>
      ${body ? `<p class="body-text">${escapeHtml(body)}</p>` : ""}
      ${type === "mistake" && item.image ? `<img class="mistake-image" src="${item.image}" alt="错题图片" />` : ""}
      <div class="card-actions">
        <button class="small-button" onclick="openEditItem('${type}','${item.id}')">编辑</button>
        <button class="small-button" onclick="openReview('${type}','${item.id}','')">记录复习</button>
        <button class="small-button danger" onclick="deleteItem('${type}','${item.id}')">删除</button>
      </div>
    </article>
  `;
}

function renderTags() {
  const roots = tagTreeRows().filter((row) => row.depth === 0).map((row) => row.tag);
  document.getElementById("tagList").innerHTML = roots.length
    ? `<div class="tag-tree">${roots.map(renderTagTreeNode).join("")}</div>`
    : empty("还没有知识点。先在左侧新增，之后错题可直接从知识点树里选择。");
}

function renderTagTreeNode(tag) {
  const descendantIds = descendantTagIds(tag.id);
  const linked = getAllItems().filter((item) => (item.tagIds || []).some((tagId) => descendantIds.includes(tagId)));
  const directLinked = getAllItems().filter((item) => (item.tagIds || []).includes(tag.id));
  const avg = linked.length ? Math.round(linked.reduce((sum, item) => sum + currentScore(item), 0) / linked.length) : 100;
  const children = state.tags
    .filter((child) => child.parentId === tag.id)
    .sort((a, b) => tagPath(a).localeCompare(tagPath(b), "zh-CN"));
  return `
    <div class="tag-tree-node">
      <article class="tag-card">
        <div class="meta">
          ${renderTagPill(tag)}
          <span class="badge ${tag.importance}">${importanceLabel(tag.importance)}</span>
          <span>${directLinked.length} 条直接关联</span>
          <span>${linked.length} 条含子知识点</span>
          <span>平均记忆分 ${avg}</span>
        </div>
        <div class="card-actions">
          <button class="small-button" onclick="renameTag('${tag.id}')">重命名</button>
          <button class="small-button" onclick="cycleImportance('${tag.id}')">切换重要性</button>
          <button class="small-button danger" onclick="deleteTag('${tag.id}')">删除</button>
        </div>
      </article>
      ${children.length ? `<div class="tag-tree-children">${children.map(renderTagTreeNode).join("")}</div>` : ""}
    </div>
  `;
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

function renderWeakTags() {
  const summaries = state.tags.map((tag) => {
    const descendantIds = descendantTagIds(tag.id);
    const linked = getAllItems().filter((item) => (item.tagIds || []).some((tagId) => descendantIds.includes(tagId)));
    if (!linked.length) return null;
    const avg = Math.round(linked.reduce((sum, item) => sum + currentScore(item), 0) / linked.length);
    const weakCount = linked.filter((item) => currentScore(item) < 60).length;
    return { tag, avg, weakCount };
  }).filter(Boolean)
    .sort((a, b) => a.avg - b.avg || b.weakCount - a.weakCount)
    .slice(0, 8);

  return summaries.length
    ? summaries.map(({ tag, avg, weakCount }) => `
      <article class="tag-card">
        <div class="meta">
          ${renderTagPill(tag)}
          <span class="badge ${tag.importance}">${importanceLabel(tag.importance)}</span>
        </div>
        <p class="body-text">平均记忆分 ${avg}，薄弱内容 ${weakCount} 条</p>
      </article>
    `).join("")
    : empty("还没有可分析的知识点。");
}

function renderTagOptions() {
  document.getElementById("tagOptions").innerHTML = [...state.tags]
    .sort((a, b) => tagPath(a).localeCompare(tagPath(b), "zh-CN"))
    .map((tag) => `<option value="${escapeHtml(tagPath(tag))}"></option>`)
    .join("");
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
  const options = [
    '<option value="">选择一个知识点</option>',
    ...tagTreeRows()
      .map(({ tag, depth }) => `<option value="${escapeHtml(tagPath(tag))}">${escapeHtml(treeOptionLabel(tag, depth))}</option>`),
  ].join("");
  document.querySelectorAll(".existing-tag-select").forEach((select) => {
    const previous = select.value;
    select.innerHTML = options;
    if ([...select.options].some((option) => option.value === previous)) select.value = previous;
  });
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

function renderSelectedTagChipsFor(inputSelector, containerId) {
  const input = document.querySelector(inputSelector);
  const container = document.getElementById(containerId);
  if (!input || !container) return;
  const tags = parseTags(input.value);
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
    <input class="${kind}-tree-level-input" list="tagOptions" placeholder="输入或选择本级知识点" value="${escapeHtml(value)}" />
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
    lastReviewedAt: existing?.lastReviewedAt,
    createdAt: existing?.createdAt || now(),
    updatedAt: now(),
  };
  await put("study", item);
  if (!existing) await createNextTask("study", item, item.date);
  await loadState();
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
    lastReviewedAt: existing?.lastReviewedAt,
    date: existing?.date || toDateInput(new Date()),
    createdAt: existing?.createdAt || now(),
    updatedAt: now(),
  };
  await put("mistakes", item);
  if (!existing) await createNextTask("mistake", item, item.date);
  await loadState();
  form.reset();
  clearMistakeImage();
  form.closest("dialog").close();
  toast(existing ? "错题已更新。" : "错题已保存，并加入复习计划。");
  render();
}

async function createStudySimpleTag() {
  await createSimpleTag({
    nameId: "studySimpleTagName",
    importanceId: "studySimpleTagImportance",
    targetSelector: "#studyForm [name='tags']",
    emptyMessage: "先输入普通标签名。",
    successLabel: "普通标签",
  });
}

async function createMistakeSimpleTag() {
  await createSimpleTag({
    nameId: "mistakeSimpleTagName",
    importanceId: "mistakeSimpleTagImportance",
    targetSelector: "#mistakeForm [name='tags']",
    emptyMessage: "先输入错题标签名。",
    successLabel: "错题标签",
  });
}

async function createSimpleTag({ nameId, importanceId, targetSelector, emptyMessage, successLabel }) {
  const nameInput = document.getElementById(nameId);
  const importanceInput = document.getElementById(importanceId);
  const name = nameInput.value.trim();
  if (!name) {
    toast(emptyMessage);
    return;
  }
  const tag = await createOrUpdateTag({ name, parentId: "", importance: importanceInput.value });
  appendTagToInput(document.querySelector(targetSelector), tagPath(tag));
  nameInput.value = "";
  await refreshAfterTagChange();
  toast(`已添加${successLabel}“${tagPath(tag)}”。`);
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
  const tag = await createTagChain(parts, "", importance);
  appendTagToInput(document.querySelector(targetSelector), tagPath(tag));
  clearTreeBuilder(kind);
  await refreshAfterTagChange();
  toast(`已添加${successLabel}“${tagPath(tag)}”。`);
}

function addExistingStudyTag() {
  const select = document.getElementById("studyExistingTagSelect");
  if (!select.value) {
    toast("先选择一个已有知识点。");
    return;
  }
  appendTagToInput(document.querySelector("#studyForm [name='tags']"), select.value);
  select.value = "";
  toast("已添加到学习记录。");
}

function addExistingMistakeTag() {
  const select = document.getElementById("mistakeExistingTagSelect");
  if (!select.value) {
    toast("先选择一个已有知识点。");
    return;
  }
  appendTagToInput(document.querySelector("#mistakeForm [name='tags']"), select.value);
  select.value = "";
  toast("已添加到错题关联知识点。");
}

async function deleteExistingTagFromSelect(selectId) {
  const select = document.getElementById(selectId);
  if (!select.value) {
    toast("先选择要删除的知识点。");
    return;
  }
  const selectedPath = select.value;
  const tag = findTagByPath(selectedPath);
  if (!tag) {
    toast("没有找到这个知识点。");
    return;
  }
  removeTagValueFromOpenForms(selectedPath);
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
    id: "main",
    examDate: data.get("examDate"),
    cramWindow: Number(data.get("cramWindow")) || 14,
    dailyCramLimit: Number(data.get("dailyCramLimit")) || 20,
    updatedAt: now(),
  };
  await put("settings", state.settings);
  await loadState();
  toast("设置已保存。");
  render();
}

async function saveReview(event) {
  event.preventDefault();
  const form = event.currentTarget;
  const data = new FormData(form);
  const sourceType = data.get("sourceType");
  const sourceId = data.get("sourceId");
  const taskId = data.get("taskId");
  const logId = data.get("logId");
  const recallPercent = clamp(Number(data.get("recallPercent") || 0), 0, 100);
  const result = resultFromPercent(recallPercent);
  const item = findItem(sourceType, sourceId);
  if (!item) return;

  if (logId) {
    await updateReviewLog({ logId, sourceType, sourceId, taskId, recallPercent, result, notes: data.get("notes").trim() });
    form.reset();
    form.closest("dialog").close();
    toast("复习记录已修改。");
    render();
    return;
  }

  const beforeScore = currentScore(item);
  const afterScore = averageRecentRecallScore(sourceType, sourceId, recallPercent);
  const delta = afterScore - beforeScore;
  const previousIndex = item.currentIntervalIndex || 0;
  let nextIndex = previousIndex;
  let nextInterval = item.currentInterval || BASE_INTERVALS[previousIndex] || 1;

  if (recallPercent >= 85) {
    nextIndex = Math.min(previousIndex + 1, BASE_INTERVALS.length - 1);
    nextInterval = BASE_INTERVALS[nextIndex] || 30;
    if (previousIndex >= BASE_INTERVALS.length - 1) nextInterval = 30;
  } else if (recallPercent >= 60) {
    nextIndex = recallPercent >= 75 ? previousIndex : Math.max(0, previousIndex - 1);
    nextInterval = Math.max(1, Math.ceil((item.currentInterval || BASE_INTERVALS[previousIndex] || 1) * (recallPercent / 100)));
  } else if (recallPercent >= 40) {
    nextInterval = Math.max(1, Math.ceil((item.currentInterval || BASE_INTERVALS[previousIndex] || 1) / 2));
    nextIndex = Math.max(0, previousIndex - 1);
  } else {
    nextIndex = 0;
    nextInterval = 1;
  }

  item.memoryScore = afterScore;
  item.currentIntervalIndex = nextIndex;
  item.currentInterval = nextInterval;
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
    id: id("log"),
    sourceType,
    sourceId,
    taskId,
    result,
    recallPercent,
    notes: data.get("notes").trim(),
    beforeScore,
    afterScore,
    delta,
    date: toDateInput(new Date()),
    createdAt: now(),
  });

  await createNextTask(sourceType, item, toDateInput(new Date()), result);
  await loadState();
  form.reset();
  form.closest("dialog").close();
  toast(`已记录为“记住 ${recallPercent}%”，下一次复习已更新。`);
  render();
}

async function updateReviewLog({ logId, sourceType, sourceId, taskId, recallPercent, result, notes }) {
  const log = state.logs.find((row) => row.id === logId);
  const item = findItem(sourceType, sourceId);
  if (!log || !item) return;
  const beforeScore = Number(log.beforeScore ?? currentScore(item));
  const afterScore = averageRecentRecallScore(sourceType, sourceId, recallPercent, logId);
  item.memoryScore = afterScore;
  item.updatedAt = now();
  if (log.date === toDateInput(new Date())) item.lastReviewedAt = log.date;
  await put(sourceType === "study" ? "study" : "mistakes", item);

  log.result = result;
  log.recallPercent = recallPercent;
  log.notes = notes;
  log.afterScore = afterScore;
  log.delta = afterScore - beforeScore;
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
    task.updatedAt = now();
    await put("tasks", task);
  }
  await loadState();
}

async function createNextTask(sourceType, item, fromDate, result = "") {
  if (state.settings.examDate && fromDate >= state.settings.examDate) return;
  const adjusted = adjustedInterval(item, item.currentInterval || 1);
  const scheduledDate = capAtExam(addDays(fromDate, adjusted));
  if (!scheduledDate) return;
  const priority = priorityScore(item, false);
  await put("tasks", {
    id: id("task"),
    sourceType,
    sourceId: item.id,
    scheduledDate,
    status: "pending",
    priority,
    isCram: false,
    intervalDays: adjusted,
    createdByResult: result,
    createdAt: now(),
  });
}

function buildDisplayTasks() {
  const pending = state.tasks
    .filter((task) => task.status === "pending" && findItem(task.sourceType, task.sourceId))
    .map((task) => ({ ...task }));
  for (const cramTask of buildCramTasks()) {
    const existing = pending.find((task) => task.sourceType === cramTask.sourceType && task.sourceId === cramTask.sourceId);
    if (existing) {
      existing.isCram = true;
      existing.priority = Math.max(existing.priority || 0, cramTask.priority || 0);
    } else {
      pending.push(cramTask);
    }
  }
  return pending;
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
  const { examDate, cramWindow, dailyCramLimit } = state.settings;
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
      scheduledDate: today,
      status: "pending",
      priority: priorityScore(item, true),
      isCram: true,
    }))
    .sort((a, b) => b.priority - a.priority)
    .slice(0, Number(dailyCramLimit) || 20);
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

function adjustedInterval(item, interval) {
  const multiplier = IMPORTANCE_MULTIPLIER[itemImportance(item)] || 1;
  return Math.max(1, Math.round(interval * multiplier));
}

function currentScore(item) {
  const base = Number(item.memoryScore ?? 70);
  const last = item.lastReviewedAt || item.date || item.createdAt?.slice(0, 10) || toDateInput(new Date());
  const decay = Math.floor(Math.max(0, diffDays(last, toDateInput(new Date()))) / 7) * 2;
  return clamp(base - decay, 0, 100);
}

function priorityScore(item, cram) {
  const recencyPenalty = Math.max(0, 12 - diffDays(item.lastReviewedAt || item.date || item.createdAt.slice(0, 10), toDateInput(new Date())));
  return (100 - currentScore(item)) + IMPORTANCE_WEIGHT[itemImportance(item)] + (cram ? 20 : 0) - recencyPenalty;
}

function resultFromPercent(percent) {
  if (percent >= 85) return "remembered";
  if (percent >= 40) return "unclear";
  return "forgotten";
}

function averageRecentRecallScore(sourceType, sourceId, currentPercent, excludeLogId = "") {
  const recentScores = [
    clamp(Number(currentPercent) || 0, 0, 100),
    ...state.logs
      .filter((log) => log.sourceType === sourceType && log.sourceId === sourceId && log.id !== excludeLogId)
      .sort((a, b) => (b.createdAt || b.date || "").localeCompare(a.createdAt || a.date || ""))
      .map((log) => Number(log.recallPercent ?? log.afterScore))
      .filter((score) => Number.isFinite(score))
      .map((score) => clamp(score, 0, 100)),
  ].slice(0, 10);
  const total = recentScores.reduce((sum, score) => sum + score, 0);
  return Math.round(total / recentScores.length);
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

async function ensureTags(names) {
  const ids = [];
  for (const name of names) {
    const tag = await ensureTagPath(name);
    ids.push(tag.id);
  }
  return [...new Set(ids)];
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
  form.elements.id.value = "";
  document.getElementById("studyModalTitle").textContent = "新增学习记录";
  document.getElementById("studySubmitBtn").textContent = "保存";
  setDefaultDates();
  renderSelectedTagChips();
}

function prepareNewMistakeForm() {
  const form = document.getElementById("mistakeForm");
  form.reset();
  form.elements.id.value = "";
  form.elements.removeImage.value = "";
  document.getElementById("mistakeModalTitle").textContent = "新增错题";
  document.getElementById("mistakeSubmitBtn").textContent = "保存";
  clearMistakeImage();
  renderSelectedTagChips();
}

function openEditItem(type, idValue) {
  if (type === "study") {
    openEditStudy(idValue);
  } else {
    openEditMistake(idValue);
  }
}

function openEditStudy(idValue) {
  const item = state.study.find((row) => row.id === idValue);
  if (!item) return;
  const form = document.getElementById("studyForm");
  form.reset();
  form.elements.id.value = item.id;
  form.elements.title.value = item.title || "";
  form.elements.date.value = item.date || toDateInput(new Date());
  form.elements.studyKind.value = item.studyKind || "new";
  form.elements.tags.value = tagsFor(item.tagIds).map(tagPath).join("，");
  form.elements.notes.value = item.notes || "";
  document.getElementById("studyModalTitle").textContent = "编辑学习记录";
  document.getElementById("studySubmitBtn").textContent = "保存修改";
  renderSelectedTagChips();
  document.getElementById("studyModal").showModal();
}

function openEditMistake(idValue) {
  const item = state.mistakes.find((row) => row.id === idValue);
  if (!item) return;
  const form = document.getElementById("mistakeForm");
  form.reset();
  form.elements.id.value = item.id;
  form.elements.removeImage.value = "";
  form.elements.location.value = item.location || "";
  form.elements.question.value = item.question || "";
  form.elements.answer.value = item.answer || "";
  form.elements.reason.value = item.reason || "";
  form.elements.tags.value = tagsFor(item.tagIds).map(tagPath).join("，");
  clearMistakeImage();
  if (item.image) showMistakeImagePreview(item.image);
  document.getElementById("mistakeModalTitle").textContent = "编辑错题";
  document.getElementById("mistakeSubmitBtn").textContent = "保存修改";
  renderSelectedTagChips();
  document.getElementById("mistakeModal").showModal();
}

function openReview(sourceType, sourceId, taskId) {
  const item = findItem(sourceType, sourceId);
  if (!item) return;
  const title = sourceType === "study" ? item.title : item.location || firstLine(item.question) || "未命名错题";
  document.getElementById("reviewModalTitle").textContent = `记录复习结果：${title}`;
  const form = document.getElementById("reviewForm");
  form.sourceType.value = sourceType;
  form.sourceId.value = sourceId;
  form.taskId.value = taskId;
  form.logId.value = "";
  form.elements.notes.value = "";
  setRecallPercent(80);
  document.getElementById("reviewModal").showModal();
}

function openEditReview(logId) {
  const log = state.logs.find((row) => row.id === logId);
  if (!log) return;
  const item = findItem(log.sourceType, log.sourceId);
  if (!item) return;
  const title = log.sourceType === "study" ? item.title : item.location || firstLine(item.question) || "未命名错题";
  document.getElementById("reviewModalTitle").textContent = `修改复习记录：${title}`;
  const form = document.getElementById("reviewForm");
  form.sourceType.value = log.sourceType;
  form.sourceId.value = log.sourceId;
  form.taskId.value = log.taskId || "";
  form.logId.value = log.id;
  form.elements.notes.value = log.notes || "";
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

async function postponeTask(taskId, sourceType, sourceId) {
  if (taskId && !taskId.startsWith("cram-")) {
    const task = state.tasks.find((row) => row.id === taskId);
    if (task) {
      task.scheduledDate = addDays(toDateInput(new Date()), 1);
      task.updatedAt = now();
      await put("tasks", task);
    }
  } else {
    const item = findItem(sourceType, sourceId);
    if (item) await createNextTask(sourceType, item, toDateInput(new Date()), "postponed");
  }
  await loadState();
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
  await loadState();
  toast("示例数据已加入。");
  render();
}

function exportJson() {
  download(`memory-review-backup-${toDateInput(new Date())}.json`, JSON.stringify(state, null, 2), "application/json");
}

function exportCsv() {
  const rows = [
    ["类型", "学习记录类型", "标题/位置", "日期", "标签", "记忆分", "下次复习", "备注/错因"],
    ...state.study.map((item) => ["学习", studyKindLabel(item), item.title, item.date, tagsFor(item.tagIds).map(tagPath).join(";"), currentScore(item), nextTaskDate("study", item.id) || "", item.notes || ""]),
    ...state.mistakes.map((item) => ["错题", "", item.location || firstLine(item.question), item.date, tagsFor(item.tagIds).map(tagPath).join(";"), currentScore(item), nextTaskDate("mistake", item.id) || "", item.reason || ""]),
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
  await loadState();
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

function tagsFor(ids = []) {
  return ids.map((tagId) => state.tags.find((tag) => tag.id === tagId)).filter(Boolean);
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

function treeOptionLabel(tag, depth) {
  return `${"　".repeat(depth)}${depth ? "└ " : ""}${tag.name}`;
}

function nextTaskDate(type, sourceId) {
  const task = state.tasks
    .filter((row) => row.status === "pending" && row.sourceType === type && row.sourceId === sourceId)
    .sort((a, b) => a.scheduledDate.localeCompare(b.scheduledDate))[0];
  return task?.scheduledDate || "";
}

function matchesStudy(item, query) {
  if (!query) return true;
  return [item.title, item.notes, ...tagsFor(item.tagIds).map(tagPath)].join(" ").toLowerCase().includes(query);
}

function matchesMistake(item, query) {
  if (!query) return true;
  return [item.location, item.question, item.answer, item.reason, ...tagsFor(item.tagIds).map(tagPath)].join(" ").toLowerCase().includes(query);
}

function parseTags(value) {
  return String(value || "")
    .split(/[,，、\n]/)
    .map((name) => name.trim())
    .filter(Boolean);
}

function appendTagToInput(input, tagName) {
  const tags = parseTags(input.value);
  if (!tags.includes(tagName)) tags.push(tagName);
  input.value = tags.join("，");
  renderSelectedTagChips();
}

function removeTagFromField(containerId, tagName) {
  const inputSelector = containerId === "studySelectedTags" ? "#studyForm [name='tags']" : "#mistakeForm [name='tags']";
  const input = document.querySelector(inputSelector);
  input.value = parseTags(input.value).filter((tag) => tag !== tagName).join("，");
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
window.cycleImportance = cycleImportance;
