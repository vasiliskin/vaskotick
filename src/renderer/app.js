'use strict';

/* ============================================================
   Учёт рабочего времени — логика рендерера.
   Работает в двух режимах:
   - Electron: данные в JSON-файле (через window.tt из preload)
   - Браузер:  данные в localStorage
   ============================================================ */

/* ---------- Утилиты ---------- */
const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 9);

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

function fmtHMS(ms) {
  const s = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  return [h, m, sec].map((v) => String(v).padStart(2, '0')).join(':');
}

function fmtHuman(ms) {
  const min = Math.round(ms / 60000);
  if (min < 1) return 'менее минуты';
  const h = Math.floor(min / 60);
  const m = min % 60;
  if (h && m) return `${h} ч ${m} мин`;
  if (h) return `${h} ч`;
  return `${m} мин`;
}

const fmtDate = (ts) => new Date(ts).toLocaleDateString('ru-RU');
const fmtTime = (ts) => new Date(ts).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });
const fmtDateTime = (ts) => `${fmtDate(ts)} ${fmtTime(ts)}`;

/* ---------- Хранилище ---------- */
const isElectron = typeof window.tt !== 'undefined';
const LS_KEY = 'worktime-tracker-data';

const storage = {
  async load() {
    if (isElectron) return await window.tt.loadData();
    try {
      const raw = localStorage.getItem(LS_KEY);
      return raw ? JSON.parse(raw) : null;
    } catch {
      return null;
    }
  },
  async save(state) {
    if (isElectron) return await window.tt.saveData(state);
    localStorage.setItem(LS_KEY, JSON.stringify(state));
    return true;
  },
};

/* ---------- Состояние ---------- */
function emptyState() {
  return { version: 1, projects: [], tasks: [], sessions: [], timer: null };
}

let state = emptyState();
const ui = { selectedProjectId: null, view: 'tasks', reportPeriod: 'today' };

function getProject(id) { return state.projects.find((p) => p.id === id); }
function getTask(id) { return state.tasks.find((t) => t.id === id); }
function tasksOf(projectId) { return state.tasks.filter((t) => t.projectId === projectId); }
function sessionsOf(taskId) { return state.sessions.filter((s) => s.taskId === taskId); }

/* Общее время задачи = сумма всех её сессий (включая ручные корректировки) */
function taskTotalMs(taskId) {
  return sessionsOf(taskId).reduce((sum, s) => sum + s.durationMs, 0);
}

/* ---------- Таймер ----------
   timer = { taskId, sessionStart, segmentStart, accumulatedMs, paused }
   Все метки — абсолютные таймстемпы, поэтому время не теряется
   даже если приложение закрыть: при запуске отсчёт продолжится. */
function timerElapsedMs() {
  const t = state.timer;
  if (!t) return 0;
  return t.accumulatedMs + (t.paused ? 0 : Date.now() - t.segmentStart);
}

function startTimer(taskId) {
  if (state.timer) {
    if (state.timer.taskId === taskId) return;
    confirmModal(
      'Сменить задачу?',
      'Переключить таймер на другую задачу',
      'Да, переключить'
    ).then((ok) => {
      if (!ok) return;
      stopTimer();
      startTimer(taskId);
    });
    return;
  }
  const now = Date.now();
  state.timer = { taskId, sessionStart: now, segmentStart: now, accumulatedMs: 0, paused: false };
  saveAndRender();
}

function pauseTimer() {
  const t = state.timer;
  if (!t || t.paused) return;
  t.accumulatedMs += Date.now() - t.segmentStart;
  t.paused = true;
  saveAndRender();
}

function resumeTimer() {
  const t = state.timer;
  if (!t || !t.paused) return;
  t.segmentStart = Date.now();
  t.paused = false;
  saveAndRender();
}

