'use client';

import { Fragment, ReactNode, useEffect, useMemo, useRef, useState, type Dispatch, type SetStateAction } from 'react';
import Image from 'next/image';

type Employee = { id: string; name: string; role: string; department: string; initials: string; color: string; online: boolean };
type RunTraceAssignment = { agentId: string; name: string; task: string };
type RunTraceChild = { agentId: string; name: string; status: string; outputText: string | null; errorText: string | null };
type RunTrace = { action: string; reason: string; assignments: RunTraceAssignment[]; childRuns: RunTraceChild[]; usage: { totalTokens: number } };
type Attachment = { id: string; originalName: string; mimeType: string; sizeBytes: number; category: 'image' | 'document' | 'spreadsheet' | 'text'; status: string; extractedText?: string | null };
type Message = { id: string; sender: 'me' | 'employee'; text: string; time: string; tokens?: number; trace?: RunTrace; tracePending?: boolean; attachments?: Attachment[] };
type MessageMap = Record<string, Message[]>;
type ChatModel = 'kimi' | 'deepseek';
type AnswerMode = 'fast' | 'deep';

const seedEmployees: Employee[] = [
  { id: 'elon', name: '马斯克', role: 'CEO · 中控大脑', department: '公司总部', initials: 'EM', color: '#ff7a45', online: true },
  { id: 'jobs', name: '乔布斯', role: '产品负责人', department: '产品部', initials: 'SJ', color: '#3988ff', online: true },
  { id: 'buffett', name: '巴菲特', role: '财务顾问', department: '财务部', initials: 'WB', color: '#20b486', online: true },
  { id: 'munger', name: '芒格', role: '战略顾问', department: '战略部', initials: 'CM', color: '#8b7cf6', online: false },
];
const seedMessages: MessageMap = {
  elon: [{ id: 'e1', sender: 'employee', text: '早上好。今天最重要的目标是什么？我会先拆掉不必要的假设。', time: '09:28' }, { id: 'e2', sender: 'me', text: '帮我规划未来 90 天的业务增长重点。', time: '09:31' }, { id: 'e3', sender: 'employee', text: '收到。我会从用户价值、增长瓶颈和执行速度三个维度整理方案。', time: '09:32' }],
  buffett: [{ id: 'b1', sender: 'employee', text: '现金流比利润表更诚实。把最新预算发给我，我来检查安全边际。', time: '昨天' }],
  munger: [{ id: 'm1', sender: 'employee', text: '先告诉我哪些事情绝对不能失败，我们再反向推导策略。', time: '周四' }],
  jobs: [{ id: 'j1', sender: 'employee', text: '产品不是功能的集合。我们先确认用户真正想完成什么。', time: '周三' }],
};
type Skill = { name: string; description?: string; desc: string };
type EmployeeProfile = { summary: string; traits: string[]; expertise: string; strengths: string[]; weaknesses: string[]; bestFor: string[]; skills: Skill[]; nationality?: string; age?: number | ''; keywords?: string[]; notGoodAt?: string[]; career?: string[] };
type OrgNode = { id: string; name: string; description: string; parentId: string | null; department?: string; headEmployeeId?: string };
type DecisionNode = { employeeId: string; domain: string; keywords: string[] };
type DecisionLine = { dispatcherId: string; nodes: DecisionNode[] };
type Group = { id: string; name: string; members: string[] };
type GroupMessage = { id: string; sender: 'me' | 'employee'; senderName: string; text: string; time: string; tokens?: number; attachments?: Attachment[] };
type GroupMessageMap = Record<string, GroupMessage[]>;
const employeeProfiles: Record<string, EmployeeProfile> = {
  elon: { summary: '用第一性原理拆解复杂问题，强调速度、工程可行性和量化结果。', traits: ['第一性原理', '高执行力', '敢于挑战'], expertise: '战略决策 · 商业增长 · 工程管理', strengths: ['能迅速抓住核心矛盾并拆除无效假设', '目标感强，擅长推动高难度项目落地', '善于把宏大目标转化成工程指标'], weaknesses: ['决策节奏快，可能低估团队承压程度', '容易对短期执行细节要求过高', '激进方案需要财务与风险角色制衡'], bestFor: ['公司战略与关键方向判断', '增长瓶颈和复杂项目攻坚', '需要大胆突破的产品或技术决策'], skills: [], nationality: '美国', age: 53, keywords: ['战略', '增长', '工程', '技术', '第一性原理', '执行', '指标'], notGoodAt: ['高频琐碎的日常运营', '需要耐心沟通的流程性工作'], career: ['SpaceX / Tesla 创始人兼 CEO', 'PayPal 联合创始人', 'xAI 创始人'] },
  buffett: { summary: '坚持长期主义与安全边际，先看现金流、风险和可持续回报。', traits: ['长期主义', '稳健理性', '重视现金流'], expertise: '财务分析 · 价值投资 · 风险控制', strengths: ['善于评估长期价值与真实盈利质量', '风险意识强，能够守住资金安全边界', '判断稳定，不易受短期情绪影响'], weaknesses: ['面对需要快速试错的机会可能偏保守', '对缺少历史数据的新业务容忍度较低', '不适合追逐短期热点和高频操作'], bestFor: ['预算、投资和现金流决策', '商业模式与长期回报评估', '重大项目的风险审查'], skills: [], nationality: '美国', age: 94, keywords: ['财务', '投资', '预算', '现金流', '价值', '风险', '成本'], notGoodAt: ['需要快速试错的创新领域', '缺乏历史数据的全新业务', '高频短线操作'], career: ['伯克希尔·哈撒韦 CEO', '长期价值投资实践者', '盖茨基金会受托人'] },
  munger: { summary: '善用多元思维模型和逆向思考，主动识别偏差与二阶效应。', traits: ['逆向思考', '多元模型', '风险敏锐'], expertise: '战略推演 · 决策复盘 · 风险预判', strengths: ['能从多个学科视角审视同一问题', '擅长发现认知偏差和隐藏风险', '能够预判决策的长期连锁反应'], weaknesses: ['分析深入，可能降低简单事项的决策速度', '表达直接，容易让方案提出者感到压力', '更擅长判断与纠偏，而不是一线推进'], bestFor: ['重要决策的反方审查', '失败预演和风险清单', '复杂问题的复盘与纠偏'], skills: [], nationality: '美国', age: 99, keywords: ['战略', '风险', '决策', '复盘', '逆向', '复利', '偏差'], notGoodAt: ['一线执行与落地', '需要速度的简单事项'], career: ['伯克希尔·哈撒韦副董事长', 'Daily Journal 董事长', '律师事务所合伙人'] },
  jobs: { summary: '从用户体验和产品本质出发，追求聚焦、简洁与卓越。', traits: ['用户导向', '极致审美', '聚焦取舍'], expertise: '产品设计 · 用户体验 · 品牌表达', strengths: ['对用户体验和产品细节高度敏感', '善于砍掉非核心功能，保持产品聚焦', '能建立清晰、有感染力的产品愿景'], weaknesses: ['对品质要求极高，可能增加团队返工压力', '容易否定尚未达到预期的早期方案', '审美判断较主观，需要用户数据验证'], bestFor: ['产品定位与核心体验设计', '功能取舍和产品评审', '品牌表达与发布方案'], skills: [], nationality: '美国', age: 56, keywords: ['产品', '设计', '体验', '品牌', '功能', '界面', '聚焦'], notGoodAt: ['纯技术底层实现', '大规模运维与行政事务'], career: ['Apple 联合创始人兼 CEO', 'Pixar 创始人兼 CEO', 'NeXT 创始人'] },
};
const DEFAULT_DECISION_LINE: DecisionLine = { dispatcherId: 'elon', nodes: [{ employeeId: 'jobs', domain: '产品设计 · 用户体验 · 品牌表达', keywords: ['产品', '设计', '体验', '品牌', '功能', '界面', '用户'] }, { employeeId: 'buffett', domain: '财务分析 · 价值投资 · 风险控制', keywords: ['财务', '投资', '预算', '现金流', '成本', '利润', '资金', '收益'] }, { employeeId: 'munger', domain: '战略推演 · 决策复盘 · 风险预判', keywords: ['战略', '风险', '决策', '复盘', '偏差', '逆向', '连锁'] }, { employeeId: 'elon', domain: '战略决策 · 商业增长 · 工程管理', keywords: ['战略', '增长', '工程', '技术', '突破', '执行', '指标'] }] };
function getEmployeeProfile(employee: Employee, profiles: Record<string, EmployeeProfile>): EmployeeProfile { return profiles[employee.id] || employeeProfiles[employee.id] || { summary: `围绕${employee.role}职责提供专业、具体且可执行的工作建议。`, traits: ['专业可靠', '结果导向', '主动协作'], expertise: `${employee.department} · ${employee.role}`, strengths: ['熟悉本岗位的专业工作', '能够围绕目标提供可执行建议', '沟通清晰并主动配合团队'], weaknesses: ['对跨部门信息的掌握依赖你提供的上下文', '遇到信息不足时需要进一步确认', '重要结论仍需要结合真实业务数据验证'], bestFor: [`处理${employee.role}相关任务`, `${employee.department}的方案分析与执行建议`, '日常工作讨论和方案初稿'], skills: [] }; }

async function pushEmployees(list: Employee[]) { try { await fetch('/api/employees', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ employees: list }) }); } catch {} }
async function createEmployee(employee: Employee) { const response = await fetch('/api/employees', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ employee }) }); const data = await response.json().catch(() => ({})) as { error?: string }; if (!response.ok) throw new Error(data.error || '新增成员失败'); }
async function moveEmployee(employeeId: string, department: string) { const response = await fetch('/api/employees', { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ employeeId, department }) }); const data = await response.json().catch(() => ({})) as { error?: string }; if (!response.ok) throw new Error(data.error || '调整部门失败'); }
async function pushMessages(map: MessageMap) { try { await fetch('/api/messages', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ messages: map }) }); } catch {} }
async function pushProfiles(profiles: Record<string, EmployeeProfile>) { try { await fetch('/api/profiles', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ profiles }) }); } catch {} }
async function pushProfile(employeeId: string, profile: EmployeeProfile) {
  const response = await fetch('/api/profiles', { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ employeeId, profile }) });
  const data = await response.json().catch(() => ({})) as { error?: string };
  if (!response.ok) throw new Error(data.error || '档案保存失败');
}
async function pushDecisionLine(decisionLine: DecisionLine) { try { await fetch('/api/decision-line', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ decisionLine }) }); } catch {} }
async function pushGroups(groups: Group[]) { try { await fetch('/api/groups', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ groups }) }); } catch {} }
async function pushGroupMessages(map: GroupMessageMap) { try { await fetch('/api/group-messages', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ groupMessages: map }) }); } catch {} }
async function deleteDmMessagesApi(employeeId: string) { try { await fetch(`/api/messages?employee=${encodeURIComponent(employeeId)}`, { method: 'DELETE' }); } catch {} }
async function deleteGroupApi(groupId: string) { try { await fetch(`/api/groups?id=${encodeURIComponent(groupId)}`, { method: 'DELETE' }); await fetch(`/api/group-messages?group=${encodeURIComponent(groupId)}`, { method: 'DELETE' }); } catch {} }
async function pushSettings(partial: { chatModel?: ChatModel; answerMode?: AnswerMode; contextStarts?: Record<string, number>; employeeModels?: Record<string, ChatModel> }) { try { await fetch('/api/settings', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(partial) }); } catch {} }
async function pushOrgNodes(orgNodes: OrgNode[]) { try { await fetch('/api/org-nodes', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ orgNodes }) }); } catch {} }

async function readJsonResponse<T>(response: Response): Promise<T> {
  const text = await response.text();
  if (!text) throw new Error(`请求失败 (${response.status})`);
  try {
    return JSON.parse(text) as T;
  } catch {
    const message = text.replace(/\s+/g, ' ').trim();
    throw new Error(message || `服务返回了无法解析的响应 (${response.status})`);
  }
}

function agentNameOf(agentId: string, employees: Employee[]): string { if (agentId === 'agent_company') return '协调处理'; const employeeId = agentId.startsWith('emp_') ? agentId.slice(4) : agentId; return employees.find((e) => e.id === employeeId)?.name ?? agentId; }

