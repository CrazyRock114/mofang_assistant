// 0002: mock 共享内存状态——MockBankService 与 mock 扩展服务共用同一份 store，
// 保证契约测试双跑（真实 SQLite / mock）语义对齐（exam 登记联动需要跨服务读题/卷数据）。

import type {
  Question, Paper, PaperLayoutConfig,
  DictEntry, Tree, TreeNode, TreeSourceMapping,
  Student, ClassInfo, StudentClassPeriod, StudentEvent,
  Exam, ExamScore, Mistake, PaperSet, PaperSetPaperRef, LayoutPreset,
  QuestionFigureLayout, FeedbackTemplate, PaperTextBlockAlign,
  /** 0044（只增）：试卷文件夹 */
  PaperFolder,
  /** 0030（只增）：AI 通道提示词模板 + 反馈记录（落档） */
  FeedbackPromptTemplate, FeedbackRecord,
} from '../../shared/contracts/bank-types.js';
// 0023（只增）：模型档案 mock 行（keyEncrypted 密文占位仅 mock 层内存持有，同真实 key_encrypted 列语义）
import type { ModelProfile } from '../../shared/contracts/ai-types.js';

/**
 * 0059：通用课后反馈·重写版（与迁移 0016 的 UPDATE 一字不差——契约测试双跑与
 * feedback-prompt-tune.test.ts 防漂移锁同绿的前提；改这里必须同步改迁移，且只能加新迁移）。
 */
export const BUILTIN_PROMPT_GENERAL = [
  '你是一位有经验的培训老师，正在给学生{学生姓名}的家长写课后反馈。',
  '',
  '【事实信息——只允许使用以下内容，不得编造、不得改动数字】',
  '课程主题：{课程主题}',
  '课堂内容：{课堂内容}',
  '课堂表现：{课堂表现}',
  '课后任务：{课后任务}',
  '测试成绩：{成绩}',
  '备注（只用来把握语气和详略，不要照抄进正文）：{备注}',
  '',
  '【写作要求】',
  '语气：{语气}。篇幅：{篇幅}。{家庭建议}',
  '1. 只能用上面「事实信息」里的内容，禁止新增任何事实、禁止改动任何数字。',
  '2. 备注只影响语气与详略，不把备注原话写进正文。例：备注写「家长最近比较焦虑，别给压力」，正文就写成「这一步需要一个过程，我们按节奏来」，而不是「听说您最近很焦虑」。',
  '3. 说人话：不写「通过本节课的学习」「充分体现了」「相信在未来的学习中」这类套话；不喊口号式表扬（如「你真棒」「太厉害了」），表扬要落到具体的一件事。',
  '4. 不写考试排名，不与其他学生、其他班级比较，不提及其他学生。',
  '5. 不出现「AI」「模型」「人工智能」「数据」等字样，也不用「该生」这类书面称呼，称呼家长为「xx家长」。',
  '',
  '【输出格式】',
  '直接输出反馈正文，不要标题、不要开场白和客套话；自然分成 2-4 段，段间空一行；不要用 Markdown 记号（*、#、-）和分点符号。',
  '',
  '【范例——只示范语气、结构和详略，内容与此例无关，不要照抄】',
  'xx家长您好！今天这次课，孩子整体状态不错，进门就能跟着节奏走，讲到新内容时会主动记笔记，遇到没听明白的地方也会第一时间问。',
  '',
  '不过在练习环节有一步卡住了：孩子习惯直接列式，把中间的关键步骤跳过去，结果答案对、过程却讲不清。这次布置的作业里我留了几道同类题，建议先让孩子把每一步写完整再算，把「先写清、再算快」这个顺序固定下来。',
  '',
  '您在家可以让孩子把今天的题讲一遍给您听，能讲明白就说明真的懂了，比多做两道题更有用。',
  '',
].join('\n');

