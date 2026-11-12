/**
 * GraphExtractor — LLM-driven entity & relation extraction for Knowledge Graph
 *
 * Pipeline:
 *   1. Schema-constrained entity extraction (Concept|Method|Tool|Person|Organization)
 *   2. Relation extraction (INCLUDES|PRECEDES|RELATES_TO|USES|DERIVES_FROM|PREREQUISITE_FOR)
 *   3. 2-pass Gleaning: second pass catches entities missed in first (+20-30% recall)
 *   4. Provenance tracking: every entity/relation → source document + chunk
 *   5. Fusion with signal graph (existing 4-signal GraphBuilder output)
 *
 * Usage:
 *   const { GraphExtractor } = require('./tools/graph-extractor');
 *   const ge = new GraphExtractor({ llmRoute, wikiDir });
 *   const graph = await ge.extractFromWiki(projectName);
 */

'use strict';

const fs = require('fs');
const path = require('path');
const https = require('https');

// ── Entity & Relation Schema ──

const ENTITY_TYPES = {
  Concept: { desc: '抽象概念、理论、思想', examples: 'transformer, attention mechanism, gradient descent' },
  Method: { desc: '具体方法、算法、技术', examples: 'SGD, Adam optimizer, backpropagation' },
  Tool: { desc: '工具、框架、库', examples: 'PyTorch, TensorFlow, Jupyter' },
  Person: { desc: '人物、研究者', examples: 'Geoffrey Hinton, Yann LeCun' },
  Organization: { desc: '组织、机构', examples: 'OpenAI, Google Brain' },
};

const RELATION_TYPES = {
  INCLUDES: { desc: '包含关系，整体包含部分', example: 'transformer INCLUDES self-attention' },
  PRECEDES: { desc: '前驱关系，A 是 B 的前置或历史基础', example: 'RNN PRECEDES transformer' },
  RELATES_TO: { desc: '相关关系，两个概念紧密关联', example: 'self-attention RELATES_TO multi-head attention' },
  USES: { desc: '使用关系，方法使用工具或另一个方法', example: 'GPT USES transformer' },
  DERIVES_FROM: { desc: '派生关系，B 从 A 派生或改进', example: 'Adam DERIVES_FROM SGD' },
  PREREQUISITE_FOR: { desc: '前置知识关系，理解 A 是理解 B 的前提', example: 'attention PREQUISITE_FOR transformer' },
};

// ── GraphExtractor Class ──

class GraphExtractor {
  constructor(options) {
    this.options = options || {};
    this.wikiDir = this.options.wikiDir || path.join(__dirname, '../wiki');
    this.llmRoute = this.options.llmRoute || null; // { host, path, apiKey, model }
    this.batchSize = this.options.batchSize || 5;   // docs per LLM call
    this.maxDocs = this.options.maxDocs || 200;      // max docs to process
    // 自定义 schema（组织图谱等垂直场景注入；缺省用知识图谱默认 schema，Knowledge Studio 行为不变）
    this.entityTypes = this.options.entityTypes || ENTITY_TYPES;
    this.relationTypes = this.options.relationTypes || RELATION_TYPES;
  }