function msgTimeInfo(t: string): { label: string; time: string; epoch: number } {
  const full = /^\d{4}/.test(t || '') ? new Date(t) : null;
  if (full && !isNaN(full.getTime())) {
    const now = new Date();
    const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const day = new Date(full.getFullYear(), full.getMonth(), full.getDate());
    const diff = Math.round((today.getTime() - day.getTime()) / 86400000);
    const hm = `${String(full.getHours()).padStart(2, '0')}:${String(full.getMinutes()).padStart(2, '0')}`;
    const label = diff === 0 ? '今天' : diff === 1 ? '昨天' : `${full.getMonth() + 1}月${full.getDate()}日`;
    return { label, time: hm, epoch: full.getTime() };
  }
  if (/^\d{1,2}:\d{2}$/.test(t || '')) {
    const d = new Date(); const parts = (t || '').split(':'); d.setHours(Number(parts[0]), Number(parts[1]), 0, 0);
    return { label: '今天', time: t || '', epoch: d.getTime() };
  }
  return { label: t || '今天', time: t || '', epoch: 0 };
}
function msgListTime(t: string): string { const info = msgTimeInfo(t); return info.label === '今天' ? info.time : info.label; }
function sortMsgsByTime<T extends { id: string; time: string }>(list: T[]): Array<{ m: T; i: number; label: string }> {
  return list.map((m, i) => ({ m, i, label: msgTimeInfo(m.time).label, epoch: msgTimeInfo(m.time).epoch })).sort((a, b) => a.epoch - b.epoch || a.i - b.i);
}
function sortGroupMessages(list: GroupMessage[]): GroupMessage[] {
  return sortMsgsByTime(list).map(({ m }) => m);
}

