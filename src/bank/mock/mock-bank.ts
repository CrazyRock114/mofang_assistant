// Phase 3: mock 层 — 内存实现 BankService 接口，预置样本
// 0002：内部状态迁入共享 MockBankStore（与 mock 扩展服务共用，支撑 exam 登记联动语义对齐）；
// Paper 返回补齐 status/paperType（服务层保证）；listQuestions 支持字典/树维度筛选。

import type {
  BankService, Question, QuestionFilter, Paper, PaperSummary, PaperQuestionRef,
  QuestionOption, QuestionImage, QuestionFigureLayout,
} from '../../shared/contracts/bank-types.js';
import { MockBankStore, MockPaperQuestionEntry } from './mock-store.js';

export class MockBankService implements BankService {
  readonly store: MockBankStore;

  constructor(store?: MockBankStore, seedSampleData = true) {
    this.store = store ?? new MockBankStore();
    // 0004（只增）：seed 可关——MockPaperExtService 克隆重建题复用本类语义，不得向共享 store 重播种
    // 0004-fix-1（demo 实测修复）：浏览器 demo 各页面各自 new MockBankService(共享 store)，
    // 原实现每次构造都重播种 → 覆盖已有状态（卷被重置回 basket，定稿/归档丢失）。
    // 播种只对「空 store」生效，语义与「示例数据初始化」一致。
    if (seedSampleData && this.store.questions.size === 0 && this.store.papers.size === 0) {
      this.seedSampleData();
    }
  }

