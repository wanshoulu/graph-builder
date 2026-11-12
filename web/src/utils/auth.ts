// 认证凭据存于 localStorage；key 保留 gb_ 前缀，独立于任何平台命名。
const TOKEN_KEY = 'gb_token';
const USERNAME_KEY = 'gb_username';
const ROLE_KEY = 'gb_role';

export const getToken = (): string | null => localStorage.getItem(TOKEN_KEY);
export const setToken = (token: string) => localStorage.setItem(TOKEN_KEY, token);
export const removeToken = () => {
  localStorage.removeItem(TOKEN_KEY);
  localStorage.removeItem(USERNAME_KEY);
  localStorage.removeItem(ROLE_KEY);
};
// 禁用认证检查，始终返回true（供AI Harbor集成）
export const isAuthenticated = (): boolean => true; // 原逻辑：!!getToken()
export const getUsername = (): string | null => localStorage.getItem(USERNAME_KEY);
export const setUsername = (username: string) => localStorage.setItem(USERNAME_KEY, username);
export const getRole = (): string | null => localStorage.getItem(ROLE_KEY);
export const setRole = (role: string) => localStorage.setItem(ROLE_KEY, role);
export const isAdmin = (): boolean => true; // 原逻辑：getRole()?.toLowerCase() === 'admin'
