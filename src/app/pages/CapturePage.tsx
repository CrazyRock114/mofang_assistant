// D1 P2: 采集面板 — 主窗内控制独立采集窗口（开/关/快捷导航/状态轮询）+ 试题篮提取预览 + 入库回显
// 公式渲染复用 buildPaperHtml.core renderMath（与 C1 校对页同源）；图走 rewriteDataAssetSrcs 资产根解析
// 合规红线：本面板不自动登录/找题/加篮，登录与加篮均由用户在采集窗口手动完成
// 0004-fix-1 D 组：解析 hash 的 toBasket（篮详情「从网络采集」带目标篮）→ 入库成功后按 okIds
//   逐个 addQuestion 进目标篮（先 getPaperQuestions 过滤已在篮，逐题容错）；无 toBasket 时行为不变，
//   但存在处理中卷则给「同时加入当前试题篮」勾选项（勾上后下次入库同样联动）。
// 0011 §一.6 采集页多篮/返回改版：
//   - toBasket 进入：横幅常显「目标试题篮：<标题>」（装载失败=报错并回 #/basket）；主按钮
//     「加入当前试题篮（同步入库）」（collect 入库+挂篮一步完成）；勾选框在 toBasket 场景移除（默认挂篮）。
//   - 无 toBasket 三态：0 张处理中→无勾选；恰 1 张→沿用现勾选逻辑；多张→目标下拉选择。
//   - 返回机制（§一.7）：「返回」from-aware（fallback #/basket）；「回到试题篮」from 参数优先。

import { useEffect, useMemo, useRef, useState } from 'react';
import 'katex/dist/katex.min.css';
import type {
  CapturedQuestion, CaptureExtraction, CaptureWindowState,
  PaperImportResult, PaperImportTarget, PaperPreview,
} from '../../shared/contracts/capture-types.js';
import type { CaptureCollectResult } from '../../shared/contracts/ipc-channels.js';
import { renderMath, rewriteDataAssetSrcs } from '../../docgen/render/buildPaperHtml.core.js';
import {
  DEFAULT_CAPTURE_SUBJECT, EMPTY_DICT_FALLBACK_OPTIONS, splitStageSubject,
  subjectIdOf, SUBJ_PREFIX,
} from '../../capture/subject.js';
import { detectSite } from '../../capture/browser/state.js';
import { parseZujuanPaperUrl } from '../../capture/papers/paper-url.js';
import { isPaperChallengeMessage } from '../../capture/papers/challenge-hint.js';
import type { DictEntry } from '../../shared/contracts/bank-types.js';
import { CaptureClient } from '../services/capture-client.js';
import { createCaptureService } from '../services/CaptureServiceFactory.js';
import { getUserDataAssetsRoot } from '../services/paths.js';
import { useExtPageServices, type ExtPageServices } from './ExtUi.js';
import { Mascot } from '../components/Mascot.js';
import { isPaperInFlight } from './paper-actions.js';
// 0055（R-044/R-063）：默认学段学科偏好 + 目标篮下拉的「新建」哨兵值
import { readDefaultStageSubject, stageOptionsWith } from '../state/default-stage-subject.js';
import { resolveBackHref, hashSearchOf, backLabelOf } from '../utils/nav.js';

const ZUJUAN_URL = 'https://zujuan.xkw.com/';
const JYEOO_URL = 'https://www.jyeoo.com';

/** 0006-fix-3 P3-1：学段固定三值（不落库，仅作采集上下文/未来挂树筛题的 UI 状态） */
const CAPTURE_STAGES = ['小学', '初中', '高中'] as const;

/** 0055（R-063）：目标篮下拉里「＋ 新建试题篮…」的哨兵值（真实篮 id 恒为 p*，不撞） */
const NEW_BASKET_OPTION = '__new__';

/** 兜底选项组合串 → 学科列表（去重保序） */
function fallbackSubjects(): string[] {
  const seen = new Set<string>();
  for (const o of EMPTY_DICT_FALLBACK_OPTIONS) {
    const s = splitStageSubject(o).subject;
    if (s) seen.add(s);
  }
  return [...seen];
}

/** 默认组合串「高中数学」→ 默认学段/学科（2026-09-06 拍板默认语义不变） */
const DEFAULT_STAGE = splitStageSubject(DEFAULT_CAPTURE_SUBJECT).stage ?? CAPTURE_STAGES[0];
const DEFAULT_SUBJECT_NAME = splitStageSubject(DEFAULT_CAPTURE_SUBJECT).subject;

const SITE_LABEL: Record<string, string> = {
  zujuan: '组卷网',
  jyeoo: '菁优网',
  generic: '其他站点',
};

/** 预览条目 HTML：题干 + 选项拼接 → KaTeX 渲染 → data-assets 资产根解析（无根回落占位） */
function previewItemHtml(q: CapturedQuestion): string {
  const optionsHtml =
    q.options.length > 0
      ? `<div class="options">${q.options.map((o) => `<span class="option">${o}</span>`).join('')}</div>`
      : '';
  return rewriteDataAssetSrcs(renderMath(q.stemHtml + optionsHtml), getUserDataAssetsRoot());
}

/** 答案/解析有无徽标：有 = 绿点；缺 = 灰点。pendingHint = 入库前提示语（答案/解析在入库动作时补抓，D1-fix-4 复验语义修正）；入库后显示真实缺失原因（vip-gated/timeout 等） */
function FieldBadge({ testid, label, present, reason, pendingHint }: { testid: string; label: string; present: boolean; reason?: string; pendingHint?: string }) {
  return (
    <span
      data-testid={testid}
      data-state={present ? 'ok' : 'missing'}
      style={{ color: present ? 'var(--green-ink)' : 'var(--ink-3)', marginRight: '0.75rem' }}
    >
      ● {label}{present ? '' : pendingHint ? ` ${pendingHint}` : ` 缺失（${reason ?? '未知原因'}）`}
    </span>
  );
}

interface CapturePageProps {
  capture?: CaptureClient;
  pollIntervalMs?: number;
  /** 注入优先（测试双跑）；缺省按环境取真实 client/mock */
  svc?: ExtPageServices;
}

/** 从 hash 解析 toBasket（#/capture?toBasket=<paperId>）；缺省 null */
function parseToBasket(hash: string): string | null {
  const q = hash.split('?')[1];
  if (!q) return null;
  const params = new URLSearchParams(q);
  const id = params.get('toBasket');
  return id && id.trim() ? id : null;
}

