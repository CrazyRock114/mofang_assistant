// 0072（只增）：公告服务（纯 Node，零 electron 依赖——主进程只把 userData 路径与定时器接在外面，
// 仿 proxy/data-location 模式，vitest 直测）。
//
// 三级回落链（任务书 §一.2）：远程 OK → 用远程；远程失败/坏 JSON/字段缺 → 用缓存；缓存也无 → 用内置兜底。
// 任何一步不 throw、不阻塞启动、不弹打扰性错误（错误只经 log 回调留痕，接线处挂 diagLog）。
// 缓存写 = 临时文件 + rename 防半截（0071 先例）；拉取成功才覆盖缓存。

import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { MF_RELEASE_PAGE_URL } from '../../shared/endpoints.js';
import type { AnnounceData, AnnounceSnapshot } from '../../shared/contracts/distribution-types.js';
import { parseAnnounceJson } from './parse-announce.js';

/** 拉取超时（毫秒）——公告非关键路径，超时即走回落链 */
export const ANNOUNCE_FETCH_TIMEOUT_MS = 10_000;

/** 内置兜底公告（打包进代码的一条静态公告：指向发布页 + 群引导文案，无二维码）。
 *  消费方（公告弹窗）对 source='builtin' 不做启动自动弹窗——无真实公告不打扰。 */
export const BUILTIN_ANNOUNCE: AnnounceData = {
  updatedAt: '2026-09-25',
  messages: [
    {
      id: 'builtin-fallback',
      level: 'info',
      title: '欢迎使用魔方助教',
      body: '当前未获取到在线公告（可能处于离线状态）。最新版本、更新说明与教师交流群入口请访问发布页。',
      links: [{ text: '打开发布页', url: MF_RELEASE_PAGE_URL }],
    },
  ],
};

export interface AnnounceServiceDeps {
  /** announce.json 端点（--smoke-feed-base 探针时由接线处换参，仅 smoke 生效） */
  announceUrl: string;
  /** 持久化缓存路径（<userData>/announce-cache.json） */
  cachePath: string;
  /** 缺省全局 fetch（Node 24 / Electron 38 主进程可用）；测试注入假实现 */
  fetchImpl?: typeof fetch;
  /** 留痕回调（接线处挂 diagLog；缺省静默） */
  log?: (message: string) => void;
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export class AnnounceService {
  private readonly deps: AnnounceServiceDeps;
  private readonly fetchImpl: typeof fetch;
  private memory: AnnounceSnapshot | null = null;

  constructor(deps: AnnounceServiceDeps) {
    this.deps = deps;
    this.fetchImpl = deps.fetchImpl ?? fetch;
  }

  /** 读缓存文件 → AnnounceData；缺文件/坏 JSON 返回 null */
  private readCache(): AnnounceData | null {
    try {
      return parseAnnounceJson(readFileSync(this.deps.cachePath, 'utf8'));
    } catch {
      return null;
    }
  }

  private setMemory(source: AnnounceSnapshot['source'], data: AnnounceData): void {
    this.memory = { source, data };
  }

  /** 拉一次：成功覆盖缓存+内存（remote）；任何失败逐级回落 cache→builtin。永不 throw。 */
  async refresh(): Promise<AnnounceSnapshot> {
    let remote: AnnounceData | null = null;
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), ANNOUNCE_FETCH_TIMEOUT_MS);
      try {
        const resp = await this.fetchImpl(this.deps.announceUrl, { signal: controller.signal });
        if (resp.ok) {
          remote = parseAnnounceJson(await resp.text());
        } else {
          this.deps.log?.(`公告拉取失败：HTTP ${resp.status}`);
        }
      } finally {
        clearTimeout(timer);
      }
    } catch (err) {
      this.deps.log?.(`公告拉取失败：${messageOf(err)}`);
    }

    if (remote !== null) {
      try {
        const tmpPath = `${this.deps.cachePath}.tmp`;
        mkdirSync(dirname(this.deps.cachePath), { recursive: true });
        writeFileSync(tmpPath, JSON.stringify(remote, null, 2), 'utf8');
        renameSync(tmpPath, this.deps.cachePath);
      } catch (err) {
        // 缓存写失败不影响本次生效（remote 仍可用），留痕即可
        this.deps.log?.(`公告缓存写入失败（本次仍用远程公告）：${messageOf(err)}`);
      }
      this.setMemory('remote', remote);
      return this.memory!;
    }

    const cached = this.memory?.source === 'cache' ? this.memory.data : this.readCache();
    if (cached !== null) {
      this.setMemory('cache', cached);
      return this.memory!;
    }
    this.setMemory('builtin', BUILTIN_ANNOUNCE);
    return this.memory!;
  }

  /**
   * 读当前生效公告（同步）：内存有 → 直接用；内存空（进程刚起、尚未首拉）→
   * 懒初始化：读缓存（cache）→ 内置兜底（builtin）。永不 throw。
   */
  getSnapshot(): AnnounceSnapshot {
    if (this.memory !== null) return this.memory;
    const cached = this.readCache();
    if (cached !== null) {
      this.setMemory('cache', cached);
      return this.memory!;
    }
    this.setMemory('builtin', BUILTIN_ANNOUNCE);
    return this.memory!;
  }
}
