// 0072（只增）：更新服务编排（零 electron 依赖——electron-updater 经 UpdaterAdapter 注入，
// vitest 用内存 stub 直测；生产适配器见 electron-updater-adapter.ts，探针 stub 见 smoke-announce.ts）。
//
// 职责（任务书 §一.3）：
//  - 启动自动检查节流（update-state.json lastCheckAt，<24h 跳过）；checkNow 手动检查忽略节流；
//  - 事件 → UpdateStateMachine 归约 → 订阅者广播（main 接线处把广播转 webContents.send）；
//  - 非便携：available 后自动 downloadUpdate（autoDownload 编排在 service 层，真/stub adapter 一致）；
//  - 便携降级（L1+L2，2026-09-25 用户拍板）：只做检查+提示+打开下载页——不自动下载、downloadUpdate 拒绝、
//   永不 quitAndInstall（判定 process.env.PORTABLE_EXECUTABLE_DIR 在 main 接线处，此处收 isPortable 布尔）。

import {
  UpdateStateMachine,
  readUpdatePersistState,
  shouldCheckNow,
  writeUpdatePersistState,
  type UpdaterEvent,
} from './update-state.js';
import type { UpdateStatus } from '../../shared/contracts/distribution-types.js';

/** adapter 面：真实现包 electron-updater autoUpdater；stub/探针实现同形（事件手动驱动） */
export interface UpdaterAdapter {
  checkForUpdates(): Promise<void>;
  downloadUpdate(): Promise<void>;
  quitAndInstall(): void;
  onEvent(handler: (event: UpdaterEvent) => void): () => void;
}

/**
 * dev 目检态专用 adapter（用户 2026-09-25 目检反馈：npm start 也要可见「检查更新」入口）——
 * 恒 not-available：未打包跑不了真实更新检查（electron-updater isPackaged 硬门控），真实链路归打包态；
 * 本 adapter 零 electron-updater 依赖，「未打包不接线更新引擎」的任务书硬约束不变。
 */
export function createNotAvailableAdapter(): UpdaterAdapter {
  const handlers: Array<(event: UpdaterEvent) => void> = [];
  const emit = (event: UpdaterEvent): void => {
    for (const handler of [...handlers]) handler(event);
  };
  return {
    async checkForUpdates(): Promise<void> {
      emit({ type: 'checking' });
      emit({ type: 'not-available' });
    },
    async downloadUpdate(): Promise<void> {
      throw new Error('开发模式不支持应用内下载更新');
    },
    quitAndInstall(): void {
      /* dev 无安装语义 */
    },
    onEvent(handler: (event: UpdaterEvent) => void): () => void {
      handlers.push(handler);
      return () => {
        const i = handlers.indexOf(handler);
        if (i >= 0) handlers.splice(i, 1);
      };
    },
  };
}