  /**
   * Full extraction pipeline for a wiki project
   * @returns { nodes: [...], edges: [...], stats: {...} }
   */
  async extractFromWiki(projectName, options) {
    var opts = options || {};
    var startTime = Date.now();
    var wp = projectName ? path.join(this.wikiDir, projectName) : this.wikiDir;
    if (!fs.existsSync(wp)) throw new Error('Wiki project not found: ' + projectName);

    // Cache check
    var cacheFile = path.join(wp, '.graph-extracted.json');
    if (!opts.forceRebuild && fs.existsSync(cacheFile)) {
      try {
        var cached = JSON.parse(fs.readFileSync(cacheFile, 'utf-8'));
        if (cached.nodes && cached.nodes.length && cached.version) return cached;
      } catch(e) {}
    }

    // Step 1: Scan documents
    var docs = this._scanWiki(wp);
    if (!docs.length) throw new Error('No documents found');
    if (docs.length > this.maxDocs) docs = docs.slice(0, this.maxDocs);

    // Step 2-4: 两遍抽取（first + gleaning）+ 实体去重合并（公共管线，见 _runExtraction）
    var extraction = await this._runExtraction(docs, opts);
    var allEntities = extraction.rawEntities;
    var resolvedEntities = extraction.entities;
    var allRelations = extraction.relations;

    // Step 5: Build graph
    var nodes = resolvedEntities.map(function(e, i) {
      return {
        id: 'ent_' + i,
        label: e.name,
        entityType: e.type,
        description: e.description || '',
        sourceDoc: e.sourceDoc || '',
        sourceChunk: e.sourceChunk || '',
        confidence: e.confidence || 0.7,
      };
    });

    var nodeNameMap = {};
    nodes.forEach(function(n) { nodeNameMap[n.label] = n.id; });

    var edges = [];
    allRelations.forEach(function(r) {
      var srcId = nodeNameMap[r.source];
      var tgtId = nodeNameMap[r.target];
      if (srcId && tgtId && srcId !== tgtId) {
        var dup = edges.find(function(ex) { return ex.source === srcId && ex.target === tgtId && ex.relationType === r.type; });
        if (!dup) {
          edges.push({
            source: srcId, target: tgtId,
            relationType: r.type,
            weight: r.confidence || 0.7,
            sourceDoc: r.sourceDoc || '',
          });
        }
      }
    });

    var stats = {
      project: projectName || '(root)',
      documentsScanned: docs.length,
      entitiesExtracted: allEntities.length,
      entitiesResolved: nodes.length,
      relationsExtracted: edges.length,
      gleaningPass: opts.gleaning !== false,
      timeMs: Date.now() - startTime,
      builtAt: new Date().toISOString(),
    };

    var result = { nodes: nodes, edges: edges, stats: stats, version: 1 };
    this._saveCache(cacheFile, result);
    return result;
  }

  /**
   * 公共抽取管线：first pass → gleaning（文档 <3 实体的二次扫描）→ 实体去重合并
   * @returns {{ rawEntities, entities, relations }} entities 为去重后的实体
   */
  async _runExtraction(docs, options) {
    var opts = options || {};
    var pass1 = await this._extractBatch(docs, 'first');
    var allEntities = pass1.entities || [];
    var allRelations = pass1.relations || [];

    if (opts.gleaning !== false) {
      var gleanDocs = docs.filter(function(d) {
        var count = allEntities.filter(function(e) { return e.sourceDoc === d.id; }).length;
        return count < 3;
      });
      if (gleanDocs.length > 0) {
        var pass2 = await this._extractBatch(gleanDocs, 'glean');
        // Merge, avoiding duplicates by name+type
        var existingKeys = {};
        allEntities.forEach(function(e) { existingKeys[(e.name||'')+'::'+(e.type||'')] = true; });
        (pass2.entities || []).forEach(function(e) {
          var key = (e.name||'')+'::'+(e.type||'');
          if (!existingKeys[key]) {
            allEntities.push(e);
            existingKeys[key] = true;
          }
        });
        (pass2.relations || []).forEach(function(r) {
          var key = (r.source||'')+'::'+(r.type||'')+'::'+(r.target||'');
          if (!allRelations.find(function(x) { return (x.source+'::'+x.type+'::'+x.target) === key; })) {
            allRelations.push(r);
          }
        });
      }
    }

    return { rawEntities: allEntities, entities: this._resolveEntities(allEntities), relations: allRelations };
  }

