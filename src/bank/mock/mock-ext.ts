// 0002: mock 扩展服务 — BankExtServices 的内存实现（契约测试双跑用）
// 业务语义与真实实现逐条对齐：重名守卫/封存过滤/payload 校验/一生一题 upsert/U9 自动升黄/内置预设不可删。

import type {
  BankExtServices, DictEntry, DictEntryInput, DictKind, DictService,
  Tree, TreeType, TreeNode, TreeSourceMapping, TreeService,
  Student, StudentStatus, StudentEvent, StudentEventType, StudentEventPayload, StudentClassPeriod, StudentService,
  ClassInfo, ClassStatus, ClassService,
  Exam, ExamScore, ScoreEntry, ExamResultEntry, ExamRecordSummary, ExamService,
  Mistake, MistakeStage, MistakeService,
  MistakeAggregateFilter, MistakeAggregateRow, MistakeBatchResult,
  Paper, PaperSet, PaperType, PaperSetPaperRef, PaperSetService,
  LayoutPreset, PresetService,
  PaperStatus, PaperLayoutConfig, PaperExtService,
  Question, QuestionFigureLayout,
  QuestionAnswerSpaceOverride,
  FeedbackService, FeedbackTemplate, FeedbackTemplateInput,
  /** 0030（只增）：AI 通道提示词模板 + 反馈记录落档 */
  FeedbackPromptTemplate, FeedbackPromptTemplateInput, FeedbackPromptTemplateService,
  FeedbackRecord, FeedbackRecordInput, FeedbackRecordPatch, FeedbackRecordQuery, FeedbackRecordService,
  /** 0044（只增）：试卷文件夹 */
  PaperFolder,
} from '../../shared/contracts/bank-types.js';
import { MockBankStore, mockSnapshotOf, MockPresetRow } from './mock-store.js';
// 0039：归档名谓词与真实实现同源（默认 listTrees 剔已归档）；纯模块，不引 db
import { isArchivedTreeName } from '../tree-archive.js';
// 0004：克隆重建题复用 MockBankService 的 createQuestion 语义（门禁/字典 FK 对齐真实实现）
import { MockBankService } from './mock-bank.js';
// 0003：改从独立模块取校验（不沿 school-service 链拉 db 进 renderer 编译图）
import { validateEventPayload } from '../event-payload.js';
// 0025 P1（只增）：聚合口径纯函数与真实实现单一来源（摘要截断/时间窗归一/批量守卫）
import {
  summarizeStem, normalizeOccurredFrom, normalizeOccurredTo, assertBatchIds, assertMistakeStage,
} from '../mistake-aggregate.js';
// 0025 P3（只增）：batch_meta 结构校验（与真实实现同一口径）
import { validateBatchMeta } from '../paper-set-batch-meta.js';

const KIND_ID_PREFIX: Record<DictKind, string> = {
  subject: 'subj',
  question_type: 'qtype',
  difficulty: 'diff',
};

const STAGE_CYCLE: Record<MistakeStage, MistakeStage> = {
  red: 'yellow',
  yellow: 'green',
  green: 'red',
};

// ---------------- dict ----------------

export class MockDictService implements DictService {
  constructor(private store: MockBankStore) {}

  async listEntries(filter: { kind?: DictKind; activeOnly?: boolean } = {}): Promise<DictEntry[]> {
    let entries = Array.from(this.store.dictEntries.values());
    if (filter.kind) entries = entries.filter(e => e.kind === filter.kind);
    if (filter.activeOnly) entries = entries.filter(e => e.active);
    // 归一行在前，组内 code 升序（对齐真实实现 ORDER BY kind, site IS NULL DESC, code）
    return entries.sort((a, b) =>
      a.kind.localeCompare(b.kind)
      || ((a.site ? 1 : 0) - (b.site ? 1 : 0))
      || a.code.localeCompare(b.code)
    );
  }

  async getEntry(id: string): Promise<DictEntry | null> {
    return this.store.dictEntries.get(id) ?? null;
  }

  async createEntry(data: DictEntryInput): Promise<DictEntry> {
    const normalized = !data.site;
    if (normalized) {
      // 拍板 §6-10：归一行同 kind 同 label 重名拒绝
      const dup = Array.from(this.store.dictEntries.values())
        .find(e => e.kind === data.kind && !e.site && e.label === data.label);
      if (dup) throw new Error(`Duplicate normalized dict entry: ${data.kind} "${data.label}" already exists (${dup.id})`);
      const dupCode = Array.from(this.store.dictEntries.values())
        .find(e => e.kind === data.kind && !e.site && e.code === data.code);
      if (dupCode) throw new Error(`UNIQUE constraint failed: dict_entries.kind/code (normalized)`);
    } else {
      const dup = Array.from(this.store.dictEntries.values())
        .find(e => e.kind === data.kind && e.site === data.site && e.sourceLabel === (data.sourceLabel ?? null));
      if (dup) throw new Error(`UNIQUE constraint failed: dict_entries.kind/site/source_label`);
    }

    const id = normalized
      ? `${KIND_ID_PREFIX[data.kind]}:${data.code}`
      : `${KIND_ID_PREFIX[data.kind]}:${data.site}:${data.sourceLabel ?? data.label}`;

    const entry: DictEntry = {
      id,
      kind: data.kind,
      code: data.code,
      label: data.label,
      site: data.site,
      sourceLabel: data.sourceLabel,
      active: data.active !== false,
    };
    this.store.dictEntries.set(id, entry);
    this.store.log('dict.create', `Created dict ${id}`);
    return entry;
  }

  async updateEntry(id: string, data: { code?: string; label?: string; active?: boolean }): Promise<DictEntry> {
    const existing = this.store.dictEntries.get(id);
    if (!existing) throw new Error(`Dict entry ${id} not found`);
    // 0016 P1-3 指认守卫（与 DictServiceImpl 同构）：patch.code 须指向同 kind 已建归一行
    if (data.code !== undefined) {
      const target = Array.from(this.store.dictEntries.values())
        .find((e) => e.kind === existing.kind && !e.site && e.code === data.code);
      if (!target) {
        throw new Error(`未知归一码 "${data.code}"（kind=${existing.kind} 无此归一行；指认须指向同 kind 已建归一行）`);
      }
    }
    const updated: DictEntry = {
      ...existing,
      code: data.code ?? existing.code,
      label: data.label ?? existing.label,
      active: data.active !== undefined ? data.active : existing.active,
    };
    this.store.dictEntries.set(id, updated);
    this.store.log('dict.update', `Updated dict ${id}`);
    return updated;
  }
}

// ---------------- tree ----------------

export class MockTreeService implements TreeService {
  constructor(private store: MockBankStore) {}

  async createTree(data: { type: TreeType; name: string; subjectId?: string; edition?: string; stage?: string; source?: string }): Promise<Tree> {
    const tree: Tree = { id: `tree-${this.store.trees.size + 1}`, ...data, createdAt: new Date().toISOString() };
    this.store.trees.set(tree.id, tree);
    this.store.log('tree.create', `Created tree ${tree.id}`);
    return tree;
  }

  async listTrees(filter: { type?: TreeType; subjectId?: string; includeArchived?: boolean } = {}): Promise<Tree[]> {
    let trees = Array.from(this.store.trees.values());
    if (filter.type) trees = trees.filter(t => t.type === filter.type);
    if (filter.subjectId) trees = trees.filter(t => t.subjectId === filter.subjectId);
    // 0039：与 TreeServiceImpl 同构——默认剔已归档（收敛后每科一套权威树）
    if (!filter.includeArchived) trees = trees.filter(t => !isArchivedTreeName(t.name));
    return trees;
  }

  async getTree(id: string): Promise<Tree | null> {
    return this.store.trees.get(id) ?? null;
  }

  async getNodes(treeId: string): Promise<TreeNode[]> {
    return Array.from(this.store.treeNodes.values())
      .filter(n => n.treeId === treeId)
      .sort((a, b) => a.sort - b.sort || a.name.localeCompare(b.name));
  }

