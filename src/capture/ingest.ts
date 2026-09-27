/**
 * 采集题目入库：CapturedQuestion[] → bank 层
 */

import type { CapturedQuestion, NormalizedCaptureQuestion } from '../shared/contracts/capture-types.js';
import type { DictEntry, Question, TreeService } from '../shared/contracts/bank-types.js';
import { normalizeCaptured } from './normalize.js';
import { hasBrokenImageRefs } from './assets.js';
import { resolveSubjectKey, subjectLabelOf, SUBJ_PREFIX } from '../bank/subject-normalize.js';
import { isArchivedTreeName } from '../bank/tree-archive.js';

// 难度文本映射表（站点原文 → 0-1 数值）
const DIFFICULTY_MAP: Record<string, number> = {
  '容易': 0.2,
  '简单': 0.2,
  '中等': 0.5,
  '较难': 0.7,
  '困难': 0.85,
  '很难': 0.95,
};

export interface AssetResolveResult {
  images: NormalizedCaptureQuestion['normalizedImages'];
  warnings: string[];
}

export interface IngestOptions {
  /** 用户选择学科（L-1 产品层下拉，单学科中文）；优先于 jyeoo meta.subject；缺省时 meta.subject（站点原文）→ 'unknown' 回落 */
  subject?: string;
  /**
   * 0006-fix-3 P3（只增）：用户选择学科已由 host 侧解析出的字典归一 id（`subj:{code}`）。
   * 缺省不落 subjectId（未命中，§零.9 不猜不并）。
   */
  subjectId?: string;
  /** 学段（L-1：学段+学科组合拆分而来，落 Question.stage） */
  stage?: string;
  /**
   * 0006-fix-3 P3（只增）：subject 全量字典（含站点行）。注入后站点原文（meta.subject）经站点行
   * 解析为归一 label + subjectId；未注入退回原文直通 + 零告警（向后兼容，同 treeService 注入模式）。
   */
  dictEntries?: DictEntry[];
  /** 图片资产下载器（host 层注入 Electron 同 session 实现；缺省则图片不落盘） */
  assetResolver?: (q: CapturedQuestion) => Promise<AssetResolveResult>;
}

export interface IngestResult {
  ok: number;
  dup: number;
  /** D1-fix-4 复验 R-U（只增）：重采回填更新的已有题目数（dup 命中且补缺字段成功） */
  updated?: number;
  failed: Array<{ questionId: string; error: string }>;
  /**
   * 0004-fix-1 D 组（只增）：本次入库后**现在本地题库中**的题目 id（ok 新建 id + updated 补缺的已有题 id）。
   * dup（既未新建也未回填，题早已在库）不属本批新增，故不含——上层按需再自行过滤。
   * 供 host.collect 组装 CaptureCollectResult.okIds → CapturePage 采集进篮联动。
   */
  okIds?: string[];
  /**
   * 0006 P4（只增）：本次入参每个题号 → 本地题 id（键 `site:questionId`），新建/回填/dup 全覆盖。
   * 成品卷装配需要 dup 题的本地 id（okIds 按语义不含 dup，无法挂卷），故另开一映射，语义与 okIds 不重叠。
   */
  localIds?: Record<string, string>;
  /** 0006 P2（只增）：入库过程降级告警（挂树反查不到/失败等），上层并入 collect warnings */
  warnings?: string[];
}

// 全局 service 实例（运行时由 shell 层注入；测试时被 mock 替换）
let questionServiceInstance: any = null;
// 0006 P2（只增）：树服务注入——题带 meta.sourceNodeIds 时经 tree_source_map 反查挂树；缺省无挂树
let treeServiceInstance: TreeService | null = null;

export function setQuestionService(service: any): void {
  questionServiceInstance = service;
}

export function getQuestionService(): any {
  if (!questionServiceInstance) {
    throw new Error('QuestionService not initialized');
  }
  return questionServiceInstance;
}

