'use strict';

/* Сборка дистрибутивов (portable + NSIS) через API electron-builder. */

const builder = require('electron-builder');
const { version } = require('../package.json');

builder
  .build({
    publish: 'never', // публикацию делает GitHub Actions, не сам builder
    targets: builder.Platform.WINDOWS.createTarget(),
    config: {
      appId: 'com.vasko.tick',
      productName: 'VaskoTick',
      electronDist: 'node_modules/electron/dist', // локальный проверенный дистрибутив
      files: ['src/**/*', 'assets/tray.png', 'assets/icon.png'],
      directories: { output: 'release' },
      // Источник автообновлений; с publish:'never' ничего не заливается,
      // но генерируется release/latest.yml для electron-updater.
      publish: [{ provider: 'github', owner: 'vasiliskin', repo: 'vaskotick' }],
      win: {
        target: ['portable', 'nsis'],
        icon: 'assets/icon.ico',
      },
      portable: {
        artifactName: `VaskoTick-${version}-Portable.exe`,
      },
      nsis: {
        oneClick: false,
        perMachine: false,
        allowToChangeInstallationDirectory: true,
        shortcutName: 'VaskoTick',
        artifactName: `VaskoTick-${version}-Setup.exe`,
      },
    },
  })
  .then((artifacts) => {
    console.log('ГОТОВО:');
    artifacts.forEach((a) => console.log(' -', a));
  })
  .catch((err) => {
    console.error('ОШИБКА СБОРКИ:', err.stack || err.message || err);
    process.exit(1);
  });
