// 0004 Phase 3 + fix-1 B/F1 + fix-1b：题库浏览器（可复用模块）—— #/bank 管理模式 + 篮详情/排版间 pick 模式共用。
// fix-1b（用户拍板，替代 fix-1 B 的摘要形态）：条目收起态即**完整题卡**，对齐采集预览/组卷网题卡——
//   题干 = stemHtml 优先回落 content，走 renderPaperQuestionHtml（renderMath + data-assets 资产根解析）
//   放入 `.question-content` 容器（与 CapturePage.previewItemHtml 同管线同容器，app.css 全局限宽规则自动生效：
//   figure.diagram 80% 封顶 / inline-figure 200px / img.q-figure 80% / KaTeX 字号对齐）；图随题内容流，无缩略、无图计数徽标；
//   选项：结构化 options（校对/导入题）拼为 `.options > .option`（标号前置），采集题 content 自带 .options 则不重复拼；
//   答案/解析 = 卡片内两个折叠钮（默认收起；无内容钮灰显不可点；展开红字，对齐教师版渲染语义），保留单独读题能力；
//   客户端分页 20 条/页 + 选中集合跨页保留。
// fix-1 F1 组（管理模式）：多选列 + 选中计数条 + 批量删除/批量标签/批量标记错题/批量加入试题篮。
// 筛选：keyword（搜题干文本，沿用 listQuestions 语义）+ 学科/题型/难度下拉（dict 驱动，
// 空表显示「待采集」仅禁用该维度）+ 来源（sourceType 平面字段，客户端过滤）。
// 树面板（0006-fix-1，0014 改版迁入左栏）：学段/学科两下拉上移顶栏（单真源，顶栏选定树级联跟随）；
//   左栏保留类型切换（知识点/章节挑题）+ 树选择 + 节点折叠浏览；节点可点筛题（0014 R17：
//   listQuestions({ treeNodeId }) 子树派生——0002 B5 通道 + 0006 挂树数据，列表上方面包屑+清除钮）。
// 题型下拉（0014 Q4-3）：「选择题」聚合项=字典行 code（single-choice/multi-choice）展开 typeIds 多值，
//   缺行自动隐没；单值 typeId 兼容保留（与 typeIds 同现时 typeId 优先，契约 JSDoc 口径）。
// 0024 P3：学段/学科两下拉改读 src/app/state 共享状态（P-12 同源单状态，供后续 AI 入口复用）——
//   交互行为零变化（级联/默认首组/筛选重置逻辑未动），挂载生命周期由模块持有者计数保证与改造前一致。
// 管理操作：编辑（QuestionEditor 编辑形态 + 答案/解析）+ 软删（自绘双按钮弹层，禁 window.confirm）。
// 范围边界：错题本/考试页手动选题本轮不换，本组件预留复用接口（onPick）。

