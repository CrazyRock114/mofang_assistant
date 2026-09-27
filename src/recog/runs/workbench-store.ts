// 0040 P1：工作台文件态落盘（run 目录 `workbench.json`）。
//
// 与 0028 的 `drafts.json`（规则切分链路产物）并存互不干扰：本文件是工作台的**卡流状态**
// （待识别卡/题卡/勾选/采纳态），随 run 目录走，草稿恢复 = 入口页「继续处理」。
// 写入走「临时文件 + rename」原子替换，避免防抖落盘被关窗打断后留下半截 JSON。

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { WorkbenchState } from '../../shared/contracts/onestep-types.js';
import { parseWorkbenchState } from '../onestep/workbench.js';

/** run 目录内的相对路径 */
export const WORKBENCH_REL = 'workbench.json';

export function workbenchPath(runDir: string): string {
  return join(runDir, WORKBENCH_REL);
}

/** 读工作台状态；文件缺失/损坏/版本不符 → null（调用方按首次进入处理，不炸） */
export function readWorkbenchFile(runDir: string, runId: string): WorkbenchState | null {
  const path = workbenchPath(runDir);
  if (!existsSync(path)) return null;
  try {
    return parseWorkbenchState(readFileSync(path, 'utf8'), runId);
  } catch {
    return null;
  }
}

/** 写工作台状态（原子替换）；返回落盘时间戳 */
export function writeWorkbenchFile(runDir: string, state: WorkbenchState, now: string): string {
  mkdirSync(runDir, { recursive: true });
  const path = workbenchPath(runDir);
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, JSON.stringify({ ...state, updatedAt: now }, null, 2), 'utf8');
  renameSync(tmp, path);
  return now;
}
