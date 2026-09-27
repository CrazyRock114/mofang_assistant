// 0071：guard 侧文件工具（自 restore-service 提公共——恢复与「数据保存位置迁移」共用递归复制实现）。
//  - copyDirectory：目录递归复制（提取前语义逐字一致；恢复链使用）。
//  - copyTree：整棵树复制 + 逐条分类（目录/文件/符号链接/其它），产出「复制清单」（相对路径 → 源字节数）
//    与「跳过清单」；数据位置迁移使用。**顶层条目不再假设是目录**——
//    2026-09-24 用户真机打回：真实 userData 根下有 Preferences / Local State / DevToolsActivePort 等普通文件，
//    按「每条目都是目录」逐项递归会撞 ENOTDIR（readdir 非目录）致迁移失败。
//  - listFilesWithSizes：与 copyTree 同一套分类/排除/跳过策略的清单化（校验面 == 复制面，防两边口径漂移）。

import { copyFileSync, lstatSync, mkdirSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

/**
 * 递归复制目录
 */
export function copyDirectory(src: string, dest: string): void {
  mkdirSync(dest, { recursive: true });

  const items = readdirSync(src);
  for (const item of items) {
    const srcPath = join(src, item);
    const destPath = join(dest, item);
    const stat = statSync(srcPath);

    if (stat.isDirectory()) {
      copyDirectory(srcPath, destPath);
    } else {
      copyFileSync(srcPath, destPath);
    }
  }
}

/**
 * Chromium 运行期易变条目（userData 根下；端口文件 / 单例锁 / 退出标记）：
 * 随进程生灭、复制过去即过期（会把上一次会话的端口或锁带进新位置，误导下一次启动），故迁移时跳过并记录。
 * 判据是名字而非内容——这些名字在 userData 根下只可能是运行期产物。
 */
export const VOLATILE_RUNTIME_ENTRIES: ReadonlySet<string> = new Set([
  'DevToolsActivePort',
  'SingletonLock',
  'SingletonCookie',
  'SingletonSocket',
  'lockfile',
]);

export interface CopyTreeOptions {
  /** 顶层排除项：不复制、不计入复制清单（如迁移用的 backups/ 与引导配置本体） */
  excludeNames?: ReadonlySet<string>;
  /** 顶层跳过项：不复制、记入跳过清单（运行期易变条目） */
  skipNames?: ReadonlySet<string>;
}

export interface CopyTreeReport {
  /** 相对路径（POSIX 分隔）→ **复制时**读到的源字节数（校验以它为准，免受复制后源目录变化干扰） */
  files: Map<string, number>;
  /** 跳过项（相对路径 + 原因），调用方应落日志（不静默丢文件） */
  skipped: string[];
}

/**
 * 整棵树复制（目录递归 / 文件直拷 / 符号链接按目标分类），返回复制清单与跳过清单。
 * 符号链接：目标是文件 → 按内容复制；目标目录或悬空 → 跳过（避免递归环与复制无意义的会话链接）。
 * 复制期间消失的条目（如运行中的 Chromium 正在删减会话文件）→ 跳过并记录，不中断迁移。
 */
export function copyTree(src: string, dest: string, options: CopyTreeOptions = {}): CopyTreeReport {
  const excludeNames = options.excludeNames ?? new Set<string>();
  const skipNames = options.skipNames ?? new Set<string>();
  const report: CopyTreeReport = { files: new Map(), skipped: [] };

  const walk = (srcDir: string, destDir: string, prefix: string): void => {
    mkdirSync(destDir, { recursive: true });
    for (const item of readdirSync(srcDir)) {
      const rel = prefix === '' ? item : `${prefix}/${item}`;
      if (prefix === '' && excludeNames.has(item)) continue;
      if (prefix === '' && skipNames.has(item)) {
        report.skipped.push(`${rel}（运行期易变条目，不随迁移）`);
        continue;
      }

      const srcPath = join(srcDir, item);
      const destPath = join(destDir, item);

      let entry;
      try {
        entry = lstatSync(srcPath);
      } catch {
        report.skipped.push(`${rel}（复制期间消失）`);
        continue;
      }

      if (entry.isSymbolicLink()) {
        let target;
        try {
          target = statSync(srcPath);
        } catch {
          report.skipped.push(`${rel}（符号链接悬空）`);
          continue;
        }
        if (target.isFile()) {
          copyFileSync(srcPath, destPath);
          report.files.set(rel, target.size);
        } else {
          report.skipped.push(`${rel}（符号链接指向目录/其它，不复制）`);
        }
        continue;
      }

      if (entry.isDirectory()) {
        walk(srcPath, destPath, rel);
        continue;
      }

      if (entry.isFile()) {
        copyFileSync(srcPath, destPath);
        report.files.set(rel, entry.size);
        continue;
      }

      report.skipped.push(`${rel}（非常规条目：既非文件、目录也非符号链接）`);
    }
  };

  walk(src, dest, '');
  return report;
}

/**
 * 目录条目清单（相对路径 → 字节数；文件态，不含目录项）。与 copyTree 同一套分类/排除/跳过策略，
 * 供迁移校验（逐文件字节比对）使用。浅表 excludeNames/skipNames 只作用于给定根的直接子项。
 */
export function listFilesWithSizes(
  root: string,
  options: CopyTreeOptions = {},
): Map<string, number> {
  const excludeNames = options.excludeNames ?? new Set<string>();
  const skipNames = options.skipNames ?? new Set<string>();
  const out = new Map<string, number>();

  const walk = (dir: string, prefix: string): void => {
    for (const item of readdirSync(dir)) {
      if (prefix === '' && (excludeNames.has(item) || skipNames.has(item))) continue;
      const full = join(dir, item);
      const rel = prefix === '' ? item : `${prefix}/${item}`;

      let entry;
      try {
        entry = lstatSync(full);
      } catch {
        continue; // 复制期间消失的条目：与 copyTree 同口径（跳过，不参与校验）
      }
      if (entry.isSymbolicLink()) {
        try {
          const target = statSync(full);
          if (target.isFile()) out.set(rel, target.size);
        } catch {
          /* 悬空链接：跳过 */
        }
        continue;
      }
      if (entry.isDirectory()) walk(full, rel);
      else if (entry.isFile()) out.set(rel, entry.size);
    }
  };

  walk(root, '');
  return out;
}

/**
 * 目录是否为空（不存在视为空）。非目录（文件占位）视为不可用 → false。
 */
export function isEmptyDirOrMissing(dir: string): boolean {
  try {
    const stat = statSync(dir);
    if (!stat.isDirectory()) return false;
    return readdirSync(dir).length === 0;
  } catch {
    return true; // 不存在
  }
}
