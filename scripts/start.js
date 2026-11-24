'use strict';

/* Обёртка запуска: в некоторых окружениях глобально выставлена
   ELECTRON_RUN_AS_NODE=1, из-за чего Electron стартует как обычный Node.
   Удаляем переменную из окружения дочернего процесса перед запуском. */

delete process.env.ELECTRON_RUN_AS_NODE;

const path = require('path');
const { spawn } = require('child_process');
const electronPath = require('electron'); // путь к electron.exe

const child = spawn(electronPath, ['.'], {
  stdio: 'inherit',
  env: process.env,
  cwd: path.join(__dirname, '..'),
});

child.on('close', (code) => process.exit(code ?? 0));
