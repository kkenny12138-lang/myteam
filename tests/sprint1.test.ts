import { describe, expect, it } from 'vitest';
import { parseLegacySkills } from '@/lib/agent/context-builder';
import { buildSystemPrompt } from '@/lib/agent/prompt-builder';
import { ApiError, assertAgentRunnable, errorBody, requireAvailableSkill, sumUsage } from '@/lib/agent/validators';

describe('Sprint 1: 旧 Skill 解析 parseLegacySkills', () => {
  it('解析对象数组 { name, desc }（字符串）', () => {
    const raw = JSON.stringify([
      { name: '财务建模', desc: '构建现金流模型' },
      { name: '估值', desc: '' },
    ]);
    expect(parseLegacySkills(raw)).toEqual([
      { name: '财务建模', description: '', desc: '构建现金流模型' },
      { name: '估值', description: '', desc: '' },
    ]);
  });

  it('直接传入对象数组（非字符串）', () => {
    expect(parseLegacySkills([{ name: 'A', description: '用途', desc: 'd' }])).toEqual([{ name: 'A', description: '用途', desc: 'd' }]);
  });

  it('解析字符串数组', () => {
    expect(parseLegacySkills(JSON.stringify(['skillA', 'skillB']))).toEqual([
      { name: 'skillA', description: '', desc: '' },
      { name: 'skillB', description: '', desc: '' },
    ]);
  });

  it('对象数组不会退化成 [object Object]', () => {
    const raw = JSON.stringify([{ name: '产品架构', desc: '擅长从 0 到 1 搭建产品体系' }]);
    const result = parseLegacySkills(raw);
    expect(result[0].name).toBe('产品架构');
    expect(result[0].desc).toContain('搭建');
    expect(result[0].name).not.toContain('[object Object]');
  });

  it('支持 description 字段回退为 desc', () => {
    const result = parseLegacySkills(JSON.stringify([{ name: 'X', description: '用 description 字段' }]));
    expect(result[0].description).toBe('用 description 字段');
    expect(result[0].desc).toBe('用 description 字段');
  });

  it('非法 JSON 返回空数组', () => {
    expect(parseLegacySkills('not-valid-json')).toEqual([]);
  });

  it('空值返回空数组', () => {
    expect(parseLegacySkills(null)).toEqual([]);
    expect(parseLegacySkills(undefined)).toEqual([]);
    expect(parseLegacySkills('')).toEqual([]);
    expect(parseLegacySkills('{}')).toEqual([]);
  });
});

describe('Sprint 1: 员工档案 Skill 注入 prompt', () => {
  it('将 employee_profiles.skills 中的名称和说明加入 system prompt', () => {
    const prompt = buildSystemPrompt({
      agent: {
        id: 'agent_buffett',
        agentType: 'employee',
        employeeId: 'buffett',
        name: '巴菲特',
        systemInstructions: '',
        modelProvider: 'deepseek',
        modelName: '',
        config: { role: '财务顾问', department: '财务部' },
        status: 'active',
        version: 1,
      },
      profile: {
        summary: '坚持长期主义与安全边际。',
        skills: [{ name: '财报分析', desc: '先检查自由现金流，再评估安全边际。' }],
      },
    });

    expect(prompt).toContain('员工档案能力');
    expect(prompt).toContain('### Skill：财报分析');
    expect(prompt).toContain('先检查自由现金流，再评估安全边际。');
  });
});

describe('Sprint 1: draft Agent 禁止生产执行 assertAgentRunnable', () => {
  it('active 放行', () => {
    expect(() => assertAgentRunnable('active')).not.toThrow();
  });

  it('draft + preview 放行', () => {
    expect(() => assertAgentRunnable('draft', true)).not.toThrow();
  });

  it('draft 生产拒绝（code=agent_draft）', () => {
    let caught: ApiError | null = null;
    try {
      assertAgentRunnable('draft');
    } catch (e) {
      caught = e as ApiError;
    }
    expect(caught).toBeInstanceOf(ApiError);
    expect(caught?.code).toBe('agent_draft');
    expect(caught?.status).toBe(403);
  });

  it('disabled 即使 preview 也拒绝', () => {
    let caught: ApiError | null = null;
    try {
      assertAgentRunnable('disabled', true);
    } catch (e) {
      caught = e as ApiError;
    }
    expect(caught?.code).toBe('agent_disabled');
  });

  it('未知状态拒绝', () => {
    expect(() => assertAgentRunnable('weird')).toThrow(ApiError);
  });
});

describe('Sprint 1: Skill 权限 requireAvailableSkill', () => {
  it('published 通过', () => {
    expect(() => requireAvailableSkill({ status: 'published' }, 'sk_1')).not.toThrow();
  });

  it('不存在 / draft / disabled 拒绝', () => {
    expect(() => requireAvailableSkill(null, 'sk_1')).toThrow(ApiError);
    expect(() => requireAvailableSkill(undefined, 'sk_1')).toThrow(ApiError);
    expect(() => requireAvailableSkill({ status: 'draft' }, 'sk_1')).toThrow(ApiError);
    expect(() => requireAvailableSkill({ status: 'disabled' }, 'sk_1')).toThrow(ApiError);
  });
});

describe('Sprint 1: 并行 usage 确定性汇总 sumUsage', () => {
  it('汇总多个 usage', () => {
    expect(
      sumUsage([
        { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
        { promptTokens: 20, completionTokens: 8, totalTokens: 28 },
      ])
    ).toEqual({ promptTokens: 30, completionTokens: 13, totalTokens: 43 });
  });

  it('跳过 null / undefined', () => {
    expect(
      sumUsage([null, { promptTokens: 1, completionTokens: 1, totalTokens: 2 }, undefined])
    ).toEqual({ promptTokens: 1, completionTokens: 1, totalTokens: 2 });
  });

  it('空数组返回 0', () => {
    expect(sumUsage([])).toEqual({ promptTokens: 0, completionTokens: 0, totalTokens: 0 });
  });

  it('顺序无关（纯函数确定性）', () => {
    const list = [
      { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
      { promptTokens: 2, completionTokens: 2, totalTokens: 4 },
      { promptTokens: 3, completionTokens: 3, totalTokens: 6 },
    ];
    expect(sumUsage([...list].reverse())).toEqual(sumUsage(list));
  });
});

describe('Sprint 1: 500 错误脱敏 errorBody', () => {
  it('ApiError 返回可公开 code/message', () => {
    const body = errorBody(new ApiError('agent_not_found', 'Agent 不存在: x', 404), 'req_1');
    expect(body).toMatchObject({ code: 'agent_not_found', message: 'Agent 不存在: x', requestId: 'req_1' });
  });

  it('未知 Error 不泄露内部信息', () => {
    const body = errorBody(new Error('SQL error: Duplicate entry ... password=secret123'), 'req_2');
    expect(body.code).toBe('internal');
    expect(body.message).toBe('服务暂时不可用');
    const json = JSON.stringify(body);
    expect(json).not.toContain('secret123');
    expect(json).not.toContain('Duplicate');
  });
});
