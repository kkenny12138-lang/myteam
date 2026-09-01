import { describe, expect, it } from 'vitest';
import { buildEmployeeAgent } from '@/lib/agent/employee-agent';

describe('buildEmployeeAgent', () => {
  it('creates an active, dispatchable agent for a newly added employee', () => {
    const agent = buildEmployeeAgent({
      id: ' recruiter_1 ',
      name: ' 小招 ',
      role: ' 招聘专员 ',
      department: ' 招聘部 ',
    });

    expect(agent).toMatchObject({
      id: 'emp_recruiter_1',
      agentType: 'employee',
      employeeId: 'recruiter_1',
      name: '小招',
      status: 'active',
      modelProvider: 'deepseek',
      config: { role: '招聘专员', department: '招聘部', temperature: 0.6 },
    });
    expect(agent.systemInstructions).toContain('小招');
    expect(agent.systemInstructions).toContain('招聘专员');
  });

  it('uses a safe role fallback', () => {
    const agent = buildEmployeeAgent({ id: 'newbie', name: '新人', role: ' ', department: '综合部' });
    expect(agent.config.role).toBe('员工');
  });
});
