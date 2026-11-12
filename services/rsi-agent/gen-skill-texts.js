// 从 skills/<task>/SKILL.prompt 重新生成 app/skill_texts.py（烧进镜像的运行时副本）。
// 用法：node gen-skill-texts.js   （在 services/rsi-agent 目录下运行；改 skill 后必须
// 重跑本脚本 + 重建镜像，见 app/skill_texts.py 头注释）
const fs = require('fs');
const path = require('path');
const ROOT = __dirname;

function pyStr(s) {
  // 与原生成格式一致：json.dumps(ensure_ascii=False) 风格（\r\n 转义、双引号、原文中文）
  return JSON.stringify(s);
}

const tasks = [
  { key: 'attribute', dir: 'attribution', varName: 'ATTRIBUTION_SKILL' },
  { key: 'propose', dir: 'proposal', varName: 'PROPOSAL_SKILL' },
];
const body = tasks.map(({ dir, varName }) => {
  const p = path.join(ROOT, 'skills', dir, 'SKILL.prompt');
  const text = fs.readFileSync(p, 'utf8');
  return `${varName} = ${pyStr(text)}`;
});

const out = `"""RSI agent 的 skill 正文（运行时载体）。

源文档在 skills/<task>/SKILL.prompt（供人阅读/评审）；本模块是烧进镜像的运行时副本。
原因：openjiuwen.harness 按扩展名接管文件访问 + Docker Desktop(WSL2) bind mount
视图陈旧（实测目录随机不可见），运行期读 skill 文件不可靠——skill 文本进模块最稳。
修改 skill 后运行 node gen-skill-texts.js 重新生成本模块并重建镜像。

（本文件由 gen-skill-texts.js 生成，勿手改。）
"""

${body.join('\n\n')}

SKILL_TEXTS = {
    "attribute": ATTRIBUTION_SKILL,
    "propose": PROPOSAL_SKILL,
}
`;

fs.writeFileSync(path.join(ROOT, 'app', 'skill_texts.py'), out, 'utf8');
console.log('regenerated app/skill_texts.py:', tasks.map(({ key, dir }) => `${key}=${fs.readFileSync(path.join(ROOT, 'skills', dir, 'SKILL.prompt'), 'utf8').length}chars`).join(' '));
