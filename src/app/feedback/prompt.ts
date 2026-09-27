// 0030 P2：提示词组装器（纯函数，任务书 §一 P2 上半；零 IO、零 IPC、零 DOM——可单测）。
//
// 两件事，都不给 AI 留发挥空间：
//   ① 事实注入：把四项输入（课堂内容/课堂表现/课后任务/成绩）按 {中文键} 槽位原样填进模板——
//      AI 只许使用这些内容、不许编造、不许改数字（红线守卫兜底，见 guard.ts）；
//   ② 风格注入：语气 × 篇幅 × 家庭建议三维按档位短语填 {语气}/{篇幅}/{家庭建议} 槽位。
//
// 空值口径（任务书 §一 P2：「成绩可空——空则槽位段整体从提示词剔除（不留「成绩：」空行）」）：
//   某行为「整行只有一个槽位、且该槽位值为空」→ 删整行；槽位与其它内容同行 → 只删槽位本身。
//   规则对课堂表现/课后任务同样生效（同属可空输入，报告申报）。
// 模板未带风格槽位时（用户自定义模板可能删掉了）→ 追加一段【写作要求】，保证风格三维仍然生效。

/** 事实变量七项（D-065① 四项输入 + 目检返工③ 增「课程主题」「备注」；顺序即变量面板展示序） */
export const FEEDBACK_FACT_VARS = ['学生姓名', '课程主题', '课堂内容', '课堂表现', '课后任务', '成绩', '备注'] as const;

/** 风格变量三项（D-065③ 语气 × 篇幅 × 家庭建议开关） */
export const FEEDBACK_STYLE_VARS = ['语气', '篇幅', '家庭建议'] as const;

/** 提示词可用变量集（8 项；模板里可用的全部槽位） */
export const FEEDBACK_PROMPT_VARS: readonly string[] = [...FEEDBACK_FACT_VARS, ...FEEDBACK_STYLE_VARS];

export type FeedbackTone = 'warm' | 'objective' | 'lively' | 'concise';
export type FeedbackLength = 'short' | 'medium' | 'long';

/** 风格三维（D-065③） */
export interface FeedbackStyle {
  tone: FeedbackTone;
  length: FeedbackLength;
  /** 家庭建议开关：带=结尾一条在家可执行的小建议 / 不带=明示不写 */
  familyAdvice: boolean;
}

export interface FeedbackOption<T extends string> {
  code: T;
  text: string;
}

/** 语气 4 档（text 即写进提示词的短语，档位码与文案解耦） */
export const TONE_OPTIONS: ReadonlyArray<FeedbackOption<FeedbackTone>> = [
  { code: 'warm', text: '温和鼓励' },
  { code: 'objective', text: '专业客观' },
  { code: 'lively', text: '热情活泼' },
  { code: 'concise', text: '简明扼要' },
];

/** 篇幅 3 档（任务书 §一 P2：~100/~200/~350 字） */
export const LENGTH_OPTIONS: ReadonlyArray<FeedbackOption<FeedbackLength>> = [
  { code: 'short', text: '约 100 字' },
  { code: 'medium', text: '约 200 字' },
  { code: 'long', text: '约 350 字' },
];

export const DEFAULT_STYLE: FeedbackStyle = { tone: 'warm', length: 'medium', familyAdvice: true };

/**
 * 输入（目检返工③后七项事实：D-065① 四项 + 课程主题 + 备注）。
 * studentName/lessonContent 必填；topic/performance/homework/score/scoreTitle/note 可空。
 */
export interface FeedbackInputs {
  studentName: string;
  /** 课程主题：一行标题式（如「期中复习·受力分析」），快速/批量均单列 */
  topic?: string;
  /** 课堂内容（必填） */
  lessonContent: string;
  /** 课堂表现：内置标签 + 自定义标签（点选，原样带入，不概括不加工） */
  performance: string[];
  /** 课后任务 */
  homework: string;
  /** 测试成绩分数（阿拉伯数字；空 = 不生成成绩段） */
  score?: string;
  /** 考试/测验名称（可选，仅与分数同现） */
  scoreTitle?: string;
  /** 备注：给 AI 的补充说明（不当作表现标签；离线档不进正文，见 engine.ts offlineVars） */
  note?: string;
}

/** 归一化数字串（前后空白去掉；'82.5' 原样） */
function norm(value: string | undefined): string {
  return (value ?? '').trim();
}

/** 课堂表现文本：去空项后顿号相连（空数组 → 空串） */
export function performanceText(performance: string[]): string {
  return (performance ?? []).map((p) => norm(p)).filter((p) => p !== '').join('、');
}

/** 成绩槽位值：`82分` / `82分（课堂小测）`；空分数 → 空串（该槽位段整体剔除） */
export function scoreSlotValue(inputs: FeedbackInputs): string {
  const score = norm(inputs.score);
  if (score === '') return '';
  const title = norm(inputs.scoreTitle);
  return title === '' ? `${score}分` : `${score}分（${title}）`;
}

/** 事实槽位取值（八项事实变量的全部） */
export function factSlotValues(inputs: FeedbackInputs): Record<string, string> {
  return {
    学生姓名: norm(inputs.studentName),
    课程主题: norm(inputs.topic),
    课堂内容: norm(inputs.lessonContent),
    课堂表现: performanceText(inputs.performance),
    课后任务: norm(inputs.homework),
    成绩: scoreSlotValue(inputs),
    备注: norm(inputs.note),
  };
}

