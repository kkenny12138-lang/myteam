/**
 * 附件校验与文本抽取（docs/MULTIMODAL_ATTACHMENT_DEVELOPMENT_PLAN.md §9）。
 * - 纯 JS 实现，不依赖 Node 专有 API，dev(Workers) 与生产(Node) 均可运行。
 * - TXT / Markdown / CSV 直接抽取文本；PDF / DOCX / XLSX 首期不做在线解析，
 *   保留原文件并返回明确提示（后续可接入服务端解析库）。
 */
import type { AttachmentCategory } from '@/lib/agent/types';
import { docxExtractText, pdfExtractText } from '@/lib/agent/document-parsers';

/** 单条消息最大附件数 */
export const ATTACHMENT_MAX_COUNT = Number(process.env.ATTACHMENT_MAX_COUNT || 5);
/** 单文件最大字节数（默认 20MB） */
export const ATTACHMENT_MAX_FILE_BYTES =
  Number(process.env.ATTACHMENT_MAX_FILE_MB || 20) * 1024 * 1024;

const IMAGE_MIME = /^image\/(png|jpe?g|webp)$/i;

export function extOf(name: string): string {
  const match = name.toLowerCase().match(/\.([a-z0-9]+)$/);
  return match ? match[1] : '';
}

/** 依据 MIME 与扩展名判定附件类别；不支持返回 null */
export function categoryOf(mimeType: string, name: string): AttachmentCategory | null {
  const ext = extOf(name);
  if (IMAGE_MIME.test(mimeType) || ['png', 'jpg', 'jpeg', 'webp'].includes(ext)) return 'image';
  if (mimeType === 'application/pdf' || ext === 'pdf') return 'document';
  if (mimeType.includes('wordprocessingml') || ext === 'docx') return 'document';
  if (mimeType.includes('spreadsheetml') || ext === 'xlsx') return 'spreadsheet';
  if (mimeType === 'text/csv' || ext === 'csv') return 'spreadsheet';
  if (mimeType === 'text/plain' || mimeType === 'text/markdown' || ext === 'txt' || ext === 'md') return 'text';
  return null;
}

/** 是否允许上传该附件 */
export function isAllowedAttachment(mimeType: string, name: string): boolean {
  return categoryOf(mimeType, name) !== null;
}

function normalizeText(text: string): string {
  return text.replace(/\r\n?/g, '\n').replace(/\u0000/g, '').trim();
}

/** 简单 CSV 解析（支持引号包裹、逗号/分号分隔），输出表格化摘要 */
function csvToTable(text: string): string {
  const normalized = normalizeText(text);
  if (!normalized) return '';
  const delimiter = normalized.indexOf('\t') >= 0 ? '\t' : (normalized.indexOf(';') >= 0 ? ';' : ',');
  const parseLine = (line: string): string[] => {
    const cells: string[] = [];
    let cur = '';
    let inQuotes = false;
    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (ch === '"') {
        if (inQuotes && line[i + 1] === '"') { cur += '"'; i++; } else { inQuotes = !inQuotes; }
      } else if (ch === delimiter && !inQuotes) {
        cells.push(cur.trim()); cur = '';
      } else {
        cur += ch;
      }
    }
    cells.push(cur.trim());
    return cells;
  };
  const rows = normalized.split('\n').map(parseLine).filter((r) => r.some((c) => c !== ''));
  if (!rows.length) return '';
  const header = rows[0];
  const body = rows.slice(1, 101); // 最多 100 行数据
  const lines = [`表格（CSV，共 ${rows.length - 1} 行数据，列：${header.join('、')}）`];
  body.forEach((row, index) => {
    const cells = header.map((h, i) => `${h}=${row[i] ?? ''}`).filter((c) => c !== '=');
    lines.push(`第 ${index + 1} 行：${cells.join('；')}`);
  });
  return lines.join('\n');
}

export interface ExtractionResult {
  text: string | null;
  meta: Record<string, unknown>;
}

/** 抽取文档文本；无法解析时返回 null 并在 meta 中说明原因 */
export async function extractDocumentText(
  category: AttachmentCategory,
  mimeType: string,
  bytes: Uint8Array
): Promise<ExtractionResult> {
  if (category === 'image') {
    return { text: null, meta: { parseable: false, kind: 'image', note: '图片附件：支持预览，是否可识别取决于模型视觉能力' } };
  }
  if (category === 'text') {
    const text = normalizeText(new TextDecoder('utf-8').decode(bytes));
    const paragraphs = text.split(/\n{2,}/).filter(Boolean).length;
    return { text: text.slice(0, 60000), meta: { parseable: true, kind: mimeType === 'text/markdown' ? 'markdown' : 'text', paragraphs } };
  }
  if (category === 'spreadsheet') {
    if (mimeType === 'text/csv' || extOfFor(mimeType) === 'csv') {
      const text = csvToTable(new TextDecoder('utf-8').decode(bytes));
      return { text: text.slice(0, 30000), meta: { parseable: true, kind: 'csv' } };
    }
    return { text: null, meta: { parseable: false, kind: 'xlsx', note: 'XLSX 需服务端解析库，当前版本暂不支持在线解析；请导出为 CSV 或直接粘贴内容' } };
  }
  // document
  if (mimeType === 'application/pdf') {
    const text = await pdfExtractText(bytes);
    if (text.trim()) return { text: text.slice(0, 60000), meta: { parseable: true, kind: 'pdf', paragraphs: text.split(/\n{2,}/).filter(Boolean).length } };
    return { text: null, meta: { parseable: false, kind: 'pdf', note: '未能从 PDF 中抽取到文本：可能是扫描件/图片型 PDF，或字体编码暂不支持；请粘贴关键内容或导出为 Word/TXT' } };
  }
  const docxText = await docxExtractText(bytes);
  if (docxText.trim()) return { text: docxText.slice(0, 60000), meta: { parseable: true, kind: 'docx', paragraphs: docxText.split(/\n{2,}/).filter(Boolean).length } };
  return { text: null, meta: { parseable: false, kind: 'docx', note: '未能从 Word 文档中抽取到文本，请确认文档非空白或粘贴关键内容' } };
}

function extOfFor(mimeType: string): string {
  // CSV 上传的 MIME 可能是 text/plain 或 application/vnd.ms-excel
  if (mimeType === 'application/vnd.ms-excel') return 'csv';
  return '';
}
