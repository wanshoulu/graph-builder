/** Task identity belongs to each browser URL; no process/global active-task switch. */
export function currentTaskId(): string | null {
  return typeof window === 'undefined' ? null : new URLSearchParams(window.location.search).get('taskId');
}
export function taskScopedPath(path: string, taskId: string | null = currentTaskId()): string {
  const [pathname, query = ''] = path.split('?');
  const params = new URLSearchParams(query);
  const globalPath = ['/tasks', '/tasks/create', '/bases', '/optimization-capabilities', '/import-graph-file', '/split-preview'].includes(pathname);
  if (taskId) params.set('taskId', taskId);
  else if (!globalPath) throw new Error('请先选择任务，再执行此操作');
  return `${pathname}${params.size ? `?${params}` : ''}`;
}
export function createTaskPayload(v: Record<string, any>, cases: Record<string, unknown>[] | null, casesName: string) {
  if (v.casesSource === 'file' && !cases?.length) throw new Error('请先选择包含题目的评测集文件');
  if (v.casesSource === 'dataset' && !v.evalDatasetId) throw new Error('请选择评测数据集');
  return { name: v.name, description: v.description || '', base: v.base || 'seed', casesSource: v.casesSource || 'inherit',
    engine: v.engine || undefined, multiIntentAdapter: v.multiIntentAdapter === true, trainRatio: v.trainRatio ?? .7, testRatio: v.withTest ? (v.testRatio ?? .15) : 0,
    ...(v.casesSource === 'dataset' ? { datasetId: v.evalDatasetId } : {}),
    ...(v.casesSource === 'file' ? { cases, casesName: casesName.replace(/\.json$/i, '') } : {}),
  };
}
