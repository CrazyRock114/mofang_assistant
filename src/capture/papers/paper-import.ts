/**
 * 0006 P4：成品卷装配（整卷下载去向「成品卷」）
 *
 * 顺序：createPaperEx(status='composing') → 逐题挂 paper_questions（position 由服务层连续分配）
 *      → snapshotPaperQuestions（定稿前置）→ updatePaperStatus('done')。
 * - 用 composing 而非 basket：状态机 basket→done 非法迁移（ALLOWED_TRANSITIONS），composing→done 才是合法定稿路径；
 *   且 composing 是瞬态、终态 done，不把整卷下载留在「处理中篮」语义里。
 * - 单题挂卷失败不整批回滚（散题已入库，兜底语义）；快照失败不置 done（留 composing 待人工重试）。
 */

import type { Paper, PaperStatus, PaperType } from '../../shared/contracts/bank-types.js';

/** 装配所需服务面（PaperExtService 子集；真库/假实现同形） */
export interface PaperAssemblyService {
  createPaperEx(title: string, config?: Record<string, unknown>, opts?: { status?: PaperStatus; paperType?: PaperType }): Promise<Paper>;
  addQuestion(paperId: string, questionId: string): Promise<void>;
  snapshotPaperQuestions(paperId: string): Promise<number>;
  updatePaperStatus(paperId: string, status: PaperStatus): Promise<void>;
}

export interface PaperAssemblyResult {
  paperId: string;
  paperTitle: string;
  /** 成功挂卷题数 */
  added: number;
  /** 快照行数（快照失败为 0） */
  snapshotCount: number;
  /** 是否成功置 done（快照失败/状态迁移失败均为 false，卷留 composing） */
  done: boolean;
  warnings: string[];
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** 装配成品卷（questionIds 顺序 = 预览勾选顺序 = 卷面题序） */
export async function assemblePaper(
  service: PaperAssemblyService,
  title: string,
  questionIds: string[],
): Promise<PaperAssemblyResult> {
  const ids = (questionIds ?? []).filter((id) => typeof id === 'string' && id.trim().length > 0);
  if (ids.length === 0) throw new Error('无题可装配（空卷拒绝创建）');

  const warnings: string[] = [];
  const paper = await service.createPaperEx(title, {}, { status: 'composing' });

  let added = 0;
  for (const questionId of ids) {
    try {
      await service.addQuestion(paper.id, questionId);
      added++;
    } catch (error) {
      warnings.push(`挂卷失败 ${questionId}：${messageOf(error)}`);
    }
  }

  let snapshotCount = 0;
  try {
    snapshotCount = await service.snapshotPaperQuestions(paper.id);
  } catch (error) {
    warnings.push(`快照失败（卷留 composing 待重试，不置 done）：${messageOf(error)}`);
    return { paperId: paper.id, paperTitle: paper.title ?? title, added, snapshotCount: 0, done: false, warnings };
  }

  let done = false;
  try {
    await service.updatePaperStatus(paper.id, 'done');
    done = true;
  } catch (error) {
    warnings.push(`置 done 失败（快照已写，可人工置 done）：${messageOf(error)}`);
  }

  return { paperId: paper.id, paperTitle: paper.title ?? title, added, snapshotCount, done, warnings };
}