export function setTreeService(service: TreeService | null): void {
  treeServiceInstance = service;
}

export function getTreeService(): TreeService | null {
  return treeServiceInstance;
}

/**
 * 0006 P2 挂树：题带站点节点 id（meta.sourceNodeIds）→ resolveSourceNode 反查本地节点 → linkQuestion。
 * 只增不删；反查不到/树服务未注入 → 记 warning 不阻塞入库（任务书 P2：查不到降级 warning）。
 * 0039 P2 归一：反查命中「已归档」树（树收敛后路径无同名节点的孤儿映射仍指向归档树）→ 显式 warning
 * 跳过，不把新链挂进归档树；待人工/0027 指认后经权威树挂树（0029 AI 建议同链）。
 */
async function linkQuestionNodes(
  questionId: string,
  cap: CapturedQuestion,
  warnings: string[]
): Promise<void> {
  const treeService = getTreeService();
  const refs = cap.meta.sourceNodeIds;
  if (!treeService || !Array.isArray(refs) || refs.length === 0) return;
  for (const ref of refs) {
    if (!ref || typeof ref.site !== 'string' || typeof ref.siteNodeId !== 'string') continue;
    try {
      const node = await treeService.resolveSourceNode(ref.site, ref.siteNodeId);
      if (!node) {
        warnings.push(`${cap.site}:${cap.questionId} 挂树跳过：站点节点未建（${ref.site}:${ref.siteNodeId}）`);
        continue;
      }
      const owner = await treeService.getTree(node.treeId);
      if (owner && isArchivedTreeName(owner.name)) {
        warnings.push(`${cap.site}:${cap.questionId} 挂树跳过：站点节点命中已归档树「${owner.name}」（${ref.site}:${ref.siteNodeId}，权威树无同名路径）——待人工指认`);
        continue;
      }
      await treeService.linkQuestion(questionId, node.id);
    } catch (error: any) {
      warnings.push(`${cap.site}:${cap.questionId} 挂树失败：${error?.message || String(error)}`);
    }
  }
}

/**
 * 0006-fix-3 P3 学科解析：用户选择优先（subjectId 由 host 解析传入）；缺省回落站点原文
 * （meta.subject，站点行解析 → 归一 label + subjectId）。
 * 未命中一律落原文 + warning、不落 subjectId（§零.9：不新建字典行、不猜不并，不阻塞入库）。
 */
function resolveIngestSubject(
  cap: CapturedQuestion,
  options: IngestOptions,
  warnings: string[],
): { subject: string; subjectId?: string } {
  if (options.subject) {
    return { subject: options.subject, ...(options.subjectId ? { subjectId: options.subjectId } : {}) };
  }
  const raw = cap.meta.subject;
  const rawText = typeof raw === 'string' && raw.trim() ? raw.trim() : undefined;
  if (!rawText) return { subject: 'unknown' };
  // 字典未注入（旧调用方）：原文直通，保持改造前语义，零告警
  if (!options.dictEntries) return { subject: rawText };

  // 0006 P4（只增）：dictEntries 现含全 kind（题型/难度行同源加载），学科解析按 kind 过滤防跨 kind 撞名
  const entries = options.dictEntries.filter((e) => e.kind === 'subject');
  const code = resolveSubjectKey(rawText, cap.site, entries);
  const label = code ? subjectLabelOf(code, entries) : undefined;
  if (!code || !label) {
    warnings.push(`${cap.site}:${cap.questionId} 学科未命中字典（meta.subject=${rawText}），subjectId 不落库`);
    return { subject: rawText };
  }
  return { subject: label, subjectId: `${SUBJ_PREFIX}${code}` };
}

/**
 * 0006 P4（只增）：题型/难度字典归一（站点行优先，同学科解析语义）——
 * 命中站点行/归一行 → 归一 label + `qtype:`/`diff:` id（只落**存在**的归一行，满足 dict_entries 外键）；
 * 未命中 → 返回 null 由调用方存原文（§零.9 不猜不并，不新建字典行）。
 */