/** 0059：考后成绩反馈·重写版（与迁移 0016 的 UPDATE 一字不差，口径同上）。 */
export const BUILTIN_PROMPT_EXAM = [
  '你是一位有经验的培训老师，正在给学生{学生姓名}的家长写这次考试的成绩反馈。',
  '',
  '【事实信息——只允许使用以下内容，不得编造、不得改动数字】',
  '本次成绩：{成绩}',
  '课程主题：{课程主题}',
  '课堂内容：{课堂内容}',
  '课堂表现：{课堂表现}',
  '课后任务：{课后任务}',
  '备注（只用来把握语气和详略，不要照抄进正文）：{备注}',
  '',
  '【写作要求】',
  '语气：{语气}。篇幅：{篇幅}。{家庭建议}',
  '1. 只能用上面「事实信息」里的内容，禁止新增任何事实、禁止改动任何数字；成绩只用给定的数字，不做排名比较。',
  '2. 只在事实支持时才说「掌握得稳 / 还有缺口」；没有对应的错题或表现信息时，不编造具体题目、不编造具体失分点。',
  '3. 备注只影响语气与详略，不把备注原话写进正文。例：备注写「这次没考好，家长比较急」，正文就写成「这次的问题很集中，方向清楚，按步骤补起来不难」，而不是「听说您很着急」。',
  '4. 说人话：不写「通过本次考试充分反映出」这类套话；不喊口号式表扬；不用「继续加油」这种没有动作的收尾。',
  '5. 不写考试排名，不与其他学生、其他班级比较，不提及其他学生。',
  '6. 不出现「AI」「模型」「人工智能」「数据」等字样，也不用「该生」这类书面称呼，称呼家长为「xx家长」。',
  '',
  '【输出格式】',
  '按下面四段顺序输出，每段标题独占一行、用中文冒号，段与段之间空一行；不要用 Markdown 记号（*、#、-），除「1.」外不要用其他分点符号：',
  '知识掌握情况：',
  '（一段话：这次考的内容里，哪些掌握得比较稳、哪些还有缺口）',
  '失分原因：',
  '（分点列出，每点一句话，不重复、不凑数）',
  '学习建议：',
  '（分点列出，每点一个具体可执行的动作）',
  '总体评价：',
  '（一段话收尾：肯定真实进步、指出下一步方向，不喊口号）',
  '',
  '【范例——只示范语气、结构和详略，内容与此例无关，不要照抄】',
  'xx家长您好！这次单元测孩子考了 82 分，我把这次卷子的情况跟您说一下。',
  '',
  '知识掌握情况：',
  '这次主要考的是新学的那一章，孩子对基本概念和常见题型掌握得比较稳，这部分几乎没丢分；综合题里要把两三个知识点串起来的题还不太顺。',
  '',
  '失分原因：',
  '1. 审题时漏看了题干里的一个条件，整道题方向就偏了。',
  '2. 中间结果抄错了一次，后面步骤都对，分还是丢了。',
  '',
  '学习建议：',
  '1. 做卷子时先把题干里的关键条件圈出来再动笔。',
  '2. 每天用 5 分钟把当天的错题重算一遍，只看过程不看答案。',
  '',
  '总体评价：',
  '整体来看，孩子对这次考的内容是有感觉的，问题集中在审题和计算这两个可控的地方。把这两个习惯固定下来，下次还能往上走。',
  '',
].join('\n');