  private seedSampleData(): void {
    // 5 道物理题（至少 3 题含公式、1 题含 figure、2 题带答案+解析）
    const q1: Question = {
      id: 'q1',
      subject: '物理',
      sourceType: 'network',
      sourceDetail: { url: 'https://example.com/q1', source: 'sample' },
      questionType: '计算题',
      difficulty: 3,
      content: '<div class="question">一个质量为 m 的物体从高度 h 处自由落体，落地时速度为多少？已知重力加速度为 g，动能公式为 <span class="math" data-tex="E_k = \\frac{1}{2}mv^2"></span>。</div>',
      answer: '<p>根据机械能守恒：<span class="math" data-tex="mgh = \\frac{1}{2}mv^2"></span>，解得 <span class="math" data-tex="v = \\sqrt{2gh}"></span></p>',
      analysis: '<p>本题考查机械能守恒定律和自由落体运动。</p>',
      images: [],
      createdAt: '2026-01-01T00:00:00Z',
      updatedAt: '2026-01-01T00:00:00Z',
    };

    const q2: Question = {
      id: 'q2',
      subject: '物理',
      sourceType: 'local',
      sourceDetail: { file: 'local-bank.db', row: 42 },
      questionType: '选择题',
      difficulty: 2,
      content: '<div class="question">下列关于牛顿第二定律 <span class="math" data-tex="F = ma"></span> 的说法，正确的是？<div class="options"><span class="option">A. 力是产生加速度的原因</span><span class="option">B. 加速度与力成反比</span></div></div>',
      answer: '<p>A</p>',
      analysis: '<p>力是改变物体运动状态的原因，加速度与力成正比。</p>',
      images: [],
      createdAt: '2026-01-02T00:00:00Z',
      updatedAt: '2026-01-02T00:00:00Z',
    };

    const q3: Question = {
      id: 'q3',
      subject: '物理',
      sourceType: 'network',
      sourceDetail: { url: 'https://example.com/q3', batch: 'physics-101' },
      questionType: '实验题',
      difficulty: 4,
      content: '<div class="question">如图所示电路中，测量电阻 R 的阻值。<figure class="diagram" data-align="center" data-w="300" data-h="200"><img src="data:image/svg+xml,%3Csvg xmlns=\'http://www.w3.org/2000/svg\' width=\'300\' height=\'200\'%3E%3Crect width=\'300\' height=\'200\' fill=\'%23f0f0f0\'/%3E%3Ctext x=\'150\' y=\'100\' text-anchor=\'middle\' font-size=\'16\' fill=\'%23333\'%3E电路图占位%3C/text%3E%3C/svg%3E" alt="电路图"></figure>根据欧姆定律 <span class="math" data-tex="R = \\frac{U}{I}"></span> 计算电阻。</div>',
      images: [],
      createdAt: '2026-01-03T00:00:00Z',
      updatedAt: '2026-01-03T00:00:00Z',
    };

    const q4: Question = {
      id: 'q4',
      subject: '物理',
      sourceType: 'network',
      sourceDetail: { url: 'https://example.com/q4', topic: 'mechanics' },
      questionType: '证明题',
      difficulty: 5,
      content: '<div class="question">证明：在匀速圆周运动中，向心加速度 <span class="math" data-tex="a_c = \\frac{v^2}{r}"></span>。</div>',
      images: [],
      createdAt: '2026-01-04T00:00:00Z',
      updatedAt: '2026-01-04T00:00:00Z',
    };

    const q5: Question = {
      id: 'q5',
      subject: '物理',
      sourceType: 'local',
      sourceDetail: { file: 'archive.json', index: 7 },
      questionType: '填空题',
      difficulty: 1,
      content: '<div class="question">光在真空中的传播速度约为 _____ m/s。（填数字）</div>',
      images: [],
      createdAt: '2026-01-05T00:00:00Z',
      updatedAt: '2026-01-05T00:00:00Z',
    };

    this.store.questions.set(q1.id, q1);
    this.store.questions.set(q2.id, q2);
    this.store.questions.set(q3.id, q3);
    this.store.questions.set(q4.id, q4);
    this.store.questions.set(q5.id, q5);

    // 3 个标签
    this.store.tags.set('q1', new Map([['易错题', '#ff6b6b'], ['力学', '#4dabf7']]));
    this.store.tags.set('q2', new Map([['力学', '#4dabf7']]));
    this.store.tags.set('q3', new Map([['电学', '#51cf66']]));

    // 1 份试卷（含 3 个引用，position 有序）
    const paper: Paper = {
      id: 'p1',
      title: '高中物理综合测试',
      config: { duration: 90, totalScore: 100 },
      createdAt: '2026-01-10T00:00:00Z',
      archived: false,
      status: 'basket',
      paperType: 'uniform',
    };
    this.store.papers.set(paper.id, paper);
    this.store.paperQuestions.set(paper.id, [
      { questionId: 'q1', position: 0, score: 20, frozen: false },
      { questionId: 'q2', position: 1, score: 15, frozen: false },
      { questionId: 'q3', position: 2, score: 25, frozen: false },
    ]);
  }

  // Question operations
  async createQuestion(data: Omit<Question, 'id' | 'createdAt' | 'updatedAt'>): Promise<Question> {
    // 来源门禁验证（与真实实现保持一致）
    const { validateSource } = await import('../gate.js');
    validateSource(data);

    const id = `q${this.store.questions.size + 1}`;
    const now = new Date().toISOString();
    // 0002：弃用字段（grade/textbook/version/chapter）不再落库，仅保留编译兼容（与真实实现对齐）；
    // 0062（R-066/D-076② 翻案 B2）：stage 除外——迁移 0017 已加回列，随题落库 + 读侧回读。
    const { grade: _g, textbook: _t, version: _v, chapter: _c, ...rest } = data;
    void _g; void _t; void _v; void _c;
    // 0002 字典外键语义对齐（真实实现由 SQLite FK 拦截）：subjectId/typeId/difficultyId 必须指向已存在的字典条目
    const dictRefs: Array<[string | undefined, string]> = [
      [data.subjectId, 'subject_id'], [data.typeId, 'type_id'], [data.difficultyId, 'difficulty_id'],
    ];
    for (const [value, column] of dictRefs) {
      if (value !== undefined && !this.store.dictEntries.has(value)) {
        throw new Error(`FOREIGN KEY constraint failed: questions.${column} → ${value}`);
      }
    }
    const question: Question = { ...rest, id, createdAt: now, updatedAt: now, images: data.images ?? [] };
    this.store.questions.set(id, question);
    this.store.log('question.create', `Created ${id}`);
    return question;
  }

