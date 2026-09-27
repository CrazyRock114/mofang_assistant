// 0002: 学生/班级服务（B6）——students/classes/student_classes/student_events
// 学生封存 = status=archived（信息保留、列表默认隐藏、历史不丢）；
// 时间线 payload 类型化 + service 校验；筛选：类别 × 时间范围 × 班级时期。

import type {
  Student, StudentStatus, ClassInfo, ClassStatus, StudentClassPeriod,
  StudentEvent, StudentEventType, StudentEventPayload,
  StudentService, ClassService,
} from '../shared/contracts/bank-types.js';
import type { Database } from './db.js';
import { OperationLogger } from './operation-log.js';
// 0003：payload 校验移至独立模块（mock 服务 renderer 复用不引入 db 链），原位 re-export 保持兼容
import { validateEventPayload } from './event-payload.js';

export { validateEventPayload };

export class StudentServiceImpl implements StudentService {
  private logger: OperationLogger;

  constructor(private db: Database) {
    this.logger = new OperationLogger(db);
  }

  async createStudent(data: { name: string; studentNo?: string; gender?: string; school?: string; remark?: string }): Promise<Student> {
    return this.logger.wrap('student.create', `Create student: ${data.name}`, () => {
      if (!data.name || !data.name.trim()) throw new Error('Student name is required');

      const id = crypto.randomUUID();
      const now = new Date().toISOString();

      this.db.prepare(`
        INSERT INTO students (id, student_no, name, gender, school, remark, status, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, 'active', ?, ?)
      `).run(id, data.studentNo ?? null, data.name, data.gender ?? null, data.school ?? null, data.remark ?? null, now, now);

      return {
        id,
        studentNo: data.studentNo,
        name: data.name,
        gender: data.gender,
        school: data.school,
        remark: data.remark,
        status: 'active',
        createdAt: now,
        updatedAt: now,
      };
    });
  }

  async getStudent(id: string): Promise<Student | null> {
    const row = this.db.prepare('SELECT * FROM students WHERE id = ?').get(id) as any;
    return row ? this.rowToStudent(row) : null;
  }

  async listStudents(filter: { includeArchived?: boolean; classId?: string; keyword?: string } = {}): Promise<Student[]> {
    let sql = 'SELECT DISTINCT s.* FROM students s';
    const params: any[] = [];
    const where: string[] = [];

    if (filter.classId) {
      sql += ' JOIN student_classes sc ON sc.student_id = s.id';
      where.push('sc.class_id = ?');
      params.push(filter.classId);
    }

    // B6：封存列表默认隐藏，按需查看
    if (!filter.includeArchived) {
      where.push("s.status = 'active'");
    }
    if (filter.keyword) {
      where.push('(s.name LIKE ? OR s.student_no LIKE ?)');
      params.push(`%${filter.keyword}%`, `%${filter.keyword}%`);
    }

    if (where.length > 0) sql += ' WHERE ' + where.join(' AND ');
    sql += ' ORDER BY s.created_at';

    const rows = this.db.prepare(sql).all(...params) as any[];
    return rows.map(row => this.rowToStudent(row));
  }

  async updateStudent(id: string, data: Partial<Omit<Student, 'id' | 'createdAt' | 'updatedAt' | 'status'>>): Promise<Student> {
    return this.logger.wrap('student.update', `Update student ${id}`, () => {
      const existing = this.db.prepare('SELECT * FROM students WHERE id = ?').get(id) as any;
      if (!existing) throw new Error(`Student ${id} not found`);

      const next = {
        student_no: data.studentNo !== undefined ? data.studentNo : existing.student_no,
        name: data.name !== undefined ? data.name : existing.name,
        gender: data.gender !== undefined ? data.gender : existing.gender,
        school: data.school !== undefined ? data.school : existing.school,
        remark: data.remark !== undefined ? data.remark : existing.remark,
      };

      this.db.prepare(`
        UPDATE students SET student_no = ?, name = ?, gender = ?, school = ?, remark = ?, updated_at = ?
        WHERE id = ?
      `).run(next.student_no, next.name, next.gender, next.school, next.remark, new Date().toISOString(), id);

      return this.rowToStudent({ ...existing, ...next, updated_at: new Date().toISOString() });
    });
  }

  async setStudentStatus(id: string, status: StudentStatus): Promise<Student> {
    return this.logger.wrap('student.setStatus', `Set student ${id} status to ${status}`, () => {
      const now = new Date().toISOString();
      const result = this.db.prepare('UPDATE students SET status = ?, updated_at = ? WHERE id = ?').run(status, now, id);
      if (result.changes === 0) throw new Error(`Student ${id} not found`);
      const row = this.db.prepare('SELECT * FROM students WHERE id = ?').get(id) as any;
      return this.rowToStudent(row);
    });
  }