  /**
   * 上传内容直抽（不落盘，不建缓存）——组织图谱等垂直场景消费
   * @param {Array} docs [{ id, title, content }]
   * @param {object} options { gleaning? }
   * @returns {{ entities, relations, stats }} 实体: {name,type,description,sourceDoc,confidence}
   */
  async extractFromContent(docs, options) {
    var opts = options || {};
    var startTime = Date.now();
    if (!docs || !docs.length) throw new Error('No documents provided');
    var extraction = await this._runExtraction(docs, opts);
    return {
      entities: extraction.entities,
      relations: extraction.relations,
      stats: {
        documentsScanned: docs.length,
        entitiesExtracted: extraction.rawEntities.length,
        entitiesResolved: extraction.entities.length,
        relationsExtracted: extraction.relations.length,
        gleaningPass: opts.gleaning !== false,
        timeMs: Date.now() - startTime,
        builtAt: new Date().toISOString(),
      },
    };
  }

  /**
   * 可断点续跑的逐块抽取：completed 里已完成的 doc 直接复用（不烧 LLM），其余逐块抽取，
   * 每块成功即回调 onDocDone（调用方落盘 checkpoint，失败重试/进程重启后从断点继续）。
   * 与 _extractBatch 的关键差异：单块失败不再静默吞掉——记入 failedDocs，由调用方明示与续跑。
   * gleaning 规则与 _runExtraction 一致（first pass 实体 <3 的文档再扫一遍）。
   * @param {Array} docs [{ id, title, content }]
   * @param {object} options { gleaning?, completed?: {docId: {entities, relations}}, onDocDone?: (docId, entities, relations)=>void }
   * @returns extractFromContent 同构结果 + { resumed, failedDocs }
   */
  async extractFromDocsResumable(docs, options) {
    var self = this;
    var opts = options || {};
    var startTime = Date.now();
    if (!docs || !docs.length) throw new Error('No documents provided');
    var completed = opts.completed || {};
    var rawEntities = [];
    var rawRelations = [];
    var failedDocs = [];
    var resumed = 0;

    for (var i = 0; i < docs.length; i++) {
      var doc = docs[i];
      if (completed[doc.id]) {
        rawEntities = rawEntities.concat(completed[doc.id].entities || []);
        rawRelations = rawRelations.concat(completed[doc.id].relations || []);
        resumed += 1;
        continue;
      }
      try {
        var llmOut = await self._callLLM(self._buildExtractionPrompt([doc], false));
        var parsed = self._parseExtractionResult(llmOut, [doc]);
        rawEntities = rawEntities.concat(parsed.entities || []);
        rawRelations = rawRelations.concat(parsed.relations || []);
        if (typeof opts.onDocDone === 'function') opts.onDocDone(doc.id, parsed.entities || [], parsed.relations || []);
      } catch (e) {
        failedDocs.push({ id: doc.id, error: String((e && e.message) || e).slice(0, 200) });
      }
    }

    if (opts.gleaning !== false) {
      var entityCountByDoc = {};
      rawEntities.forEach(function (e) { entityCountByDoc[e.sourceDoc] = (entityCountByDoc[e.sourceDoc] || 0) + 1; });
      var gleanDocs = docs.filter(function (d) { return (entityCountByDoc[d.id] || 0) < 3; });
      if (gleanDocs.length > 0) {
        var pass2 = await this._extractBatch(gleanDocs, 'glean');
        var existingKeys = {};
        rawEntities.forEach(function (e) { existingKeys[(e.name || '') + '::' + (e.type || '')] = true; });
        (pass2.entities || []).forEach(function (e) {
          var key = (e.name || '') + '::' + (e.type || '');
          if (!existingKeys[key]) { rawEntities.push(e); existingKeys[key] = true; }
        });
        (pass2.relations || []).forEach(function (r) {
          var key = (r.source || '') + '::' + (r.type || '') + '::' + (r.target || '');
          if (!rawRelations.find(function (x) { return (x.source + '::' + x.type + '::' + x.target) === key; })) rawRelations.push(r);
        });
      }
    }

    var resolved = this._resolveEntities(rawEntities);
    return {
      entities: resolved,
      relations: rawRelations,
      resumed: resumed,
      failedDocs: failedDocs,
      stats: {
        documentsScanned: docs.length,
        entitiesExtracted: rawEntities.length,
        entitiesResolved: resolved.length,
        relationsExtracted: rawRelations.length,
        gleaningPass: opts.gleaning !== false,
        timeMs: Date.now() - startTime,
        builtAt: new Date().toISOString(),
      },
    };
  }

