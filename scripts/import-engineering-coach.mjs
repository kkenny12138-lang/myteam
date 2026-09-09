// Uses existing Myteam APIs. Preview by default; --apply performs the import.
import { readFile } from 'node:fs/promises';
const base = process.argv.find(a => /^https?:\/\//.test(a));
if (!base) throw new Error('Provide the verified Myteam base URL; add --apply to import.');
const target = new URL(base);
if (target.username || target.password || target.search) throw new Error('Do not put credentials in the URL.');
const bundle = JSON.parse(await readFile(new URL('../docs/engineering-coach/employee-bundle.json', import.meta.url), 'utf8'));
async function api(path, method = 'GET', body) {
  const response = await fetch(new URL(path, target), {
    method, redirect: 'error', signal: AbortSignal.timeout(20000),
    headers: { 'Content-Type': 'application/json', ...(process.env.MYTEAM_AUTHORIZATION ? {Authorization: process.env.MYTEAM_AUTHORIZATION} : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!response.ok) throw new Error(`${method} ${path}: HTTP ${response.status}`);
  return response.json();
}
const employeeData = await api('/api/employees');
const skillData = await api('/api/skills');
if (!Array.isArray(employeeData.employees) || !Array.isArray(skillData.skills)) throw new Error('Not a configured Myteam API.');
const existingEmployee = employeeData.employees.find(e => e.id === bundle.employee.id || e.name === bundle.employee.name);
if (existingEmployee && existingEmployee.id !== bundle.employee.id) throw new Error('An employee with that name already exists under another ID.');
const agentId = `emp_${bundle.employee.id}`;
let agent = existingEmployee ? (await api(`/api/agents/${agentId}`)).agent : null;
const resumeFresh = process.argv.includes('--resume-created') && agent?.version === 1 && agent?.name === bundle.employee.name && agent?.employeeId === bundle.employee.id;
if (agent && agent.config?.skillBundleSource !== bundle.source && !resumeFresh) throw new Error('Existing employee is not owned by this import; refusing to overwrite.');
for (const skill of bundle.skills) {
  const existing = skillData.skills.find(s => s.id === skill.id);
  if (existing && (existing.instructions !== skill.instructions || existing.name !== skill.name || existing.status !== 'published')) {
    throw new Error(`Existing skill differs: ${skill.id}. Review instead of overwriting.`);
  }
}
console.log(JSON.stringify({ target: target.origin, employee: bundle.employee.name, department: bundle.employee.department, skills: bundle.skills.map(s => s.name), apply: process.argv.includes('--apply') }));
if (process.argv.includes('--apply')) {
// Safe to resume after a partial import: stable IDs prevent duplicate records.
for (const skill of bundle.skills) {
  if (!skillData.skills.some(s => s.id === skill.id)) await api('/api/skills', 'POST', skill);
}
if (!existingEmployee) {
  await api('/api/employees', 'POST', { employee: bundle.employee });
  agent = (await api(`/api/agents/${agentId}`)).agent;
}
await api(`/api/agents/${agentId}`, 'PATCH', {
  name: agent.name, agentType: agent.agentType,
  version: agent.version, systemInstructions: bundle.systemInstructions,
  config: { ...agent.config, role: bundle.employee.role, department: bundle.employee.department, skillBundleSource: bundle.source }, status: 'active',
});
await api('/api/profiles', 'PATCH', { employeeId: bundle.employee.id, profile: bundle.profile });
for (const [i, skill] of bundle.skills.entries()) {
  await api(`/api/agents/${agentId}/skills/${skill.id}`, 'PUT', { priority: 10 + i, customInstructions: '遵守 Myteam 平台适配说明，只在本次任务相关时执行。' });
}
const profiles = (await api('/api/profiles')).profiles;
const saved = (await api(`/api/agents/${agentId}`)).agent;
if (profiles?.[bundle.employee.id]?.skills?.length !== bundle.skills.length || saved.status !== 'active') throw new Error('Post-import verification failed.');
console.log(`Created and verified ${bundle.employee.name}, ${bundle.skills.length} profile skills; all skill links accepted by API.`);
}
