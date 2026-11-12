import {useEffect,useState} from 'react';
import {Alert,Button,Card,Modal,Select,Space,Table,Tag,Typography,Upload,message} from 'antd';
import {DownloadOutlined,UploadOutlined} from '@ant-design/icons';
import {rsiRequest} from './rsiShared';
import {downloadTemplate,localCheck,reportToIssues,shapeDistLine,type LocalIssue,type TemplateCase} from './rsiDatasetImport';

/** 导入结果：成功数 + 后端逐行错误（与本地预检同构渲染） */
type ImportResult = { imported: number; importReport?: { errors?: { index: number; caseId: string | null; reason: string }[] } };

const ISSUE_COLUMNS = [
  { title: '行号', dataIndex: 'index', width: 70, render: (v: number) => v < 0 ? '文件' : v + 1 },
  { title: '题目编号', dataIndex: 'caseId', render: (v: string | null) => v || '未填' },
  { title: '问题', dataIndex: 'reason' },
];

function IssueTable({ issues }: { issues: LocalIssue[] }) {
  return <Table size="small" rowKey={(r) => `${r.index}-${r.reason}`} dataSource={issues} columns={ISSUE_COLUMNS} pagination={issues.length > 8 ? { pageSize: 8 } : false} scroll={{ x: 400 }} />;
}

