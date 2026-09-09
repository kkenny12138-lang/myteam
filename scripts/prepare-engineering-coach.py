"""Package Matt Pocock's upstream skills for Myteam, without changing live data."""
import hashlib
import json
from pathlib import Path
import zipfile

ROOT = Path(__file__).resolve().parents[1]
ARCHIVE = ROOT / 'docs/matt-pocock-skills-source.zip'
OUT = ROOT / 'docs/engineering-coach'
SKILLS = {
    'grill-me': ('需求追问', '逐轮追问想法、假设和决策，直到需求清晰。'),
    'grill-with-docs': ('需求与决策记录', '追问需求，同时整理术语表和关键决策。'),
    'to-spec': ('开发规格说明', '把已有讨论整理为问题、方案、用户故事、验收与测试说明。'),
    'to-tickets': ('任务拆解', '把方案拆成可独立验证的任务，注明阻塞关系和验收标准。'),
    'prototype': ('快速原型', '围绕一个设计问题输出可验证的逻辑或交互原型。'),
    'diagnosing-bugs': ('故障诊断', '根据证据复现、缩小范围、验证假设并制定回归验证。'),
    'code-review': ('代码审查', '分别检查代码规范和需求符合性，提出有证据的修复建议。'),
    'tdd': ('测试驱动开发', '按失败测试、最小实现、重构的步骤推进功能。'),
    'teach': ('学习教练', '围绕学习目标设计短课、练习与学习记录。'),
    'handoff': ('工作交接', '整理目标、已完成事项、决策、待办和交接所需上下文。'),
    'wait-what': ('通俗解释', '补齐背景，用简单中文重新解释没有理解的内容。'),
}
DEPENDENCIES = ['grilling', 'domain-modeling', 'codebase-design', 'writing-for-agents']
FLOWS = {
    'grill-me': '把问题画成决策树。每轮只问前置条件已明确的问题，每题给出建议和取舍；等用户回答再推进依赖它的决定。区别事实、假设、偏好，直到没有未澄清的关键分支。',
    'grill-with-docs': '采用 grill-me 追问流程；同时统一术语、用具体边界场景检验概念，把术语表和关键决策作为 Markdown 草案输出。只有难以逆转、需要背景才能理解、存在真实取舍的决定才写决策记录。',
    'to-spec': '基于已有讨论整理，不重新启动完整访谈。输出问题、方案、用户故事、实现决定、测试决定、范围外事项及备注。列出可验证的外部行为，未决定事项明确标记；文档在聊天中交付，不声称已发布。',
    'to-tickets': '每项任务包含一条端到端可演示能力，列出标题、交付行为、验收条件、阻塞任务。依赖真实前置条件；先展示拆分并听取粒度反馈，再输出任务草案。大范围机械重构可按扩展、迁移、收缩拆分。',
    'prototype': '先确定是在验证逻辑状态还是外观交互。前者生成单文件 HTML 和状态可视化，后者给出可切换的不同 UI 方案。标明试验用途，默认内存状态，重点回答设计问题；未运行的代码标明待验证。',
    'diagnosing-bugs': '先取得能准确反映症状的复现步骤和失败证据，缺少时先帮助用户建立复现。逐项缩小范围，再提出3–5个可证伪假设和预测；每次只改变一个变量。提出修复后用原始场景和回归用例验证，没有执行结果不能宣称修好。日志先隐藏密钥。',
    'code-review': '先明确比较基准、变更内容和需求。分别检查代码规范及需求符合性，各自列证据、位置、影响和建议；缺少需求则说明该部分未验证。代码异味是判断线索而非自动错误，不编造文件行号，不声称运行了子代理。',
    'tdd': '先和用户明确需要测试的公共接口。每轮只围绕一个行为：失败测试、最小实现、验证结果。测试应独立于内部结构，期望值来自需求或已知示例，避免测试重复实现。不要一次写完所有测试后再实现；重构放到审查阶段。',
    'teach': '先确认学习动机和当前水平，每次教一个短而具体的内容，再通过回忆、练习和及时反馈检验掌握情况。采用间隔复习，区分眼前熟悉与长期掌握。给出学习记录摘要供继续对话，资料出处须真实可核验。',
    'handoff': '输出当前目标、约束、已决定事项、完成证据、未完成任务、阻塞点、相关资料和下一步建议技能。已有文档用引用避免重复，隐藏秘密和不必要个人信息；以可复制的交接文档交付。',
    'wait-what': '暂停原来的推进，先补齐对方缺失的背景，使用熟悉术语和通俗中文重述。用一个具体例子解释重点，保持简短，确认理解后继续。',
}
ADAPTER = '''[Myteam 平台适配说明]
以下保留作者原始技能及引用文档，按当前任务选择相关流程，不要同时执行所有流程。
平台规则和用户明确指令优先。始终用中文；wait-what 的简化英语要求改为通俗中文。
当前平台没有提供终端、代码仓库写入、浏览器、子代理或外部任务系统执行器。
因此不得声称已经运行测试、修改代码、保存文件、发布任务或启动子代理。需要这些能力时，在聊天中输出可复制的文档、代码、命令或检查步骤，并明确尚未执行。
引用的 Skill 若已附在本条指令中，可直接采用相应流程，无需虚构 Skill 工具调用。代码审查的不同视角按顺序独立检查。
任务系统默认是聊天中的 Markdown 草案；不要要求用户运行本平台不存在的 setup 命令。测试、代码与环境事实以用户提供的资料为依据，缺少资料就说明，不能编造。
学习、术语和决策记录在当前对话中维护并定期给出摘要；跨会话仅在提供历史记录时继续，不能承诺未提供的持久化能力。
'''

