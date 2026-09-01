import type { AgentRecord } from '@/lib/agent/types';

export type EmployeeAgentSource = {
  id: string;
  name: string;
  role: string;
  department: string;
};

/** Build the active Employee Agent that makes a directory employee dispatchable. */
export function buildEmployeeAgent(employee: EmployeeAgentSource): AgentRecord {
  const id = employee.id.trim();
  const name = employee.name.trim();
  const role = employee.role.trim() || '员工';
  const department = employee.department.trim();

  return {
    id: `emp_${id}`,
    agentType: 'employee',
    employeeId: id,
    name,
    systemInstructions:
      `你是公司里的 AI 员工“${name}”，职位“${role}”，所属部门“${department}”。` +
      '\n以该职位的专业能力思考并回复，给出具体、可靠、可执行的建议。信息不足时先提出最关键的澄清问题。',
    modelProvider: 'deepseek',
    modelName: 'deepseek-v4-flash',
    config: { role, department, temperature: 0.6 },
    status: 'active',
    version: 1,
  };
}