function stopTimer() {
  const t = state.timer;
  if (!t) return;
  const durationMs = timerElapsedMs();
  if (durationMs >= 1000) {
    state.sessions.push({
      id: uid(),
      taskId: t.taskId,
      start: t.sessionStart,
      end: Date.now(),
      durationMs,
      note: '',
      manual: false,
    });
    toast(`Записано: ${fmtHuman(durationMs)} — «${getTask(t.taskId)?.name ?? '?'}»`);
  } else {
    toast('Сессия короче секунды — не записана');
  }
  state.timer = null;
  saveAndRender();
}

/* ---------- CRUD: проекты ---------- */
async function addProject() {
  const name = await inputModal('Новый проект', 'Название проекта');
  if (!name) return;
  const project = { id: uid(), name, createdAt: Date.now() };
  state.projects.push(project);
  ui.selectedProjectId = project.id;
  saveAndRender();
}

async function renameProject(id) {
  const p = getProject(id);
  if (!p) return;
  const name = await inputModal('Переименовать проект', 'Название проекта', p.name);
  if (!name) return;
  p.name = name;
  saveAndRender();
}

async function deleteProject(id) {
  const p = getProject(id);
  if (!p) return;
  const nTasks = tasksOf(id).length;
  const ok = await confirmModal(
    'Удалить проект?',
    `Проект «${p.name}» и ${nTasks} ${plural(nTasks, 'задача', 'задачи', 'задач')} со всей историей будут удалены безвозвратно.`,
    'Удалить',
    true
  );
  if (!ok) return;
  if (state.timer && getTask(state.timer.taskId)?.projectId === id) state.timer = null;
  const taskIds = new Set(tasksOf(id).map((t) => t.id));
  state.sessions = state.sessions.filter((s) => !taskIds.has(s.taskId));
  state.tasks = state.tasks.filter((t) => t.projectId !== id);
  state.projects = state.projects.filter((pr) => pr.id !== id);
  if (ui.selectedProjectId === id) ui.selectedProjectId = null;
  saveAndRender();
}

function plural(n, one, few, many) {
  const mod10 = n % 10, mod100 = n % 100;
  if (mod10 === 1 && mod100 !== 11) return one;
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 10 || mod100 >= 20)) return few;
  return many;
}

/* ---------- CRUD: задачи ---------- */
async function addTask() {
  const projectId = ui.selectedProjectId;
  if (!projectId) return;
  const data = await taskModal('Новая задача');
  if (!data) return;
  state.tasks.push({ id: uid(), projectId, ...data, createdAt: Date.now() });
  saveAndRender();
}

async function editTask(id) {
  const t = getTask(id);
  if (!t) return;
  const data = await taskModal('Редактировать задачу', t);
  if (!data) return;
  Object.assign(t, data);
  saveAndRender();
}

async function deleteTask(id) {
  const t = getTask(id);
  if (!t) return;
  const ok = await confirmModal(
    'Удалить задачу?',
    `Задача «${t.name}» и вся её история сессий будут удалены.`,
    'Удалить',
    true
  );
  if (!ok) return;
  if (state.timer?.taskId === id) state.timer = null;
  state.sessions = state.sessions.filter((s) => s.taskId !== id);
  state.tasks = state.tasks.filter((x) => x.id !== id);
  saveAndRender();
}

async function adjustTaskTime(id) {
  const t = getTask(id);
  if (!t) return;
  const minutes = await adjustModal(t);
  if (minutes === null || minutes === 0) return;
  const deltaMs = minutes * 60000;
  const current = taskTotalMs(id);
  if (current + deltaMs < 0) {
    toast('Итоговое время не может быть отрицательным');
    return;
  }
  const now = Date.now();
  state.sessions.push({
    id: uid(), taskId: id, start: now, end: now, durationMs: deltaMs,
    note: 'Ручная корректировка', manual: true,
  });
  toast(`Скорректировано: ${minutes > 0 ? '+' : ''}${minutes} мин — «${t.name}»`);
  saveAndRender();
}

/* ---------- Отчёты ---------- */
function periodStart(period) {
  const d = new Date();
  if (period === 'today') { d.setHours(0, 0, 0, 0); return d.getTime(); }
  if (period === 'week') {
    const day = (d.getDay() + 6) % 7; // понедельник = 0
    d.setDate(d.getDate() - day);
    d.setHours(0, 0, 0, 0);
    return d.getTime();
  }
  if (period === 'month') { d.setDate(1); d.setHours(0, 0, 0, 0); return d.getTime(); }
  return 0;
}