  async enrollStudent(studentId: string, classId: string, startedAt?: string): Promise<StudentClassPeriod> {
    return this.logger.wrap('student.enroll', `Enroll student ${studentId} into class ${classId}`, () => {
      if (!this.db.prepare('SELECT id FROM students WHERE id = ?').get(studentId)) throw new Error(`Student ${studentId} not found`);
      if (!this.db.prepare('SELECT id FROM classes WHERE id = ?').get(classId)) throw new Error(`Class ${classId} not found`);

      // 同班存在未结束时期时拒绝（一人一班最多一个在读时期）
      const open = this.db.prepare(`
        SELECT student_id FROM student_classes
        WHERE student_id = ? AND class_id = ? AND ended_at IS NULL
      `).get(studentId, classId) as any;
      if (open) throw new Error(`Student ${studentId} already has an open enrollment in class ${classId}`);

      const period: StudentClassPeriod = { studentId, classId, startedAt, endedAt: undefined };
      this.db.prepare(`
        INSERT INTO student_classes (student_id, class_id, started_at, ended_at)
        VALUES (?, ?, ?, NULL)
      `).run(studentId, classId, startedAt ?? null);

      return period;
    });
  }

  async endEnrollment(studentId: string, classId: string, endedAt: string): Promise<void> {
    this.logger.wrap('student.endEnrollment', `End enrollment of ${studentId} in ${classId}`, () => {
      const result = this.db.prepare(`
        UPDATE student_classes SET ended_at = ?
        WHERE student_id = ? AND class_id = ? AND ended_at IS NULL
      `).run(endedAt, studentId, classId);
      if (result.changes === 0) throw new Error(`No open enrollment for student ${studentId} in class ${classId}`);
    });
  }

  async getStudentClasses(studentId: string): Promise<Array<StudentClassPeriod & { className?: string }>> {
    const rows = this.db.prepare(`
      SELECT sc.student_id, sc.class_id, sc.started_at, sc.ended_at, c.name AS class_name
      FROM student_classes sc LEFT JOIN classes c ON c.id = sc.class_id
      WHERE sc.student_id = ?
      ORDER BY sc.started_at
    `).all(studentId) as any[];
    return rows.map(row => ({
      studentId: row.student_id,
      classId: row.class_id,
      startedAt: row.started_at ?? undefined,
      endedAt: row.ended_at ?? undefined,
      className: row.class_name ?? undefined,
    }));
  }

  async getClassStudents(classId: string): Promise<StudentClassPeriod[]> {
    const rows = this.db.prepare(`
      SELECT student_id, class_id, started_at, ended_at
      FROM student_classes WHERE class_id = ?
      ORDER BY started_at
    `).all(classId) as any[];
    return rows.map(row => ({
      studentId: row.student_id,
      classId: row.class_id,
      startedAt: row.started_at ?? undefined,
      endedAt: row.ended_at ?? undefined,
    }));
  }

  async addEvent(data: { studentId: string; eventType: StudentEventType; occurredAt: string; payload: StudentEventPayload }): Promise<StudentEvent> {
    return this.logger.wrap('student.addEvent', `Add ${data.eventType} event for student ${data.studentId}`, () => {
      if (!this.db.prepare('SELECT id FROM students WHERE id = ?').get(data.studentId)) {
        throw new Error(`Student ${data.studentId} not found`);
      }
      validateEventPayload(data.eventType, data.payload);

      const id = crypto.randomUUID();
      const now = new Date().toISOString();

      this.db.prepare(`
        INSERT INTO student_events (id, student_id, event_type, occurred_at, payload_json, created_at)
        VALUES (?, ?, ?, ?, ?, ?)
      `).run(id, data.studentId, data.eventType, data.occurredAt, JSON.stringify(data.payload), now);

      return {
        id,
        studentId: data.studentId,
        eventType: data.eventType,
        occurredAt: data.occurredAt,
        payload: data.payload,
        createdAt: now,
      };
    });
  }

