// 0028 P2：素材分类（R-028「先拖进来」的前置判定，纯函数）
// 拖拽 / Ctrl+V 粘贴 / 点选三入口落到同一份判定：图片收下、PDF 转交切题工作区（0036 已上线）、
// 其余给明确理由——**不静默失败**（任务书 §一 P2）。
// 渲染层用它做即时反馈；主进程 createRun 复用同一份做防深度校验（同一真源，不双轨）。

/** 收下的图片扩展名（mime 缺失时按扩展名兜底；Electron 的 File.type 并非总是可靠） */
const IMAGE_EXTS = ['png', 'jpg', 'jpeg', 'webp', 'bmp', 'gif'];
const IMAGE_MIMES = ['image/png', 'image/jpeg', 'image/webp', 'image/bmp', 'image/gif'];

/** 单页上限：A4@150dpi PNG 约 1–3MB，12MB 已覆盖扫描仪原图；再大先压缩更划算 */
export const MATERIAL_MAX_BYTES = 12 * 1024 * 1024;
/** 单 run 页数上限：免费/慢速通道下 30 页 ≈ 一份卷；更多请分批（也保护内存与超时预算） */
export const MATERIAL_MAX_PAGES = 30;

export interface MaterialCandidate {
  name: string;
  /** MIME type（可为空串；Electron File.type） */
  type: string;
  size: number;
}

export interface MaterialClassification {
  /** 可识别图片（≤ 上限页数） */
  accepted: MaterialCandidate[];
  /** PDF：转交切题工作区（0036 / R-027），本页不识别 */
  pdf: MaterialCandidate[];
  /** 不收的素材及理由（UI 逐条展示，不静默丢） */
  rejected: Array<{ name: string; reason: string }>;
}

function extOf(name: string): string {
  const m = name.toLowerCase().match(/\.([a-z0-9]+)$/);
  return m ? m[1] : '';
}

export function isImageMaterial(candidate: MaterialCandidate): boolean {
  if (IMAGE_MIMES.includes(candidate.type.toLowerCase())) return true;
  if (candidate.type !== '' && !candidate.type.toLowerCase().startsWith('image/')) return false;
  return IMAGE_EXTS.includes(extOf(candidate.name));
}

export function isPdfMaterial(candidate: MaterialCandidate): boolean {
  if (candidate.type.toLowerCase() === 'application/pdf') return true;
  return extOf(candidate.name) === 'pdf';
}

/** 分类：顺序=入参顺序（页序=用户拖入顺序，不做排序猜测试图） */
export function classifyMaterials(candidates: MaterialCandidate[]): MaterialClassification {
  const accepted: MaterialCandidate[] = [];
  const pdf: MaterialCandidate[] = [];
  const rejected: Array<{ name: string; reason: string }> = [];

  for (const c of candidates) {
    if (isPdfMaterial(c)) {
      pdf.push(c);
      continue;
    }
    if (!isImageMaterial(c)) {
      rejected.push({ name: c.name, reason: '不支持的文件类型（当前仅识别图片：PNG / JPG / WEBP / BMP / GIF）' });
      continue;
    }
    if (c.size > MATERIAL_MAX_BYTES) {
      rejected.push({
        name: c.name,
        reason: `文件过大（${(c.size / 1024 / 1024).toFixed(1)}MB，上限 ${MATERIAL_MAX_BYTES / 1024 / 1024}MB）`,
      });
      continue;
    }
    if (accepted.length >= MATERIAL_MAX_PAGES) {
      rejected.push({ name: c.name, reason: `超出单次 ${MATERIAL_MAX_PAGES} 页上限，请分批识别` });
      continue;
    }
    accepted.push(c);
  }
  return { accepted, pdf, rejected };
}

/**
 * PDF 去向提示（单源）：0036 上线后 PDF 有了正经入口——**PDF 切题工作区**（D-051 / R-027），
 * 不再走「先导出成图片」的降级路径。
 * 渲染层转交 PDF 时用同源文案；主进程 createRun 拒绝 PDF 时也用这句（两端说法一致，不出现双轨）。
 */
export const PDF_SPLIT_REDIRECT_NOTICE =
  'PDF 请用「PDF 切题录题」工作区打开（左侧导航「PDF 切题录题」，或在录题页直接拖入 PDF）：按段框选、一题一识别。';