/** 风格槽位取值（八项变量的后三项）；家庭建议两态为完整句子，调用方负责句读 */
export function styleSlotValues(style: FeedbackStyle): Record<string, string> {
  const tone = TONE_OPTIONS.find((o) => o.code === style.tone) ?? TONE_OPTIONS[0]!;
  const length = LENGTH_OPTIONS.find((o) => o.code === style.length) ?? LENGTH_OPTIONS[1]!;
  return {
    语气: tone.text,
    篇幅: length.text,
    家庭建议: style.familyAdvice ? '结尾带一条在家可执行的小建议。' : '不要写家庭建议。',
  };
}

/** 模板是否自带风格槽位（任一即可；无 → 组装时追加【写作要求】段） */
export function hasStyleSlots(templateBody: string): boolean {
  return FEEDBACK_STYLE_VARS.some((v) => (templateBody ?? '').includes(`{${v}}`));
}

/** 无风格槽位模板的追加段（三维全带，措辞与内置模板同源） */
export function styleRequirementBlock(style: FeedbackStyle): string {
  const v = styleSlotValues(style);
  return `【写作要求】\n语气：${v.语气}。篇幅：${v.篇幅}。家庭建议：${v.家庭建议}`;
}

/** 阿拉伯数字取样（守卫共用同一取数口径；中文数字不在守卫范围——报告申报） */
export function extractNumbers(text: string): string[] {
  return (text ?? '').match(/\d+(?:\.\d+)?/g) ?? [];
}

/** 输入里出现过的全部数字（守卫的「输入侧数字集合」；含课程主题/备注里的数字） */
export function feedbackNumbers(inputs: FeedbackInputs): string[] {
  const text = [
    norm(inputs.score), norm(inputs.scoreTitle), norm(inputs.topic),
    norm(inputs.lessonContent), norm(inputs.homework), norm(inputs.note),
    performanceText(inputs.performance),
  ].join(' ');
  return extractNumbers(text);
}

/** 缺值显式报错（任务书 §四：不静默出草稿） */
function assertRequired(inputs: FeedbackInputs): void {
  const missing: string[] = [];
  if (norm(inputs.studentName) === '') missing.push('学生姓名');
  if (norm(inputs.lessonContent) === '') missing.push('课堂内容');
  if (missing.length > 0) throw new Error(`提示词组装缺少必填项：${missing.join('、')}`);
}

const SLOT_RE = /\{([^{}]+)\}/g;

/**
 * 单行渲染：整行只剩一个空值槽位 → 返回 null（调用方删该行）；否则替换已知槽位。
 * 未知槽位原样保留（用户手抖写错变量名时看得见，不被静默吞掉）。
 */
function renderLine(line: string, values: Record<string, string>): string | null {
  const slots = [...line.matchAll(SLOT_RE)].map((m) => m[1] ?? '');
  if (slots.length === 1) {
    const key = slots[0]!;
    if (key in values && norm(values[key]) === '') return null;
  }
  return line.replace(SLOT_RE, (match, key: string) => (key in values ? values[key]! : match));
}

/**
 * 模板缺失事实槽位的补齐段（目检返工③新增「课程主题」「备注」后的兼容机制）：
 * 用户手上的模板（含已落库的内置种子、或自己删过槽位的模板）未必写全事实槽位，
 * 若放任不注入，AI 就拿不到这些事实——「只允许使用给定事实」的约束会留下空档。
 * 口径：模板**至少含一个事实槽位**（=它本来就是「事实驱动」的模板）时，把缺失且非空的事实补进本段；
 * 模板一个事实槽位都没有 → 视为「自由提示词」意图，不追加。
 */
export function missingFactBlock(templateBody: string, inputs: FeedbackInputs): string {
  const body = templateBody ?? '';
  const present = FEEDBACK_FACT_VARS.filter((v) => body.includes(`{${v}}`));
  if (present.length === 0) return '';
  const values = factSlotValues(inputs);
  const missing = FEEDBACK_FACT_VARS.filter((v) => !present.includes(v) && norm(values[v]) !== '');
  if (missing.length === 0) return '';
  const lines = missing.map((v) => `${v}：${values[v]}`);
  return `【补充事实——只允许使用以下内容，不得编造、不得改动数字】\n${lines.join('\n')}`;
}

/**
 * 组装完整提示词：事实注入 + 风格注入 + 缺失事实补齐段（+ 无风格槽位时追加写作要求段）。
 * 必填缺失抛错（中文文案含字段名，UI 直接展示）。
 */
export function buildPrompt(templateBody: string, inputs: FeedbackInputs, style: FeedbackStyle): string {
  assertRequired(inputs);
  const values: Record<string, string> = { ...factSlotValues(inputs), ...styleSlotValues(style) };
  const body = templateBody ?? '';
  const rendered = body
    .split('\n')
    .map((line) => renderLine(line, values))
    .filter((line): line is string => line !== null)
    .join('\n');

  const sections = [rendered.replace(/\s+$/, '')];
  const supplement = missingFactBlock(body, inputs);
  if (supplement !== '') sections.push(supplement);
  if (!hasStyleSlots(body)) sections.push(styleRequirementBlock(style));
  return sections.join('\n\n');
}