  async listEvents(filter: { studentId: string; eventType?: StudentEventType; from?: string; to?: string; classId?: string }): Promise<StudentEvent[]> {
    let sql = 'SELECT se.* FROM student_events se';
    const params: any[] = [];
    const where: string[] = ['se.student_id = ?'];
    params.push(filter.studentId);

    if (filter.classId) {
      // 班级时期筛选：事件发生时间落在该生的 [started_at, ended_at] 时期内
      sql += ` JOIN student_classes sc ON sc.student_id = se.student_id
        AND (sc.started_at IS NULL OR se.occurred_at >= sc.started_at)
        AND (sc.ended_at IS NULL OR se.occurred_at <= sc.ended_at)`;
      where.push('sc.class_id = ?');
      params.push(filter.classId);
    }
    if (filter.eventType) {
      where.push('se.event_type = ?');
      params.push(filter.eventType);
    }
    if (filter.from) {
      where.push('se.occurred_at >= ?');
      params.push(filter.from);
    }
    if (filter.to) {
      where.push('se.occurred_at <= ?');
      params.push(filter.to);
    }

    sql += ' WHERE ' + where.join(' AND ');
    sql += ' GROUP BY se.id ORDER BY se.occurred_at DESC';

    const rows = this.db.prepare(sql).all(...params) as any[];
    return rows.map(row => ({
      id: row.id,
      studentId: row.student_id,
      eventType: row.event_type,
      occurredAt: row.occurred_at,
      payload: JSON.parse(row.payload_json) as StudentEventPayload,
      createdAt: row.created_at,
    }));
  }

  private rowToStudent(row: any): Student {
    return {
      id: row.id,
      studentNo: row.student_no ?? undefined,
      name: row.name,
      gender: row.gender ?? undefined,
      school: row.school ?? undefined,
      remark: row.remark ?? undefined,
      status: row.status,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }
}

export class ClassServiceImpl implements ClassService {
  private logger: OperationLogger;

  constructor(private db: Database) {
    this.logger = new OperationLogger(db);
  }

  async createClass(data: { name: string; school?: string; gradeLevel?: string; term?: string }): Promise<ClassInfo> {
    return this.logger.wrap('class.create', `Create class: ${data.name}`, () => {
      if (!data.name || !data.name.trim()) throw new Error('Class name is required');

      const id = crypto.randomUUID();
      const now = new Date().toISOString();

      this.db.prepare(`
        INSERT INTO classes (id, name, school, grade_level, term, status, created_at)
        VALUES (?, ?, ?, ?, ?, 'active', ?)
      `).run(id, data.name, data.school ?? null, data.gradeLevel ?? null, data.term ?? null, now);

      return {
        id,
        name: data.name,
        school: data.school,
        gradeLevel: data.gradeLevel,
        term: data.term,
        status: 'active',
        createdAt: now,
      };
    });
  }

  async getClass(id: string): Promise<ClassInfo | null> {
    const row = this.db.prepare('SELECT * FROM classes WHERE id = ?').get(id) as any;
    return row ? this.rowToClass(row) : null;
  }

  async listClasses(filter: { status?: ClassStatus | 'all' } = {}): Promise<ClassInfo[]> {
    let sql = 'SELECT * FROM classes';
    const params: any[] = [];
    if (filter.status && filter.status !== 'all') {
      sql += ' WHERE status = ?';
      params.push(filter.status);
    }
    sql += ' ORDER BY created_at';

    const rows = this.db.prepare(sql).all(...params) as any[];
    return rows.map(row => this.rowToClass(row));
  }

  async updateClass(id: string, data: Partial<Omit<ClassInfo, 'id' | 'createdAt'>>): Promise<ClassInfo> {
    return this.logger.wrap('class.update', `Update class ${id}`, () => {
      const existing = this.db.prepare('SELECT * FROM classes WHERE id = ?').get(id) as any;
      if (!existing) throw new Error(`Class ${id} not found`);

      const next = {
        name: data.name !== undefined ? data.name : existing.name,
        school: data.school !== undefined ? data.school : existing.school,
        grade_level: data.gradeLevel !== undefined ? data.gradeLevel : existing.grade_level,
        term: data.term !== undefined ? data.term : existing.term,
        status: data.status !== undefined ? data.status : existing.status,
      };

      this.db.prepare(`
        UPDATE classes SET name = ?, school = ?, grade_level = ?, term = ?, status = ?
        WHERE id = ?
      `).run(next.name, next.school, next.grade_level, next.term, next.status, id);

      return this.rowToClass({ ...existing, ...next });
    });
  }

  async closeClass(id: string): Promise<ClassInfo> {
    return this.updateClass(id, { status: 'closed' });
  }

  private rowToClass(row: any): ClassInfo {
    return {
      id: row.id,
      name: row.name,
      school: row.school ?? undefined,
      gradeLevel: row.grade_level ?? undefined,
      term: row.term ?? undefined,
      status: row.status,
      createdAt: row.created_at,
    };
  }
}
