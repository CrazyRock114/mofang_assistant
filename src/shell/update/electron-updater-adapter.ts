// 0072（只增）：electron-updater 生产适配器（UpdaterAdapter 真实现——薄包装，不做单测；
// 行为由探针 stub adapter + 0073 出仓包联调覆盖）。
//
// 口径（任务书 §零.12 / §一.3）：
//  - feed 用运行时 setFeedURL(generic) 指向端点常量——package.json 不配 publish 块（单一真源）；
//  - autoDownload=false：自动下载编排在 UpdateService 层（真/stub adapter 一致、便携降级可控）；
//  - autoInstallOnAppQuit=true：downloaded 后用户直接退出也顺带装上（NSIS 覆盖安装，userData 保留）；
//  - 差分更新（blockmap）是 electron-updater 默认行为，无需配置；
//  - isPackaged 门控在 main.ts 接线处（本模块只在生产态被 import——dev/自动化零加载）。

import { autoUpdater } from 'electron-updater';
import type { UpdaterAdapter } from './update-service.js';
import type { UpdaterEvent } from './update-state.js';

export function createElectronUpdaterAdapter(feedUrl: string): UpdaterAdapter {
  autoUpdater.setFeedURL({ provider: 'generic', url: feedUrl });
  autoUpdater.autoDownload = false;
  autoUpdater.autoInstallOnAppQuit = true;

  const handlers: Array<(event: UpdaterEvent) => void> = [];
  const send = (event: UpdaterEvent): void => {
    /* 事件经构造时注册的 handler 回流 UpdateService */
    for (const handler of handlers) handler(event);
  };

  autoUpdater.on('checking-for-update', () => send({ type: 'checking' }));
  autoUpdater.on('update-available', (info) => send({ type: 'available', version: info.version }));
  autoUpdater.on('update-not-available', () => send({ type: 'not-available' }));
  autoUpdater.on('download-progress', (progress) =>
    send({
      type: 'progress',
      percent: progress.percent,
      bytesPerSecond: progress.bytesPerSecond,
      transferred: progress.transferred,
      total: progress.total,
    }),
  );
  autoUpdater.on('update-downloaded', (info) => send({ type: 'downloaded', version: info.version }));
  autoUpdater.on('error', (err) => send({ type: 'error', message: err.message }));

  return {
    checkForUpdates: () => autoUpdater.checkForUpdates().then(() => undefined),
    downloadUpdate: () => autoUpdater.downloadUpdate().then(() => undefined),
    quitAndInstall: () => autoUpdater.quitAndInstall(),
    onEvent: (handler) => {
      handlers.push(handler);
      return () => {
        const i = handlers.indexOf(handler);
        if (i >= 0) handlers.splice(i, 1);
      };
    },
  };
}
