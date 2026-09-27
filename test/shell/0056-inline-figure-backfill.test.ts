// 0056（R-064 P2）：存量 inline-figure 误判回填。
//
// 判据（任务书 §零.11，与 §零.10 新判定同口径）：content 里被 span.inline-figure 包裹 **且** 位图（非 .svg）
// **且** 高 > 60px **且** 非选项区 → 还原块级 figure.diagram（只改包裹结构，不动资产文件、不动 images）。
// 机制复用 0057 启动期 backfill 先例：幂等 + 先备份 + 单题失败不中断启动 + operation_log 留痕。
//
// 环境：node（真 fs 临时库文件；electron 全 mock 模式照 0057 同款）。

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { rewriteInlineFigureWraps, runInlineFigureBackfill } from '../../src/shell/inline-figure-backfill.js';

/** 菁优真形态：位图 197×122 被纯尺寸判定包成行内图（诊断纪要 §一/§二） */
const JYEOO_INLINE = '<span class="inline-figure"><img class="q-figure" data-w="197" data-h="122" src="data-assets/capture/jyeoo/jh1-1.png"></span>';
const JYEOO_BLOCK = '<figure class="diagram" data-w="197" data-h="122"><img class="q-figure" src="data-assets/capture/jyeoo/jh1-1.png"></figure>';

/** 公式条（位图但高 ≤60px）——判定正确，不该动 */
const FORMULA_STRIP = '<span class="inline-figure"><img class="q-figure" data-w="84" data-h="20" src="data-assets/capture/zujuan/f1.png"></span>';
/** 组卷公式 SVG——非位图，不该动 */
const FORMULA_SVG = '<span class="inline-figure"><img class="q-figure" data-w="33" data-h="12" src="data-assets/capture/zujuan/f3.svg"></span>';

function contentOf(stem: string, options = ''): string {
  return `<div class="question">${stem}${options ? `<div class="options">${options}</div>` : '<div class="options"></div>'}</div>`;
}

describe('0056 R-064 backfill：纯改写判据', () => {
  it('题干区：位图高 > 60 → 还原块级 figure.diagram（data-w/h 与 src 逐字保留）', () => {
    const out = rewriteInlineFigureWraps(contentOf(`如图，${JYEOO_INLINE}所示`));
    expect(out.html).toContain(`如图，${JYEOO_BLOCK}所示`);
    expect(out.converted).toBe(1);
    expect(out.skippedOptionRegion).toBe(0);
  });

  it('选项区：同形图不拽出文字流（skippedOptionRegion 记账），块级结构零改动', () => {
    const html = contentOf('题', `<span class="option">A. ${JYEOO_INLINE}</span>`);
    const out = rewriteInlineFigureWraps(html);
    expect(out.html).toBe(html);
    expect(out.converted).toBe(0);
    expect(out.skippedOptionRegion).toBe(1);
  });

  it('公式条（位图高 ≤60）不动', () => {
    const html = contentOf(FORMULA_STRIP);
    expect(rewriteInlineFigureWraps(html).html).toBe(html);
  });

  it('公式 SVG 不动（非位图）', () => {
    const html = contentOf(FORMULA_SVG);
    expect(rewriteInlineFigureWraps(html).html).toBe(html);
  });

  it('块级 figure.diagram 本身不动（已是正确形态）', () => {
    const html = contentOf(JYEOO_BLOCK);
    expect(rewriteInlineFigureWraps(html).html).toBe(html);
  });

  it('缺 data-h（尺寸未知）不动——新判据不猜', () => {
    const html = contentOf('<span class="inline-figure"><img class="q-figure" src="data-assets/capture/jyeoo/x.png"></span>');
    expect(rewriteInlineFigureWraps(html).html).toBe(html);
  });

  it('一题多图：只还原命中者，其余逐字不动', () => {
    const html = contentOf(`${JYEOO_INLINE}文字${FORMULA_STRIP}${JYEOO_INLINE}`);
    const out = rewriteInlineFigureWraps(html);
    expect(out.converted).toBe(2);
    expect(out.html).toContain(FORMULA_STRIP); // 公式条（高 ≤60）保持行内
    expect(out.html).not.toContain(`inline-figure"><img class="q-figure" data-w="197"`); // 命中者全部还原
  });

  it('幂等：对已还原的 HTML 再跑零改动', () => {
    const once = rewriteInlineFigureWraps(contentOf(JYEOO_INLINE));
    const twice = rewriteInlineFigureWraps(once.html);
    expect(twice.html).toBe(once.html);
    expect(twice.converted).toBe(0);
  });

  it('jpg/webp 同属位图；无扩展名按位图处理（非 .svg 即非公式矢量）', () => {
    const jpg = contentOf('<span class="inline-figure"><img class="q-figure" data-w="180" data-h="120" src="data-assets/capture/jyeoo/a.jpg"></span>');
    expect(rewriteInlineFigureWraps(jpg).converted).toBe(1);
    const noExt = contentOf('<span class="inline-figure"><img class="q-figure" data-w="180" data-h="120" src="data-assets/capture/jyeoo/b"></span>');
    expect(rewriteInlineFigureWraps(noExt).converted).toBe(1);
  });
});

let root: string;
let dbPath: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'mofang-0056-'));
  dbPath = join(root, 'bank.db');
  writeFileSync(dbPath, 'FAKE-DB-BYTES-v1');
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

