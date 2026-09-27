/**
 * --smoke-feedback030：0030 反馈模块一期真机验收（Electron 模式）
 *
 * 上半场（主进程侧，真 SQLite + 迁移 0010 已应用）：
 *   内置提示词模板两条可见且只读 → 记录两态落库往返（快速=student_id NULL / 批量=关联）→ 筛选与删除。
 *
 * 下半场（真渲染页，**本次白屏事故的回归**）：
 *   用真 preload 起一个隐藏窗口加载 dist/renderer/index.html（=应用同一渲染环境，共享 localStorage），
 *   注入「上一版形态的批量草稿」（行里没有返工轮二新增的 extras 字段）→ 进 #/feedback →
 *   断言：渲染期零未捕获异常、反馈页正常出现（不是白屏、也没落到错误兜底页）、旧草稿被升级接纳且可用。
 *   修复前此现场必然白屏（TypeError: Cannot read properties of undefined (reading 'map')）。
 *
 * 运行：npm run build && node scripts/smoke-feedback030.mjs（退出码 0/1 透传）
 */

import { app, BrowserWindow } from 'electron';
import { join } from 'node:path';
import type { BankExtServices } from '../shared/contracts/bank-types.js';

/** 上一版（返工轮一）写入的草稿形态：行里只有 selected/score/note/tags（没有返工轮二的 extras） */
function legacyDraft(classId: string, rows: Record<string, unknown>): string {
  return JSON.stringify({
    savedAt: '2026-09-22T09:00:00Z',
    classId,
    examId: '',
    content: '旧内容：欧姆定律',
    homework: '旧作业',
    style: { tone: 'warm', length: 'medium', familyAdvice: true },
    promptTemplateId: '',
    offlineTemplateId: '',
    rows,
    cards: [],
  });
}

