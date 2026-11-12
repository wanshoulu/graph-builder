import {useEffect,useState} from 'react';
import {Alert,Button,Collapse,Descriptions,Form,Input,Modal,Radio,Select,Space,Steps,Switch,Typography,Upload,message} from 'antd';
import {UploadOutlined} from '@ant-design/icons';
import {rsiRequest} from './rsiShared';
import {createTaskPayload} from './rsiTaskContext';
import {matchingDatasets,validateSetupStep} from './rsiTaskSetup';

type Dataset={datasetId:string;name:string;graph:string|null;graphVersionId?:string|null;caseCount:number;shapeCounts?:Record<string,number>;createdAt?:string|null};
type Props={open:boolean;snapshots:{id:string;label:string}[];manifestVersions:{versionId:string;name:string;status:string|null;intentCount?:number|null;imported:boolean}[];
 sourceGraphs:unknown[];evalDatasets:Dataset[];onClose:()=>void;onCreated:(id:string)=>void;onImported?:(id:string)=>void;assetsLoading?:boolean;assetsError?:string;onRetryAssets?:()=>void};
export function CreateTaskModal({open,snapshots,manifestVersions,evalDatasets,onClose,onCreated,onImported,assetsLoading,assetsError,onRetryAssets}:Props){
 const [form]=Form.useForm();
 const [step,setStep]=useState(0),[busy,setBusy]=useState(false),[fileCases,setFileCases]=useState<Record<string,unknown>[]|null>(null),[fileName,setFileName]=useState('');
 const [preview,setPreview]=useState<{total:number;split:{trainCount:number;heldoutCount:number;testCount:number};warnings?:string[]}|null>(null),[previewError,setPreviewError]=useState('');
 const base=Form.useWatch('base',form),source=Form.useWatch('casesSource',form),datasetId=Form.useWatch('evalDatasetId',form),train=Form.useWatch('trainRatio',form)??.7,test=Form.useWatch('testRatio',form)??.15,withTest=Form.useWatch('withTest',form)??true,adapter=Form.useWatch('multiIntentAdapter',form);
 const recommended=matchingDatasets(base,evalDatasets);
 const options=[...manifestVersions.map(v=>({value:`manifest:${v.versionId}`,label:`${v.name}${v.intentCount!=null?`（${v.intentCount}个意图）`:''}${v.status==='active_default'?' · 当前使用':''}`})),...snapshots.filter(s=>!manifestVersions.some(v=>v.versionId===s.id)).map(s=>({value:`snapshot:${s.id}`,label:s.label})),...(base==='seed'?[{value:'seed',label:'内置演示图谱（仅供体验）'}]:[])];
 useEffect(()=>{if(open){setStep(0);setPreview(null);setPreviewError('');}},[open]);
 useEffect(()=>{
  if(!open||step!==2||source==='none')return;
  let active=true;setPreview(null);setPreviewError('');
  const timer=setTimeout(()=>rsiRequest<{total:number;split:{trainCount:number;heldoutCount:number;testCount:number};warnings?:string[]}>('/split-preview',{base,casesSource:source,datasetId,cases:source==='file'?fileCases:undefined,trainRatio:train,testRatio:withTest?test:0,multiIntentAdapter:adapter===true})
   .then(r=>{if(active)setPreview(r);}).catch(e=>{if(active)setPreviewError(e.message);}),200);
  return()=>{active=false;clearTimeout(timer);};
 },[open,step,base,source,datasetId,fileCases,train,test,withTest,adapter]);
 const next=async()=>{try{const values=form.getFieldsValue(true),error=validateSetupStep(step,values,!!fileCases?.length);if(error)throw new Error(error);await form.validateFields(step===0?['name','base']:source==='dataset'?['evalDatasetId']:[]);setStep(step+1);}catch(e){if((e as Error).message)message.error((e as Error).message);}};
 const submit=async()=>{try{
  const v=form.getFieldsValue(true);for(const n of [0,1]){const error=validateSetupStep(n,v,!!fileCases?.length);if(error)throw new Error(error);}
  if(previewError)throw new Error(previewError);setBusy(true);
  const r=await rsiRequest<{task:{id:string;name:string}}>('/tasks/create',createTaskPayload(v,fileCases,fileName));
  message.success(source==='none'?`任务「${r.task.name}」已保存，请先准备题目`:`任务「${r.task.name}」已创建，可以评测当前识别效果`);
  form.resetFields();setFileCases(null);setFileName('');onCreated(r.task.id);
 }catch(e){message.error((e as Error).message||'任务未创建，请检查配置后重试');}finally{setBusy(false);}};
 const readFile=(file:File)=>{
  if(file.size>10*1024*1024){message.error('文件最大10 MB');return false;}
  const reader=new FileReader();reader.onload=()=>{try{const data=JSON.parse(String(reader.result)),rows=Array.isArray(data)?data:data.cases;if(!Array.isArray(rows)||!rows.length)throw new Error('文件中没有题目，请使用图谱评测导出的JSON文件');setFileCases(rows);setFileName(file.name);}catch(e){setFileCases(null);setFileName('');message.error((e as Error).message);}};reader.readAsText(file);return false;
 };
 const graphLabel=options.find(o=>o.value===base)?.label||'尚未选择';
 return <Modal title="新建识别优化任务" open={open} onCancel={onClose} width={720} destroyOnClose
  styles={{body:{maxHeight:'68vh',overflowY:'auto',paddingRight:6}}}
  footer={<Space><Button onClick={onClose} disabled={busy}>取消</Button>{step>0&&<Button onClick={()=>setStep(step-1)} disabled={busy}>上一步</Button>}<Button type="primary" loading={busy} disabled={step===2&&source!=='none'&&(!preview||!!previewError)} onClick={step<2?next:submit}>{step===0?'下一步：准备题目':step===1?'下一步：确认任务':'创建任务'}</Button></Space>}>
  <Typography.Paragraph type="secondary">选择要改善的业务图谱，再准备一套能检验效果的题目。创建任务只保存配置，不会启动模型调用，也不会修改线上图谱。</Typography.Paragraph>
  <Steps size="small" current={step} items={[{title:'选择业务'},{title:'准备题目'},{title:'确认任务'}]} style={{marginBottom:24}}/>
  <Form form={form} layout="vertical" initialValues={{casesSource:'none',trainRatio:.7,withTest:true,testRatio:.15}}>
   <div hidden={step!==0}>
    <Form.Item name="name" label="任务名称" rules={[{required:true,message:'请输入任务名称'},{max:40,message:'任务名不超过40字'}]} extra="用希望解决的业务问题命名，便于日后查找。"><Input placeholder="例如：减少用户同时查余额和转账时的漏识别" maxLength={40}/></Form.Item>
    <Form.Item name="base" label="要改善哪份业务图谱？" rules={[{required:true,message:'请选择业务图谱'}]} extra="系统会保存一份实验副本；原图谱不受影响。"><Select loading={assetsLoading} showSearch optionFilterProp="label" options={options} placeholder={assetsLoading?'正在加载业务图谱…':'选择你的业务图谱'} onChange={()=>{form.setFieldsValue({casesSource:'none',evalDatasetId:undefined});setPreview(null);}}/></Form.Item>
    {assetsError&&<Alert type="error" showIcon message="业务图谱暂时无法加载" description={assetsError} action={<Button onClick={onRetryAssets}>重新加载</Button>}/>}
    <Form.Item name="description" label="补充说明（可选）"><Input.TextArea rows={2} placeholder="例如：一句话包含多个办理需求时，通常只识别出一个。" maxLength={200}/></Form.Item>
    <Collapse ghost items={[{key:'other',label:'没有合适的图谱？',children:<Space wrap><Button onClick={()=>{form.setFieldsValue({base:'seed',casesSource:'inherit',name:form.getFieldValue('name')||'体验识别优化示例'});}}>体验内置示例</Button><Upload accept=".json" showUploadList={false} beforeUpload={file=>{if(file.size>10*1024*1024){message.error('文件最大10 MB');return false;}const reader=new FileReader();reader.onload=async()=>{try{const graph=JSON.parse(String(reader.result));const r=await rsiRequest<{snapshot:{id:string;label:string}}>('/import-graph-file',{name:file.name.replace(/\.json$/i,''),graph});onImported?.(r.snapshot.id);form.setFieldsValue({base:`snapshot:${r.snapshot.id}`,casesSource:'none'});message.success('图谱已添加，请继续准备题目');}catch(e){message.error((e as Error).message);}};reader.readAsText(file);return false;}}><Button icon={<UploadOutlined/>}>从文件添加图谱</Button></Upload></Space>}]} />
   </div>
   <div hidden={step!==1}>
    <Typography.Paragraph>评测题目是一组“用户会怎么问”和“应该识别成什么”的例子。系统用它们找出弱点，并检查改动是否有效。</Typography.Paragraph>
    <Form.Item name="casesSource" label="题目从哪里来？"><Radio.Group style={{width:'100%'}}><Space direction="vertical" size={16}>
     {base==='seed'&&<Radio value="inherit">使用示例自带题目</Radio>}
     <Radio value="dataset">使用已有评测题目{recommended.length?'（有匹配的题目）':''}</Radio>
     <Radio value="file">导入题目文件</Radio>
     <Radio value="none">稍后准备，先保存任务</Radio>
    </Space></Radio.Group></Form.Item>
    {source==='dataset'&&<Form.Item name="evalDatasetId" label="选择评测题目" extra={recommended.length?`找到${recommended.length}套与当前图谱版本匹配的题目，优先选择这些。`:'未找到与当前图谱版本直接匹配的题目。选择其他题目时，系统会检查答案是否属于当前图谱。'}><Select showSearch optionFilterProp="label" placeholder="选择一套题目" options={[{label:'与当前图谱匹配',options:recommended.map(d=>({value:d.datasetId,label:`${d.name}（${d.caseCount}题）`}))},{label:'其他题目（创建时检查兼容性）',options:evalDatasets.filter(d=>!recommended.includes(d)).map(d=>({value:d.datasetId,label:`${d.name}（${d.caseCount}题）`}))}].filter(g=>g.options.length)}/></Form.Item>}
    {source==='file'&&<Form.Item label="题目文件" required extra="支持图谱评测导出的JSON文件，最大10 MB。创建前会检查格式与标准答案。"><Upload accept=".json" showUploadList={false} beforeUpload={readFile}><Button icon={<UploadOutlined/>}>{fileCases?`${fileName}（${fileCases.length}题）`:'选择题目文件'}</Button></Upload></Form.Item>}
    {source==='none'&&<Alert showIcon type="info" message="创建后先进入题目准备" description="你可以导入已有题目，或主动让AI生成题目。准备好之后才能开始评测和优化。"/>}
    {(source==='file'||source==='dataset')&&<Collapse ghost items={[{key:'conversion',label:'题型转换选项',children:<Form.Item name="multiIntentAdapter" valuePropName="checked" label="将复合题作为多需求题评测" extra="仅当文件包含复合或复杂题型时需要。保留全部标准答案；未开启时系统会说明哪些题型暂不支持。"><Switch/></Form.Item>}]} />}
   </div>
   <div hidden={step!==2}>
    <Descriptions column={1} size="small" bordered items={[{key:'name',label:'任务',children:form.getFieldValue('name')},{key:'graph',label:'业务图谱',children:graphLabel},{key:'data',label:'评测题目',children:source==='none'?'尚未准备，创建后继续':source==='file'?`${fileName}（${fileCases?.length||0}题）`:source==='inherit'?'示例自带题目':evalDatasets.find(d=>d.datasetId===datasetId)?.name||'尚未选择'}]}/>
    {source!=='none'&&<Typography.Paragraph style={{marginTop:16}}>{preview?`共${preview.total}题：${preview.split.trainCount}题用于发现和修复问题，${preview.split.heldoutCount}题检查是否退步，${preview.split.testCount}题保留到最终验收。`:'正在检查题目和分配数量…'}</Typography.Paragraph>}
    {previewError&&<Alert showIcon type="error" message="题目检查未通过" description={previewError}/>}
    {preview?.warnings?.map((text,i)=><Alert key={i} style={{marginTop:8}} type="warning" message={text}/>)}
    <Alert style={{marginTop:16}} showIcon type="info" message={source==='none'?'下一步：准备评测题目':'下一步：评测当前识别效果'} description="创建后不会自动运行。你可以检查配置，再决定何时启动；每次运行都会显示预算和进展。"/>
    <Collapse ghost style={{marginTop:12}} items={[{key:'advanced',label:'高级评测设置（默认推荐）',children:<><Typography.Paragraph type="secondary">默认70%题目用于优化、15%防止退步、15%留作最终验收。实际数量按题型分层取整。</Typography.Paragraph><Space wrap align="start"><Form.Item name="trainRatio" label="用于优化的比例"><Select style={{width:140}} options={[{value:.6,label:'60%'},{value:.7,label:'70%（推荐）'},{value:.8,label:'80%'}]}/></Form.Item><Form.Item name="withTest" label="保留最终验收题" valuePropName="checked"><Switch aria-label="保留最终验收题"/></Form.Item>{withTest&&<Form.Item name="testRatio" label="最终验收比例"><Select style={{width:130}} options={[{value:.1,label:'10%'},{value:.15,label:'15%（推荐）'}]}/></Form.Item>}</Space></>}]} />
   </div>
  </Form>
 </Modal>;
}