function sessionsInPeriod(period) {
  const from = periodStart(period);
  return state.sessions.filter((s) => s.end >= from);
}

function taskLabel(taskId) {
  const t = getTask(taskId);
  if (!t) return '(удалённая задача)';
  const p = getProject(t.projectId);
  return `${p ? p.name + ' / ' : ''}${t.name}`;
}

/* ---------- Экспорт ---------- */
function buildReportText() {
  const lines = [];
  lines.push('УЧЁТ РАБОЧЕГО ВРЕМЕНИ');
  lines.push(`Сформировано: ${fmtDateTime(Date.now())}`);
  lines.push('');

  let grandTotal = 0;
  for (const p of state.projects) {
    const pTasks = tasksOf(p.id);
    const pTotal = pTasks.reduce((sum, t) => sum + taskTotalMs(t.id), 0);
    grandTotal += pTotal;
    lines.push('='.repeat(56));
    lines.push(`ПРОЕКТ: ${p.name}`);
    lines.push(`Всего по проекту: ${fmtHuman(pTotal)}`);
    lines.push('-'.repeat(56));
    for (const t of pTasks) {
      const total = taskTotalMs(t.id);
      lines.push(`  • ${t.name} — ${fmtHuman(total)}`);
      if (t.tags?.length) lines.push(`      теги: ${t.tags.join(', ')}`);
      if (t.notes) lines.push(`      заметки: ${t.notes.replace(/\n/g, ' ')}`);
    }
    if (!pTasks.length) lines.push('  (задач нет)');
    lines.push('');
  }

  lines.push('='.repeat(56));
  lines.push(`ИТОГО ПО ВСЕМ ПРОЕКТАМ: ${fmtHuman(grandTotal)}`);
  lines.push('');

  lines.push('ИСТОРИЯ СЕССИЙ');
  lines.push('-'.repeat(56));
  const sorted = [...state.sessions].sort((a, b) => a.start - b.start);
  for (const s of sorted) {
    const sign = s.manual && s.durationMs < 0 ? '-' : '';
    const dur = s.manual
      ? `${sign}${fmtHuman(Math.abs(s.durationMs))} (ручная корректировка)`
      : `${fmtTime(s.start)}–${fmtTime(s.end)} (${fmtHuman(s.durationMs)})`;
    lines.push(`  ${fmtDate(s.start)}  ${dur}  —  ${taskLabel(s.taskId)}${s.note && !s.manual ? '  [' + s.note + ']' : ''}`);
  }
  if (!sorted.length) lines.push('  (сессий пока нет)');
  lines.push('');
  return lines.join('\n');
}

