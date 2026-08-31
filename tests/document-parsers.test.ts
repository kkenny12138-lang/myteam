import { describe, expect, it } from 'vitest';
import { deflateRawSync } from 'node:zlib';
import { docxExtractText, pdfExtractText } from '@/lib/agent/document-parsers';

/** 构造一个带 FlateDecode 文本内容流的最小 PDF */
function buildPdf(lines: string[]): Uint8Array {
  const content = `BT /F1 14 Tf 72 720 Td (${lines[0]}) Tj\n0 -24 Td (${lines[1]}) Tj\n0 -24 Td (${lines[2]}) Tj ET`;
  const stream = deflateRawSync(Buffer.from(content, 'latin1'));
  const header = Buffer.from('%PDF-1.4\n', 'latin1');
  const objs = [
    Buffer.from('1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n', 'latin1'),
    Buffer.from('2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n', 'latin1'),
    Buffer.from('3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>\nendobj\n', 'latin1'),
    Buffer.from(`4 0 obj\n<< /Length ${stream.length} /Filter /FlateDecode >>\nstream\n`, 'latin1'),
    Buffer.from(stream),
    Buffer.from('\nendstream\nendobj\n', 'latin1'),
    Buffer.from('5 0 obj\n<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>\nendobj\n', 'latin1'),
  ];
  const offsets: number[] = [0];
  let cursor = header.length;
  for (const o of objs) { offsets.push(cursor); cursor += o.length; }
  const xref = `xref\n0 ${offsets.length}\n0000000000 65535 f \n` +
    offsets.slice(1).map((o) => o.toString().padStart(10, '0') + ' 00000 n \n').join('');
  const trailer = Buffer.from(`trailer\n<< /Size ${offsets.length} /Root 1 0 R >>\nstartxref\n${cursor}\n%%EOF\n`, 'latin1');
  const total = cursor + trailer.length;
  const out = new Uint8Array(total);
  let o = 0;
  out.set(new Uint8Array(header), o); o += header.length;
  for (const obj of objs) { out.set(new Uint8Array(obj), o); o += obj.length; }
  out.set(new Uint8Array(trailer), o);
  return out;
}

/** 构造一个最小 DOCX（ZIP 存储模式，含 word/document.xml） */
function buildDocx(paragraphs: string[]): Uint8Array {
  const encoder = new TextEncoder();
  const body = paragraphs.map((t) => `<w:p><w:r><w:t>${t}</w:t></w:r></w:p>`).join('');
  const xml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${body}</w:body></w:document>`;
  const entries = [{ name: 'word/document.xml', data: encoder.encode(xml) }];
  const local: Uint8Array[] = [];
  const central: Uint8Array[] = [];
  let offset = 0;
  for (const e of entries) {
    const name = encoder.encode(e.name);
    const l = new Uint8Array(30 + name.length);
    const dv = new DataView(l.buffer);
    dv.setUint32(0, 0x04034b50, true);
    dv.setUint16(4, 20, true);
    dv.setUint16(8, 0, true); // method = stored
    dv.setUint32(18, e.data.length, true);
    dv.setUint32(22, e.data.length, true);
    dv.setUint16(26, name.length, true);
    l.set(name, 30);
    const c = new Uint8Array(46 + name.length);
    const cdv = new DataView(c.buffer);
    cdv.setUint32(0, 0x02014b50, true);
    cdv.setUint16(4, 20, true);
    cdv.setUint16(6, 20, true);
    cdv.setUint32(20, e.data.length, true);
    cdv.setUint32(24, e.data.length, true);
    cdv.setUint16(28, name.length, true);
    cdv.setUint32(42, offset, true);
    c.set(name, 46);
    local.push(l, e.data);
    central.push(c);
    offset += l.length + e.data.length;
  }
  const centralSize = central.reduce((s, p) => s + p.length, 0);
  const eocd = new Uint8Array(22);
  const e = new DataView(eocd.buffer);
  e.setUint32(0, 0x06054b50, true);
  e.setUint16(8, entries.length, true);
  e.setUint16(10, entries.length, true);
  e.setUint32(12, centralSize, true);
  e.setUint32(16, offset, true);
  const all = [...local, ...central, eocd];
  const out = new Uint8Array(all.reduce((s, p) => s + p.length, 0));
  let o = 0;
  for (const p of all) { out.set(p, o); o += p.length; }
  return out;
}

describe('document parsers', () => {
  it('extracts PDF text', async () => {
    const bytes = buildPdf(['Resume of Jane Smith', 'Senior Financial Analyst', '8 years experience']);
    const text = await pdfExtractText(bytes);
    expect(text).toContain('Resume of Jane Smith');
    expect(text).toContain('Senior Financial Analyst');
  });

  it('extracts DOCX text by paragraph', async () => {
    const bytes = buildDocx(['Resume of Jane Smith', 'Senior Financial Analyst', '8 years experience']);
    const text = await docxExtractText(bytes);
    expect(text).toContain('Resume of Jane Smith');
    expect(text).toContain('8 years experience');
  });
});