  async getDescendants(nodeId: string): Promise<Array<TreeNode & { depth: number }>> {
    const start = this.store.treeNodes.get(nodeId);
    if (!start) return [];
    const result: Array<TreeNode & { depth: number }> = [{ ...start, depth: 0 }];
    const queue: Array<{ id: string; depth: number }> = [{ id: nodeId, depth: 0 }];
    while (queue.length > 0) {
      const { id, depth } = queue.shift()!;
      const children = Array.from(this.store.treeNodes.values())
        .filter(n => n.parentId === id)
        .sort((a, b) => a.sort - b.sort || a.name.localeCompare(b.name));
      for (const child of children) {
        result.push({ ...child, depth: depth + 1 });
        queue.push({ id: child.id, depth: depth + 1 });
      }
    }
    return result;
  }

  async createNode(data: { treeId: string; parentId?: string; name: string; sort?: number; sourceMapping?: { site: string; siteNodeId: string; siteNodeName?: string } }): Promise<TreeNode> {
    if (!this.store.trees.has(data.treeId)) throw new Error(`Tree ${data.treeId} not found`);
    if (data.parentId && !this.store.treeNodes.has(data.parentId)) {
      throw new Error(`Parent node ${data.parentId} not found`);
    }
    if (!data.parentId) {
      // 拍板 §6-10：根节点重名守卫
      const dup = Array.from(this.store.treeNodes.values())
        .find(n => n.treeId === data.treeId && !n.parentId && n.name === data.name);
      if (dup) throw new Error(`Duplicate root node "${data.name}" in tree ${data.treeId}`);
    }

    const node: TreeNode = {
      id: `node-${this.store.treeNodes.size + 1}`,
      treeId: data.treeId,
      parentId: data.parentId,
      name: data.name,
      sort: data.sort ?? 0,
    };
    this.store.treeNodes.set(node.id, node);

    if (data.sourceMapping) {
      const key = `${data.sourceMapping.site}:${data.sourceMapping.siteNodeId}`;
      if (this.store.treeSourceMap.has(key)) {
        throw new Error(`UNIQUE constraint failed: tree_source_map.site/site_node_id`);
      }
      this.store.treeSourceMap.set(key, { nodeId: node.id, ...data.sourceMapping });
    }

    this.store.log('tree.createNode', `Created node ${node.id}`);
    return node;
  }

  async linkQuestion(questionId: string, nodeId: string): Promise<void> {
    if (!this.store.treeNodes.has(nodeId)) throw new Error(`Tree node ${nodeId} not found`);
    const set = this.store.questionNodeLinks.get(questionId) ?? new Set<string>();
    set.add(nodeId);
    this.store.questionNodeLinks.set(questionId, set);
    this.store.log('tree.linkQuestion', `Linked ${questionId} → ${nodeId}`);
  }

  async unlinkQuestion(questionId: string, nodeId: string): Promise<void> {
    this.store.questionNodeLinks.get(questionId)?.delete(nodeId);
    this.store.log('tree.unlinkQuestion', `Unlinked ${questionId} ↛ ${nodeId}`);
  }

  async getQuestionNodes(questionId: string): Promise<TreeNode[]> {
    const linked = this.store.questionNodeLinks.get(questionId);
    if (!linked) return [];
    return Array.from(linked)
      .map(id => this.store.treeNodes.get(id))
      .filter((n): n is TreeNode => Boolean(n));
  }

  async resolveSourceNode(site: string, siteNodeId: string): Promise<TreeNode | null> {
    const mapping = this.store.treeSourceMap.get(`${site}:${siteNodeId}`);
    return mapping ? this.store.treeNodes.get(mapping.nodeId) ?? null : null;
  }

  async getSourceMappings(nodeId: string): Promise<TreeSourceMapping[]> {
    return Array.from(this.store.treeSourceMap.values()).filter(m => m.nodeId === nodeId);
  }
}

// ---------------- student / class ----------------

export class MockStudentService implements StudentService {
  constructor(private store: MockBankStore) {}

  async createStudent(data: { name: string; studentNo?: string; gender?: string; school?: string; remark?: string }): Promise<Student> {
    if (!data.name || !data.name.trim()) throw new Error('Student name is required');
    const now = new Date().toISOString();
    const student: Student = {
      id: `s-${this.store.students.size + 1}`,
      studentNo: data.studentNo,
      name: data.name,
      gender: data.gender,
      school: data.school,
      remark: data.remark,
      status: 'active',
      createdAt: now,
      updatedAt: now,
    };
    this.store.students.set(student.id, student);
    this.store.log('student.create', `Created ${student.id}`);
    return student;
  }

  async getStudent(id: string): Promise<Student | null> {
    return this.store.students.get(id) ?? null;
  }

  async listStudents(filter: { includeArchived?: boolean; classId?: string; keyword?: string } = {}): Promise<Student[]> {
    let students = Array.from(this.store.students.values());
    if (!filter.includeArchived) students = students.filter(s => s.status === 'active');
    if (filter.classId) {
      const inClass = new Set(
        this.store.studentClasses.filter(sc => sc.classId === filter.classId).map(sc => sc.studentId)
      );
      students = students.filter(s => inClass.has(s.id));
    }
    if (filter.keyword) {
      students = students.filter(s => s.name.includes(filter.keyword!) || s.studentNo?.includes(filter.keyword!));
    }
    return students;
  }

  async updateStudent(id: string, data: Partial<Omit<Student, 'id' | 'createdAt' | 'updatedAt' | 'status'>>): Promise<Student> {
    const existing = this.store.students.get(id);
    if (!existing) throw new Error(`Student ${id} not found`);
    const updated: Student = { ...existing, ...data, updatedAt: new Date().toISOString() };
    this.store.students.set(id, updated);
    this.store.log('student.update', `Updated ${id}`);
    return updated;
  }

  async setStudentStatus(id: string, status: StudentStatus): Promise<Student> {
    const existing = this.store.students.get(id);
    if (!existing) throw new Error(`Student ${id} not found`);
    const updated: Student = { ...existing, status, updatedAt: new Date().toISOString() };
    this.store.students.set(id, updated);
    this.store.log('student.setStatus', `${id} → ${status}`);
    return updated;
  }

  async enrollStudent(studentId: string, classId: string, startedAt?: string): Promise<StudentClassPeriod> {
    if (!this.store.students.has(studentId)) throw new Error(`Student ${studentId} not found`);
    if (!this.store.classes.has(classId)) throw new Error(`Class ${classId} not found`);
    const open = this.store.studentClasses.find(sc => sc.studentId === studentId && sc.classId === classId && !sc.endedAt);
    if (open) throw new Error(`Student ${studentId} already has an open enrollment in class ${classId}`);

    const period: StudentClassPeriod = { studentId, classId, startedAt, endedAt: undefined };
    this.store.studentClasses.push(period);
    this.store.log('student.enroll', `${studentId} → ${classId}`);
    return period;
  }

  async endEnrollment(studentId: string, classId: string, endedAt: string): Promise<void> {
    const open = this.store.studentClasses.find(sc => sc.studentId === studentId && sc.classId === classId && !sc.endedAt);
    if (!open) throw new Error(`No open enrollment for student ${studentId} in class ${classId}`);
    open.endedAt = endedAt;
    this.store.log('student.endEnrollment', `${studentId} ⊣ ${classId}`);
  }

  async getStudentClasses(studentId: string): Promise<Array<StudentClassPeriod & { className?: string }>> {
    return this.store.studentClasses
      .filter(sc => sc.studentId === studentId)
      .map(sc => ({ ...sc, className: this.store.classes.get(sc.classId)?.name }));
  }

  async getClassStudents(classId: string): Promise<StudentClassPeriod[]> {
    return this.store.studentClasses.filter(sc => sc.classId === classId);
  }

  async addEvent(data: { studentId: string; eventType: StudentEventType; occurredAt: string; payload: StudentEventPayload }): Promise<StudentEvent> {
    if (!this.store.students.has(data.studentId)) throw new Error(`Student ${data.studentId} not found`);
    validateEventPayload(data.eventType, data.payload);

    const event: StudentEvent = {
      id: `evt-${this.store.studentEvents.size + 1}`,
      studentId: data.studentId,
      eventType: data.eventType,
      occurredAt: data.occurredAt,
      payload: data.payload,
      createdAt: new Date().toISOString(),
    };
    this.store.studentEvents.set(event.id, event);
    this.store.log('student.addEvent', `${data.eventType} for ${data.studentId}`);
    return event;
  }