export function RsiDataPreparation({taskId,hasHistory,onChanged,onGenerate}:{taskId:string;hasHistory:boolean;onChanged:()=>void;onGenerate?:()=>void}){
 const [datasets,setDatasets]=useState<{datasetId:string;name:string;caseCount:number}[]>([]),[selected,setSelected]=useState<string>(),[busy,setBusy]=useState(false);
 // P1④ 导入三步：本地预检 → 预览确认 → 提交；任何一步失败都逐行展示原因
 const [issues,setIssues]=useState<LocalIssue[]|null>(null);
 const [preview,setPreview]=useState<{cases:TemplateCase[];fileName:string}|null>(null);
 useEffect(()=>{let active=true;rsiRequest<{evalDatasets?:{datasetId:string;name:string;caseCount:number}[]}>('/bases',undefined,taskId).then(r=>{if(active)setDatasets(r.evalDatasets||[]);}).catch(()=>{});return()=>{active=false;};},[taskId]);
 const submit=(body:unknown,okText:string)=>{
  const work=async()=>{
   setBusy(true);
   try{
    const r=await rsiRequest<ImportResult>('/import-eval-dataset',body,taskId);
    const errs=reportToIssues(r.importReport);
    if(errs.length){setIssues(errs);message.warning(`已导入 ${r.imported} 道，另有 ${errs.length} 道被拒——原因见下表`);}
    else message.success(`已导入${r.imported}道题目，请重新评测当前识别效果`);
    setPreview(null);onChanged();
   }catch(e){
    // 后端 fail-fast 时错误对象带 importReport（HTTP 层已透出），逐行渲染
    const err=e as Error & {importReport?:{errors?:{index:number;caseId:string|null;reason:string}[]}};
    const errs=reportToIssues(err.importReport);
    if(errs.length){setIssues(errs);message.error('校验失败，未导入任何题目——逐行原因见下表');}
    else message.error(err.message);
   }finally{setBusy(false);}
  };
  if(hasHistory)Modal.confirm({title:'替换评测题目？',content:'题目变更会重新开始本任务的实验，清空当前候选、成绩和版本历史。请先导出需要保留的成果。',okText,cancelText:'取消',onOk:work});else void work();
 };
 const handleFile=(file:File)=>{
  if(file.size>10*1024*1024){message.error('文件最大10 MB');return false;}
  const reader=new FileReader();
  reader.onload=()=>{
   try{
    const parsed=JSON.parse(String(reader.result));
    const raw=Array.isArray(parsed)?parsed:parsed.cases;
    if(!Array.isArray(raw)||!raw.length)throw new Error('文件中没有题目，请使用模板或图谱评测导出的JSON文件');
    const {cases,issues:local}=localCheck(raw);
    setIssues(local.length?local:null);
    if(!cases.length){message.error(`${local.length} 道题全部未通过本地检查——请按下表修正后重试`);return;}
    if(local.length)message.warning(`${local.length} 道题未通过检查，可先修正再导入，或只导入其余 ${cases.length} 道`);
    setPreview({cases,fileName:file.name.replace(/\.json$/i,'')});
   }catch(e){setIssues(null);setPreview(null);message.error((e as Error).message);}
  };
  reader.readAsText(file);
  return false;
 };
 return <Card title="准备评测题目" style={{marginBottom:20}}>
  <Typography.Paragraph>题目需要包含用户的问法和正确答案。导入后会检查答案是否属于当前业务图谱，并分配优化、验证和最终验收题目。</Typography.Paragraph>
  <Space wrap style={{marginBottom:12}}>
   <Select aria-label="选择已有评测题目" placeholder="选择已有评测题目" value={selected} onChange={setSelected} style={{minWidth:240,maxWidth:'100%'}} options={datasets.map(d=>({value:d.datasetId,label:`${d.name}（${d.caseCount}题）`}))}/>
   <Button disabled={!selected||busy} loading={busy} onClick={()=>submit({datasetId:selected},'替换题目')}>导入所选题目</Button>
   <Upload accept=".json" showUploadList={false} beforeUpload={handleFile}><Button loading={busy} icon={<UploadOutlined/>}>从文件导入题目</Button></Upload>
   <Button icon={<DownloadOutlined/>} onClick={downloadTemplate}>下载填写模板</Button>
  </Space>
  <Typography.Text type="secondary" style={{fontSize:12,display:'block',marginBottom:8}}>三种题型（单意图 / 一句话多需求 / 模糊提问）模板里各有一条示例；不确定就先导 3-5 道试错，失败会逐行告诉你原因。</Typography.Text>
  {onGenerate&&<div style={{marginTop:8}}><Typography.Text type="secondary">还没有可用题目？</Typography.Text> <Button onClick={()=>Modal.confirm({title:'让 AI 生成评测题目？',content:`生成会调用模型服务并产生用量，题目仍需人工检查。${hasHistory?'本任务已有历史记录，生成题目会重开实验并清空当前方案、成绩和版本，请先到成果页导出备份。':'生成完成后再评测当前版本。'}`,okText:'生成题目',cancelText:'取消',onOk:onGenerate})}>用 AI 生成题目</Button></div>}

  {/* ── 逐行错误表（本地预检或后端校验产生）── */}
  {issues&&issues.length>0&&<Alert type="error" showIcon style={{marginTop:12}} message={`${issues.length} 道题未通过检查`} description={<IssueTable issues={issues}/>} action={<Button size="small" onClick={()=>setIssues(null)}>知道了</Button>}/>}

  {/* ── 预览确认：题数/题型分布先看清，再落库 ── */}
  {preview&&<Modal
    title={`确认导入「${preview.fileName}」`}
    open
    okText={`导入 ${preview.cases.length} 道题`}
    cancelText="取消"
    confirmLoading={busy}
    onCancel={()=>setPreview(null)}
    onOk={()=>submit({cases:preview.cases,name:preview.fileName},'替换题目')}
  >
   <Typography.Paragraph>检查通过 <b>{preview.cases.length}</b> 道 · 题型分布：<Tag style={{borderRadius:4}}>{shapeDistLine(preview.cases)}</Tag></Typography.Paragraph>
   <Table size="small" rowKey="case_id" dataSource={preview.cases.slice(0,5)} pagination={false} columns={[{title:'编号',dataIndex:'case_id',width:130,ellipsis:true},{title:'问法',dataIndex:'query',ellipsis:true},{title:'题型',dataIndex:'intent_shape',width:90,render:(v:string)=>({single_intent:'单意图',multi_intent:'多意图',ambiguous_intent:'模糊提问'} as Record<string,string>)[v]||v}]}/>
   {preview.cases.length>5&&<Typography.Text type="secondary" style={{fontSize:12}}>仅预览前 5 道，共 {preview.cases.length} 道。</Typography.Text>}
   <Typography.Paragraph type="secondary" style={{fontSize:12,marginTop:8}}>导入后系统还会检查答案是否属于当前业务图谱，不属于的会被拒并逐行说明。</Typography.Paragraph>
  </Modal>}
 </Card>;
}
