/**
 * PDF / DOCX 文本抽取（纯 JS，双运行时兼容）。
 *
 * - 解压使用 Web 标准 DecompressionStream（Node 18+ 与 Workers 均支持），
 *   避免引入 node:zlib 等 Node 专有依赖。
 * - PDF：读取内容流（支持 FlateDecode），抽取 Tj/TJ 文本算子。
 *   注意：扫描件/图片型 PDF 无文本层；部分中文 PDF 使用 CID 字体编码，可能抽取失败或乱码。
 * - DOCX：按 ZIP 结构读取 word/document.xml，抽取 <w:t> 文本并按段落分行。
 */

function hasDecompressionStream(): boolean {
  return typeof DecompressionStream !== 'undefined';
}

/** 原始 deflate（PDF FlateDecode / ZIP 存储压缩均使用 raw deflate） */
export async function inflateRaw(bytes: Uint8Array): Promise<Uint8Array> {
  if (!hasDecompressionStream()) throw new Error('当前运行环境不支持流式解压');
  const ds = new DecompressionStream('deflate-raw') as TransformStream;
  const stream = new Blob([bytes as BlobPart]).stream().pipeThrough(ds);
  const out = await new Response(stream).arrayBuffer();
  return new Uint8Array(out);
}

/** 在字节数组中查找子序列，返回起始下标；找不到返回 -1 */
function indexOfBytes(hay: Uint8Array, needle: number[], from = 0): number {
  outer: for (let i = from; i + needle.length <= hay.length; i++) {
    for (let j = 0; j < needle.length; j++) {
      if (hay[i + j] !== needle[j]) continue outer;
    }
    return i;
  }
  return -1;
}

const BYTES_STREAM = [0x73, 0x74, 0x72, 0x65, 0x61, 0x6d]; // "stream"
const BYTES_ENDSTREAM = [0x65, 0x6e, 0x64, 0x73, 0x74, 0x72, 0x65, 0x61, 0x6d]; // "endstream"
const BYTES_DICT_OPEN = [0x3c, 0x3c]; // "<<"

function decodePdfString(s: string): string {
  return s
    .replace(/\\([nrtbf()\\])/g, (_m, c: string) => ({ n: '\n', r: '\r', t: '\t', b: '\b', f: '\f', '(': '(', ')': ')', '\\': '\\' }[c] ?? c))
    .replace(/\\([0-7]{1,3})/g, (_m, oct: string) => String.fromCharCode(parseInt(oct, 8)));
}

/** 从 PDF 内容流里抽取文本算子（Tj / TJ） */
function extractPdfTextOperators(content: string): string {
  const out: string[] = [];
  const tj = /\(((?:\\.|[^()\\])*)\)\s*Tj/g;
  let m: RegExpExecArray | null;
  while ((m = tj.exec(content))) out.push(decodePdfString(m[1]));
  const tjArr = /\[((?:[^\]])*)\]\s*TJ/g;
  while ((m = tjArr.exec(content))) {
    const parts = m[1].match(/\(((?:\\.|[^()\\])*)\)/g) || [];
    out.push(parts.map((p) => decodePdfString(p.slice(1, -1))).join(''));
  }
  return out.join('\n');
}

interface PdfStream { dict: string; data: Uint8Array }

/** 遍历 PDF 对象流（按 /Length 精确切分，避免二进制里出现 endstream 干扰） */
function* iteratePdfStreams(bytes: Uint8Array): Generator<PdfStream> {
  let i = 0;
  while (i < bytes.length) {
    const si = indexOfBytes(bytes, BYTES_STREAM, i);
    if (si < 0) return;
    // 找 stream 之前最近的 "<<"
    let dictStart = -1;
    let pos = indexOfBytes(bytes, BYTES_DICT_OPEN, Math.max(0, si - 400));
    while (pos >= 0 && pos < si) {
      dictStart = pos;
      pos = indexOfBytes(bytes, BYTES_DICT_OPEN, pos + 2);
    }
    if (dictStart < 0) { i = si + 6; continue; }
    const dict = new TextDecoder().decode(bytes.subarray(dictStart, si)); // dict 为 ASCII
    const lenMatch = dict.match(/\/Length\s+(\d+)/);
    let p = si + 6;
    if (bytes[p] === 0x0d) p++;
    if (bytes[p] === 0x0a) p++;
    if (lenMatch) {
      const len = Number(lenMatch[1]);
      if (len > 0 && len < 50 * 1024 * 1024 && p + len <= bytes.length) {
        yield { dict, data: bytes.subarray(p, p + len) };
        i = p + len;
        continue;
      }
    }
    // 没有 /Length：退化为按 endstream 切分
    const end = indexOfBytes(bytes, BYTES_ENDSTREAM, p);
    if (end > p) { yield { dict, data: bytes.subarray(p, end) }; i = end + 9; } else { i = p; }
  }
}

