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

const styles: Record<string, CSSProperties> = {
  page: { maxWidth: 960, margin: '0 auto', padding: '32px 20px 80px', fontFamily: 'system-ui, -apple-system, "Segoe UI", sans-serif', color: '#1f2733' },
  header: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 24 },
  title: { fontSize: 24, fontWeight: 700, margin: 0 },
  sub: { color: '#7a8596', fontSize: 13, marginTop: 4 },
  back: { color: '#3478f6', textDecoration: 'none', fontSize: 13 },
  grid: { display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))', gap: 16 },
  card: { border: '1px solid #e4e9f1', borderRadius: 12, padding: 16, background: '#fff', cursor: 'pointer', display: 'flex', flexDirection: 'column', gap: 8, boxShadow: '0 1px 2px rgba(16,24,40,.04)' },
  name: { fontSize: 15, fontWeight: 600, margin: 0 },
  summary: { fontSize: 12, color: '#5b6675', margin: 0, display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical', overflow: 'hidden' },
  meta: { display: 'flex', gap: 8, alignItems: 'center', fontSize: 11, color: '#98a4b8' },
  pill: { padding: '2px 8px', borderRadius: 999, fontSize: 11 },
  empty: { color: '#98a4b8', textAlign: 'center', padding: 48, fontSize: 14 },
  form: { border: '1px solid #e4e9f1', borderRadius: 12, padding: 16, background: '#fafbfd', marginBottom: 20, display: 'flex', flexDirection: 'column', gap: 10 },
  input: { border: '1px solid #ccd6e3', borderRadius: 8, padding: '8px 12px', fontSize: 13, fontFamily: 'inherit' },
  textarea: { border: '1px solid #ccd6e3', borderRadius: 8, padding: '8px 12px', fontSize: 13, fontFamily: 'inherit', resize: 'vertical', minHeight: 120, lineHeight: 1.6 },
  btn: { border: 'none', borderRadius: 8, padding: '9px 16px', fontSize: 13, cursor: 'pointer', background: '#3478f6', color: '#fff', fontWeight: 600 },
  row: { display: 'flex', gap: 10, alignItems: 'center', justifyContent: 'space-between' },
  count: { fontSize: 11, color: '#98a4b8' },
};

const statusStyle: Record<string, CSSProperties> = {
  draft: { background: '#f1f3f7', color: '#5b6675' },
  published: { background: '#e6f6ec', color: '#1c8a4c' },
  disabled: { background: '#fdeaea', color: '#c0392b' },
};

export default function SkillsPage() {
  const [skills, setSkills] = useState<SkillItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [showForm, setShowForm] = useState(false);
  const [name, setName] = useState('');
  const [summary, setSummary] = useState('');
  const [instructions, setInstructions] = useState('');

  const load = async () => {
    try {
      const r = await fetch('/api/skills');
      const data = await r.json() as { skills?: SkillItem[]; error?: string };
      if (!r.ok || !data.skills) throw new Error(data.error || '加载失败');
      setSkills(data.skills);
    } catch (e) {
      setError(e instanceof Error ? e.message : '加载失败');
    } finally {
      setLoading(false);
    }
  };
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const r = await fetch('/api/skills');
        const data = await r.json() as { skills?: SkillItem[]; error?: string };
        if (cancelled) return;
        if (!r.ok || !data.skills) throw new Error(data.error || '加载失败');
        setSkills(data.skills);
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : '加载失败');
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, []);

  const create = async () => {
    if (!name.trim()) return;
    try {
      const r = await fetch('/api/skills', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name, summary, instructions, status: 'draft' }) });
      const data = await r.json() as { skill?: SkillItem; error?: string; code?: string };
      if (!r.ok || !data.skill) throw new Error(data.error || data.code || '创建失败');
      setShowForm(false); setName(''); setSummary(''); setInstructions('');
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : '创建失败');
    }
  };

  return (
    <div style={styles.page}>
      <div style={styles.header}>
        <div>
          <h1 style={styles.title}>Skill 库</h1>
          <p style={styles.sub}>可复用、可版本化的员工能力说明 · 支持 Markdown 长文本</p>
        </div>
        <Link href="/" style={styles.back}>← 返回 IM</Link>
      </div>

      {error && <p style={{ color: '#c0392b', fontSize: 13 }}>{error}</p>}

      {showForm ? (
        <div style={styles.form}>
          <input style={styles.input} value={name} onChange={(e) => setName(e.target.value)} placeholder="Skill 名称（如：财务建模）" />
          <input style={styles.input} value={summary} onChange={(e) => setSummary(e.target.value)} placeholder="一句话摘要（列表展示用，≤200 字）" />
          <textarea style={styles.textarea} value={instructions} onChange={(e) => { if (e.target.value.length <= 200000) setInstructions(e.target.value); }} placeholder="详细执行说明：触发场景、执行步骤、输入输出、注意事项（Markdown，最多 200,000 字）" />
          <div style={styles.row}>
            <span style={styles.count}>{instructions.length} 字 · 约 {Math.ceil(instructions.length / 1.8)} tokens</span>
            <div style={{ display: 'flex', gap: 10 }}>
              <button style={{ ...styles.btn, background: '#eef1f6', color: '#5b6675' }} onClick={() => setShowForm(false)}>取消</button>
              <button style={styles.btn} onClick={create} disabled={!name.trim()}>创建 Skill</button>
            </div>
          </div>
        </div>
      ) : (
        <button style={{ ...styles.btn, marginBottom: 16 }} onClick={() => setShowForm(true)}>＋ 新建 Skill</button>
      )}

      {loading ? <p style={styles.empty}>加载中…</p> : skills.length ? (
        <div style={styles.grid}>
          {skills.map((s) => (
            <Link key={s.id} href={`/skills/${s.id}`} style={{ ...styles.card, textDecoration: 'none' }}>
              <h3 style={styles.name}>{s.name}</h3>
              <p style={styles.summary}>{s.summary || '（暂无摘要）'}</p>
              <div style={styles.meta}>
                <span style={{ ...styles.pill, ...statusStyle[s.status] }}>{s.status}</span>
                <span>v{s.version}</span>
                <span>{Math.ceil(s.instructions.length / 1.8)} tokens</span>
                <span>{s.updatedAt ? new Date(s.updatedAt).toLocaleDateString('zh-CN') : ''}</span>
              </div>
            </Link>
          ))}
        </div>
      ) : <p style={styles.empty}>还没有 Skill，点击上方按钮创建第一个。</p>}
    </div>
  );
}