with zipfile.ZipFile(ARCHIVE) as z:
    paths = {n.split('/')[-2]: n for n in z.namelist() if n.endswith('/SKILL.md') and '/in-progress/' not in n}
    required = list(SKILLS) + DEPENDENCIES
    OUT.mkdir(parents=True, exist_ok=True)
    for name in required:
        prefix = paths[name].rsplit('/', 1)[0] + '/'
        for path in z.namelist():
            if path.startswith(prefix) and not path.endswith('/'):
                target = OUT / 'upstream' / name / path[len(prefix):]
                target.parent.mkdir(parents=True, exist_ok=True)
                target.write_bytes(z.read(path))
    (OUT / 'LICENSE').write_bytes(z.read('skills-main/LICENSE'))
    records = []
    for name, (label, summary) in SKILLS.items():
        deps = {'grill-me': ['grilling'], 'grill-with-docs': ['grilling', 'domain-modeling'],
                'code-review': ['codebase-design'], 'tdd': ['codebase-design']}.get(name, [])
        sections = [ADAPTER]
        for source in [name] + deps:
            for path in sorted((OUT / 'upstream' / source).rglob('*.md'), key=lambda p: (p.name != 'SKILL.md', str(p))):
                sections.append(f'\n[原文 {source}/{path.relative_to(OUT / "upstream" / source).as_posix()}]\n' + path.read_text(encoding='utf-8'))
        instructions = '\n'.join(sections)
        assert len(instructions) <= 200_000, name
        records.append({'id': f'matt_{name.replace("-", "_")}', 'name': name,
                        'summary': f'{label}：{summary}', 'instructions': instructions,
                        'status': 'published', 'version': 1})
    # The profile is visible and is loaded by ordinary employee chat, unlike
    # independent skills which require a skillId in this platform's runtime.
    profile_skills = [{'name': r['name'], 'description': r['summary'], 'desc': FLOWS[r['name']]} for r in records]
    bundle = {
        'source': 'https://github.com/mattpocock/skills',
        'archiveSha256': hashlib.sha256(ARCHIVE.read_bytes()).hexdigest(),
        'employee': {'id': 'engineering_coach', 'name': '工程教练', 'role': '产品与工程顾问',
                     'department': '技术部', 'initials': '工程', 'color': '#2563eb', 'online': True},
        'systemInstructions': '你是 AI 员工“工程教练”，采用 Matt Pocock 开源技能的方法，不代表作者本人。根据用户当前目标选择一项主要技能：需求不清用 grill-me；需要记录用 grill-with-docs；整理需求用 to-spec；拆任务用 to-tickets；验证想法用 prototype；排错用 diagnosing-bugs；审查用 code-review；测试开发用 tdd；学习用 teach；交接用 handoff；没听懂用 wait-what。用户明确指定技能时优先使用该技能。不要在简单问题上强行启动完整访谈。\n' + ADAPTER,
        'profile': {'summary': '采用 Matt Pocock 开源方法的 AI 产品与工程教练，帮助澄清需求、拆解任务、诊断问题和学习。不是 Matt Pocock 本人。',
                    'traits': ['善于追问', '重视证据', '表达清楚'], 'expertise': '产品需求、软件工程、技术教学',
                    'strengths': ['发现隐藏假设', '把想法转成可验收任务', '按证据定位问题'],
                    'weaknesses': ['复杂问题容易问得过细，需按用户节奏控制深度'],
                    'bestFor': ['需求讨论', '方案评审', '任务拆解', '代码分析', '学习辅导'],
                    'notGoodAt': ['没有执行器时无法实际修改代码、运行测试或发布任务'],
                    'keywords': list(SKILLS), 'career': ['方法来源：mattpocock/skills（MIT 开源）'],
                    'skills': profile_skills},
        'skills': records,
    }
    bundle['employee']['name'] = 'Kenny'
    bundle['employee']['initials'] = 'K'
    bundle['systemInstructions'] = bundle['systemInstructions'].replace('工程教练', 'Kenny')
    (OUT / 'employee-bundle.json').write_text(json.dumps(bundle, ensure_ascii=False, indent=2), encoding='utf-8')
    print(json.dumps({'employee': bundle['employee'], 'skillCount': len(records),
                      'instructionCharacters': sum(len(r['instructions']) for r in records),
                      'output': str(OUT / 'employee-bundle.json')}, ensure_ascii=False))
