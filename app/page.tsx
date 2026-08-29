'use client';

export { default } from './im-page';

import { useMemo, useState } from 'react';

const quickCommands = ['分析本季度的增长机会，并给出执行计划', '评估我的投资组合风险，提出调整建议', '为新项目制定预算和里程碑'];
const team = [
  { name: '马斯克', role: 'CEO · 中控大脑', initials: 'EM', color: 'from-orange-400 to-rose-500', note: '第一性原理 · 快速迭代 · 高密度决策' },
  { name: '巴菲特', role: '财务顾问', initials: 'WB', color: 'from-emerald-400 to-teal-600', note: '价值投资 · 安全边际 · 长期复利' },
];

// eslint-disable-next-line @typescript-eslint/no-unused-vars
function LegacyHome() {
  const [command, setCommand] = useState('');
  const [activeCommand, setActiveCommand] = useState('制定未来 90 天的业务增长计划');
  const [sent, setSent] = useState(false);
  const date = useMemo(() => new Intl.DateTimeFormat('zh-CN', { month: 'long', day: 'numeric', weekday: 'long' }).format(new Date()), []);
  const submit = () => { const value = command.trim(); if (!value) return; setActiveCommand(value); setCommand(''); setSent(true); };

  return (
    <main className="min-h-screen bg-[#080b12] text-white selection:bg-orange-400/40">
      <div className="mx-auto min-h-screen max-w-[1500px] px-4 py-4 sm:px-6 lg:px-8">
        <header className="flex items-center justify-between border-b border-white/10 pb-4">
          <div className="flex items-center gap-3"><div className="grid h-10 w-10 place-items-center rounded-2xl bg-gradient-to-br from-orange-400 to-rose-500 font-black text-black">M</div><div><p className="text-sm font-semibold tracking-[0.22em]">MYTEAM</p><p className="text-xs text-white/40">智能团队指挥中心</p></div></div>
          <div className="hidden items-center gap-2 text-xs text-white/50 sm:flex"><span className="h-2 w-2 rounded-full bg-emerald-400 shadow-[0_0_12px_#34d399]" />团队系统运行正常</div>
          <button className="rounded-xl border border-white/10 bg-white/5 px-4 py-2 text-sm text-white/70 transition hover:bg-white/10">设置</button>
        </header>

        <div className="grid gap-5 py-5 lg:grid-cols-[250px_minmax(0,1fr)_310px]">
          <aside className="rounded-3xl border border-white/10 bg-white/[0.035] p-4">
            <div className="mb-5 flex items-center justify-between"><p className="text-xs font-semibold uppercase tracking-[0.2em] text-white/40">我的团队</p><button className="grid h-7 w-7 place-items-center rounded-lg bg-white/10 text-lg text-white/60">+</button></div>
            <div className="space-y-3">{team.map((member, index) => <button key={member.name} className={`w-full rounded-2xl border p-3 text-left transition ${index === 0 ? 'border-orange-400/30 bg-orange-400/[0.08]' : 'border-white/5 bg-white/[0.025] hover:bg-white/[0.06]'}`}>
              <div className="flex items-center gap-3"><div className={`grid h-11 w-11 shrink-0 place-items-center rounded-2xl bg-gradient-to-br ${member.color} text-xs font-black text-black`}>{member.initials}</div><div className="min-w-0"><div className="flex items-center gap-2"><p className="font-semibold">{member.name}</p><span className="h-1.5 w-1.5 rounded-full bg-emerald-400" /></div><p className="truncate text-xs text-white/45">{member.role}</p></div></div>
              <p className="mt-3 text-[11px] leading-5 text-white/35">{member.note}</p></button>)}</div>
            <div className="mt-5 rounded-2xl border border-dashed border-white/10 p-4 text-center"><p className="text-sm text-white/45">扩展你的团队</p><p className="mt-1 text-xs text-white/25">添加运营、产品、法务等员工</p></div>
          </aside>

          <section className="min-w-0">
            <div className="mb-5 rounded-3xl border border-white/10 bg-[radial-gradient(circle_at_20%_0%,rgba(251,146,60,.16),transparent_40%),rgba(255,255,255,.035)] p-6 sm:p-8">
              <p className="text-sm text-white/40">{date}</p><h1 className="mt-3 text-3xl font-semibold tracking-tight sm:text-4xl">今天，我们要完成什么？</h1><p className="mt-3 max-w-2xl text-sm leading-6 text-white/45">把目标交给中控大脑。马斯克会用第一性原理拆解任务，并将专业工作分派给最合适的团队成员。</p>
              <div className="mt-7 rounded-2xl border border-white/10 bg-black/25 p-2 focus-within:border-orange-400/40"><textarea value={command} onChange={(e) => setCommand(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) submit(); }} rows={3} placeholder="输入你的总指令……" className="w-full resize-none bg-transparent px-3 py-3 text-base outline-none placeholder:text-white/20" /><div className="flex items-center justify-between px-2 pb-1"><span className="text-[11px] text-white/25">Ctrl + Enter 发送</span><button onClick={submit} className="rounded-xl bg-orange-400 px-5 py-2.5 text-sm font-semibold text-black transition hover:bg-orange-300">下达指令 ↗</button></div></div>
              <div className="mt-3 flex flex-wrap gap-2">{quickCommands.map((item) => <button key={item} onClick={() => setCommand(item)} className="rounded-full border border-white/10 px-3 py-1.5 text-xs text-white/40 transition hover:border-white/20 hover:text-white/70">{item}</button>)}</div>
            </div>
            <div className="rounded-3xl border border-white/10 bg-white/[0.035] p-5 sm:p-6">
              <div className="flex items-center justify-between"><div><p className="text-xs uppercase tracking-[0.18em] text-white/35">当前任务流</p><h2 className="mt-1 font-semibold">CEO 正在组织执行</h2></div><span className="rounded-full bg-orange-400/10 px-3 py-1 text-xs text-orange-300">进行中</span></div>
              <div className="mt-5 space-y-3"><Task number="01" title="理解与重构目标" detail={activeCommand} owner="马斯克" active /><Task number="02" title="建立关键假设与成功指标" detail="明确约束、时间窗口与可衡量成果" owner="马斯克" /><Task number="03" title="财务可行性与风险评估" detail="预算、安全边际、回报周期与风险敞口" owner="巴菲特" /></div>
              {sent && <p role="status" className="mt-4 rounded-xl bg-emerald-400/10 px-4 py-3 text-sm text-emerald-300">指令已进入中控流程，团队任务链已更新。</p>}
            </div>
          </section>

          <aside className="space-y-5">
            <div className="rounded-3xl border border-white/10 bg-white/[0.035] p-5"><p className="text-xs uppercase tracking-[0.18em] text-white/35">中控简报</p><div className="mt-4 flex items-start gap-3"><div className="grid h-10 w-10 shrink-0 place-items-center rounded-2xl bg-gradient-to-br from-orange-400 to-rose-500 text-xs font-black text-black">EM</div><div><p className="font-semibold">马斯克</p><p className="text-xs text-white/35">CEO · 刚刚更新</p></div></div><blockquote className="mt-4 border-l-2 border-orange-400/60 pl-4 text-sm leading-6 text-white/55">“先找到问题里不可改变的事实，再从零构建最快的实现路径。当前目标将按影响力和速度排序。”</blockquote><div className="mt-5 grid grid-cols-2 gap-2"><Metric label="活跃任务" value="3" /><Metric label="团队负载" value="68%" /></div></div>
            <div className="rounded-3xl border border-emerald-400/15 bg-emerald-400/[0.045] p-5"><div className="flex items-center justify-between"><p className="font-semibold">财务观察</p><span className="text-xs text-emerald-300">低风险</span></div><p className="mt-3 text-sm leading-6 text-white/45">巴菲特将重点检查现金流、安全边际与长期复利，避免被短期波动干扰。</p><button className="mt-4 text-sm text-emerald-300">查看财务建议 →</button></div>
          </aside>
        </div>
      </div>
    </main>
  );
}

function Task({ number, title, detail, owner, active = false }: { number: string; title: string; detail: string; owner: string; active?: boolean }) {
  return <div className={`flex gap-4 rounded-2xl border p-4 ${active ? 'border-orange-400/25 bg-orange-400/[0.06]' : 'border-white/5 bg-black/10'}`}><span className={`grid h-8 w-8 shrink-0 place-items-center rounded-xl text-xs font-semibold ${active ? 'bg-orange-400 text-black' : 'bg-white/5 text-white/30'}`}>{number}</span><div className="min-w-0 flex-1"><div className="flex flex-wrap items-center justify-between gap-2"><p className="font-medium">{title}</p><span className="text-xs text-white/35">负责人：{owner}</span></div><p className="mt-1 truncate text-sm text-white/35">{detail}</p></div></div>;
}

function Metric({ label, value }: { label: string; value: string }) { return <div className="rounded-2xl bg-black/20 p-3"><p className="text-xl font-semibold">{value}</p><p className="mt-1 text-xs text-white/30">{label}</p></div>; }
