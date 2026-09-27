// 0044 P3：「存为试卷」主进程一步编排（R-036 / D-058）。
//
// 编排序（任务书 §二.P3.3）：逐题入库（沿用各题卡已采纳的挂树与标签）→ 建卷（status='composing'
// + folder 归属）→ paper.addQuestion ×N（保题卡顺序）→ recog run 回写。
//
// 失败口径（§二.P3.4「题保留、卷不建，半态卷不出现」）：
//   - 入库阶段失败：已入库题保留（不回滚、不删），卷未建（尚未进入事务），报错明示第 N 题；
//   - 建卷+归属+挂题在注入的事务边界内原子执行，任一步失败 → rollback → 卷不存在；
//   - run 回写在事务提交后（0040 入库同口径：卷已完整、只差回写时显式报错，不回滚已保存数据）。
//
// 本类不碰 SQL（bank-core 唯一碰 SQL 硬规则不破）：全部经注入的 service 面操作；
// 事务边界由 shell 侧以 Database BEGIN/COMMIT/ROLLBACK 注入（单连接同步模式，跨 await 安全：
// 桌面单用户单连接，事务开启到提交之间无并发语句插入）。

import type { BankService, PaperExtService, TreeService } from '../shared/contracts/bank-types.js';
import type { RecogSaveAsPaperPayload, RecogSaveAsPaperResult } from '../shared/contracts/ipc-channels.js';

export interface SaveAsPaperDeps {
  /** 入库/打标/挂题（addQuestion 在 BankService 面——与 bank.paper.addQuestion 通道同源） */
  bank: Pick<BankService, 'createQuestion' | 'addTag' | 'addQuestion'>;
  tree: Pick<TreeService, 'linkQuestion'>;
  paper: Pick<PaperExtService, 'createPaperEx' | 'moveToFolder'>;
  /** recog run 回写面（RecogRunServiceImpl.attachQuestions 同形；返回值不消费） */
  runs: { attachQuestions(id: string, questionIds: string[], now: string): Promise<void> };
  /** 事务边界（建卷→归属→挂题 的原子性；「卷不建」靠 rollback 兑现） */
  tx: { begin(): void; commit(): void; rollback(): void };
  now?: () => string;
}

export class SaveAsPaperService {
  constructor(private deps: SaveAsPaperDeps) {}

  async saveAsPaper(payload: RecogSaveAsPaperPayload): Promise<RecogSaveAsPaperResult> {
    if (!payload.cards || payload.cards.length === 0) {
      throw new Error('saveAsPaper：题卡清单为空（至少 1 题）');
    }
    if (!payload.title || !payload.title.trim()) {
      throw new Error('saveAsPaper：卷名不能为空（渲染层负责默认名兜底，此处守最后一道）');
    }
    const now = this.deps.now ? this.deps.now() : new Date().toISOString();

    // ---- 阶段一：逐题入库（题保留语义——失败不回滚已入库题，卷尚未建） ----
    const questionIds: string[] = [];
    for (let i = 0; i < payload.cards.length; i++) {
      const card = payload.cards[i]!;
      const label = card.qno ? `第 ${i + 1} 题（题号 ${card.qno}）` : `第 ${i + 1} 题`;
      try {
        const question = await this.deps.bank.createQuestion({
          subject: payload.subject,
          ...(payload.subjectId ? { subjectId: payload.subjectId } : {}),
          // 0062（R-066/D-076②）：学段随批次落题级列（缺省不写 → 读侧按「未分组」归一）
          ...(payload.stage ? { stage: payload.stage } : {}),
          sourceType: 'local',
          // 0040 工作台入库同口径（origin 恒 'scan'；写全 sourceDetail 供后续溯源）
          sourceDetail: {
            origin: 'scan',
            pageNo: card.pageNo,
            qno: card.qno ?? '',
            ...(payload.paperTitle ? { paperTitle: payload.paperTitle } : {}),
          },
          ...(card.typeCode ? { typeId: card.typeCode } : {}),
          content: card.contentHtml,
          stemHtml: card.contentHtml,
          ...(card.answerHtml.trim() !== '' ? { answer: card.answerHtml } : {}),
          ...(card.analysisHtml.trim() !== '' ? { analysis: card.analysisHtml } : {}),
          // 0057：题内图片条目随卡下发（渲染层按 contentHtml 的资产引用生成）；缺省空数组
          images: card.images ?? [],
        });
        // 沿用题卡已采纳的标签/挂树（未采纳不写，P-07）
        for (const tag of card.adoptedTags) {
          await this.deps.bank.addTag(question.id, tag);
        }
        // 0054（R-045③）：知识节点多值落链——adoptedNodes 为准、adoptedNode 回落（旧调用方零影响）；
        // 一题多节点由 linkQuestion 的 INSERT OR IGNORE 保证幂等（多挂 B3）。
        const nodes = card.adoptedNodes ?? (card.adoptedNode ? [card.adoptedNode] : []);
        for (const node of nodes) {
          await this.deps.tree.linkQuestion(question.id, node.nodeId);
        }
        questionIds.push(question.id);
      } catch (err) {
        const reason = err instanceof Error ? err.message : String(err);
        throw new Error(`saveAsPaper：${label}入库失败（已入库 ${questionIds.length} 题保留，试卷未创建）：${reason}`);
      }
    }

    // ---- 阶段二：建卷 + 归属 + 保序挂题（单事务——任一步失败回滚，半态卷不出现） ----
    let paperId = '';
    this.deps.tx.begin();
    try {
      const paper = await this.deps.paper.createPaperEx(payload.title.trim(), {}, { status: 'composing' });
      paperId = paper.id;
      if (payload.folderId) {
        await this.deps.paper.moveToFolder(paper.id, payload.folderId);
      }
      for (const questionId of questionIds) {
        await this.deps.bank.addQuestion(paper.id, questionId);
      }
      this.deps.tx.commit();
    } catch (err) {
      this.deps.tx.rollback();
      const reason = err instanceof Error ? err.message : String(err);
      throw new Error(`saveAsPaper：试卷保存失败（建卷/挂题阶段，事务已回滚——${questionIds.length} 题已入库保留）：${reason}`);
    }

    // ---- 阶段三：run 回写（事务外；失败=卷已完整，显式报错与 0040 入库口径一致，不回滚） ----
    try {
      await this.deps.runs.attachQuestions(payload.runId, questionIds, now);
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      throw new Error(`saveAsPaper：试卷已保存（${paperId}，${questionIds.length} 题）但识别记录回写失败：${reason}`);
    }

    return { paperId, questionIds };
  }
}