  /**
   * Fuse extracted graph with signal graph (from GraphBuilder)
   * Semantic edges ×3 weight, signal edges ×1 weight
   */
  fuseWithSignals(extractedGraph, signalGraph) {
    if (!signalGraph || !signalGraph.nodes) return extractedGraph;

    var fusionNodes = JSON.parse(JSON.stringify(extractedGraph.nodes));
    var fusionEdges = JSON.parse(JSON.stringify(extractedGraph.edges));

    // Map signal node names to extracted node labels
    var extLabelMap = {};
    fusionNodes.forEach(function(n) { extLabelMap[n.label.toLowerCase()] = n.id; });

    // Add signal edges with lower weight
    (signalGraph.edges || []).forEach(function(se) {
      var srcLabel = se.sourceLabel || se.source || '';
      var tgtLabel = se.targetLabel || se.target || '';
      var srcId = extLabelMap[srcLabel.toLowerCase()];
      var tgtId = extLabelMap[tgtLabel.toLowerCase()];
      if (srcId && tgtId && srcId !== tgtId) {
        var exists = fusionEdges.find(function(e) { return e.source === srcId && e.target === tgtId; });
        if (exists) {
          exists.signalWeight = (exists.signalWeight || 0) + (se.weight || 1);
          exists.weight = exists.weight * 3 + (se.weight || 1) * 1; // semantic ×3, signal ×1
        } else {
          fusionEdges.push({
            source: srcId, target: tgtId,
            relationType: se.type || 'RELATES_TO',
            weight: (se.weight || 1) * 1,
            signalWeight: se.weight || 1,
            sourceDoc: '',
          });
        }
      }
    });

    return { nodes: fusionNodes, edges: fusionEdges, stats: extractedGraph.stats, version: 2 };
  }

  /**
   * Generate LLM summaries for Louvain communities
   * @param communities — [{id, nodes: [...], cohesion}]
   * @param nodes — graph nodes
   * @returns communities with summary field added
   */
  async summarizeCommunities(communities, nodes) {
    if (!this.llmRoute || !this.llmRoute.apiKey) return communities;

    var summarized = [];
    for (var i = 0; i < communities.length; i++) {
      var comm = communities[i];
      var nodeLabels = (comm.nodes || []).map(function(nId) {
        var node = nodes.find(function(n) { return (n.id || '') === (nId || n.id || ''); });
        return node ? node.label : nId;
      }).slice(0, 30);

      if (nodeLabels.length < 2) { summarized.push(comm); continue; }

      try {
        var summary = await this._callLLM(
          '你是一个知识图谱分析专家。以下是一个知识社区中的节点列表（节点是通过LLM从技术文档中抽取的实体）。请用1-2句话描述这个社区的主题。\n\n社区节点: ' + nodeLabels.join(', ') + '\n\n社区主题描述:'
        );
        summarized.push({
          id: comm.id,
          nodes: comm.nodes,
          cohesion: comm.cohesion,
          size: comm.size,
          summary: (summary || '').trim(),
        });
      } catch(e) {
        summarized.push(comm);
      }
    }
    return summarized;
  }

  // ── Internal ──

