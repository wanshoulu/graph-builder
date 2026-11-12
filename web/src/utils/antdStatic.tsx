/**
 * antd v5 静态方法 bridge：
 * 根布局包裹 antd <App> 后，<AntdStaticBridge> 组件通过 App.useApp()
 * 获取 context-aware 的 message / modal / notification 实例，
 * 写入模块级变量，供其他模块直接 import 使用。
 *
 * 用法：
 *   import { message } from '@/utils/antdStatic';
 *   message.success('ok');  // 消费动态主题，不再有 Warning
 */
import { App as AntdApp } from 'antd';

type AppInstance = ReturnType<typeof AntdApp.useApp>;
type MessageInstance = AppInstance['message'];
type ModalHookAPI = AppInstance['modal'];
type NotificationHookAPI = AppInstance['notification'];

let _message: MessageInstance | null = null;
let _modal: ModalHookAPI | null = null;
let _notification: NotificationHookAPI | null = null;

/** 在 <App> 内部渲染此组件，自动捕获静态实例 */
export function AntdStaticBridge() {
  const app = AntdApp.useApp();
  _message = app.message;
  _modal = app.modal;
  _notification = app.notification;
  return null;
}

export const message: MessageInstance = new Proxy({} as MessageInstance, {
  get(_t, prop: string) {
    const instance = _message;
    if (instance && prop in instance) {
      const value = (instance as unknown as Record<string, unknown>)[prop];
      return typeof value === 'function' ? value.bind(instance) : value;
    }
    return undefined;
  },
});

export const modal: ModalHookAPI = new Proxy({} as ModalHookAPI, {
  get(_t, prop: string) {
    const instance = _modal;
    if (instance && prop in instance) {
      const value = (instance as unknown as Record<string, unknown>)[prop];
      return typeof value === 'function' ? value.bind(instance) : value;
    }
    return undefined;
  },
});

export const notification: NotificationHookAPI = new Proxy({} as NotificationHookAPI, {
  get(_t, prop: string) {
    const instance = _notification;
    if (instance && prop in instance) {
      const value = (instance as unknown as Record<string, unknown>)[prop];
      return typeof value === 'function' ? value.bind(instance) : value;
    }
    return undefined;
  },
});