/** PDF 文本抽取 */
export async function pdfExtractText(bytes: Uint8Array): Promise<string> {
  const chunks: string[] = [];
  for (const stream of iteratePdfStreams(bytes)) {
    try {
      const isFlate = /FlateDecode/.test(stream.dict);
      const contentBytes = isFlate ? await inflateRaw(stream.data) : stream.data;
      const text = extractPdfTextOperators(new TextDecoder().decode(contentBytes));
      if (text.trim()) chunks.push(text);
    } catch {
      // 单个流解压失败则跳过
    }
  }
  return chunks.join('\n').replace(/\u0000/g, '').trim();
}

// ---------- DOCX（ZIP） ----------

interface ZipEntry { name: string; data: Uint8Array }

/** 读取 ZIP 全部条目（按中央目录的压缩方式/大小读取） */
async function readZipEntries(bytes: Uint8Array): Promise<ZipEntry[]> {
  const entries: ZipEntry[] = [];
  // 1. 定位 EOCD（End of Central Directory）
  let eocd = -1;
  const searchFrom = Math.max(0, bytes.length - 65557);
  for (let i = bytes.length - 22; i >= searchFrom; i--) {
    if (bytes[i] === 0x50 && bytes[i + 1] === 0x4b && bytes[i + 2] === 0x05 && bytes[i + 3] === 0x06) { eocd = i; break; }
  }
  if (eocd < 0) return entries;
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const centralCount = dv.getUint16(eocd + 10, true);
  let centralOffset = dv.getUint32(eocd + 16, true);
  for (let n = 0; n < centralCount; n++) {
    if (centralOffset + 46 > bytes.length) break;
    if (dv.getUint32(centralOffset, true) !== 0x02014b50) break;
    const method = dv.getUint16(centralOffset + 10, true);
    const compressedSize = dv.getUint32(centralOffset + 20, true);
    const nameLen = dv.getUint16(centralOffset + 28, true);
    const extraLen = dv.getUint16(centralOffset + 30, true);
    const commentLen = dv.getUint16(centralOffset + 32, true);
    const localOffset = dv.getUint32(centralOffset + 42, true);
    const name = new TextDecoder('utf-8').decode(bytes.subarray(centralOffset + 46, centralOffset + 46 + nameLen));
    centralOffset += 46 + nameLen + extraLen + commentLen;
    // 2. 读本地文件头，跳到数据区
    if (localOffset + 30 > bytes.length) continue;
    if (dv.getUint32(localOffset, true) !== 0x04034b50) continue;
    const lNameLen = dv.getUint16(localOffset + 26, true);
    const lExtraLen = dv.getUint16(localOffset + 28, true);
    const dataStart = localOffset + 30 + lNameLen + lExtraLen;
    const dataEnd = dataStart + compressedSize;
    if (dataEnd > bytes.length) continue;
    const compressed = bytes.subarray(dataStart, dataEnd);
    let data: Uint8Array;
    if (method === 8) {
      try { data = await inflateRaw(compressed); } catch { continue; }
    } else if (method === 0) {
      data = compressed;
    } else {
      continue;
    }
    entries.push({ name, data });
  }
  return entries;
}

function decodeXml(s: string): string {
  return s
    .replace(/<[^>]+>/g, '')
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&#(\d+);/g, (_m, d) => String.fromCharCode(Number(d)));
}

/** DOCX 文本抽取：按段落读取 word/document.xml */
export async function docxExtractText(bytes: Uint8Array): Promise<string> {
  const entries = await readZipEntries(bytes);
  const doc = entries.find((e) => e.name === 'word/document.xml');
  if (!doc) return '';
  const xml = new TextDecoder('utf-8').decode(doc.data);
  const paragraphs = xml.match(/<w:p[ >][\s\S]*?<\/w:p>/g) || [];
  const lines = paragraphs.map((p) => {
    const texts = [...p.matchAll(/<w:t[^>]*>([\s\S]*?)<\/w:t>/g)].map((m) => decodeXml(m[1]));
    return texts.join('').trim();
  }).filter(Boolean);
  return lines.join('\n').trim();
}