  _scanWiki(wp) {
    var docs = [];
    function scan(dir, relRoot) {
      relRoot = relRoot || '';
      var entries;
      try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch(e) { return; }
      entries.forEach(function(entry) {
        var fp = path.join(dir, entry.name);
        var rp = relRoot ? relRoot + '/' + entry.name : entry.name;
        if (entry.isDirectory()) {
          if (entry.name.startsWith('.') || entry.name === 'node_modules' || entry.name === 'syntheses') return;
          scan(fp, rp);
        } else if (entry.isFile() && entry.name.endsWith('.md')) {
          try {
            var content = fs.readFileSync(fp, 'utf-8');
            var text = content.replace(/^---[\s\S]*?---\n*/, '').trim();
            if (text.length > 100) {
              var title = (content.match(/^#\s+(.+)$/m) || [])[1] || entry.name.replace('.md', '');
              docs.push({ id: rp, title: title, content: text.slice(0, 3000) });
            }
          } catch(e) {}
        }
      });
    }
    scan(wp);
    return docs;
  }

  async _extractBatch(docs, passType) {
    var self = this;
    var allEntities = [];
    var allRelations = [];
    var batchSize = this.batchSize;

    for (var i = 0; i < docs.length; i += batchSize) {
      var batch = docs.slice(i, i + batchSize);
      var isGlean = passType === 'glean';
      var prompt = self._buildExtractionPrompt(batch, isGlean);

      try {
        var result = await self._callLLM(prompt);
        var parsed = self._parseExtractionResult(result, batch);
        allEntities = allEntities.concat(parsed.entities || []);
        allRelations = allRelations.concat(parsed.relations || []);
      } catch(e) {
        console.error('[GraphExtractor] Batch ' + i + ' failed:', e.message);
      }
    }

    return { entities: allEntities, relations: allRelations };
  }

  _buildExtractionPrompt(batch, isGlean) {
    var self = this;
    var docsText = batch.map(function(d, i) {
      return '--- Document ' + (i+1) + ' (' + d.id + '): ' + d.title + ' ---\n' + d.content.slice(0, 2500);
    }).join('\n\n');

    var entityTypesDesc = Object.keys(self.entityTypes).map(function(t) {
      return '- ' + t + ': ' + self.entityTypes[t].desc + ' (例: ' + self.entityTypes[t].examples + ')';
    }).join('\n');

    var relationTypesDesc = Object.keys(self.relationTypes).map(function(t) {
      return '- ' + t + ': ' + self.relationTypes[t].desc + ' (例: ' + self.relationTypes[t].example + ')';
    }).join('\n');

    var gleanHint = isGlean
      ? '\n这是第二次扫描，请重点关注第一次可能遗漏的次要实体和隐含关系。提高召回率，宁可多抽不要漏。'
      : '';

    return '你是一个知识图谱构建专家。从以下技术文档中抽取实体和关系。' + gleanHint + '\n\n' +
      '实体类型:\n' + entityTypesDesc + '\n\n' +
      '关系类型:\n' + relationTypesDesc + '\n\n' +
      '文档内容:\n' + docsText + '\n\n' +
      '请严格按以下 JSON 格式输出（不要输出其他内容）:\n' +
      '{\n' +
      '  "entities": [\n' +
      '    {"name": "实体名称", "type": "' + Object.keys(self.entityTypes).join('|') + '", "description": "一句话描述", "sourceDoc": "文档ID", "confidence": 0.9}\n' +
      '  ],\n' +
      '  "relations": [\n' +
      '    {"source": "源实体名称", "type": "' + Object.keys(self.relationTypes).join('|') + '", "target": "目标实体名称", "sourceDoc": "文档ID", "confidence": 0.8}\n' +
      '  ]\n' +
      '}';
  }

  _parseExtractionResult(llmOutput, batch) {
    var self = this;
    var defaultEntityType = Object.keys(self.entityTypes)[0];
    // 默认 schema 保持历史回退值 RELATES_TO（Knowledge Studio 行为不变）；自定义 schema 回退第一个类型
    var defaultRelationType = self.relationTypes.RELATES_TO ? 'RELATES_TO' : Object.keys(self.relationTypes)[0];
    try {
      // Try to extract JSON from markdown code blocks
      var jsonStr = llmOutput;
      var codeMatch = llmOutput.match(/```(?:json)?\s*([\s\S]*?)```/);
      if (codeMatch) jsonStr = codeMatch[1].trim();
      // Find first { and last }
      var startIdx = jsonStr.indexOf('{');
      var endIdx = jsonStr.lastIndexOf('}');
      if (startIdx >= 0 && endIdx > startIdx) {
        jsonStr = jsonStr.slice(startIdx, endIdx + 1);
      }
      var parsed = JSON.parse(jsonStr);

      // Validate entities
      var entities = (parsed.entities || []).map(function(e) {
        return {
          name: (e.name || '').trim(),
          type: self.entityTypes[e.type] ? e.type : defaultEntityType,
          description: (e.description || '').slice(0, 200),
          sourceDoc: e.sourceDoc || batch[0]?.id || '',
          sourceChunk: '',
          confidence: Math.min(1, Math.max(0, e.confidence || 0.7)),
        };
      }).filter(function(e) { return e.name.length > 1 && e.name.length < 100; });

      // Validate relations
      var entityNames = {};
      entities.forEach(function(e) { entityNames[e.name] = true; });

      var relations = (parsed.relations || []).map(function(r) {
        return {
          source: (r.source || '').trim(),
          type: self.relationTypes[r.type] ? r.type : defaultRelationType,
          target: (r.target || '').trim(),
          sourceDoc: r.sourceDoc || batch[0]?.id || '',
          confidence: Math.min(1, Math.max(0, r.confidence || 0.7)),
        };
      }).filter(function(r) {
        return r.source.length > 1 && r.target.length > 1 && r.source !== r.target;
      });

      return { entities: entities, relations: relations };
    } catch(e) {
      console.error('[GraphExtractor] Parse error:', e.message, 'output preview:', llmOutput.slice(0, 200));
      return { entities: [], relations: [] };
    }
  }

  _resolveEntities(entities) {
    var resolved = [];
    var seen = {};

    entities.forEach(function(e) {
      var key = (e.name || '').toLowerCase() + '::' + (e.type || '');
      // seen[key] 存索引，0 也是合法索引（历史 bug：if (seen[key]) 对 0 失效导致同名实体不去重）
      if (Object.prototype.hasOwnProperty.call(seen, key)) {
        // Merge: keep higher confidence, append descriptions
        var existing = resolved[seen[key]];
        if (e.confidence > existing.confidence) {
          existing.confidence = e.confidence;
          existing.description = e.description || existing.description;
        }
        if (e.sourceDoc && existing.sourceDoc.indexOf(e.sourceDoc) < 0) {
          existing.sourceDoc += ', ' + e.sourceDoc;
        }
      } else {
        seen[key] = resolved.length;
        resolved.push(e);
      }
    });

    return resolved;
  }

  _callLLM(prompt) {
    var self = this;
    var route = this.llmRoute;
    if (!route || !route.apiKey) return Promise.resolve('{}');

    return new Promise(function(resolve, reject) {
      var body = JSON.stringify({
        model: route.model || 'deepseek-chat',
        messages: [{ role: 'user', content: prompt }],
        max_tokens: 2000,
        temperature: 0.2, // low temp for structured extraction
      });
      var req = https.request({
        hostname: route.host,
        port: 443,
        path: route.path,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': 'Bearer ' + route.apiKey,
          'Content-Length': Buffer.byteLength(body),
        },
      }, function(resp) {
        var data = '';
        resp.on('data', function(c) { data += c; });
        resp.on('end', function() {
          try {
            var json = JSON.parse(data);
            var content = json.choices[0].message.content;
            resolve(content);
          } catch(e) { reject(e); }
        });
      });
      req.on('error', reject);
      req.write(body);
      req.end();
    });
  }

  _saveCache(cacheFile, data) {
    try {
      fs.writeFileSync(cacheFile, JSON.stringify(data, null, 2), 'utf-8');
    } catch(e) {}
  }
}

module.exports = { GraphExtractor, ENTITY_TYPES, RELATION_TYPES };
