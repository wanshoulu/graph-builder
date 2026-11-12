/**
 * 图谱导入器注册表（routes/org-graph.js /api/org-graph/import 的调度层）
 * 新增数据源 = 新增一个 importer 模块 + 注册一行，routes 主逻辑零改动。
 */
'use strict';

const IMPORTERS = {
  'intent-v21': require('./intent-v21'),
};

function getImporter(kind) {
  return IMPORTERS[kind] || null;
}

module.exports = { getImporter: getImporter, IMPORTERS: IMPORTERS };
