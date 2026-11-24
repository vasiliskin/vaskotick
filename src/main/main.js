'use strict';

const { app, BrowserWindow, ipcMain, dialog, Tray, Menu, nativeImage } = require('electron');
const fs = require('fs');
const path = require('path');

const dataFilePath = () => path.join(app.getPath('userData'), 'worktime-data.json');

let mainWindow = null;
let tray = null;
let isQuitting = false;
let timerState = { active: false };

function showWindow() {
  if (!mainWindow) return;
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
}

function sendCommand(cmd) {
  showWindow();
  mainWindow.webContents.send('timer:command', cmd);
}

function buildTrayMenu() {
  const items = [];
  items.push({ label: `VaskoTick v${app.getVersion()}`, enabled: false });
  items.push({ type: 'separator' });
  if (timerState.active) {
    items.push({ label: `${timerState.label || 'Идёт таймер'}`, enabled: false });
    items.push({
      label: timerState.paused ? '▶ Продолжить' : '⏸ Пауза',
      click: () => sendCommand('toggle-pause'),
    });
    items.push({ label: '⏹ Стоп', click: () => sendCommand('stop') });
  } else {
    items.push({ label: 'Таймер не запущен', enabled: false });
  }
  items.push({ type: 'separator' });
  items.push({ label: 'Показать окно', click: showWindow });
  items.push({ label: 'Проверить обновления…', click: () => checkForUpdates(true) });
  items.push({
    label: 'Выход',
    click: () => {
      isQuitting = true;
      app.quit();
    },
  });
  return Menu.buildFromTemplate(items);
}

function updateTray() {
  if (!tray) return;
  tray.setContextMenu(buildTrayMenu());
  const tip = timerState.active
    ? `VaskoTick — ${timerState.label || ''}`
    : 'VaskoTick — таймер не запущен';
  tray.setToolTip(tip.slice(0, 120));
}

/* ---------- Автообновление (только установленная версия) ---------- */

const UPDATE_CHECK_INTERVAL_MS = 4 * 60 * 60 * 1000; // раз в 4 часа
let autoUpdater = null;
let manualCheckInProgress = false;

// Журнал обновлений — userData/updates.log (удобно для диагностики).
function logUpdate(message) {
  const line = `[${new Date().toISOString()}] ${message}\n`;
  try {
    const file = path.join(app.getPath('userData'), 'updates.log');
    let prev = '';
    try {
      prev = fs.readFileSync(file, 'utf8');
    } catch {}
    if (prev.length > 200000) prev = prev.slice(-100000);
    fs.writeFileSync(file, prev + line, 'utf8');
  } catch {}
}

async function checkForUpdates(manual) {
  if (!autoUpdater) {
    if (manual) {
      dialog.showMessageBox({
        type: 'info',
        title: 'VaskoTick',
        message: 'Проверка обновлений доступна только в установленной версии.',
      });
    }
    return;
  }
  manualCheckInProgress = manual;
  try {
    await autoUpdater.checkForUpdates();
  } catch (err) {
    // Событие 'error' тоже сработает — там и лог, и диалог для ручной проверки.
    logUpdate(`ошибка проверки: ${err && err.message ? err.message : err}`);
  }
}

function setupAutoUpdates() {
  if (!app.isPackaged) return; // в dev-режиме обновляться нечему
  try {
    ({ autoUpdater } = require('electron-updater'));
  } catch (err) {
    logUpdate(`electron-updater не загрузился: ${err && err.message ? err.message : err}`);
    return;
  }

  autoUpdater.autoDownload = true; // скачиваем сразу, спрашиваем только о перезапуске
  autoUpdater.autoInstallOnAppQuit = true; // «Позже» = установится при следующем выходе

  autoUpdater.on('checking-for-update', () => logUpdate('проверка обновлений…'));
  autoUpdater.on('update-available', (info) => {
    logUpdate(`найдена версия ${info.version}, скачиваю`);
    if (manualCheckInProgress) {
      dialog.showMessageBox({
        type: 'info',
        title: 'VaskoTick',
        message: `Найдена новая версия ${info.version}.`,
        detail: 'Скачиваю в фоне — когда будет готова, предложу перезапустить.',
      });
    }
    manualCheckInProgress = false;
  });
  autoUpdater.on('update-not-available', () => {
    logUpdate('обновлений нет');
    if (manualCheckInProgress) {
      dialog.showMessageBox({
        type: 'info',
        title: 'VaskoTick',
        message: `У вас последняя версия — ${app.getVersion()}.`,
      });
    }
    manualCheckInProgress = false;
  });
  autoUpdater.on('error', (err) => {
    logUpdate(`ошибка: ${err && err.message ? err.message : err}`);
    if (manualCheckInProgress) {
      dialog.showMessageBox({
        type: 'error',
        title: 'VaskoTick',
        message: 'Не удалось проверить обновления.',
        detail: 'Проверьте подключение к интернету или попробуйте позже.',
      });
    }
    manualCheckInProgress = false;
  });
  autoUpdater.on('update-downloaded', (info) => {
    logUpdate(`версия ${info.version} скачана, предлагаю перезапуск`);
    const choice = dialog.showMessageBoxSync({
      type: 'info',
      title: 'VaskoTick',
      message: `Обновление ${info.version} готово.`,
      detail:
        'Перезапустить сейчас и установить? Если выбрать «Позже», ' +
        'обновление установится при следующем выходе из приложения.',
      buttons: ['Перезапустить сейчас', 'Позже'],
      defaultId: 0,
      cancelId: 1,
    });
    if (choice === 0) {
      isQuitting = true; // иначе перехват 'close' не даст окну закрыться
      autoUpdater.quitAndInstall();
    }
  });

  // Первая проверка — через 15 секунд после запуска, дальше — каждые 4 часа.
  setTimeout(() => checkForUpdates(false), 15000);
  setInterval(() => checkForUpdates(false), UPDATE_CHECK_INTERVAL_MS);
}