export interface UpdateServiceDeps {
  adapter: UpdaterAdapter;
  /** <userData>/update-state.json（节流 lastCheckAt 持久化） */
  statePath: string;
  /** 便携版运行（L1+L2 降级：不自动下载、不装） */
  isPortable: boolean;
  now?: () => number;
  log?: (level: 'info' | 'warn' | 'error', message: string) => void;
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export class UpdateService {
  private readonly deps: UpdateServiceDeps;
  private readonly machine = new UpdateStateMachine();
  private readonly subscribers = new Set<(status: UpdateStatus) => void>();
  private lastCheckNote = '尚未检查';

  constructor(deps: UpdateServiceDeps) {
    this.deps = deps;
    deps.adapter.onEvent((event) => this.onAdapterEvent(event));
  }

  /** adapter 事件 → 状态归约 → 订阅广播；非便携 available 后自动续下载 */
  private onAdapterEvent(event: UpdaterEvent): void {
    // progress 喂滚动窗口必须用真实时钟（慢速判定「持续满 30s」；now 注入供测试/探针）
    const status = this.machine.apply(event, (this.deps.now ?? Date.now)());
    if (event.type === 'checking') {
      this.lastCheckNote = '检查中';
    } else if (event.type === 'available') {
      this.deps.log?.('info', `发现新版本 ${event.version}`);
      if (!this.deps.isPortable) {
        // 自动下载（service 层编排；失败会以 error 事件回流，此处不重复记态）
        void this.deps.adapter.downloadUpdate().catch((err) => {
          this.deps.log?.('warn', `自动下载启动失败：${messageOf(err)}`);
        });
      }
    } else if (event.type === 'not-available') {
      this.lastCheckNote = '已是最新';
    } else if (event.type === 'error') {
      // 失败一律静默记 app.log；UI 可见性由 status.manual 标志判（手动检查才提示）
      this.deps.log?.('warn', `更新检查/下载失败：${event.message}`);
    }
    for (const sub of [...this.subscribers]) {
      try {
        sub(status);
      } catch {
        /* 单个订阅者异常不拖垮广播 */
      }
    }
  }

  getStatus(): UpdateStatus {
    return this.machine.status;
  }

  /** 上次启动自动检查的处理备注（app.log/诊断留痕用） */
  get startupCheckNote(): string {
    return this.lastCheckNote;
  }

  onStatus(callback: (status: UpdateStatus) => void): () => void {
    this.subscribers.add(callback);
    return () => {
      this.subscribers.delete(callback);
    };
  }

  /**
   * 启动自动检查（节流内建）：<24h 查过即跳过（不触 adapter）；否则记 lastCheckAt 后检查。
   * 永不 throw。
   */
  async maybeCheckOnStartup(): Promise<void> {
    const now = (this.deps.now ?? Date.now)();
    const persisted = readUpdatePersistState(this.deps.statePath);
    if (!shouldCheckNow(persisted.lastCheckAt, now)) {
      this.lastCheckNote = '24h 内已检查，跳过启动自动检查';
      this.deps.log?.('info', `更新检查节流：${this.lastCheckNote}`);
      return;
    }
    this.recordCheckTime(now);
    try {
      await this.deps.adapter.checkForUpdates();
    } catch (err) {
      this.deps.log?.('warn', `启动更新检查失败：${messageOf(err)}`);
    }
  }

  /** 手动检查（设置页「检查更新」）：忽略节流；已有检查/下载在飞时忽略本次。 */
  async checkNow(): Promise<{ started: boolean }> {
    const phase = this.machine.phase;
    if (phase === 'checking' || phase === 'downloading') {
      return { started: false };
    }
    this.machine.markManual();
    this.recordCheckTime((this.deps.now ?? Date.now)());
    try {
      await this.deps.adapter.checkForUpdates();
    } catch (err) {
      this.deps.log?.('warn', `手动更新检查失败：${messageOf(err)}`);
    }
    return { started: true };
  }

  /** 手动续下载（非便携自动下载中断后的兜底入口；便携版拒绝——下载语义走「打开下载页」） */
  async downloadUpdate(): Promise<void> {
    if (this.deps.isPortable) {
      throw new Error('便携版不做应用内下载，请在下载页获取新版本');
    }
    await this.deps.adapter.downloadUpdate();
  }

  /** downloaded 后「立即重启」：NSIS 覆盖安装（userData 保留，0071 数据目录方案兼容） */
  quitAndInstall(): void {
    if (this.deps.isPortable) return; // 便携版永不走应用内安装
    this.deps.adapter.quitAndInstall();
  }

  private recordCheckTime(now: number): void {
    try {
      writeUpdatePersistState(this.deps.statePath, { lastCheckAt: new Date(now).toISOString() });
    } catch (err) {
      // 节流记录写失败不影响本次检查（最多下次多查一回）
      this.deps.log?.('warn', `更新节流状态写入失败：${messageOf(err)}`);
    }
  }
}
