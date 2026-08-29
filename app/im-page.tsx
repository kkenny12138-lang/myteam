'use client';

import { FormEvent, useEffect, useMemo, useState } from 'react';

type Employee = { id: string; name: string; role: string; department: string; initials: string; color: string; online: boolean };
type Message = { id: string; sender: 'me' | 'employee'; text: string; time: string };
type MessageMap = Record<string, Message[]>;

const seedEmployees: Employee[] = [
  { id: 'elon', name: '马斯克', role: 'CEO · 中控大脑', department: '管理层', initials: 'EM', color: '#ff7a45', online: true },
  { id: 'buffett', name: '巴菲特', role: '财务顾问', department: '财务部', initials: 'WB', color: '#20b486', online: true },
  { id: 'munger', name: '芒格', role: '战略顾问', department: '战略部', initials: 'CM', color: '#8b7cf6', online: false },
  { id: 'jobs', name: '乔布斯', role: '产品负责人', department: '产品部', initials: 'SJ', color: '#3988ff', online: true },
];
const seedMessages: MessageMap = {
  elon: [{ id: 'e1', sender: 'employee', text: '早上好。今天最重要的目标是什么？我会先拆掉不必要的假设。', time: '09:28' }, { id: 'e2', sender: 'me', text: '帮我规划未来 90 天的业务增长重点。', time: '09:31' }, { id: 'e3', sender: 'employee', text: '收到。我会从用户价值、增长瓶颈和执行速度三个维度整理方案。', time: '09:32' }],
  buffett: [{ id: 'b1', sender: 'employee', text: '现金流比利润表更诚实。把最新预算发给我，我来检查安全边际。', time: '昨天' }],
  munger: [{ id: 'm1', sender: 'employee', text: '先告诉我哪些事情绝对不能失败，我们再反向推导策略。', time: '周四' }],
  jobs: [{ id: 'j1', sender: 'employee', text: '产品不是功能的集合。我们先确认用户真正想完成什么。', time: '周三' }],
};
const colors = ['#ff7a45', '#20b486', '#3988ff', '#8b7cf6', '#ef5da8', '#f4b740'];

