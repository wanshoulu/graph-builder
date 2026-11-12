/**
 * Mock 企业数据 — 日程管理 Agent 的数据层（L1 员工主数据 + L3 动态状态模拟）
 *
 * 设计（对齐业界三层数据分层）：
 *   L1 员工主数据：name/工号/部门/职位/职级/办公地点/技能/邮箱/手机/雇佣状态（buildEmployees）
 *   L2 组织关系图：汇报线/项目组/技能关系 → org-graph-builder.js 构建（不落库，从 L1 派生）
 *   L3 动态状态：日历忙闲 + 出差/请假（OOO 忙块）+ 会议室日历 + 协作热度（buildDayContext，当天生成）
 *
 * 规模：~150 人模拟银行（总行 10 个部门，4-5 层汇报树，跨部门项目组）
 * 可复现：seeded PRNG（mulberry32）——同一 seed 生成完全一致的企业，测试稳定
 *
 * 拆分说明（组织图谱构建工具消费桥接，2026-08-24）：
 *   buildEmployees(state) + buildDayContext(state, employees, projects) = buildCompany(seed)
 *   两者共用同一个 PRNG 状态流（state.rand），组合行为与拆分前字节级一致；
 *   发布图谱路径只替换 L1/L2（employees/projects 来自图文档），L3 用 buildDayContext 当天生成。
 */

'use strict';

var { BJ_OFFSET_H, HOUR_MS, DAY_MS } = require('./scheduling-engine');