export async function runFeedback030Smoke(extServices: BankExtServices): Promise<void> {
  const driver = new BrowserWindow({
    show: false,
    width: 1280,
    height: 900,
    webPreferences: {
      preload: join(process.cwd(), 'dist', 'shell', 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });
  const consoleErrors: string[] = [];
  driver.webContents.on('console-message', (...args: unknown[]) => {
    const first = args[0] as { level?: unknown; message?: unknown } | undefined;
    const level = first && typeof first.level !== 'undefined' ? first.level : args[1];
    const message = first && typeof first.message === 'string' ? first.message : String(args[2] ?? '');
    if (level === 'error' || level === 3 || level === '3') consoleErrors.push(message);
  });

  try {
    // ---------- 上半场：真 SQLite 数据面 ----------
    const prompts = await extServices.feedbackPrompt.listTemplates();
    const builtins = prompts.filter((t) => t.isBuiltin).map((t) => t.name);
    if (!builtins.includes('通用课后反馈') || !builtins.includes('考后成绩反馈')) {
      throw new Error(`内置提示词模板不可见: ${JSON.stringify(builtins)}`);
    }
    const builtin = prompts.find((t) => t.isBuiltin)!;
    for (const slot of ['{课程主题}', '{课堂内容}', '{备注}', '{语气}', '{篇幅}']) {
      if (!builtin.body.includes(slot)) throw new Error(`内置正文缺槽位 ${slot}`);
    }
    let guarded = false;
    try { await extServices.feedbackPrompt.updateTemplate(builtin.id, { body: 'x' }); } catch { guarded = true; }
    if (!guarded) throw new Error('内置提示词模板 update 未拒绝');

    const batch = await extServices.feedbackRecord.createRecord({
      studentId: 'smoke-stu', studentName: 'smoke-陈小明', classId: 'smoke-cls', examId: 'smoke-exam',
      channel: 'ai', promptTemplateId: builtin.id, promptSnapshot: builtin.body, modelProfileId: 'smoke-profile',
      inputJson: JSON.stringify({ 课程主题: '欧姆定律', 课堂内容: 'I=U/R', 课堂表现: ['专注'], 课后任务: 'P45', 成绩: '82分', 备注: '' }),
      body: 'smoke-正文（批量态）',
    });
    const quick = await extServices.feedbackRecord.createRecord({
      studentName: 'smoke-刘一凡', channel: 'offline',
      inputJson: JSON.stringify({ 课程主题: '', 课堂内容: '牛顿第二定律', 课堂表现: [], 课后任务: '', 成绩: '', 备注: '' }),
      body: 'smoke-正文（快速留痕）',
    });
    const batchBack = await extServices.feedbackRecord.getRecord(batch.id);
    const quickBack = await extServices.feedbackRecord.getRecord(quick.id);
    if (batchBack?.studentId !== 'smoke-stu' || batchBack.promptSnapshot !== builtin.body) {
      throw new Error('批量态往返不一致');
    }
    if (quickBack?.studentId !== null || quickBack.classId !== null) throw new Error('快速态应为未关联（student_id NULL）');
    const byClass = await extServices.feedbackRecord.listRecords({ classId: 'smoke-cls' });
    if (byClass.length !== 1 || byClass[0]!.id !== batch.id) throw new Error('班级筛选不正确');
    await extServices.feedbackRecord.deleteRecord(quick.id);
    if ((await extServices.feedbackRecord.listRecords()).some((r) => r.id === quick.id)) {
      throw new Error('删除后仍可见');
    }

    const smokeClass = await extServices.class.createClass({ name: 'smoke-初二（3）班' });
    const legacyStudents: string[] = [];
    for (const name of ['smoke-陈小明', 'smoke-李思颖']) {
      const student = await extServices.student.createStudent({ name });
      await extServices.student.enrollStudent(student.id, smokeClass.id);
      legacyStudents.push(student.id);
    }
    const legacyRows = Object.fromEntries(legacyStudents.map((id) => (
      [id, { selected: true, score: '80', note: '旧备注', tags: ['专注'] }] // 注意：没有 extras 字段
    )));

    // ---------- 下半场：真渲染页 + 旧形态草稿（白屏回归） ----------
    await driver.loadFile(join(process.cwd(), 'dist', 'renderer', 'index.html'));
    await driver.webContents.executeJavaScript(`
      localStorage.setItem('mofang-feedback-batch-draft-v1', ${JSON.stringify(legacyDraft(smokeClass.id, legacyRows))});
      localStorage.removeItem('mofang-feedback-perf-tags-v1');
      location.hash = '#/feedback';
      location.reload();
      'seeded';
    `);
    await new Promise<void>((resolve) => {
      driver.webContents.once('did-finish-load', () => resolve());
      setTimeout(resolve, 15000);
    });
    await new Promise((resolve) => setTimeout(resolve, 2000));

    const probe = await driver.webContents.executeJavaScript(`
      (() => {
        const err = document.querySelector('[data-testid="fb-page-error"]');
        const pageOk = Boolean(document.querySelector('[data-testid="fb-quick-name"]')
          || document.querySelector('[data-testid="fb-batch-content"]')
          || document.querySelector('[data-testid="fb-tab-quick"]'));
        return {
          hasErrorBoundary: Boolean(err),
          errorText: err ? err.textContent : null,
          pageOk,
          draftBanner: Boolean(document.querySelector('[data-testid="fb-batch-draft-banner"]')),
          tabs: document.querySelectorAll('[data-testid^="fb-tab-"]').length,
          rows: document.querySelectorAll('[data-testid^="fb-batch-row-"]').length,
          legacyTagChip: Boolean(document.querySelector('[data-testid="fb-batch-perf-${legacyStudents[0]}-专注"]')),
          legacyExtra: Boolean(document.querySelector('[data-testid="fb-batch-extra-${legacyStudents[0]}-0"]')),
          content: (document.querySelector('[data-testid="fb-batch-content"]') || {}).value || null,
          bodyText: (document.body.innerText || '').slice(0, 100).replace(/\\s+/g, ' '),
        };
      })()
    `);

    if (consoleErrors.length > 0) throw new Error(`渲染期出现未捕获异常: ${consoleErrors.slice(0, 2).join(' | ')}`);
    if (!probe.pageOk) throw new Error(`反馈页未正常渲染（白屏？）: ${JSON.stringify(probe)}`);
    if (probe.hasErrorBoundary) throw new Error(`落到错误兜底页（本应修复）: ${probe.errorText}`);
    if (!probe.draftBanner) throw new Error('旧形态草稿未被升级接纳（横幅缺失）');
    if (probe.tabs < 4) throw new Error(`页签不齐: ${probe.tabs}`);
    if (probe.rows !== 2) throw new Error(`旧草稿的名单行未渲染: ${probe.rows}`);
    if (probe.content !== '旧内容：欧姆定律') throw new Error(`旧草稿内容未恢复: ${probe.content}`);
    if (!probe.legacyTagChip) throw new Error('旧行的标签未保留');
    if (probe.legacyExtra) throw new Error('旧行不应有一次性表现条目（升级后应为空）');

    // 旧行照常可用：加一条一次性表现 → 生成两张卡（真页面、真桥、真服务）
    const generated = await driver.webContents.executeJavaScript(`
      (async () => {
        document.querySelector('[data-testid="fb-batch-extra-add-${legacyStudents[0]}"]').click();
        await new Promise((r) => setTimeout(r, 60));
        const input = document.querySelector('[data-testid="fb-batch-extra-input-${legacyStudents[0]}"]');
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, '今天状态不错');
        input.dispatchEvent(new Event('input', { bubbles: true }));
        input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
        await new Promise((r) => setTimeout(r, 80));
        const added = Boolean(document.querySelector('[data-testid="fb-batch-extra-${legacyStudents[0]}-0"]'));
        document.querySelector('[data-testid="fb-batch-generate"]').click();
        for (let i = 0; i < 100; i += 1) {
          await new Promise((r) => setTimeout(r, 100));
          const cards = document.querySelectorAll('[data-testid^="fb-batch-card-text-"]');
          if (cards.length === 2 && Array.from(cards).every((c) => !c.disabled)) break;
        }
        const cards = Array.from(document.querySelectorAll('[data-testid^="fb-batch-card-text-"]'));
        return { added, cardCount: cards.length, firstText: cards[0] ? cards[0].value.slice(0, 60) : '' };
      })()
    `);
    if (!generated.added) throw new Error('旧行无法新增一次性表现');
    if (generated.cardCount !== 2) throw new Error(`旧草稿行未生成卡片: ${generated.cardCount}`);
    if (!generated.firstText.includes('欧姆定律')) throw new Error(`首页卡片内容异常: ${generated.firstText}`);
    if (consoleErrors.length > 0) throw new Error(`生成后出现未捕获异常: ${consoleErrors.slice(0, 2).join(' | ')}`);

    // 反馈设置页：主从结构（左侧选中一条 → 右侧只展开那一项）——第三轮返工的真机验证
    const settingsProbe = await driver.webContents.executeJavaScript(`
      (async () => {
        document.querySelector('[data-testid="fb-tab-settings"]').click();
        await new Promise((r) => setTimeout(r, 200));
        const panels = () => ({
          prompt: Boolean(document.querySelector('[data-testid="fb-prompt-body"]')),
          offline: Boolean(document.querySelector('[data-testid="feedback-template-body-input"]')),
          tag: Boolean(document.querySelector('[data-testid="fb-settings-panel-tag"]')),
        });
        const first = panels();
        const offlineRow = document.querySelector('[data-testid="feedback-template-row-feedback-tpl-builtin-default"]')
          || document.querySelector('[data-testid^="feedback-template-row-"]');
        offlineRow.click();
        await new Promise((r) => setTimeout(r, 200));
        const second = panels();
        const tagsEntry = document.querySelector('[data-testid="fb-settings-tags-entry"]');
        tagsEntry.click();
        await new Promise((r) => setTimeout(r, 200));
        const third = panels();
        // 左侧只有「课堂表现标签」一个入口：标签行全部在右侧面板里（左栏不含标签行）
        const tagPanel = document.querySelector('[data-testid="fb-settings-panel-tag"]');
        const rowsInPanel = tagPanel ? tagPanel.querySelectorAll('[data-testid^="fb-tag-row-"]').length : 0;
        const allTagRows = document.querySelectorAll('[data-testid^="fb-tag-row-"]').length;
        const builtinTagReadOnly = !document.querySelector('[data-testid="fb-tag-edit-专注"]')
          && !document.querySelector('[data-testid="fb-tag-del-专注"]')
          && Boolean(document.querySelector('[data-testid="fb-tag-row-专注"]'));
        const hasNewForm = Boolean(document.querySelector('[data-testid="fb-tag-new-input"]'));
        return { first, second, third, builtinTagReadOnly, rowsInPanel, allTagRows, hasNewForm };
      })()
    `);
    const onlyOnePanel = (p: { prompt: boolean; offline: boolean; tag: boolean }): number =>
      [p.prompt, p.offline, p.tag].filter(Boolean).length;
    if (!settingsProbe.first.prompt || onlyOnePanel(settingsProbe.first) !== 1) {
      throw new Error(`设置页初始应只展开提示词面板: ${JSON.stringify(settingsProbe.first)}`);
    }
    if (!settingsProbe.second.offline || onlyOnePanel(settingsProbe.second) !== 1) {
      throw new Error(`设置页选中离线模板后应只展开离线面板: ${JSON.stringify(settingsProbe.second)}`);
    }
    if (!settingsProbe.third.tag || onlyOnePanel(settingsProbe.third) !== 1) {
      throw new Error(`设置页选中标签后应只展开标签面板: ${JSON.stringify(settingsProbe.third)}`);
    }
    if (!settingsProbe.builtinTagReadOnly) throw new Error('内置标签行应为只读（无编辑/删除）');
    if (settingsProbe.rowsInPanel !== settingsProbe.allTagRows || settingsProbe.allTagRows < 7) {
      throw new Error(`标签行应全部在右侧面板内（面板 ${settingsProbe.rowsInPanel} / 全页 ${settingsProbe.allTagRows}）`);
    }
    if (!settingsProbe.hasNewForm) throw new Error('标签面板缺新增表单');
    // 提示词模板「先建再填」：＋新建 → 右侧空表单（未落库）→ 填完点「新建」才入库
    const newPromptProbe = await driver.webContents.executeJavaScript(`
      (async () => {
        // React 受控输入必须走原生 setter + input 事件（直接赋 .value 不会被 onChange 接住）
        const setValue = (el, value) => {
          const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
          Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, value);
          el.dispatchEvent(new Event('input', { bubbles: true }));
        };
        document.querySelector('[data-testid="fb-prompt-new"]').click();
        await new Promise((r) => setTimeout(r, 200));
        const nameInput = document.querySelector('[data-testid="fb-prompt-name"]');
        const bodyInput = document.querySelector('[data-testid="fb-prompt-body"]');
        const formShown = Boolean(nameInput) && Boolean(document.querySelector('[data-testid="fb-prompt-create"]'));
        const emptyBefore = formShown && nameInput.value === '';
        const hasSave = Boolean(document.querySelector('[data-testid="fb-prompt-save"]'));
        setValue(nameInput, 'smoke-先建再填');
        setValue(bodyInput, '给学生{学生姓名}写反馈：{课堂内容}');
        await new Promise((r) => setTimeout(r, 80));
        document.querySelector('[data-testid="fb-prompt-create"]').click();
        for (let i = 0; i < 50; i += 1) {
          await new Promise((r) => setTimeout(r, 100));
          if (document.querySelector('[data-testid="fb-prompt-save"]')) break;
        }
        const items = Array.from(document.querySelectorAll('[data-testid^="fb-prompt-item-"]')).map((el) => el.textContent);
        const listed = items.some((text) => text.includes('smoke-先建再填'));
        return {
          formShown, emptyBefore, hasSave, listed,
          items,
          nameAfter: nameInput.value,
          bodyAfter: bodyInput.value.slice(0, 20),
          message: (document.querySelector('[data-testid="page-message"]') || {}).textContent || null,
        };
      })()
    `);
    if (!newPromptProbe.formShown || !newPromptProbe.emptyBefore) {
      throw new Error(`「＋新建提示词模板」应先出空表单（先建再填）: ${JSON.stringify(newPromptProbe)}`);
    }
    if (newPromptProbe.hasSave) throw new Error('新建态不应出现「保存」按钮');
    if (!newPromptProbe.listed) throw new Error(`新建的提示词模板未入左侧列表: ${JSON.stringify(newPromptProbe)}`);
    if (consoleErrors.length > 0) throw new Error(`设置页操作后出现未捕获异常: ${consoleErrors.slice(0, 2).join(' | ')}`);

    driver.close();
    console.log('OK   smoke-feedback030（Electron）通过：内置提示词两条可见+只读（10 槽位）→ 记录两态往返（批量关联 / 快速 student_id NULL）+ 班级筛选 + 删除不可见（真 SQLite）→ 真渲染页加载【上一版形态的批量草稿】：零未捕获异常、反馈页正常（非白屏/非兜底页）、草稿被升级接纳（横幅 + 名单 2 行 + 旧标签在、一次性区为空）、旧行可加表现并生成 2 张卡（真 preload + 真桥）→ 反馈设置页主从结构：默认只展开提示词面板、点离线模板只展开离线面板、点「课堂表现标签」入口只展开标签管理面板（全部标签都在右侧面板里、含新增表单，内置标签只读）；另验提示词模板「先建再填」');
    app.exit(0);
  } catch (err) {
    console.error('FAIL smoke-feedback030（Electron）失败:', err);
    driver.close();
    app.exit(1);
  }
}
