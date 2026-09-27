// 0044 P3：「存为试卷」弹层（呈现依据 paper-manager 设计稿 v5 视图二）。
//
// D-060④ 卷名默认=来源文件名、弹层内可改；D-061⑨⑩ 归属文件夹=树选择器（D-063 字段+点击展开
// 树浮层，默认折叠）、按钮只留「取消 / 保存」、框内文字明示保存语义=试题入库 + 保存为可排版试卷；
// 保存后留在工作台（toast 由调用方出），不设「去排版」直达钮。

import { useState } from 'react';
import type { PaperFolder } from '../../shared/contracts/bank-types.js';
import { Field, Modal } from '../pages/ExtUi.js';
import { FolderTreePicker } from '../components/FolderTreePicker.js';

export function SaveAsPaperModal({
  count, sourceTitle, defaultTitle, folders, submitting, onCreateFolder, onSubmit, onClose,
}: {
  /** 勾选题数（副标题） */
  count: number;
  /** 来源文件名（workbench paperTitle / run sourceName；取不到传空串则副标题不显示来源段） */
  sourceTitle: string;
  /** 卷名默认值（来源文件名兜底「未命名试卷」由调用方算好传入） */
  defaultTitle: string;
  folders: PaperFolder[];
  submitting?: boolean;
  onCreateFolder?: (name: string, parentId: string | null) => Promise<string>;
  onSubmit: (title: string, folderId: string | null) => void;
  onClose: () => void;
}) {
  const [title, setTitle] = useState(defaultTitle);
  const [folderId, setFolderId] = useState<string | null>(null);

  return (
    <Modal title="存为试卷" onClose={onClose}>
      <div data-testid="wb-save-as-paper-modal">
        <p className="m-sub">
          已勾选 <b>{count}</b> 道题{sourceTitle ? <> · 来自「{sourceTitle}」</> : null}
        </p>
        <Field label="试卷名称（默认取文件名，可改）">
          <input
            className="input"
            data-testid="wb-save-as-paper-title"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
          />
        </Field>
        <Field label="归属文件夹（点击展开选择，默认折叠）">
          <FolderTreePicker
            folders={folders}
            value={folderId}
            onChange={(id) => setFolderId(id)}
            {...(onCreateFolder ? { onCreateFolder } : {})}
          />
        </Field>
        <div className="m-note" data-testid="wb-save-as-paper-note">
          「保存」= 把选中的 {count} 道题<b>录入题库</b>（沿用各题卡已采纳的知识节点与标签），
          <b>同时保存为一张可排版的试卷</b>（「排版中」状态）。之后随时可在「试卷管理」中继续排版、导出 Word/PDF。
        </div>
        <div style={{ display: 'flex', gap: '0.6rem', justifyContent: 'flex-end' }}>
          <button type="button" className="btn btn-ghost btn-sm" data-testid="wb-save-as-paper-cancel" onClick={onClose}>取消</button>
          <button
            type="button"
            className="btn btn-primary btn-sm"
            data-testid="wb-save-as-paper-save"
            disabled={submitting || !title.trim()}
            onClick={() => onSubmit(title.trim(), folderId)}
          >
            保存
          </button>
        </div>
      </div>
    </Modal>
  );
}