async function exportTxt() {
  const text = buildReportText();
  const name = `worktime-${new Date().toISOString().slice(0, 10)}.txt`;
  if (isElectron) {
    const savedTo = await window.tt.exportTxt(text, name);
    toast(savedTo ? `Файл сохранён: ${savedTo}` : 'Экспорт отменён');
  } else {
    const blob = new Blob(['﻿' + text], { type: 'text/plain;charset=utf-8' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = name;
    a.click();
    URL.revokeObjectURL(a.href);
    toast(`Файл ${name} скачан`);
  }
}

/* ---------- Рендер: проекты ---------- */
function renderProjects() {
  const list = $('#project-list');
  const empty = $('#projects-empty');
  empty.hidden = state.projects.length > 0;

  list.innerHTML = state.projects.map((p) => {
    const pTasks = tasksOf(p.id);
    const total = pTasks.reduce((sum, t) => sum + taskTotalMs(t.id), 0);
    return `
      <li class="project-item ${p.id === ui.selectedProjectId ? 'active' : ''}"
          data-project-id="${p.id}" tabindex="0" role="button">
        <span class="project-name">${esc(p.name)}</span>
        <span class="project-meta">${pTasks.length} · ${fmtHuman(total)}</span>
        <span class="row-actions">
          <button class="icon-btn" data-action="edit-project" data-id="${p.id}" title="Переименовать" aria-label="Переименовать проект">
            <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17 3a2.8 2.8 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z"/></svg>
          </button>
          <button class="icon-btn" data-action="delete-project" data-id="${p.id}" title="Удалить" aria-label="Удалить проект">
            <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6"/><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>
          </button>
        </span>
      </li>`;
  }).join('');
}

/* ---------- Рендер: задачи ---------- */
function renderTasks() {
  const list = $('#task-list');
  const empty = $('#tasks-empty');
  const addBtn = $('#btn-add-task');
  const headName = $('#current-project-name');

  const project = getProject(ui.selectedProjectId);
  addBtn.disabled = !project;
  headName.textContent = project ? project.name : 'Задачи';

  if (!project) {
    list.innerHTML = '';
    empty.hidden = false;
    empty.textContent = state.projects.length
      ? 'Выберите проект слева, чтобы увидеть его задачи.'
      : 'Сначала создайте проект.';
    return;
  }

  const pTasks = tasksOf(project.id);
  empty.hidden = pTasks.length > 0;
  empty.textContent = 'В этом проекте пока нет задач.';

  const runningId = state.timer?.taskId;

  list.innerHTML = pTasks.map((t) => {
    const isActive = runningId === t.id;
    const isPaused = isActive && state.timer.paused;
    const total = taskTotalMs(t.id);
    const nSessions = sessionsOf(t.id).filter((s) => !s.manual).length;

    const cardClass = isActive ? (isPaused ? 'task-card paused-task' : 'task-card running') : 'task-card';
    const badge = isActive
      ? `<span class="status-badge ${isPaused ? 'paused' : 'running'}">${isPaused ? 'Пауза' : 'Идёт'}</span>`
      : '';
    const mainBtn = isActive
      ? (isPaused
        ? `<button class="btn btn-sm btn-primary" data-action="resume" data-id="${t.id}">Продолжить</button>`
        : `<button class="btn btn-sm" data-action="pause" data-id="${t.id}">Пауза</button>`)
        + `<button class="btn btn-sm btn-danger-ghost" data-action="stop" data-id="${t.id}">Стоп</button>`
      : `<button class="btn btn-sm btn-primary" data-action="start" data-id="${t.id}">
           <svg viewBox="0 0 24 24" width="13" height="13" fill="currentColor" aria-hidden="true"><polygon points="6 3 20 12 6 21"/></svg>
           Старт</button>`;

    return `
      <li class="${cardClass}" data-task-id="${t.id}">
        <div class="task-main">
          <div class="task-name">${esc(t.name)} ${badge}</div>
          ${t.notes ? `<div class="task-notes">${esc(t.notes)}</div>` : ''}
          ${t.tags?.length ? `<div class="task-tags">${t.tags.map((tag) => `<span class="tag">${esc(tag)}</span>`).join('')}</div>` : ''}
        </div>
        <div class="task-total">
          <div class="total-value" data-total-for="${t.id}">${fmtHMS(total)}</div>
          <div class="total-sub">${nSessions} ${plural(nSessions, 'сессия', 'сессии', 'сессий')}</div>
        </div>
        <div class="task-actions">
          ${mainBtn}
          <button class="icon-btn" data-action="adjust" data-id="${t.id}" title="Скорректировать время" aria-label="Скорректировать время">
            <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 3"/><path d="M17 3.3 20.7 7"/></svg>
          </button>
          <button class="icon-btn" data-action="edit-task" data-id="${t.id}" title="Редактировать" aria-label="Редактировать задачу">
            <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17 3a2.8 2.8 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z"/></svg>
          </button>
          <button class="icon-btn" data-action="delete-task" data-id="${t.id}" title="Удалить" aria-label="Удалить задачу">
            <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6"/><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>
          </button>
        </div>
      </li>`;
  }).join('');
}

/* ---------- Рендер: панель таймера ---------- */
function renderTimerBar() {
  const bar = $('#timer-bar');
  const t = state.timer;
  if (!t) { bar.hidden = true; return; }
  const task = getTask(t.taskId);
  if (!task) { state.timer = null; bar.hidden = true; return; }
  bar.hidden = false;
  bar.classList.toggle('paused', t.paused);
  const project = getProject(task.projectId);
  $('#timer-task-name').textContent = `${project ? project.name + ' / ' : ''}${task.name}`;
  $('#timer-elapsed').textContent = fmtHMS(timerElapsedMs());
  $('#timer-pause-btn').textContent = t.paused ? 'Продолжить' : 'Пауза';
}

/* ---------- Рендер: отчёты ---------- */
function renderReports() {
  const body = $('#report-body');
  const sessions = sessionsInPeriod(ui.reportPeriod);

  if (!state.projects.length) {
    body.innerHTML = '<p class="empty-hint">Нет данных. Создайте проект и задачу на вкладке «Задачи».</p>';
    return;
  }

  let html = '';
  let grandTotal = 0;

  for (const p of state.projects) {
    const pTasks = tasksOf(p.id);
    const rows = pTasks.map((t) => {
      const sum = sessions.filter((s) => s.taskId === t.id).reduce((a, s) => a + s.durationMs, 0);
      return { name: t.name, sum };
    }).filter((r) => r.sum !== 0);
    const pTotal = rows.reduce((a, r) => a + r.sum, 0);
    grandTotal += pTotal;
    if (!rows.length && ui.reportPeriod !== 'all') continue;

    html += `<div class="report-project">
      <div class="report-project-head"><span>${esc(p.name)}</span><span class="sum">${fmtHMS(pTotal)}</span></div>
      ${rows.map((r) => `<div class="report-task-row"><span>${esc(r.name)}</span><span class="sum">${fmtHMS(r.sum)}</span></div>`).join('')}
    </div>`;
  }

  html += `<div class="report-grand"><span>Итого за период</span><span class="sum">${fmtHMS(grandTotal)}</span></div>`;

  const sorted = [...sessions].sort((a, b) => b.start - a.start).slice(0, 100);
  html += '<h3 class="sessions-title">Сессии за период</h3>';
  if (!sorted.length) {
    html += '<p class="empty-hint">За выбранный период сессий нет.</p>';
  } else {
    html += sorted.map((s) => {
      const dur = s.manual
        ? `${s.durationMs < 0 ? '−' : '+'}${fmtHMS(Math.abs(s.durationMs))}`
        : fmtHMS(s.durationMs);
      const when = s.manual ? fmtDateTime(s.start) : `${fmtDate(s.start)} ${fmtTime(s.start)}–${fmtTime(s.end)}`;
      return `<div class="session-row">
        <span class="when">${when}</span>
        <span class="what">${esc(taskLabel(s.taskId))}</span>
        ${s.note ? `<span class="note">${esc(s.note)}</span>` : ''}
        <span class="dur">${dur}</span>
      </div>`;
    }).join('');
  }

  body.innerHTML = html;
}

/* Полная очистка истории сессий (проекты и задачи остаются) */
async function clearReport() {
  const n = state.sessions.length;
  if (!n) {
    toast('История уже пуста');
    return;
  }
  const ok = await confirmModal(
    'Очистить историю?',
    `Все записи сессий (${n} ${plural(n, 'запись', 'записи', 'записей')}) будут удалены безвозвратно. ` +
    'Проекты и задачи останутся, но их затреканное время обнулится.',
    'Очистить',
    true
  );
  if (!ok) return;
  state.sessions = [];
  saveAndRender();
  toast('История очищена');
}

/* ---------- Рендер: всё ---------- */
function renderAll() {
  renderProjects();
  renderTasks();
  renderTimerBar();
  if (ui.view === 'reports') renderReports();
}

let saveTimer = null;
function saveAndRender() {
  renderAll();
  syncTray();
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => storage.save(state), 150);
}

/* ---------- Модалки ---------- */
function openModal({ title, bodyHTML, okText = 'Сохранить', danger = false, hideCancel = false }) {
  return new Promise((resolve) => {
    const root = $('#modal-root');
    root.innerHTML = `
      <div class="modal-backdrop">
        <div class="modal" role="dialog" aria-modal="true" aria-label="${esc(title)}">
          <h3>${esc(title)}</h3>
          <div class="modal-body">${bodyHTML}</div>
          <div class="modal-actions">
            ${hideCancel ? '' : '<button class="btn btn-ghost" data-modal-cancel>Отмена</button>'}
            <button class="btn ${danger ? '' : 'btn-primary'}" ${danger ? 'style="background:var(--red);border-color:var(--red);color:#fff"' : ''} data-modal-ok>${esc(okText)}</button>
          </div>
        </div>
      </div>`;

    const backdrop = $('.modal-backdrop', root);
    const close = (value) => { root.innerHTML = ''; document.removeEventListener('keydown', onKey, true); resolve(value); };
    const onKey = (e) => {
      if (e.key === 'Escape') { e.stopPropagation(); close(null); }
      if (e.key === 'Enter' && e.target.tagName !== 'TEXTAREA') { e.preventDefault(); close($('.modal-body', root)); }
    };
    document.addEventListener('keydown', onKey, true);
    backdrop.addEventListener('mousedown', (e) => { if (e.target === backdrop) close(null); });
    const cancelBtn = $('[data-modal-cancel]', root);
    if (cancelBtn) cancelBtn.addEventListener('click', () => close(null));
    $('[data-modal-ok]', root).addEventListener('click', () => close($('.modal-body', root)));
    const firstInput = $('input, textarea', root);
    if (firstInput) { firstInput.focus(); firstInput.select(); }
  });
}

/* ---------- О программе ---------- */
async function aboutModal() {
  let version = 'dev';
  if (isElectron && typeof window.tt.getVersion === 'function') {
    version = 'v' + (await window.tt.getVersion());
  }
  openModal({
    title: 'О программе',
    okText: 'Закрыть',
    hideCancel: true,
    bodyHTML: `
      <div class="about">
        <div class="about-name">VaskoTick <span class="about-version">${esc(version)}</span></div>
        <p class="modal-text">Учёт рабочего времени: проекты, задачи, таймер, отчёты.</p>
        <p class="modal-text">Автор: <strong>Vasily Ryabchikov</strong></p>
        <p class="modal-text"><a href="https://github.com/vasiliskin/vaskotick" data-external>github.com/vasiliskin/vaskotick</a></p>
        <p class="modal-text"><a href="mailto:vasiliskin@gmail.com" data-external>vasiliskin@gmail.com</a></p>
      </div>`,
  });
}

async function inputModal(title, label, value = '') {
  const body = await openModal({
    title,
    bodyHTML: `<label>${esc(label)}</label><input type="text" id="m-input" value="${esc(value)}" maxlength="200" />`,
  });
  if (!body) return null;
  const v = $('#m-input', body).value.trim();
  return v || null;
}

async function confirmModal(title, text, okText = 'Подтвердить', danger = false) {
  const body = await openModal({ title, bodyHTML: `<p class="modal-text">${esc(text)}</p>`, okText, danger });
  return body !== null;
}

async function taskModal(title, task = null) {
  const body = await openModal({
    title,
    bodyHTML: `
      <label>Название</label>
      <input type="text" id="m-name" value="${esc(task?.name ?? '')}" maxlength="200" />
      <label>Теги (через запятую, необязательно)</label>
      <input type="text" id="m-tags" value="${esc(task?.tags?.join(', ') ?? '')}" maxlength="200" />
      <label>Заметки (необязательно)</label>
      <textarea id="m-notes" maxlength="2000">${esc(task?.notes ?? '')}</textarea>`,
  });
  if (!body) return null;
  const name = $('#m-name', body).value.trim();
  if (!name) { toast('Название задачи обязательно'); return null; }
  const tags = $('#m-tags', body).value.split(',').map((s) => s.trim()).filter(Boolean);
  const notes = $('#m-notes', body).value.trim();
  return { name, tags, notes };
}

async function adjustModal(task) {
  const current = taskTotalMs(task.id);
  const body = await openModal({
    title: 'Корректировка времени',
    okText: 'Применить',
    bodyHTML: `
      <p class="modal-text">Сейчас по задаче «${esc(task.name)}»: <strong>${fmtHuman(current)}</strong></p>
      <label>Минуты (положительное — добавить, отрицательное — убавить)</label>
      <input type="number" id="m-minutes" value="30" step="1" />`,
  });
  if (!body) return null;
  const v = parseInt($('#m-minutes', body).value, 10);
  return Number.isFinite(v) ? v : null;
}

/* ---------- Тосты ---------- */
function toast(text) {
  const root = $('#toast-root');
  const el = document.createElement('div');
  el.className = 'toast';
  el.textContent = text;
  root.appendChild(el);
  setTimeout(() => el.remove(), 3500);
}

/* ---------- События ---------- */
function bindEvents() {
  $('#btn-add-project').addEventListener('click', addProject);
  $('#btn-add-task').addEventListener('click', addTask);
  $('#btn-export').addEventListener('click', exportTxt);
  $('#btn-clear-report').addEventListener('click', clearReport);
  $('#app-version').addEventListener('click', aboutModal);

  /* Внешние ссылки из модалок — открываем в браузере, а не в окне приложения */
  $('#modal-root').addEventListener('click', (e) => {
    const a = e.target.closest('a[data-external]');
    if (!a) return;
    e.preventDefault();
    if (isElectron && typeof window.tt.openExternal === 'function') window.tt.openExternal(a.href);
    else window.open(a.href, '_blank', 'noopener');
  });

  /* Открытие «О программе» из меню трея */
  if (isElectron && typeof window.tt.onAbout === 'function') {
    window.tt.onAbout(() => aboutModal());
  }

  $$('.tab').forEach((tab) => tab.addEventListener('click', () => {
    ui.view = tab.dataset.view;
    $$('.tab').forEach((t) => t.classList.toggle('active', t === tab));
    $('#view-tasks').hidden = ui.view !== 'tasks';
    $('#view-reports').hidden = ui.view !== 'reports';
    if (ui.view === 'reports') renderReports();
  }));

  $$('.chip').forEach((chip) => chip.addEventListener('click', () => {
    ui.reportPeriod = chip.dataset.period;
    $$('.chip').forEach((c) => c.classList.toggle('active', c === chip));
    renderReports();
  }));

  $('#project-list').addEventListener('click', (e) => {
    const actionBtn = e.target.closest('[data-action]');
    if (actionBtn) {
      const id = actionBtn.dataset.id;
      if (actionBtn.dataset.action === 'edit-project') renameProject(id);
      if (actionBtn.dataset.action === 'delete-project') deleteProject(id);
      return;
    }
    const item = e.target.closest('.project-item');
    if (item) { ui.selectedProjectId = item.dataset.projectId; renderAll(); saveSoon(); }
  });

  $('#project-list').addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') {
      const item = e.target.closest('.project-item');
      if (item) { e.preventDefault(); ui.selectedProjectId = item.dataset.projectId; renderAll(); saveSoon(); }
    }
  });

  /* Двойной клик по проекту открывает переименование (помимо кнопки-карандаша) */
  $('#project-list').addEventListener('dblclick', (e) => {
    if (e.target.closest('[data-action]')) return; // клик по кнопке — не редактируем
    const item = e.target.closest('.project-item');
    if (item) renameProject(item.dataset.projectId);
  });

  $('#task-list').addEventListener('click', (e) => {
    const btn = e.target.closest('[data-action]');
    if (!btn) return;
    const id = btn.dataset.id;
    switch (btn.dataset.action) {
      case 'start': startTimer(id); break;
      case 'pause': pauseTimer(); break;
      case 'resume': resumeTimer(); break;
      case 'stop': stopTimer(); break;
      case 'adjust': adjustTaskTime(id); break;
      case 'edit-task': editTask(id); break;
      case 'delete-task': deleteTask(id); break;
    }
  });

  /* Двойной клик по карточке задачи открывает её редактирование */
  $('#task-list').addEventListener('dblclick', (e) => {
    if (e.target.closest('[data-action]')) return; // клик по кнопке — не редактируем
    const item = e.target.closest('.task-card');
    if (item) editTask(item.dataset.taskId);
  });

  $('#timer-pause-btn').addEventListener('click', () => {
    if (!state.timer) return;
    state.timer.paused ? resumeTimer() : pauseTimer();
  });
  $('#timer-stop-btn').addEventListener('click', stopTimer);

  window.addEventListener('beforeunload', () => { storage.save(state); });

  /* Автозапуск с Windows (только в Electron-сборке) */
  if (isElectron && typeof window.tt.getAutostart === 'function') {
    const wrap = $('#autostart-wrap');
    const toggle = $('#autostart-toggle');
    window.tt.getAutostart().then((on) => {
      wrap.hidden = false;
      toggle.checked = !!on;
    });
    toggle.addEventListener('change', async () => {
      const on = await window.tt.setAutostart(toggle.checked);
      toggle.checked = !!on;
      toast(on ? 'Автозапуск включён' : 'Автозапуск выключен');
    });
  }

  /* Команды из меню трея */
  if (isElectron && typeof window.tt.onTimerCommand === 'function') {
    window.tt.onTimerCommand((cmd) => {
      if (cmd === 'stop') stopTimer();
      if (cmd === 'toggle-pause' && state.timer) {
        state.timer.paused ? resumeTimer() : pauseTimer();
      }
    });
  }
}