  async listEvents(filter: { studentId: string; eventType?: StudentEventType; from?: string; to?: string; classId?: string }): Promise<StudentEvent[]> {
    let events = Array.from(this.store.studentEvents.values()).filter(e => e.studentId === filter.studentId);

    if (filter.classId) {
      // 班级时期筛选：occurredAt 落在 [startedAt, endedAt]
      const periods = this.store.studentClasses.filter(sc => sc.classId === filter.classId && sc.studentId === filter.studentId);
      events = events.filter(e => periods.some(p =>
        (!p.startedAt || e.occurredAt >= p.startedAt) && (!p.endedAt || e.occurredAt <= p.endedAt)
      ));
    }
    if (filter.eventType) events = events.filter(e => e.eventType === filter.eventType);
    if (filter.from) events = events.filter(e => e.occurredAt >= filter.from!);
    if (filter.to) events = events.filter(e => e.occurredAt <= filter.to!);

    return events.sort((a, b) => b.occurredAt.localeCompare(a.occurredAt));
  }
}

export class MockClassService implements ClassService {
  constructor(private store: MockBankStore) {}

  async createClass(data: { name: string; school?: string; gradeLevel?: string; term?: string }): Promise<ClassInfo> {
    if (!data.name || !data.name.trim()) throw new Error('Class name is required');
    const cls: ClassInfo = {
      id: `c-${this.store.classes.size + 1}`,
      name: data.name,
      school: data.school,
      gradeLevel: data.gradeLevel,
      term: data.term,
      status: 'active',
      createdAt: new Date().toISOString(),
    };
    this.store.classes.set(cls.id, cls);
    this.store.log('class.create', `Created ${cls.id}`);
    return cls;
  }

  async getClass(id: string): Promise<ClassInfo | null> {
    return this.store.classes.get(id) ?? null;
  }

  async listClasses(filter: { status?: ClassStatus | 'all' } = {}): Promise<ClassInfo[]> {
    let classes = Array.from(this.store.classes.values());
    if (filter.status && filter.status !== 'all') classes = classes.filter(c => c.status === filter.status);
    return classes;
  }

  async updateClass(id: string, data: Partial<Omit<ClassInfo, 'id' | 'createdAt'>>): Promise<ClassInfo> {
    const existing = this.store.classes.get(id);
    if (!existing) throw new Error(`Class ${id} not found`);
    const updated: ClassInfo = { ...existing, ...data };
    this.store.classes.set(id, updated);
    this.store.log('class.update', `Updated ${id}`);
    return updated;
  }

  async closeClass(id: string): Promise<ClassInfo> {
    return this.updateClass(id, { status: 'closed' });
  }
}

// ---------------- mistake ----------------

export class MockMistakeService implements MistakeService {
  constructor(private store: MockBankStore) {}

  /** mock 同步核心（MockExamService 复用；对齐真实 recordWrongSync 语义） */
  recordWrongCore(data: { questionId: string; studentId: string; examId?: string; sourcePaperId?: string; occurredAt: string; note?: string }): { mistake: Mistake; created: boolean } {
    const question = this.store.questions.get(data.questionId);
    if (!question) throw new Error(`Question ${data.questionId} not found`);
    if (!this.store.students.has(data.studentId)) throw new Error(`Student ${data.studentId} not found`);

    const now = new Date().toISOString();
    const existing = Array.from(this.store.mistakes.values())
      .find(m => m.questionId === data.questionId && m.studentId === data.studentId);

    if (existing) {
      const updated: Mistake = {
        ...existing,
        examId: data.examId ?? existing.examId,
        sourcePaperId: data.sourcePaperId ?? existing.sourcePaperId,
        occurredAt: data.occurredAt,
        stage: 'red',
        snapshot: mockSnapshotOf(question),
        note: data.note ?? existing.note,
        updatedAt: now,
      };
      this.store.mistakes.set(updated.id, updated);
      return { mistake: updated, created: false };
    }

    const mistake: Mistake = {
      id: `m-${this.store.mistakes.size + 1}`,
      questionId: data.questionId,
      studentId: data.studentId,
      examId: data.examId,
      sourcePaperId: data.sourcePaperId,
      occurredAt: data.occurredAt,
      stage: 'red',
      snapshot: mockSnapshotOf(question),
      note: data.note,
      createdAt: now,
      updatedAt: now,
    };
    this.store.mistakes.set(mistake.id, mistake);
    return { mistake, created: true };
  }

  async recordWrong(data: { questionId: string; studentId: string; examId?: string; sourcePaperId?: string; occurredAt: string; note?: string }): Promise<{ mistake: Mistake; created: boolean }> {
    const res = this.recordWrongCore(data);
    this.store.log('mistake.recordWrong', `student ${data.studentId} × question ${data.questionId}`);
    return res;
  }

  async getMistake(id: string): Promise<Mistake | null> {
    return this.store.mistakes.get(id) ?? null;
  }

  async listMistakes(filter: { studentId?: string; stage?: MistakeStage; questionId?: string; examId?: string } = {}): Promise<Mistake[]> {
    let mistakes = Array.from(this.store.mistakes.values());
    if (filter.studentId) mistakes = mistakes.filter(m => m.studentId === filter.studentId);
    if (filter.stage) mistakes = mistakes.filter(m => m.stage === filter.stage);
    if (filter.questionId) mistakes = mistakes.filter(m => m.questionId === filter.questionId);
    if (filter.examId) mistakes = mistakes.filter(m => m.examId === filter.examId);
    return mistakes.sort((a, b) => b.occurredAt.localeCompare(a.occurredAt));
  }

  async setStage(id: string, stage: MistakeStage): Promise<Mistake> {
    const existing = this.store.mistakes.get(id);
    if (!existing) throw new Error(`Mistake ${id} not found`);
    const updated: Mistake = { ...existing, stage, updatedAt: new Date().toISOString() };
    this.store.mistakes.set(id, updated);
    this.store.log('mistake.setStage', `${id} → ${stage}`);
    return updated;
  }

  async cycleStage(id: string): Promise<Mistake> {
    const existing = this.store.mistakes.get(id);
    if (!existing) throw new Error(`Mistake ${id} not found`);
    return this.setStage(id, STAGE_CYCLE[existing.stage]);
  }

  async setNote(id: string, note: string): Promise<void> {
    const existing = this.store.mistakes.get(id);
    if (!existing) throw new Error(`Mistake ${id} not found`);
    this.store.mistakes.set(id, { ...existing, note, updatedAt: new Date().toISOString() });
    this.store.log('mistake.setNote', `${id}`);
  }

  async deleteMistake(id: string): Promise<void> {
    if (!this.store.mistakes.delete(id)) throw new Error(`Mistake ${id} not found`);
    this.store.log('mistake.delete', `${id}`);
  }

  // ==================== 0025 P1（只增）：聚合 / 批量 / 导出（口径对齐真实实现） ====================

  async aggregateByQuestion(filter: MistakeAggregateFilter = {}): Promise<MistakeAggregateRow[]> {
    const occurredFrom = filter.occurredFrom ? normalizeOccurredFrom(filter.occurredFrom) : undefined;
    const occurredTo = filter.occurredTo ? normalizeOccurredTo(filter.occurredTo) : undefined;
    const studentIds = filter.studentIds && filter.studentIds.length > 0 ? new Set(filter.studentIds) : null;

    const groups = new Map<string, { wrongCount: number; first: string; last: string }>();
    for (const m of this.store.mistakes.values()) {
      // INNER JOIN 语义：题行不存在即不参与聚合（真实层由 FK 保证不会发生）
      if (!this.store.questions.has(m.questionId)) continue;
      if (filter.stage && m.stage !== filter.stage) continue;
      if (studentIds && !studentIds.has(m.studentId)) continue;
      if (occurredFrom && m.occurredAt < occurredFrom) continue;
      if (occurredTo && m.occurredAt > occurredTo) continue;

      const g = groups.get(m.questionId);
      if (!g) {
        groups.set(m.questionId, { wrongCount: 1, first: m.occurredAt, last: m.occurredAt });
      } else {
        // 一生一题唯一关系（store 以 id 为键，同生同题仅一行）——按 studentId 去重计数
        g.wrongCount += 1;
        if (m.occurredAt < g.first) g.first = m.occurredAt;
        if (m.occurredAt > g.last) g.last = m.occurredAt;
      }
    }

    const rows: MistakeAggregateRow[] = [];
    for (const [questionId, g] of groups) {
      const q = this.store.questions.get(questionId);
      if (!q) continue;
      if (filter.subject && q.subject !== filter.subject) continue;
      rows.push({
        questionId,
        wrongCount: g.wrongCount,
        stemSummary: summarizeStem(q.stemHtml, q.content),
        subject: q.subject,
        questionType: q.questionType,
        difficulty: q.difficulty,
        firstOccurredAt: g.first,
        lastOccurredAt: g.last,
      });
    }
    // 人次降序、同人次题号升序（与真实 SQL ORDER BY wrong_count DESC, question_id ASC 同序）
    rows.sort((a, b) => (b.wrongCount - a.wrongCount) || (a.questionId < b.questionId ? -1 : a.questionId > b.questionId ? 1 : 0));
    return rows;
  }