const TRAY_ICON_DATA_URL = 'data:image/png;base64,' + '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';

function createTray() {
  try {
    // Иконка встроена в код: чтение из asar-архива в упакованной сборке ненадёжно.
    let icon = nativeImage.createFromDataURL(TRAY_ICON_DATA_URL);
    if (icon.isEmpty()) {
      icon = nativeImage.createFromPath(path.join(__dirname, 'build', 'tray.png'));
    }
    if (icon.isEmpty()) return; // без иконки трей не создаём
    tray = new Tray(icon);
    tray.on('click', showWindow);
    updateTray();
  } catch (err) {
    // Трей недоступен — приложение продолжает работать без него.
    console.error('Tray error:', err);
  }
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1180,
    height: 760,
    minWidth: 900,
    minHeight: 600,
    backgroundColor: '#15171c',
    title: 'VaskoTick',
    icon: path.join(__dirname, '..', '..', 'assets', 'icon.png'),
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  mainWindow.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));

  // Закрытие окна сворачивает приложение в трей, а не завершает его.
  // Полный выход — через меню трея «Выход».
  mainWindow.on('close', (e) => {
    if (!isQuitting) {
      e.preventDefault();
      mainWindow.hide();
    }
  });
  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => showWindow());

  app.whenReady().then(() => {
    // Миграция данных из папки старого имени приложения
    try {
      const legacy = path.join(app.getPath('appData'), 'worktime-tracker', 'worktime-data.json');
      if (!fs.existsSync(dataFilePath()) && fs.existsSync(legacy)) {
        fs.mkdirSync(path.dirname(dataFilePath()), { recursive: true });
        fs.copyFileSync(legacy, dataFilePath());
      }
    } catch {}
    ipcMain.handle('store:load', () => {
      try {
        const raw = fs.readFileSync(dataFilePath(), 'utf8');
        return JSON.parse(raw);
      } catch {
        return null;
      }
    });

    ipcMain.handle('store:save', (_event, state) => {
      try {
        const tmp = dataFilePath() + '.tmp';
        fs.writeFileSync(tmp, JSON.stringify(state), 'utf8');
        fs.renameSync(tmp, dataFilePath());
        return true;
      } catch (err) {
        return { error: String(err) };
      }
    });

    ipcMain.handle('export:txt', async (_event, content, suggestedName) => {
      const { canceled, filePath } = await dialog.showSaveDialog(mainWindow, {
        title: 'Экспорт данных',
        defaultPath: suggestedName || 'worktime-report.txt',
        filters: [{ name: 'Текстовый файл', extensions: ['txt'] }],
      });
      if (canceled || !filePath) return null;
      fs.writeFileSync(filePath, content, 'utf8');
      return filePath;
    });

    ipcMain.on('timer:state', (_event, state) => {
      timerState = state || { active: false };
      updateTray();
    });

    /* Версия приложения для отображения в интерфейсе */
    ipcMain.handle('app:version', () => app.getVersion());

    /* Автозапуск с Windows (только для установленной/portable-сборки) */
    ipcMain.handle('autostart:get', () => {
      if (!app.isPackaged) return false;
      return app.getLoginItemSettings().openAtLogin;
    });
    ipcMain.handle('autostart:set', (_event, enabled) => {
      if (!app.isPackaged) return false;
      app.setLoginItemSettings({ openAtLogin: !!enabled });
      return app.getLoginItemSettings().openAtLogin;
    });

    createWindow();
    createTray();
    setupAutoUpdates();

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  });

  app.on('window-all-closed', () => {
    // Не выходим: приложение живёт в трее до явного «Выход».
  });

  app.on('before-quit', () => {
    isQuitting = true;
  });
}
