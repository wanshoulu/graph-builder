import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// 独立部署开发/预览的代理拓扑：
//   /api   → graph-builder server.js（默认 3013）
//   /tools → 单文件应用页与共享脚本
//   /data  → 应用页 ../data/ 相对取数
const proxyTarget = process.env.GRAPH_SERVICE_URL || 'http://127.0.0.1:3013';

export default defineConfig({
  // 根路径部署：dist/index.html 的 /assets/* 由 server.js 直接托管。
  // 若需挂到子路径，设置 VITE_BASE 并同步改 server.js 的 /assets/ 映射与 <BrowserRouter basename>。
  base: process.env.VITE_BASE || '/',
  plugins: [react()],
  resolve: {
    alias: {
      '@': '/src',
    },
  },
  server: {
    port: 5273,
    proxy: {
      '/api': { target: proxyTarget, changeOrigin: true },
      '/tools': { target: proxyTarget, changeOrigin: true },
      '/data': { target: proxyTarget, changeOrigin: true },
    },
  },
  preview: {
    port: 5273,
    proxy: {
      '/api': { target: proxyTarget, changeOrigin: true },
      '/tools': { target: proxyTarget, changeOrigin: true },
      '/data': { target: proxyTarget, changeOrigin: true },
    },
  },
  build: {
    // 原单体配置里 build 键写了两次，emptyOutDir:false 被后者覆盖；这里合并为一份。
    emptyOutDir: false,
    rollupOptions: {
      output: {
        manualChunks: {
          antd: ['antd', '@ant-design/icons'],
          charts: ['@antv/g6', 'dagre'],
          vendor: ['react', 'react-dom', 'react-router-dom', 'react-resizable-panels'],
        },
      },
    },
  },
});