  async deleteMistakes(ids: string[]): Promise<MistakeBatchResult> {
    assertBatchIds(ids);
    let affectedCount = 0;
    for (const id of ids) {
      if (this.store.mistakes.delete(id)) affectedCount += 1;
    }
    this.store.log('mistake.batchDelete', `Batch delete ${ids.length} mistake(s)`, affectedCount);
    return { affectedCount };
  }

  async setStages(ids: string[], stage: MistakeStage): Promise<MistakeBatchResult> {
    assertBatchIds(ids);
    assertMistakeStage(stage);
    const now = new Date().toISOString();
    let affectedCount = 0;
    for (const id of ids) {
      const existing = this.store.mistakes.get(id);
      if (!existing) continue;
      this.store.mistakes.set(id, { ...existing, stage, updatedAt: now });
      affectedCount += 1;
    }
    this.store.log('mistake.batchSetStage', `Batch set stage ${stage} on ${ids.length} mistake(s)`, affectedCount);
    return { affectedCount };
  }

  async exportQuestionIds(filter: MistakeAggregateFilter = {}): Promise<string[]> {
    const rows = await this.aggregateByQuestion(filter);
    return rows.map((row) => row.questionId);
  }
}

// ---------------- exam ----------------

export class MockExamService implements ExamService {
  constructor(private store: MockBankStore, private mistakeService: MockMistakeService) {}

  async createExam(data: { title: string; classId?: string; subjectId?: string; occurredAt: string; paperSetId?: string; remark?: string }): Promise<Exam> {
    const exam: Exam = {
      id: `exam-${this.store.exams.size + 1}`,
      title: data.title,
      classId: data.classId,
      subjectId: data.subjectId,
      occurredAt: data.occurredAt,
      paperSetId: data.paperSetId,
      remark: data.remark,
      createdAt: new Date().toISOString(),
    };
    this.store.exams.set(exam.id, exam);
    this.store.log('exam.create', `Created ${exam.id}`);
    return exam;
  }

  async getExam(id: string): Promise<Exam | null> {
    return this.store.exams.get(id) ?? null;
  }

  async listExams(filter: { classId?: string; subjectId?: string } = {}): Promise<Exam[]> {
    let exams = Array.from(this.store.exams.values());
    if (filter.classId) exams = exams.filter(e => e.classId === filter.classId);
    if (filter.subjectId) exams = exams.filter(e => e.subjectId === filter.subjectId);
    return exams.sort((a, b) => b.occurredAt.localeCompare(a.occurredAt));
  }

  async recordScores(examId: string, entries: ScoreEntry[]): Promise<number> {
    const exam = this.getExamRow(examId);
    const count = this.upsertScores(exam, entries);
    this.store.log('exam.recordScores', `${count} scores for ${examId}`);
    return count;
  }

  async getExamScores(examId: string): Promise<ExamScore[]> {
    return Array.from(this.store.examScores.values())
      .filter(s => s.examId === examId)
      .sort((a, b) => a.studentId.localeCompare(b.studentId));
  }

  async getStudentScores(studentId: string): Promise<Array<ExamScore & { examTitle?: string }>> {
    return Array.from(this.store.examScores.values())
      .filter(s => s.studentId === studentId)
      .map(s => ({ ...s, examTitle: this.store.exams.get(s.examId)?.title }))
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  async recordResults(examId: string, entries: ExamResultEntry[]): Promise<ExamRecordSummary> {
    const exam = this.getExamRow(examId);
    const summary: ExamRecordSummary = {
      scoresUpserted: 0,
      mistakesCreated: 0,
      mistakesUpdated: 0,
      autoPromotedToYellow: 0,
      promotedStudents: 0,
    };

    summary.scoresUpserted = this.upsertScores(exam, entries);

    for (const entry of entries) {
      const wrongIds = entry.wrongQuestionIds ?? [];
      const wrongSet = new Set(wrongIds);
      const studentPaperId = this.studentPaper(exam, entry.studentId);

      for (const questionId of wrongIds) {
        const res = this.mistakeService.recordWrongCore({
          questionId,
          studentId: entry.studentId,
          examId: exam.id,
          sourcePaperId: studentPaperId ?? undefined,
          occurredAt: exam.occurredAt,
        });
        if (res.created) summary.mistakesCreated++;
        else summary.mistakesUpdated++;
      }

      if (studentPaperId) {
        const paperQuestionIds = (this.store.paperQuestions.get(studentPaperId) ?? []).map(pq => pq.questionId);
        let promoted = 0;
        for (const questionId of paperQuestionIds) {
          if (wrongSet.has(questionId)) continue;
          const existing = Array.from(this.store.mistakes.values())
            .find(m => m.questionId === questionId && m.studentId === entry.studentId);
          if (!existing) continue;

          if (existing.stage === 'red') {
            this.store.mistakes.set(existing.id, {
              ...existing,
              stage: 'yellow',
              lastCorrectAt: exam.occurredAt,
              updatedAt: new Date().toISOString(),
            });
            promoted++;
          } else if (existing.stage === 'yellow') {
            this.store.mistakes.set(existing.id, {
              ...existing,
              lastCorrectAt: exam.occurredAt,
              updatedAt: new Date().toISOString(),
            });
          }
        }
        if (promoted > 0) {
          summary.autoPromotedToYellow += promoted;
          summary.promotedStudents++;
        }
      }
    }

    this.store.log('exam.recordResults', `Results for ${examId}`);
    return summary;
  }

  private upsertScores(exam: Exam, entries: ScoreEntry[]): number {
    let count = 0;
    for (const entry of entries) {
      if (!this.store.students.has(entry.studentId)) throw new Error(`Student ${entry.studentId} not found`);
      const now = new Date().toISOString();
      const key = `${exam.id}:${entry.studentId}`;
      const existing = this.store.examScores.get(key);
      if (existing) {
        // upsert 只更新提供的字段（与真实实现 COALESCE 语义对齐）
        this.store.examScores.set(key, {
          ...existing,
          score: entry.score !== undefined ? entry.score : existing.score,
          detail: entry.detail !== undefined ? entry.detail : existing.detail,
          updatedAt: now,
        });
      } else {
        this.store.examScores.set(key, {
          id: `score-${this.store.examScores.size + 1}`,
          examId: exam.id,
          studentId: entry.studentId,
          score: entry.score,
          detail: entry.detail,
          createdAt: now,
          updatedAt: now,
        });
      }

      // 时间线展示流（U14）
      const event: StudentEvent = {
        id: `evt-${this.store.studentEvents.size + 1}`,
        studentId: entry.studentId,
        eventType: 'exam_score',
        occurredAt: exam.occurredAt,
        payload: {
          eventType: 'exam_score',
          examId: exam.id,
          ...(entry.score !== undefined ? { score: entry.score } : {}),
          ...(exam.subjectId ? { subjectId: exam.subjectId } : {}),
        },
        createdAt: now,
      };
      this.store.studentEvents.set(event.id, event);
      count++;
    }
    return count;
  }

  /** uniform 集合 → 全体共用单卷；custom-mistake → 每生各自卷；无集合 → null（对齐真实 resolvePaperScope） */
  private studentPaper(exam: Exam, studentId: string): string | null {
    if (!exam.paperSetId) return null;
    const refs = this.store.paperSetPapers.get(exam.paperSetId) ?? [];
    const uniformPaper = refs.find(r => !r.studentId)?.paperId ?? refs[0]?.paperId ?? null;
    if (this.store.paperSets.get(exam.paperSetId)?.type === 'uniform') return uniformPaper;
    return refs.find(r => r.studentId === studentId)?.paperId ?? null;
  }

  private getExamRow(examId: string): Exam {
    const exam = this.store.exams.get(examId);
    if (!exam) throw new Error(`Exam ${examId} not found`);
    return exam;
  }
}

// ---------------- paper set / preset / paper ext ----------------

export class MockPaperSetService implements PaperSetService {
  constructor(private store: MockBankStore) {}