  async getQuestion(id: string): Promise<Question | null> {
    const question = this.store.questions.get(id);
    if (!question) return null;
    // 0054：与真实实现同口径——读侧回填 question_tags
    return this.withTags(question);
  }

  /** 0054（只增）：单题标签回填（无标签不产生 tags 字段，与真实实现一致） */
  private withTags(question: Question): Question {
    const tags = this.store.tags.get(question.id);
    if (!tags || tags.size === 0) return question;
    return { ...question, tags: [...tags.keys()].sort() };
  }

  async listQuestions(filter?: QuestionFilter): Promise<Question[]> {
    let results = Array.from(this.store.questions.values());

    if (filter?.subject) {
      results = results.filter(q => q.subject === filter.subject);
    }
    if (filter?.subjectId) {
      results = results.filter(q => q.subjectId === filter.subjectId);
    }
    if (filter?.typeId) {
      results = results.filter(q => q.typeId === filter.typeId);
    }
    // 0014 题型多值（与真实实现同语义：typeId 同现时 typeId 优先）
    if (!filter?.typeId && filter?.typeIds && filter.typeIds.length > 0) {
      const wanted = new Set(filter.typeIds);
      results = results.filter(q => q.typeId !== undefined && wanted.has(q.typeId));
    }
    if (filter?.difficultyId) {
      results = results.filter(q => q.difficultyId === filter.difficultyId);
    }
    if (filter?.treeNodeId) {
      const subtree = this.descendantNodeIds(filter.treeNodeId);
      results = results.filter(q => {
        const linked = this.store.questionNodeLinks.get(q.id);
        if (!linked) return false;
        for (const nodeId of linked) {
          if (subtree.has(nodeId)) return true;
        }
        return false;
      });
    }
    // 0062（R-066/D-076② 翻案 B2）：学段维度——分区语义（与真实实现同语义、同步 SQL 结构）：
    // ① 题级非空 → 只看题级；② 题级空 + 挂了树 → 回退树 stage（空值归一「未分组」）；
    // ③ 题级空 + 从未挂树 → 按「未分组」参与。
    if (filter?.stage) {
      results = results.filter(q => {
        const own = q.stage && q.stage !== '' ? q.stage : null;
        if (own !== null) return own === filter.stage;
        const linked = this.store.questionNodeLinks.get(q.id);
        if (linked && linked.size > 0) {
          for (const nodeId of linked) {
            const node = this.store.treeNodes.get(nodeId);
            const tree = node ? this.store.trees.get(node.treeId) : undefined;
            if (tree && (tree.stage || '未分组') === filter.stage) return true;
          }
          return false;
        }
        return filter.stage === '未分组';
      });
    }
    if (filter?.tag) {
      results = results.filter(q => {
        const qTags = this.store.tags.get(q.id);
        return qTags?.has(filter.tag!) ?? false;
      });
    }
    if (filter?.keyword) {
      results = results.filter(q => q.content.includes(filter.keyword!));
    }

    // 0054：与真实实现同口径——列表逐题回填标签
    return results.map(q => this.withTags(q));
  }

  async updateQuestion(id: string, data: Partial<Omit<Question, 'id' | 'createdAt'>>): Promise<Question> {
    const existing = this.store.questions.get(id);
    if (!existing) throw new Error(`Question ${id} not found`);

    // 来源门禁验证（如果更新了 source 相关字段）
    if (data.sourceType !== undefined || data.sourceDetail !== undefined) {
      const { validateSource } = await import('../gate.js');
      validateSource({
        sourceType: data.sourceType ?? existing.sourceType,
        sourceDetail: data.sourceDetail ?? existing.sourceDetail,
      });
    }

    // 0002：弃用字段不落库（与真实实现对齐）
    const { grade: _g, stage: _s, textbook: _t, version: _v, chapter: _c, ...patch } = data;
    void _g; void _s; void _t; void _v; void _c;
    const updated: Question = { ...existing, ...patch, updatedAt: new Date().toISOString() };
    this.store.questions.set(id, updated);
    this.store.log('question.update', `Updated ${id}`);
    return updated;
  }