/** 0059：通用课后反馈·小学（迁移 0016 新增内置的镜像，一字不差，口径同上）。 */
export const BUILTIN_PROMPT_PRIMARY = [
  '你是一位有经验的培训老师，正在给小学生{学生姓名}的家长写课后反馈。',
  '',
  '【学段语气——小学】',
  '称呼孩子为「宝贝」「小朋友」或小名，不用「该生」。语言活泼口语化，句子短，可以用 emoji（一句最多一个，全文 2-4 个）。先肯定孩子做到的地方，再委婉说可以更好的地方。不用书面术语和教育口号，像跟家长聊天。',
  '',
  '【事实信息——只允许使用以下内容，不得编造、不得改动数字】',
  '课程主题：{课程主题}',
  '课堂内容：{课堂内容}',
  '课堂表现：{课堂表现}',
  '课后任务：{课后任务}',
  '测试成绩：{成绩}',
  '备注（只用来把握语气和详略，不要照抄进正文）：{备注}',
  '',
  '【写作要求】',
  '语气：{语气}。篇幅：{篇幅}。{家庭建议}',
  '1. 只能用上面「事实信息」里的内容，禁止新增任何事实、禁止改动任何数字。',
  '2. 备注只影响语气与详略，不把备注原话写进正文。例：备注写「家长很关心孩子有没有举手」，正文就写成「今天宝贝有两次主动举手」，而不是「听说您很关心他有没有举手」。',
  '3. 说人话：不写「通过本节课的学习」「充分体现了」这类套话；不喊口号式表扬（如「你真棒」），表扬要落到具体的一件事。',
  '4. 不写排名，不与其他小朋友比较，不提及其他学生。',
  '5. 不出现「AI」「模型」「人工智能」「数据」等字样，称呼家长为「xx家长」。',
  '',
  '【输出格式】',
  '直接输出反馈正文，不要标题、不要开场白和客套话；自然分成 2-4 段，段间空一行；不要用 Markdown 记号（*、#、-）和分点符号。',
  '',
  '【范例——只示范语气、结构和详略，内容与此例无关，不要照抄】',
  'xx家长您好！今天这次课，宝贝表现得很棒呀！讲到新内容的时候坐得很稳，还主动举手回答了两次问题呢。',
  '',
  '做练习的时候有一小步没跟上：看到图就着急写算式，没有先看图里给了什么。今天留的作业里有几道同类的题，回家可以先让宝贝用手指一指图里有什么，说清楚了再写，这样会顺很多。',
  '',
  '您在家可以陪宝贝把今天的题讲一遍给您听，能讲明白就说明真的学会啦，比多做两道题管用。',
  '',
].join('\n');

/** 0059：通用课后反馈·高中（迁移 0016 新增内置的镜像，一字不差，口径同上）。 */
export const BUILTIN_PROMPT_SENIOR = [
  '你是一位有经验的培训老师，正在给高中生{学生姓名}的家长写课后反馈。',
  '',
  '【学段语气——高中】',
  '称呼孩子为「某某同学」或全名，不用「宝贝」「小朋友」等幼儿化称呼，也不用「该生」。语言成熟理性、简洁干练，不用「呀」「哦」「哈」「嘛」「呢」等撒娇语气词，少用感叹号。不用可爱/卖萌表情（👏🎯💪🌟😊☀️）；需要时只用功能性 emoji（🌻📅✅📝）。先讲事实和判断，再说建议；礼貌有温度，但不煽情。',
  '',
  '【事实信息——只允许使用以下内容，不得编造、不得改动数字】',
  '课程主题：{课程主题}',
  '课堂内容：{课堂内容}',
  '课堂表现：{课堂表现}',
  '课后任务：{课后任务}',
  '测试成绩：{成绩}',
  '备注（只用来把握语气和详略，不要照抄进正文）：{备注}',
  '',
  '【写作要求】',
  '语气：{语气}。篇幅：{篇幅}。{家庭建议}',
  '1. 只能用上面「事实信息」里的内容，禁止新增任何事实、禁止改动任何数字。',
  '2. 备注只影响语气与详略，不把备注原话写进正文。例：备注写「家长想了解孩子的薄弱环节」，正文就写成「目前更需要补的是综合题的分析环节」，而不是「听说您想知道他的薄弱点」。',
  '3. 说人话：不写「通过本节课的学习」「充分体现了」这类套话；不喊口号式表扬，表扬要落到具体的一件事；不写「继续努力」这种没有动作的收尾。',
  '4. 不写考试排名，不与其他学生、其他班级比较，不提及其他学生。',
  '5. 不出现「AI」「模型」「人工智能」「数据」等字样，称呼家长为「xx家长」。',
  '',
  '【输出格式】',
  '直接输出反馈正文，不要标题、不要开场白和客套话；自然分成 2-4 段，段间空一行；不要用 Markdown 记号（*、#、-）和分点符号。',
  '',
  '【范例——只示范语气、结构和详略，内容与此例无关，不要照抄】',
  'xx家长您好！今天这节课的进度和完成情况跟您反馈一下。',
  '',
  '课上主要推进了新课内容。从练习的完成度看，{学生姓名}同学对新概念的理解是到位的，独立完成的速度也比较好。需要留意的是，遇到需要综合两三个知识点的题时，思考的起点偏慢，更倾向于先套用课上讲过的方法，而不是先判断这类题的结构。',
  '',
  '这次布置的作业我按难易分层留了题，建议把其中两三道综合题单独拿出来，先写出解题思路再动笔算。这个环节走顺了，后续做综合题会更有把握。',
  '',
  '您有任何问题可以随时和我沟通。',
  '',
].join('\n');

