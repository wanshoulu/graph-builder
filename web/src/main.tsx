import {
  ApartmentOutlined,
  AuditOutlined,
  CloudUploadOutlined,
  ClusterOutlined,
  ExperimentOutlined,
  MessageOutlined,
  PropertySafetyOutlined,
  RiseOutlined,
} from '@ant-design/icons';
import { App as AntdApp, ConfigProvider, Layout, Menu } from 'antd';
import zhCN from 'antd/locale/zh_CN';
import React from 'react';
import ReactDOM from 'react-dom/client';
import { BrowserRouter, Navigate, Route, Routes, useLocation, useNavigate } from 'react-router-dom';
import AutoBuilderPage from './pages/GraphBuilder/AutoBuilderPage';
import GraphBuilder from './pages/GraphBuilder/index';
import GraphEvaluation from './pages/GraphEvaluation/index';
import GraphManagement from './pages/GraphManagement/index';
import IntentRsiEvolution from './pages/IntentRsiEvolution/index';
import KnowledgeIntake from './pages/KnowledgeIntake/index';
import { AntdStaticBridge } from './utils/antdStatic';
import './main.css';

const { Header, Content } = Layout;

const MENU_ITEMS = [
  { key: '/intake', icon: <CloudUploadOutlined />, label: '知识导入' },
  { key: '/auto-build', icon: <ClusterOutlined />, label: '自动建图' },
  { key: '/builder', icon: <ApartmentOutlined />, label: '辅助建图' },
  { key: '/evaluation', icon: <ExperimentOutlined />, label: '图谱评测' },
  {
    key: '/intent-rsi',
    icon: <RiseOutlined />,
    label: '意图进化',
    children: [
      { key: '/intent-rsi', label: 'V2 工作台（Agent+Skill）' },
      { key: '/tools/intent-rsi-lab.html', label: 'V1 实验台（规则模式）', external: true },
    ],
  },
  { key: '/management', icon: <AuditOutlined />, label: '图谱管理' },
];

function Shell({ children }: { children: React.ReactNode }) {
  const navigate = useNavigate();
  const location = useLocation();
  const active =
    MENU_ITEMS.find((item) => !('children' in item) && location.pathname.startsWith(item.key))?.key ?? '';
  // FE-02（codex 二审）：进入独立工具页（/tools/ iframe/新窗）时折叠外层 Header，
  // 把首屏还给工具自身导航——外层产品导航与内层工具导航并存会让内容区变窄、定位成本翻倍。
  const isToolPage = location.pathname.startsWith('/tools/');
  return (
    <Layout style={{ minHeight: '100vh' }}>
      {!isToolPage && (
      <Header
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 24,
          background: '#fff',
          borderBottom: '1px solid #f0f0f0',
          paddingInline: 24,
        }}
      >
        <PropertySafetyOutlined style={{ fontSize: 24, color: '#2878b5' }} />
        <span style={{ fontSize: 16, fontWeight: 600, whiteSpace: 'nowrap' }}>graph-builder 图谱构建工具</span>
        <Menu
          mode="horizontal"
          selectedKeys={active ? [active] : []}
          items={MENU_ITEMS}
          onClick={({ key }) => {
            if (key.startsWith('/tools/')) window.open(key, '_blank');
            else navigate(key);
          }}
          style={{ flex: 1, minWidth: 0, borderBottom: 'none' }}
        />
      </Header>
      )}
      <Content style={{ padding: 0 }}>{children}</Content>
    </Layout>
  );
}

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <ConfigProvider locale={zhCN} theme={{ token: { colorPrimary: '#2878b5', fontFamily: '"Noto Sans SC", -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "PingFang SC", "Microsoft YaHei", sans-serif', borderRadius: 8, fontSize: 13 } }}>
      <AntdApp>
        <AntdStaticBridge />
        <BrowserRouter future={{ v7_startTransition: true, v7_relativeSplatPath: true }}>
          <Shell>
            <Routes>
              <Route path="/" element={<Navigate to="/auto-build" replace />} />
              <Route path="/auto-build" element={<AutoBuilderPage />} />
              <Route path="/builder" element={<GraphBuilder />} />
              <Route path="/intake" element={<KnowledgeIntake />} />
              <Route path="/evaluation" element={<GraphEvaluation />} />
              <Route path="/intent-rsi" element={<IntentRsiEvolution />} />
              <Route path="/management" element={<GraphManagement />} />
              <Route path="*" element={<Navigate to="/auto-build" replace />} />
            </Routes>
          </Shell>
        </BrowserRouter>
      </AntdApp>
    </ConfigProvider>
  </React.StrictMode>,
);