  async deleteQuestion(id: string): Promise<void> {
    // 与真实实现语义对齐：软删后 list/get 不可见（内存实现直接从 Map 移除）
    this.store.questions.delete(id);
    this.store.log('question.delete', `Deleted ${id}`);
  }

  async addTag(questionId: string, tag: string, color?: string): Promise<void> {
    if (!this.store.tags.has(questionId)) {
      this.store.tags.set(questionId, new Map());
    }
    this.store.tags.get(questionId)!.set(tag, color);
    this.store.log('question.addTag', `Added tag ${tag} to ${questionId}`);
  }

  async removeTag(questionId: string, tag: string): Promise<void> {
    this.store.tags.get(questionId)?.delete(tag);
    this.store.log('question.removeTag', `Removed tag ${tag} from ${questionId}`);
  }

  // Paper operations
  async createPaper(title: string, config?: Record<string, unknown>): Promise<Paper> {
    const id = `p${this.store.papers.size + 1}`;
    const now = new Date().toISOString();
    const paper: Paper = { id, title, config: config ?? {}, createdAt: now, archived: false, status: 'basket', paperType: 'uniform' };
    this.store.papers.set(id, paper);
    this.store.paperQuestions.set(id, []);
    this.store.log('paper.create', `Created paper ${id}`);
    return paper;
  }

  async getPaper(id: string): Promise<Paper | null> {
    const paper = this.store.papers.get(id);
    // 语义对齐真实实现：archived 卷默认不可见
    if (!paper || paper.status === 'archived') return null;
    return paper;
  }

  async listPapers(): Promise<PaperSummary[]> {
    return Array.from(this.store.papers.values())
      .filter(p => p.status !== 'archived')
      .map(paper => {
        const questions = this.store.paperQuestions.get(paper.id) ?? [];
        return {
          paper,
          questionCount: questions.length,
          totalScore: questions.reduce((sum, q) => sum + (q.score ?? 0), 0),
        };
      });
  }

  async addQuestion(paperId: string, questionId: string, score?: number, layout?: PaperQuestionRef['layout'], textBlock?: { text: string; style?: 'section' | 'note'; align?: 'left' | 'center' | 'right' }): Promise<void> {
    const questions = this.store.paperQuestions.get(paperId) ?? [];
    const existing = questions.find(q => q.questionId === questionId);
    // 0004-fix-4 2.3：文本内容块（kind='text'）——同 id 已存在且为文本块 → upsert 更新
    // 0004-fix-6 P1-1：align 缺省=清回 undefined（样式基线观感，与真实 text_align=NULL 同语义）
    if (textBlock) {
      if (existing && existing.kind !== 'text') {
        throw new Error(`Row ${questionId} in paper ${paperId} is not a text block`);
      }
      if (existing) {
        existing.kind = 'text';
        existing.textBody = textBlock.text;
        existing.style = textBlock.style ?? 'section';
        existing.align = textBlock.align;
        this.store.log('paper.addQuestion', `Updated text block ${questionId} in ${paperId}`);
        return;
      }
      questions.push({
        questionId,
        position: questions.length,
        frozen: false,
        kind: 'text',
        textBody: textBlock.text,
        style: textBlock.style ?? 'section',
        ...(textBlock.align ? { align: textBlock.align } : {}),
      });
      this.store.paperQuestions.set(paperId, questions);
      this.store.log('paper.addQuestion', `Added text block ${questionId} to ${paperId}`);
      return;
    }
    if (existing) throw new Error(`Row ${questionId} already exists in paper ${paperId}`);
    const nextPosition = questions.length;
    questions.push({
      questionId,
      position: nextPosition,
      score,
      frozen: false,
      ...(layout ? { layout: JSON.parse(JSON.stringify(layout)) as { figures?: QuestionFigureLayout[] } } : {}),
    });
    this.store.paperQuestions.set(paperId, questions);
    this.store.log('paper.addQuestion', `Added ${questionId} to ${paperId}`);
  }

