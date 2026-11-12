import dagre from 'dagre';

export function layoutEvolutionDag(nodes: { id: string }[], edges: { from: string; to: string }[]) {
  const graph = new dagre.graphlib.Graph({ multigraph: true });
  graph.setGraph({ rankdir: 'LR', ranksep: 80, nodesep: 28, marginx: 28, marginy: 50 });
  graph.setDefaultEdgeLabel(() => ({}));
  nodes.forEach(n => graph.setNode(n.id, { width: 280, height: 152 }));
  const ids = new Set(nodes.map(n => n.id));
  const valid = edges.filter(e => ids.has(e.from) && ids.has(e.to) && e.from !== e.to);
  valid.forEach((e, i) => graph.setEdge(e.from, e.to, {}, String(i)));
  // Reject corrupt history explicitly; a cycle must never be drawn as valid evolution.
  if (!dagre.graphlib.alg.isAcyclic(graph)) return null;
  dagre.layout(graph);
  const pos = new Map(nodes.map(n => { const p = graph.node(n.id); return [n.id, { x: p.x - 140, y: p.y }]; }));
  const dimensions = graph.graph();
  return { pos, width: Math.max(640, dimensions.width || 0), height: Math.max(260, dimensions.height || 0) };
}
