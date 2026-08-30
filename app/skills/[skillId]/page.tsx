'use client';

import { useEffect, useState, type CSSProperties } from 'react';
import Link from 'next/link';

type SkillItem = {
  id: string;
  name: string;
  summary: string;
  instructions: string;
  status: 'draft' | 'published' | 'disabled';
  version: number;
  updatedAt?: string;
};

const SKILL_MAX = 200_000;

const styles: Record<string, CSSProperties> = {
  page: { maxWidth: 880, margin: '0 auto', padding: '32px 20px 80px', fontFamily: 'system-ui, -apple-system, "Segoe UI", sans-serif', color: '#1f2733' },
  header: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 20 },
  back: { color: '#3478f6', textDecoration: 'none', fontSize: 13 },
  title: { fontSize: 22, fontWeight: 700, margin: 0 },
  field: { marginBottom: 18 },
  label: { display: 'block', fontSize: 12, color: '#7a8596', marginBottom: 6, fontWeight: 600 },
  input: { width: '100%', boxSizing: 'border-box', border: '1px solid #ccd6e3', borderRadius: 8, padding: '9px 12px', fontSize: 14, fontFamily: 'inherit' },
  textarea: { width: '100%', boxSizing: 'border-box', border: '1px solid #ccd6e3', borderRadius: 8, padding: '12px', fontSize: 14, fontFamily: 'inherit', lineHeight: 1.7, resize: 'vertical', minHeight: 320 },
  count: { fontSize: 12, color: '#98a4b8', marginTop: 6 },
  row: { display: 'flex', alignItems: 'center', gap: 10, justifyContent: 'space-between', marginTop: 8 },
  btn: { border: 'none', borderRadius: 8, padding: '10px 18px', fontSize: 14, cursor: 'pointer', background: '#3478f6', color: '#fff', fontWeight: 600 },
  select: { border: '1px solid #ccd6e3', borderRadius: 8, padding: '8px 12px', fontSize: 13, fontFamily: 'inherit' },
  hint: { fontSize: 12, color: '#7a8596', lineHeight: 1.6 },
  error: { color: '#c0392b', fontSize: 13 },
  ok: { color: '#1c8a4c', fontSize: 13 },
};

export default function SkillEditorPage({ params }: { params: Promise<{ skillId: string }> }) {
  const [skillId, setSkillId] = useState('');
  const [skill, setSkill] = useState<SkillItem | null>(null);
  const [name, setName] = useState('');
  const [summary, setSummary] = useState('');
  const [instructions, setInstructions] = useState('');
  const [status, setStatus] = useState<SkillItem['status']>('draft');
  const [version, setVersion] = useState(1);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    void (async () => {
      const { skillId: id } = await params;
      setSkillId(id);
      try {
        const r = await fetch(`/api/skills/${id}`);
        const data = await r.json() as { skill?: SkillItem; error?: string; code?: string };
        if (!r.ok || !data.skill) throw new Error(data.error || data.code || '加载失败');
        setSkill(data.skill);
        setName(data.skill.name);
        setSummary(data.skill.summary);
        setInstructions(data.skill.instructions);
        setStatus(data.skill.status);
        setVersion(data.skill.version);
      } catch (e) {
        setError(e instanceof Error ? e.message : '加载失败');
      } finally {
        setLoading(false);
      }
    })();
  }, [params]);

  const save = async () => {
    if (!skill) return;
    setSaving(true); setError(''); setNotice('');
    try {
      const r = await fetch(`/api/skills/${skillId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, summary, instructions, status, version }),
      });
      const data = await r.json() as { skill?: SkillItem; error?: string; code?: string };
      if (!r.ok || !data.skill) {
        if (r.status === 409) { setError('版本冲突：该 Skill 已被他人更新，请刷新后重试'); setVersion((await refreshVersion()) ?? version); return; }
        throw new Error(data.error || data.code || '保存失败');
      }
      setSkill(data.skill);
      setVersion(data.skill.version);
      setNotice(`已保存 · v${data.skill.version}`);
    } catch (e) {
      setError(e instanceof Error ? e.message : '保存失败');
    } finally {
      setSaving(false);
    }
  };

  const refreshVersion = async (): Promise<number | null> => {
    try {
      const r = await fetch(`/api/skills/${skillId}`);
      const data = await r.json() as { skill?: SkillItem };
      if (data.skill) { setVersion(data.skill.version); return data.skill.version; }
    } catch { /* ignore */ }
    return null;
  };

  if (loading) return <div style={styles.page}><p style={{ color: '#98a4b8' }}>加载中…</p></div>;
  if (!skill) return <div style={styles.page}><p style={styles.error}>{error || 'Skill 不存在'}</p><Link href="/skills" style={styles.back}>← 返回 Skill 库</Link></div>;

  return (
    <div style={styles.page}>
      <div style={styles.header}>
        <h1 style={styles.title}>编辑 Skill</h1>
        <Link href="/skills" style={styles.back}>← 返回 Skill 库</Link>
      </div>
      <p style={styles.hint}>Skill 是可复用的能力说明。发布（published）后才会进入员工 prompt；禁用（disabled）后不会参与任何任务。修改采用乐观锁（version 字段），冲突时请刷新后重试。</p>

      {error && <p style={styles.error}>{error}</p>}
      {notice && <p style={styles.ok}>{notice}</p>}

      <div style={styles.field}>
        <label style={styles.label}>名称</label>
        <input style={styles.input} value={name} onChange={(e) => setName(e.target.value)} placeholder="Skill 名称" />
      </div>
      <div style={styles.field}>
        <label style={styles.label}>摘要（列表展示，≤200 字）</label>
        <input style={styles.input} value={summary} onChange={(e) => { if (e.target.value.length <= 500) setSummary(e.target.value); }} placeholder="一句话摘要" />
      </div>
      <div style={styles.field}>
        <label style={styles.label}>执行说明（Markdown 长文本，最多 200,000 字）</label>
        <textarea style={styles.textarea} value={instructions} onChange={(e) => { if (e.target.value.length <= SKILL_MAX) setInstructions(e.target.value); }} placeholder="详细能力说明…" />
        <p style={styles.count}>{instructions.length.toLocaleString()} 字 · 约 {Math.ceil(instructions.length / 1.8).toLocaleString()} tokens{instructions.length >= SKILL_MAX ? ' · 已达上限' : ''}</p>
      </div>
      <div style={styles.field}>
        <label style={styles.label}>状态</label>
        <select style={styles.select} value={status} onChange={(e) => setStatus(e.target.value as SkillItem['status'])}>
          <option value="draft">draft · 草稿</option>
          <option value="published">published · 已发布</option>
          <option value="disabled">disabled · 禁用</option>
        </select>
      </div>
      <div style={styles.row}>
        <span style={styles.hint}>当前版本 v{version}</span>
        <button style={styles.btn} onClick={save} disabled={saving || !name.trim()}>{saving ? '保存中…' : '保存修改'}</button>
      </div>
    </div>
  );
}