  async createPaperSet(data: { name: string; type: PaperType; batchMeta?: Record<string, unknown> }): Promise<PaperSet> {
    // 0025 P3：结构与真实实现同口径校验（非法写入即拒绝，不静默吞）
    if (data.batchMeta) validateBatchMeta(data.batchMeta);
    const set: PaperSet = {
      id: `ps-${this.store.paperSets.size + 1}`,
      name: data.name,
      type: data.type,
      batchMeta: data.batchMeta,
      createdAt: new Date().toISOString(),
    };
    this.store.paperSets.set(set.id, set);
    this.store.paperSetPapers.set(set.id, []);
    this.store.log('paperSet.create', `Created ${set.id}`);
    return set;
  }

  async getPaperSet(id: string): Promise<PaperSet | null> {
    const set = this.store.paperSets.get(id);
    // 0025 P3：读出结构校验（坏数据显式报错，不静默回落 undefined）
    return set ? { ...set, batchMeta: this.checkedBatchMeta(set.batchMeta) } : null;
  }

  async listPaperSets(filter: { type?: PaperType } = {}): Promise<PaperSet[]> {
    let sets = Array.from(this.store.paperSets.values());
    if (filter.type) sets = sets.filter(s => s.type === filter.type);
    return sets.map(s => ({ ...s, batchMeta: this.checkedBatchMeta(s.batchMeta) }));
  }

  private checkedBatchMeta(meta: Record<string, unknown> | undefined): Record<string, unknown> | undefined {
    if (!meta) return undefined;
    validateBatchMeta(meta);
    return meta;
  }

  async addPaper(paperSetId: string, paperId: string, studentId?: string): Promise<void> {
    if (!this.store.paperSets.has(paperSetId)) throw new Error(`Paper set ${paperSetId} not found`);
    if (!this.store.papers.has(paperId)) throw new Error(`Paper ${paperId} not found`);
    const refs = this.store.paperSetPapers.get(paperSetId) ?? [];
    const existing = refs.find(r => r.paperId === paperId);
    if (existing) existing.studentId = studentId;
    else refs.push({ paperSetId, paperId, studentId });
    this.store.paperSetPapers.set(paperSetId, refs);
    this.store.log('paperSet.addPaper', `${paperId} → ${paperSetId}`);
  }

  async removePaper(paperSetId: string, paperId: string): Promise<void> {
    const refs = this.store.paperSetPapers.get(paperSetId) ?? [];
    this.store.paperSetPapers.set(paperSetId, refs.filter(r => r.paperId !== paperId));
    this.store.log('paperSet.removePaper', `${paperId} ⊣ ${paperSetId}`);
  }

  async getSetPapers(paperSetId: string): Promise<PaperSetPaperRef[]> {
    return [...(this.store.paperSetPapers.get(paperSetId) ?? [])];
  }

  async getStudentPaper(paperSetId: string, studentId: string): Promise<PaperSetPaperRef | null> {
    return (this.store.paperSetPapers.get(paperSetId) ?? []).find(r => r.studentId === studentId) ?? null;
  }

  async deletePaperSet(id: string): Promise<void> {
    this.store.paperSetPapers.delete(id);
    this.store.paperSets.delete(id);
    this.store.log('paperSet.delete', `${id}`);
  }
}

export class MockPresetService implements PresetService {
  constructor(private store: MockBankStore) {}

  async createPreset(data: { name: string; config: PaperLayoutConfig; isBuiltin?: boolean }): Promise<LayoutPreset> {
    const preset: MockPresetRow = {
      id: `preset-${this.store.presets.size + 1}`,
      name: data.name,
      config: data.config,
      isBuiltin: Boolean(data.isBuiltin),
      createdAt: new Date().toISOString(),
      deleted: false,
    };
    this.store.presets.set(preset.id, preset);
    this.store.log('preset.create', `Created ${preset.id}`);
    return { ...preset };
  }

  async getPreset(id: string): Promise<LayoutPreset | null> {
    const preset = this.store.presets.get(id);
    return preset && !preset.deleted ? { ...preset } : null;
  }

  async listPresets(filter: { includeDeleted?: boolean } = {}): Promise<LayoutPreset[]> {
    let presets = Array.from(this.store.presets.values());
    if (!filter.includeDeleted) presets = presets.filter(p => !p.deleted);
    // 内置在前、创建时间升序（对齐真实实现 ORDER BY is_builtin DESC, created_at）
    return presets
      .sort((a, b) => ((a.isBuiltin ? 0 : 1) - (b.isBuiltin ? 0 : 1)) || a.createdAt.localeCompare(b.createdAt))
      .map(p => ({ ...p }));
  }

  async updatePreset(id: string, data: { name?: string; config?: PaperLayoutConfig }): Promise<LayoutPreset> {
    const existing = this.store.presets.get(id);
    if (!existing || existing.deleted) throw new Error(`Preset ${id} not found`);
    // 0004 守卫补全（对齐真实实现）：内置预设不可改（应用可、改不可）
    if (existing.isBuiltin) throw new Error('Built-in preset cannot be updated');
    const updated: MockPresetRow = {
      ...existing,
      name: data.name ?? existing.name,
      config: data.config ?? existing.config,
    };
    this.store.presets.set(id, updated);
    this.store.log('preset.update', `Updated ${id}`);
    return { ...updated };
  }

  async deletePreset(id: string): Promise<void> {
    const existing = this.store.presets.get(id);
    if (!existing || existing.deleted) throw new Error(`Preset ${id} not found`);
    if (existing.isBuiltin) throw new Error('Built-in preset cannot be deleted');
    this.store.presets.set(id, { ...existing, deleted: true });
    this.store.log('preset.delete', `${id} (soft)`);
  }
}

export class MockPaperExtService implements PaperExtService {
  constructor(private store: MockBankStore) {}

  /**
   * 0004：题目操作复用 MockBankService 语义（来源门禁/字典 FK/弃用字段剥离与真实 QuestionService 对齐）。
   * 关播种：共享 store 已有业务数据，重播种会覆盖固定 id（q1..q5/p1）。
   */
  private questionOps(): MockBankService {
    return new MockBankService(this.store, false);
  }

  private summaryOf(paper: Paper): { paper: Paper; questionCount: number; totalScore: number } {
    const questions = this.store.paperQuestions.get(paper.id) ?? [];
    return {
      paper,
      questionCount: questions.length,
      totalScore: questions.reduce((sum, q) => sum + (q.score ?? 0), 0),
    };
  }

  async createPaperEx(title: string, config: Record<string, unknown> = {}, opts: { status?: PaperStatus; paperType?: PaperType } = {}): Promise<Paper> {
    const id = `p${this.store.papers.size + 1}`;
    const now = new Date().toISOString();
    const status = opts.status ?? 'basket';
    const paper = {
      id,
      title,
      config,
      createdAt: now,
      archived: status === 'archived',
      status,
      paperType: opts.paperType ?? 'uniform',
    };
    this.store.papers.set(id, paper);
    this.store.paperQuestions.set(id, []);
    this.store.log('paper.create', `Created paper ${id}`);
    return paper;
  }

  async updatePaperStatus(id: string, status: PaperStatus): Promise<void> {
    const paper = this.store.papers.get(id);
    if (!paper) throw new Error(`Paper ${id} not found`);
    const current = paper.status ?? 'basket';
    if (current !== status && !ALLOWED_TRANSITIONS[current].includes(status)) {
      throw new Error(`Illegal paper status transition: ${current} -> ${status}`);
    }
    // 0044：入回收站记 trashedFrom（内存对齐 papers.trashed_from 列语义）
    const updated = { ...paper, status, archived: status === 'archived' } as Paper & { trashedFrom?: string };
    if (status === 'trashed') {
      updated.trashedFrom = current;
    } else {
      delete updated.trashedFrom;
    }
    this.store.papers.set(id, updated);
    this.store.log('paper.updateStatus', `${id} → ${status}`);
  }