// ── 确定性伪随机（seed 可复现，测试/演示数据稳定） ──
function mulberry32(seed) {
  var a = seed >>> 0;
  return function() {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    var t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ── 组织与人员素材 ──
var DEPARTMENTS = [
  { id: 'president', name: '行长办公室', parent: null },
  { id: 'risk', name: '风险管理部', parent: 'president' },
  { id: 'tech', name: '金融科技部', parent: 'president' },
  { id: 'hr', name: '人力资源部', parent: 'president' },
  { id: 'finance', name: '财务管理部', parent: 'president' },
  { id: 'corp', name: '公司业务部', parent: 'president' },
  { id: 'retail', name: '零售业务部', parent: 'president' },
  { id: 'ops', name: '运营管理部', parent: 'president' },
  { id: 'compliance', name: '合规部', parent: 'president' },
  { id: 'audit', name: '审计部', parent: 'president' },
];

// 习惯叫法（别名）：按职级生成的尊称——企业通讯录标准字段（对标 AD displayName/alias、飞书备注名）
// 行长/部门总经理等带职务尊称；"X董"为行长兼董事长的习惯叫法（中小银行常见）
var ALIAS_RULES = [
  { rank: '行长', alias: '行长' },
  { rank: '行长', alias: '董' },
  { rank: '部门总经理', alias: '总' },
  { rank: '副总经理', alias: '总' },
  { rank: '团队负责人', alias: '老师' },
];

// 部门 → 团队（汇报树第 3 层）
var TEAMS = {
  tech: ['大数据团队', '人工智能团队', '应用开发团队', '测试与运维团队'],
  risk: ['信用风控团队', '市场风控团队', '模型验证团队'],
  hr: ['招聘培训团队', '薪酬绩效团队', '员工关系团队'],
  finance: ['预算管理团队', '财务分析团队', '税务核算团队'],
  corp: ['大客户团队', '中小企业团队', '机构业务团队'],
  retail: ['个人信贷团队', '财富管理团队', '渠道运营团队'],
  ops: ['流程管理团队', '运营支持团队'],
  compliance: ['制度审查团队', '反洗钱团队'],
  audit: ['现场审计团队', '非现场审计团队'],
  president: ['综合管理团队', '战略研究团队'],
};

var RANKS = ['行长', '副行长', '部门总经理', '副总经理', '团队负责人', '高级经理', '经理', '专员'];

var SKILL_POOL = [
  'NLP', '机器学习', '大数据分析', '风控建模', 'Python', 'Java', '前端开发',
  '产品设计', '项目管理', '合规审查', '反洗钱', '财务分析', '预算管理',
  '薪酬绩效', '招聘面试', '培训设计', '客户营销', '信贷审批', '财富规划',
  '渠道运营', '流程优化', '数据分析', '系统架构', '测试自动化', '运维保障',
];

var SURNAMES = ['王', '李', '张', '刘', '陈', '杨', '黄', '赵', '吴', '周', '徐', '孙', '马', '朱', '胡', '郭', '何', '林', '罗', '郑', '梁', '谢', '宋', '唐', '许', '韩', '冯', '邓', '曹', '彭'];
var GIVEN_NAMES = ['伟', '芳', '娜', '敏', '静', '磊', '军', '洋', '勇', '艳', '杰', '涛', '明', '超', '秀兰', '霞', '平', '刚', '桂英', '建华', '志强', '丽华', '文轩', '子涵', '雨桐', '浩然', '欣怡', '宇轩', '诗涵', '梓萱', '睿哲', '梦琪', '俊杰', '婉婷'];

var PINYIN_INITIALS = {
  '王': 'wang', '李': 'li', '张': 'zhang', '刘': 'liu', '陈': 'chen', '杨': 'yang', '黄': 'huang', '赵': 'zhao', '吴': 'wu', '周': 'zhou',
  '徐': 'xu', '孙': 'sun', '马': 'ma', '朱': 'zhu', '胡': 'hu', '郭': 'guo', '何': 'he', '林': 'lin', '罗': 'luo', '郑': 'zheng',
  '梁': 'liang', '谢': 'xie', '宋': 'song', '唐': 'tang', '许': 'xu2', '韩': 'han', '冯': 'feng', '邓': 'deng', '曹': 'cao', '彭': 'peng',
};

var PROJECTS = [
  { id: 'proj-mobile', name: '手机银行改版项目', depts: ['tech', 'retail', 'ops'] },
  { id: 'proj-risk-ai', name: '智能风控项目', depts: ['risk', 'tech'] },
  { id: 'proj-core', name: '核心系统升级项目', depts: ['tech', 'ops', 'audit'] },
  { id: 'proj-wealth', name: '财富管理转型项目', depts: ['retail', 'corp', 'compliance'] },
  { id: 'proj-hr-digital', name: '人力资源数字化项目', depts: ['hr', 'tech'] },
  { id: 'proj-aml', name: '反洗钱系统建设项目', depts: ['compliance', 'tech', 'risk'] },
];

var LOCATIONS = ['总行大厦A座', '总行大厦B座', '金融街数据中心', '科技园区', '分行大厦'];

// 会议室资源（线下会议预订，对标 Outlook/飞书会议室资源日历：容量/设备/忙闲）
var ROOM_DEFS = [
  { id: 'room-a301', name: 'A座301会议室', location: '总行大厦A座', capacity: 12, facilities: ['投影', '视频会议'] },
  { id: 'room-a302', name: 'A座302会议室', location: '总行大厦A座', capacity: 8, facilities: ['投影'] },
  { id: 'room-a501', name: 'A座501大会议室', location: '总行大厦A座', capacity: 30, facilities: ['投影', '视频会议', '同声传译'] },
  { id: 'room-b201', name: 'B座201会议室', location: '总行大厦B座', capacity: 10, facilities: ['投影', '视频会议'] },
  { id: 'room-b202', name: 'B座202小会议室', location: '总行大厦B座', capacity: 6, facilities: ['白板'] },
  { id: 'room-dc301', name: '数据中心301会议室', location: '金融街数据中心', capacity: 16, facilities: ['投影', '视频会议'] },
  { id: 'room-park101', name: '科技园101会议室', location: '科技园区', capacity: 12, facilities: ['投影', '视频会议', '白板'] },
  { id: 'room-park102', name: '科技园102会议室', location: '科技园区', capacity: 8, facilities: ['投影'] },
  { id: 'room-br101', name: '分行大厦101会议室', location: '分行大厦', capacity: 14, facilities: ['投影', '视频会议'] },
];

// ── PRNG 随机工具（共享 state.rand 流） ──
function makeHelpers(rand) {
  return {
    pick: function(arr) { return arr[Math.floor(rand() * arr.length)]; },
    pickN: function(arr, n) { // 不重复取 n 个
      var pool = arr.slice();
      var out = [];
      while (out.length < n && pool.length) {
        out.push(pool.splice(Math.floor(rand() * pool.length), 1)[0]);
      }
      return out;
    },
    randInt: function(min, max) { return min + Math.floor(rand() * (max - min + 1)); },
  };
}

// ═══════════════════ L1 员工主数据 + L2 项目成员（组织关系派生） ═══════════════════
/**
 * 生成员工主数据与项目成员（L1/L2；PRNG 流前半段）
 * @param {object} state { rand: mulberry32 实例 }
 * @returns {{ employees: Array, projects: Array<{id,name,memberIds}> }}
 */
function buildEmployees(state) {
  var h = makeHelpers(state.rand);
  var pick = h.pick, pickN = h.pickN, randInt = h.randInt, rand = state.rand;

  var employees = [];
  var empId = 0;
  var usedNames = {};
  var usedIds = {};

  function nextName() {
    for (var tries = 0; tries < 100; tries++) {
      var name = pick(SURNAMES) + pick(GIVEN_NAMES);
      if (!usedNames[name]) { usedNames[name] = true; return name; }
    }
    return '员工' + (++empId);
  }
  function nextEmpNo() {
    var no = 'A' + String(1000 + empId);
    while (usedIds[no]) { empId++; no = 'A' + String(1000 + empId); }
    usedIds[no] = true;
    return no;
  }
  function makeEmployee(dept, rank, managerNo, team) {
    var name = nextName();
    var no = nextEmpNo();
    var surname = name[0];
    var pinyin = (PINYIN_INITIALS[surname] || 'x') + '_' + no.toLowerCase();
    var skills = pickN(SKILL_POOL, randInt(2, 5));
    // 技能按部门加权：tech 部门必含 1 个技术技能
    if (dept === 'tech') {
      var techSkills = ['NLP', '机器学习', '大数据分析', 'Python', 'Java', '前端开发', '系统架构', '测试自动化', '运维保障'];
      if (!skills.some(function(s) { return techSkills.indexOf(s) >= 0; })) {
        skills[0] = pick(techSkills);
      }
    }
    return {
      id: 'emp-' + no,
      empNo: no,
      name: name,
      pinyin: pinyin,
      // 习惯叫法：按职级规则生成（如 张总、王老师）；工号 + 姓名拼音字母为检索别名
      aliases: ALIAS_RULES.filter(function(r) { return r.rank === rank; }).map(function(r) { return surname + r.alias; }),
      department: dept,
      deptName: (DEPARTMENTS.filter(function(d) { return d.id === dept; })[0] || {}).name || dept,
      team: team || '',
      rank: rank,
      title: team ? team.replace('团队', '') + (rank === '团队负责人' ? '团队负责人' : rank) : rank,
      location: pick(LOCATIONS),
      skills: skills,
      email: pinyin.replace(/_\d+$/, '') + no.toLowerCase() + '@aiharbor-bank.com',
      phone: '13' + randInt(100000000, 999999999),
      managerId: managerNo || null,
      status: 'active',
      onboardDate: '20' + randInt(10, 24) + '-' + String(randInt(1, 12)).padStart(2, '0') + '-01',
    };
  }

  // 行长办公室：行长 + 副行长 2 + 综合/战略团队
  var president = makeEmployee('president', '行长', null, '');
  employees.push(president);
  ['副行长', '副行长'].forEach(function(rank) {
    employees.push(makeEmployee('president', rank, president.id, ''));
  });

  // 其余 9 个部门
  DEPARTMENTS.filter(function(d) { return d.id !== 'president'; }).forEach(function(dept) {
    var gm = makeEmployee(dept.id, '部门总经理', president.id, '');
    employees.push(gm);
    var vpCount = dept.id === 'tech' ? 2 : 1;
    var vps = [];
    for (var v = 0; v < vpCount; v++) {
      var vp = makeEmployee(dept.id, '副总经理', gm.id, '');
      employees.push(vp);
      vps.push(vp);
    }
    // 团队
    (TEAMS[dept.id] || []).forEach(function(team) {
      var lead = makeEmployee(dept.id, '团队负责人', vps[vps.length - 1].id, team);
      employees.push(lead);
      // 团队成员（按部门规模：tech 每团队 6-9 人，其他 3-5 人）
      var size = dept.id === 'tech' ? randInt(6, 9) : randInt(3, 5);
      for (var m = 0; m < size; m++) {
        var rank = rand() < 0.3 ? '高级经理' : (rand() < 0.6 ? '经理' : '专员');
        employees.push(makeEmployee(dept.id, rank, lead.id, team));
      }
    });
  });

  // ── 项目组成员（跨部门，5-10 人/项目） ──
  var projectMembers = {};
  PROJECTS.forEach(function(proj) {
    var members = [];
    var pool = employees.filter(function(e) {
      return proj.depts.indexOf(e.department) >= 0 && e.rank !== '行长' && e.rank !== '副行长' && e.rank !== '部门总经理';
    });
    var n = randInt(5, 10);
    members = pickN(pool, Math.min(n, pool.length)).map(function(e) { return e.id; });
    projectMembers[proj.id] = members;
  });

  return {
    employees: employees,
    projects: PROJECTS.map(function(p) { return { id: p.id, name: p.name, memberIds: projectMembers[p.id] || [] }; }),
  };
}

// ═══════════════════ L3 动态状态（当天生成：日历 / OOO / 会议室 / 协作热度） ═══════════════════
/**
 * 生成当天动态状态（L3；PRNG 流后半段）
 * @param {object} state { rand: mulberry32 实例 }
 * @param {Array} employees 员工（来自 buildEmployees 或发布图谱转换）
 * @param {Array} projects 项目 {id, name, memberIds}
 * @returns {{ calendars, oooEvents, interactions, rooms, roomCalendars, generatedAt }}
 */
function buildDayContext(state, employees, projects) {
  var h = makeHelpers(state.rand);
  var pick = h.pick, randInt = h.randInt, rand = state.rand;

  // ── 日历：未来 14 天忙闲（工作日北京时间 9:00-18:00，职级越高会议越密） ──
  // 时区约定：北京日期基准 dayUTC = 北京日 D 的 00:00（UTC 表示），北京时间 9:00 = dayUTC + 1h，
  // 18:00 = dayUTC + 10h。与 scheduling-engine 的 _dayBounds 同约定，宿主机/容器行为一致。
  var busyDensity = { '行长': 0.85, '副行长': 0.8, '部门总经理': 0.75, '副总经理': 0.65, '团队负责人': 0.55, '高级经理': 0.4, '经理': 0.3, '专员': 0.2 };
  var calendars = {};
  var oooEvents = [];
  var nowBJ = new Date(Date.now() + BJ_OFFSET_H * HOUR_MS);
  var todayUTC = Date.UTC(nowBJ.getUTCFullYear(), nowBJ.getUTCMonth(), nowBJ.getUTCDate());

  employees.forEach(function(emp) {
    var busy = [];
    var density = busyDensity[emp.rank] || 0.3;
    for (var day = 0; day < 14; day++) {
      var dayUTC = todayUTC + day * DAY_MS;
      var dow = new Date(dayUTC).getUTCDay();
      if (dow === 0 || dow === 6) continue; // 周末不排会
      // 每天会议块数量 2-8（按密度）
      var blockCount = Math.floor(density * 8) + (rand() < density % 1 ? 1 : 0);
      var slotStart = 9 * 60; // 北京 9:00（dayUTC 为北京 8:00，offset = 60min）
      for (var b = 0; b < blockCount; b++) {
        var startMin = slotStart + randInt(0, 90);
        var lenMin = pick([30, 30, 60, 60, 90]);
        var endMin = startMin + lenMin;
        if (endMin > 18 * 60) break;
        busy.push({
          start: new Date(dayUTC + (startMin - BJ_OFFSET_H * 60) * 60000).toISOString(),
          end: new Date(dayUTC + (endMin - BJ_OFFSET_H * 60) * 60000).toISOString(),
          title: pick(['部门例会', '项目评审会', '客户拜访', '周例会', '专题讨论会', '一对一沟通', '季度规划会']),
        });
        slotStart = endMin + 15; // 会议间至少 15 分钟
      }
    }
    calendars[emp.id] = busy;

    // 出差/请假（OOO）：约 8% 员工有未来 3-10 天的 OOO 块（北京 9:00 → len 天后 18:00）
    if (rand() < 0.08) {
      var oooLen = randInt(3, 10);
      var oooStartDay = randInt(1, 8);
      var oooStartUTC = todayUTC + oooStartDay * DAY_MS + 1 * HOUR_MS; // 北京 9:00
      var oooEndUTC = oooStartUTC + oooLen * DAY_MS + 9 * HOUR_MS;     // len 天后北京 18:00
      var oooType = rand() < 0.6 ? '出差' : '请假';
      oooEvents.push({
        empId: emp.id,
        type: oooType,
        reason: oooType === '出差' ? pick(['客户现场调研', '监管汇报', '同业交流', '分行检查']) : pick(['年休假', '病假', '婚假']),
        start: new Date(oooStartUTC).toISOString(),
        end: new Date(oooEndUTC).toISOString(),
      });
      // OOO 期间日历标全忙
      calendars[emp.id].push({ start: new Date(oooStartUTC).toISOString(), end: new Date(oooEndUTC).toISOString(), title: oooType + '（' + (oooType === '出差' ? '出差' : '请假') + '）' });
    }
  });

  // ── 会议室日历：工作日北京时间 9-18 随机忙块（密度约 0.45，每间每天 2-5 个） ──
  var roomCalendars = {};
  ROOM_DEFS.forEach(function(room) {
    var busy = [];
    for (var day = 0; day < 14; day++) {
      var dayUTC = todayUTC + day * DAY_MS;
      var dow = new Date(dayUTC).getUTCDay();
      if (dow === 0 || dow === 6) continue;
      var blockCount = randInt(2, 5);
      var slotStart = 9 * 60;
      for (var b = 0; b < blockCount; b++) {
        var startMin = slotStart + randInt(0, 60);
        var lenMin = pick([30, 60, 60, 90]);
        var endMin = startMin + lenMin;
        if (endMin > 18 * 60) break;
        busy.push({
          start: new Date(dayUTC + (startMin - BJ_OFFSET_H * 60) * 60000).toISOString(),
          end: new Date(dayUTC + (endMin - BJ_OFFSET_H * 60) * 60000).toISOString(),
          title: '会议室占用',
        });
        slotStart = endMin + 15;
      }
    }
    roomCalendars[room.id] = busy;
  });

  // ── 近期协作信号（对标 Microsoft Graph people insights / Delve 协作关系） ──
  // 生成"近 30 天共同会议/业务往来"行为数据：
  //   同团队对：概率 0.2 → 1-6 次共同会议；项目成员对：概率 0.6 → 2-8 次（项目协作更强）
  // 行为信号不进组织边权（避免污染结构语义），作为边属性 + recent_collaborators 查询使用
  var empMap = {};
  employees.forEach(function(e) { empMap[e.id] = e; });
  var interactions = [];
  function addInteraction(a, b, times) {
    interactions.push({
      empA: a.id, empB: b.id,
      meetings30d: times,
      lastDays: randInt(0, 29),
    });
  }
  // 同团队对
  var teamsMap = {};
  employees.forEach(function(e) {
    if (!e.team) return;
    var key = e.department + '||' + e.team;
    (teamsMap[key] = teamsMap[key] || []).push(e);
  });
  Object.keys(teamsMap).forEach(function(key) {
    var members = teamsMap[key];
    for (var i = 0; i < members.length; i++) {
      for (var j = i + 1; j < members.length; j++) {
        if (rand() < 0.2) addInteraction(members[i], members[j], randInt(1, 6));
      }
    }
  });
  // 项目成员对（跨部门业务往来）
  (projects || []).forEach(function(p) {
    var members = (p.memberIds || []).map(function(id) { return empMap[id]; }).filter(Boolean);
    for (var i = 0; i < members.length; i++) {
      for (var j = i + 1; j < members.length; j++) {
        if (rand() < 0.6) addInteraction(members[i], members[j], randInt(2, 8));
      }
    }
  });
  // 汇报线对（经理与直接下属：一对一沟通/部门例会——高管日历密度最高，协作行为必须覆盖）
  employees.forEach(function(e) {
    if (e.managerId && empMap[e.managerId] && rand() < 0.8) {
      addInteraction(e, empMap[e.managerId], randInt(2, 10));
    }
  });
  // 同部门高管对（GM/VP 之间的部门例会、周例会）
  var execs = employees.filter(function(e) { return e.rank === '部门总经理' || e.rank === '副总经理'; });
  for (var i = 0; i < execs.length; i++) {
    for (var j = i + 1; j < execs.length; j++) {
      if (execs[i].department !== execs[j].department) continue;
      if (rand() < 0.9) addInteraction(execs[i], execs[j], randInt(2, 8));
    }
  }

  return {
    calendars: calendars, // empId → busy intervals
    oooEvents: oooEvents,
    interactions: interactions, // 近期协作行为（边属性数据源）
    rooms: ROOM_DEFS.map(function(r) { return { roomId: r.id, name: r.name, location: r.location, capacity: r.capacity, facilities: r.facilities }; }),
    roomCalendars: roomCalendars, // roomId → busy intervals（会议室资源日历）
    generatedAt: new Date(todayUTC).toISOString(),
  };
}

// ── 企业生成（组合） ──
/**
 * 生成 mock 企业
 * @param {number} seed 随机种子（默认 42）
 * @returns {{ employees: Array, departments: Array, projects: Array }}
 */
function buildCompany(seed) {
  var state = { rand: mulberry32(seed || 42) };
  var base = buildEmployees(state);
  var day = buildDayContext(state, base.employees, base.projects);
  return {
    employees: base.employees,
    departments: DEPARTMENTS,
    projects: base.projects,
    calendars: day.calendars, // empId → busy intervals
    oooEvents: day.oooEvents,
    interactions: day.interactions, // 近期协作行为（边属性数据源）
    rooms: day.rooms,
    roomCalendars: day.roomCalendars, // roomId → busy intervals（会议室资源日历）
    generatedAt: day.generatedAt,
  };
}

module.exports = {
  buildCompany: buildCompany,
  buildEmployees: buildEmployees,
  buildDayContext: buildDayContext,
  mulberry32: mulberry32,
  DEPARTMENTS: DEPARTMENTS,
  PROJECTS: PROJECTS,
  SKILL_POOL: SKILL_POOL,
};