export default function IMPage() {
  const [view, setView] = useState<'chat' | 'org'>('chat');
  const [employees, setEmployees] = useState<Employee[]>(seedEmployees);
  const [messages, setMessages] = useState<MessageMap>(seedMessages);
  const [selectedId, setSelectedId] = useState('elon');
  const [draft, setDraft] = useState('');
  const [search, setSearch] = useState('');
  const [showAdd, setShowAdd] = useState(false);
  const [mobileConversation, setMobileConversation] = useState(false);
  const [hydrated, setHydrated] = useState(false);
  useEffect(() => { queueMicrotask(() => { try { const e = localStorage.getItem('myteam-employees'); const m = localStorage.getItem('myteam-messages'); if (e) setEmployees(JSON.parse(e)); if (m) setMessages(JSON.parse(m)); } catch {} setHydrated(true); }); }, []);
  useEffect(() => { if (hydrated) localStorage.setItem('myteam-employees', JSON.stringify(employees)); }, [employees, hydrated]);
  useEffect(() => { if (hydrated) localStorage.setItem('myteam-messages', JSON.stringify(messages)); }, [messages, hydrated]);
  const selected = employees.find((item) => item.id === selectedId) ?? employees[0];
  const filtered = employees.filter((item) => `${item.name}${item.role}${item.department}`.toLowerCase().includes(search.toLowerCase()));
  const grouped = useMemo(() => Object.entries(employees.reduce<Record<string, Employee[]>>((acc, item) => { (acc[item.department] ||= []).push(item); return acc; }, {})), [employees]);
  const openChat = (id: string) => { setSelectedId(id); setView('chat'); setMobileConversation(true); };
  const send = () => { const text = draft.trim(); if (!text || !selected) return; const time = new Intl.DateTimeFormat('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date()); setMessages((current) => ({ ...current, [selected.id]: [...(current[selected.id] || []), { id: crypto.randomUUID(), sender: 'me', text, time }] })); setDraft(''); };
  return <main className="im-shell">
    <aside className="im-nav"><div className="im-brand">M</div><NavButton active={view === 'chat'} label="消息" icon="chat" onClick={() => setView('chat')} /><NavButton active={view === 'org'} label="通讯录" icon="org" onClick={() => setView('org')} /><div className="im-nav-spacer" /><button className="im-profile" aria-label="我的账户">K</button></aside>
    {view === 'chat' ? <>
      <section className={`conversation-list ${mobileConversation ? 'mobile-hidden' : ''}`}><div className="panel-header"><div><span className="eyebrow">MYTEAM</span><h1>消息</h1></div><button className="round-action" onClick={() => setShowAdd(true)}>＋</button></div><label className="search-box"><SearchIcon /><input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="搜索员工或部门" /></label><div className="conversation-scroll"><div className="section-label">最近对话 <span>{filtered.length}</span></div>{filtered.map((employee) => { const thread = messages[employee.id] || []; const last = thread[thread.length - 1]; return <button key={employee.id} className={`conversation-card ${selectedId === employee.id ? 'selected' : ''}`} onClick={() => openChat(employee.id)}><Avatar employee={employee} /><div className="conversation-copy"><div className="name-line"><strong>{employee.name}</strong><time>{last?.time || ''}</time></div><p>{last?.text || '开始一段新对话'}</p><span>{employee.role}</span></div></button>; })}</div></section>
      <section className={`chat-panel ${mobileConversation ? 'mobile-open' : ''}`}>{selected && <><header className="chat-header"><button className="mobile-back" onClick={() => setMobileConversation(false)}>‹</button><Avatar employee={selected} compact /><div><h2>{selected.name}</h2><p><span className={selected.online ? 'status-online' : 'status-offline'} />{selected.online ? '在线' : '离线'} · {selected.role}</p></div><button className="header-more">•••</button></header><div className="message-area"><div className="day-divider"><span>今天</span></div>{(messages[selected.id] || []).map((message) => <div key={message.id} className={`message-row ${message.sender === 'me' ? 'mine' : ''}`}>{message.sender === 'employee' && <Avatar employee={selected} compact />}<div><div className="message-bubble">{message.text}</div><time>{message.time}</time></div></div>)}</div><div className="composer"><div className="composer-tools"><button>＋</button><button>☺</button><span>与 {selected.name} 对话</span></div><textarea value={draft} onChange={(e) => setDraft(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); } }} placeholder="输入消息…" rows={3} /><div className="composer-footer"><span>Enter 发送 · Shift + Enter 换行</span><button onClick={send} disabled={!draft.trim()}>发送</button></div></div></>}</section>
    </> : <section className="org-panel"><header className="org-header"><div><span className="eyebrow">COMPANY DIRECTORY</span><h1>组织架构</h1><p>{employees.length} 位员工 · {grouped.length} 个部门</p></div><button className="primary-action" onClick={() => setShowAdd(true)}>＋ 添加员工</button></header><div className="org-summary"><div><span>公司负责人</span><strong>马斯克</strong></div><div><span>在线成员</span><strong>{employees.filter((e) => e.online).length}</strong></div><div><span>部门数量</span><strong>{grouped.length}</strong></div></div><div className="department-grid">{grouped.map(([department, members]) => <section className="department-card" key={department}><header><div><span className="department-icon">{department.slice(0, 1)}</span><div><h2>{department}</h2><p>{members.length} 位成员</p></div></div><button onClick={() => setShowAdd(true)}>＋</button></header><div className="member-list">{members.map((member) => <button key={member.id} onClick={() => openChat(member.id)}><Avatar employee={member} /><div><strong>{member.name}</strong><span>{member.role}</span></div><span className="member-chat">对话 ›</span></button>)}</div></section>)}</div></section>}
    <nav className="mobile-nav"><NavButton active={view === 'chat'} label="消息" icon="chat" onClick={() => { setView('chat'); setMobileConversation(false); }} /><NavButton active={view === 'org'} label="通讯录" icon="org" onClick={() => setView('org')} /></nav>
    {showAdd && <AddEmployeeModal onClose={() => setShowAdd(false)} onAdd={(employee) => { setEmployees((items) => [...items, employee]); setMessages((items) => ({ ...items, [employee.id]: [] })); setShowAdd(false); setSelectedId(employee.id); }} />}
  </main>;
}
function Avatar({ employee, compact = false }: { employee: Employee; compact?: boolean }) { return <div className={`avatar ${compact ? 'compact' : ''}`} style={{ background: employee.color }}>{employee.initials}<i className={employee.online ? 'online' : ''} /></div>; }
function NavButton({ active, label, icon, onClick }: { active: boolean; label: string; icon: 'chat' | 'org'; onClick: () => void }) { return <button className={`nav-button ${active ? 'active' : ''}`} onClick={onClick}>{icon === 'chat' ? <ChatIcon /> : <OrgIcon />}<span>{label}</span></button>; }
function AddEmployeeModal({ onClose, onAdd }: { onClose: () => void; onAdd: (employee: Employee) => void }) { const [name, setName] = useState(''); const [role, setRole] = useState(''); const [department, setDepartment] = useState(''); const submit = (e: FormEvent) => { e.preventDefault(); if (!name.trim() || !role.trim() || !department.trim()) return; onAdd({ id: crypto.randomUUID(), name: name.trim(), role: role.trim(), department: department.trim(), initials: name.trim().slice(0, 2).toUpperCase(), color: colors[Math.floor(Math.random() * colors.length)], online: false }); }; return <div className="modal-backdrop" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}><form className="employee-modal" onSubmit={submit}><header><div><span className="eyebrow">NEW MEMBER</span><h2>添加员工</h2></div><button type="button" onClick={onClose}>×</button></header><label>姓名<input autoFocus value={name} onChange={(e) => setName(e.target.value)} placeholder="例如：张三" /></label><label>职位<input value={role} onChange={(e) => setRole(e.target.value)} placeholder="例如：运营负责人" /></label><label>所属部门<input value={department} onChange={(e) => setDepartment(e.target.value)} placeholder="例如：运营部" /></label><footer><button type="button" onClick={onClose}>取消</button><button className="primary-action" type="submit">添加到组织</button></footer></form></div>; }
function ChatIcon() { return <svg viewBox="0 0 24 24"><path d="M5 5.8h14v9.4H9l-4 3v-12.4Z" /></svg>; }
function OrgIcon() { return <svg viewBox="0 0 24 24"><circle cx="12" cy="6" r="2.5" /><circle cx="6" cy="17" r="2.5" /><circle cx="18" cy="17" r="2.5" /><path d="M12 8.5v4M6 14.5v-2h12v2" /></svg>; }
function SearchIcon() { return <svg viewBox="0 0 24 24"><circle cx="11" cy="11" r="6" /><path d="m16 16 4 4" /></svg>; }
