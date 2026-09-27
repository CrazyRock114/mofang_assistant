// 0006 P1：dict 计划落库 — 真实 SQLite（DictServiceImpl + migrations，探针三场景：
// 归一行/站点行/未知值 active=0 + 幂等重跑零增量 + 人工指认不覆盖）

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { openDatabase } from '../../src/bank/db.js';
import { DictServiceImpl } from '../../src/bank/dict-service.js';
import { buildDictPlan, applyDictPlan } from '../../src/capture/dict-collect.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const migrationsDir = join(__dirname, '../../src/bank/migrations');

describe('applyDictPlan — 真实 SQLite（0006 P1 幂等落库）', () => {
  let tempDir: string;
  let dbPath: string;
  let dict: DictServiceImpl;
  let db: ReturnType<typeof openDatabase>;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'dict-apply-test-'));
    dbPath = join(tempDir, 'test.db');
    db = openDatabase(dbPath, migrationsDir);
    dict = new DictServiceImpl(db);
  });

  afterEach(() => {
    // Windows：SQLite 句柄未关时 rmSync 会 EPERM（migration.test.ts 同款收尾）
    db.close();
    rmSync(tempDir, { recursive: true, force: true });
  });

  const samplePlan = () => buildDictPlan({
    zujuanSubjects: [
      { bankId: '4', label: '物理', stage: '初中' },
      { bankId: '13', label: '物理', stage: '高中' },
    ],
    jyeooSubjects: [
      { segment: 'physics2', label: '物理', fullLabel: '物理', stage: '高中' },
      // 奥数已拍板归一 math（2026-09-10 目检拍板）；未知值场景改由「玄学」承担
      { segment: 'math0', label: '奥数', fullLabel: '奥数', stage: '小学' },
      { segment: 'xuanxue0', label: '玄学', fullLabel: '玄学', stage: '小学' },
    ],
    zujuanDifficulties: [{ value: '1', sourceLabel: '容易' }],
    jyeooDifficulties: [{ value: '13', sourceLabel: '中档' }],
  });

  it('首跑：归一行去重建行、站点行带 code 指向归一、未知值 active=0', async () => {
    const report = await applyDictPlan(dict, samplePlan());

    expect(report.normalizedCreated).toBe(4); // subject:physics,math + difficulty:easy,medium
    expect(report.siteCreated).toBe(6); // zujuan 初中物理/高中物理 + jyeoo physics2/math0 + zujuan 容易 + jyeoo 中档
    expect(report.unknownActive0).toBe(1); // jyeoo xuanxue0 玄学
    expect(report.siteSkipped).toBe(0);

    const all = await dict.listEntries();

    // 归一行：site=null，id 前缀规范
    const physics = all.find((e) => e.kind === 'subject' && e.code === 'physics' && !e.site);
    expect(physics).toMatchObject({ id: 'subj:physics', label: '物理', active: true });

    // 站点行：code 指向归一行 code，active=1
    const zujuanChuzhong = all.find((e) => e.site === 'zujuan' && e.sourceLabel === '初中物理');
    expect(zujiangChuzhongGuard(zujuanChuzhong)).toBe(true);
    expect(zujuanChuzhong).toMatchObject({ kind: 'subject', code: 'physics', label: '初中物理', active: true });

    // 菁优 segment 原文行
    const jyeooPhysics = all.find((e) => e.site === 'jyeoo' && e.sourceLabel === 'physics2');
    expect(jyeooPhysics).toMatchObject({ kind: 'subject', code: 'physics', label: 'physics2', active: true });

    // 奥数已拍板归一 math：站点行 code 指向归一码、active=1
    const olympiad = all.find((e) => e.site === 'jyeoo' && e.sourceLabel === 'math0');
    expect(olympiad).toMatchObject({ kind: 'subject', code: 'math', label: 'math0', active: true });

    // 未知值：存原样 + code='' + active=0（U12 待指认）
    const xuanxue = all.find((e) => e.site === 'jyeoo' && e.sourceLabel === 'xuanxue0');
    expect(xuanxue).toMatchObject({ kind: 'subject', code: '', label: 'xuanxue0', active: false });

    // 难度站点行/归一行
    const easyNorm = all.find((e) => e.kind === 'difficulty' && !e.site && e.code === 'easy');
    expect(easyNorm).toMatchObject({ label: '容易' });
    const zujuanEasy = all.find((e) => e.kind === 'difficulty' && e.site === 'zujuan');
    expect(zujiangEasyGuard(zujuanEasy)).toBe(true);
    const jyeooZhongdang = all.find((e) => e.kind === 'difficulty' && e.site === 'jyeoo');
    expect(jyeooZhongdang).toMatchObject({ sourceLabel: '中档', code: 'medium' });
  });

  it('幂等重跑：零增量、行数不变', async () => {
    const plan = samplePlan();
    const first = await applyDictPlan(dict, plan);
    const before = (await dict.listEntries()).length;
    expect(before).toBe(first.normalizedCreated + first.siteCreated + first.unknownActive0);

    const second = await applyDictPlan(dict, plan);
    expect(second.normalizedCreated).toBe(0);
    expect(second.siteCreated).toBe(0);
    expect(second.unknownActive0).toBe(0);
    expect(second.normalizedSkipped).toBe(first.normalizedCreated);
    expect(second.siteSkipped).toBe(first.siteCreated + first.unknownActive0);
    expect((await dict.listEntries()).length).toBe(before);
  });

  it('人工指认保护：站点行 code 被人工改动后重跑不覆盖、不重复建行', async () => {
    const plan = samplePlan();
    await applyDictPlan(dict, plan);
    const all = await dict.listEntries();
    const unknown = all.find((e) => e.site === 'jyeoo' && e.sourceLabel === 'xuanxue0');
    // 设置页指认：补 code + 激活（updateEntry 语义）
    // 0016 P1-3 守卫适配：指认 code 须指向已建归一行（原 'metaphysics' 非归一行），改指既有归一行 'physics'；
    // 断言强度不变：仍验证「人工改 code + 激活 → 重跑零覆盖零重建」
    await dict.updateEntry(unknown!.id, { code: 'physics', active: true });

    const second = await applyDictPlan(dict, plan);
    expect(second.siteCreated).toBe(0);
    expect(second.unknownActive0).toBe(0);

    const after = await dict.listEntries();
    const rows = after.filter((e) => e.site === 'jyeoo' && e.sourceLabel === 'xuanxue0');
    expect(rows.length).toBe(1);
    expect(rows[0]).toMatchObject({ code: 'physics', active: true });
  });
});

/** 行存在断言（避免 ts 将严格 null 检查下的可选链误判） */
function zujiangChuzhongGuard(row: unknown): boolean {
  return row !== undefined && row !== null;
}
function zujiangEasyGuard(row: unknown): boolean {
  return row !== undefined && row !== null;
}
