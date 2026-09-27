// 0004 Phase 5：排版间版式控件区（ComposePage 左控件列）。
// 自上而下：①版式预设选择（内置/我的预设下拉，应用即写控件态、不落库——落库在定稿与存预设）
// ③版式参数区（纸张/栏数+列间距/字号行距字体/页边距/顶部样式/内容显隐 4 开关/作答区/
//   图片排版全局参数/Logo 列表）④操作（存为我的预设/预设导入导出）。
// 预设管理弹层：内置=只读展示（应用可、改不可——服务层守卫）；我的=应用/改名/删除。
// 0018 P2：左栏排距 class 化（9 个 fieldset 内联 0.65rem 退役 → 启用死代码 .ctl-section 并收紧为 8px 档）；
// 预设四操作归堆（顶部「管理」并入底部 layout-actions-section，一处可寻）；左栏裸按钮统一 .btn btn-sm
// 紧凑档（纯观感，testid 与点击行为零变化）。
// file 降级：无 __mofangFile（浏览器 demo）时 Logo 添加走 assetId 文本输入、
// 预设导入走 FileReader、导出走 Blob 下载（Electron 真机走 file.* 通道）。

import { useEffect, useState } from 'react';
import type { ReactNode } from 'react';
import type {
  PaperLayoutConfig, LayoutPreset, PaperHeaderLine, OptionsLayoutMode,
} from '../../shared/contracts/bank-types.js';
import type { ExtPageServices, PageMessage } from './ExtUi.js';
import { Field, Modal } from './ExtUi.js';
import { parseLayoutConfigJson } from '../services/layout-config-validate.js';
import { resolveHeaderLine } from '../../docgen/render/layout.js';
/** 常用印刷字体（值=CSS font-family，与 paper.css 默认变量同形） */
const FONT_OPTIONS: Array<{ label: string; value: string }> = [
  { label: '宋体（默认）', value: "'SimSun', 'STSong', serif" },
  { label: '黑体', value: "'SimHei', sans-serif" },
  { label: '楷体', value: "'KaiTi', 'STKaiti', serif" },
  { label: '仿宋', value: "'FangSong', 'STFangsong', serif" },
];

/** 数值输入（草稿态：输入中不强制解析，失焦/回车提交；清空=提交 undefined 即「未配置」） */
function NumberField({
  value, onCommit, testid, step, min, max, placeholder, width,
}: {
  value: number | undefined;
  onCommit: (next: number | undefined) => void;
  testid?: string;
  step?: number;
  min?: number;
  max?: number;
  placeholder?: string;
  width?: number;
}) {
  const [draft, setDraft] = useState<string | null>(null);
  const display = draft ?? (value === undefined ? '' : String(value));
  const commit = () => {
    if (draft === null) return;
    const text = draft.trim();
    if (text === '') {
      onCommit(undefined);
    } else {
      const v = parseFloat(text);
      if (!isNaN(v)) onCommit(v);
    }
    setDraft(null);
  };
  return (
    <input className="input"
      data-testid={testid}
      type="number"
      step={step}
      min={min}
      max={max}
      value={display}
      placeholder={placeholder}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
      }}
      style={{ width: width ?? 72, padding: '0.2rem 0.35rem' }}
    />
  );
}

/** 缺省展开的分区（其余缺省折叠；0018 目检返工一）。
 *  0063 返工①（2026-09-24 用户目检拍板）：**缺省全折叠**——首次进入排版左栏 9 分区全部收起，
 *  点分区头展开（常挂载仅 hidden：折叠只藏不卸，草稿态与 testid 恒在）。 */
const DEFAULT_OPEN_SECTIONS: string[] = [];

/**
 * 0018 目检返工一：可折叠分区（fieldset + 折叠头 + 体）。
 * 内容**常挂载仅 hidden**——testid 恒在、既有测试与输入草稿态不受折叠影响；
 * aria-expanded 供断言/无障碍。样式见 theme.css 末尾 .ctl-head/.ctl-chev/.ctl-body。
 */
function CtlSection({ id, title, open, onToggle, children }: {
  id: string;
  title: string;
  open: boolean;
  onToggle: (id: string) => void;
  children: ReactNode;
}) {
  return (
    <fieldset data-testid={id} className="ctl-section">
      <button
        type="button"
        className="ctl-head"
        data-testid={`ctl-toggle-${id}`}
        aria-expanded={open}
        onClick={() => onToggle(id)}
      >
        <i className="ctl-chev" aria-hidden="true" />
        <span>{title}</span>
      </button>
      <div className="ctl-body" hidden={!open}>{children}</div>
    </fieldset>
  );
}