export function CapturePage({ capture, pollIntervalMs = 1000, svc: injectedSvc }: CapturePageProps) {
  const client = useMemo(() => capture ?? createCaptureService(), [capture]);
  const svc = useExtPageServices(injectedSvc);
  const [state, setState] = useState<CaptureWindowState | null>(null);
  const [extraction, setExtraction] = useState<CaptureExtraction | null>(null);
  const [collectResult, setCollectResult] = useState<CaptureCollectResult | null>(null);
  // D1-fix-4 复验：入库后预览已刷新为补抓后数据（true）→ 徽标显示真实缺失原因；
  // 入库前（false）缺字段徽标提示「待入库时补抓」，不误导为已丢失
  const [postCollect, setPostCollect] = useState(false);
  // 0055（R-044）：默认学段让位设置页偏好（拍板③：未设置时维持现默认「高中」，行为不变）
  const [stage, setStage] = useState<string>(() => readDefaultStageSubject().stage || DEFAULT_STAGE);
  const [subjectName, setSubjectName] = useState<string>(DEFAULT_SUBJECT_NAME);
  // 0006-fix-3 P3-1：学科项由 dict 归一行（site 为空）驱动；null=加载中（先只显当前选择）
  const [dictSubjects, setDictSubjects] = useState<string[] | null>(null);
  // 0012 P4（只增）：字典全量行（含站点行）——预填归一 subjectIdOf 单源解析用
  const [dictEntries, setDictEntries] = useState<DictEntry[] | null>(null);
  const [busy, setBusy] = useState(false);
  // 0010 P2-8：入库等待期进度反馈（collect 挂起期间渲染不定态进度条 + 阶段文案；只动渲染层）
  const [collecting, setCollecting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // L-2：已同步的 lastExtraction.at（控件条提取后自动拉取，避免重复拉）
  const lastSyncedExtractionAt = useRef<string | null>(null);
  // 0004-fix-1 D：目标篮（hash toBasket 优先；无则处理中卷 + 用户勾选/下拉选择）
  const [targetPaper, setTargetPaper] = useState<{ id: string; title: string } | null>(null);
  const [existingIds, setExistingIds] = useState<string[]>([]);
  // 0011 §一.6：处理中卷清单（无 toBasket 时的联动候选；0/1/N 张三态）
  const [inFlightPapers, setInFlightPapers] = useState<Array<{ id: string; title: string }>>([]);
  // 多张处理中时的目标选择（下拉；默认第一张）
  const [selectedInFlightId, setSelectedInFlightId] = useState('');
  const [addToBasketChecked, setAddToBasketChecked] = useState(false);
  // 0055（R-063）：现场新建试题篮（下拉末项 / 0 篮态按钮 → 行内输入 → 建后设为入库目标）
  const [newBasketOpen, setNewBasketOpen] = useState(false);
  const [newBasketTitle, setNewBasketTitle] = useState('');
  const [newBasketBusy, setNewBasketBusy] = useState(false);
  const [basketNotice, setBasketNotice] = useState<{ type: 'success' | 'error'; text: string } | null>(null);
  // 0006 P4：整卷下载（组卷网整卷 URL → 预览勾选 → 去向二选一；与试题篮零交互、不占处理中篮）
  const [paperUrl, setPaperUrl] = useState('');
  const [paperPreview, setPaperPreview] = useState<PaperPreview | null>(null);
  const [paperSelected, setPaperSelected] = useState<Set<string>>(new Set());
  // 0010 P2-9：逐题展开态（题号集合）。契约（PaperPreviewItem）无完整题干/选项/配图字段，
  // 展开区呈现契约已有字段全文：题干摘要全文 + 知识点 + 子题数 + 答案/解析有无（不扩契约）
  const [paperExpanded, setPaperExpanded] = useState<Set<string>>(new Set());
  const [paperTarget, setPaperTarget] = useState<PaperImportTarget>('paper');
  const [paperBusy, setPaperBusy] = useState(false);
  // 0012 目检返工 5：整卷抓取/导入进行中读条（对齐试题入库读条形态）
  const [paperPhase, setPaperPhase] = useState<'preview' | 'import' | null>(null);
  const [paperError, setPaperError] = useState<string | null>(null);
  const [paperResult, setPaperResult] = useState<PaperImportResult | null>(null);
  // 0012 P2：顶部栏瞬态提示（提取/保存HTML/地址复制）
  const [extractNotice, setExtractNotice] = useState<string | null>(null);
  const [saveNotice, setSaveNotice] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  // 0012 P4：自动预填（手选锁定 + 「已按页面识别」轻提示；禁静默改值）
  const [autoHint, setAutoHint] = useState<string | null>(null);
  const manualPickRef = useRef(false);
  // 0012 目检返工 2：三个页签（浏览器/采集界面/整卷下载；默认浏览器页）
  const [activeTab, setActiveTab] = useState<'browser' | 'panel' | 'paper'>('browser');
  // 0012 P2.3：内嵌站点视图槽位（原生 view 覆盖其上；路由在场=顶部栏+view 填满内容区）
  const slotRef = useRef<HTMLDivElement | null>(null);
  const openRef = useRef(false);

  // 目标篮装载：hash 带 toBasket → 解析卷标题 + 已在篮题 id（去重基准）；
  // 装载失败（卷不存在/已删）→ 报错可见并回组卷列表（0011 §一.6）；否则查处理中卷供勾选/下拉
  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      const toBasket = parseToBasket(window.location.hash);
      if (toBasket) {
        const paper = await svc.ext.paper.getPaperEx(toBasket).catch(() => null);
        if (cancelled) return;
        if (paper) {
          const refs = await svc.bank.getPaperQuestions(toBasket).catch(() => []);
          if (cancelled) return;
          setTargetPaper({ id: paper.id, title: paper.title });
          setExistingIds(refs.map((r) => r.questionId));
        } else {
          setError('目标试题篮不存在或已删除');
          window.location.hash = '#/basket';
        }
        return;
      }
      const list = await svc.ext.paper.listPapersEx().catch(() => []);
      if (cancelled) return;
      const inflight = list
        .filter((p) => isPaperInFlight(p.paper.status))
        .map((p) => ({ id: p.paper.id, title: p.paper.title }));
      setInFlightPapers(inflight);
      setSelectedInFlightId((cur) => (inflight.some((p) => p.id === cur) ? cur : inflight[0]?.id ?? ''));
    };
    load().catch(() => {});
    return () => { cancelled = true; };
  }, [svc]);

  /** 勾选命中的处理中卷（多张时按下拉选择；缺省第一张） */
  const checkedInFlight = useMemo(
    () => inFlightPapers.find((p) => p.id === selectedInFlightId) ?? inFlightPapers[0] ?? null,
    [inFlightPapers, selectedInFlightId],
  );

  /** 当前生效的目标篮：hash toBasket 优先；否则勾选项命中的处理中卷 */
  const effectiveTarget = targetPaper ?? (addToBasketChecked && checkedInFlight ? checkedInFlight : null);

  /**
   * 0055（R-063）：现场新建试题篮（bank.createPaper 默认 status='basket' → 即「处理中卷」）
   * → 刷清单 → 设为入库目标（勾选置真，语义=「建了就是要用它」）。失败可见（不静默）。
   */
  const createBasketHere = async () => {
    const title = newBasketTitle.trim();
    if (!title || newBasketBusy) return;
    setNewBasketBusy(true);
    try {
      const paper = await svc.bank.createPaper(title);
      const list = await svc.ext.paper.listPapersEx().catch(() => []);
      const inflight = list
        .filter((p) => isPaperInFlight(p.paper.status))
        .map((p) => ({ id: p.paper.id, title: p.paper.title }));
      setInFlightPapers(inflight.some((p) => p.id === paper.id) ? inflight : [{ id: paper.id, title: paper.title }, ...inflight]);
      setSelectedInFlightId(paper.id);
      setAddToBasketChecked(true);
      setNewBasketTitle('');
      setNewBasketOpen(false);
    } catch (err) {
      setError(`新建试题篮失败：${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setNewBasketBusy(false);
    }
  };

  // 0006-fix-3 P3-1：学科项取 dict 归一行（站点同义行不进下拉，同 BankBrowser）；空库/查询失败回落 6 项硬编码兜底
  useEffect(() => {
    let cancelled = false;
    svc.ext.dict.listEntries({ kind: 'subject', activeOnly: true })
      .then((entries) => {
        if (cancelled) return;
        const labels = entries.filter((e) => !e.site).map((e) => e.label);
        setDictEntries(entries.length > 0 ? entries : null);
        setDictSubjects(labels.length > 0 ? labels : fallbackSubjects());
      })
      .catch(() => {
        if (!cancelled) {
          setDictEntries(null);
          setDictSubjects(fallbackSubjects());
        }
      });
    return () => { cancelled = true; };
  }, [svc]);

  const subjectOptions = useMemo(() => dictSubjects ?? [subjectName], [dictSubjects, subjectName]);

  // 字典到达后当前选项可能不在新列表（如空库建的默认值被真实字典替代）——回落默认学科，再退首项
  useEffect(() => {
    if (dictSubjects === null || dictSubjects.includes(subjectName)) return;
    setSubjectName(dictSubjects.includes(DEFAULT_SUBJECT_NAME) ? DEFAULT_SUBJECT_NAME : dictSubjects[0]);
  }, [dictSubjects, subjectName]);

  // 0055（R-044）：设置默认学科（字典 id）→ 学科下拉的 label 口径；字典就绪后落地，
  // 用户手选过（manualPickRef）/页面预填过则不覆盖（「可改为其他的」）
  useEffect(() => {
    const stored = readDefaultStageSubject();
    if (!stored.subjectId || manualPickRef.current || !dictEntries) return;
    const label = dictEntries.find((e) => !e.site && e.id === stored.subjectId)?.label;
    if (label && dictSubjects?.includes(label)) setSubjectName(label);
  }, [dictEntries, dictSubjects]);

  // 提交形态不变（契约零改动）：学段+学科组合串
  const subject = `${stage}${subjectName}`;

  // 轮询状态刷新：采集窗口独立于主窗，定时 getState 刷新开合/URL/登录态
  useEffect(() => {
    let cancelled = false;
    const refresh = () => {
      client.getState().then((s) => {
        if (cancelled) return;
        setState(s);
        // L-2：控件条「提取试题篮」在采集窗侧完成后，lastExtraction.at 变化 → 自动拉取结果进预览
        const at = s.lastExtraction?.at ?? null;
        if (at && at !== lastSyncedExtractionAt.current) {
          lastSyncedExtractionAt.current = at;
          client.getLastExtraction().then((r) => {
            if (!cancelled && r.extracted) {
              setExtraction(r.extracted);
              setCollectResult(null);
              setPostCollect(false);
            }
          }).catch(() => {});
        }
      }).catch(() => {});
    };
    refresh();
    const timer = setInterval(refresh, pollIntervalMs);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [client, pollIntervalMs]);

  const open = state?.open ?? false;
  openRef.current = open;

  // 0038 返工 2：站点/登录合并框的两段文案——文字位=当前站点（未进站「检测中」，
  // 进站未识别「未识别」），灯=登录三态；登录文案同时写进 tooltip 保留可读性
  const siteText = state?.site ? SITE_LABEL[state.site] ?? state.site : (open ? '未识别' : '检测中');
  const loginText = open ? (state?.loggedIn ? '已登录' : '未登录') : '检测中';

  // 0012 P2.3：路由离开=detach（view 销毁，重进需重新 open——语义同现状关窗）
  useEffect(() => () => {
    if (openRef.current) void client.closeWindow();
  }, [client]);

  // 0012 P1：状态事件推送订阅（快路径刷新；getState 轮询保留兜底）。
  // 0012 P4：事件携带页面语境（stage/subject 站点原文）时自动预填两下拉（未手选过才生效）
  const dictEntriesRef = useRef(dictEntries);
  dictEntriesRef.current = dictEntries;
  const subjectOptionsRef = useRef(subjectOptions);
  subjectOptionsRef.current = subjectOptions;
  const maybePrefillRef = useRef<(stage: string, subjectLabel: string, site: string | null) => void>(() => {});
  maybePrefillRef.current = (stage, subjectLabel, site) => {
    if (manualPickRef.current) return; // 用户手选过一次即锁定，跳转不覆盖
    const entries = dictEntriesRef.current;
    if (!entries) return; // 字典未就绪/空库兜底=无归一行，不预填（不猜）
    const id = subjectIdOf(subjectLabel, site ?? undefined, entries);
    if (!id) return; // 未命中字典：不预填 + 调试记档（不打扰不新建字典行）
    const normalized = entries.find((e) => !e.site && e.code === id.slice(SUBJ_PREFIX.length));
    const label = normalized?.label;
    if (!label || !subjectOptionsRef.current.includes(label)) return;
    setStage(stage);
    setSubjectName(label);
    setAutoHint(`${stage}·${label}`);
  };
  useEffect(() => {
    return client.onEvent((payload) => {
      setState((prev) => (prev
        ? { ...prev, url: payload.url, title: payload.title, loggedIn: payload.loggedIn ?? prev.loggedIn }
        : prev));
      if (payload.stage && payload.subject) {
        maybePrefillRef.current(payload.stage, payload.subject, detectSite(payload.url));
      }
    });
  }, [client]);

  // 0012 P1：bounds 上报编排——浏览器页=视口矩形随 resize/滚动/点击/节拍跟随；
  // 切到「采集界面」标签=上报零矩形（视图隐藏但会话保持，宿主对提取如实拒绝=红线）；
  // 灯箱等全屏弹层在场 → 零矩形（P0 定稿的遮挡对策）
  useEffect(() => {
    if (!open) return;
    const sync = () => {
      if (activeTab !== 'browser') {
        void client.setBounds({ x: 0, y: 0, width: 0, height: 0 });
        return;
      }
      const el = slotRef.current;
      if (!el) return;
      const occluded = !!document.querySelector('[data-testid="image-lightbox"]');
      const r = el.getBoundingClientRect();
      const rect = occluded
        ? { x: 0, y: 0, width: 0, height: 0 }
        : {
            x: Math.round(r.left),
            y: Math.round(r.top),
            width: Math.max(0, Math.round(r.width)),
            height: Math.max(0, Math.round(r.height)),
          };
      void client.setBounds(rect);
    };
    sync();
    window.addEventListener('resize', sync);
    window.addEventListener('scroll', sync, true);
    const onDocClick = () => { setTimeout(sync, 0); };
    document.addEventListener('click', onDocClick, true);
    const timer = setInterval(sync, 250);
    return () => {
      window.removeEventListener('resize', sync);
      window.removeEventListener('scroll', sync, true);
      document.removeEventListener('click', onDocClick, true);
      clearInterval(timer);
    };
  }, [open, activeTab, client]);

  const handleNavigate = async (url: string, via: 'url' | 'back' | 'forward' | 'reload' = 'url') => {
    setError(null);
    await client.navigate({ url, via });
    setState(await client.getState());
  };

  /**
   * 0020：挑战自助跳转（0012 目检新记录：原提示「请在采集窗口打开该整卷页人工通过」无对应通路）。
   * 目标 URL 以契约 preview.url 为准，无 preview 时用输入框现值；须过整卷 URL 校验才可点（禁拿脏值导航）。
   * 语义=切浏览器页 + 导航到该整卷页，人工过验证后由用户自己回来重试；不自动绕过、不自动重试。
   */
  const paperChallengeUrl = parseZujuanPaperUrl(paperPreview?.url ?? paperUrl.trim())?.url ?? null;

  const handleGotoPaperInBrowser = async () => {
    if (!paperChallengeUrl) return;
    setActiveTab('browser');
    await handleNavigate(paperChallengeUrl);
  };

  /** 三处挂载点共用的挑战自助跳转按钮属性（无有效整卷 URL 时禁用并 title 说明）；
   *  testid 与按钮文案在挂载点以字面量书写——保持静态扫描可见（验收扫描脚本按字面 grep） */
  const challengeGotoProps = {
    type: 'button' as const,
    className: 'btn btn-sm',
    onClick: handleGotoPaperInBrowser,
    disabled: !paperChallengeUrl,
    // 0020 目检返工 2：挑战在抓取用隐藏窗（offscreen）触发，可见浏览器未必复现验证——
    // 提示语不承诺「一定出现验证」，两种实况都给回程动作（行为与两条挑战消息一字未动）
    title: paperChallengeUrl
      ? `打开整卷页 ${paperChallengeUrl}（出现验证请人工通过；未出现验证可直接回到本页重试）`
      : '无有效整卷 URL（需 {bankId}p{paperId}.html 形态）：请先在输入框填写整卷详情页地址',
    style: { marginTop: '0.4rem' },
  };

  /** 0012 P2：地址只读点击复制（可输入导航为可选增强，本期不做） */
  const handleCopyAddress = async () => {
    const url = state?.url;
    if (!url) return;
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // 剪贴板不可用（非安全上下文等）——静默，完整 URL 经 title 悬浮可见
    }
  };

  /**
   * 0012 目检返工 5：初始未启动——进入浏览器页不自动挂载，快捷导航/整卷带链（host.navigate 自动
   * attach）才启动浏览器；「关闭浏览器」卸载后保持未启动直到下次导航。会话 persist 持久。
   */

  const handleExtract = async () => {
    setError(null);
    setBusy(true);
    setExtractNotice(null);
    try {
      const { extracted } = await client.extractBasket();
      setExtraction(extracted);
      setExtractNotice(`已提取 ${extracted.captured.length} 题，可切「采集界面」查看入库`);
      setCollectResult(null);
      setPostCollect(false);
    } catch (e: any) {
      setError(e?.message || String(e));
    } finally {
      setBusy(false);
    }
  };

  const handleCollect = async () => {
    if (!extraction) return;
    setError(null);
    setBasketNotice(null);
    setBusy(true);
    setCollecting(true);
    try {
      // L-1：入库携带用户选择学科（学段+学科组合串，host 侧拆分 subject/stage）
      const result = await client.collect({ extracted: extraction, subject });
      setCollectResult(result);
      // D1-fix-4 复验：答案/解析补抓发生在主进程 collect 内，渲染侧 state 是入库前旧副本；
      // 回传 enriched captured 时刷新预览徽标（mock/旧桥无 captured 则保持原状）
      if (result.captured) {
        setExtraction({ ...extraction, captured: result.captured });
        setPostCollect(true);
      }
      // 0004-fix-1 D：目标篮联动——0011-fix 改为**按本批采集题全量同步**：
      // okIds 契约语义只含本批新建/回填（dup 不含，见 ipc-channels CaptureCollectResult），
      // 若目标题已在库（此前采过/换篮重采），旧逻辑会静默丢题；现经 listQuestions 按
      // 站点键（sourceDetail.site:questionId）反查库内 id 与 okIds 取并集，已在目标篮的题仍过滤。
      if (effectiveTarget) {
        let bankIdByKey = new Map<string, string>();
        try {
          const all = await svc.bank.listQuestions();
          for (const q of all) {
            if (q.sourceType !== 'network' || !q.sourceDetail) continue;
            const detail = q.sourceDetail as Record<string, unknown>;
            const site = detail['site'];
            const qid = detail['questionId'];
            if (typeof site === 'string' && typeof qid === 'string') bankIdByKey.set(`${site}:${qid}`, q.id);
          }
        } catch {
          bankIdByKey = new Map(); // 反查失败回落 okIds（既有语义，不阻塞入库回显）
        }
        const capturedIds = extraction.captured
          .map((q) => bankIdByKey.get(`${q.site}:${q.questionId}`))
          .filter((id): id is string => !!id);
        const candidates = [...new Set([...capturedIds, ...(result.okIds ?? [])])];
        const addIds = candidates.filter((id) => !existingIds.includes(id));
        const skipped = candidates.length - addIds.length;
        let added = 0;
        const failures: string[] = [];
        for (const qid of addIds) {
          try {
            await svc.bank.addQuestion(effectiveTarget.id, qid);
            added++;
          } catch (err) {
            failures.push(`${qid}：${err instanceof Error ? err.message : String(err)}`);
          }
        }
        setBasketNotice({
          type: failures.length > 0 ? 'error' : 'success',
          text: `${added} 题已加入试题篮「${effectiveTarget.title}」`
            + (skipped > 0 ? `（已在篮跳过 ${skipped} 题）` : '')
            + (failures.length > 0 ? `（${failures.length} 题加篮失败：${failures.join('；')}）` : ''),
        });
        // 加篮后刷新已在篮集合（同批重复入库时不重复加）
        const refs = await svc.bank.getPaperQuestions(effectiveTarget.id).catch(() => []);
        setExistingIds(refs.map((r) => r.questionId));
      }
    } catch (e: any) {
      setError(e?.message || String(e));
    } finally {
      setBusy(false);
      setCollecting(false);
    }
  };

  /** 0006 P4：整卷下载预览（组卷网整卷 URL；主进程经 PC SSR + 移动批量 API 抓全卷字段） */
  const handlePaperPreview = async () => {
    setPaperError(null);
    setPaperResult(null);
    setPaperBusy(true);
    setPaperPhase('preview');
    try {
      const preview = await client.paperPreview({ url: paperUrl.trim() });
      setPaperPreview(preview);
      setPaperSelected(new Set(preview.items.map((i) => i.questionId)));
      setPaperExpanded(new Set());
    } catch (e: any) {
      setPaperPreview(null);
      setPaperError(e?.message || String(e));
    } finally {
      setPaperBusy(false);
      setPaperPhase(null);
    }
  };

  const togglePaperSelected = (questionId: string) => {
    setPaperSelected((prev) => {
      const next = new Set(prev);
      if (next.has(questionId)) next.delete(questionId);
      else next.add(questionId);
      return next;
    });
  };

  /** 0010 P2-9：展开/收起单题明细 */
  const togglePaperExpanded = (questionId: string) => {
    setPaperExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(questionId)) next.delete(questionId);
      else next.add(questionId);
      return next;
    });
  };

  /** 0006 P4：整卷导入（勾选顺序 = 卷面题序；去向二选一：成品卷 / 散题入题库） */
  const handlePaperImport = async () => {
    if (!paperPreview) return;
    setPaperError(null);
    setPaperBusy(true);
    setPaperPhase('import');
    try {
      const questionIds = paperPreview.items
        .filter((i) => paperSelected.has(i.questionId))
        .map((i) => i.questionId);
      const result = await client.paperImport({ url: paperPreview.url, questionIds, target: paperTarget });
      setPaperResult(result);
    } catch (e: any) {
      setPaperError(e?.message || String(e));
    } finally {
      setPaperBusy(false);
      setPaperPhase(null);
    }
  };

  return (
    <div>
      {/* 0012 目检返工：顶部标签页（浏览器/采集界面）——浏览器页=站点视图整页 + 常规浏览器控件 +
          登录态灯 + 导出试题篮；采集界面页=入库上下文/读条/结果/预览（互不挤占空间） */}
      {/* 0012 目检返工 2：第一行=返回 + 三页签；第二行（浏览器页）=精简浏览器控件 */}
      {/* 0012 目检返工 5：页头返回（参考题库/组卷页 page-head 形态）+ 标签行（from-aware 指名返回右对齐） */}
      <div className="page-head" style={{ marginBottom: 8 }}>
        <a
          className="page-back"
          data-testid="capture-header-back"
          href={resolveBackHref(hashSearchOf(window.location.hash), '#/basket')}
        >
          ← 返回
        </a>
      </div>
      <div className="cap-bar" data-testid="cap-bar">
        <button
          className={activeTab === 'browser' ? 'btn btn-primary' : 'btn'}
          data-testid="capture-tab-browser"
          onClick={() => setActiveTab('browser')}
          title="站点视图（内嵌浏览器）"
        >
          浏览器
        </button>
        <button
          className={activeTab === 'panel' ? 'btn btn-primary' : 'btn'}
          data-testid="capture-tab-panel"
          onClick={() => setActiveTab('panel')}
          title="采集组件：入库上下文/读条/结果/预览"
        >
          试题采集{extraction && extraction.captured.length > 0 ? `（${extraction.captured.length} 题）` : ''}
        </button>
        <button
          className={activeTab === 'paper' ? 'btn btn-primary' : 'btn'}
          data-testid="capture-tab-paper"
          onClick={() => setActiveTab('paper')}
          title="组卷整卷下载（独立页）"
        >
          整卷下载
        </button>
        <span style={{ flex: 1 }} />
        {/* 0011 §一.7：from-aware 指名返回（右对齐） */}
        <button
          className="btn"
          data-testid="capture-back-btn"
          onClick={() => { window.location.hash = resolveBackHref(hashSearchOf(window.location.hash), '#/basket'); }}
        >
          {backLabelOf(hashSearchOf(window.location.hash))}
        </button>
      </div>
      {activeTab === 'browser' && (
        <div className="cap-bar" style={{ borderTop: 'none', marginTop: '-0.75rem' }}>
          {/* 0038 返工 2：前进/后退/刷新压缩为紧凑控件组（窄窗不折行） */}
          <span className="cap-nav-ctl-group">
            <button
              className="btn btn-nav-ctl"
              data-testid="capture-nav-back"
              onClick={() => handleNavigate(state?.url ?? '', 'back')}
              disabled={!open || !state?.canGoBack || busy}
              title="后退"
            >
              ⟵
            </button>
            <button
              className="btn btn-nav-ctl"
              data-testid="capture-nav-forward"
              onClick={() => handleNavigate(state?.url ?? '', 'forward')}
              disabled={!open || !state?.canGoForward || busy}
              title="前进"
            >
              ⟶
            </button>
            <button
              className="btn btn-nav-ctl"
              data-testid="capture-nav-reload"
              onClick={() => handleNavigate(state?.url ?? '', 'reload')}
              disabled={!open || busy}
              title="刷新"
            >
              ⟳
            </button>
          </span>
          <button
            className="btn"
            data-testid="capture-address"
            onClick={handleCopyAddress}
            disabled={!open || !state?.url}
            title={state?.url || '当前页面地址（点击复制）'}
            style={{ flex: '1 1 12rem', maxWidth: '100%', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', display: 'inline-block', textAlign: 'left' }}
          >
            {copied ? '已复制 ✓' : (state?.url || '（自动挂载中…点快捷导航开始采集）')}
          </button>
          {/* 0038 返工 2：站点 + 登录态合并为一框——文字=当前站点（未进站=检测中/未识别），
              指示灯=登录三态（绿=已登录 / 红=未登录 / 灰=检测中；事件推送+轮询双源），登录文案进 tooltip */}
          <span
            className="login-light"
            data-testid="capture-site-state"
            title={`当前站点：${siteText}；登录状态：${loginText}`}
          >
            <span
              className="ll"
              data-testid="capture-login-light"
              data-state={open ? (state?.loggedIn ? 'green' : 'red') : 'grey'}
              title={`登录状态：${loginText}`}
              style={{ backgroundColor: open ? (state?.loggedIn ? 'var(--green-ink)' : 'var(--brick)') : 'var(--ink-3)' }}
            />
            <span data-testid="capture-site-badge">{siteText}</span>
          </span>
          {/* 快捷导航（导航即自动挂载；手动关闭后导航重新恢复）
              0038（R-030）：站导航=采集第一步，加粗边框 + 荧光圈高亮（0038 返工 1：撤分组外框与圆点） */}
          <span className="cap-site-nav">
            <button className="btn btn-site-nav" onClick={() => handleNavigate(ZUJUAN_URL)} disabled={busy} title="快速导航：组卷网">组卷网</button>
            <button className="btn btn-site-nav" onClick={() => handleNavigate(JYEOO_URL)} disabled={busy} title="快速导航：菁优网">菁优网</button>
          </span>
          <button
            className="btn"
            data-testid="capture-extract-btn"
            onClick={handleExtract}
            disabled={!open || busy}
            title="把网站上试题篮里的题目导出到软件（再点「入库」落库）"
          >
            导出试题篮
          </button>
          {/* 0012 目检返工 3：试卷详情页一键带链跳整卷下载页 */}
          <button
            className="btn"
            data-testid="capture-goto-paper-btn"
            onClick={() => {
              const ref = parseZujuanPaperUrl(state?.url ?? '');
              if (ref) setPaperUrl(ref.url);
              setActiveTab('paper');
            }}
            disabled={!open || !parseZujuanPaperUrl(state?.url ?? '') || busy}
            title={parseZujuanPaperUrl(state?.url ?? '')
              ? `整卷下载当前试卷（${parseZujuanPaperUrl(state?.url ?? '')!.url}）`
              : '当前页面为组卷整卷详情页（{bankId}p{paperId}.html）时可用'}
          >
            整卷下载
          </button>
          <button
            className="btn"
            data-testid="capture-close-browser-btn"
            onClick={async () => {
              setError(null);
              await client.closeWindow();
              setState(await client.getState());
            }}
            disabled={!open || busy}
            title="卸载内嵌浏览器（登录会话保留，再次导航自动恢复）"
          >
            关闭浏览器
          </button>
          {extractNotice && (
            <span data-testid="capture-extract-notice" style={{ color: 'var(--green-ink)', fontSize: '0.85rem' }}>
              {extractNotice}
            </span>
          )}
          {open && !state?.loggedIn && state?.site && (
            <span style={{ color: 'var(--brick)', fontSize: '0.85rem' }}>请先在页面登录</span>
          )}
        </div>
      )}
      {/* 0012 目检返工 2：状态卡（URL/站点/登录的重复展示）随精简退役——信息归顶部栏第二行 */}

      {activeTab === 'browser' && (
        /* 0012 目检返工：浏览器页=站点视图独占内容区（顶部两行之外全部让给视图） */
        <div
          ref={slotRef}
          data-testid="capture-view-slot"
          style={{
            position: 'relative',
            height: 'calc(100vh - 190px)',
            minHeight: '320px',
            margin: '0 0 0.75rem',
            border: '1px solid var(--line)',
            borderRadius: 'var(--radius-sm)',
            background: 'var(--card)',
            overflow: 'hidden',
          }}
        >
          {!open && (
            <div
              data-testid="capture-slot-empty"
              style={{
                display: 'flex', flexDirection: 'column', alignItems: 'center',
                justifyContent: 'center', height: '100%', gap: '0.9rem', color: 'var(--ink-2)',
              }}
            >
              {/* 0012 目检返工 5：初始未启动 + 流程引导（小方同学陪伴）
                  0038 返工 3（目检）：最大化建议并入引导文字（仅浏览器未启动时随引导呈现） */}
              <Mascot mood="work" size={72} />
              <div style={{ display: 'grid', gap: '0.4rem', lineHeight: 1.9 }}>
                <div><strong style={{ color: 'var(--ink)' }}>试题采集</strong>：打开组卷网 / 菁优网 → 挑选题目加入试题篮 → 展开试题篮后点「导出试题篮」</div>
                <div><strong style={{ color: 'var(--ink)' }}>试卷下载</strong>：打开组卷网 / 菁优网 → 选择想下载的试卷 → 点「整卷下载」</div>
                <div
                  data-testid="capture-maximize-tip"
                  style={{ fontSize: '0.85em', color: 'var(--ink-3)' }}
                >
                  提示：为了达到最好的使用体验，建议将应用窗口最大化（浏览区更大、顶部工具栏不折行）
                </div>
              </div>
              <span style={{ fontSize: '0.85em' }}>登录态持久保存；「关闭浏览器」可随时卸载，不影响已登录会话</span>
            </div>
          )}
        </div>
      )}
      {activeTab === 'panel' && (
        /* 0012 目检返工 5：选项行与提示同框（勾选行在上一行，目标篮提示在其下、同一框内）
           0012 目检返工 6：内层行剥掉 .cap-bar 自带边框/底色/外距（避免与卡片边框重合冲突） */
        <div className="card" data-testid="capture-panel-context" style={{ margin: '0.75rem 0', padding: '0.75rem 0.9rem', boxShadow: 'none' }}>
          {/* 入库上下文（学段/学科 + 入库 + 目标篮联动；0011 三态不变） */}
          <div className="cap-bar" style={{ border: 'none', background: 'transparent', padding: 0, margin: 0 }}>
            <label>
              学段：
              <select
                className="select"
                data-testid="stage-select"
                value={stage}
                onChange={(e) => { manualPickRef.current = true; setAutoHint(null); setStage(e.target.value); }}
                disabled={busy}
              >
                {stageOptionsWith(CAPTURE_STAGES, stage).map((s2) => (
                  <option key={s2} value={s2}>{s2}</option>
                ))}
              </select>
            </label>
            <label>
              学科：
              <select
                className="select"
                data-testid="subject-select"
                value={subjectName}
                onChange={(e) => { manualPickRef.current = true; setAutoHint(null); setSubjectName(e.target.value); }}
                disabled={busy}
              >
                {subjectOptions.map((s2) => (
                  <option key={s2} value={s2}>{s2}</option>
                ))}
              </select>
            </label>
            {/* 0012 P4：预填可见性（禁静默改值）——「已按页面识别：<学段>·<学科>」轻提示 */}
            {autoHint && (
              <span className="tag tag-green" data-testid="capture-autofill-hint" title="按当前浏览页面自动识别（手选后不再覆盖）">
                已按页面识别：{autoHint}
              </span>
            )}
            <button
              className="btn btn-primary"
              data-testid={targetPaper ? 'capture-collect-btn' : undefined}
              onClick={handleCollect}
              disabled={!extraction || extraction.captured.length === 0 || busy}
            >
              {/* 0011 §一.6：toBasket 场景主按钮点明「入库+挂篮一步完成」语义 */}
              {targetPaper ? '加入当前试题篮（同步入库）' : '入库'}
            </button>
            {/* 0004-fix-1 D + 0011 §一.6 三态：无 toBasket 时——恰 1 张处理中沿用勾选；
                多张出现目标下拉；0 张不显示勾选。
                0012 目检返工 5：勾选框在前、试题篮下拉在后（同一行），下拉压缩宽度+选项截断防溢出。
                0055（R-063）：下拉恒渲染（恰 1 张也在）+「＋ 新建试题篮…」选项；0 张仍留新建口——
                勾选框语义不变（0 张不渲染），任何态都有新建试题篮的出口 */}
            {!targetPaper && (
              <>
                {inFlightPapers.length > 0 && (
                  <label data-testid="capture-add-basket-label">
                    <input
                      type="checkbox"
                      data-testid="capture-add-basket-checkbox"
                      checked={addToBasketChecked}
                      onChange={(e) => setAddToBasketChecked(e.target.checked)}
                      disabled={busy}
                    />
                    {' '}{inFlightPapers.length === 1
                      ? `同时加入当前试题篮 ${inFlightPapers[0].title}`
                      : '同时加入选中试题篮'}
                  </label>
                )}
                {inFlightPapers.length > 0 ? (
                  <select
                    className="select"
                    data-testid="capture-basket-target-select"
                    aria-label="目标试题篮"
                    value={selectedInFlightId}
                    onChange={(e) => {
                      if (e.target.value === NEW_BASKET_OPTION) { setNewBasketOpen(true); return; }
                      setSelectedInFlightId(e.target.value);
                    }}
                    disabled={busy}
                    style={{ maxWidth: '14rem' }}
                  >
                    {inFlightPapers.map((p) => (
                      <option key={p.id} value={p.id} title={p.title}>
                        {p.title.length > 20 ? `${p.title.slice(0, 20)}…` : p.title}
                      </option>
                    ))}
                    <option value={NEW_BASKET_OPTION}>＋ 新建试题篮…</option>
                  </select>
                ) : (
                  !newBasketOpen && (
                    <button
                      type="button"
                      className="btn btn-sm"
                      data-testid="capture-new-basket-btn"
                      onClick={() => setNewBasketOpen(true)}
                      disabled={busy}
                    >
                      ＋ 新建试题篮…
                    </button>
                  )
                )}
                {newBasketOpen && (
                  <span style={{ display: 'inline-flex', alignItems: 'center', gap: '0.4rem' }}>
                    <input
                      className="input"
                      data-testid="capture-basket-new-name"
                      aria-label="新试题篮名称"
                      value={newBasketTitle}
                      placeholder="试题篮名称"
                      onChange={(e) => setNewBasketTitle(e.target.value)}
                      disabled={busy || newBasketBusy}
                      style={{ width: '10rem' }}
                    />
                    <button
                      type="button"
                      className="btn btn-sm btn-primary"
                      data-testid="capture-basket-new-confirm"
                      onClick={() => void createBasketHere()}
                      disabled={busy || newBasketBusy || !newBasketTitle.trim()}
                    >
                      新建
                    </button>
                  </span>
                )}
              </>
            )}
          </div>
          {/* 目标篮提示条：toBasket 进入=「目标试题篮：<标题>」常显（0011 §一.6）；
              勾选联动=沿用「将加入：…」形态（0012 目检返工 5：同框置于选项行下方） */}
          {targetPaper && (
            <div
              data-testid="capture-target-banner"
              className="selection-bar"
              style={{ marginTop: '0.6rem' }}
            >
              目标试题篮：<strong>{targetPaper.title}</strong>（入库即同步加入本篮）
            </div>
          )}
          {!targetPaper && effectiveTarget && (
            <div
              data-testid="capture-target-banner"
              className="selection-bar"
              style={{ marginTop: '0.6rem' }}
            >
              将加入：试题篮 <strong>{effectiveTarget.title}</strong>（入库成功后自动加篮）
            </div>
          )}
        </div>
      )}

      {/* 0012 目检返工：入库读条/结果上移——以下采集组件全部归属「试题采集」标签页 */}
      {activeTab === 'panel' && (
        <>
          {error && <div data-testid="capture-error" style={{ color: 'var(--brick)', marginBottom: '1rem' }}>{error}</div>}

          {/* 0010 P2-8：入库等待进度反馈（无逐题事件流 → 不定态动画 + 确定题数阶段文案） */}
          {collecting && extraction && (
            <div className="progress-shell" data-testid="collect-progress" data-count={extraction.captured.length} role="status">
              {/* 0010-merge P3.11：采集等待进度区吉祥物（工作表情） */}
              <Mascot mood="work" size={48} />
              <div>
                <strong>正在入库 {extraction.captured.length} 题…</strong>
                <div className="progress-track"><i /></div>
                <span>题目归一化与图片落盘中，请稍候</span>
              </div>
            </div>
          )}

          {/* 入库/挂篮结果（0011-fix 上移；0012 目检返工 5：紧凑化——挂篮结果随统计行内展示，双按钮同一行） */}
          {collectResult && (
            <section className="card" data-testid="collect-result" style={{ marginTop: '1rem', padding: '0.75rem' }}>
              <h2 className="section-title" style={{ marginTop: 0 }}>入库结果</h2>
              <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: '0.5rem' }}>
                <span>
                  成功 <span data-testid="collect-ok">{collectResult.ok}</span>，
                  重复 <span data-testid="collect-dup">{collectResult.dup}</span>，
                  更新 <span data-testid="collect-updated">{collectResult.updated ?? 0}</span>，
                  失败 <span data-testid="collect-failed">{collectResult.failed.length}</span>
                </span>
                {/* 0004-fix-1 D：加篮结果随统计行内展示（任务书 §一 D L48） */}
                {basketNotice && (
                  <span
                    data-testid="capture-basket-notice"
                    data-type={basketNotice.type}
                    className={basketNotice.type === 'success' ? 'notice notice-green' : 'notice notice-red'}
                    style={{ margin: 0 }}
                  >
                    {basketNotice.text}
                  </span>
                )}
              </div>
              {collectResult.failed.length > 0 && (
                <ul data-testid="collect-failed-list" style={{ color: 'var(--brick)' }}>
                  {collectResult.failed.map((f) => (
                    <li key={f.questionId}>{f.questionId}：{f.error}</li>
                  ))}
                </ul>
              )}
              <div style={{ display: 'flex', gap: '0.5rem', marginTop: '0.5rem' }}>
                {/* 0067 顺手修复（用户 2026-09-24 授权）：「查看题库」原写死 `#/` = 首页工作台，
                    与按钮文案不符。题库管理页路由 = `#/bank`（main.tsx 分发 + AppShell NAV_ITEMS['bank'].href）。 */}
                <button className="btn" data-testid="goto-bank" onClick={() => (window.location.hash = '#/bank')}>
                  查看题库
                </button>
                {/* 0011 §一.7：from 参数优先（如 compose/<id> → 回排版间）；无 from 落目标篮详情。
                    未选择加入试题篮（无目标）时本按钮不出现（0012 目检返工 5） */}
                {effectiveTarget && (
                  <button
                    data-testid="back-to-basket"
                    onClick={() => {
                      const fromHref = resolveBackHref(hashSearchOf(window.location.hash), '');
                      window.location.hash = fromHref || `#/basket/${effectiveTarget.id}`;
                    }}
                    className="btn"
                  >
                    回到试题篮
                  </button>
                )}
              </div>
            </section>
          )}
        </>
      )}

      {activeTab === 'paper' && (
        <>
          {/* 0012 目检返工 5：整卷抓取/导入进行中读条（对齐试题入库读条形态） */}
          {paperBusy && paperPhase && (
            <div className="progress-shell" data-testid="paper-progress" data-phase={paperPhase} role="status">
              <Mascot mood="work" size={48} />
              <div>
                <strong>{paperPhase === 'preview' ? '正在抓取整卷…' : '正在导入整卷…'}</strong>
                <div className="progress-track"><i /></div>
                <span>只读取站点公开页面，请稍候</span>
              </div>
            </div>
          )}
          {/* 0020 目检返工 4：整卷下载结果以单独框呈现，位置与「下载中」读条同槽位（同款壳 + 吉祥物） */}
          {paperResult && (
            <div className="progress-shell" data-testid="paper-import-result" role="status">
              <Mascot mood={paperResult.failed.length > 0 ? 'lost' : 'cheer'} size={48} />
              <div>
                <strong>整卷下载结果</strong>
                <div>
                  {paperResult.target === 'paper' ? (
                    <>
                      成品卷「{paperResult.paperTitle}」{paperResult.done ? '已生成并定稿' : '已建卷但未定稿'}
                      （{paperResult.snapshotCount ?? 0} 题，快照 {paperResult.snapshotCount ?? 0}）
                    </>
                  ) : (
                    <>
                      入库 成功 <span data-testid="paper-collect-ok">{paperResult.ok}</span>，
                      重复 <span data-testid="paper-collect-dup">{paperResult.dup}</span>，
                      更新 <span data-testid="paper-collect-updated">{paperResult.updated ?? 0}</span>，
                      失败 <span data-testid="paper-collect-failed">{paperResult.failed.length}</span>
                    </>
                  )}
                </div>
                {paperResult.failed.length > 0 && (
                  <ul data-testid="paper-import-failed" style={{ color: 'var(--brick)' }}>
                    {paperResult.failed.map((f) => <li key={f.questionId}>{f.questionId}：{f.error}</li>)}
                  </ul>
                )}
                {paperResult.warnings.length > 0 && (
                  <>
                    <ul data-testid="paper-import-warnings" style={{ color: 'var(--brick)' }}>
                      {paperResult.warnings.map((w, i) => <li key={i}>{w}</li>)}
                    </ul>
                    {/* 0020：导入段挑战告警旁的自助跳转 */}
                    {paperResult.warnings.some((w) => isPaperChallengeMessage(w)) && (
                      <button {...challengeGotoProps} data-testid="paper-import-goto-browser">去浏览器页打开本卷</button>
                    )}
                  </>
                )}
              </div>
            </div>
          )}
          {/* 0012 目检返工 2：整卷下载独立页（组卷网整卷 URL → 预览勾选 → 去向二选一）；与试题篮零交互、不占处理中篮 */}
          <section
            data-testid="paper-download"
        className="card"
        style={{ margin: '0.75rem 0', padding: '0.75rem' }}
      >
        <h2 className="section-title" style={{ marginTop: 0 }}>整卷下载（组卷网）</h2>
        <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: '0.5rem' }}>
          <input
            className="input"
            data-testid="paper-url-input"
            type="text"
            value={paperUrl}
            placeholder="https://zujuan.xkw.com/4p2338916.html"
            onChange={(e) => setPaperUrl(e.target.value)}
            disabled={paperBusy}
            style={{ flex: '1 1 14rem', width: '100%', maxWidth: '26rem', boxSizing: 'border-box' }}
          />
          <button
            className="btn"
            data-testid="paper-preview-button"
            onClick={handlePaperPreview}
            disabled={paperBusy || !paperUrl.trim()}
          >
            整卷下载
          </button>
          <span style={{ color: 'var(--ink-2)' }}>
            粘贴组卷整卷详情页 URL（{'{bankId}p{paperId}.html'}），不占试题篮
          </span>
        </div>

        {paperError && (
          <div data-testid="paper-error" style={{ color: 'var(--brick)', marginTop: '0.5rem' }}>
            <div>{paperError}</div>
            {/* 0020：挑战错（只有它命中单源谓词）才给自助跳转；文案渲染逐字不变，按钮纯追加 */}
            {isPaperChallengeMessage(paperError) && (
              <button {...challengeGotoProps} data-testid="paper-error-goto-browser">去浏览器页打开本卷</button>
            )}
          </div>
        )}

        {paperPreview && (
          <div data-testid="paper-preview-panel" style={{ marginTop: '0.75rem' }}>
            <div>
              <strong>{paperPreview.title}</strong>
              <span data-testid="paper-preview-count" style={{ marginLeft: '0.5rem', color: 'var(--ink-2)' }}>
                共 {paperPreview.total} 题，可下载 {paperPreview.items.length} 题
                {paperPreview.missing.length > 0 ? `（站点未返回 ${paperPreview.missing.length} 题）` : ''}
              </span>
            </div>
            {paperPreview.warnings.length > 0 && (
              <>
                <ul data-testid="paper-preview-warnings" style={{ color: 'var(--brick)' }}>
                  {paperPreview.warnings.map((w, i) => <li key={i}>{w}</li>)}
                </ul>
                {/* 0020：任一 warning 命中挑战即出一个按钮（非逐条） */}
                {paperPreview.warnings.some((w) => isPaperChallengeMessage(w)) && (
                  <button {...challengeGotoProps} data-testid="paper-preview-goto-browser">去浏览器页打开本卷</button>
                )}
              </>
            )}
            <ol>
              {paperPreview.items.map((item) => (
                <li
                  key={item.questionId}
                  data-testid={`paper-item-${item.questionId}`}
                  style={{ marginBottom: '0.5rem' }}
                >
                  <label>
                    <input
                      type="checkbox"
                      data-testid={`paper-check-${item.questionId}`}
                      checked={paperSelected.has(item.questionId)}
                      onChange={() => togglePaperSelected(item.questionId)}
                      disabled={paperBusy}
                    />
                    {' '}题号 {item.questionId}
                  </label>
                  <span style={{ marginLeft: '0.5rem', color: 'var(--ink-2)' }}>
                    {item.questionType ?? '未知题型'}
                    {item.difficulty ? `，${item.difficulty}` : ''}
                    {item.childCount > 1 ? `（含 ${item.childCount} 小题，v1 不拆题）` : ''}
                    {item.answerPresent ? '' : '（缺答案）'}
                    {item.analysisPresent ? '' : '（缺解析）'}
                  </span>
                  <button
                    type="button"
                    className="btn btn-sm"
                    data-testid={`paper-item-toggle-${item.questionId}`}
                    aria-expanded={paperExpanded.has(item.questionId)}
                    onClick={() => togglePaperExpanded(item.questionId)}
                    style={{ marginLeft: '0.5rem' }}
                  >
                    {paperExpanded.has(item.questionId) ? '收起' : '展开详情'}
                  </button>
                  <div style={{ color: 'var(--ink)', marginTop: '0.25rem' }}>{item.stemSummary || '（无题干摘要）'}</div>
                  {paperExpanded.has(item.questionId) && (
                    <div
                      data-testid={`paper-item-detail-${item.questionId}`}
                      className="card card-dashed"
                      style={{ marginTop: '0.5rem', padding: '0.6rem 0.75rem', boxShadow: 'none', fontSize: '0.9rem' }}
                    >
                      {/* 契约字段边界：stemSummary 全文（契约即截断摘要，无更长题干可渲染——缺口列报告） */}
                      <div style={{ color: 'var(--ink)', lineHeight: 1.7 }}>{item.stemSummary || '（无题干摘要）'}</div>
                      <div style={{ display: 'flex', gap: '0.4rem', flexWrap: 'wrap', marginTop: '0.5rem', alignItems: 'center' }}>
                        <span className="tag">{item.questionType ?? '未知题型'}</span>
                        {item.difficulty && <span className="tag">{item.difficulty}</span>}
                        <span className="tag">{item.answerPresent ? '答案：有' : '答案：缺'}</span>
                        <span className="tag">{item.analysisPresent ? '解析：有' : '解析：缺'}</span>
                        {item.childCount > 1 && <span className="tag tag-orange">含 {item.childCount} 小题（v1 不拆题）</span>}
                        {(item.knowledgePoints ?? []).map((kp) => (
                          <span key={kp} className="tag tag-green">{kp}</span>
                        ))}
                      </div>
                    </div>
                  )}
                </li>
              ))}
            </ol>
            <div>
              <label style={{ marginRight: '1rem' }}>
                <input
                  type="radio"
                  name="paper-target"
                  data-testid="paper-target-paper"
                  checked={paperTarget === 'paper'}
                  onChange={() => setPaperTarget('paper')}
                  disabled={paperBusy}
                />
                {' '}成品卷（新建成品卷 + 快照定稿）
              </label>
              <label>
                <input
                  type="radio"
                  name="paper-target"
                  data-testid="paper-target-bank"
                  checked={paperTarget === 'bank'}
                  onChange={() => setPaperTarget('bank')}
                  disabled={paperBusy}
                />
                {' '}散题入题库（去重/回填）
              </label>
            </div>
            <button
              className="btn btn-primary"
              data-testid="paper-import-button"
              onClick={handlePaperImport}
              disabled={paperBusy || paperSelected.size === 0}
              style={{ marginTop: '0.5rem' }}
            >
              导入
            </button>
          </div>
        )}
      </section>
        </>
      )}

      {/* 提取结果预览（0012 目检返工 2：归属采集界面标签页） */}
      {activeTab === 'panel' && (
        <>
      {/* 提取结果预览 */}
      {extraction && (
        <section>
          <h2 className="section-title">
            采集预览（{extraction.captured.length} 题，模式 {extraction.mode}）
          </h2>
          {extraction.warnings.length > 0 && (
            <ul data-testid="capture-warnings" style={{ color: 'var(--brick)' }}>
              {extraction.warnings.map((w, i) => (
                <li key={i}>{w}</li>
              ))}
            </ul>
          )}
          <ol>
            {extraction.captured.map((q) => {
              // 入库前缺字段的提示语义：有补抓通道（zujuan questionId / jyeoo 报告页两跳）且非会员墙 → 「待入库时补抓」；
              // 会员墙/无通道/入库后 → 显示真实缺失原因（D1-fix-4 复验语义修正）
              const canEnrich = q.site === 'zujuan' || (q.site === 'jyeoo' && !!q.meta.reportUrl);
              const pendingHint = !postCollect && !q.meta.gated && canEnrich ? '待入库时补抓' : undefined;
              return (
              <li
                key={q.questionId}
                data-testid={`capture-item-${q.questionId}`}
                style={{ marginBottom: '1rem', padding: '0.75rem', border: '1px solid var(--line)', borderRadius: 'var(--radius-sm)', background: 'var(--card)' }}
              >
                <div style={{ color: 'var(--ink-2)', marginBottom: '0.25rem' }}>
                  题号 {q.questionId}（{q.meta.questionType ?? '未知题型'}，{q.site}）
                </div>
                <div className="question-content" dangerouslySetInnerHTML={{ __html: previewItemHtml(q) }} />
                <div style={{ marginTop: '0.25rem', fontSize: '0.9em' }}>
                  <FieldBadge
                    testid={`capture-answer-${q.questionId}`}
                    label="答案"
                    present={q.answerHtml.length > 0}
                    reason={q.meta.answerVia || (q.meta.gated ? 'vip-gated' : undefined)}
                    pendingHint={pendingHint}
                  />
                  <FieldBadge
                    testid={`capture-analysis-${q.questionId}`}
                    label="解析"
                    present={q.analysisHtml.length > 0}
                    reason={q.meta.answerVia || (q.meta.gated ? 'vip-gated' : undefined)}
                    pendingHint={pendingHint}
                  />
                </div>
              </li>
              );
            })}
          </ol>
        </section>
      )}
        </>
      )}
    </div>
  );
}