function formatSize(bytes: number): string { if (bytes >= 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`; if (bytes >= 1024) return `${Math.round(bytes / 1024)} KB`; return `${bytes} B`; }
function attachmentUrl(id: string): string { return `/api/attachments/${encodeURIComponent(id)}/file`; }

function buildAttachmentNote(atts: Attachment[]): string {
  if (!atts?.length) return '';
  return '\n\n[用户上传了附件]\n' + atts.map((a) => a.extractedText ? `· ${a.originalName}（已抽取文本）\n${(a.extractedText || '').slice(0, 3000)}` : `· ${a.originalName}（${a.category === 'image' ? '图片' : '文件'}）`).join('\n');
}

function AttachmentChips({ attachments }: { attachments?: Attachment[] }) {
  if (!attachments?.length) return null;
  return <div className="msg-attachments">{attachments.map((a) => a.category === 'image'
    ? <a key={a.id} className="msg-att-img" href={attachmentUrl(a.id)} target="_blank" rel="noreferrer" title={a.originalName}><img src={attachmentUrl(a.id)} alt={a.originalName} loading="lazy" /></a>
    : <a key={a.id} className="msg-att-chip" href={attachmentUrl(a.id)} download={a.originalName} title={`下载 ${a.originalName}`}><span className="att-icon">{a.category === 'spreadsheet' ? '📊' : '📄'}</span><span className="att-name">{a.originalName}</span><span className="att-size">{formatSize(a.sizeBytes)}</span></a>)}
  </div>;
}

function AttachmentDraftList({ attachments, onRemove }: { attachments: Attachment[]; onRemove: (id: string) => void }) {
  if (!attachments?.length) return null;
  return <div className="att-draft-list">{attachments.map((a) => a.category === 'image'
    ? <div key={a.id} className="att-draft att-draft-img"><img src={attachmentUrl(a.id)} alt={a.originalName} /><button type="button" aria-label="移除附件" onClick={() => onRemove(a.id)}>×</button></div>
    : <div key={a.id} className="att-draft"><span className="att-icon">{a.category === 'spreadsheet' ? '📊' : '📄'}</span><span className="att-name">{a.originalName}</span><span className="att-size">{formatSize(a.sizeBytes)}</span><button type="button" aria-label="移除附件" onClick={() => onRemove(a.id)}>×</button></div>)}
  </div>;
}

const DEFAULT_ORG_NODES: OrgNode[] = [
  { id: 'root', name: '公司总部', parentId: null, department: '公司总部', description: '统筹公司整体战略与经营目标，负责跨部门协调、资源分配与重大决策的最终拍板。' },
  { id: 'mgmt', name: '管理层', parentId: 'root', department: '管理层', description: '负责公司战略方向制定、关键项目决策与全局资源调度，向下拆解目标并分派给各部门。' },
  { id: 'product', name: '产品部', parentId: 'root', department: '产品部', headEmployeeId: 'jobs', description: '负责产品定位、用户体验与品牌表达，把用户需求转化为可落地的产品方案，并对功能做取舍评审。' },
  { id: 'finance', name: '财务部', parentId: 'root', department: '财务部', headEmployeeId: 'buffett', description: '负责预算、投资、现金流与风险控制，评估商业模式与长期回报，守住资金安全边界。' },
  { id: 'strategy', name: '战略部', parentId: 'root', department: '战略部', headEmployeeId: 'munger', description: '负责战略推演、决策复盘与风险预判，用多元思维模型识别偏差、预演失败并纠偏。' },
  { id: 'hr', name: '人力资源部', parentId: 'root', department: '人力资源部', description: '负责招聘、培训、绩效与员工关系，搭建人才梯队并建设组织文化。' },
  { id: 'recruiting', name: '招聘部', parentId: 'hr', department: '招聘部', description: '负责人才需求分析、候选人搜寻、面试评估与录用跟进，为各部门持续补充合适人才。' },
];

export default function IMPage() {
  const [view, setView] = useState<'chat' | 'org' | 'decision'>('chat');
  const [employees, setEmployees] = useState<Employee[]>(seedEmployees);
  const [messages, setMessages] = useState<MessageMap>(seedMessages);
  const [selectedId, setSelectedId] = useState('elon');
  const [draft, setDraft] = useState('');
  const [search, setSearch] = useState('');
  const [showEmployeeInfo, setShowEmployeeInfo] = useState(false);
  const [mobileConversation, setMobileConversation] = useState(false);
  const [hydrated, setHydrated] = useState(false);
  const [replying, setReplying] = useState(false);
  const [aiError, setAiError] = useState('');
  const [chatModel, setChatModel] = useState<ChatModel>('kimi');
  const [answerMode, setAnswerMode] = useState<AnswerMode>('fast');
  const [contextStarts, setContextStarts] = useState<Record<string, number>>({});
  const [employeeModels, setEmployeeModels] = useState<Record<string, ChatModel>>({});
  const [dbStatus, setDbStatus] = useState<'local' | 'connected'>('local');
  const [profiles, setProfiles] = useState<Record<string, EmployeeProfile>>(employeeProfiles);
  const [decisionLine, setDecisionLine] = useState<DecisionLine>(DEFAULT_DECISION_LINE);
  const [showDecisionLine, setShowDecisionLine] = useState(false);
  const [showAssign, setShowAssign] = useState(false);
  const [groups, setGroups] = useState<Group[]>([]);
  const [groupMessages, setGroupMessages] = useState<GroupMessageMap>({});
  const [activeGroupId, setActiveGroupId] = useState<string | null>(null);
  const [showNewGroup, setShowNewGroup] = useState(false);
  const [showGroupInfo, setShowGroupInfo] = useState(false);
  const [groupDraft, setGroupDraft] = useState('');
  const [groupMentionIndex, setGroupMentionIndex] = useState(0);
  const [groupMentionOpen, setGroupMentionOpen] = useState(false);
  const [groupCursor, setGroupCursor] = useState(0);
  const [groupReplying, setGroupReplying] = useState(false);
  const [groupAiError, setGroupAiError] = useState('');
  const [groupNotice, setGroupNotice] = useState('');
  const [draftAttachments, setDraftAttachments] = useState<Attachment[]>([]);
  const [groupDraftAttachments, setGroupDraftAttachments] = useState<Attachment[]>([]);
  const [uploading, setUploading] = useState(false);
  const [orgNodes, setOrgNodes] = useState<OrgNode[]>(DEFAULT_ORG_NODES);
  const [selectedOrgNodeId, setSelectedOrgNodeId] = useState<string | null>('root');
  const [selectedOrgMemberId, setSelectedOrgMemberId] = useState<string | null>(null);
  const messageEndRef = useRef<HTMLDivElement>(null);
  const groupInputRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  useEffect(() => { queueMicrotask(() => { try { const e = localStorage.getItem('myteam-employees'); const m = localStorage.getItem('myteam-messages'); const model = localStorage.getItem('myteam-chat-model'); const mode = localStorage.getItem('myteam-answer-mode'); const starts = localStorage.getItem('myteam-context-starts'); const em = localStorage.getItem('myteam-employee-models'); const p = localStorage.getItem('myteam-profiles'); if (e) setEmployees(JSON.parse(e)); if (m) setMessages(JSON.parse(m)); if (starts) setContextStarts(JSON.parse(starts)); if (model === 'kimi' || model === 'deepseek') setChatModel(model); if (mode === 'fast' || mode === 'deep') setAnswerMode(mode); if (em) setEmployeeModels(JSON.parse(em)); if (p) setProfiles(JSON.parse(p)); } catch {} setHydrated(true); }); }, []);
  useEffect(() => { if (!hydrated) return; let cancelled = false; let attempt = 0; const load = async () => { try { const [empRes, msgRes, setRes, profRes, dlRes, grpRes, gmRes, orgRes] = await Promise.all([fetch('/api/employees'), fetch('/api/messages'), fetch('/api/settings'), fetch('/api/profiles'), fetch('/api/decision-line'), fetch('/api/groups'), fetch('/api/group-messages'), fetch('/api/org-nodes')]); if (!empRes.ok || !msgRes.ok || !setRes.ok || !profRes.ok || !dlRes.ok || !grpRes.ok || !gmRes.ok || !orgRes.ok) throw new Error('db-unavailable'); const empData = await empRes.json() as { employees: Employee[] | null }; const msgData = await msgRes.json() as { messages: MessageMap | null }; const setData = await setRes.json() as { settings: { chatModel: ChatModel | null; answerMode: AnswerMode | null; contextStarts: Record<string, number> | null; employeeModels: Record<string, ChatModel> | null } }; const profData = await profRes.json() as { profiles: Record<string, EmployeeProfile> | null }; const dlData = await dlRes.json() as { decisionLine: DecisionLine | null }; const grpData = await grpRes.json() as { groups: Group[] | null }; const gmData = await gmRes.json() as { groupMessages: GroupMessageMap | null }; const orgData = await orgRes.json() as { orgNodes: OrgNode[] | null }; if (cancelled) return; const remoteEmployees = empData.employees; const remoteMessages = msgData.messages; const remoteSettings = setData.settings; const remoteProfiles = profData.profiles; const remoteLine = dlData.decisionLine; const remoteGroups = grpData.groups; const remoteGm = gmData.groupMessages; const remoteOrg = orgData.orgNodes; const employeesOk = !!remoteEmployees && remoteEmployees.length > 0; const messagesOk = !!remoteMessages && Object.keys(remoteMessages).length > 0; const modelOk = !!remoteSettings?.chatModel; const modeOk = !!remoteSettings?.answerMode; const startsOk = !!remoteSettings?.contextStarts; const profilesOk = !!remoteProfiles && Object.keys(remoteProfiles).length > 0; const groupsOk = !!remoteGroups && remoteGroups.length > 0; const gmOk = !!remoteGm && Object.keys(remoteGm).length > 0; const orgOk = !!remoteOrg && remoteOrg.length > 0; if (!employeesOk) void pushEmployees(employees); if (!messagesOk) void pushMessages(messages); if (!modelOk) void pushSettings({ chatModel }); if (!modeOk) void pushSettings({ answerMode }); if (!startsOk) void pushSettings({ contextStarts }); if (!profilesOk) void pushProfiles(employeeProfiles); if (!orgOk) void pushOrgNodes(DEFAULT_ORG_NODES); setEmployees(employeesOk ? remoteEmployees! : employees); setMessages(messagesOk ? remoteMessages! : messages); if (modelOk) setChatModel(remoteSettings!.chatModel!); if (modeOk) setAnswerMode(remoteSettings!.answerMode!); if (startsOk) setContextStarts(remoteSettings!.contextStarts!); if (remoteSettings?.employeeModels) setEmployeeModels(remoteSettings.employeeModels); setProfiles(profilesOk ? remoteProfiles! : employeeProfiles); setOrgNodes(orgOk ? remoteOrg! : DEFAULT_ORG_NODES); if (remoteLine) { setDecisionLine(remoteLine); void pushDecisionLine(remoteLine); } setGroups(groupsOk ? remoteGroups! : []); setGroupMessages(gmOk ? remoteGm! : {}); setDbStatus('connected'); } catch { if (cancelled) return; if (attempt < 1) { attempt += 1; setTimeout(load, 1500); } else { setDbStatus('local'); } } }; load(); return () => { cancelled = true; }; }, [hydrated]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { if (hydrated) localStorage.setItem('myteam-employees', JSON.stringify(employees)); if (hydrated && dbStatus === 'connected') void pushEmployees(employees); }, [employees, hydrated, dbStatus]);
  useEffect(() => { if (hydrated) localStorage.setItem('myteam-messages', JSON.stringify(messages)); if (hydrated && dbStatus === 'connected') void pushMessages(messages); }, [messages, hydrated, dbStatus]);
  useEffect(() => { if (hydrated) localStorage.setItem('myteam-chat-model', chatModel); if (hydrated && dbStatus === 'connected') void pushSettings({ chatModel }); }, [chatModel, hydrated, dbStatus]);
  useEffect(() => { if (hydrated) localStorage.setItem('myteam-answer-mode', answerMode); if (hydrated && dbStatus === 'connected') void pushSettings({ answerMode }); }, [answerMode, hydrated, dbStatus]);
  useEffect(() => { if (hydrated) localStorage.setItem('myteam-context-starts', JSON.stringify(contextStarts)); if (hydrated && dbStatus === 'connected') void pushSettings({ contextStarts }); }, [contextStarts, hydrated, dbStatus]);
  useEffect(() => { if (hydrated) localStorage.setItem('myteam-employee-models', JSON.stringify(employeeModels)); if (hydrated && dbStatus === 'connected') void pushSettings({ employeeModels }); }, [employeeModels, hydrated, dbStatus]);
  useEffect(() => { if (hydrated) localStorage.setItem('myteam-profiles', JSON.stringify(profiles)); }, [profiles, hydrated]);
  useEffect(() => { if (hydrated && dbStatus === 'connected') void pushDecisionLine(decisionLine); }, [decisionLine, hydrated, dbStatus]);
  useEffect(() => { if (hydrated && dbStatus === 'connected') void pushGroups(groups); }, [groups, hydrated, dbStatus]);
  useEffect(() => { if (hydrated && dbStatus === 'connected') void pushGroupMessages(groupMessages); }, [groupMessages, hydrated, dbStatus]);
  useEffect(() => { if (hydrated && dbStatus === 'connected') void pushOrgNodes(orgNodes); }, [orgNodes, hydrated, dbStatus]);
  const selected = activeGroupId ? null : (employees.find((item) => item.id === selectedId) ?? employees[0]);
  const filtered = employees.filter((item) => `${item.name}${item.role}${item.department}`.toLowerCase().includes(search.toLowerCase()));
  const decisionDispatcher = employees.find((e) => e.id === decisionLine.dispatcherId) ?? employees[0];
  const assignMatches = useMemo(() => { const text = selected ? (messages[selected.id] || []).filter((m) => m.sender === 'me').map((m) => m.text).join('\n') : ''; if (!text) return []; const byEmployee = new Map<string, string[]>(); for (const node of decisionLine.nodes) { const hits = node.keywords.filter((k) => k && text.includes(k)); if (!hits.length) continue; const prev = byEmployee.get(node.employeeId) || []; byEmployee.set(node.employeeId, hits.length > prev.length ? hits : prev); } return Array.from(byEmployee.entries()).map(([employeeId, keywords]) => ({ employeeId, keywords })).sort((a, b) => b.keywords.length - a.keywords.length); }, [messages, selected, decisionLine]);
  const openChat = (id: string) => { setActiveGroupId(null); setSelectedId(id); setView('chat'); setMobileConversation(true); };
  const openGroup = (id: string) => { setSelectedId(''); setActiveGroupId(id); setView('chat'); setMobileConversation(true); };
  const activeGroup = activeGroupId ? groups.find((g) => g.id === activeGroupId) ?? null : null;
  const selectedThread = sortMsgsByTime(messages[selected?.id || ''] || []);
  const openChatByName = (name: string) => { const e = employees.find((x) => x.name === name); if (e) openChat(e.id); };
  const modelFor = (employeeId?: string): ChatModel => (employeeId && employeeModels[employeeId]) || chatModel;
  const setEmployeeModel = (employeeId: string, model: ChatModel | null) => setEmployeeModels((cur) => { const next = { ...cur }; if (model) next[employeeId] = model; else delete next[employeeId]; return next; });
  const uploadFiles = async (files: FileList | File[], toGroup: boolean) => {
    const ownerType = toGroup ? 'group' : 'single';
    const ownerId = toGroup ? activeGroupId : selected?.id;
    if (!ownerId) { if (toGroup) setGroupAiError('当前群无效，无法上传附件'); else setAiError('当前会话无效，无法上传附件'); return; }
    const list = Array.from(files).slice(0, 5);
    if (!list.length) return;
    setUploading(true);
    const setAtts = toGroup ? setGroupDraftAttachments : setDraftAttachments;
    const setErr = toGroup ? setGroupAiError : setAiError;
    setErr('');
    try {
      const uploaded: Attachment[] = [];
      for (const file of list) {
        const form = new FormData();
        form.append('file', file);
        form.append('ownerType', ownerType);
        form.append('ownerId', ownerId);
        const res = await fetch('/api/attachments', { method: 'POST', body: form });
        const data = await readJsonResponse<{ attachment?: Attachment; error?: string }>(res);
        if (!res.ok || !data.attachment) throw new Error(data.error || `上传失败：${file.name}`);
        uploaded.push(data.attachment);
      }
      setAtts((cur) => [...cur, ...uploaded].slice(0, 5));
    } catch (error) {
      setErr(error instanceof Error ? error.message : '附件上传失败');
    } finally {
      setUploading(false);
      if (fileInputRef.current) fileInputRef.current.value = '';
    }
  };
  const removeDraftAttachment = (toGroup: boolean, id: string) => { (toGroup ? setGroupDraftAttachments : setDraftAttachments)((cur) => cur.filter((a) => a.id !== id)); };
  useEffect(() => { messageEndRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' }); }, [selectedId, messages, replying]);
  const startNewConversation = () => { if (!selected || replying) return; setContextStarts((current) => ({ ...current, [selected.id]: (messages[selected.id] || []).length })); setDraft(''); setAiError(''); };
  const send = async () => {
    const text = draft.trim(); if ((!text && !draftAttachments.length) || !selected || replying) return;
    const now = () => new Date().toISOString();
    const userMessage: Message = { id: crypto.randomUUID(), sender: 'me', text: text || '', time: now(), attachments: draftAttachments.length ? draftAttachments : undefined };
    const history = [...(messages[selected.id] || []), userMessage];
    const isDispatcher = selected.id === decisionLine.dispatcherId;
    const traceId = crypto.randomUUID();
    const pending = isDispatcher ? [{ id: traceId, sender: 'employee' as const, text: '', time: now(), tracePending: true }] : [];
    setMessages((current) => ({ ...current, [selected.id]: [...history, ...pending] })); setDraft(''); setDraftAttachments([]); setReplying(true); setAiError('');
    try {
      if (isDispatcher) {
        // 调度者走平台 Agent（Company Agent），展示 规划→委派→汇总 过程
        const activeHistory = history.slice(contextStarts[selected.id] || 0);
        const response = await fetch('/api/agent/runs', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ conversationId: `dm_${selected.id}`, agentId: 'agent_company', personaAgentId: `emp_${selected.id}`, message: text + buildAttachmentNote(draftAttachments), mode: answerMode, model: modelFor(selected.id), history: activeHistory.map(({ sender, text: content }) => ({ role: sender === 'me' ? 'user' : 'assistant', content })) }) });
        const data = await readJsonResponse<{ answer?: string | null; error?: string; code?: string; message?: string; plan?: { action?: string; reason?: string; groupName?: string; assignments?: Array<{ agentId: string; task: string }> } | null; childRuns?: Array<{ agentId: string; status: string; outputText: string | null; errorText: string | null }>; usage?: { totalTokens?: number } }>(response);
        if (!response.ok) throw new Error(data.error || data.message || data.code || '平台暂时无法回复');
        const assignments = (data.plan?.assignments ?? []).map((a) => ({ agentId: a.agentId, name: agentNameOf(a.agentId, employees), task: a.task }));
        const childRuns = (data.childRuns ?? []).map((c) => ({ agentId: c.agentId, name: agentNameOf(c.agentId, employees), status: c.status, outputText: c.outputText, errorText: c.errorText }));
        const trace: RunTrace = { action: data.plan?.action ?? 'answer', reason: data.plan?.reason ?? '', assignments, childRuns, usage: { totalTokens: data.usage?.totalTokens ?? 0 } };
        if (data.plan?.action === 'delegate' && assignments.length) {
          // 委派：自动拉群——群名用 Planner 建议（可在群信息里改名），员工在群里各自回复
          const groupName = (data.plan.groupName && data.plan.groupName.trim()) || (`${text.replace(/[？?。！!，,、\s]+/g, '').slice(0, 8) || '任务'}协作群`);
          const memberIds: string[] = [selected.id];
          for (const a of assignments) {
            const employeeId = a.agentId.startsWith('emp_') ? a.agentId.slice(4) : a.agentId;
            const emp = employees.find((e) => e.id === employeeId);
            if (emp && !memberIds.includes(emp.id)) memberIds.push(emp.id);
          }
          const groupId = `g-${crypto.randomUUID().slice(0, 8)}`;
          const childById = new Map((data.childRuns ?? []).map((c) => [c.agentId, c]));
          const gm: GroupMessage[] = [{ id: crypto.randomUUID(), sender: 'me', senderName: '', text, time: now() }];
          gm.push({ id: crypto.randomUUID(), sender: 'employee', senderName: selected.name, text: `我来分派任务，各位完成后直接在群里回复：\n${assignments.map((a) => `@${a.name} ${a.task}`).join('\n')}`, time: now() });
          for (const a of assignments) {
            const child = childById.get(a.agentId);
            if (child?.status === 'succeeded' && child.outputText) gm.push({ id: crypto.randomUUID(), sender: 'employee', senderName: a.name, text: child.outputText, time: now() });
            else if (child?.status === 'failed') gm.push({ id: crypto.randomUUID(), sender: 'employee', senderName: a.name, text: `（执行失败：${child.errorText || '未知错误'}）`, time: now() });
          }
          if (data.answer) gm.push({ id: crypto.randomUUID(), sender: 'employee', senderName: selected.name, text: data.answer, time: now(), tokens: data.usage?.totalTokens });
          setGroups((cur) => [...cur, { id: groupId, name: groupName, members: memberIds }]);
          setGroupMessages((cur) => ({ ...cur, [groupId]: gm }));
          const reply: Message = { id: traceId, sender: 'employee', text: `已拉群「${groupName}」并分派给 ${assignments.map((a) => a.name).join('、')}，去群里跟进。`, time: now(), tokens: data.usage?.totalTokens, trace };
          setMessages((current) => ({ ...current, [selected.id]: (current[selected.id] || []).map((m) => (m.id === traceId ? reply : m)) }));
          openGroup(groupId);
        } else {
          if (!data.answer) throw new Error(data.error || data.message || data.code || '平台暂时无法回复');
          const reply: Message = { id: traceId, sender: 'employee', text: data.answer, time: now(), tokens: data.usage?.totalTokens, trace };
          setMessages((current) => ({ ...current, [selected.id]: (current[selected.id] || []).map((m) => (m.id === traceId ? reply : m)) }));
        }
      } else {
        const activeHistory = history.slice(contextStarts[selected.id] || 0);
        const response = await fetch('/api/chat', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ model: modelFor(selected.id), mode: answerMode, employeeId: selected.id, attachmentIds: draftAttachments.map((a) => a.id), messages: activeHistory.map(({ sender, text: content }) => ({ sender, text: content })) }) });
        const data = await readJsonResponse<{ text?: string; error?: string; usage?: { total_tokens?: number } }>(response);
        if (!response.ok || !data.text) throw new Error(data.error || '员工暂时无法回复');
        const reply: Message = { id: crypto.randomUUID(), sender: 'employee', text: data.text, time: now(), tokens: data.usage?.total_tokens };
        setMessages((current) => ({ ...current, [selected.id]: [...(current[selected.id] || []), reply] }));
      }
    } catch (error) {
      setAiError(error instanceof Error ? error.message : '员工暂时无法回复');
      setMessages((current) => ({ ...current, [selected.id]: (current[selected.id] || []).filter((m) => !(m.id === traceId && m.tracePending)) }));
    }
    finally { setReplying(false); }
  };
  const sendGroup = async () => {
    const text = groupDraft.trim(); if ((!text && !groupDraftAttachments.length) || !activeGroup || groupReplying) return;
    const memberEmployees = activeGroup.members.map((id) => employees.find((e) => e.id === id)).filter((e): e is Employee => !!e);
    // 解析用户消息里 @ 的所有成员（支持一条消息同时 @ 多人）
    const userMentioned = Array.from(new Set(Array.from(text.matchAll(/@([\u4e00-\u9fa5A-Za-z0-9_]+)/g)).map((m) => m[1])));
    const userMentionedEmps = userMentioned.map((name) => memberEmployees.find((e) => e.name === name)).filter((e): e is Employee => !!e);
    const responderEmp = userMentionedEmps[0] ?? memberEmployees.find((e) => e.id === decisionLine.dispatcherId) ?? memberEmployees[0];
    if (!responderEmp) return;
    const now = () => new Date().toISOString();
    const userMsg: GroupMessage = { id: crypto.randomUUID(), sender: 'me', senderName: '', text: text || '', time: now(), attachments: groupDraftAttachments.length ? groupDraftAttachments : undefined };
    const history = [...(groupMessages[activeGroup.id] || []), userMsg];
    setGroupMessages((cur) => ({ ...cur, [activeGroup.id]: history })); setGroupDraft(''); setGroupDraftAttachments([]); setGroupReplying(true); setGroupAiError('');
    const buildExperts = () => decisionLine.nodes.filter((n) => n.employeeId !== decisionLine.dispatcherId).map((n) => { const e = employees.find((x) => x.id === n.employeeId); return { name: e?.name ?? n.employeeId, domain: n.domain }; });
    const callChat = async (emp: Employee, msgs: GroupMessage[], members: Employee[], directive?: string, attachmentIds?: string[]): Promise<{ text: string; tokens?: number }> => { const payloadMsgs = msgs.map(({ sender, text: content }) => ({ sender, text: content })); if (directive) payloadMsgs.push({ sender: 'me', text: directive }); const r = await fetch('/api/chat', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ model: modelFor(emp.id), mode: answerMode, employeeId: emp.id, groupId: activeGroup.id, attachmentIds: attachmentIds || [], messages: payloadMsgs, experts: buildExperts(), group: { name: activeGroup.name, members: members.map((e) => ({ name: e.name, role: e.role })) } }) }); const d = await readJsonResponse<{ text?: string; error?: string; usage?: { total_tokens?: number } }>(r); if (!r.ok || !d.text) throw new Error(d.error || '暂时无法回复'); return { text: d.text, tokens: d.usage?.total_tokens }; };
    try {
      const mainRes = await callChat(responderEmp, history, memberEmployees, undefined, groupDraftAttachments.map((a) => a.id));
      const reply: GroupMessage = { id: crypto.randomUUID(), sender: 'employee', senderName: responderEmp.name, text: mainRes.text, time: now(), tokens: mainRes.tokens };
      const thread = [...history, reply];
      setGroupMessages((cur) => ({ ...cur, [activeGroup.id]: thread }));
      const mentioned = Array.from(new Set(Array.from(mainRes.text.matchAll(/@([\u4e00-\u9fa5A-Za-z0-9_]+)/g)).map((m) => m[1])));
      const memberNames = new Set(memberEmployees.map((e) => e.name));
      const added = mentioned.filter((name) => employees.some((e) => e.name === name) && !memberNames.has(name));
      if (added.length) {
        const idsToAdd = added.map((name) => employees.find((e) => e.name === name)!.id).filter((id) => !activeGroup.members.includes(id));
        if (idsToAdd.length) { setGroups((cur) => cur.map((g) => (g.id === activeGroup.id ? { ...g, members: [...g.members, ...idsToAdd] } : g))); setGroupNotice(`已将 ${added.join('、')} 拉入群`); window.setTimeout(() => setGroupNotice(''), 4000); }
      }
      const allMembers = [...memberEmployees, ...added.map((name) => employees.find((e) => e.name === name)!).filter((e): e is Employee => !!e)];
      const followUpPool: Employee[] = [...userMentionedEmps, ...mentioned.map((name) => employees.find((e) => e.name === name)).filter((e): e is Employee => !!e)];
      const followUps = Array.from(new Map(followUpPool.filter((e) => e.id !== responderEmp.id).map((e) => [e.id, e])).values()).slice(0, 4);
      const completedThread = await followUps.reduce<Promise<GroupMessage[]>>(async (pendingThread, expert) => {
        const currentThread = await pendingThread;
        await new Promise((resolve) => window.setTimeout(resolve, 900));
        try {
          const expertRes = await callChat(expert, currentThread, allMembers, `@${expert.name}，你刚被 @ 了，请用你自己的专业视角给出独立、有差异的补充观点，不要重复前面同事已经说过的内容，控制在几句到一段话，简洁精炼。`);
          const expertReply: GroupMessage = { id: crypto.randomUUID(), sender: 'employee', senderName: expert.name, text: expertRes.text, time: now(), tokens: expertRes.tokens };
          return [...currentThread, expertReply];
        } catch { return currentThread; }
      }, Promise.resolve(thread));
      setGroupMessages((cur) => ({ ...cur, [activeGroup.id]: completedThread }));
    } catch (error) { setGroupAiError(error instanceof Error ? error.message : '暂时无法回复'); }
    finally { setGroupReplying(false); }
  };
  const insertGroupMention = (name: string) => {
    const cursor = groupCursor || groupDraft.length;
    const before = groupDraft.slice(0, cursor);
    const mentionStart = before.lastIndexOf('@');
    const next = `${groupDraft.slice(0, mentionStart >= 0 ? mentionStart : cursor)}@${name} ${groupDraft.slice(cursor)}`;
    const nextCursor = (mentionStart >= 0 ? mentionStart : cursor) + name.length + 2;
    setGroupDraft(next); setGroupCursor(nextCursor); setGroupMentionIndex(0); setGroupMentionOpen(false);
  };
  const createGroup = (name: string, memberIds: string[]) => { const id = `g-${crypto.randomUUID().slice(0, 8)}`; setGroups((cur) => [...cur, { id, name: name.trim() || '未命名群', members: memberIds }]); setShowNewGroup(false); openGroup(id); };
  const removeGroupMember = (memberId: string) => { if (!activeGroup) return; setGroups((cur) => cur.map((g) => (g.id === activeGroup.id ? { ...g, members: g.members.filter((m) => m !== memberId) } : g))); };
  const addGroupMember = (memberId: string) => { if (!activeGroup) return; setGroups((cur) => cur.map((g) => (g.id === activeGroup.id && !g.members.includes(memberId) ? { ...g, members: [...g.members, memberId] } : g))); };
  const renameGroup = (groupId: string, name: string) => { setGroups((cur) => cur.map((g) => (g.id === groupId ? { ...g, name: name.trim() || g.name } : g))); };
  const deleteCurrentConversation = () => {
    if (activeGroup) {
      setGroups((cur) => cur.filter((g) => g.id !== activeGroup.id));
      setGroupMessages((cur) => { const next = { ...cur }; delete next[activeGroup.id]; return next; });
      void deleteGroupApi(activeGroup.id);
      setActiveGroupId(null); setSelectedId(employees[0]?.id || '');
    } else if (selected) {
      setMessages((cur) => { const next = { ...cur }; delete next[selected.id]; return next; });
      void deleteDmMessagesApi(selected.id);
    }
  };
  return <main className="im-shell">
    <aside className="im-nav"><div className="im-brand">M</div><NavButton active={view === 'chat'} label="消息" icon="chat" onClick={() => setView('chat')} /><NavButton active={view === 'org'} label="通讯录" icon="org" onClick={() => setView('org')} /><NavButton active={view === 'decision'} label="决策线" icon="decision" onClick={() => setView('decision')} /><div className="im-nav-spacer" /><button className="im-profile" aria-label="我的账户">K</button></aside>
    <input ref={fileInputRef} type="file" multiple accept=".png,.jpg,.jpeg,.webp,.pdf,.docx,.txt,.md,.csv,.xlsx" style={{ display: 'none' }} onChange={(e) => { const files = e.target.files; if (files?.length) void uploadFiles(files, !!activeGroupId); }} />
    {view === 'chat' ? <>
      <section className={`conversation-list ${mobileConversation ? 'mobile-hidden' : ''}`}><div className="panel-header"><div><span className="eyebrow">MYTEAM</span><span className={`db-pill ${dbStatus === 'connected' ? 'on' : 'off'}`}>{dbStatus === 'connected' ? '云端同步' : '本地模式'}</span><div className="title-model-row"><h1>消息</h1><label className="model-picker"><span>对话模型</span><select aria-label="选择全局对话模型" value={chatModel} disabled={replying} onChange={(e) => { setChatModel(e.target.value as ChatModel); setAiError(''); }}><option value="kimi">Kimi</option><option value="deepseek">DS V4</option></select></label><label className="model-picker mode-picker"><span>回答模式</span><select aria-label="选择回答模式" value={answerMode} disabled={replying} onChange={(e) => { setAnswerMode(e.target.value as AnswerMode); setAiError(''); }}><option value="fast">快速</option><option value="deep">深度</option></select></label></div></div></div><label className="search-box"><SearchIcon /><input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="搜索员工或部门" /></label><div className="conversation-scroll"><div className="section-label">群组 <span>{groups.length}</span><button className="new-group-btn" onClick={() => setShowNewGroup(true)}>＋ 新建</button></div>{groups.map((g) => { const gm = sortGroupMessages(groupMessages[g.id] || []); const last = gm[gm.length - 1]; return <button key={g.id} className={`conversation-card ${activeGroupId === g.id ? 'selected' : ''}`} onClick={() => openGroup(g.id)}><div className="group-avatar-mini">{g.members.slice(0, 3).map((id) => { const e = employees.find((x) => x.id === id); return <span key={id} style={{ background: e?.color }}>{e?.initials?.slice(0, 1)}</span>; })}</div><div className="conversation-copy"><div className="name-line"><strong>{g.name}</strong><time>{last ? msgListTime(last.time) : ''}</time></div><p>{last?.text || '邀请成员讨论…'}</p><span>{g.members.length} 位成员</span></div></button>; })}<div className="section-label">最近对话 <span>{filtered.length}</span></div>{filtered.map((employee) => { const thread = messages[employee.id] || []; const last = thread[thread.length - 1]; return <button key={employee.id} className={`conversation-card ${selectedId === employee.id ? 'selected' : ''}`} onClick={() => openChat(employee.id)}><Avatar employee={employee} /><div className="conversation-copy"><div className="name-line"><strong>{employee.name}</strong><time>{last ? msgListTime(last.time) : ''}</time></div><p>{last?.text || '开始一段新对话'}</p><span>{employee.role}</span></div></button>; })}</div></section>
      <section className={`chat-panel ${mobileConversation ? 'mobile-open' : ''}`}>{selected && <><header className="chat-header"><button className="mobile-back" onClick={() => setMobileConversation(false)}>‹</button><Avatar employee={selected} compact /><div><h2>{selected.name}</h2><p><span className={selected.online ? 'status-online' : 'status-offline'} />{replying ? '正在思考…' : selected.online ? '在线' : '离线'} · {selected.role}</p></div>{selected.id === decisionLine.dispatcherId && <button className="assign-button" onClick={() => setShowAssign((v) => !v)}>分配任务</button>}<button className="employee-info-button" onClick={() => setShowEmployeeInfo(true)}>员工信息</button><button className="new-chat-button" disabled={replying} onClick={startNewConversation}>＋ 新对话</button><button className="header-more" onClick={deleteCurrentConversation}>删除</button></header>{showAssign && <div className="assign-popover">{assignMatches.length ? assignMatches.map((m) => { const e = employees.find((x) => x.id === m.employeeId); return <button key={m.employeeId} onClick={() => { setShowAssign(false); openChat(m.employeeId); }}><strong>{e?.name ?? m.employeeId}</strong><span>命中：{m.keywords.join('、')}</span></button>; }) : <p className="assign-empty">未匹配到专家，可去通讯录「决策线」补充关键词</p>}</div>}<div className="message-area">{selectedThread.map((item, index) => { const message = item.m; const label = item.label; const showDivider = index === 0 || label !== selectedThread[index - 1].label; return <div key={message.id}>{showDivider && <div className="day-divider"><span>{label}</span></div>}{item.i === contextStarts[selected.id] && <div className="context-divider"><span>新的对话 · 已重置上下文</span></div>}<div className={`message-row ${message.sender === 'me' ? 'mine' : ''}`}>{message.sender === 'employee' && <Avatar employee={selected} compact />}<div><div className={`message-bubble ${message.sender === 'employee' ? 'formatted' : ''}`}>{message.tracePending ? <div className="trace-pending"><i /><i /><i /><span>{selected.name} 正在思考…</span></div> : message.sender === 'employee' ? <FormattedMessage text={message.text} onAt={openChatByName} /> : message.text}</div><AttachmentChips attachments={message.attachments} />{message.trace?.action === 'delegate' ? <RunTraceCard trace={message.trace} /> : null}<time>{msgTimeInfo(message.time).time}</time>{message.sender === 'employee' && message.tokens ? <span className="msg-tokens" title={`本次回复约消耗 ${message.tokens} tokens`}>ℹ {message.tokens}</span> : null}</div></div></div>; })}{contextStarts[selected.id] === (messages[selected.id] || []).length && <div className="context-divider"><span>新的对话 · 已重置上下文</span></div>}{replying && <div className="message-row"><Avatar employee={selected} compact /><div className="thinking-bubble"><i /><i /><i /></div></div>}{aiError && <button className="ai-error" onClick={() => setAiError('')}>{aiError} · 点击关闭</button>}<div ref={messageEndRef} /></div><div className="composer"><div className="composer-tools"><button type="button" title="添加附件" disabled={replying || uploading} onClick={() => fileInputRef.current?.click()}>＋</button><button>☺</button><span>与 {selected.name} 对话 · 当前上下文 {Math.max(0, (messages[selected.id] || []).length - (contextStarts[selected.id] || 0))} 条</span></div><AttachmentDraftList attachments={draftAttachments} onRemove={(id) => removeDraftAttachment(false, id)} /><textarea value={draft} disabled={replying} onChange={(e) => setDraft(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); void send(); } }} placeholder={replying ? `${selected.name} 正在思考…` : '输入消息…'} rows={3} /><div className="composer-footer"><span>Enter 发送 · Shift + Enter 换行</span><button onClick={() => void send()} disabled={(!draft.trim() && !draftAttachments.length) || replying || uploading}>{replying ? '思考中' : '发送'}</button></div></div></>}{activeGroup && (() => { const memberEmployees = activeGroup.members.map((id) => employees.find((e) => e.id === id)).filter((e): e is Employee => !!e); const gThread = sortMsgsByTime(groupMessages[activeGroup.id] || []); const mentionQuery = groupDraft.match(/@([^@\s]*)$/)?.[1] ?? ''; const mentionOptions = memberEmployees.filter((m) => !mentionQuery || m.name.toLowerCase().includes(mentionQuery.toLowerCase())); return <><header className="chat-header"><button className="mobile-back" onClick={() => setMobileConversation(false)}>‹</button><div className="group-avatar">{memberEmployees.slice(0, 4).map((m) => <span key={m.id} style={{ background: m.color }}>{m.initials.slice(0, 1)}</span>)}</div><div><h2>{activeGroup.name}</h2><p>{memberEmployees.length} 位成员 · 回复时 @ 名字可指派</p></div><button className="employee-info-button" onClick={() => setShowGroupInfo(true)}>群成员</button><button className="header-more" onClick={deleteCurrentConversation}>删除群</button></header>{groupNotice && <div className="group-notice">{groupNotice}</div>}<div className="message-area">{gThread.map((item, index) => { const message = item.m; const label = item.label; const showDivider = index === 0 || label !== gThread[index - 1].label; return <div key={message.id}>{showDivider && <div className="day-divider"><span>{label}</span></div>}<div className={`message-row ${message.sender === 'me' ? 'mine' : ''}`}>{message.sender === 'employee' && (() => { const sender = memberEmployees.find((m) => m.name === message.senderName); return <div className="group-msg-avatar" style={{ background: sender?.color }}>{sender?.initials?.slice(0, 1) || '?'}</div>; })()}<div><div className={`message-bubble ${message.sender === 'employee' ? 'formatted' : ''}`}>{message.sender === 'employee' ? <FormattedMessage text={message.text} onAt={openChatByName} /> : inlineFormat(message.text)}</div><AttachmentChips attachments={message.attachments} /><time>{msgTimeInfo(message.time).time}{message.sender === 'employee' && message.senderName ? ` · ${message.senderName}` : ''}</time>{message.sender === 'employee' && message.tokens ? <span className="msg-tokens" title={`本次回复约消耗 ${message.tokens} tokens`}>ℹ {message.tokens}</span> : null}</div></div></div>; })}{groupReplying && <div className="message-row"><div className="thinking-bubble"><i /><i /><i /></div></div>}{groupAiError && <button className="ai-error" onClick={() => setGroupAiError('')}>{groupAiError} · 点击关闭</button>}<div ref={messageEndRef} /></div><div className="composer group-composer">{groupMentionOpen && mentionOptions.length > 0 && <div className="mention-menu" role="listbox" aria-label="选择群成员">{mentionOptions.map((member, index) => <button key={member.id} type="button" className={index === groupMentionIndex ? 'active' : ''} onMouseDown={(e) => { e.preventDefault(); insertGroupMention(member.name); }}><span style={{ background: member.color }}>{member.initials.slice(0, 1)}</span><strong>@{member.name}</strong><small>{member.role}</small></button>)}</div>}<div className="composer-tools"><button type="button" title="添加附件" disabled={groupReplying || uploading} onClick={() => fileInputRef.current?.click()}>＋</button><button>☺</button><span>群「{activeGroup.name}」 · @名字 指定某人回答</span></div><AttachmentDraftList attachments={groupDraftAttachments} onRemove={(id) => removeDraftAttachment(true, id)} /><textarea ref={groupInputRef} value={groupDraft} disabled={groupReplying} onChange={(e) => { setGroupDraft(e.target.value); setGroupMentionOpen(/@[^@\s]*$/.test(e.target.value.slice(0, e.target.selectionStart))); setGroupMentionIndex(0); }} onKeyDown={(e) => { if (groupMentionOpen && mentionOptions.length) { if (e.key === 'ArrowDown') { e.preventDefault(); setGroupMentionIndex((i) => (i + 1) % mentionOptions.length); return; } if (e.key === 'ArrowUp') { e.preventDefault(); setGroupMentionIndex((i) => (i - 1 + mentionOptions.length) % mentionOptions.length); return; } if (e.key === 'Enter' || e.key === 'Tab') { e.preventDefault(); insertGroupMention(mentionOptions[groupMentionIndex]?.name || mentionOptions[0].name); return; } if (e.key === 'Escape') { e.preventDefault(); setGroupMentionOpen(false); return; } } if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); void sendGroup(); } }} placeholder={groupReplying ? '回复生成中…' : `输入 @ 选择群成员，或直接提问…`} rows={3} /><div className="composer-footer"><span>Enter 发送 · Shift + Enter 换行</span><button onClick={() => void sendGroup()} disabled={(!groupDraft.trim() && !groupDraftAttachments.length) || groupReplying || uploading}>{groupReplying ? '思考中' : '发送'}</button></div></div></>; })()}</section>
    </> : view === 'org' ? <section className="org-panel"><header className="org-header"><div><span className="eyebrow">COMPANY DIRECTORY</span><h1>组织架构</h1><p>{employees.length} 位员工 · {orgNodes.length} 个架构节点 · 点击左侧节点/成员查看详情</p></div><div className="org-header-actions"><span className={`db-pill ${dbStatus === 'connected' ? 'on' : 'off'}`}>{dbStatus === 'connected' ? '云端同步' : '本地模式'}</span><button className="decision-edit" onClick={() => setShowDecisionLine(true)}>决策线配置</button></div></header><OrgDirectory employees={employees} profiles={profiles} orgNodes={orgNodes} decisionDispatcher={decisionDispatcher} employeeModels={employeeModels} chatModel={chatModel} onSetEmployeeModel={setEmployeeModel} onOpenChat={openChat} onOpenDecisionLine={() => setShowDecisionLine(true)} onSaveProfile={async (id, p) => { if (dbStatus === 'connected') await pushProfile(id, p); setProfiles((cur) => ({ ...cur, [id]: p })); }} selectedOrgNodeId={selectedOrgNodeId} setSelectedOrgNodeId={setSelectedOrgNodeId} selectedOrgMemberId={selectedOrgMemberId} setSelectedOrgMemberId={setSelectedOrgMemberId} /></section> : <DecisionConfigPanel employees={employees} decisionLine={decisionLine} setDecisionLine={setDecisionLine} dbStatus={dbStatus} />}
    <nav className="mobile-nav"><NavButton active={view === 'chat'} label="消息" icon="chat" onClick={() => { setView('chat'); setMobileConversation(false); }} /><NavButton active={view === 'org'} label="通讯录" icon="org" onClick={() => setView('org')} /><NavButton active={view === 'decision'} label="决策线" icon="decision" onClick={() => setView('decision')} /></nav>
    {showEmployeeInfo && selected && <EmployeeInfoModal employee={selected} profiles={profiles} onClose={() => setShowEmployeeInfo(false)} />}
    {showDecisionLine && <DecisionLineModal employees={employees} decisionLine={decisionLine} setDecisionLine={setDecisionLine} onClose={() => setShowDecisionLine(false)} />}
    {showNewGroup && <NewGroupModal employees={employees} onCreate={createGroup} onClose={() => setShowNewGroup(false)} />}
    {showGroupInfo && activeGroup && <GroupInfoModal group={activeGroup} employees={employees} onRemove={removeGroupMember} onAdd={addGroupMember} onRename={renameGroup} onClose={() => setShowGroupInfo(false)} />}
  </main>;
}
function Avatar({ employee, compact = false }: { employee: Employee; compact?: boolean }) { return <div className={`avatar ${compact ? 'compact' : ''}`} style={{ background: employee.color }}>{employee.initials}<i className={employee.online ? 'online' : ''} /></div>; }
function NavButton({ active, label, icon, onClick }: { active: boolean; label: string; icon: 'chat' | 'org' | 'decision'; onClick: () => void }) { return <button className={`nav-button ${active ? 'active' : ''}`} onClick={onClick}>{icon === 'chat' ? <ChatIcon /> : icon === 'org' ? <OrgIcon /> : <DecisionIcon />}<span>{label}</span></button>; }
function RunTraceCard({ trace }: { trace: RunTrace }) {
  const [expanded, setExpanded] = useState<string | null>(null);
  const actionLabel = trace.action === 'delegate' ? '委派' : trace.action === 'ask' ? '追问' : '直接回答';
  const steps = trace.assignments.length
    ? trace.assignments.map((a) => ({ agentId: a.agentId, name: a.name, task: a.task, child: trace.childRuns.find((c) => c.agentId === a.agentId) }))
    : trace.childRuns.map((c) => ({ agentId: c.agentId, name: c.name, task: '', child: c }));
  return <div className="run-trace">
    <div className="run-trace-head"><span className="run-trace-badge">协作过程</span><span className="run-trace-action">{actionLabel} · {steps.length} 位员工</span>{trace.usage.totalTokens ? <span className="run-trace-tokens">{trace.usage.totalTokens} tokens</span> : null}</div>
    {trace.reason && <p className="run-trace-reason">规划理由：{trace.reason}</p>}
    <ol className="run-trace-steps">{steps.map((s, i) => { const done = s.child?.status === 'succeeded'; const failed = s.child?.status === 'failed'; const open = expanded === s.agentId; return <li key={i} className={`run-trace-step ${failed ? 'failed' : ''}`}><div className="run-trace-step-head" onClick={() => setExpanded(open ? null : s.agentId)}><span className={`run-trace-dot ${done ? 'ok' : failed ? 'err' : ''}`} /><strong>{s.name}</strong><span className="run-trace-status">{done ? '已完成' : failed ? '执行失败' : '进行中'}</span>{s.child && <button className="run-trace-toggle">{open ? '收起思考' : '查看思考'}</button>}</div>{open && <div className="run-trace-body">{s.task && <p className="run-trace-task">任务：{s.task}</p>}{s.child?.outputText ? <pre className="run-trace-think">{s.child.outputText}</pre> : s.child?.errorText ? <pre className="run-trace-think error">{s.child.errorText}</pre> : <p className="run-trace-empty">（暂无输出）</p>}</div>}</li>; })}</ol>
  </div>;
}
function EmployeeInfoModal({ employee, profiles, onClose }: { employee: Employee; profiles: Record<string, EmployeeProfile>; onClose: () => void }) { const profile = getEmployeeProfile(employee, profiles); return <div className="modal-backdrop" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}><section className="employee-info-modal"><header><div className="employee-info-title"><Avatar employee={employee} /><div><span className="eyebrow">EMPLOYEE PROFILE</span><h2>{employee.name}</h2><p>{employee.role} · {employee.department}</p></div></div><button onClick={onClose}>×</button></header><p className="employee-info-summary">{profile.summary}</p><section className="profile-section skills-section"><h3>Skill 能力</h3>{profile.skills.length ? <ul>{profile.skills.map((skill) => <li key={skill.name}>{skill.desc ? <><strong>{skill.name}</strong><span>{skill.desc}</span></> : skill.name}</li>)}</ul> : <p className="skills-empty">暂无，待补充</p>}</section><div className="employee-info-grid"><section className="profile-section strengths"><h3>优点</h3><ul>{profile.strengths.map((item) => <li key={item}>{item}</li>)}</ul></section><section className="profile-section weaknesses"><h3>需要注意</h3><ul>{profile.weaknesses.map((item) => <li key={item}>{item}</li>)}</ul></section><section className="profile-section best-for"><h3>适合做什么</h3><ul>{profile.bestFor.map((item) => <li key={item}>{item}</li>)}</ul></section></div><footer><div className="trait-list">{profile.traits.map((trait) => <span key={trait}>{trait}</span>)}</div><button className="primary-action" onClick={onClose}>返回对话</button></footer></section></div>; }
function DecisionLineModal({ employees, decisionLine, setDecisionLine, onClose }: { employees: Employee[]; decisionLine: DecisionLine; setDecisionLine: (v: DecisionLine) => void; onClose: () => void }) { const [draft, setDraft] = useState<DecisionLine>(decisionLine); const updateNode = (index: number, patch: Partial<DecisionNode>) => setDraft((d) => ({ ...d, nodes: d.nodes.map((n, i) => (i === index ? { ...n, ...patch } : n)) })); const removeNode = (index: number) => setDraft((d) => ({ ...d, nodes: d.nodes.filter((_, i) => i !== index) })); const addNode = () => setDraft((d) => ({ ...d, nodes: [...d.nodes, { employeeId: employees[0]?.id || '', domain: '', keywords: [] }] })); return <div className="modal-backdrop" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}><section className="decision-line-modal"><header><div><span className="eyebrow">DECISION LINE</span><h2>决策线配置</h2><p>调度者解析问题后，按关键词分派给对应专家处理</p></div><button onClick={onClose}>×</button></header><div className="dl-field"><label>调度者（负责解析与分派）</label><select value={draft.dispatcherId} onChange={(e) => setDraft((d) => ({ ...d, dispatcherId: e.target.value }))}>{employees.map((e) => <option key={e.id} value={e.id}>{e.name}</option>)}</select></div><div className="dl-nodes">{draft.nodes.map((node, index) => <div className="dl-node" key={index}><select value={node.employeeId} onChange={(e) => updateNode(index, { employeeId: e.target.value })}>{employees.map((e) => <option key={e.id} value={e.id}>{e.name}</option>)}</select><input value={node.domain} placeholder="专业领域（如：财务分析 · 风险控制）" onChange={(e) => updateNode(index, { domain: e.target.value })} /><input value={node.keywords.join(',')} placeholder="路由关键词，逗号分隔（如：预算,投资,成本）" onChange={(e) => updateNode(index, { keywords: e.target.value.split(/[,，]/).map((s) => s.trim()).filter(Boolean) })} /><button className="dl-remove" onClick={() => removeNode(index)}>删除</button></div>)}</div><div className="dl-actions"><button className="dl-add" onClick={addNode}>＋ 添加专家</button><button className="primary-action" onClick={() => { setDecisionLine(draft); onClose(); }}>保存配置</button></div></section></div>; }
function NewGroupModal({ employees, onCreate, onClose }: { employees: Employee[]; onCreate: (name: string, memberIds: string[]) => void; onClose: () => void }) { const [name, setName] = useState(''); const [selected, setSelected] = useState<string[]>([]); const toggle = (id: string) => setSelected((cur) => (cur.includes(id) ? cur.filter((x) => x !== id) : [...cur, id])); return <div className="modal-backdrop" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}><section className="new-group-modal"><header><div><span className="eyebrow">GROUP</span><h2>新建群聊</h2><p>选成员，之后可在群里 @ 提问、AI 回复会自动拉人进群</p></div><button onClick={onClose}>×</button></header><div className="dl-field"><label>群名称</label><input value={name} onChange={(e) => setName(e.target.value)} placeholder="如：收购评估小组" /></div><div className="ng-members">{employees.map((e) => <label key={e.id} className="ng-member"><input type="checkbox" checked={selected.includes(e.id)} onChange={() => toggle(e.id)} /><Avatar employee={e} compact /><span>{e.name}</span><em>{e.role}</em></label>)}</div><div className="dl-actions"><button className="dl-add" onClick={onClose}>取消</button><button className="primary-action" disabled={!selected.length} onClick={() => onCreate(name, selected)}>创建群（{selected.length} 人）</button></div></section></div>; }
function GroupInfoModal({ group, employees, onRemove, onAdd, onRename, onClose }: { group: Group; employees: Employee[]; onRemove: (memberId: string) => void; onAdd: (memberId: string) => void; onRename: (groupId: string, name: string) => void; onClose: () => void }) { const [adding, setAdding] = useState(false); const candidates = employees.filter((e) => !group.members.includes(e.id)); return <div className="modal-backdrop" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}><section className="group-info-modal"><header><div><span className="eyebrow">GROUP</span><input className="gi-name-input" value={group.name} aria-label="群名称" onChange={(e) => onRename(group.id, e.target.value)} /><p>{group.members.length} 位成员 · AI 回复 @ 的人会自动拉进群</p></div><button onClick={onClose}>×</button></header><div className="gi-members">{group.members.map((id) => { const e = employees.find((x) => x.id === id); return <div className="gi-member" key={id}>{e && <Avatar employee={e} compact />}<span>{e?.name ?? id}</span><em>{e?.role}</em><button className="dl-remove" onClick={() => onRemove(id)}>移出</button></div>; })}</div>{adding && <div className="gi-add">{candidates.length ? candidates.map((e) => <button className="gi-add-item" key={e.id} onClick={() => onAdd(e.id)}><Avatar employee={e} compact /><span>{e.name}</span><em>{e.role}</em><b>＋</b></button>) : <p className="assign-empty">所有员工都已在群里了</p>}</div>}<div className="dl-actions"><button className="dl-add" onClick={() => setAdding((v) => !v)}>{adding ? '收起' : '＋ 添加成员'}</button><button className="primary-action" onClick={onClose}>完成</button></div></section></div>; }
function FormattedMessage({ text, onAt }: { text: string; onAt?: (name: string) => void }) { const lines = text.split(/\r?\n/); const blocks: Array<{ type: 'table'; rows: string[] } | { type: 'line'; line: string }> = []; for (let i = 0; i < lines.length; i++) { const line = lines[i].trim(); const next = lines[i + 1] ? lines[i + 1].trim() : ''; if (line.startsWith('|') && /^\|[\s:|-]+\|?$/.test(next)) { const rows: string[] = [line]; i++; while (i < lines.length && lines[i].trim().startsWith('|')) { rows.push(lines[i].trim()); i++; } i--; blocks.push({ type: 'table', rows }); } else { blocks.push({ type: 'line', line: lines[i] }); } } return <div className="rich-message">{blocks.map((block, bi) => { if (block.type === 'table') { const rows = block.rows.map((r) => r.replace(/^\|/, '').replace(/\|$/, '').split('|').map((c) => c.trim())); const header = rows[0] || []; const body = rows.slice(2); return <div className="rich-table" key={bi}><table><thead><tr>{header.map((c, ci) => <th key={ci}>{inlineFormat(c, onAt)}</th>)}</tr></thead>{body.length ? <tbody>{body.map((row, ri) => <tr key={ri}>{row.map((c, ci) => <td key={ci}>{inlineFormat(c, onAt)}</td>)}</tr>)}</tbody> : null}</table></div>; } const clean = block.line.trim(); if (!clean) return <span className="rich-space" key={bi} />; if (/^#{1,3}\s/.test(clean)) return <h3 key={bi}>{inlineFormat(clean.replace(/^#{1,3}\s+/, ''), onAt)}</h3>; const bullet = clean.match(/^[-*]\s+(.+)/); if (bullet) return <div className="rich-list" key={bi}><i>•</i><span>{inlineFormat(bullet[1], onAt)}</span></div>; const numbered = clean.match(/^(\d+)[.、]\s*(.+)/); if (numbered) return <div className="rich-list" key={bi}><i>{numbered[1]}.</i><span>{inlineFormat(numbered[2], onAt)}</span></div>; return <p key={bi}>{inlineFormat(clean, onAt)}</p>; })}</div>; }
function inlineFormat(text: string, onAt?: (name: string) => void): ReactNode[] { return text.split(/(\*\*[^*]+\*\*|`[^`]+`|@[\u4e00-\u9fa5A-Za-z0-9_]+|!\[[^\]]*\]\([^)]+\)|\[[^\]]*\]\([^)]+\))/g).filter(Boolean).map((part, index) => { if (part.startsWith('**') && part.endsWith('**')) return <strong key={index}>{part.slice(2, -2)}</strong>; if (part.startsWith('`') && part.endsWith('`')) return <code key={index}>{part.slice(1, -1)}</code>; if (part.startsWith('@') && part.length > 1) return onAt ? <button className="at-chip" key={index} onClick={() => onAt(part.slice(1))}>{part}</button> : <span className="at-chip" key={index}>{part}</span>; if (part.startsWith('![')) { const m = part.match(/^!\[([^\]]*)\]\(([^)]+)\)$/); if (m && /^https?:\/\//i.test(m[2])) return <Image key={index} className="rich-img" src={m[2]} alt={m[1]} width={720} height={405} unoptimized onClick={() => window.open(m[2], '_blank')} />; } if (part.startsWith('[')) { const m = part.match(/^\[([^\]]*)\]\(([^)]+)\)$/); if (m && /^https?:\/\//i.test(m[2])) return <a key={index} className="rich-link" href={m[2]} target="_blank" rel="noopener noreferrer">{m[1]}</a>; } return part; }); }
function ChatIcon() { return <svg viewBox="0 0 24 24"><path d="M5 5.8h14v9.4H9l-4 3v-12.4Z" /></svg>; }
function OrgIcon() { return <svg viewBox="0 0 24 24"><circle cx="12" cy="6" r="2.5" /><circle cx="6" cy="17" r="2.5" /><circle cx="18" cy="17" r="2.5" /><path d="M12 8.5v4M6 14.5v-2h12v2" /></svg>; }
function DecisionIcon() { return <svg viewBox="0 0 24 24"><path d="M12 3l9 9-9 9-9-9 9-9Z" /><path d="M12 8.5v7M8.5 12h7" /></svg>; }
function SearchIcon() { return <svg viewBox="0 0 24 24"><circle cx="11" cy="11" r="6" /><path d="m16 16 4 4" /></svg>; }

function OrgDirectory({ employees, profiles, orgNodes, decisionDispatcher, employeeModels, chatModel, onSetEmployeeModel, onOpenChat, onOpenDecisionLine, onSaveProfile, selectedOrgNodeId, setSelectedOrgNodeId, selectedOrgMemberId, setSelectedOrgMemberId }: { employees: Employee[]; profiles: Record<string, EmployeeProfile>; orgNodes: OrgNode[]; decisionDispatcher: Employee; employeeModels: Record<string, ChatModel>; chatModel: ChatModel; onSetEmployeeModel: (employeeId: string, model: ChatModel | null) => void; onOpenChat: (id: string) => void; onOpenDecisionLine: () => void; onSaveProfile: (employeeId: string, profile: EmployeeProfile) => Promise<void>; selectedOrgNodeId: string | null; setSelectedOrgNodeId: (id: string | null) => void; selectedOrgMemberId: string | null; setSelectedOrgMemberId: (id: string | null) => void; }) {
  const roots = orgNodes.filter((n) => !n.parentId);
  const childrenOf = (parentId: string) => orgNodes.filter((n) => n.parentId === parentId);
  const membersOf = (node: OrgNode) => node.department ? employees.filter((e) => e.department === node.department) : [];
  const selectedNode = selectedOrgNodeId ? orgNodes.find((n) => n.id === selectedOrgNodeId) ?? null : null;
  const selectedMember = selectedOrgMemberId ? employees.find((e) => e.id === selectedOrgMemberId) ?? null : null;
  const selectNode = (id: string) => { setSelectedOrgNodeId(id); setSelectedOrgMemberId(null); };
  const selectMember = (id: string) => { setSelectedOrgMemberId(id); };
  const renderNode = (node: OrgNode, depth: number): ReactNode => {
    const members = membersOf(node);
    const kids = childrenOf(node.id);
    const isActive = selectedOrgNodeId === node.id;
    return <div className="org-node" key={node.id}>
      <button className={`org-node-row ${isActive ? 'active' : ''}`} style={{ paddingLeft: 10 + depth * 20 }} onClick={() => selectNode(node.id)}><span className="org-node-icon">{node.id === 'root' ? '🏢' : '▤'}</span><span className="org-node-name">{node.name}</span><span className="org-node-count">{members.length}</span></button>
      {members.map((m) => <button key={m.id} className={`org-member-chip ${selectedOrgMemberId === m.id ? 'active' : ''}`} style={{ paddingLeft: 30 + depth * 20 }} onClick={() => selectMember(m.id)}><span className="org-member-dot" style={{ background: m.color }}>{m.initials.slice(0, 1)}</span>{m.name}{node.headEmployeeId === m.id ? <span className="member-head-tag">负责人</span> : null}</button>)}
      {kids.map((k) => renderNode(k, depth + 1))}
    </div>;
  };
  return <div className="org-layout">
    <aside className="org-tree-pane">
      <div className="org-tree-head"><span className="eyebrow">ORG CHART</span><button className="decision-edit" onClick={onOpenDecisionLine}>决策线配置</button></div>
      <div className="org-tree">{roots.map((n) => renderNode(n, 0))}</div>
      <div className="org-tree-foot">调度者：{decisionDispatcher.name} · 解析问题后按专业分派给对应专家</div>
    </aside>
    <section className="org-detail-pane">
      {selectedMember ? <EmployeeDetailCard key={selectedMember.id} employee={selectedMember} profile={getEmployeeProfile(selectedMember, profiles)} employeeModels={employeeModels} chatModel={chatModel} onSetEmployeeModel={onSetEmployeeModel} onSaveProfile={onSaveProfile} onOpenChat={onOpenChat} /> : selectedNode ? <OrgNodeDetail node={selectedNode} members={membersOf(selectedNode)} onSelectMember={selectMember} onOpenChat={onOpenChat} /> : <div className="org-detail-empty"><p>从左侧选择架构节点或成员查看详情</p></div>}
    </section>
  </div>;
}

function OrgNodeDetail({ node, members, onSelectMember, onOpenChat }: { node: OrgNode; members: Employee[]; onSelectMember: (id: string) => void; onOpenChat: (id: string) => void; }) {
  const [showAddMember, setShowAddMember] = useState(false);
  return <div className="org-node-detail">
    <header className="org-detail-header"><div className="org-detail-icon">▤</div><div><span className="eyebrow">ORG NODE</span><h2>{node.name}</h2><p>{members.length} 位成员</p></div></header>
    <section className="org-block"><h3>架构职责</h3><p className="org-node-desc">{node.description || '暂无职责说明'}</p></section>
    <section className="org-block"><div className="org-block-title"><h3>架构成员</h3>{node.department && <button className="org-add-member" onClick={() => setShowAddMember(true)}>＋ 添加成员</button>}</div><div className="org-member-list">{members.map((m) => <div className="org-member-item" key={m.id}><button className="org-member-main" onClick={() => onSelectMember(m.id)}><Avatar employee={m} compact /><div><strong>{m.name}</strong>{node.headEmployeeId === m.id ? <span className="member-head-tag">负责人</span> : null}<span>{m.role}</span></div></button><button className="org-go-chat" onClick={() => onOpenChat(m.id)}>去对话 →</button></div>)}{!members.length && <p className="org-empty">该节点暂无成员，点击右上角添加。</p>}</div></section>
    {showAddMember && node.department && <DepartmentMemberModal node={node} currentMemberIds={members.map((m) => m.id)} onClose={() => setShowAddMember(false)} />}
  </div>;
}

function DepartmentMemberModal({ node, currentMemberIds, onClose }: { node: OrgNode; currentMemberIds: string[]; onClose: () => void }) {
  const [mode, setMode] = useState<'existing' | 'new'>('new');
  const [employees, setEmployees] = useState<Employee[]>([]);
  const [name, setName] = useState('');
  const [role, setRole] = useState(node.id === 'recruiting' ? '招聘专员' : '部门成员');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => { const load = async () => { try { const response = await fetch('/api/employees'); const data = await response.json() as { employees?: Employee[] }; setEmployees(data.employees || []); } catch { setError('成员列表加载失败'); } }; void load(); }, []);
  const candidates = employees.filter((employee) => !currentMemberIds.includes(employee.id));
  const finish = () => { onClose(); window.location.reload(); };
  const addExisting = async (employeeId: string) => { setSaving(true); setError(''); try { await moveEmployee(employeeId, node.department || node.name); finish(); } catch (e) { setError(e instanceof Error ? e.message : '添加失败'); setSaving(false); } };
  const addNew = async () => {
    const cleanName = name.trim(); if (!cleanName) return;
    setSaving(true); setError('');
    const id = `employee_${crypto.randomUUID().replace(/-/g, '').slice(0, 12)}`;
    const colors = ['#3478f6', '#20b486', '#8b7cf6', '#ff7a45', '#d65db1'];
    const employee: Employee = { id, name: cleanName, role: role.trim() || '部门成员', department: node.department || node.name, initials: cleanName.slice(0, 2), color: colors[employees.length % colors.length], online: true };
    try { await createEmployee(employee); finish(); } catch (e) { setError(e instanceof Error ? e.message : '新增失败'); setSaving(false); }
  };
  return <div className="modal-backdrop" onMouseDown={(e) => { if (e.target === e.currentTarget && !saving) onClose(); }}><section className="department-member-modal"><header><div><span className="eyebrow">ADD MEMBER</span><h2>添加到{node.name}</h2><p>新建成员，或将现有成员调整到该部门</p></div><button onClick={onClose} disabled={saving}>×</button></header><div className="member-mode-tabs"><button className={mode === 'new' ? 'active' : ''} onClick={() => setMode('new')}>新建成员</button><button className={mode === 'existing' ? 'active' : ''} onClick={() => setMode('existing')}>选择现有成员</button></div>{mode === 'new' ? <div className="member-create-form"><label>姓名<input value={name} onChange={(e) => setName(e.target.value)} placeholder="请输入成员姓名" autoFocus /></label><label>职位<input value={role} onChange={(e) => setRole(e.target.value)} placeholder="如：招聘专员" /></label><button className="primary-action" disabled={!name.trim() || saving} onClick={() => void addNew()}>{saving ? '添加中…' : '确认添加'}</button></div> : <div className="department-candidates">{candidates.length ? candidates.map((employee) => <button key={employee.id} disabled={saving} onClick={() => void addExisting(employee.id)}><Avatar employee={employee} compact /><span><strong>{employee.name}</strong><small>{employee.role} · 当前在{employee.department}</small></span><b>加入</b></button>) : <p className="org-empty">暂无可添加的现有成员</p>}</div>}{error && <p className="member-add-error">{error}</p>}</section></div>;
}

function EmployeeDetailCard({ employee, profile, employeeModels, chatModel, onSetEmployeeModel, onSaveProfile, onOpenChat }: { employee: Employee; profile: EmployeeProfile; employeeModels: Record<string, ChatModel>; chatModel: ChatModel; onSetEmployeeModel: (employeeId: string, model: ChatModel | null) => void; onSaveProfile: (employeeId: string, profile: EmployeeProfile) => Promise<void>; onOpenChat: (id: string) => void; }) {
  const [editing, setEditing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState('');
  const [draft, setDraft] = useState<EmployeeProfile>(profile);
  const lastProfileRef = useRef<string>('');
  // Skill 长文本编辑状态（Phase 0）
  const [skillName, setSkillName] = useState('');
  const [skillDescription, setSkillDescription] = useState('');
  const [skillDesc, setSkillDesc] = useState('');
  const [expandedSkill, setExpandedSkill] = useState<number | null>(null);
  const [editingSkillIdx, setEditingSkillIdx] = useState<number | null>(null);
  const [editSkillName, setEditSkillName] = useState('');
  const [editSkillDescription, setEditSkillDescription] = useState('');
  const [editSkillDesc, setEditSkillDesc] = useState('');
  const SKILL_MAX = 200_000;
  useEffect(() => { const json = JSON.stringify(profile); if (lastProfileRef.current !== json) { lastProfileRef.current = json; setDraft(profile); } }, [profile]);
  const update = (patch: Partial<EmployeeProfile>) => setDraft((d) => ({ ...d, ...patch }));
  const addItem = (key: 'strengths' | 'weaknesses' | 'keywords' | 'notGoodAt' | 'career', value: string) => { const v = value.trim(); if (!v) return; update({ [key]: [...(draft[key] || []), v] } as Partial<EmployeeProfile>); };
  const removeItem = (key: 'strengths' | 'weaknesses' | 'keywords' | 'notGoodAt' | 'career', index: number) => update({ [key]: (draft[key] || []).filter((_, i) => i !== index) } as Partial<EmployeeProfile>);
  const addSkill = (name: string, description: string, desc: string) => { const n = name.trim(); if (!n) return; update({ skills: [...(draft.skills || []), { name: n, description: description.trim(), desc: desc.trim() }] }); };
  const startEditSkill = (i: number) => { const s = (draft.skills || [])[i]; if (!s) return; setEditingSkillIdx(i); setEditSkillName(s.name); setEditSkillDescription(s.description || ''); setEditSkillDesc(s.desc); };
  const saveSkillEdit = () => { if (editingSkillIdx === null) return; const n = editSkillName.trim(); if (!n) return; const skills = [...(draft.skills || [])]; skills[editingSkillIdx] = { name: n, description: editSkillDescription.trim(), desc: editSkillDesc.trim() }; update({ skills }); setEditingSkillIdx(null); };
  const submitNewSkill = () => { const n = skillName.trim(); if (!n || skillDesc.length > SKILL_MAX) return; addSkill(n, skillDescription, skillDesc); setSkillName(''); setSkillDescription(''); setSkillDesc(''); };
  const saveProfile = async () => {
    setSaving(true); setSaveError('');
    try { await onSaveProfile(employee.id, { ...draft }); setEditing(false); }
    catch (error) { setSaveError(error instanceof Error ? error.message : '档案保存失败'); }
    finally { setSaving(false); }
  };
  const chips = (key: 'strengths' | 'weaknesses' | 'keywords' | 'notGoodAt', label: string) => (
    <section className="emp-block" key={key}>
      <h3>{label}</h3>
      <div className="emp-chips">{((draft[key] as string[]) || []).map((v, i) => <span className="emp-chip" key={i}>{v}{editing && <i className="emp-chip-rm" onClick={() => removeItem(key, i)}>×</i>}</span>)}</div>
      {editing && <div className="emp-add-row"><input className="emp-add-input" placeholder={`添加${label}…`} onKeyDown={(e) => { if (e.key === 'Enter') { addItem(key, e.currentTarget.value); e.currentTarget.value = ''; } }} /><button className="emp-add-btn" onClick={(e) => { const input = e.currentTarget.previousElementSibling as HTMLInputElement; addItem(key, input.value); input.value = ''; }}>＋</button></div>}
    </section>
  );
  return <div className="emp-detail">
    <header className="emp-detail-header">
      <Avatar employee={employee} />
      <div className="emp-title"><span className="eyebrow">EMPLOYEE PROFILE</span><h2>{employee.name}</h2><p>{employee.role} · {employee.department} {employee.online ? '· 在线' : '· 离线'}</p></div>
      <div className="emp-header-actions">
        <button className="emp-chat-btn" onClick={() => onOpenChat(employee.id)}>去对话</button>
        {editing ? <><button className="emp-save-btn" onClick={saveProfile} disabled={saving}>{saving ? '保存中…' : '保存档案'}</button><button className="emp-edit-btn" onClick={() => setEditing(false)} disabled={saving}>取消</button></> : <button className="emp-edit-btn" onClick={() => setEditing(true)}>编辑档案</button>}
      </div>
    </header>
    {saveError && <p className="emp-empty">保存失败：{saveError}</p>}
    <p className="emp-summary">{draft.summary}</p>
    <section className="emp-block basic">
      <h3>基本信息</h3>
      <div className="emp-basic-grid">
        <div className="emp-basic-item"><span>姓名</span><strong>{employee.name}</strong></div>
        <div className="emp-basic-item"><span>国籍</span>{editing ? <input className="emp-input" value={draft.nationality || ''} onChange={(e) => update({ nationality: e.target.value })} /> : <strong>{draft.nationality || '—'}</strong>}</div>
        <div className="emp-basic-item"><span>年龄</span>{editing ? <input className="emp-input" type="number" value={draft.age === '' || draft.age === undefined ? '' : String(draft.age)} onChange={(e) => update({ age: e.target.value === '' ? '' : Number(e.target.value) })} /> : <strong>{draft.age || '—'}</strong>}</div>
      </div>
    </section>
    <section className="emp-block set">
      <h3>员工设定</h3>
      <div className="emp-set-row"><span className="emp-set-label">擅长做什么</span>{editing ? <input className="emp-input wide" value={draft.expertise || ''} onChange={(e) => update({ expertise: e.target.value })} /> : <strong className="emp-set-value">{draft.expertise || '—'}</strong>}</div>
      <div className="emp-set-row"><span className="emp-set-label">对话模型</span>{editing ? <select className="emp-input wide" value={employeeModels[employee.id] ?? ''} onChange={(e) => onSetEmployeeModel(employee.id, e.target.value === 'kimi' || e.target.value === 'deepseek' ? e.target.value : null)}><option value="">跟随全局（{chatModel === 'kimi' ? 'Kimi' : 'DS V4'}）</option><option value="kimi">Kimi</option><option value="deepseek">DS V4</option></select> : <strong className="emp-set-value">{employeeModels[employee.id] === 'kimi' ? 'Kimi' : employeeModels[employee.id] === 'deepseek' ? 'DS V4' : `跟随全局（${chatModel === 'kimi' ? 'Kimi' : 'DS V4'}）`}</strong>}</div>
    </section>
    {chips('strengths', '优点')}
    {chips('weaknesses', '缺点')}
    {chips('keywords', '关键词')}
    {chips('notGoodAt', '不擅长做什么')}
    <section className="emp-block skills">
      <h3>员工 Skill</h3>
      {(draft.skills || []).length ? <ul className="emp-skill-list">{(draft.skills || []).map((s, i) => editingSkillIdx === i ? (
        <li key={i} className="emp-skill-edit">
          <input className="emp-add-input" value={editSkillName} onChange={(e) => setEditSkillName(e.target.value)} placeholder="Skill 名称" />
          <input className="emp-add-input" value={editSkillDescription} onChange={(e) => setEditSkillDescription(e.target.value)} placeholder="Skill 描述（一句话说明用途）" maxLength={300} />
          <textarea className="emp-add-input skill-textarea" rows={6} value={editSkillDesc} onChange={(e) => { if (e.target.value.length <= SKILL_MAX) setEditSkillDesc(e.target.value); }} placeholder="能力说明（支持 Markdown，最多 200,000 字）" />
          <div className="emp-skill-meta"><span>{editSkillDesc.length} 字 · 约 {Math.ceil(editSkillDesc.length / 1.8)} tokens</span><span><button className="emp-save-btn" onClick={saveSkillEdit}>应用修改</button><button className="emp-edit-btn" onClick={() => setEditingSkillIdx(null)}>取消</button></span></div>
        </li>
      ) : (
        <li key={i} onClick={() => setExpandedSkill(expandedSkill === i ? null : i)}>
          <strong>{s.name}</strong>
          {s.description && <span className="emp-skill-summary">{s.description}</span>}
          {s.desc && <span className={expandedSkill === i ? 'expanded' : 'collapsed'}>{expandedSkill === i ? s.desc : `${s.desc.slice(0, 60)}${s.desc.length > 60 ? '…（点击展开）' : ''}`}</span>}
          {editing && <span className="emp-skill-actions"><i className="emp-chip-rm" title="编辑" onClick={(e) => { e.stopPropagation(); startEditSkill(i); }}>✎</i><i className="emp-chip-rm" title="删除" onClick={(e) => { e.stopPropagation(); update({ skills: (draft.skills || []).filter((_, j) => j !== i) }); }}>×</i></span>}
        </li>
      ))}</ul> : <p className="emp-empty">暂空，待补充</p>}
      {editing && <div className="emp-skill-add">
        <input className="emp-add-input" value={skillName} onChange={(e) => setSkillName(e.target.value)} placeholder="Skill 名称（如：财务建模）" />
        <input className="emp-add-input" value={skillDescription} onChange={(e) => setSkillDescription(e.target.value)} placeholder="Skill 描述（一句话说明它解决什么问题）" maxLength={300} />
        <textarea className="emp-add-input skill-textarea" rows={8} value={skillDesc} onChange={(e) => { if (e.target.value.length <= SKILL_MAX) setSkillDesc(e.target.value); }} placeholder="详细能力说明：触发场景、执行步骤、输入输出、注意事项（支持 Markdown，最多 200,000 字）" />
        <div className="emp-skill-meta"><span>{skillDesc.length} 字 · 约 {Math.ceil(skillDesc.length / 1.8)} tokens{skillDesc.length >= SKILL_MAX ? ' · 已达上限' : ''}</span><button className="emp-add-btn" onClick={submitNewSkill} disabled={!skillName.trim()}>＋ 添加 Skill</button></div>
      </div>}
    </section>
    <section className="emp-block career">
      <h3>过往履历</h3>
      {(draft.career || []).length ? <ul className="emp-career-list">{draft.career!.map((c, i) => <li key={i}><span>{c}</span>{editing && <i className="emp-chip-rm" onClick={() => removeItem('career', i)}>×</i>}</li>)}</ul> : <p className="emp-empty">暂空，待补充</p>}
      {editing && <div className="emp-add-row"><input className="emp-add-input" placeholder="添加履历（如：2019-2023 XX公司 产品总监）" onKeyDown={(e) => { if (e.key === 'Enter') { addItem('career', e.currentTarget.value); e.currentTarget.value = ''; } }} /><button className="emp-add-btn" onClick={(e) => { const input = e.currentTarget.previousElementSibling as HTMLInputElement; addItem('career', input.value); input.value = ''; }}>＋</button></div>}
    </section>
  </div>;
}

function DecisionConfigPanel({ employees, decisionLine, setDecisionLine, dbStatus }: { employees: Employee[]; decisionLine: DecisionLine; setDecisionLine: Dispatch<SetStateAction<DecisionLine>>; dbStatus: 'local' | 'connected'; }) {
  const dispatcher = employees.find((e) => e.id === decisionLine.dispatcherId) ?? employees[0];
  const updateNode = (index: number, patch: Partial<DecisionNode>) => setDecisionLine((d) => ({ ...d, nodes: d.nodes.map((n, i) => (i === index ? { ...n, ...patch } : n)) }));
  const removeNode = (index: number) => setDecisionLine((d) => ({ ...d, nodes: d.nodes.filter((_, i) => i !== index) }));
  const addNode = () => setDecisionLine((d) => ({ ...d, nodes: [...d.nodes, { employeeId: employees[0]?.id || '', domain: '', keywords: [] }] }));
  const nameOf = (id: string) => employees.find((e) => e.id === id)?.name ?? id;
  return <section className="decision-panel">
    <header className="org-header">
      <div><span className="eyebrow">DECISION LINE</span><h1>决策线配置</h1><p>调度者解析问题后，按关键词把任务分派给对应专家处理 · 修改即时保存并同步</p></div>
      <div className="org-header-actions"><span className={`db-pill ${dbStatus === 'connected' ? 'on' : 'off'}`}>{dbStatus === 'connected' ? '云端同步' : '本地模式'}</span></div>
    </header>
    <section className="decision-card">
      <header><div><h2>当前决策线</h2><p>调度者：{dispatcher.name} · {decisionLine.nodes.length} 位专家按关键词路由</p></div></header>
      <div className="decision-flow">
        <div className="decision-node dispatcher"><strong>🎯 {dispatcher.name}</strong><span>调度者 · 解析与分派</span></div>
        {decisionLine.nodes.map((node, i) => <Fragment key={i}><i className="decision-arrow">→</i><div className="decision-node"><strong>{nameOf(node.employeeId)}</strong><span>{node.domain || '未设置领域'}</span></div></Fragment>)}
      </div>
    </section>
    <section className="decision-card">
      <header><div><h2>调度者</h2><p>负责解析问题并按专业分派给专家</p></div></header>
      <div className="dl-field"><label>调度者（负责解析与分派）</label><select value={decisionLine.dispatcherId} onChange={(e) => setDecisionLine((d) => ({ ...d, dispatcherId: e.target.value }))}>{employees.map((e) => <option key={e.id} value={e.id}>{e.name}</option>)}</select></div>
    </section>
    <section className="decision-card">
      <header><div><h2>专家节点</h2><p>用户消息命中关键词后，任务分派给对应专家</p></div><button className="decision-edit" onClick={addNode}>＋ 添加节点</button></header>
      <div className="dl-nodes">
        {decisionLine.nodes.map((node, index) => <div className="dl-node" key={index}>
          <select value={node.employeeId} onChange={(e) => updateNode(index, { employeeId: e.target.value })}>{employees.map((e) => <option key={e.id} value={e.id}>{e.name}</option>)}</select>
          <input value={node.domain} placeholder="专业领域（如：财务分析 · 风险控制）" onChange={(e) => updateNode(index, { domain: e.target.value })} />
          <input value={node.keywords.join(',')} placeholder="路由关键词，逗号分隔（如：预算,投资,成本）" onChange={(e) => updateNode(index, { keywords: e.target.value.split(/[,，]/).map((s) => s.trim()).filter(Boolean) })} />
          <button className="dl-remove" onClick={() => removeNode(index)}>删除</button>
        </div>)}
        {!decisionLine.nodes.length && <p className="org-empty">暂无专家节点，点击「＋ 添加节点」创建</p>}
      </div>
    </section>
    <section className="decision-card">
      <header><div><h2>使用说明</h2></div></header>
      <ul className="dl-help"><li>在与调度者（{dispatcher.name}）的对话中，系统会解析你的消息并命中关键词，把任务分派给对应专家。</li><li>调度者会在回复中 @ 对应专家；群聊中也会按此规则选择默认应答者。</li><li>修改即时生效：本地模式存入浏览器，云端同步状态下自动写入数据库。</li></ul>
    </section>
  </section>;
}
