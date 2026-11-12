/**
 * AI 自动建图（独立建图模式，与专家建图 /knowledge/graph/builder 平级）
 *
 *   左侧：图谱资产目录列表（可收起）+ 新建入口
 *   右侧：对话式建图工作台（Agent 对话 / 文档 / 表格 → 图谱）
 *
 * 点击左侧列表项切换资产，工作台自动加载该资产模板与草稿续作。
 * 「进入审核精修」把当前产物落草稿后跳转专家建图页续作。
 * 数据与能力全部复用 AI Harbor /api/org-graph/*，与专家建图页同源。
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { Alert, Button, Empty, Spin, Tag, Tooltip, Typography } from 'antd';
import { message } from '@/utils/antdStatic';
import {
  DatabaseOutlined,
  FileTextOutlined,
  RobotOutlined,
  PlusOutlined,
  MenuFoldOutlined,
  MenuUnfoldOutlined,
} from '@ant-design/icons';
import type { GraphAsset, GraphDocument, GraphTemplate } from '@/api/orgGraph';
import { getTemplate, listAssets, saveGraph } from '@/api/orgGraph';
import { AutoBuildPanel } from './auto/AutoBuildPanel';
import { RegisterAssetModal } from '@/pages/GraphManagement/RegisterAssetModal';
import './auto/autoBuildResponsive.css';
import { currentIntentTemplateDocument } from './lib/graphDoc';

const { Title, Text } = Typography;

export default function AutoBuilderPage() {
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();

  const [assets, setAssets] = useState<GraphAsset[]>([]);
  const [assetId, setAssetId] = useState('');
  const [template, setTemplate] = useState<GraphTemplate | null>(null);
  /** 面板最新产物（仅用于「进入审核精修」时落草稿） */
  const [document, setDocument] = useState<GraphDocument | null>(null);
  const [loading, setLoading] = useState(false);
  /** 资产列表加载失败（服务不可达 ≠ 无资产，二者提示不同） */
  const [assetsError, setAssetsError] = useState(false);
  /** 侧边栏收起 */
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  /** 用户是否手动点击了目录项（首次自动加载/深链为 false，点击后切换为 true） */
  const userClickedAssetRef = useRef(false);
  /** 新建资产弹窗 */
  const [registerOpen, setRegisterOpen] = useState(false);

  // 深链（图谱管理/工作台跳入）：?asset= 直接进入工作台
  const initialAssetRef = useRef(searchParams.get('asset') || '');

  const loadAssets = useCallback(async () => {
    setAssetsError(false);
    try {
      const list = await listAssets();
      setAssets(list);
      // 深链：直接选中
      if (list.length) {
        const linked = initialAssetRef.current;
        if (linked && list.some((a) => a.assetId === linked)) {
          setAssetId(linked);
        } else if (!assetId) {
          // 默认选中第一个
          setAssetId(list[0].assetId);
        }
      }
    } catch (e) {
      setAssetsError(true);
      message.error(e instanceof Error ? e.message : '加载资产失败');
    }
  }, [assetId]);

  useEffect(() => {
    loadAssets();
  }, [loadAssets]);

  // 资产切换 → 模板加载（草稿加载由 AutoBuildPanel 内部 useEffect 自行处理）
  useEffect(() => {
    if (!assetId) return;
    let cancelled = false;
    setLoading(true);
    setDocument(null);
    setTemplate(null);
    getTemplate(assetId)
      .then((tpl) => { if (!cancelled) setTemplate(tpl); })
      .catch((e) => { if (!cancelled) message.error(e instanceof Error ? e.message : '加载模板失败'); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [assetId]);

  const handleAssetChange = useCallback((v: string) => {
    userClickedAssetRef.current = true;
    setAssetId(v);
  }, []);

  /** 新建资产成功后：刷新列表 + 选中新建项 */
  const handleAssetCreated = useCallback((id: string) => {
    loadAssets().then(() => {
      setAssetId(id);
    });
  }, [loadAssets]);

  /** 精修跳转：当前产物落草稿（force 与手动保存同语义，旧稿自动归档），编辑器加载该资产草稿续作；空产物绝不落草稿 */
  const handleSwitchToManual = useCallback(async () => {
    const empty = !document || (document.nodes.length === 0 && document.edges.length === 0);
    if (empty) {
      message.info('当前产物为空，未落草稿；编辑器将加载该资产已有草稿', 4);
    } else if (assetId) {
      try {
        await saveGraph(assetId, currentIntentTemplateDocument(assetId, template, document), { force: true });
      } catch {
        message.warning('当前产物落草稿失败，编辑器将加载该资产已有草稿；可回退本页重试', 6);
      }
    }
    navigate(`/knowledge/graph/builder?asset=${encodeURIComponent(assetId)}`);
  }, [document, assetId, template, navigate]);

  const sidebarWidth = sidebarCollapsed ? 48 : 260;

  return (
    <div className="auto-build-page" style={{ display: 'flex', height: 'calc(100vh - 48px)', minHeight: 480 }}>
      {/* ── 左侧：对话式建图工作台（主区域） ── */}
      <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
        {/* 头部 */}
        <div style={{ flexShrink: 0, display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', padding: '8px 16px', borderBottom: '1px solid #e6ebf5' }}>
          <RobotOutlined style={{ fontSize: 18, color: '#1677ff' }} />
          <Title level={4} style={{ margin: 0 }}>AI 自动建图</Title>
          <span style={{ fontSize: 12, color: '#86909c' }}>对话 / 文档 / 表格 → 图谱 · 模板驱动</span>
          {document && Boolean(document.metadata?.sourceFileName) && (document.nodes.length > 0 || document.edges.length > 0) && (
            <Tag color="geekblue" icon={<FileTextOutlined />} style={{ maxWidth: 360 }}>
              来源：{String(document.metadata?.sourceFileName ?? '')}
            </Tag>
          )}
        </div>

        {/* 工作台主体 */}
        <div style={{ flex: 1, minHeight: 0, overflow: 'hidden', display: 'flex', flexDirection: 'column' }}>
          {!assetId && !assetsError && (
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100%' }}>
              <Empty description="请从右侧目录选择图谱资产，或新建图谱开始建图" />
            </div>
          )}

          {!assetId && assetsError && (
            <div style={{ padding: 24, maxWidth: 600, margin: '0 auto' }}>
              <Alert
                type="error"
                showIcon
                message="图谱资产服务不可达"
                description="AI Harbor 图谱服务（org-graph API）当前无法访问，资产列表加载失败。服务恢复后点击重试即可。"
                action={<Button size="small" onClick={loadAssets}>重试</Button>}
              />
            </div>
          )}

          {assetId && !template && loading && (
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100%' }}>
              <Spin tip="加载模板中..." />
            </div>
          )}

          {assetId && !template && !loading && (
            <div style={{ padding: 24, maxWidth: 600, margin: '0 auto' }}>
              <Alert
                type="info"
                showIcon
                message="模板加载失败"
                description="该资产的模板配置可能缺失，请到「图谱管理」检查模板配置。"
              />
            </div>
          )}

          {assetId && template && (
            <AutoBuildPanel
              key={assetId}
              asset={assetId}
              template={template}
              assets={assets}
              onAssetChange={handleAssetChange}
              onGenerated={setDocument}
              onSwitchToManual={handleSwitchToManual}
              openResultOnLoad={userClickedAssetRef.current}
            />
          )}
        </div>
      </div>

      {/* ── 右侧：资产目录列表 ── */}
      <div style={{
        flexShrink: 0,
        width: sidebarWidth,
        transition: 'width 0.2s',
        borderLeft: '1px solid #e6ebf5',
        display: 'flex',
        flexDirection: 'column',
        background: '#fafbfc',
        overflow: 'hidden',
      }}>
        {/* 折叠按钮 */}
        <div style={{
          display: 'flex',
          alignItems: 'center',
          padding: '12px 12px',
          borderBottom: '1px solid #e6ebf5',
          gap: 8,
        }}>
          {!sidebarCollapsed && (
            <Text strong style={{ fontSize: 13, flex: 1, minWidth: 0, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
              图谱目录
            </Text>
          )}
          <Button
            type="text"
            size="small"
            icon={sidebarCollapsed ? <MenuUnfoldOutlined /> : <MenuFoldOutlined />}
            onClick={() => setSidebarCollapsed(!sidebarCollapsed)}
          />
        </div>

        {/* 新建按钮 */}
        {!sidebarCollapsed && (
          <div style={{ padding: '8px 12px' }}>
            <Button
              type="dashed"
              block
              icon={<PlusOutlined />}
              onClick={() => setRegisterOpen(true)}
            >
              新建图谱
            </Button>
          </div>
        )}

        {/* 资产列表 */}
        <div style={{ flex: 1, overflow: 'auto', padding: sidebarCollapsed ? '8px 0' : '8px 8px' }}>
          {sidebarCollapsed ? (
            // 折叠态：仅图标
            <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 8 }}>
              {assets.map((a) => (
                <Tooltip key={a.assetId} title={`${a.name}${a.name_en ? ' / ' + a.name_en : ''}`} placement="left">
                  <Button
                    type="text"
                    size="small"
                    icon={<DatabaseOutlined />}
                    onClick={() => handleAssetChange(a.assetId)}
                    style={{
                      background: a.assetId === assetId ? '#e6f4ff' : undefined,
                      color: a.assetId === assetId ? '#1677ff' : undefined,
                    }}
                  />
                </Tooltip>
              ))}
            </div>
          ) : (
            assets.map((a) => {
              const isActive = a.assetId === assetId;
              const hasDraft = a.hasDraft;
              const hasPublished = a.hasPublished;
              return (
                <div
                  key={a.assetId}
                  onClick={() => handleAssetChange(a.assetId)}
                  style={{
                    padding: '10px 12px',
                    borderRadius: 6,
                    cursor: 'pointer',
                    marginBottom: 4,
                    background: isActive ? '#e6f4ff' : 'transparent',
                    border: isActive ? '1px solid #91caff' : '1px solid transparent',
                    transition: 'background 0.15s, border-color 0.15s',
                  }}
                  onMouseEnter={(e) => { if (!isActive) e.currentTarget.style.background = '#f0f5ff'; }}
                  onMouseLeave={(e) => { if (!isActive) e.currentTarget.style.background = 'transparent'; }}
                >
                  <div style={{ display: 'flex', alignItems: 'flex-start', gap: 6 }}>
                    <DatabaseOutlined style={{ fontSize: 14, color: isActive ? '#1677ff' : '#86909c', marginTop: 2, flexShrink: 0 }} />
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <Text ellipsis style={{ fontSize: 13, fontWeight: isActive ? 600 : 400, display: 'block', color: isActive ? '#1677ff' : undefined }}>
                        {a.name}{a.name_en ? ` / ${a.name_en}` : ''}
                      </Text>
                      <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap', marginTop: 4 }}>
                        {hasDraft && <Tag color="orange" style={{ margin: 0, fontSize: 10, padding: '0 4px', lineHeight: '16px' }}>草稿</Tag>}
                        {hasPublished && <Tag color="green" style={{ margin: 0, fontSize: 10, padding: '0 4px', lineHeight: '16px' }}>已发布</Tag>}
                        {a.builtin && <Tag color="blue" style={{ margin: 0, fontSize: 10, padding: '0 4px', lineHeight: '16px' }}>内置</Tag>}
                        {!hasDraft && !hasPublished && <Tag color="default" style={{ margin: 0, fontSize: 10, padding: '0 4px', lineHeight: '16px' }}>未开始</Tag>}
                      </div>
                      {/* 统计 */}
                      <div style={{ fontSize: 11, color: '#bfbfbf', marginTop: 4 }}>
                        {a.activeStats ? `节点 ${a.activeStats.nodes} · 关系 ${a.activeStats.edges}` : `${a.nodeTypes.length} 节点类型 · ${a.edgeTypes.length} 关系类型`}
                      </div>
                    </div>
                  </div>
                </div>
              );
            })
          )}

          {/* 空列表提示 */}
          {!sidebarCollapsed && assets.length === 0 && !assetsError && (
            <div style={{ textAlign: 'center', padding: '24px 12px' }}>
              <Empty description="暂无资产" image={Empty.PRESENTED_IMAGE_SIMPLE} />
            </div>
          )}
        </div>

        {/* 加载错误提示 */}
        {!sidebarCollapsed && assetsError && (
          <div style={{ padding: '8px 12px' }}>
            <Alert
              type="error"
              showIcon
              message="服务不可达"
              action={<Button size="small" onClick={loadAssets}>重试</Button>}
              style={{ fontSize: 12 }}
            />
          </div>
        )}
      </div>

      {/* 新建资产弹窗 */}
      <RegisterAssetModal
        open={registerOpen}
        onClose={() => setRegisterOpen(false)}
        onCreated={handleAssetCreated}
      />
    </div>
  );
}
