// ===== Utilities =====
const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => document.querySelectorAll(sel);

const todayISO = () => new Date().toISOString().slice(0, 10); // YYYY-MM-DD
const nowTime = () => new Date().toLocaleString("ja-JP", { hour12: false });

function escapeHTML(s) {
  return s.replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
  }[c]));
}

// ===== IndexedDB wrapper (tiny) =====
const DB_NAME = "Yuki_DB_Web";
const DB_VER = 1;

let db;

function openDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VER);

    req.onupgradeneeded = (e) => {
      const d = e.target.result;

      // jour: { id (auto), title (unique) }
      const jour = d.createObjectStore("jour", { keyPath: "jour_id", autoIncrement: true });
      jour.createIndex("jour_title", "jour_title", { unique: true });

      // memos: { id (auto), title, jour_title }
      const memos = d.createObjectStore("memos", { keyPath: "memo_id", autoIncrement: true });
      memos.createIndex("jour_title", "jour_title", { unique: false });

      // tasks: { id (auto), title, done, jour_title }
      const tasks = d.createObjectStore("tasks", { keyPath: "id", autoIncrement: true });
      tasks.createIndex("jour_title", "jour_title", { unique: false });
      tasks.createIndex("done", "done", { unique: false });
    };

    req.onsuccess = () => { db = req.result; resolve(db); };
    req.onerror = () => reject(req.error);
  });
}

function tx(storeName, mode = "readonly") {
  const t = db.transaction(storeName, mode);
  return t.objectStore(storeName);
}

function idbGetAll(storeName) {
  return new Promise((resolve, reject) => {
    const req = tx(storeName).getAll();
    req.onsuccess = () => resolve(req.result || []);
    req.onerror = () => reject(req.error);
  });
}