import { memo, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import type {
  DictEntry, Question, Student, Tree, TreeNode, TreeType,
} from '../../shared/contracts/bank-types.js';
import {
  useExtPageServices, MessageBanner, Modal, EmptyState,
  type ExtPageServices, type PageMessage,
} from '../pages/ExtUi.js';
import { QuestionEditor } from '../../docgen/editor/QuestionEditor.js';
import type { QuestionEditorApi } from '../../docgen/editor/QuestionEditor.js';
import { wrapForEditor, unwrapFromEditor } from '../../recog/onestep/markdown.js';
import { renderPaperQuestionHtml, isPaperInFlight } from '../pages/paper-actions.js';
import { relocateLeadingFigures } from '../../capture/normalize.js';
import { groupKeyOfSubject, siteOfTree } from '../../bank/subject-normalize.js';
import { useStageSubject } from '../state/use-stage-subject.js';
// 0029（只增）：AI 挂树/打标建议人确认弹层（P-07：AI 只建议、此处逐条确认写入）
import { AiSuggestDialog } from './AiSuggestDialog.js';
// 0040（只增）：树节点折叠浏览抽为共享组件（录题工作台挂树弹层同源）；行为与 data-testid 逐字不变
import { buildParentIndex, TreeNodeRows } from './TreeRows.js';
// 0054（R-049）：树名/根层的显示层处理（只剥显示层，落库树名原文零改动）
import { TREE_ROOT_NAMES, displayTreeName } from '../utils/tree-display.js';
// 0056（R-041）：采集题 AI 整理（整理入口区：批量条「AI 整理」+ 题卡「整理本题」+ 对照确认弹层）
import { AiCleanDialog } from './AiCleanDialog.js';
import { createAiCleanRunner, type AiCleanRunner } from '../services/question-ai-clean-client.js';

/**
 * 0045 目检返工（第三轮根因修复）：编辑器字段必须用 **div 壳** 而非 `<Field>`（label）。
 * `<label>` 会把标签内任意非交互处（标签文字/内边距/空白）的点击**转发给它内部第一个可标注控件**——
 * 题面/答案/解析三个字段里第一个就是工具条的 ƒx 按钮 → 「点编辑区就弹公式编辑器」；
 * 关掉后再点一下又弹回来 → 「×/取消也关不掉」。语义上 label 也不该包富文本编辑器。
 * 第四轮：字段间距收紧（0.5rem）、文本框加高（题面 240px / 答案·解析 160px），减少上下空隙。
 */
function EditorField({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div style={{ display: 'block', marginBottom: '0.5rem' }}>
      <div className="field-label">{label}</div>
      {children}
    </div>
  );
}

const SOURCE_TYPE_LABEL: Record<Question['sourceType'], string> = {
  network: '网络采集',
  local: '本地录入',
};

/** 0014 选择题聚合下拉的保留值（非字典 id）：命中时 listQuestions 走 typeIds=[单选id, 多选id] */
const CHOICE_GROUP_VALUE = 'choice-group';

const DIFFICULTY_TEXT: Record<number, string> = {
  1: '很容易', 2: '较易', 3: '中等', 4: '较难', 5: '很难',
};

/** fix-1 B：客户端分页每页条数（任务书定稿 20） */
export const BANK_PAGE_SIZE = 20;

/** 来源显示名：站名（sourceDetail.site，采集题）优先，回落来源类型标签 */
function sourceLabel(q: Question): string {
  const site = q.sourceDetail?.['site'];
  return typeof site === 'string' && site.trim()
    ? `${SOURCE_TYPE_LABEL[q.sourceType]} · ${site}`
    : SOURCE_TYPE_LABEL[q.sourceType];
}

/**
 * fix-1b 题卡题干 HTML：与采集预览同管线同容器（renderMath + data-assets 资产根解析，见 CapturePage.previewItemHtml）。
 * 题干取 stemHtml 优先、回落 content；结构化 options（校对/导入题）拼为 .options > .option（标号前置），
 * 采集题 content 自带 .options 契约结构（src/capture/normalize.ts）则不重复拼。
 */
export function questionCardHtml(q: Question): string {
  const rawStem = q.stemHtml && q.stemHtml.trim() ? q.stemHtml : q.content;
  // 0004-fix-1c C组：渲染前预处理——存量题题首孤图后移（菁优左文右图题显示层即时修复，无需重采；
  // 输入含 question-content 契约包裹时只后移题干区、选项居尾）。卷面引擎不走此路径（尊重 DOM 序
  // 为 U4 语义），存量卷面根治走重采回填（ingest updated 路径，B组）
  const stem = relocateLeadingFigures(rawStem);
  const options = q.options ?? [];
  const hasInlineOptions = /class\s*=\s*["'][^"']*\boptions\b/.test(stem);
  const optionsHtml = options.length > 0 && !hasInlineOptions
    ? `<div class="options">${options.map((o) => `<span class="option">${o.label}. ${o.html}</span>`).join('')}</div>`
    : '';
  return renderPaperQuestionHtml(stem + optionsHtml);
}

export interface BankBrowserProps {
  /** 注入优先（测试双跑）；缺省按环境取真实 client/mock */
  svc?: ExtPageServices;
  /** pick 模式：点「选入」回调；缺省 = 详情管理模式 */
  onPick?: (questionId: string) => void;
  /** pick 模式下排除的题 id（已在卷内的题不再列出）；过滤在客户端执行 */
  excludeIds?: string[];
  /**
   * 0056（R-041）：AI 整理运行面（注入优先，测试双跑）；缺省取 `window.__mofangBank.questionAiClean`。
   * 无桥且未注入 = 不渲染整理入口（0016 口径：不出现死按钮）。
   */
  aiClean?: AiCleanRunner;
}

/** 字典维度下拉：空表 → 单个「待采集」禁用项（不渲染假数据） */
function DictSelect({
  label, entries, value, onChange, testid,
}: {
  label: string;
  entries: DictEntry[];
  value: string;
  onChange: (v: string) => void;
  testid: string;
}) {
  const empty = entries.length === 0;
  return (
    <select
      className="select"
      data-testid={testid}
      value={value}
      onChange={(e) => onChange(e.target.value)}
      disabled={empty}
      title={empty ? `${label}待采集` : undefined}
    >
      <option value="">{empty ? `${label}（待采集）` : `全部${label}`}</option>
      {!empty && entries.map((e) => (
        <option key={e.id} value={e.id}>{e.label}</option>
      ))}
    </select>
  );
}

interface BankQuestionCardProps {
  question: Question;
  /** 列表序号（跨页连续，与组卷网题卡一致） */
  no: number;
  manage: boolean;
  selected: boolean;
  /** 字典标签预算结果（父层算好，保持 memo 浅比较有效） */
  typeLabel?: string;
  difficultyLabel?: string;
  /** 0054（只增）：已挂知识树节点（父层按页读取后下发；缺省/空数组=不渲染「知识点」行） */
  linkedNodes?: TreeNode[];
  /** 0056（R-041）：上次整理失败（题卡可见标记 + 重试入口；未传 = 不渲染整理面） */
  aiCleanFailed?: boolean;
  onAiClean?: (id: string) => void;
  onToggleSelected: (id: string) => void;
  onPick?: (id: string) => void;
  onEdit: (q: Question) => void;
  onDelete: (q: Question) => void;
}

/**
 * fix-1b：单层完整题卡（列表收起态即题卡，无「详情」两级展开）。
 * memo 隔离列表重渲染；答案/解析折叠态是卡片局部状态（翻页/卸载即复位）。
 */
const BankQuestionCard = memo(function BankQuestionCard({
  question: q, no, manage, selected, typeLabel, difficultyLabel, linkedNodes,
  aiCleanFailed, onAiClean, onToggleSelected, onPick, onEdit, onDelete,
}: BankQuestionCardProps) {
  const [answerOpen, setAnswerOpen] = useState(false);
  const [analysisOpen, setAnalysisOpen] = useState(false);
  const hasAnswer = Boolean(q.answer && q.answer.trim());
  const hasAnalysis = Boolean(q.analysis && q.analysis.trim());

  return (
    <li
      data-testid={`bank-item-${q.id}`}
      data-selected={selected}
      className={selected ? 'q-item selected' : 'q-item'}
    >
      {/* 题卡主体：[勾选] 序号 + 完整题干（公式/图随内容流，与采集预览同管线同容器） */}
      <div style={{ display: 'flex', gap: '0.5rem', alignItems: 'flex-start' }}>
        {manage && (
          <input
            type="checkbox"
            data-testid={`bank-select-${q.id}`}
            checked={selected}
            onChange={() => onToggleSelected(q.id)}
            style={{ marginTop: '0.35rem' }}
          />
        )}
        <span data-testid={`bank-qno-${q.id}`} className="q-no" style={{ flex: '0 0 auto', fontWeight: 700, lineHeight: 1.9, color: 'var(--orange-deep)', fontFamily: 'var(--font-serif)' }}>{no}.</span>
        <div
          className="question-content"
          data-testid={`bank-stem-${q.id}`}
          style={{ flex: 1, minWidth: 0 }}
          dangerouslySetInnerHTML={{ __html: questionCardHtml(q) }}
        />
      </div>

      {/* 答案/解析折叠层：默认收起；无内容钮灰显不可点（题干已完整在上方，保留单独读题能力） */}
      <div style={{ display: 'flex', gap: '0.4rem', marginTop: '0.5rem' }}>
        <button
          className="btn btn-sm"
          data-testid={`bank-answer-toggle-${q.id}`}
          aria-pressed={answerOpen}
          disabled={!hasAnswer}
          title={hasAnswer ? undefined : '该题无答案'}
          onClick={() => setAnswerOpen((v) => !v)}
        >
          答案
        </button>
        <button
          className="btn btn-sm"
          data-testid={`bank-analysis-toggle-${q.id}`}
          aria-pressed={analysisOpen}
          disabled={!hasAnalysis}
          title={hasAnalysis ? undefined : '该题无解析'}
          onClick={() => setAnalysisOpen((v) => !v)}
        >
          解析
        </button>
      </div>
      {answerOpen && hasAnswer && (
        <div className="answer-field" data-testid={`bank-answer-${q.id}`} style={{ color: 'var(--brick)', marginTop: '0.4rem' }}>
          <strong>答案：</strong>
          <span dangerouslySetInnerHTML={{ __html: renderPaperQuestionHtml(q.answer ?? '') }} />
        </div>
      )}
      {analysisOpen && hasAnalysis && (
        <div className="analysis-field" data-testid={`bank-analysis-${q.id}`} style={{ color: 'var(--brick)', marginTop: '0.4rem' }}>
          <strong>解析：</strong>
          <span dangerouslySetInnerHTML={{ __html: renderPaperQuestionHtml(q.analysis ?? '') }} />
        </div>
      )}

      {/* 元信息行：来源 · 题型 · 难度 · 知识点（徽标化小字，不抢题干）+ 操作 */}
      <div className="q-meta" style={{ marginTop: '0.5rem' }}>
        <span className={q.sourceType === 'network' ? 'tag tag-green' : 'tag tag-brick'}>
          {sourceLabel(q)}
        </span>
        {typeLabel && (
          <span className="tag tag-orange">
            {typeLabel}
          </span>
        )}
        {difficultyLabel && (
          <span className="tag">
            {difficultyLabel}
          </span>
        )}
        {(q.knowledgePoints ?? []).map((kp) => (
          <span
            key={kp}
            data-testid={`bank-kp-${q.id}-${kp}`}
            title="采集来源的知识点原文"
            className="tag"
          >
            {kp}
          </span>
        ))}
        <span style={{ flex: 1 }} />
        {onPick ? (
          <button className="btn btn-sm btn-primary" data-testid={`bank-pick-${q.id}`} onClick={() => onPick(q.id)}>选入</button>
        ) : (
          <>
            {/* 0056（R-041）：单题「整理本题」入口（失败时带可见标记与重试语义——点它即重进弹层） */}
            {onAiClean && (
              <>
                <button className="btn btn-sm" data-testid={`bank-ai-clean-${q.id}`} onClick={() => onAiClean(q.id)}>整理本题</button>
                {aiCleanFailed && (
                  <span className="tag tag-brick" data-testid={`bank-ai-clean-failed-${q.id}`}>整理失败</span>
                )}
              </>
            )}
            <button className="btn btn-sm" data-testid={`bank-edit-${q.id}`} onClick={() => onEdit(q)}>编辑</button>
            <button
              className="btn btn-sm"
              data-testid={`bank-delete-${q.id}`}
              onClick={() => onDelete(q)}
              style={{ color: 'var(--brick)' }}
            >
              删除
            </button>
          </>
        )}
      </div>

      {/* 0054 目检反馈：标签 / 知识点两行——来源不分（AI 打标建议 / 批量打标 / 手动打的标签；
          录题台采纳、AI 节点建议、采集挂树反查写下的树节点）；两行都空时不渲染（不占版面）。
          采集链写入的站点知识点原文（knowledgePoints）仍留在上面的元信息行，两处并存。 */}
      {(q.tags ?? []).length > 0 && (
        <div className="q-meta" data-testid={`bank-qtags-${q.id}`} style={{ marginTop: '0.35rem' }}>
          <span style={{ color: 'var(--ink-3)', fontSize: '0.75rem' }}>标签</span>
          {(q.tags ?? []).map((tag) => (
            <span key={tag} data-testid={`bank-qtag-${q.id}-${tag}`} title="标签" className="tag tag-orange">
              {tag}
            </span>
          ))}
        </div>
      )}
      {(linkedNodes ?? []).length > 0 && (
        <div className="q-meta" data-testid={`bank-qnodes-${q.id}`} style={{ marginTop: '0.2rem' }}>
          <span style={{ color: 'var(--ink-3)', fontSize: '0.75rem' }}>知识点</span>
          {(linkedNodes ?? []).map((node) => (
            <span key={node.id} data-testid={`bank-qnode-${q.id}-${node.id}`} title="已挂知识树节点" className="tag tag-green">
              {node.name}
            </span>
          ))}
        </div>
      )}
    </li>
  );
});

export function BankBrowser({ svc: injected, onPick, excludeIds = [], aiClean: injectedAiClean }: BankBrowserProps) {
  const svc = useExtPageServices(injected);
  const manage = !onPick;
  // 0056（R-041）：AI 整理运行面（桥取用单源见 question-ai-clean-client.ts；无桥 = 入口不渲染）
  const aiClean = useMemo<AiCleanRunner | null>(() => injectedAiClean ?? createAiCleanRunner(), [injectedAiClean]);
  const [questions, setQuestions] = useState<Question[]>([]);
  /** 0054（只增）：题 id → 已挂知识树节点（题卡「知识点」行；随题目列表一起刷新） */
  const [questionNodes, setQuestionNodes] = useState<Map<string, TreeNode[]>>(new Map());
  const [subjects, setSubjects] = useState<DictEntry[]>([]);
  const [types, setTypes] = useState<DictEntry[]>([]);
  const [difficulties, setDifficulties] = useState<DictEntry[]>([]);
  // 0006-fix-1：树面板真实数据态（学段→学科→树级联 + 节点浏览）
  // 0014 改版：学段/学科两下拉上移顶栏（单真源）——treeStage 即顶栏学段选择；
  //   树学科不再持有独立状态，从顶栏 subjectId 派生（wantedSubjectKey）
  const [trees, setTrees] = useState<Tree[]>([]);
  // 0006-fix-2：树学科归一反查表（含站点行；展示用 subjects 归一行不动）
  const [subjectDict, setSubjectDict] = useState<DictEntry[]>([]);
  // 0024 P3（P-12 / D-049）：学段-学科迁入共享状态模块（后续 AI 入口同源单状态）；
  // 模块挂载生命周期对齐改造前 useState——最后一个消费者卸载即复位（离开题库页再回来仍是默认）
  const { stage: treeStage, subjectId, setStage: setTreeStage, setSubjectId } = useStageSubject();
  const [treeType, setTreeType] = useState<TreeType>('knowledge');
  const [treeId, setTreeId] = useState('');
  const [treeNodes, setTreeNodes] = useState<TreeNode[]>([]);
  const [treeOpen, setTreeOpen] = useState<ReadonlySet<string>>(new Set());
  // 0014 挂树筛题：点左栏节点 → listQuestions({ treeNodeId })
  const [selectedNodeId, setSelectedNodeId] = useState('');
  const [loading, setLoading] = useState(true);

  // 筛选态
  const [keyword, setKeyword] = useState('');
  // subjectId 见上方共享状态模块（0024 P3）；此处不再持有本地学科态
  const [typeId, setTypeId] = useState('');
  // 0014 题型多值（「选择题」聚合展开）；typeId 与 typeIds 同现时契约口径 typeId 优先
  const [typeIds, setTypeIds] = useState<string[]>([]);
  const [difficultyId, setDifficultyId] = useState('');
  const [sourceType, setSourceType] = useState('');

  // fix-1 B：分页 + 多选（选中集合跨页保留）
  const [page, setPage] = useState(1);
  const [selectedIds, setSelectedIds] = useState<string[]>([]);

  // 编辑 / 删除（fix-1b：题卡无展开态，答案/解析折叠态下沉到 BankQuestionCard）
  const [editing, setEditing] = useState<Question | null>(null);
  const [editAnswer, setEditAnswer] = useState('');
  const [editAnalysis, setEditAnalysis] = useState('');
  /** 0045 目检返工⑤：题面/答案/解析三区受控插入句柄（保存时统一取当前契约 HTML） */
  const stemApiRef = useRef<QuestionEditorApi | null>(null);
  const answerApiRef = useRef<QuestionEditorApi | null>(null);
  const analysisApiRef = useRef<QuestionEditorApi | null>(null);
  const [deleting, setDeleting] = useState<Question | null>(null);
  const [message, setMessage] = useState<PageMessage | null>(null);

  // fix-1 F1：批量动作弹层
  const [batchDeleteOpen, setBatchDeleteOpen] = useState(false);
  const [batchTagOpen, setBatchTagOpen] = useState(false);
  const [batchTagInput, setBatchTagInput] = useState('');
  const [batchMistakeOpen, setBatchMistakeOpen] = useState(false);
  const [students, setStudents] = useState<Student[]>([]);
  const [studentKeyword, setStudentKeyword] = useState('');
  const [selectedStudentIds, setSelectedStudentIds] = useState<string[]>([]);
  const [batchBusy, setBatchBusy] = useState(false);

  // 0014 目检返工：批量加篮改弹窗选篮（点击时实时重查）——0011 内联目标下拉退役
  const [basketModalOpen, setBasketModalOpen] = useState(false);
  const [basketOptions, setBasketOptions] = useState<Array<{ id: string; title: string; count: number }>>([]);
  const [basketPickedId, setBasketPickedId] = useState('');
  // 0055（R-063，吸收 R-048）：弹层内新建试题篮（行内输入 → 即建并选中，弹层不关）+ 每张篮卡行内重命名
  const [basketNewTitle, setBasketNewTitle] = useState('');
  const [basketNewBusy, setBasketNewBusy] = useState(false);
  const [renameBasketId, setRenameBasketId] = useState<string | null>(null);
  const [renameBasketTitle, setRenameBasketTitle] = useState('');
  // 0029（只增）：AI 建议（挂树/打标）人确认弹层
  const [aiSuggestOpen, setAiSuggestOpen] = useState(false);
  // 0056（R-041）：AI 整理对照弹层（批量=选中集；单题=题卡入口）+ 上次整理失败的题 id（题卡标记用）
  const [aiCleanTargets, setAiCleanTargets] = useState<string[] | null>(null);
  const [aiCleanFailed, setAiCleanFailed] = useState<ReadonlySet<string>>(new Set());

  // 字典标签反查（typeId/difficultyId → 显示名；旧平面字段直接显示）
  const typeLabel = (q: Question): string | undefined => {
    if (q.typeId) return types.find((e) => e.id === q.typeId)?.label ?? q.questionType;
    return q.questionType;
  };
  const difficultyLabel = (q: Question): string | undefined => {
    if (q.difficultyId) return difficulties.find((e) => e.id === q.difficultyId)?.label;
    return q.difficulty !== undefined ? (DIFFICULTY_TEXT[q.difficulty] ?? `难度${q.difficulty}`) : undefined;
  };

  // 0006-fix-1 / fix-2：树级联——学段→学科（归一去重）→类型（知识点挑题/章节挑题）→树。
  // 0014 单真源改版：学段=顶栏 bank-filter-stage 的选择；学科从顶栏 subjectId 派生
  // （顶栏 value=字典条目 id 'subj:{code}'，groupKeyOfSubject 剥前缀得归一 code）；
  // 顶栏未选学科或该学段无此科树时回落首组（树列表始终有内容，不因联动落空）。
  // 0014 目检返工：学段升级为筛题维度——''（全部学段）不过滤题目、树级联跨学段混列；
  // 具体学段=题目只显示挂在该学段树上的题（未挂树题隐藏），树级联收敛到该学段。
  const stageOf = (t: Tree) => t.stage || '未分组';
  const treeStages = Array.from(new Set(trees.map(stageOf)));
  const effStage = treeStage !== '' && treeStages.includes(treeStage) ? treeStage : '';
  const stageTrees = effStage === '' ? trees : trees.filter((t) => stageOf(t) === effStage);
  // 学科分组键：命中 dict 归一 → code（三格式并组）；未命中 → 原文独立成组（不静默并错）
  const treeSubjectKeys = Array.from(new Set(stageTrees.map((t) => groupKeyOfSubject(t.subjectId, siteOfTree(t.source, t.name), subjectDict))));
  const wantedSubjectKey = subjectId ? groupKeyOfSubject(subjectId, undefined, subjectDict) : '';
  const effSubject = treeSubjectKeys.includes(wantedSubjectKey) ? wantedSubjectKey : (treeSubjectKeys[0] ?? '');
  const subjectTrees = stageTrees.filter((t) => groupKeyOfSubject(t.subjectId, siteOfTree(t.source, t.name), subjectDict) === effSubject);
  // 类型级：知识点树 / 教材章节树（用户拍板两套体系分开；标签照站点用语），级内默认知识点
  const treeTypes = (['knowledge', 'textbook'] as const).filter((tp) => subjectTrees.some((t) => t.type === tp));
  const effType = treeTypes.includes(treeType) ? treeType : (treeTypes[0] ?? 'knowledge');
  const typedTrees = subjectTrees.filter((t) => t.type === effType);
  const effTreeId = typedTrees.some((t) => t.id === treeId) ? treeId : (typedTrees[0]?.id ?? '');
  const treeTypeLabel = (tp: TreeType) => (tp === 'textbook' ? '章节挑题' : '知识点挑题');

  async function loadDicts() {
    const [subj, tp, diff, trees] = await Promise.all([
      svc.ext.dict.listEntries({ kind: 'subject', activeOnly: true }),
      svc.ext.dict.listEntries({ kind: 'question_type', activeOnly: true }),
      svc.ext.dict.listEntries({ kind: 'difficulty', activeOnly: true }),
      svc.ext.tree.listTrees({}),
    ]);
    // 归一行在前（site=null）供下拉；站点同义行不进 UI
    setSubjects(subj.filter((e) => !e.site));
    setTypes(tp.filter((e) => !e.site));
    setDifficulties(diff.filter((e) => !e.site));
    setTrees(trees);
    // 0006-fix-2：树学科分组另用 subject 全量字典（含站点行）——站点原文 segment/中文名反查归一
    setSubjectDict(subj);
  }

  async function loadQuestions() {
    const list = await svc.bank.listQuestions({
      ...(subjectId ? { subjectId } : {}),
      ...(typeId ? { typeId } : typeIds.length > 0 ? { typeIds } : {}),
      ...(difficultyId ? { difficultyId } : {}),
      ...(selectedNodeId ? { treeNodeId: selectedNodeId } : {}),
      ...(effStage ? { stage: effStage } : {}),
      ...(keyword.trim() ? { keyword: keyword.trim() } : {}),
    });
    // 来源（sourceType 平面字段）客户端过滤
    const finalList = sourceType ? list.filter((q) => q.sourceType === sourceType) : list;
    setQuestions(finalList);
    // 0054（只增）：题卡「知识点」行 = 该题已挂的树节点（含采集挂树反查结果）。
    // 逐题读本地 IPC（每页 ≤ BANK_PAGE_SIZE 次）；读不到按空处理，不影响列表主流程。
    const nodeEntries = await Promise.all(finalList.map(async (q) => {
      try {
        return [q.id, await svc.ext.tree.getQuestionNodes(q.id)] as const;
      } catch {
        return [q.id, [] as TreeNode[]] as const;
      }
    }));
    setQuestionNodes(new Map(nodeEntries));
  }

  useEffect(() => {
    loadDicts()
      .catch((err) => setMessage({ type: 'error', text: `字典/树加载失败：${err instanceof Error ? err.message : String(err)}` }))
      .finally(() => setLoading(false));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [svc]);

  // typeIds 是数组引用态，effect 依赖用其序列化键（聚合/单值切换才触发重查）
  const typeIdsKey = typeIds.join('\u0000');

  useEffect(() => {
    const timer = setTimeout(() => {
      loadQuestions().catch((err) => setMessage({ type: 'error', text: `题目加载失败：${err instanceof Error ? err.message : String(err)}` }));
    }, keyword ? 200 : 0);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [svc, keyword, subjectId, typeId, typeIdsKey, difficultyId, sourceType, selectedNodeId, effStage]);

  // fix-1 B：筛选/关键词变化重置第 1 页（选中集合不清——由「取消选择」控制）
  useEffect(() => {
    setPage(1);
  }, [keyword, subjectId, typeId, typeIdsKey, difficultyId, sourceType, selectedNodeId, effStage]);


  useEffect(() => {
    setTreeNodes([]);
    setTreeOpen(new Set());
    setSelectedNodeId(''); // 0014：换树后原选中节点不属于新树，筛题态一并清空
    if (!effTreeId) return;
    let cancelled = false;
    svc.ext.tree.getNodes(effTreeId)
      .then((ns) => {
        if (cancelled) return;
        setTreeNodes(ns);
        // 2026-09-23 目检反馈：题库页左栏树一级节点也**默认折叠**（原「默认展开一级」只保留在
        // 录题台的知识节点选择弹层里——那里是选节点场景，铺开更省事）；展开/收起全由用户掌握。
      })
      .catch((err) => setMessage({ type: 'error', text: `树节点加载失败：${err instanceof Error ? err.message : String(err)}` }));
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [svc, effTreeId]);

  // 父子索引（sort 排序）；parentId 悬空（父不在本树）按根处理
  const treeByParent = buildParentIndex(treeNodes, { sort: true });

  // 0014 面包屑：选中节点自根到叶路径（child→parent 反查；guard 防数据环）
  const treeParentOf = new Map<string, string>();
  for (const [pid, list] of treeByParent) {
    for (const n of list) treeParentOf.set(n.id, pid);
  }
  const crumbLabels: string[] = [];
  {
    const nodeById = new Map(treeNodes.map((n) => [n.id, n]));
    let cur = selectedNodeId ? nodeById.get(selectedNodeId) : undefined;
    let guard = 0;
    while (cur && guard++ < 64) {
      crumbLabels.unshift(cur.name);
      const pid = treeParentOf.get(cur.id);
      cur = pid ? nodeById.get(pid) : undefined;
    }
  }

  // 0014 选择题聚合成员：字典行 code 标准码驱动（single-choice + multi-choice），禁硬编码字典 id；
  // 缺任一行 → 聚合项隐没（不渲染半档）
  const choiceMembers = types.filter((e) => e.code === 'single-choice' || e.code === 'multi-choice');
  const hasChoiceGroup = choiceMembers.length === 2;

  const toggleTreeNode = (id: string) => {
    setTreeOpen((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  };

  const visible = questions.filter((q) => !excludeIds.includes(q.id));
  // fix-1 B：分页切片（页码越界回落到最后一页，避免筛选后空白）
  const totalPages = Math.max(1, Math.ceil(visible.length / BANK_PAGE_SIZE));
  const currentPage = Math.min(page, totalPages);
  const pageItems = visible.slice((currentPage - 1) * BANK_PAGE_SIZE, currentPage * BANK_PAGE_SIZE);

  const selectedOnPage = pageItems.filter((q) => selectedIds.includes(q.id));
  const allPageSelected = pageItems.length > 0 && selectedOnPage.length === pageItems.length;

  // fix-1b：卡片回调 useCallback 稳定引用（BankQuestionCard 的 memo 才有效——否则每渲染新函数必重渲）
  const toggleSelected = useCallback((id: string) => {
    setSelectedIds((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]));
  }, []);

  const toggleSelectPage = () => {
    setSelectedIds((prev) => (allPageSelected
      ? prev.filter((id) => !pageItems.some((q) => q.id === id))
      : [...new Set([...prev, ...pageItems.map((q) => q.id)])]));
  };

  const clearSelection = () => setSelectedIds([]);

  const openEdit = useCallback((q: Question) => {
    setEditing(q);
    setEditAnswer(q.answer ?? '');
    setEditAnalysis(q.analysis ?? '');
  }, []);

  const requestDelete = useCallback((q: Question) => setDeleting(q), []);

  // 0056（R-041）：整理入口（批量=选中集 / 单题=题卡「整理本题」）；结果回填失败标记（题卡可见）
  const openAiClean = useCallback((ids: string[]) => setAiCleanTargets(ids), []);
  const openAiCleanOne = useCallback((id: string) => setAiCleanTargets([id]), []);
  const handleAiCleanResult = useCallback((failedIds: string[]) => {
    setAiCleanFailed((prev) => {
      const next = new Set(prev);
      for (const id of failedIds) next.add(id);
      for (const id of aiCleanTargets ?? []) if (!failedIds.includes(id)) next.delete(id);
      return next;
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [aiCleanTargets]);

  const handleEditSave = async () => {
    if (!editing) return;
    try {
      // 0045 目检返工⑤：题面/答案/解析三区均为编辑器——保存时从各自句柄取当前契约 HTML
      // （任一工具条的 💾 都保存整题；未编辑的区取回原值，行为与旧 textarea 口径一致）
      const content = stemApiRef.current?.getHtml() ?? editing.content;
      const answerRaw = answerApiRef.current?.getHtml();
      const answer = answerRaw !== undefined ? unwrapFromEditor(answerRaw) : editAnswer;
      const analysisRaw = analysisApiRef.current?.getHtml();
      const analysis = analysisRaw !== undefined ? unwrapFromEditor(analysisRaw) : editAnalysis;
      await svc.bank.updateQuestion(editing.id, {
        content,
        ...(answer.trim() ? { answer } : { answer: undefined }),
        ...(analysis.trim() ? { analysis } : { analysis: undefined }),
      });
      setEditing(null);
      setMessage({ type: 'success', text: '题目已更新' });
      await loadQuestions();
    } catch (err) {
      setMessage({ type: 'error', text: `更新失败：${err instanceof Error ? err.message : String(err)}` });
    }
  };

  const handleDelete = async () => {
    if (!deleting) return;
    try {
      await svc.bank.deleteQuestion(deleting.id);
      setDeleting(null);
      setMessage({ type: 'success', text: '题目已从题库删除（软删）' });
      await loadQuestions();
    } catch (err) {
      setMessage({ type: 'error', text: `删除失败：${err instanceof Error ? err.message : String(err)}` });
    }
  };

  // ---------- fix-1 F1：批量动作（逐题循环既有通道；单题失败跳过并计入提示，不整批回滚） ----------

  const handleBatchDelete = async () => {
    const ids = [...selectedIds];
    setBatchDeleteOpen(false);
    setBatchBusy(true);
    let ok = 0;
    let failed = 0;
    for (const id of ids) {
      try {
        await svc.bank.deleteQuestion(id);
        ok++;
      } catch {
        failed++;
      }
    }
    setBatchBusy(false);
    clearSelection();
    await loadQuestions().catch(() => {});
    setMessage({
      type: failed > 0 ? 'error' : 'success',
      text: `批量删除 ${ids.length} 题：成功 ${ok} 题，失败 ${failed} 题`,
    });
  };

  const handleBatchTag = async () => {
    const tag = batchTagInput.trim();
    if (!tag) {
      setMessage({ type: 'error', text: '标签名不能为空' });
      return;
    }
    const ids = [...selectedIds];
    setBatchTagOpen(false);
    setBatchBusy(true);
    let ok = 0;
    let failed = 0;
    for (const id of ids) {
      try {
        await svc.bank.addTag(id, tag);
        ok++;
      } catch {
        failed++;
      }
    }
    setBatchBusy(false);
    clearSelection();
    setBatchTagInput('');
    await loadQuestions().catch(() => {});
    setMessage({
      type: failed > 0 ? 'error' : 'success',
      text: `批量添加标签「${tag}」${ids.length} 题：成功 ${ok} 题，失败 ${failed} 题`,
    });
  };

  const openBatchMistake = () => {
    setSelectedStudentIds([]);
    setStudentKeyword('');
    setBatchMistakeOpen(true);
    svc.ext.student.listStudents({ includeArchived: true })
      .then(setStudents)
      .catch((err) => setMessage({ type: 'error', text: `学生列表加载失败：${err instanceof Error ? err.message : String(err)}` }));
  };

  const handleBatchMistake = async () => {
    const questionIds = [...selectedIds];
    const studentIds = [...selectedStudentIds];
    if (studentIds.length === 0) {
      setMessage({ type: 'error', text: '请先勾选学生' });
      return;
    }
    setBatchMistakeOpen(false);
    setBatchBusy(true);
    const occurredAt = new Date().toISOString();
    let ok = 0;
    let failed = 0;
    for (const questionId of questionIds) {
      for (const studentId of studentIds) {
        try {
          await svc.ext.mistake.recordWrong({ questionId, studentId, occurredAt });
          ok++;
        } catch {
          failed++;
        }
      }
    }
    setBatchBusy(false);
    clearSelection();
    setMessage({
      type: failed > 0 ? 'error' : 'success',
      text: `标记 ${questionIds.length} 题 × ${studentIds.length} 生：成功 ${ok} 项，失败 ${failed} 项`,
    });
  };

  // 0014 目检返工：批量加篮两步——点击先实时重查处理中卷（≥1 张弹窗卡片选篮），
  // 确认后按选中篮执行加入（沿用 0011 去重/计数文案）。返工二：卡片框形态 + 各篮题数 + 长名截断。
  // 0055（R-063）：0 篮早退放宽——弹层照开、列表为空、新建行为唯一入口（不再「请先新建试题篮」拦在门外）
  const openBatchBasket = async () => {
    try {
      const papers = await svc.ext.paper.listPapersEx();
      const inFlight = papers.filter((p) => isPaperInFlight(p.paper.status));
      const options = await Promise.all(inFlight.map(async (p) => ({
        id: p.paper.id,
        title: p.paper.title,
        count: await svc.bank.getPaperQuestions(p.paper.id).then((rows) => rows.length).catch(() => 0),
      })));
      setBasketOptions(options);
      setBasketPickedId(options[0]?.id ?? '');
      setBasketNewTitle('');
      setRenameBasketId(null);
      setBasketModalOpen(true);
    } catch (err) {
      setMessage({ type: 'error', text: `试题篮加载失败：${err instanceof Error ? err.message : String(err)}` });
    }
  };

  /** 0055（R-063）：弹层内现场新建试题篮——即建并选中（弹层不关，可连续建）；建完直接「确认加入」 */
  const createBasketInModal = async () => {
    const title = basketNewTitle.trim();
    if (!title || basketNewBusy) return;
    setBasketNewBusy(true);
    try {
      const paper = await svc.bank.createPaper(title);
      // 真实列表按 created_at DESC（最新在前）——新建的排最前，与复核口径一致
      setBasketOptions((cur) => [{ id: paper.id, title: paper.title, count: 0 }, ...cur]);
      setBasketPickedId(paper.id);
      setBasketNewTitle('');
    } catch (err) {
      setMessage({ type: 'error', text: `新建试题篮失败：${err instanceof Error ? err.message : String(err)}` });
    } finally {
      setBasketNewBusy(false);
    }
  };

  /** 0055（R-063）：篮卡行内重命名（复用既有 updatePaperTitle 全链，零新通道） */
  const confirmRenameBasket = async (id: string) => {
    const next = renameBasketTitle.trim();
    if (!next) return;
    try {
      const updated = await svc.ext.paper.updatePaperTitle(id, next);
      setBasketOptions((cur) => cur.map((p) => (p.id === id ? { ...p, title: updated.title } : p)));
      setRenameBasketId(null);
    } catch (err) {
      setMessage({ type: 'error', text: `重命名失败：${err instanceof Error ? err.message : String(err)}` });
    }
  };

  const confirmBatchBasket = async () => {
    const ids = [...selectedIds];
    const target = basketOptions.find((p) => p.id === basketPickedId) ?? basketOptions[0];
    if (!target) {
      // 0055：0 篮且未现场新建——不静默（弹层保持打开，可从新建行建一个再确认）
      setMessage({ type: 'error', text: '请先新建试题篮' });
      return;
    }
    setBasketModalOpen(false);
    try {
      const existing = new Set((await svc.bank.getPaperQuestions(target.id)).map((r) => r.questionId));
      const toAdd = ids.filter((id) => !existing.has(id));
      setBatchBusy(true);
      let ok = 0;
      let failed = 0;
      for (const id of toAdd) {
        try {
          await svc.bank.addQuestion(target.id, id);
          ok++;
        } catch {
          failed++;
        }
      }
      setBatchBusy(false);
      clearSelection();
      const skipped = ids.length - toAdd.length;
      setMessage({
        type: failed > 0 ? 'error' : 'success',
        text: `已加入试题篮「${target.title}」：成功 ${ok} 题`
          + `${skipped > 0 ? `，跳过已在篮 ${skipped} 题` : ''}`
          + `${failed > 0 ? `，失败 ${failed} 题` : ''}`,
      });
    } catch (err) {
      setBatchBusy(false);
      setMessage({ type: 'error', text: `加入试题篮失败：${err instanceof Error ? err.message : String(err)}` });
    }
  };

  const visibleStudents = students.filter((s) => {
    const kw = studentKeyword.trim().toLowerCase();
    if (!kw) return true;
    return s.name.toLowerCase().includes(kw) || (s.studentNo ?? '').toLowerCase().includes(kw);
  });

  // ---------- fix-1b：列表 = 题卡直显（形态见 BankQuestionCard；无收起/展开两级结构） ----------

  return (
    <div data-testid="bank-browser" className="bank-browser-root">
      {/* 0014 两栏布局：左树右列表（theme.css .bank-layout；≤900px 窄窗降级单列） */}
      <div className="bank-layout" data-testid="bank-layout">
        {/* 左栏：树面板（0006-fix-1 迁入；0014 删树面板自带学段/学科下拉——单真源上移顶栏） */}
        <aside className="bank-side" data-testid="bank-side">
          {trees.length === 0 ? (
            <div
              data-testid="bank-tree-empty"
              data-tree-empty="true"
              className="card card-dashed"
              style={{
                padding: '0.5rem 0.75rem', fontSize: '0.85rem',
                color: 'var(--ink-2)', boxShadow: 'none',
              }}
            >
              知识树待采集（后续版本）
            </div>
          ) : (
            <div
              data-testid="bank-tree-panel"
              className="card"
              style={{
                padding: '0.5rem 0.75rem', fontSize: '0.85rem',
                boxShadow: 'none',
              }}
            >
              <div style={{ display: 'flex', flexDirection: 'column', gap: '0.35rem' }}>
                <select
                  className="select"
                  data-testid="bank-tree-type"
                  value={effType}
                  onChange={(e) => { setTreeType(e.target.value as TreeType); setTreeId(''); }}
                >
                  {treeTypes.map((tp) => <option key={tp} value={tp}>{treeTypeLabel(tp)}</option>)}
                </select>
                <select
                  className="select"
                  data-testid="bank-tree-select"
                  value={effTreeId}
                  onChange={(e) => setTreeId(e.target.value)}
                >
                  {typedTrees.map((t) => <option key={t.id} value={t.id}>{displayTreeName(t.name)}</option>)}
                </select>
                <span data-testid="bank-tree-node-count" style={{ color: 'var(--ink-3)', fontSize: '0.8rem' }}>
                  {treeNodes.length} 节点
                </span>
              </div>
              <div data-testid="bank-tree-nodes" className="tree bank-side-tree" style={{ overflowY: 'auto', marginTop: '0.4rem' }}>
                <TreeNodeRows byParent={treeByParent} parentId="" depth={0} open={treeOpen} onToggle={toggleTreeNode} selectedId={selectedNodeId} onSelect={setSelectedNodeId} skipRootNames={TREE_ROOT_NAMES} />
              </div>
              <div style={{ fontSize: '0.75rem', color: 'var(--ink-3)', marginTop: '0.3rem' }}>
                点节点按知识点筛题（含其子孙节点挂题）；点 ▸ 折叠/展开
              </div>
            </div>
          )}
        </aside>

        {/* 右栏：0014 目检返工二——固定头（筛选栏/消息/选中条/面包屑）+ 滚动体（题卡列表/分页）。
         * 仅题库页（.bank-page 祖先）启用内部滚动；pick 弹层无该祖先，自然流不受影响 */}
        <div className="bank-main" data-testid="bank-main">
          <div className="bank-main-fixed">
          <div className="filter-bar" style={{ marginBottom: '0.75rem' }}>
            <input
              className="input"
              data-testid="bank-keyword-input"
              placeholder="搜题干关键词…"
              value={keyword}
              onChange={(e) => setKeyword(e.target.value)}
              style={{ flex: '1 1 160px' }}
            />
            {/* 0014：学段上移顶栏（数据源=树面板级联既有学段集合；与左侧树单真源联动）。
             * 0014 目检返工：学段升级为筛题维度——首项「全部学段」（默认不过滤），具体学段只显示挂树题 */}
            <select
              className="select"
              data-testid="bank-filter-stage"
              value={effStage}
              onChange={(e) => setTreeStage(e.target.value)}
              disabled={treeStages.length === 0}
              title={treeStages.length === 0 ? '学段待树数据' : (effStage ? `只显示挂在「${effStage}」树上的题` : undefined)}
            >
              <option value="">全部学段</option>
              {treeStages.map((s) => <option key={s} value={s}>{s}</option>)}
            </select>
            <DictSelect label="学科" entries={subjects} value={subjectId} onChange={setSubjectId} testid="bank-filter-subject" />
            {/* 0014：题型聚合（选择题=单选+多选展开 typeIds；成员由字典行 code 驱动） */}
            <select
              className="select"
              data-testid="bank-filter-type"
              value={typeIds.length > 0 ? CHOICE_GROUP_VALUE : typeId}
              onChange={(e) => {
                const v = e.target.value;
                if (v === CHOICE_GROUP_VALUE && hasChoiceGroup) {
                  setTypeIds(choiceMembers.map((m) => m.id));
                  setTypeId('');
                } else {
                  setTypeIds([]);
                  setTypeId(v);
                }
              }}
              disabled={types.length === 0}
              title={types.length === 0 ? '题型待采集' : undefined}
            >
              <option value="">{types.length === 0 ? '题型（待采集）' : '全部题型'}</option>
              {hasChoiceGroup && <option value={CHOICE_GROUP_VALUE}>选择题（含单选/多选）</option>}
              {types.map((e) => <option key={e.id} value={e.id}>{e.label}</option>)}
            </select>
            <DictSelect label="难度" entries={difficulties} value={difficultyId} onChange={setDifficultyId} testid="bank-filter-difficulty" />
            <select
              className="select"
              data-testid="bank-filter-source"
              value={sourceType}
              onChange={(e) => setSourceType(e.target.value)}
            >
              <option value="">全部来源</option>
              <option value="network">网络采集</option>
              <option value="local">本地录入</option>
            </select>
          </div>

          <MessageBanner message={message} />

          {/* fix-1 F1：选中计数条（列表上方常驻，翻页保留选中） */}
          {manage && (
            <div
              data-testid="bank-selection-bar"
              data-selected-count={selectedIds.length}
              className={selectedIds.length > 0 ? 'selection-bar' : 'selection-bar neutral'}
            >
              <span>已选 {selectedIds.length} 项</span>
              <span style={{ flex: 1 }} />
              <button className="btn btn-sm" data-testid="bank-batch-delete-btn" disabled={selectedIds.length === 0 || batchBusy} onClick={() => setBatchDeleteOpen(true)}>批量删除</button>
              <button className="btn btn-sm" data-testid="bank-batch-tag-btn" disabled={selectedIds.length === 0 || batchBusy} onClick={() => setBatchTagOpen(true)}>批量添加标签</button>
              {/* 0056（R-041）：采集题 AI 整理（公式图/答案图转文字；对照弹层逐题确认才落库） */}
              {aiClean && (
                <button className="btn btn-sm" data-testid="bank-ai-clean-btn" disabled={selectedIds.length === 0 || batchBusy} onClick={() => openAiClean([...selectedIds])}>AI 整理</button>
              )}
              {/* 0029（只增）：AI 建议（挂树/打标）——P-07 人确认闸门在弹层内 */}
              <button className="btn btn-sm" data-testid="bank-ai-suggest-btn" disabled={selectedIds.length === 0 || batchBusy} onClick={() => setAiSuggestOpen(true)}>AI 建议</button>
              <button className="btn btn-sm" data-testid="bank-batch-mistake-btn" disabled={selectedIds.length === 0 || batchBusy} onClick={openBatchMistake}>批量标记错题</button>
              {/* 0014 目检返工：点击弹窗选目标篮（0011 内联目标下拉退役） */}
              <button className="btn btn-sm" data-testid="bank-batch-add-basket-btn" disabled={selectedIds.length === 0 || batchBusy} onClick={() => void openBatchBasket()}>批量加入试题篮</button>
              <button className="btn btn-sm" data-testid="bank-batch-clear-btn" disabled={selectedIds.length === 0} onClick={clearSelection}>取消选择</button>
            </div>
          )}

          {/* 0014 挂树筛题面包屑：根→叶路径 + 清除钮（清除即恢复全量） */}
          {crumbLabels.length > 0 && (
            <div
              className="node-crumb"
              data-testid="bank-node-crumb"
              style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', margin: '0.4rem 0', fontSize: '0.85rem', color: 'var(--ink-2)' }}
            >
              <span>当前节点：{crumbLabels.join(' › ')}</span>
              <button className="btn btn-sm" data-testid="bank-node-crumb-clear" onClick={() => setSelectedNodeId('')}>清除</button>
            </div>
          )}
          </div>

          <div className="bank-main-scroll">
          {loading ? (
            <p>加载中…</p>
          ) : visible.length === 0 ? (
            <div data-testid="bank-empty">
              <EmptyState>暂无题目，去采集或新建题开始积累题库</EmptyState>
            </div>
          ) : (
            <>
              {/* 0014 目检返工一：列表铺满右栏（.bank-question-list width:100%，700px 版心限宽退役）；
               * 图片观感由块图 min(48%,240px)/行内 200px 独立保证 */}
              <ul className="bank-question-list" style={{ listStyle: 'none', padding: 0 }}>
                {pageItems.map((q, index) => (
                  <BankQuestionCard
                    key={q.id}
                    question={q}
                    no={(currentPage - 1) * BANK_PAGE_SIZE + index + 1}
                    manage={manage}
                    selected={selectedIds.includes(q.id)}
                    typeLabel={typeLabel(q)}
                    difficultyLabel={difficultyLabel(q)}
                    linkedNodes={questionNodes.get(q.id)}
                    aiCleanFailed={aiCleanFailed.has(q.id)}
                    onAiClean={aiClean ? openAiCleanOne : undefined}
                    onToggleSelected={toggleSelected}
                    onPick={onPick}
                    onEdit={openEdit}
                    onDelete={requestDelete}
                  />
                ))}
              </ul>

              {/* fix-1 B：分页条（客户端分页，筛选变化重置第 1 页） */}
              <div
                data-testid="bank-pager"
                data-page={currentPage}
                data-total-pages={totalPages}
                style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', marginTop: '0.75rem' }}
              >
                <button className="btn btn-sm" data-testid="bank-prev-page" disabled={currentPage <= 1} onClick={() => setPage(currentPage - 1)}>上一页</button>
                <span data-testid="bank-page-info" style={{ color: 'var(--ink-2)', fontSize: '0.85rem' }}>共 {visible.length} 题 · 第 {currentPage}/{totalPages} 页</span>
                <button className="btn btn-sm" data-testid="bank-next-page" disabled={currentPage >= totalPages} onClick={() => setPage(currentPage + 1)}>下一页</button>
              </div>
            </>
          )}
          </div>
        </div>
      </div>

      {/* 编辑弹层（0045 目检返工⑤：题面 → 答案 → 解析 三区均为编辑器，顺序自上而下；
          第三轮根因修复：三区一律用 EditorField（div），不得用 Field（label）；
          第四轮（用户）：三区工具条的「存回」按钮撤下 → 弹层右下角统一彩色「保存」按钮；
          文本框加高（题面 240 / 答案·解析 160），字段间距收紧） */}
      {editing && (
        <Modal title="编辑题目" onClose={() => setEditing(null)}>
          <div style={{ maxWidth: '760px' }}>
            <EditorField label="题面">
              <QuestionEditor
                key={`stem-${editing.id}`}
                ref={stemApiRef}
                variant="stem"
                showSave={false}
                initialContent={editing.content}
                onSave={handleEditSave}
              />
            </EditorField>
            <EditorField label="答案（可空）">
              <QuestionEditor
                key={`answer-${editing.id}`}
                ref={answerApiRef}
                variant="plain"
                showSave={false}
                initialContent={wrapForEditor(editAnswer)}
                onSave={handleEditSave}
              />
            </EditorField>
            <EditorField label="解析（可空）">
              <QuestionEditor
                key={`analysis-${editing.id}`}
                ref={analysisApiRef}
                variant="plain"
                showSave={false}
                initialContent={wrapForEditor(editAnalysis)}
                onSave={handleEditSave}
              />
            </EditorField>
            <div style={{ display: 'flex', gap: '0.5rem', justifyContent: 'flex-end', marginTop: '0.5rem' }}>
              <button className="btn" onClick={() => setEditing(null)}>取消</button>
              <button className="btn btn-primary" data-testid="bank-edit-save" onClick={() => void handleEditSave()}>
                保存
              </button>
            </div>
          </div>
        </Modal>
      )}

      {/* 软删确认：自绘双按钮弹层（禁 window.confirm） */}
      {deleting && (
        <Modal title="确认删除题目" onClose={() => setDeleting(null)}>
          <p style={{ marginTop: 0 }}>确定从题库删除该题？删除后不再出现在题库与选题列表（已组入试卷的引用不受影响）。</p>
          <div style={{ display: 'flex', gap: '0.5rem', justifyContent: 'flex-end' }}>
            <button className="btn" onClick={() => setDeleting(null)}>取消</button>
            <button
              className="btn btn-danger"
              data-testid="bank-delete-confirm"
              onClick={handleDelete}
            >
              确认删除
            </button>
          </div>
        </Modal>
      )}

      {/* 0014 目检返工：批量加入试题篮——弹窗选目标篮。返工二：卡片框形态（长卷名截断有 title 全文、
       * 大量试题篮时列表内滚、各篮显示现有题数）。
       * 0055（R-063）：0 篮照开（新建行=唯一入口）+ 新建行置顶（目检①；行内输入即建即选，弹层不关）+ 每卡行内重命名 */}
      {basketModalOpen && (
        <Modal title="加入试题篮" onClose={() => setBasketModalOpen(false)}>
          <div data-testid="bank-batch-basket-modal">
            <p style={{ marginTop: 0 }}>将已选 {selectedIds.length} 题加入哪个试题篮（草稿卷）？</p>
            {basketOptions.length === 0 && (
              <p data-testid="bank-batch-basket-empty" style={{ margin: '0 0 8px', color: 'var(--ink-3)', fontSize: '13px' }}>
                还没有试题篮——在最上面那行起个名字新建，再点「确认加入」。
              </p>
            )}
            <div className="basket-pick-list">
              {/* 0055（R-063 / 目检①）：「＋ 新建试题篮」行置顶——先能建，再谈选；
                  形态照录题台 CardFlow（行内输入 + 确定即建并选中，弹层不关） */}
              <div
                data-testid="bank-batch-basket-new-row"
                style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}
              >
                <input
                  className="input"
                  data-testid="bank-batch-basket-new-name"
                  value={basketNewTitle}
                  placeholder="＋ 新建试题篮（填名称）"
                  aria-label="新试题篮名称"
                  onChange={(e) => setBasketNewTitle(e.target.value)}
                  style={{ flex: 1, minWidth: 0 }}
                />
                <button
                  type="button"
                  className="btn btn-sm"
                  data-testid="bank-batch-basket-new-confirm"
                  disabled={!basketNewTitle.trim() || basketNewBusy}
                  onClick={() => void createBasketInModal()}
                >
                  新建
                </button>
              </div>
              {basketOptions.map((p) => (
                <div key={p.id} style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                  {renameBasketId === p.id ? (
                    <span className="basket-pick-card" data-testid={`bank-basket-rename-row-${p.id}`}>
                      <input
                        className="input"
                        data-testid={`bank-basket-rename-input-${p.id}`}
                        value={renameBasketTitle}
                        aria-label="试题篮新名称"
                        onChange={(e) => setRenameBasketTitle(e.target.value)}
                        style={{ flex: 1, minWidth: 0 }}
                      />
                      <button
                        type="button"
                        className="btn btn-sm btn-primary"
                        data-testid={`bank-basket-rename-save-${p.id}`}
                        disabled={!renameBasketTitle.trim()}
                        onClick={() => void confirmRenameBasket(p.id)}
                      >
                        保存
                      </button>
                      <button
                        type="button"
                        className="btn btn-sm"
                        data-testid={`bank-basket-rename-cancel-${p.id}`}
                        onClick={() => setRenameBasketId(null)}
                      >
                        取消
                      </button>
                    </span>
                  ) : (
                    <>
                      <label
                        className={basketPickedId === p.id ? 'basket-pick-card selected' : 'basket-pick-card'}
                        data-testid={`bank-basket-option-${p.id}`}
                        style={{ flex: 1, minWidth: 0 }}
                      >
                        <input
                          type="radio"
                          name="bank-basket-pick"
                          value={p.id}
                          checked={basketPickedId === p.id}
                          onChange={() => setBasketPickedId(p.id)}
                        />
                        <span className="basket-pick-title" title={p.title}>{p.title}</span>
                        <span className="basket-pick-meta">{p.count} 题</span>
                      </label>
                      <button
                        type="button"
                        className="btn btn-sm"
                        data-testid={`bank-basket-rename-${p.id}`}
                        onClick={() => { setRenameBasketId(p.id); setRenameBasketTitle(p.title); }}
                      >
                        重命名
                      </button>
                    </>
                  )}
                </div>
              ))}
            </div>
            <div style={{ display: 'flex', gap: '0.5rem', justifyContent: 'flex-end' }}>
              <button className="btn" onClick={() => setBasketModalOpen(false)}>取消</button>
              <button className="btn btn-primary" data-testid="bank-batch-basket-confirm" disabled={batchBusy} onClick={() => void confirmBatchBasket()}>确认加入</button>
            </div>
          </div>
        </Modal>
      )}

      {/* fix-1 F1：批量删除确认（文案照任务书） */}
      {batchDeleteOpen && (
        <Modal title="确认批量删除" onClose={() => setBatchDeleteOpen(false)}>
          <p data-testid="bank-batch-delete-text" style={{ marginTop: 0 }}>
            删除 {selectedIds.length} 题？软删后不再出现在题库与选题列表（已组入试卷引用不受影响）
          </p>
          <div style={{ display: 'flex', gap: '0.5rem', justifyContent: 'flex-end' }}>
            <button className="btn" onClick={() => setBatchDeleteOpen(false)}>取消</button>
            <button
              className="btn btn-danger"
              data-testid="bank-batch-delete-confirm"
              onClick={() => void handleBatchDelete()}
            >
              确认删除
            </button>
          </div>
        </Modal>
      )}

      {/* fix-1 F1：批量添加标签 */}
      {batchTagOpen && (
        <Modal title="批量添加标签" onClose={() => setBatchTagOpen(false)}>
          <p style={{ marginTop: 0 }}>将为已选 {selectedIds.length} 题添加同一标签。</p>
          <input
            className="input"
            data-testid="bank-batch-tag-input"
            value={batchTagInput}
            onChange={(e) => setBatchTagInput(e.target.value)}
            placeholder="标签名（如：易错题）"
            autoFocus
            style={{ width: '100%', marginBottom: '0.75rem' }}
          />
          <div style={{ display: 'flex', gap: '0.5rem', justifyContent: 'flex-end' }}>
            <button className="btn" onClick={() => setBatchTagOpen(false)}>取消</button>
            <button className="btn btn-primary" data-testid="bank-batch-tag-confirm" onClick={() => void handleBatchTag()}>确认添加</button>
          </div>
        </Modal>
      )}

      {/* fix-1 F1：批量标记错题（学生选择器：搜索 + 多选；照考试登记页学生名单交互） */}
      {batchMistakeOpen && (
        <Modal title="批量标记错题" onClose={() => setBatchMistakeOpen(false)}>
          <p data-testid="bank-batch-mistake-text" style={{ marginTop: 0 }}>
            将为已选 {selectedIds.length} 题登记错题（occurredAt=now，逐题×逐生）。
          </p>
          <input
            className="input"
            data-testid="bank-student-search"
            value={studentKeyword}
            onChange={(e) => setStudentKeyword(e.target.value)}
            placeholder="搜索学生姓名/学号…"
            style={{ width: '100%', marginBottom: '0.5rem' }}
          />
          {students.length === 0 ? (
            <p data-testid="bank-student-empty" style={{ color: 'var(--ink-3)' }}>暂无学生，先到学生管理页建档</p>
          ) : (
            <div data-testid="bank-student-list" style={{ maxHeight: '40vh', overflowY: 'auto', border: '1px solid var(--line)', borderRadius: '8px', padding: '0.4rem' }}>
              {visibleStudents.length === 0 ? (
                <p style={{ color: 'var(--ink-3)' }}>没有匹配的学生</p>
              ) : visibleStudents.map((s) => (
                <label key={s.id} data-testid={`bank-student-${s.name}`} style={{ display: 'block', padding: '0.2rem 0' }}>
                  <input
                    type="checkbox"
                    checked={selectedStudentIds.includes(s.id)}
                    onChange={() => setSelectedStudentIds((prev) => (prev.includes(s.id) ? prev.filter((x) => x !== s.id) : [...prev, s.id]))}
                  />
                  {' '}{s.name}{s.studentNo ? `（${s.studentNo}）` : ''}
                </label>
              ))}
            </div>
          )}
          <p style={{ color: 'var(--ink-2)', fontSize: '0.85rem' }}>已选学生 {selectedStudentIds.length} 名</p>
          <div style={{ display: 'flex', gap: '0.5rem', justifyContent: 'flex-end' }}>
            <button className="btn" onClick={() => setBatchMistakeOpen(false)}>取消</button>
            <button className="btn btn-primary" data-testid="bank-batch-mistake-confirm" onClick={() => void handleBatchMistake()}>确认标记</button>
          </div>
        </Modal>
      )}
      {/* 0029（只增）：AI 挂树/打标建议人确认弹层（写入后刷新列表以反映挂树/标签变化） */}
      {aiSuggestOpen && (
        <AiSuggestDialog
          questionIds={[...selectedIds]}
          onClose={() => setAiSuggestOpen(false)}
          onWritten={() => { void loadQuestions(); }}
          onMessage={setMessage}
          subjectLabel={subjects.find((e) => e.id === subjectId)?.label ?? ''}
        />
      )}
      {/* 0056（R-041）：AI 整理对照确认弹层（D-050 必人确认：确认才落库；失败题回填标记供题卡重试） */}
      {aiClean && aiCleanTargets && (
        <AiCleanDialog
          questionIds={aiCleanTargets}
          runner={aiClean}
          onClose={() => setAiCleanTargets(null)}
          onWritten={() => { void loadQuestions(); }}
          onMessage={setMessage}
          onResult={handleAiCleanResult}
        />
      )}
    </div>
  );
}