export interface MockPaperQuestionEntry {
  questionId: string;
  position: number;
  score?: number;
  frozen: boolean;
  /** 0004 Phase 5：题级图排版覆盖（对齐真实 layout_json 列；undefined = 未覆盖） */
  layout?: { figures?: QuestionFigureLayout[] };
  /** 0004-fix-4 2.3：文本内容块（对齐真实 kind/text_body/style 列；kind 缺省=题目行） */
  kind?: 'question' | 'text';
  textBody?: string;
  style?: 'section' | 'note';
  /** 0004-fix-6 P1-1：文本块对齐（对齐真实 text_align 列；undefined=样式基线观感） */
  align?: PaperTextBlockAlign;
}

export interface MockLogEntry {
  type: string;
  timestamp: string;
  status: string;
  description: string;
  /** 0025（只增）：影响条数（对齐真实 operation_log.affected_count；既有调用方缺省 0） */
  affectedCount?: number;
}

export type MockPresetRow = LayoutPreset & { deleted: boolean };

export class MockBankStore {
  questions = new Map<string, Question>();
  tags = new Map<string, Map<string, string | undefined>>();
  papers = new Map<string, Paper>();
  paperQuestions = new Map<string, MockPaperQuestionEntry[]>();
  logs: MockLogEntry[] = [];

  dictEntries = new Map<string, DictEntry>();
  trees = new Map<string, Tree>();
  treeNodes = new Map<string, TreeNode>();
  /** questionId → 挂接节点 id 集合（多挂） */
  questionNodeLinks = new Map<string, Set<string>>();
  /** key = `${site}:${siteNodeId}` */
  treeSourceMap = new Map<string, TreeSourceMapping>();

  students = new Map<string, Student>();
  classes = new Map<string, ClassInfo>();
  studentClasses: StudentClassPeriod[] = [];
  studentEvents = new Map<string, StudentEvent>();

  exams = new Map<string, Exam>();
  /** key = `${examId}:${studentId}` */
  examScores = new Map<string, ExamScore>();
  mistakes = new Map<string, Mistake>();
  paperSets = new Map<string, PaperSet>();
  paperSetPapers = new Map<string, PaperSetPaperRef[]>();
  presets = new Map<string, MockPresetRow>();

  /** 0004：paper 快照（paperId → questionId → Question 全字段 JSON），语义对齐真实 paper_snapshots 表 */
  paperSnapshots = new Map<string, Map<string, string>>();

  /** 0044：试卷文件夹（paper_folders 内存对齐；parent_id 自引用嵌套，D-062） */
  paperFolders = new Map<string, PaperFolder>();

  /** 0005：feedback 模板（对齐真实 feedback_templates 表；软删语义同 preset） */
  feedbackTemplates = new Map<string, FeedbackTemplate & { deleted: boolean }>();

  /** 0023：模型档案（对齐真实 model_profiles 表；keyEncrypted=密文占位，对外仍剥离为 hasKey） */
  modelProfiles = new Map<string, ModelProfile & { keyEncrypted: string | null }>();

  /** 0030（只增）：AI 通道提示词模板（对齐真实 feedback_prompt_templates 表；软删语义同 preset） */
  feedbackPromptTemplates = new Map<string, FeedbackPromptTemplate & { deleted: boolean }>();

  /** 0030（只增）：反馈记录（对齐真实 feedback_records 表；快速模式 studentId=null 仅留痕） */
  feedbackRecords = new Map<string, FeedbackRecord>();