  async setPaperLayoutConfig(id: string, layoutConfig: PaperLayoutConfig): Promise<void> {
    const paper = this.store.papers.get(id);
    if (!paper) throw new Error(`Paper ${id} not found`);
    this.store.papers.set(id, { ...paper, layoutConfig });
    this.store.log('paper.setLayoutConfig', `${id}`);
  }

  async listPapersEx(filter: { statuses?: PaperStatus[] } = {}): Promise<Array<{ paper: Paper; questionCount: number; totalScore: number }>> {
    let papers = Array.from(this.store.papers.values());
    if (filter.statuses && filter.statuses.length > 0) {
      papers = papers.filter(p => filter.statuses!.includes(p.status ?? 'basket'));
    } else {
      // 0044：缺省排除 trashed（与真实实现同口径）
      papers = papers.filter(p => (p.status ?? 'basket') !== 'trashed');
    }
    // 对齐真实实现：created_at DESC
    return papers.sort((a, b) => b.createdAt.localeCompare(a.createdAt)).map(p => this.summaryOf(p));
  }

  async getPaperEx(id: string): Promise<Paper | null> {
    // 与真实实现语义对齐：不过滤 archived（getPaper 才过滤）
    return this.store.papers.get(id) ?? null;
  }

  async snapshotPaperQuestions(paperId: string): Promise<number> {
    const paper = this.store.papers.get(paperId);
    if (!paper) throw new Error(`Paper ${paperId} not found`);

    const refs = [...(this.store.paperQuestions.get(paperId) ?? [])].sort((a, b) => a.position - b.position);
    const questions: Question[] = [];
    for (const ref of refs) {
      // 0004-fix-4 2.3：文本内容块不是题（不产快照行；正文随 paper_questions 行带出）
      if (ref.kind === 'text') continue;
      const q = this.store.questions.get(ref.questionId);
      // 题不存在（含软删——mock 软删即移除）抛错：done 卷绝不允许缺题快照
      if (!q) throw new Error(`Question ${ref.questionId} not found (missing or deleted); snapshot aborted`);
      questions.push(q);
    }

    const snapMap = this.store.paperSnapshots.get(paperId) ?? new Map<string, string>();
    for (const q of questions) {
      snapMap.set(q.id, JSON.stringify(q));
    }
    this.store.paperSnapshots.set(paperId, snapMap);
    this.store.log('paper.snapshot', `Snapshot ${questions.length} questions of paper ${paperId}`);
    return questions.length;
  }

  async listPaperSnapshotQuestions(paperId: string): Promise<Question[]> {
    const snapMap = this.store.paperSnapshots.get(paperId);
    if (!snapMap) return [];
    // 只还原仍在卷内的快照，按 position 序（与真实实现 JOIN paper_queries 语义对齐）
    const refs = [...(this.store.paperQuestions.get(paperId) ?? [])].sort((a, b) => a.position - b.position);
    const result: Question[] = [];
    for (const ref of refs) {
      const json = snapMap.get(ref.questionId);
      if (json !== undefined) result.push(JSON.parse(json) as Question);
    }
    return result;
  }

  async clonePaperToBasket(sourcePaperId: string, title?: string): Promise<Paper> {
    const source = this.store.papers.get(sourcePaperId);
    if (!source) throw new Error(`Paper ${sourcePaperId} not found`);

    const questionOps = this.questionOps();
    const refs = [...(this.store.paperQuestions.get(sourcePaperId) ?? [])].sort((a, b) => a.position - b.position);
    const snapMap = this.store.paperSnapshots.get(sourcePaperId) ?? new Map<string, string>();

    const resolved: Array<{
      questionId: string;
      score?: number;
      layout?: { figures?: QuestionFigureLayout[]; answerSpace?: QuestionAnswerSpaceOverride };
      textBlock?: { text: string; style?: 'section' | 'note'; align?: 'left' | 'center' | 'right' };
    }> = [];
    const skipped: string[] = [];
    for (const ref of refs) {
      // 0004-fix-4 2.3：文本内容块随行拷贝（kind/textBody/style；无 questions 行可解析）；fix-6：align
      if (ref.kind === 'text') {
        resolved.push({
          questionId: ref.questionId,
          textBlock: {
            text: ref.textBody ?? '',
            ...(ref.style ? { style: ref.style } : {}),
            ...(ref.align ? { align: ref.align } : {}),
          },
        });
        continue;
      }
      const snapshotJson = snapMap.get(ref.questionId);
      if (snapshotJson !== undefined) {
        const original = this.store.questions.get(ref.questionId);
        if (original) {
          resolved.push({ questionId: ref.questionId, score: ref.score, layout: ref.layout });
        } else {
          // 原题软删/不存在：从快照重建新题再引用（题目不可变原则）
          const snapQuestion = JSON.parse(snapshotJson) as Question;
          const { id: _id, createdAt: _c, updatedAt: _u, ...rebuildData } = snapQuestion;
          void _id; void _c; void _u;
          const rebuilt = await questionOps.createQuestion(rebuildData);
          resolved.push({ questionId: rebuilt.id, score: ref.score, layout: ref.layout });
        }
      } else {
        const q = this.store.questions.get(ref.questionId);
        if (q) {
          resolved.push({ questionId: q.id, score: ref.score, layout: ref.layout });
        } else {
          skipped.push(ref.questionId);
        }
      }
    }

    const newTitle = title !== undefined ? title : `${source.title}复制`;
    const newPaper = await this.createPaperEx(newTitle, source.config, {
      status: 'basket',
      paperType: source.paperType ?? 'uniform',
    });
    if (source.layoutConfig) {
      await this.setPaperLayoutConfig(newPaper.id, source.layoutConfig);
    }
    for (const item of resolved) {
      // 0004-fix-2 F2-E：题级图排版覆盖随行拷贝（语义对齐真实 layout_json 列拷贝）
      // 0004-fix-4 2.3：文本内容块随行拷贝
      await this.createPaperExAddQuestion(newPaper.id, item.questionId, item.score, item.layout, item.textBlock);
    }

    if (skipped.length > 0) {
      this.store.log('paper.clone', `Clone paper ${sourcePaperId} → ${newPaper.id}; skipped missing questions: ${skipped.join(', ')}`);
    }
    // 返回值带 layoutConfig（setPaperLayoutConfig 在 createPaperEx 之后落库）
    return source.layoutConfig ? { ...newPaper, layoutConfig: source.layoutConfig } : newPaper;
  }

  /** clone 专用加引用（position 顺延 + score/layout_json 拷贝；对齐真实 addQuestion） */
  private createPaperExAddQuestion(paperId: string, questionId: string, score?: number, layout?: { figures?: QuestionFigureLayout[]; answerSpace?: QuestionAnswerSpaceOverride }, textBlock?: { text: string; style?: 'section' | 'note'; align?: 'left' | 'center' | 'right' }): void {
    const questions = this.store.paperQuestions.get(paperId) ?? [];
    questions.push({
      questionId,
      position: questions.length,
      score,
      frozen: false,
      ...(layout ? { layout: JSON.parse(JSON.stringify(layout)) as { figures?: QuestionFigureLayout[]; answerSpace?: QuestionAnswerSpaceOverride } } : {}),
      ...(textBlock ? {
        kind: 'text' as const,
        textBody: textBlock.text,
        style: textBlock.style ?? 'section',
        ...(textBlock.align ? { align: textBlock.align } : {}),
      } : {}),
    });
    this.store.paperQuestions.set(paperId, questions);
    this.store.log('paper.addQuestion', `Added ${questionId} to ${paperId}`);
  }

  async updatePaperTitle(id: string, title: string): Promise<Paper> {
    if (!title || !title.trim()) throw new Error('Paper title cannot be empty');
    const paper = this.store.papers.get(id);
    if (!paper) throw new Error(`Paper ${id} not found`);
    const updated = { ...paper, title };
    this.store.papers.set(id, updated);
    this.store.log('paper.updateTitle', `Renamed ${id}`);
    return updated;
  }

