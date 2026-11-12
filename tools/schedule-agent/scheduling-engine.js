/**
 * 排期引擎 — 忙闲查询 + 公共空闲槽位计算（业界标准：算法在引擎侧，LLM 不参与算术）
 *
 * 流程（对标 Microsoft Graph findMeetingTimes / 飞书钉钉企微共同模式）：
 *   ① freebusy：取各参会人忙区间（含 OOO 出差/请假块——业界"日历忙块"模式）
 *   ② 反集推导：时间窗内求公共空闲区间（逐工作日内跳过忙区间）
 *   ③ 槽位生成：工作时段（默认北京时间 9:00-18:00 工作日）内切槽，满足时长 + 缓冲
 *   ④ 打分排序：空闲度 + 时段偏好（上午 > 下午 > 午休）→ 0-1 分
 *
 * 时区约定（2026-08-23 修复）：全部时间内部用 Unix 毫秒（UTC）计算，输出 ISO 8601（UTC）。
 * 工作时段边界显式按北京时间（UTC+8，无夏令时）折算，不依赖宿主/容器本地时区——
 * 宿主机（Asia/Shanghai）与 Docker 容器（UTC）行为一致。
 */

'use strict';

var DAY_MS = 86400000;
var HOUR_MS = 3600000;
var BJ_OFFSET_H = 8; // 北京时间固定 +8（无夏令时）

/**
 * 合并重叠区间（已按 start 排序）
 * @param {Array<{start,end}>} intervals
 */
function mergeIntervals(intervals) {
  var out = [];
  intervals.forEach(function(iv) {
    if (!out.length || iv.start > out[out.length - 1].end) {
      out.push({ start: iv.start, end: iv.end });
    } else if (iv.end > out[out.length - 1].end) {
      out[out.length - 1].end = iv.end;
    }
  });
  return out;
}

/**
 * 多人忙闲查询：合并所有参会人的忙区间（含 OOO 块）
 * @param {object} company
 * @param {Array<string>} empIds
 * @param {number} windowStart 窗口起点（Unix ms）
 * @param {number} windowEnd 窗口终点（Unix ms）
 * @returns {{ busy: Array<{start,end}> , perPerson: Object }}
 */
function queryFreeBusy(company, empIds, windowStart, windowEnd) {
  var perPerson = {};
  var all = [];
  var seen = {};
  empIds.forEach(function(id) {
    if (!id || seen[id]) return; // 去重（LLM 可能重复传同一人）
    seen[id] = true;
    var busy = ((company.calendars || {})[id] || []).filter(function(b) {
      var s = new Date(b.start).getTime();
      var e = new Date(b.end).getTime();
      if (isNaN(s) || isNaN(e) || s >= e) return false;
      return e > windowStart && s < windowEnd;
    }).map(function(b) {
      return { start: new Date(b.start).getTime(), end: new Date(b.end).getTime(), title: b.title };
    }).sort(function(a, b) { return a.start - b.start; }); // 按时间排序（前端日历渲染依赖）
    perPerson[id] = busy;
    all = all.concat(busy);
  });
  all.sort(function(a, b) { return a.start - b.start; });
  return { busy: mergeIntervals(all), perPerson: perPerson };
}

/**
 * 某 UTC 毫秒所在"北京日期"的工作时段边界（UTC 毫秒）
 * 北京日 D 的 [workStart, workEnd) = UTC [D 00:00 + (workStart-8)h, D 00:00 + (workEnd-8)h)
 */
function _dayBounds(utcMs, workHours) {
  // 先折算到北京时间再取日期，确保 UTC 16:00-24:00（= 北京次日 00:00-08:00）也能正确归入北京日期
  var d = new Date(utcMs + BJ_OFFSET_H * HOUR_MS);
  var y = d.getUTCFullYear();
  var m = d.getUTCMonth();
  var day = d.getUTCDate();
  var dayBase = Date.UTC(y, m, day);
  return {
    start: dayBase + (workHours[0] - BJ_OFFSET_H) * HOUR_MS,
    end: dayBase + (workHours[1] - BJ_OFFSET_H) * HOUR_MS,
    dow: d.getUTCDay(),
  };
}

/**
 * 找容量足够且时段空闲的会议室（资源日历反查，对标 Outlook 会议室预订）
 * @param {object} company
 * @param {number} capacity 参会人数
 * @param {number} start / end 会议时段（Unix ms）
 * @returns {object|null} {roomId, name, location, capacity, facilities}
 */
function findFreeRoom(company, capacity, start, end) {
  var rooms = company.rooms || [];
  var calendars = company.roomCalendars || {};
  for (var i = 0; i < rooms.length; i++) {
    var room = rooms[i];
    if (!room.capacity || room.capacity < capacity) continue;
    if (!room.roomId) continue;
    var busy = (calendars[room.roomId] || []).some(function(b) {
      var bs = new Date(b.start).getTime();
      var be = new Date(b.end).getTime();
      return !isNaN(bs) && !isNaN(be) && bs < end && be > start;
    });
    if (!busy) {
      return { roomId: room.roomId, name: room.name, location: room.location, capacity: room.capacity, facilities: room.facilities };
    }
  }
  return null;
}