function resolveDictKind(
  kind: 'question_type' | 'difficulty',
  raw: string | undefined,
  site: string,
  entries: DictEntry[],
): { code: string; label: string } | null {
  const value = (raw ?? '').trim();
  if (!value) return null;
  const siteRow = entries.find((e) => e.kind === kind && e.site === site && e.sourceLabel === value);
  const code = siteRow?.code
    || (entries.some((e) => e.kind === kind && !e.site && e.code === value) ? value : undefined)
    || entries.find((e) => e.kind === kind && !e.site && e.label === value)?.code;
  if (!code) return null;
  const normalized = entries.find((e) => e.kind === kind && !e.site && e.code === code);
  if (!normalized) return null;
  return { code, label: normalized.label };
}

/**
 * 归一化图片 → Question.images（0002 契约：assetId + 语义类型；采集侧按区域分域自动判定：
 * 题干区域图→figure；答案区域图→answer-image）
 */
function toQuestionImages(
  images: NormalizedCaptureQuestion['normalizedImages'],
): Question['images'] {
  return images.map((img) => ({
    assetId: img.localPath,
    type: img.role === 'answer' ? ('answer-image' as const) : ('figure' as const),
  }));
}

/**
 * 批量入库采集题目
 */
export async function ingestCaptured(
  captured: CapturedQuestion[],
  options: IngestOptions
): Promise<IngestResult> {
  const bankService = getQuestionService();

  // 去重：拉取本地所有题目，按 sourceDetail.site + questionId 过滤（保留完整记录供回填）
  const existingQuestions = await bankService.listQuestions();
  const existingByKey = new Map<string, Question>();
  for (const q of existingQuestions as Question[]) {
    if (q.sourceType !== 'network' || !q.sourceDetail) continue;
    const detail = q.sourceDetail as any;
    existingByKey.set(`${detail.site}:${detail.questionId}`, q);
  }

  const result: IngestResult = {
    ok: 0,
    dup: 0,
    updated: 0,
    failed: [],
    okIds: [],
    localIds: {},
    warnings: [],
  };

  for (const cap of captured) {
    const key = `${cap.site}:${cap.questionId}`;

    // temp-*/空 questionId 拒绝入库：jyeoo 真实 tid 未解析不得产生脏数据（D-4）
    if (!cap.questionId || /^temp-/i.test(cap.questionId)) {
      result.failed.push({
        questionId: cap.questionId || '(empty)',
        error: 'missing real questionId（真实 tid 未解析，不入库）',
      });
      continue;
    }

    // 去重检查：命中已有条目时，D1-fix-4 复验 R-U——不再整条跳过；
    // 已有题缺失而本次抓到的字段（答案/解析/考点）回填更新，已有内容一律不覆盖（保护用户编辑）
    const existing = existingByKey.get(key);
    if (existing) {
      // 0006 P4（只增）：dup/回填题也登记本地 id（成品卷装配需挂 dup 题；okIds 按语义不含 dup）
      result.localIds![key] = existing.id;
      // 0004-fix-1c B组：重采回填同步走完整归一化管线（含题首孤图后移）。资产下载先行——
      // HTML src 需改写本地路径并取真实尺寸，否则 content 刷新会把库内本地引用退化为远程 src
      let backfillImages: NormalizedCaptureQuestion['normalizedImages'] = [];
      if (options.assetResolver) {
        const assets = await options.assetResolver(cap);
        backfillImages = assets.images;
      }
      const normalized = normalizeCaptured(cap, backfillImages);
      const patch: Record<string, unknown> = {};
      if (!existing.answer && normalized.answerHtml) patch.answer = normalized.answerHtml;
      if (!existing.analysis && normalized.analysisHtml) patch.analysis = normalized.analysisHtml;
      const incomingKp = cap.meta.knowledgePoints?.filter(Boolean) ?? [];
      if ((!existing.knowledgePoints || existing.knowledgePoints.length === 0) && incomingKp.length > 0) {
        patch.knowledgePoints = incomingKp;
      }
      // 0004-fix-1c B组：content 整体以新归一化结果刷新（重采即修复存量旧题）。
      // 仅在资产管线可用时执行（无下载层的归一化产物 src 为远程地址，刷新反而劣化库内内容）；
      // 与库内一致（已是新管线产物）则不写，保持 dup 语义不虚增 updated；
      // 0006-P4-fix-1 P3：仅「库存裂 + 本次仍裂」抑制刷新——不拿新的裂图形态覆盖存量裂图
      if (options.assetResolver && normalized.contentHtml !== existing.content
        && !(hasBrokenImageRefs(existing.content) && hasBrokenImageRefs(normalized.contentHtml))) {
        patch.content = normalized.contentHtml;
      }
      // 0006-P4-fix-1 P3：裂图字段修复性回填（定向扩张，仅 dup 分支）——
      // 「用户主动重新导入 = 授权修复损坏字段」：库存字段确含裂图形态（`.html` WAF 资产 / mzujuan 死链）
      // 且本次归一化产物已修好 → 覆盖该字段；健康字段与本次仍裂一律不动（保护健康内容与用户编辑）。
      // 只在资产管线可用时生效（无下载层时本次产物 src 为远端地址，不算「修好」）。
      const repairFields = options.assetResolver
        ? (['content', 'answer', 'analysis'] as const).filter((field) => {
            const stored = field === 'content' ? existing.content : field === 'answer' ? existing.answer : existing.analysis;
            const inbound = field === 'content' ? normalized.contentHtml : field === 'answer' ? normalized.answerHtml : normalized.analysisHtml;
            return !!stored && hasBrokenImageRefs(stored)
              && !!inbound && !hasBrokenImageRefs(inbound)
              && inbound !== stored;
          })
        : [];
      if (repairFields.includes('answer')) patch.answer = normalized.answerHtml;
      if (repairFields.includes('analysis')) patch.analysis = normalized.analysisHtml;
      if (repairFields.length > 0) {
        // 修复性覆盖发生时（content 由上方既有刷新规则写入 / answer / analysis 本轮覆盖）：
        // images 列同步刷新为本次归一化结果，清除 `.html` 资产引用
        patch.images = toQuestionImages(normalized.normalizedImages);
      }
      // D1-fix-6：bankid 回填——库存无而本次采到（含 host 注入的库存兜底值）时，读出现有
      // sourceDetail 合并写回（其他键原样保留）；库存已有值一律不覆盖（首次落库值即实测优先）
      const existingDetail = (existing.sourceDetail ?? {}) as Record<string, unknown>;
      if (!existingDetail.bankid && cap.meta.bankid) {
        patch.sourceDetail = { ...existingDetail, bankid: cap.meta.bankid };
      }
      if (Object.keys(patch).length === 0) {
        result.dup++;
        continue;
      }
      try {
        await bankService.updateQuestion(existing.id, patch);
        result.updated = (result.updated ?? 0) + 1;
        // 0004-fix-1 D：回填题也在库中，计入 okIds（补缺成功即本批可加篮的题）
        result.okIds?.push(existing.id);
      } catch (error: any) {
        result.failed.push({
          questionId: cap.questionId,
          error: `回填更新失败：${error?.message || String(error)}`,
        });
      }
      continue;
    }

    try {
      // 图片资产下载（同 session），失败降级为 warning 不中断
      let localImages: NormalizedCaptureQuestion['normalizedImages'] = [];
      if (options.assetResolver) {
        const assets = await options.assetResolver(cap);
        localImages = assets.images;
      }

      // 归一化
      const normalized = normalizeCaptured(cap, localImages);

      // 映射 meta
      // 0006 P4（只增）：题型/难度经字典归一（dictEntries 注入时）；未命中存站点原文、不落 id
      const typeResolved = options.dictEntries
        ? resolveDictKind('question_type', cap.meta.questionType, cap.site, options.dictEntries)
        : null;
      const diffResolved = options.dictEntries
        ? resolveDictKind('difficulty', cap.meta.difficulty, cap.site, options.dictEntries)
        : null;
      const difficulty = cap.meta.difficulty
        ? DIFFICULTY_MAP[cap.meta.difficulty] ?? (diffResolved ? DIFFICULTY_MAP[diffResolved.label] : undefined)
        : undefined;

      const knowledgePoints = cap.meta.knowledgePoints?.filter(Boolean) ?? [];

      // 构建入库入参（P3：用户选择优先【host 已解析 subjectId】，缺省站点原文经站点行字典化）
      const subj = resolveIngestSubject(cap, options, result.warnings!);
      const questionData: Omit<Question, 'id' | 'createdAt' | 'updatedAt'> = {
        subject: subj.subject,
        ...(subj.subjectId ? { subjectId: subj.subjectId } : {}),
        ...(options.stage ? { stage: options.stage } : {}),
        sourceType: 'network',
        sourceDetail: {
          site: cap.site,
          url: cap.sourceUrl,
          questionId: cap.questionId,
          collectedAt: new Date().toISOString(),
          ...(cap.meta.gated ? { gated: true } : {}),
          ...(cap.meta.answerVia ? { answerVia: cap.meta.answerVia } : {}),
          // D1-fix-6：题库 id 随来源明细落库——异页/重采时 host 可回注（详情页 URL 前缀兜底）
          ...(cap.meta.bankid ? { bankid: cap.meta.bankid } : {}),
          // 0006 P4：整卷下载溯源（卷名/卷 URL/来源卷 from+paperTitle）
          ...(cap.meta.paperRef ? { paper: cap.meta.paperRef } : {}),
          // 0056（只增）：子母题条数落库（quesChildNum>1；采集时已按母题整题入库，未拆子题）。
          // 落库理由：AI 整理（R-041）要按此跳过子母题——采集预览是瞬态的、库内此前无此信号，
          // 不落库则该批无法识别子母题（任务书 §零.4 的「不进整理集」）。零契约变更：sourceDetail 是 JSON 自由面。
          ...(cap.meta.childQuestionCount ? { childQuestionCount: cap.meta.childQuestionCount } : {}),
        },
        ...(cap.meta.questionType ? { questionType: typeResolved ? typeResolved.label : cap.meta.questionType } : {}),
        ...(typeResolved ? { typeId: `qtype:${typeResolved.code}` } : {}),
        difficulty,
        ...(diffResolved ? { difficultyId: `diff:${diffResolved.code}` } : {}),
        knowledgePoints: knowledgePoints.length > 0 ? knowledgePoints : undefined,
        content: normalized.contentHtml,
        answer: normalized.answerHtml || undefined,
        analysis: normalized.analysisHtml || undefined,
        // 0002 契约：images 结构化（assetId+语义类型）。采集侧按区域分域自动判定（schema 草案 §7）：
        // 题干区域图→figure；答案区域图→answer-image
        images: toQuestionImages(normalized.normalizedImages),
      };

      const created = await bankService.createQuestion({ data: questionData });
      result.ok++;
      if (created?.id) {
        result.okIds?.push(created.id);
        // 0006 P4（只增）：登记本地 id（成品卷挂卷用）
        result.localIds![key] = created.id;
        // 0006 P2：题带站点节点 id 时挂树（warning 降级，不阻塞）
        await linkQuestionNodes(created.id, cap, result.warnings!);
      }
      // 批量内去重：新建条目入索引（二次命中走回填/跳过分支）
      existingByKey.set(key, { ...questionData, id: created?.id ?? key } as Question);
    } catch (error: any) {
      result.failed.push({
        questionId: cap.questionId,
        error: error.message || String(error),
      });
    }
  }

  return result;
}