  constructor() {
    // 0004 Phase 5：内置预设播种（对齐真实 0003_basket_ext.sql 种子——A3双列/A4，
    // config 数值一字不差；mock 环境/demo/测试由此「内置模板可见可应用」）
    // 0004-fix-2 F2-A：对齐 0004_a3_landscape.sql 迁移后种子（orientation 逐字段一致）
    this.presets.set('preset-builtin-a3-2col', {
      id: 'preset-builtin-a3-2col',
      name: 'A3双列',
      config: { version: 2, pageSize: 'A3', orientation: 'landscape', columns: 2, columnGapMm: 8, fontSize: 12, lineHeight: 1.5, header: { style: 'exam' } },
      isBuiltin: true,
      createdAt: '2026-09-08T00:00:00Z',
      deleted: false,
    });
    this.presets.set('preset-builtin-a4', {
      id: 'preset-builtin-a4',
      name: 'A4',
      config: { version: 2, pageSize: 'A4', orientation: 'portrait', columns: 1, fontSize: 12, lineHeight: 1.5, header: { style: 'exam' } },
      isBuiltin: true,
      createdAt: '2026-09-08T00:00:00Z',
      deleted: false,
    });
    // 0005：内置默认课后反馈模板播种（对齐真实 0005_feedback.sql 种子，正文一字不差；
    // 中文键变量由 renderFeedback 插值——src/app/feedback/render.ts）
    this.feedbackTemplates.set('feedback-tpl-builtin-default', {
      id: 'feedback-tpl-builtin-default',
      name: '默认课后反馈',
      bodyTemplate: '{学生姓名}家长您好！本次{科目}课我们学习了{本次内容}。{课堂表现}{成绩}{错题情况}{学习建议}如有疑问欢迎与我沟通。——{老师姓名}',
      isBuiltin: true,
      createdAt: '2026-09-09T00:00:00Z',
      updatedAt: '2026-09-09T00:00:00Z',
      deleted: false,
    });
    // 0030：AI 通道内置提示词模板播种（对齐真实迁移种子，正文一字不差；0059 起镜像 0016 的四条内置；
    // 槽位由 buildPrompt 填真实数据与风格档位——src/app/feedback/prompt.ts）。
    // createdAt 口径与迁移一致：既有两条 '2026-09-22T00:00:00Z'，0059 新增两条 '2026-09-22T12:00:00Z'
    //（新档晚于旧档，保证列表排序 is_builtin DESC + created_at ASC 下顺位确定）。
    const builtinPromptSeed = (id: string, name: string, body: string, createdAt = '2026-09-22T00:00:00Z'): void => {
      this.feedbackPromptTemplates.set(id, {
        id, name, body, isBuiltin: true,
        createdAt, updatedAt: createdAt, deleted: false,
      });
    };
    builtinPromptSeed('feedback-prompt-builtin-general', '通用课后反馈', BUILTIN_PROMPT_GENERAL);
    builtinPromptSeed('feedback-prompt-builtin-exam', '考后成绩反馈', BUILTIN_PROMPT_EXAM);
    builtinPromptSeed('feedback-prompt-builtin-primary', '通用课后反馈·小学', BUILTIN_PROMPT_PRIMARY, '2026-09-22T12:00:00Z');
    builtinPromptSeed('feedback-prompt-builtin-senior', '通用课后反馈·高中', BUILTIN_PROMPT_SENIOR, '2026-09-22T12:00:00Z');
  }

  private changeListeners: Array<() => void> = [];

  onChange(listener: () => void): () => void {
    this.changeListeners.push(listener);
    return () => {
      this.changeListeners = this.changeListeners.filter((l) => l !== listener);
    };
  }

  notifyChange(): void {
    for (const listener of this.changeListeners) {
      try {
        listener();
      } catch (err) {
        console.error('Error in store change listener:', err);
      }
    }
  }

  log(type: string, description: string, affectedCount = 0): void {
    this.logs.push({ type, timestamp: new Date().toISOString(), status: 'succeeded', description, affectedCount });
    this.notifyChange();
  }
}

/** mock 侧错题题快照（与真实 buildSnapshotFromRow 语义对齐：优先 stemHtml 回落 content） */
export function mockSnapshotOf(q: Question): Mistake['snapshot'] {
  return {
    stemHtml: q.stemHtml || q.content || '',
    options: q.options ? [...q.options] : [],
    answer: q.answer,
    analysis: q.analysis,
    images: q.images ? [...q.images] : [],
  };
}

export type { PaperLayoutConfig };