  async setQuestionLayouts(paperId: string, questionId: string, layout: { figures?: QuestionFigureLayout[]; answerSpace?: QuestionAnswerSpaceOverride }): Promise<void> {
    const refs = this.store.paperQuestions.get(paperId) ?? [];
    const ref = refs.find(r => r.questionId === questionId);
    // 语义对齐真实实现：卷-题引用不存在抛错
    if (!ref) throw new Error(`Question ${questionId} not found in paper ${paperId}`);
    ref.layout = JSON.parse(JSON.stringify(layout)) as { figures?: QuestionFigureLayout[]; answerSpace?: QuestionAnswerSpaceOverride };
    this.store.log('paper.setQuestionLayouts', `Set layouts for ${questionId} in ${paperId}`);
  }

  // ==================== 0044（只增）：文件夹 + 回收站（内存对齐真实 PaperService） ====================

  async listFolders(): Promise<PaperFolder[]> {
    return Array.from(this.store.paperFolders.values())
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id))
      .map((f) => ({ ...f }));
  }

  async createFolder(data: { name: string; parentId?: string }): Promise<PaperFolder> {
    const name = data.name.trim();
    if (!name) throw new Error('Folder name cannot be empty');
    if (data.parentId !== undefined && !this.store.paperFolders.has(data.parentId)) {
      throw new Error(`Parent folder ${data.parentId} not found`);
    }
    const id = `pf-${this.store.paperFolders.size + 1}`;
    const folder: PaperFolder = {
      id,
      name,
      ...(data.parentId ? { parentId: data.parentId } : {}),
      sort: 0,
      createdAt: new Date().toISOString(),
    };
    this.store.paperFolders.set(id, folder);
    this.store.log('paper.folder.create', `Created folder ${id}`);
    return { ...folder };
  }

  async renameFolder(id: string, name: string): Promise<PaperFolder> {
    const trimmed = name.trim();
    if (!trimmed) throw new Error('Folder name cannot be empty');
    const folder = this.store.paperFolders.get(id);
    if (!folder) throw new Error(`Folder ${id} not found`);
    const updated = { ...folder, name: trimmed };
    this.store.paperFolders.set(id, updated);
    this.store.log('paper.folder.rename', `Renamed ${id}`);
    return { ...updated };
  }

  async deleteFolder(id: string): Promise<void> {
    const folder = this.store.paperFolders.get(id);
    if (!folder) throw new Error(`Folder ${id} not found`);
    // D-062：夹内卷回未分类 + 子夹上移一级
    for (const paper of this.store.papers.values()) {
      if (paper.folderId === id) this.store.papers.set(paper.id, { ...paper, folderId: undefined });
    }
    for (const other of this.store.paperFolders.values()) {
      if (other.parentId === id) {
        this.store.paperFolders.set(other.id, { ...other, ...(folder.parentId ? { parentId: folder.parentId } : { parentId: undefined }) });
      }
    }
    this.store.paperFolders.delete(id);
    this.store.log('paper.folder.delete', `Deleted ${id}`);
  }

  async moveToFolder(paperId: string, folderId: string | null): Promise<void> {
    const paper = this.store.papers.get(paperId);
    if (!paper) throw new Error(`Paper ${paperId} not found`);
    if (folderId !== null && !this.store.paperFolders.has(folderId)) {
      throw new Error(`Folder ${folderId} not found`);
    }
    const updated = { ...paper } as Paper & { folderId?: string };
    if (folderId === null) delete updated.folderId;
    else updated.folderId = folderId;
    this.store.papers.set(paperId, updated);
    this.store.log('paper.moveToFolder', `${paperId} → ${folderId ?? '(none)'}`);
  }

  async trashPaper(id: string): Promise<void> {
    const paper = this.store.papers.get(id);
    if (!paper) throw new Error(`Paper ${id} not found`);
    const current = paper.status ?? 'basket';
    if (current === 'trashed') throw new Error(`Paper ${id} is already trashed`);
    this.store.papers.set(id, { ...paper, status: 'trashed', archived: false, trashedFrom: current } as Paper & { trashedFrom: string });
    this.store.log('paper.trash', `${id} (from ${current})`);
  }

  async restorePaper(id: string): Promise<void> {
    const paper = this.store.papers.get(id) as (Paper & { trashedFrom?: string }) | undefined;
    if (!paper) throw new Error(`Paper ${id} not found`);
    if (paper.status !== 'trashed') throw new Error(`Paper ${id} is not in trash`);
    if (!paper.trashedFrom) throw new Error(`Paper ${id} has no trashedFrom recorded`);
    const restored = { ...paper, status: paper.trashedFrom, archived: paper.trashedFrom === 'archived' } as Paper & { trashedFrom?: string };
    delete restored.trashedFrom;
    this.store.papers.set(id, restored);
    this.store.log('paper.restore', `${id} → ${paper.trashedFrom}`);
  }

  async deleteForeverPaper(id: string): Promise<void> {
    const paper = this.store.papers.get(id);
    if (!paper) throw new Error(`Paper ${id} not found`);
    if (paper.status !== 'trashed') throw new Error(`Paper ${id} is not in trash; deleteForever only works on trashed papers`);
    this.store.paperQuestions.delete(id);
    this.store.paperSnapshots.delete(id);
    for (const [setId, refs] of this.store.paperSetPapers) {
      this.store.paperSetPapers.set(setId, refs.filter((r) => r.paperId !== id));
    }
    this.store.papers.delete(id);
    this.store.log('paper.deleteForever', `Deleted forever ${id}`);
  }
}

// 状态迁移表（与真实 paper-service ALLOWED_TRANSITIONS 保持一致）
// 0044：任意非 trashed → trashed（回收站）；trashed 无出边（restorePaper 专用）
const ALLOWED_TRANSITIONS: Record<PaperStatus, PaperStatus[]> = {
  basket: ['composing', 'archived', 'trashed'],
  composing: ['basket', 'done', 'archived', 'trashed'],
  done: ['archived', 'trashed'],
  archived: ['done', 'trashed'],
  trashed: [],
};

/** mock 扩展服务组装（与 createExtServices 对应；同一 store 跨服务共享） */
// 0005：MockFeedbackService（语义对齐真实 FeedbackServiceImpl：内置只读守卫 + 用户软删）
export class MockFeedbackService implements FeedbackService {
  constructor(private store: MockBankStore) {}

  async createTemplate(data: FeedbackTemplateInput): Promise<FeedbackTemplate> {
    if (!data.name || !data.name.trim()) throw new Error('Feedback template name cannot be empty');
    if (!data.bodyTemplate || !data.bodyTemplate.trim()) throw new Error('Feedback template body cannot be empty');
    const id = `feedback-tpl-${this.store.feedbackTemplates.size + 1}`;
    const now = new Date().toISOString();
    const template: FeedbackTemplate & { deleted: boolean } = {
      id, name: data.name, bodyTemplate: data.bodyTemplate,
      isBuiltin: false, createdAt: now, updatedAt: now, deleted: false,
    };
    this.store.feedbackTemplates.set(id, template);
    this.store.log('feedback.create', `Create feedback template: ${data.name}`);
    const { deleted: _d, ...rest } = template;
    void _d;
    return rest;
  }

  async getTemplate(id: string): Promise<FeedbackTemplate | null> {
    const row = this.store.feedbackTemplates.get(id);
    if (!row || row.deleted) return null;
    const { deleted: _d, ...rest } = row;
    void _d;
    return rest;
  }

  async listTemplates(filter?: { includeDeleted?: boolean }): Promise<FeedbackTemplate[]> {
    const rows = [...this.store.feedbackTemplates.values()]
      .filter((t) => filter?.includeDeleted || !t.deleted)
      .sort((a, b) => (a.isBuiltin === b.isBuiltin ? a.createdAt.localeCompare(b.createdAt) : a.isBuiltin ? -1 : 1));
    return rows.map(({ deleted: _d, ...rest }) => { void _d; return rest; });
  }