function saveSoon() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => storage.save(state), 150);
}

/* ---------- Трей (только Electron) ---------- */
function syncTray() {
  if (!isElectron || typeof window.tt.notifyTimer !== 'function') return;
  const t = state.timer;
  if (!t) {
    window.tt.notifyTimer({ active: false });
    return;
  }
  const task = getTask(t.taskId);
  window.tt.notifyTimer({
    active: true,
    paused: t.paused,
    label: `${task ? task.name : 'Задача'} — ${fmtHMS(timerElapsedMs())}`,
  });
}

/* ---------- Тик таймера + автосохранение ---------- */
let autosaveCounter = 0;
function tick() {
  if (state.timer && !state.timer.paused) {
    $('#timer-elapsed').textContent = fmtHMS(timerElapsedMs());
    const totalEl = $(`[data-total-for="${state.timer.taskId}"]`);
    if (totalEl) totalEl.textContent = fmtHMS(taskTotalMs(state.timer.taskId) + timerElapsedMs());
    autosaveCounter++;
    if (autosaveCounter % 10 === 0) storage.save(state); // защита от потери таймера
  }
  syncTray();
}

/* ---------- Инициализация ---------- */
async function init() {
  const loaded = await storage.load();
  if (loaded && typeof loaded === 'object') {
    state = Object.assign(emptyState(), loaded);
  }

  /* Защита таймера: если приложение закрыли с идущим таймером,
     время продолжает считаться от абсолютных меток — ничего не теряется. */
  if (state.timer) {
    const task = getTask(state.timer.taskId);
    if (task) {
      toast(`Таймер восстановлен: «${task.name}» — ${state.timer.paused ? 'на паузе' : 'продолжает идти'}`);
    } else {
      state.timer = null;
    }
  }

  if (!ui.selectedProjectId && state.projects.length) {
    ui.selectedProjectId = state.projects[0].id;
  }

  /* Версия приложения в шапке (в браузерном предпросмотре — «dev») */
  const versionEl = $('#app-version');
  if (isElectron && typeof window.tt.getVersion === 'function') {
    window.tt.getVersion().then((v) => {
      versionEl.textContent = `v${v}`;
      versionEl.hidden = false;
    });
  } else {
    versionEl.textContent = 'dev';
    versionEl.hidden = false;
  }

  bindEvents();
  renderAll();
  setInterval(tick, 1000);
}

init();
