// 0016 P1-3：dict.update 指认守卫 — patch.code 须指向同 kind 已建归一行（site IS NULL）
// 守卫语义基准：src/bank/tree-subject-fix.ts:68-69（applySubjectAssignments：code 必须是已建归一行否则抛错）
// 指认调用形态基准：test/bank/dict-collect-apply.test.ts:106-121（指认 = updateEntry(id, { code, active: true })）
// 双跑：真实 SQLite + mock 内存同绿（mock 层同构守卫）

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import type { DictService } from '../../src/shared/contracts/bank-types.js';
import { openDatabase } from '../../src/bank/db.js';
import { DictServiceImpl } from '../../src/bank/dict-service.js';
import { createMockExtServices } from '../../src/bank/mock/mock-ext.js';
import { MockBankStore } from '../../src/bank/mock/mock-store.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const migrationsDir = join(__dirname, '../../src/bank/migrations');

interface GuardCtx {
  dict: DictService;
  cleanup: () => void;
}

const implementations: Array<{ name: string; factory: () => GuardCtx }> = [
  {
    name: 'Real (SQLite)',
    factory: () => {
      const tempDir = mkdtempSync(join(tmpdir(), 'dict-guard-test-'));
      const db = openDatabase(join(tempDir, 'test.db'), migrationsDir);
      return { dict: new DictServiceImpl(db), cleanup: () => { db.close(); rmSync(tempDir, { recursive: true, force: true }); } };
    },
  },
  {
    name: 'Mock (in-memory)',
    factory: () => {
      const ext = createMockExtServices(new MockBankStore());
      return { dict: ext.dict, cleanup: () => {} };
    },
  },
];

implementations.forEach(({ name, factory }) => {
  describe(`0016 P1-3 dict.update 指认守卫 - ${name}`, () => {
    let ctx: GuardCtx;
    let dict: DictService;

    beforeEach(() => {
      ctx = factory();
      dict = ctx.dict;
    });
    afterEach(() => ctx.cleanup());

    /** 播种：subject 归一行 physics + difficulty 归一行 easy + subject 未知站点行（code='' active=false） */
    async function seed() {
      const physics = await dict.createEntry({ kind: 'subject', code: 'physics', label: '物理' });
      const easy = await dict.createEntry({ kind: 'difficulty', code: 'easy', label: '容易' });
      const unknown = await dict.createEntry({
        kind: 'subject', code: '', label: '玄学', site: 'jyeoo', sourceLabel: 'xuanxue0', active: false,
      });
      return { physics, easy, unknown };
    }

    it('指认成功：updateEntry(id, { code: 归一行, active: true }) 落库（对齐 dict-collect-apply 指认形态）', async () => {
      const { physics, unknown } = await seed();
      const updated = await dict.updateEntry(unknown.id, { code: physics.code, active: true });
      expect(updated).toMatchObject({ id: unknown.id, code: 'physics', active: true });

      const reread = await dict.getEntry(unknown.id);
      expect(reread).toMatchObject({ code: 'physics', active: true, site: 'jyeoo', sourceLabel: 'xuanxue0' });
    });

    it('守卫拒绝·code 不存在（非已建归一行）', async () => {
      const { unknown } = await seed();
      await expect(dict.updateEntry(unknown.id, { code: 'metaphysics' }))
        .rejects.toThrow(/已建归一行/);
    });

    it('守卫拒绝·跨 kind（difficulty 归一码指到 subject 站点行）', async () => {
      const { easy, unknown } = await seed();
      await expect(dict.updateEntry(unknown.id, { code: easy.code }))
        .rejects.toThrow(/已建归一行/);
    });

    it('守卫拒绝·空 code（不存在 code="" 的归一行）', async () => {
      const { unknown } = await seed();
      await expect(dict.updateEntry(unknown.id, { code: '' }))
        .rejects.toThrow(/已建归一行/);
    });

    it('守卫拒绝后站点行 code 不变式零破坏：未知行仍 code="" active=false，归一行零漂移', async () => {
      const { physics, easy, unknown } = await seed();
      await expect(dict.updateEntry(unknown.id, { code: 'metaphysics', active: true })).rejects.toThrow();
      await expect(dict.updateEntry(unknown.id, { code: 'easy' })).rejects.toThrow();

      const after = await dict.getEntry(unknown.id);
      expect(after).toMatchObject({ code: '', active: false });

      const physicsAfter = await dict.getEntry(physics.id);
      expect(physicsAfter).toMatchObject({ code: 'physics', label: '物理', active: true });
      const easyAfter = await dict.getEntry(easy.id);
      expect(easyAfter).toMatchObject({ code: 'easy', label: '容易', active: true });
    });

    it('不涉 code 的 patch（label/active）不受守卫影响（ext-contract「激活开关」语义保留）', async () => {
      const { physics } = await seed();
      const updated = await dict.updateEntry(physics.id, { active: false, label: '物理（停用）' });
      expect(updated).toMatchObject({ code: 'physics', label: '物理（停用）', active: false });
    });

    it('指认到非空 code 但 active 未传：code 生效、active 保持原值（守卫只拦 code 指向，不多管）', async () => {
      const { physics, unknown } = await seed();
      const updated = await dict.updateEntry(unknown.id, { code: physics.code });
      expect(updated).toMatchObject({ code: 'physics', active: false });
    });
  });
});
