// 0004 Phase 3：题库管理页（#/bank）——BankBrowser 详情管理模式 + 新建题入口 + 统计。
// 树/字典维度数据未采集（队列第 2 步），空态「待采集」占位（见 BankBrowser）；
// 错题本/考试页手动选题本轮不换（0003 UI 不动），BankBrowser 预留复用接口。

import { useEffect, useState } from 'react';
import {
  useExtPageServices, MessageBanner, Modal, PageHeader,
  type ExtPageServices, type PageMessage,
} from './ExtUi.js';
import { BankBrowser } from '../components/BankBrowser.js';
import { QuestionEditor } from '../../docgen/editor/QuestionEditor.js';

export function BankPage({ svc: injected }: { svc?: ExtPageServices }) {
  const svc = useExtPageServices(injected);
  const [questionCount, setQuestionCount] = useState<number | null>(null);
  const [showNewQuestionModal, setShowNewQuestionModal] = useState(false);
  const [message, setMessage] = useState<PageMessage | null>(null);

  const loadCount = () => {
    svc.bank.listQuestions()
      .then((list) => setQuestionCount(list.length))
      .catch((err) => setMessage({ type: 'error', text: `统计加载失败：${err instanceof Error ? err.message : String(err)}` }));
  };

  useEffect(() => {
    loadCount();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [svc]);

  const handleNewQuestionSave = async (content: string) => {
    try {
      await svc.bank.createQuestion({
        content,
        subject: '未分类',
        sourceType: 'local',
        sourceDetail: { origin: 'manual' },
        images: [],
      });
      setShowNewQuestionModal(false);
      setMessage({ type: 'success', text: '题目已入库' });
      loadCount();
    } catch (err) {
      setMessage({ type: 'error', text: `入库失败：${err instanceof Error ? err.message : String(err)}` });
    }
  };

  return (
    <div className="bank-page">
      <PageHeader
        title="题库管理"
        backHref="#/"
        actions={(
          <button className="btn btn-primary" data-testid="bank-new-question-btn" onClick={() => setShowNewQuestionModal(true)}>新建题</button>
        )}
      />

      <p className="page-desc" style={{ marginTop: 0, marginBottom: '1rem', flex: '0 0 auto' }} data-testid="bank-count">
        题库共 {questionCount ?? '…'} 题
      </p>

      <MessageBanner message={message} />

      <BankBrowser svc={svc} />

      {/* 新建题弹层 */}
      {showNewQuestionModal && (
        <Modal title="新建题目" onClose={() => setShowNewQuestionModal(false)}>
          <div style={{ maxWidth: '760px' }}>
            <QuestionEditor onSave={(content: string) => void handleNewQuestionSave(content)} />
            <button className="btn" onClick={() => setShowNewQuestionModal(false)} style={{ marginTop: '1rem' }}>取消</button>
          </div>
        </Modal>
      )}
    </div>
  );
}