/**
 * 时间窗内公共空闲槽位生成 + 打分
 * @param {object} company
 * @param {Array<string>} empIds 参会人（不含发起人时发起人可选）
 * @param {number} durationMin 会议时长（分钟）
 * @param {number} windowStart / windowEnd 时间窗（Unix ms）
 * @param {object} opts { workHours?: [startH, endH]（北京时间）, maxCandidates?: number, requireRoom?: boolean }
 * @returns {Array<{ start, end, score, conflicts: number, room: object|null }>} 建议槽位（score 降序）
 */
function suggestSlots(company, empIds, durationMin, windowStart, windowEnd, opts) {
  opts = opts || {};
  var workHours = opts.workHours || [9, 18];
  var maxCandidates = opts.maxCandidates || 5;
  if (!durationMin || durationMin <= 0) return [];
  var durMs = durationMin * 60000;
  if (!empIds || !empIds.length) return [];

  // 去重（会议室容量按真实人数计）
  var seenIds = {};
  empIds = empIds.filter(function(id) {
    if (!id || seenIds[id]) return false;
    seenIds[id] = true;
    return true;
  });
  if (!empIds.length) return [];

  var fb = queryFreeBusy(company, empIds, windowStart, windowEnd);
  var busy = fb.busy;

  // 反集：逐工作日 [dayStart, dayEnd) 内跳过忙区间，收集空闲区间
  var free = [];
  var cursor = windowStart;
  while (cursor < windowEnd) {
    var b = _dayBounds(cursor, workHours);
    var dayStart = Math.max(b.start, cursor);
    var dayEnd = Math.min(b.end, windowEnd);
    if (b.dow === 0 || b.dow === 6 || dayEnd <= dayStart) {
      cursor = b.start + DAY_MS; // 周末或当天无有效时段 → 下一工作日
      continue;
    }
    // 当天内扫描忙区间（busy 全局排序，跨天忙块如 OOO 由 t 推进覆盖）
    var t = dayStart;
    for (var i = 0; i < busy.length; i++) {
      var bs = busy[i].start, be = busy[i].end;
      if (be <= t) continue;
      if (bs >= dayEnd) break;
      if (bs > t) free.push({ start: t, end: Math.min(bs, dayEnd) });
      if (be > t) t = Math.max(t, be);
      if (t >= dayEnd) break;
    }
    if (t < dayEnd) free.push({ start: t, end: dayEnd });
    cursor = b.start + DAY_MS;
  }

  // 槽位生成：每个空闲区间切出满足时长的起始点
  // 粒度 30 分钟（业界日历惯例：约会整点/半点起始好管理，对标 Outlook 30 分钟网格/飞书日程）；
  // 起始点按北京时间向上对齐到整点/半点（空闲区间从 16:18 开始 → 首个槽 16:30）
  var slots = [];
  free.forEach(function(f) {
    if (f.end - f.start < durMs) return;
    var bjMin0 = (f.start + BJ_OFFSET_H * HOUR_MS) / 60000; // 北京时间当天分钟数
    var alignedMin = Math.ceil(bjMin0 / 30) * 30;
    var t0 = alignedMin * 60000 - BJ_OFFSET_H * HOUR_MS; // 转回 UTC ms
    for (var t = t0; t + durMs <= f.end; t += 30 * 60000) {
      slots.push({ start: t, end: t + durMs });
    }
  });

  // 打分：时段偏好（北京时间 9:00-11:30 上午 = 1.0；14:00-17:30 下午 = 0.8；午休/边缘 = 0.5）
  slots.forEach(function(s) {
    var bj = new Date(s.start + BJ_OFFSET_H * HOUR_MS); // UTC → 北京时间
    var h = bj.getUTCHours() + bj.getUTCMinutes() / 60;
    var pref;
    if (h >= 9 && h < 11.5) pref = 1.0;
    else if (h >= 14 && h < 17.5) pref = 0.8;
    else pref = 0.5;
    s.score = Math.round(pref * 100) / 100;
    // 冲突数（该槽位与多少人忙重叠——全部空闲时为 0）
    s.conflicts = 0; // 空闲区间由合并忙区间反集推导，不可能与个人忙区间重叠
    // 会议室推荐：容量 ≥ 参会人数且该时段空闲的首个会议室（线下会议用）
    s.room = findFreeRoom(company, empIds.length, s.start, s.end);
  });

  // requireRoom：只保留有可用会议室的槽位（线下会议硬约束）
  var candidates = slots;
  if (opts.requireRoom) candidates = slots.filter(function(s) { return s.room !== null; });

  candidates.sort(function(a, b) { return b.score - a.score || a.start - b.start; });
  return candidates.slice(0, maxCandidates).map(function(s) {
    return {
      start: new Date(s.start).toISOString(),
      end: new Date(s.end).toISOString(),
      score: s.score,
      conflicts: s.conflicts,
      room: s.room,
    };
  });
}

module.exports = { queryFreeBusy: queryFreeBusy, suggestSlots: suggestSlots, findFreeRoom: findFreeRoom, BJ_OFFSET_H: BJ_OFFSET_H, HOUR_MS: HOUR_MS, DAY_MS: DAY_MS };
