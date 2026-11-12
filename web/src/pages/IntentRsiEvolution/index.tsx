import { useEffect, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { Button, Typography } from "antd";
import { ArrowLeftOutlined } from "@ant-design/icons";
import RsiEvolutionPanel from "./RsiEvolutionPanel";
import { RsiTaskList } from "./RsiTaskList";
import { COLOR, RULE, TYPE } from "./rsiDesign";

export default function IntentRsiEvolution() {
  const [params, setParams] = useSearchParams();
  const activeTask = params.get("taskId");
  const [taskName, setTaskName] = useState("");
  useEffect(() => {
    // 立即显示 taskId，等 /state 返回后由 RsiEvolutionPanel 的 onTaskName 回调更新为真实名称
    setTaskName(activeTask || "");
  }, [activeTask]);
  const openTask = (id: string | null) => {
    const next = new URLSearchParams(window.location.search);
    next.delete('runId'); next.delete('section');
    if (id) next.set('taskId', id); else next.delete('taskId');
    setParams(next);
  };
  return <div className="rsi-task-page" style={{ maxWidth: 1240, margin: "0 auto", paddingBottom: 48 }}>
    <header style={{ marginBottom: 6 }}>
      {activeTask && <Button type="link" icon={<ArrowLeftOutlined />} onClick={() => openTask(null)} style={{ padding: 0, marginBottom: 6 }}>返回任务列表</Button>}
      <Typography.Title level={3} style={{ margin: 0, fontSize: 22, fontWeight: 650, color: COLOR.textPrimary }}>
        {activeTask ? taskName || "正在加载任务…" : "识别优化任务"}
      </Typography.Title>
      <Typography.Text style={{ display: "block", marginTop: 7, maxWidth: 760, fontSize: TYPE.body, color: COLOR.textSecondary, lineHeight: 1.7 }}>
        {activeTask ? "所有操作保存在本任务的实验副本中，不会自动修改线上图谱。" : "改善用户问题的识别效果：准备题目、运行优化、检查结果，再决定是否采纳。"}
      </Typography.Text>
      <div style={{ height: 1, background: RULE, marginTop: 20 }} />
    </header>
    {activeTask ? <RsiEvolutionPanel key={activeTask} taskId={activeTask} initialGraphKey={activeTask === 'park' ? 'park' : 'bank'} onTaskName={setTaskName} /> : <RsiTaskList onOpenTask={id => openTask(id)} />}
  </div>;
}