  async updateTemplate(id: string, data: Partial<FeedbackTemplateInput>): Promise<FeedbackTemplate> {
    const row = this.store.feedbackTemplates.get(id);
    if (!row || row.deleted) throw new Error(`Feedback template ${id} not found`);
    if (row.isBuiltin) throw new Error('Builtin feedback template cannot be updated');
    if (data.name !== undefined) {
      if (!data.name.trim()) throw new Error('Feedback template name cannot be empty');
      row.name = data.name;
    }
    if (data.bodyTemplate !== undefined) {
      if (!data.bodyTemplate.trim()) throw new Error('Feedback template body cannot be empty');
      row.bodyTemplate = data.bodyTemplate;
    }
    row.updatedAt = new Date().toISOString();
    this.store.log('feedback.update', `Update feedback template ${id}`);
    const { deleted: _d, ...rest } = row;
    void _d;
    return rest;
  }

  async deleteTemplate(id: string): Promise<void> {
    const row = this.store.feedbackTemplates.get(id);
    if (!row || row.deleted) throw new Error(`Feedback template ${id} not found`);
    if (row.isBuiltin) throw new Error('Builtin feedback template cannot be deleted');
    row.deleted = true;
    row.updatedAt = new Date().toISOString();
    this.store.log('feedback.delete', `Delete feedback template ${id}`);
  }
}

// 0030（只增）：MockFeedbackPromptTemplateService（语义对齐真实实现：内置只读守卫 + 用户软删）
export class MockFeedbackPromptTemplateService implements FeedbackPromptTemplateService {
  constructor(private store: MockBankStore) {}

  async createTemplate(data: FeedbackPromptTemplateInput): Promise<FeedbackPromptTemplate> {
    if (!data.name || !data.name.trim()) throw new Error('Feedback prompt template name cannot be empty');
    if (!data.body || !data.body.trim()) throw new Error('Feedback prompt template body cannot be empty');
    const id = `feedback-prompt-${this.store.feedbackPromptTemplates.size + 1}`;
    const now = new Date().toISOString();
    const template: FeedbackPromptTemplate & { deleted: boolean } = {
      id, name: data.name, body: data.body, isBuiltin: false, createdAt: now, updatedAt: now, deleted: false,
    };
    this.store.feedbackPromptTemplates.set(id, template);
    this.store.log('feedback.prompt.create', `Create feedback prompt template: ${data.name}`);
    const { deleted: _d, ...rest } = template;
    void _d;
    return rest;
  }

  async getTemplate(id: string): Promise<FeedbackPromptTemplate | null> {
    const row = this.store.feedbackPromptTemplates.get(id);
    if (!row || row.deleted) return null;
    const { deleted: _d, ...rest } = row;
    void _d;
    return rest;
  }

  async listTemplates(filter?: { includeDeleted?: boolean }): Promise<FeedbackPromptTemplate[]> {
    const rows = [...this.store.feedbackPromptTemplates.values()]
      .filter((t) => filter?.includeDeleted || !t.deleted)
      .sort((a, b) => (a.isBuiltin === b.isBuiltin ? a.createdAt.localeCompare(b.createdAt) : a.isBuiltin ? -1 : 1));
    return rows.map(({ deleted: _d, ...rest }) => { void _d; return rest; });
  }

  async updateTemplate(id: string, data: Partial<FeedbackPromptTemplateInput>): Promise<FeedbackPromptTemplate> {
    const row = this.store.feedbackPromptTemplates.get(id);
    if (!row || row.deleted) throw new Error(`Feedback prompt template ${id} not found`);
    if (row.isBuiltin) throw new Error('Builtin feedback prompt template cannot be updated');
    if (data.name !== undefined) {
      if (!data.name.trim()) throw new Error('Feedback prompt template name cannot be empty');
      row.name = data.name;
    }
    if (data.body !== undefined) {
      if (!data.body.trim()) throw new Error('Feedback prompt template body cannot be empty');
      row.body = data.body;
    }
    row.updatedAt = new Date().toISOString();
    this.store.log('feedback.prompt.update', `Update feedback prompt template ${id}`);
    const { deleted: _d, ...rest } = row;
    void _d;
    return rest;
  }

  async deleteTemplate(id: string): Promise<void> {
    const row = this.store.feedbackPromptTemplates.get(id);
    if (!row || row.deleted) throw new Error(`Feedback prompt template ${id} not found`);
    if (row.isBuiltin) throw new Error('Builtin feedback prompt template cannot be deleted');
    row.deleted = true;
    row.updatedAt = new Date().toISOString();
    this.store.log('feedback.prompt.delete', `Delete feedback prompt template ${id}`);
  }
}

// 0030（只增）：MockFeedbackRecordService（语义对齐真实实现：两态落档 + 班级/姓名筛选 + 时间倒序）
export class MockFeedbackRecordService implements FeedbackRecordService {
  constructor(private store: MockBankStore) {}

  async createRecord(data: FeedbackRecordInput): Promise<FeedbackRecord> {
    if (!data.studentName || !data.studentName.trim()) throw new Error('Feedback record studentName cannot be empty');
    if (data.channel !== 'offline' && data.channel !== 'ai') {
      throw new Error('Feedback record channel must be one of: offline, ai');
    }
    if (!data.body || !data.body.trim()) throw new Error('Feedback record body cannot be empty');
    if (!data.inputJson || !data.inputJson.trim()) throw new Error('Feedback record inputJson cannot be empty');

    const id = `feedback-rec-${this.store.feedbackRecords.size + 1}`;
    const now = new Date().toISOString();
    const record: FeedbackRecord = {
      id,
      studentId: data.studentId ?? null,
      studentName: data.studentName,
      classId: data.classId ?? null,
      examId: data.examId ?? null,
      channel: data.channel,
      promptTemplateId: data.promptTemplateId ?? null,
      promptSnapshot: data.promptSnapshot ?? null,
      modelProfileId: data.modelProfileId ?? null,
      inputJson: data.inputJson,
      body: data.body,
      createdAt: now,
      updatedAt: now,
    };
    this.store.feedbackRecords.set(id, record);
    this.store.log('feedback.record.create', `Create feedback record: ${data.studentName}`);
    return { ...record };
  }

  async getRecord(id: string): Promise<FeedbackRecord | null> {
    const row = this.store.feedbackRecords.get(id);
    return row ? { ...row } : null;
  }

  async listRecords(query?: FeedbackRecordQuery): Promise<FeedbackRecord[]> {
    const keyword = (query?.studentName ?? '').trim();
    return [...this.store.feedbackRecords.values()]
      .filter((r) => (query?.classId ? r.classId === query.classId : true))
      .filter((r) => (keyword === '' ? true : r.studentName.includes(keyword)))
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .map((r) => ({ ...r }));
  }

  async updateRecord(id: string, data: FeedbackRecordPatch): Promise<FeedbackRecord> {
    const row = this.store.feedbackRecords.get(id);
    if (!row) throw new Error(`Feedback record ${id} not found`);
    if (data.body !== undefined) {
      if (!data.body.trim()) throw new Error('Feedback record body cannot be empty');
      row.body = data.body;
    }
    if (data.studentName !== undefined) {
      if (!data.studentName.trim()) throw new Error('Feedback record studentName cannot be empty');
      row.studentName = data.studentName;
    }
    row.updatedAt = new Date().toISOString();
    this.store.log('feedback.record.update', `Update feedback record ${id}`);
    return { ...row };
  }

  async deleteRecord(id: string): Promise<void> {
    if (!this.store.feedbackRecords.has(id)) throw new Error(`Feedback record ${id} not found`);
    this.store.feedbackRecords.delete(id);
    this.store.log('feedback.record.delete', `Delete feedback record ${id}`);
  }
}

export function createMockExtServices(store: MockBankStore): BankExtServices {
  return {
    dict: new MockDictService(store),
    tree: new MockTreeService(store),
    student: new MockStudentService(store),
    class: new MockClassService(store),
    exam: new MockExamService(store, new MockMistakeService(store)),
    mistake: new MockMistakeService(store),
    paperSet: new MockPaperSetService(store),
    preset: new MockPresetService(store),
    // 0005（只增）：课后反馈模板 CRUD
    feedback: new MockFeedbackService(store),
    // 0030（只增）：AI 通道提示词模板（内置只读）+ 反馈记录落档（双模式）
    feedbackPrompt: new MockFeedbackPromptTemplateService(store),
    feedbackRecord: new MockFeedbackRecordService(store),
    paper: new MockPaperExtService(store),
  };
}