/** 假 bank 面（内存表；只记调用，不碰 SQL） */
function makeFakeBank(seed: Array<{ id: string; content: string }>) {
  const rows = new Map(seed.map((q) => [q.id, { ...q }]));
  const updates: Array<{ id: string; patch: Record<string, unknown> }> = [];
  const logs: Array<{ kind: 'start' | 'success' | 'failure'; op: string; detail: unknown }> = [];
  return {
    rows, updates, logs,
    listQuestions: async () => [...rows.values()].map((r) => ({ ...r })),
    updateQuestion: async (id: string, patch: Record<string, unknown>) => {
      updates.push({ id, patch });
      rows.set(id, { ...rows.get(id)!, ...patch });
      return rows.get(id);
    },
    logger: {
      logStart: (op: string) => { logs.push({ kind: 'start', op, detail: null }); return `log-${logs.length}`; },
      logSuccess: (id: string, affected: number) => { logs.push({ kind: 'success', op: id, detail: { affected } }); },
      logFailure: (id: string, error: Error) => { logs.push({ kind: 'failure', op: id, detail: { message: error.message } }); },
    },
  };
}

describe('0056 R-064 backfill：跑一次（备份 / 幂等 / 单题失败不中断）', () => {
  it('命中题改写落库（只写 content 字段）+ 台账成功 affected=改动题数', async () => {
    const bank = makeFakeBank([
      { id: 'q1', content: contentOf(JYEOO_INLINE) },
      { id: 'q2', content: contentOf(FORMULA_STRIP) },
    ]);
    const report = await runInlineFigureBackfill({
      listQuestions: bank.listQuestions,
      updateQuestion: bank.updateQuestion,
      dbPath,
      logger: bank.logger,
    });
    expect(report.scanned).toBe(2);
    expect(report.candidates).toBe(1);
    expect(report.changed).toBe(1);
    expect(report.convertedFigures).toBe(1);
    expect(report.failures).toEqual([]);
    expect(report.backedUp).toBe(true);
    expect(bank.updates).toHaveLength(1);
    expect(Object.keys(bank.updates[0]!.patch)).toEqual(['content']);
    expect(bank.logs.filter((l) => l.kind === 'success')).toEqual([{ kind: 'success', op: 'log-1', detail: { affected: 1 } }]);
  });

  it('备份先落：bank.db.bak-0056 字节 = 迁移前库文件（不动源文件）', async () => {
    const bank = makeFakeBank([{ id: 'q1', content: contentOf(JYEOO_INLINE) }]);
    const before = readFileSync(dbPath);
    await runInlineFigureBackfill({ listQuestions: bank.listQuestions, updateQuestion: bank.updateQuestion, dbPath });
    const backup = `${dbPath}.bak-0056`;
    expect(existsSync(backup)).toBe(true);
    expect(readFileSync(backup).equals(before)).toBe(true);
  });

  it('幂等：二次跑零改动、不重复备份、零台账（文件级实证）', async () => {
    const seed = [{ id: 'q1', content: contentOf(JYEOO_INLINE) }];
    const bank = makeFakeBank([...seed]);
    await runInlineFigureBackfill({ listQuestions: bank.listQuestions, updateQuestion: bank.updateQuestion, dbPath, logger: bank.logger });
    const backupBytes = readFileSync(`${dbPath}.bak-0056`);
    const second = await runInlineFigureBackfill({
      listQuestions: bank.listQuestions,
      updateQuestion: bank.updateQuestion,
      dbPath,
      logger: bank.logger,
    });
    expect(second.candidates).toBe(0);
    expect(second.changed).toBe(0);
    expect(second.backedUp).toBe(false);
    expect(bank.updates).toHaveLength(1); // 只第一跑那一次
    expect(bank.logs.filter((l) => l.kind === 'start')).toHaveLength(1);
    expect(readFileSync(`${dbPath}.bak-0056`).equals(backupBytes)).toBe(true);
  });

  it('无候选（零命中）：不备份、零写库、零台账', async () => {
    const bank = makeFakeBank([{ id: 'q1', content: contentOf(FORMULA_STRIP) }]);
    const report = await runInlineFigureBackfill({
      listQuestions: bank.listQuestions,
      updateQuestion: bank.updateQuestion,
      dbPath,
      logger: bank.logger,
    });
    expect(report.changed).toBe(0);
    expect(report.backedUp).toBe(false);
    expect(existsSync(`${dbPath}.bak-0056`)).toBe(false);
    expect(bank.updates).toHaveLength(0);
    expect(bank.logs).toHaveLength(0);
  });

  it('单题失败不中断：其余题照改，失败记账 + 台账 failed 分支', async () => {
    const bank = makeFakeBank([
      { id: 'q1', content: contentOf(JYEOO_INLINE) },
      { id: 'q2', content: contentOf(JYEOO_INLINE) },
    ]);
    const updateQuestion = vi.fn(async (id: string, patch: Record<string, unknown>) => {
      if (id === 'q1') throw new Error('磁盘满');
      return bank.updateQuestion(id, patch);
    });
    const warnings: string[] = [];
    const report = await runInlineFigureBackfill({
      listQuestions: bank.listQuestions,
      updateQuestion,
      dbPath,
      logger: bank.logger,
      warn: (m) => warnings.push(m),
    });
    expect(report.changed).toBe(1);
    expect(report.failures).toEqual([{ id: 'q1', reason: '磁盘满' }]);
    expect(warnings.some((w) => w.includes('q1'))).toBe(true);
    expect(bank.logs.some((l) => l.kind === 'failure')).toBe(true);
  });
});