function idbAdd(storeName, value) {
  return new Promise((resolve, reject) => {
    const req = tx(storeName, "readwrite").add(value);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function idbPut(storeName, value) {
  return new Promise((resolve, reject) => {
    const req = tx(storeName, "readwrite").put(value);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function idbDelete(storeName, key) {
  return new Promise((resolve, reject) => {
    const req = tx(storeName, "readwrite").delete(key);
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error);
  });
}

function idbIndexGetAll(storeName, indexName, indexValue) {
  return new Promise((resolve, reject) => {
    const store = tx(storeName);
    const idx = store.index(indexName);
    const range = IDBKeyRange.only(indexValue);
    const req = idx.getAll(range);
    req.onsuccess = () => resolve(req.result || []);
    req.onerror = () => reject(req.error);
  });
}

// ===== App state =====
let currentJourTitle = todayISO();

// ===== Modal helper =====
const modal = $("#modal");
const modalTitle = $("#modalTitle");
const modalLabel = $("#modalLabel");
const modalInput = $("#modalInput");
const modalHelp = $("#modalHelp");

function promptModal({ title, label, placeholder = "", help = "", initial = "" }) {
  modalTitle.textContent = title;
  modalLabel.textContent = label;
  modalHelp.textContent = help;
  modalInput.value = initial;
  modalInput.placeholder = placeholder;

  return new Promise((resolve) => {
    modal.addEventListener("close", () => {
      if (modal.returnValue === "ok") resolve(modalInput.value.trim());
      else resolve(null);
    }, { once: true });

    modal.showModal();
    setTimeout(() => modalInput.focus(), 50);
  });
}

// ===== Core actions =====
async function ensureTodayJour() {
  const title = todayISO();
  currentJourTitle = title;
  $("#todayPill").textContent = title;

  // Try insert if not exists
  try {
    await idbAdd("jour", { jour_title: title, created_at: nowTime() });
    toast("✅ 今日のジャーナルを作成したよ！");
  } catch (e) {
    // likely unique constraint
    toast("📝 今日のジャーナルに追加しよう！");
  }
  await renderAll();
}

async function setCurrentJour(title) {
  currentJourTitle = title;
  $("#todayPill").textContent = title;
  $("#heroTitle").textContent = `${title} のジャーナル`;
  await renderAll();
}

async function addMemo() {
  const v = await promptModal({
    title: "メモ追加",
    label: "メモ名",
    placeholder: "例）朝：やること/気づき",
    help: "保存はこの端末のブラウザ内に行われます。",
  });
  if (!v) return;
  await idbAdd("memos", { memo_title: v, jour_title: currentJourTitle, created_at: nowTime() });
  toast("✅ メモを追加したよ");
  await renderMemos();
}

async function addTask() {
  const v = await promptModal({
    title: "タスク作成",
    label: "タスク名",
    placeholder: "例）洗濯 / レポート / 筋トレ",
    help: "完了したらチェックしてね。",
  });
  if (!v) return;
  await idbAdd("tasks", { title: v, done: 0, jour_title: currentJourTitle, created_at: nowTime() });
  toast("✅ タスクを追加したよ");
  await renderTasks();
}

async function deleteJour(jourTitle) {
  // Delete jour row itself
  const allJour = await idbGetAll("jour");
  const target = allJour.find(j => j.jour_title === jourTitle);
  if (!target) return;

  // Also delete related memos/tasks
  const memos = await idbIndexGetAll("memos", "jour_title", jourTitle);
  const tasks = await idbIndexGetAll("tasks", "jour_title", jourTitle);

  for (const m of memos) await idbDelete("memos", m.memo_id);
  for (const t of tasks) await idbDelete("tasks", t.id);
  await idbDelete("jour", target.jour_id);

  toast("🗑 ジャーナルを削除したよ");
  // Move to today
  await ensureTodayJour();
}

async function deleteMemo(memoId) {
  await idbDelete("memos", memoId);
  toast("🗑 メモを削除したよ");
  await renderMemos();
}

async function deleteTask(taskId) {
  await idbDelete("tasks", taskId);
  toast("🗑 タスクを削除したよ");
  await renderTasks();
}

async function toggleTaskDone(task) {
  await idbPut("tasks", { ...task, done: task.done ? 0 : 1 });
  await renderTasks();
}

// ===== Rendering =====
async function renderJour() {
  const list = $("#jourList");
  const q = $("#jourSearch").value.trim().toLowerCase();

  let rows = await idbGetAll("jour");
  rows.sort((a, b) => (a.jour_title > b.jour_title ? -1 : 1)); // newest first

  if (q) rows = rows.filter(r => (r.jour_title || "").toLowerCase().includes(q));

  list.innerHTML = "";
  if (!rows.length) {
    list.innerHTML = `<div class="hint">まだジャーナルがありません。「今日」を押して作成してね。</div>`;
    return;
  }

  for (const r of rows) {
    const isCurrent = r.jour_title === currentJourTitle;
    const el = document.createElement("div");
    el.className = "item";
    el.innerHTML = `
      <div class="left">
        <div class="name">${escapeHTML(r.jour_title)}</div>
        <div class="meta">${isCurrent ? "現在開いているジャーナル" : "タップで開く"}</div>
      </div>
      <div class="right">
        ${isCurrent ? `<span class="badge">OPEN</span>` : `<button class="btn ghost openJour">開く</button>`}
        <button class="btn ghost delJour">削除</button>
      </div>
    `;

    el.querySelector(".openJour")?.addEventListener("click", () => setCurrentJour(r.jour_title));
    el.querySelector(".delJour").addEventListener("click", async () => {
      const ok = confirm(`${r.jour_title} を削除しますか？（メモ/タスクも消えます）`);
      if (ok) await deleteJour(r.jour_title);
    });

    list.appendChild(el);
  }
}

async function renderMemos() {
  const list = $("#memoList");
  const memos = await idbIndexGetAll("memos", "jour_title", currentJourTitle);
  memos.sort((a, b) => (a.memo_id ?? 0) - (b.memo_id ?? 0));

  list.innerHTML = "";
  if (!memos.length) {
    list.innerHTML = `<div class="hint">メモがありません。「＋追加」で作ってね。</div>`;
    return;
  }

  for (const m of memos) {
    const el = document.createElement("div");
    el.className = "item";
    el.innerHTML = `
      <div class="left">
        <div class="name">${escapeHTML(m.memo_title)}</div>
        <div class="meta">作成: ${escapeHTML(m.created_at || "")}</div>
      </div>
      <div class="right">
        <button class="btn ghost">削除</button>
      </div>
    `;
    el.querySelector("button").addEventListener("click", () => {
      const ok = confirm("このメモを削除しますか？");
      if (ok) deleteMemo(m.memo_id);
    });
    list.appendChild(el);
  }
}

async function renderTasks() {
  const list = $("#taskList");
  const hideDone = $("#hideDone").checked;

  let tasks = await idbIndexGetAll("tasks", "jour_title", currentJourTitle);
  tasks.sort((a, b) => (a.id ?? 0) - (b.id ?? 0));

  if (hideDone) tasks = tasks.filter(t => !t.done);

  list.innerHTML = "";
  if (!tasks.length) {
    list.innerHTML = `<div class="hint">タスクがありません。「＋追加」で作ってね。</div>`;
    return;
  }

  for (const t of tasks) {
    const el = document.createElement("div");
    el.className = "item";
    el.innerHTML = `
      <div class="left">
        <div class="name">${escapeHTML(t.title)}</div>
        <div class="meta">作成: ${escapeHTML(t.created_at || "")}</div>
      </div>
      <div class="right">
        <span class="badge ${t.done ? "done" : "todo"}">${t.done ? "〇 完了" : "× 未完了"}</span>
        <button class="btn ghost toggle">${t.done ? "戻す" : "完了"}</button>
        <button class="btn ghost del">削除</button>
      </div>
    `;
    el.querySelector(".toggle").addEventListener("click", () => toggleTaskDone(t));
    el.querySelector(".del").addEventListener("click", () => {
      const ok = confirm("このタスクを削除しますか？");
      if (ok) deleteTask(t.id);
    });
    list.appendChild(el);
  }
}

async function renderAll() {
  $("#heroTitle").textContent = `${currentJourTitle} のジャーナル`;
  await Promise.all([renderJour(), renderMemos(), renderTasks()]);
}

// ===== Tabs =====
function setupTabs() {
  $$(".tab").forEach(btn => {
    btn.addEventListener("click", () => {
      $$(".tab").forEach(b => b.classList.remove("active"));
      btn.classList.add("active");
      const tab = btn.dataset.tab;

      $("#pane-memos").classList.toggle("hidden", tab !== "memos");
      $("#pane-tasks").classList.toggle("hidden", tab !== "tasks");
    });
  });
}

// ===== Toast (simple) =====
let toastTimer;
function toast(msg) {
  clearTimeout(toastTimer);
  let el = $("#toast");
  if (!el) {
    el = document.createElement("div");
    el.id = "toast";
    el.style.position = "fixed";
    el.style.left = "50%";
    el.style.bottom = "70px";
    el.style.transform = "translateX(-50%)";
    el.style.padding = "10px 12px";
    el.style.borderRadius = "14px";
    el.style.border = "1px solid rgba(255,255,255,.12)";
    el.style.background = "rgba(11,18,32,.92)";
    el.style.color = "rgba(232,238,252,.95)";
    el.style.backdropFilter = "blur(10px)";
    el.style.zIndex = "9999";
    document.body.appendChild(el);
  }
  el.textContent = msg;
  el.style.opacity = "1";
  toastTimer = setTimeout(() => { el.style.opacity = "0"; }, 1800);
}

// ===== Init =====
async function main() {
  await openDB();

  // UI hooks
  $("#newTodayBtn").addEventListener("click", ensureTodayJour);
  $("#addMemoBtn").addEventListener("click", addMemo);
  $("#addTaskBtn").addEventListener("click", addTask);
  $("#addMemoQuick").addEventListener("click", addMemo);
  $("#addTaskQuick").addEventListener("click", addTask);
  $("#refreshJour").addEventListener("click", renderJour);
  $("#jourSearch").addEventListener("input", renderJour);
  $("#hideDone").addEventListener("change", renderTasks);

  setupTabs();

  // Start with today
  $("#todayPill").textContent = todayISO();
  await ensureTodayJour();
}

main().catch((e) => {
  console.error(e);
  alert("初期化に失敗しました。ブラウザがIndexedDBに対応しているか確認してね。");
});