export interface ComposeLayoutControlsProps {
  svc: ExtPageServices;
  /** 当前控件态（受控，父级持有） */
  layout: PaperLayoutConfig;
  onChange: (next: PaperLayoutConfig) => void;
  /** done/archived 只读 */
  disabled?: boolean;
  onNotify: (msg: PageMessage | null) => void;
  /** 卷标题（导出文件缺省名用） */
  paperTitle: string;
  /** 递增信号：聚焦「标题文字」输入框（fix-2 F2-D：iframe 标题点编回传，自定义抬头时聚焦此处） */
  headerTitleFocusSignal?: number;
}

export function ComposeLayoutControls({ svc, layout, onChange, disabled, onNotify, paperTitle, headerTitleFocusSignal }: ComposeLayoutControlsProps) {
  const [presets, setPresets] = useState<LayoutPreset[]>([]);
  const [showManage, setShowManage] = useState(false);
  const [showSavePreset, setShowSavePreset] = useState(false);
  const [saveName, setSaveName] = useState('');
  const [renameTarget, setRenameTarget] = useState<LayoutPreset | null>(null);
  const [renameInput, setRenameInput] = useState('');
  const [demoLogoInput, setDemoLogoInput] = useState('');
  // 0018 目检返工一：分区折叠态（缺省 3 开 6 合）
  const [openSections, setOpenSections] = useState<Record<string, boolean>>(
    () => Object.fromEntries(DEFAULT_OPEN_SECTIONS.map((id) => [id, true])),
  );
  const toggleSection = (id: string) => setOpenSections((prev) => ({ ...prev, [id]: !(prev[id] ?? false) }));
  // demo 导入用的隐藏 file input（ref 经 id 取）
  const hasFileBridge = typeof window !== 'undefined' && Boolean(window.__mofangFile);

  // fix-2 F2-D：iframe 标题点编（自定义抬头态）→ 聚焦标题文字输入框
  // 0009：多行自定义模式（lines 已定义）→ 输入框退役，聚焦卷头行编辑器首行
  // 0018 目检返工一：顶部样式分区若折叠先展开，下一拍再聚焦（等折叠体重渲染）
  useEffect(() => {
    const signal = headerTitleFocusSignal ?? 0;
    if (signal > 0) {
      setOpenSections((prev) => ({ ...prev, 'layout-header-section': true }));
      const timer = window.setTimeout(() => {
        const input = document.querySelector('[data-testid="layout-header-title"], [data-testid="header-line-text-0"]');
        if (input) {
          input.scrollIntoView({ block: 'center' });
          (input as HTMLInputElement).focus();
        }
      }, 0);
      return () => window.clearTimeout(timer);
    }
  }, [headerTitleFocusSignal]);

  const reloadPresets = async () => {
    try {
      setPresets(await svc.ext.preset.listPresets());
    } catch (err) {
      onNotify({ type: 'error', text: `预设列表加载失败：${err instanceof Error ? err.message : String(err)}` });
    }
  };

  useEffect(() => {
    void reloadPresets();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const patch = (p: Partial<PaperLayoutConfig>) => onChange({ ...layout, ...p });

  // ---------- 预设 ----------

  const applyPreset = (preset: LayoutPreset) => {
    onChange({ ...preset.config });
    onNotify({ type: 'success', text: `已应用版式预设「${preset.name}」（定稿时落库）` });
  };

  const saveAsPreset = async () => {
    const name = saveName.trim();
    if (!name) {
      onNotify({ type: 'error', text: '预设名称不能为空' });
      return;
    }
    try {
      await svc.ext.preset.createPreset({ name, config: layout });
      setShowSavePreset(false);
      setSaveName('');
      await reloadPresets();
      onNotify({ type: 'success', text: `已保存为我的预设「${name}」` });
    } catch (err) {
      onNotify({ type: 'error', text: `保存预设失败：${err instanceof Error ? err.message : String(err)}` });
    }
  };

  const renamePreset = async () => {
    const target = renameTarget;
    if (!target) return;
    const name = renameInput.trim();
    if (!name) {
      onNotify({ type: 'error', text: '预设名称不能为空' });
      return;
    }
    try {
      await svc.ext.preset.updatePreset(target.id, { name });
      setRenameTarget(null);
      await reloadPresets();
      onNotify({ type: 'success', text: '预设已改名' });
    } catch (err) {
      onNotify({ type: 'error', text: `改名失败：${err instanceof Error ? err.message : String(err)}` });
    }
  };

  const deletePreset = async (preset: LayoutPreset) => {
    try {
      await svc.ext.preset.deletePreset(preset.id);
      await reloadPresets();
      onNotify({ type: 'success', text: `已删除预设「${preset.name}」` });
    } catch (err) {
      // 内置预设删除守卫（服务层抛错）在此可见，不静默
      onNotify({ type: 'error', text: `删除失败：${err instanceof Error ? err.message : String(err)}` });
    }
  };

  // ---------- 预设导入/导出（Electron=file.* 通道；demo=FileReader/Blob 降级） ----------

  const exportPresetFile = async () => {
    const content = JSON.stringify(layout, null, 2);
    const suggestedName = `${paperTitle || '版式预设'}-layout.json`;
    try {
      if (hasFileBridge) {
        const res = await window.__mofangFile!.exportPresetFile({ suggestedName, content });
        onNotify(res.filePath
          ? { type: 'success', text: '版式已导出为预设文件' }
          : { type: 'success', text: '已取消导出' });
        return;
      }
      // demo 降级：Blob 下载
      const blob = new Blob([content], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = suggestedName;
      a.click();
      URL.revokeObjectURL(url);
      onNotify({ type: 'success', text: '版式已导出（浏览器下载）' });
    } catch (err) {
      onNotify({ type: 'error', text: `导出失败：${err instanceof Error ? err.message : String(err)}` });
    }
  };

  const importPresetContent = async (content: string, fileName: string) => {
    // 非法结构报错不静默（任务书 Phase 5 导入校验条款）
    let config: PaperLayoutConfig;
    try {
      config = parseLayoutConfigJson(content);
    } catch (err) {
      onNotify({ type: 'error', text: err instanceof Error ? err.message : String(err) });
      return;
    }
    try {
      const name = fileName.replace(/\.json$/i, '') || '导入预设';
      const preset = await svc.ext.preset.createPreset({ name, config });
      await reloadPresets();
      onNotify({ type: 'success', text: `已导入为我的预设「${preset.name}」，可在下拉中应用` });
    } catch (err) {
      onNotify({ type: 'error', text: `导入失败：${err instanceof Error ? err.message : String(err)}` });
    }
  };

  const importPresetFile = async () => {
    if (hasFileBridge) {
      try {
        const res = await window.__mofangFile!.importPresetFile();
        if (!res) {
          onNotify({ type: 'success', text: '已取消导入' });
          return;
        }
        await importPresetContent(res.content, res.fileName ?? '导入预设.json');
      } catch (err) {
        onNotify({ type: 'error', text: `导入失败：${err instanceof Error ? err.message : String(err)}` });
      }
      return;
    }
    // demo 降级：FileReader
    document.getElementById('mf-demo-preset-import-input')?.click();
  };

  const onDemoImportChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      void importPresetContent(String(reader.result ?? ''), file.name);
    };
    reader.onerror = () => onNotify({ type: 'error', text: '读取文件失败' });
    reader.readAsText(file);
  };

  // ---------- Logo（添加=本地图/截图粘贴；demo 降级=assetId 文本输入） ----------

  const addLogo = (assetId: string, width?: number) => {
    const logos = [...(layout.logos ?? [])];
    logos.push({
      assetId,
      xRatio: 0.06,
      yRatio: 0.05,
      widthRatio: width && width > 0 ? Math.min(0.3, width / 794) : 0.12,
    });
    patch({ logos });
  };

  const pickLogo = async (mode: 'pick' | 'clipboard') => {
    try {
      const asset = mode === 'pick'
        ? await window.__mofangFile!.pickLogoImage()
        : await window.__mofangFile!.readClipboardImage();
      if (!asset) {
        if (mode === 'clipboard') onNotify({ type: 'success', text: '剪贴板中没有图片' });
        return;
      }
      addLogo(asset.relPath, asset.width);
      onNotify({ type: 'success', text: mode === 'pick' ? '已添加本地图片 Logo' : '已添加剪贴板图片 Logo' });
    } catch (err) {
      onNotify({ type: 'error', text: `添加 Logo 失败：${err instanceof Error ? err.message : String(err)}` });
    }
  };

  const patchLogo = (index: number, p: Partial<NonNullable<PaperLayoutConfig['logos']>[number]>) => {
    const logos = [...(layout.logos ?? [])];
    logos[index] = { ...logos[index], ...p };
    patch({ logos });
  };

  const removeLogo = (index: number) => {
    const logos = [...(layout.logos ?? [])];
    logos.splice(index, 1);
    patch({ logos });
  };

  // ---------- 0009：卷头多行自定义（行编辑器；缺省值经归一化同源取显示） ----------

  const headerLines = layout.header?.lines;
  /** lines 已定义 = 多行自定义模式（渲染侧：全空行回退旧三态，见 layout.resolveHeaderLines） */
  const linesMode = headerLines !== undefined;

  const patchHeader = (p: Partial<NonNullable<PaperLayoutConfig['header']>>) =>
    patch({ header: { ...(layout.header ?? {}), ...p } });

  /** 转为多行自定义：以当前标题文字（缺省=卷标题）初始化首行（18pt 居中加粗） */
  const toHeaderLines = () => {
    patchHeader({ lines: [{ text: layout.header?.title ?? paperTitle, sizePt: 18, align: 'center', bold: true }] });
  };

  const patchHeaderLine = (index: number, p: Partial<PaperHeaderLine>) => {
    const lines = [...(layout.header?.lines ?? [])];
    lines[index] = { ...lines[index], ...p };
    patchHeader({ lines });
  };

  /** 新行只写文本占位（字号/对齐/加粗缺省由归一化层按行序落定，UI 不预填） */
  const addHeaderLine = () => patchHeader({ lines: [...(layout.header?.lines ?? []), { text: '' }] });

  const removeHeaderLine = (index: number) => {
    const lines = [...(layout.header?.lines ?? [])];
    lines.splice(index, 1);
    patchHeader({ lines });
  };

  const builtinPresets = presets.filter((p) => p.isBuiltin);
  const userPresets = presets.filter((p) => !p.isBuiltin);

  return (
    <div data-testid="layout-controls" style={{ opacity: disabled ? 0.6 : 1, pointerEvents: disabled ? 'none' : 'auto' }}>
      {/* ① 版式预设（0018 P2：「管理」并入底部版式操作区，四操作归堆一处） */}
      <CtlSection id="preset-section" title="版式预设" open={openSections['preset-section'] ?? false} onToggle={toggleSection}>
        <div style={{ display: 'flex', gap: '0.4rem', flexWrap: 'wrap', alignItems: 'center' }}>
          <select className="select"
            data-testid="layout-preset-select"
            defaultValue=""
            onChange={(e) => {
              const preset = presets.find((p) => p.id === e.target.value);
              if (preset) applyPreset(preset);
              e.target.value = '';
            }}
            style={{ flex: 1, minWidth: 140 }}
          >
            <option value="">选择预设应用…</option>
            {builtinPresets.length > 0 && (
              <optgroup label="内置模板（只读）">
                {builtinPresets.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
              </optgroup>
            )}
            <optgroup label="我的预设">
              {userPresets.length > 0
                ? userPresets.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)
                : <option value="" disabled>（暂无，可「存为我的预设」）</option>}
            </optgroup>
          </select>
        </div>
      </CtlSection>

      {/* ③ 版式参数区 */}
      <CtlSection id="layout-page-section" title="纸张与分栏" open={openSections['layout-page-section'] ?? false} onToggle={toggleSection}>
        <Field label="纸张">
          <select className="select"
            data-testid="layout-page-size"
            value={layout.pageSize ?? 'A4'}
            onChange={(e) => patch({ pageSize: e.target.value as 'A4' | 'A3' })}
          >
            <option value="A4">A4（210×297mm）</option>
            <option value="A3">A3（297×420mm）</option>
          </select>
        </Field>
        <Field label="方向">
          <select className="select"
            data-testid="layout-orientation"
            value={layout.orientation ?? 'portrait'}
            onChange={(e) => patch({ orientation: e.target.value as 'portrait' | 'landscape' })}
          >
            <option value="portrait">纵向</option>
            <option value="landscape">横向（横幅）</option>
          </select>
        </Field>
        <Field label="分栏">
          <select className="select"
            data-testid="layout-columns"
            value={String(layout.columns ?? 1)}
            onChange={(e) => patch({ columns: Number(e.target.value) as 1 | 2 })}
          >
            <option value="1">单栏</option>
            <option value="2">双栏</option>
          </select>
        </Field>
        {(layout.columns ?? 1) === 2 && (
          <Field label="列间距（mm）">
            <NumberField
              testid="layout-column-gap"
              value={layout.columnGapMm}
              min={0}
              max={40}
              onCommit={(v) => patch({ columnGapMm: v })}
            />
          </Field>
        )}
      </CtlSection>

      <CtlSection id="layout-type-section" title="文字" open={openSections['layout-type-section'] ?? false} onToggle={toggleSection}>
        <Field label={`字号（pt）：${layout.fontSize ?? 12}`}>
          <NumberField
            testid="layout-font-size"
            value={layout.fontSize}
            min={6}
            max={36}
            onCommit={(v) => patch({ fontSize: v })}
          />
        </Field>
        <Field label="行距">
          <NumberField
            testid="layout-line-height"
            value={layout.lineHeight}
            step={0.1}
            min={1}
            max={3}
            placeholder="默认（1.8）"
            onCommit={(v) => patch({ lineHeight: v })}
          />
        </Field>
        <Field label="字体">
          <select className="select"
            data-testid="layout-font-family"
            value={layout.fontFamily ?? FONT_OPTIONS[0].value}
            onChange={(e) => patch({ fontFamily: e.target.value })}
          >
            {FONT_OPTIONS.map((f) => <option key={f.value} value={f.value}>{f.label}</option>)}
          </select>
        </Field>
        <Field label="页边距（mm，上/右/下/左）">
          <div style={{ display: 'flex', gap: '0.3rem' }}>
            <NumberField testid="layout-margin-top" value={layout.pageMarginMm?.top} min={0} max={100} onCommit={(v) => patch({ pageMarginMm: { ...(layout.pageMarginMm ?? { top: 20, right: 15, bottom: 20, left: 15 }), top: v ?? 20 } })} />
            <NumberField testid="layout-margin-right" value={layout.pageMarginMm?.right} min={0} max={100} onCommit={(v) => patch({ pageMarginMm: { ...(layout.pageMarginMm ?? { top: 20, right: 15, bottom: 20, left: 15 }), right: v ?? 15 } })} />
            <NumberField testid="layout-margin-bottom" value={layout.pageMarginMm?.bottom} min={0} max={100} onCommit={(v) => patch({ pageMarginMm: { ...(layout.pageMarginMm ?? { top: 20, right: 15, bottom: 20, left: 15 }), bottom: v ?? 20 } })} />
            <NumberField testid="layout-margin-left" value={layout.pageMarginMm?.left} min={0} max={100} onCommit={(v) => patch({ pageMarginMm: { ...(layout.pageMarginMm ?? { top: 20, right: 15, bottom: 20, left: 15 }), left: v ?? 15 } })} />
          </div>
        </Field>
      </CtlSection>

      <CtlSection id="layout-header-section" title="顶部样式" open={openSections['layout-header-section'] ?? false} onToggle={toggleSection}>
        <Field label="样式">
          <select className="select"
            data-testid="layout-header-style"
            value={layout.header?.style ?? 'exam'}
            onChange={(e) => patch({ header: { ...(layout.header ?? {}), style: e.target.value as 'simple' | 'exam' | 'none' } })}
          >
            <option value="exam">考试头（标题+总分时长）</option>
            <option value="simple">仅标题</option>
            <option value="none">无</option>
          </select>
        </Field>
        <Field label="标题文字（缺省=卷标题）">
          {linesMode ? (
            <div data-testid="header-lines-editor">
              <p style={{ color: 'var(--ink-3)', margin: '0 0 0.4rem', fontSize: '0.85rem' }}>
                多行自定义：逐行编辑内容/字号/对齐/加粗（字号缺省=首行 18pt、其余 11pt）；「样式」选「无」则整段不输出
              </p>
              {(layout.header?.lines ?? []).map((line, i) => {
                // 显示缺省与渲染同源（归一化层落定），存储侧仍保持「未配置=undefined」
                const shown = resolveHeaderLine(line, i);
                return (
                  <div
                    key={`header-line-${i}`}
                    data-testid={`header-line-row-${i}`}
                    style={{ border: '1px solid var(--line)', borderRadius: '4px', padding: '0.4rem', marginBottom: '0.4rem' }}
                  >
                    <input className="input"
                      data-testid={`header-line-text-${i}`}
                      value={line.text}
                      placeholder={i === 0 ? paperTitle : '文本'}
                      onChange={(e) => patchHeaderLine(i, { text: e.target.value })}
                      style={{ width: '100%', padding: '0.2rem 0.35rem', marginBottom: '0.3rem' }}
                    />
                    <div style={{ display: 'flex', gap: '0.5rem', alignItems: 'center', flexWrap: 'wrap', fontSize: '0.85rem' }}>
                      <label>
                        字号{' '}
                        <NumberField
                          testid={`header-line-size-${i}`}
                          value={shown.sizePt}
                          min={6}
                          max={72}
                          width={64}
                          onCommit={(v) => patchHeaderLine(i, { sizePt: v })}
                        />
                      </label>
                      <label>
                        对齐{' '}
                        <select className="select"
                          data-testid={`header-line-align-${i}`}
                          value={shown.align}
                          onChange={(e) => patchHeaderLine(i, { align: e.target.value as 'left' | 'center' | 'right' })}
                        >
                          <option value="left">左</option>
                          <option value="center">居中</option>
                          <option value="right">右</option>
                        </select>
                      </label>
                      <label>
                        <input className="input"
                          type="checkbox"
                          data-testid={`header-line-bold-${i}`}
                          checked={shown.bold}
                          onChange={(e) => patchHeaderLine(i, { bold: e.target.checked })}
                        />
                        {' '}加粗
                      </label>
                      <button
                        className="btn btn-sm"
                        data-testid={`header-line-remove-${i}`}
                        onClick={() => removeHeaderLine(i)}
                        style={{ color: 'var(--brick)' }}
                      >
                        删除
                      </button>
                    </div>
                  </div>
                );
              })}
              <button className="btn btn-sm" data-testid="header-line-add-btn" onClick={addHeaderLine}>+ 添加行</button>
            </div>
          ) : (
            <>
              <input className="input"
                data-testid="layout-header-title"
                value={layout.header?.title ?? ''}
                placeholder={paperTitle}
                onChange={(e) => patchHeader({ title: e.target.value || undefined })}
                style={{ width: '100%', padding: '0.2rem 0.35rem' }}
              />
              <div style={{ marginTop: '0.35rem' }}>
                <button className="btn btn-sm" data-testid="header-to-lines-btn" onClick={toHeaderLines}>转为多行自定义</button>
              </div>
            </>
          )}
        </Field>
      </CtlSection>

      <CtlSection id="layout-visibility-section" title="内容显隐" open={openSections['layout-visibility-section'] ?? false} onToggle={toggleSection}>
        {([
          ['questionNo', '题号'],
          ['score', '分值'],
          ['answer', '答案'],
          ['analysis', '解析'],
        ] as const).map(([key, label]) => (
          <label key={key} style={{ display: 'block', marginBottom: '0.25rem' }}>
            <input className="input"
              type="checkbox"
              data-testid={`layout-vis-${key}`}
              checked={layout.fieldVisibility?.[key] !== false}
              onChange={(e) => patch({ fieldVisibility: { ...(layout.fieldVisibility ?? {}), [key]: e.target.checked } })}
            />
            {' '}{label}
          </label>
        ))}
      </CtlSection>

      {/* 0004-fix-4 #6（目检 #6）：全局作答区控件组已删除——作答区只留题级（无/空白/横线+行数），
          题卡内的 QuestionAnswerSpaceControl 承担；卷级 config.answerSpace 字段保留仅为存量数据兼容
          （引擎回落语义不变），UI 不再暴露。 */}

      {/* 0013：选择题选项版式卷级默认档（缺省 auto=竖排；单题可在预览操作条覆盖） */}
      <CtlSection id="layout-options-section" title="选项版式（选择题）" open={openSections['layout-options-section'] ?? false} onToggle={toggleSection}>
        <Field label="排列">
          <select className="select"
            data-testid="layout-options-layout"
            value={layout.optionsLayout ?? 'auto'}
            onChange={(e) => patch({ optionsLayout: e.target.value as OptionsLayoutMode })}
          >
            <option value="auto">自动（竖排）</option>
            <option value="single-line">单行横排</option>
            <option value="two-lines">两行均分</option>
          </select>
        </Field>
      </CtlSection>

      <CtlSection id="layout-figure-section" title="图片排版（全局）" open={openSections['layout-figure-section'] ?? false} onToggle={toggleSection}>
        <Field label="版式">
          <select className="select"
            data-testid="layout-figure-mode"
            value={layout.figureLayout?.mode ?? 'inline'}
            onChange={(e) => patch({ figureLayout: { ...(layout.figureLayout ?? {}), mode: e.target.value as 'inline' | 'side-by-side' } })}
          >
            <option value="inline">单独成行（插在文中）</option>
            <option value="side-by-side">图文并排（文左图右）</option>
          </select>
        </Field>
        {(layout.figureLayout?.mode ?? 'inline') === 'inline' && (
          <Field label="对齐">
            <select className="select"
              data-testid="layout-figure-align"
              value={layout.figureLayout?.align ?? 'center'}
              onChange={(e) => patch({ figureLayout: { ...(layout.figureLayout ?? {}), align: e.target.value as 'left' | 'center' | 'right' } })}
            >
              <option value="left">左</option>
              <option value="center">居中</option>
              <option value="right">右</option>
            </select>
          </Field>
        )}
        <Field label="图宽（版心%，空=默认档 min(原宽,60%)）">
          <NumberField
            testid="layout-figure-width"
            value={layout.figureLayout?.widthPercent}
            min={5}
            max={100}
            placeholder="默认档"
            onCommit={(v) => patch({ figureLayout: { ...(layout.figureLayout ?? {}), widthPercent: v } })}
          />
        </Field>
      </CtlSection>

      <CtlSection id="layout-logo-section" title="Logo" open={openSections['layout-logo-section'] ?? false} onToggle={toggleSection}>
        {hasFileBridge ? (
          <div style={{ display: 'flex', gap: '0.4rem', marginBottom: '0.5rem', flexWrap: 'wrap' }}>
            <button className="btn btn-sm" data-testid="logo-add-pick-btn" onClick={() => void pickLogo('pick')}>选择本地图片…</button>
            <button className="btn btn-sm" data-testid="logo-add-clipboard-btn" onClick={() => void pickLogo('clipboard')}>粘贴剪贴板截图</button>
          </div>
        ) : (
          <div style={{ marginBottom: '0.5rem' }}>
            <p style={{ color: 'var(--ink-3)', margin: '0 0 0.3rem', fontSize: '0.85rem' }}>
              本地图片/剪贴板仅 Electron 应用可用；演示环境可粘贴题库图片 assetId（如 capture/xxx.png）
            </p>
            <div style={{ display: 'flex', gap: '0.4rem' }}>
              <input className="input"
                data-testid="logo-add-demo-input"
                value={demoLogoInput}
                placeholder="粘贴 assetId"
                onChange={(e) => setDemoLogoInput(e.target.value)}
                style={{ flex: 1, padding: '0.2rem 0.35rem' }}
              />
              <button
                className="btn btn-sm"
                data-testid="logo-add-demo-btn"
                onClick={() => {
                  const id = demoLogoInput.trim().replace(/^data-assets\//, '');
                  if (!id) {
                    onNotify({ type: 'error', text: '请粘贴图片 assetId' });
                    return;
                  }
                  addLogo(id);
                  setDemoLogoInput('');
                }}
              >
                添加
              </button>
            </div>
          </div>
        )}
        {(layout.logos ?? []).length === 0 ? (
          <p style={{ color: 'var(--ink-3)', margin: 0, fontSize: '0.85rem' }}>暂无 Logo</p>
        ) : (
          (layout.logos ?? []).map((logo, i) => (
            <div
              key={`${logo.assetId}-${i}`}
              data-testid={`logo-row-${i}`}
              style={{ border: '1px solid var(--line)', borderRadius: '4px', padding: '0.4rem', marginBottom: '0.4rem', fontSize: '0.85rem' }}
            >
              <div style={{ marginBottom: '0.25rem', wordBreak: 'break-all' }}>{logo.assetId}</div>
              <div style={{ display: 'flex', gap: '0.5rem', alignItems: 'center', flexWrap: 'wrap' }}>
                <label>x <NumberField testid={`logo-x-${i}`} value={logo.xRatio} step={0.01} min={0} max={1} width={64} onCommit={(v) => patchLogo(i, { xRatio: v ?? 0 })} /></label>
                <label>y <NumberField testid={`logo-y-${i}`} value={logo.yRatio} step={0.01} min={0} max={1} width={64} onCommit={(v) => patchLogo(i, { yRatio: v ?? 0 })} /></label>
                <label>宽 <NumberField testid={`logo-w-${i}`} value={logo.widthRatio} step={0.01} min={0} max={1} width={64} onCommit={(v) => patchLogo(i, { widthRatio: v ?? 0.12 })} /></label>
                <button className="btn btn-sm" data-testid={`logo-remove-${i}`} onClick={() => removeLogo(i)} style={{ color: 'var(--brick)' }}>删除</button>
              </div>
            </div>
          ))
        )}
      </CtlSection>

      {/* ④ 操作（0018 P2：预设四操作归堆一处——「管理」自顶部并入） */}
      <CtlSection id="layout-actions-section" title="版式操作" open={openSections['layout-actions-section'] ?? false} onToggle={toggleSection}>
        <div style={{ display: 'flex', gap: '0.4rem', flexWrap: 'wrap' }}>
          <button className="btn btn-sm" data-testid="preset-manage-btn" onClick={() => setShowManage(true)}>管理</button>
          <button className="btn btn-sm" data-testid="preset-save-btn" onClick={() => { setSaveName(''); setShowSavePreset(true); }}>存为我的预设</button>
          <button className="btn btn-sm" data-testid="preset-import-btn" onClick={() => void importPresetFile()}>导入预设文件</button>
          <button className="btn btn-sm" data-testid="preset-export-btn" onClick={() => void exportPresetFile()}>导出当前版式</button>
        </div>
        {!hasFileBridge && (
          <input className="input"
            id="mf-demo-preset-import-input"
            type="file"
            accept=".json,application/json"
            style={{ display: 'none' }}
            onChange={onDemoImportChange}
          />
        )}
      </CtlSection>

      {/* 存为我的预设（命名弹层） */}
      {showSavePreset && (
        <Modal title="存为我的预设" onClose={() => setShowSavePreset(false)}>
          <Field label="预设名称">
            <input className="input"
              data-testid="preset-save-input"
              value={saveName}
              onChange={(e) => setSaveName(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && void saveAsPreset()}
              autoFocus
              style={{ width: '100%', padding: '0.35rem' }}
            />
          </Field>
          <div style={{ display: 'flex', gap: '0.5rem', justifyContent: 'flex-end' }}>
            <button className="btn btn-sm" onClick={() => setShowSavePreset(false)}>取消</button>
            <button className="btn btn-sm btn-primary" data-testid="preset-save-confirm" onClick={() => void saveAsPreset()}>保存</button>
          </div>
        </Modal>
      )}

      {/* 预设管理（内置只读；我的=应用/改名/删除） */}
      {showManage && (
        <Modal title="版式预设管理" onClose={() => setShowManage(false)}>
          <div style={{ minWidth: '420px' }}>
            <h3 style={{ margin: '0 0 0.4rem', fontSize: '1rem' }}>内置模板（只读，应用可、改不可）</h3>
            {builtinPresets.length === 0 && <p style={{ color: 'var(--ink-3)' }}>无</p>}
            {builtinPresets.map((p) => (
              <div key={p.id} data-testid={`preset-row-${p.id}`} style={{ display: 'flex', gap: '0.5rem', alignItems: 'center', padding: '0.3rem 0', borderBottom: '1px solid var(--line)' }}>
                <strong>{p.name}</strong>
                <span style={{ color: 'var(--ink-3)', fontSize: '0.85rem' }}>
                  {p.config.pageSize ?? 'A4'} · {p.config.columns ?? 1} 栏
                </span>
                <span style={{ flex: 1 }} />
                <button className="btn btn-sm" data-testid={`preset-apply-${p.id}`} onClick={() => { applyPreset(p); setShowManage(false); }}>应用</button>
              </div>
            ))}
            <h3 style={{ margin: '0.8rem 0 0.4rem', fontSize: '1rem' }}>我的预设</h3>
            {userPresets.length === 0 && <p style={{ color: 'var(--ink-3)' }}>暂无，用「存为我的预设」保存当前版式</p>}
            {userPresets.map((p) => (
              <div key={p.id} data-testid={`preset-row-${p.id}`} style={{ display: 'flex', gap: '0.5rem', alignItems: 'center', padding: '0.3rem 0', borderBottom: '1px solid var(--line)' }}>
                <strong>{p.name}</strong>
                <span style={{ flex: 1 }} />
                <button className="btn btn-sm" data-testid={`preset-apply-${p.id}`} onClick={() => { applyPreset(p); setShowManage(false); }}>应用</button>
                <button className="btn btn-sm" data-testid={`preset-rename-${p.id}`} onClick={() => { setRenameInput(p.name); setRenameTarget(p); }}>改名</button>
                <button className="btn btn-sm" data-testid={`preset-delete-${p.id}`} onClick={() => void deletePreset(p)} style={{ color: 'var(--brick)' }}>删除</button>
              </div>
            ))}
            <div style={{ marginTop: '0.75rem', textAlign: 'right' }}>
              <button className="btn btn-sm" onClick={() => setShowManage(false)}>关闭</button>
            </div>
          </div>
        </Modal>
      )}

      {/* 改名弹层 */}
      {renameTarget && (
        <Modal title="预设改名" onClose={() => setRenameTarget(null)}>
          <Field label="新名称">
            <input className="input"
              data-testid="preset-rename-input"
              value={renameInput}
              onChange={(e) => setRenameInput(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && void renamePreset()}
              autoFocus
              style={{ width: '100%', padding: '0.35rem' }}
            />
          </Field>
          <div style={{ display: 'flex', gap: '0.5rem', justifyContent: 'flex-end' }}>
            <button className="btn btn-sm" onClick={() => setRenameTarget(null)}>取消</button>
            <button className="btn btn-sm btn-primary" data-testid="preset-rename-confirm" onClick={() => void renamePreset()}>确定</button>
          </div>
        </Modal>
      )}
    </div>
  );
}