  async removeQuestion(paperId: string, questionId: string): Promise<void> {
    const questions = this.store.paperQuestions.get(paperId) ?? [];
    const filtered = questions.filter(q => q.questionId !== questionId);
    // 重新调整 position
    filtered.forEach((q, index) => { q.position = index; });
    this.store.paperQuestions.set(paperId, filtered);
    this.store.log('paper.removeQuestion', `Removed ${questionId} from ${paperId}`);
  }

  async reorderQuestions(paperId: string, questionIds: string[]): Promise<void> {
    const questions = this.store.paperQuestions.get(paperId) ?? [];
    const reordered = questionIds.map((qid, index) => {
      const existing = questions.find(q => q.questionId === qid);
      if (!existing) throw new Error(`Question ${qid} not in paper ${paperId}`);
      return { ...existing, position: index };
    });
    this.store.paperQuestions.set(paperId, reordered);
    this.store.log('paper.reorderQuestions', `Reordered ${questionIds.length} questions in ${paperId}`);
  }

  async getPaperQuestions(paperId: string): Promise<PaperQuestionRef[]> {
    const questions = this.store.paperQuestions.get(paperId) ?? [];
    return questions
      .sort((a, b) => a.position - b.position)
      .map((q, index) => ({
        id: `ref-${paperId}-${q.questionId}`,
        paperId,
        questionId: q.questionId,
        position: q.position,
        score: q.score,
        frozen: q.frozen,
        // 0004-fix-4 2.3：文本内容块行带出（kind/textBody/style）；fix-6 P1-1：align
        ...(q.kind ? { kind: q.kind } : {}),
        ...(q.textBody !== undefined ? { textBody: q.textBody } : {}),
        ...(q.style ? { style: q.style } : {}),
        ...(q.align ? { align: q.align } : {}),
        // 0004 Phase 5：题级图排版覆盖带出（undefined = 未覆盖）
        ...(q.layout ? { layout: q.layout } : {}),
      }));
  }

  async setQuestionScore(paperId: string, questionId: string, score: number | undefined): Promise<void> {
    const questions = this.store.paperQuestions.get(paperId) ?? [];
    const question = questions.find(q => q.questionId === questionId);
    if (!question) throw new Error(`Question ${questionId} not in paper ${paperId}`);
    // 0018 目检返工三：undefined = 清除分值（回未设置）
    question.score = score;
    this.store.log('paper.setScore', `Set score ${score ?? 'NULL'} for ${questionId} in ${paperId}`);
  }

  // 辅助：获取 operation_log（用于测试）
  getOperationLogs() {
    return this.store.logs;
  }

  /** 树维度筛选（B5 子树派生）：自身+全部后代节点 id 集合 */
  private descendantNodeIds(nodeId: string): Set<string> {
    const result = new Set<string>([nodeId]);
    const queue = [nodeId];
    const childrenOf = new Map<string, string[]>();
    for (const node of this.store.treeNodes.values()) {
      if (!node.parentId) continue;
      const list = childrenOf.get(node.parentId) ?? [];
      list.push(node.id);
      childrenOf.set(node.parentId, list);
    }
    while (queue.length > 0) {
      const current = queue.shift()!;
      for (const child of childrenOf.get(current) ?? []) {
        if (!result.has(child)) {
          result.add(child);
          queue.push(child);
        }
      }
    }
    return result;
  }
}

// 类型再导出（mock-bank 历史消费方兼容）
export type { MockBankStore, MockPaperQuestionEntry, QuestionOption, QuestionImage };
