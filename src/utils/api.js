// src/utils/api.js
// Resolve API base URL with env override and forced fallback for the remote API.

const rawEnvUrl = (process.env.REACT_APP_API_BASE_URL || '').trim();
const FORCED_BASE_URL = 'http://85.31.61.242:8003';

export const API_BASE_URL = (() => {
  // 1) If an environment variable provides the full URL, prefer it.
  if (rawEnvUrl) {
    return rawEnvUrl.replace(/\/+$/, '');
  }

  // 2) Fall back to the required remote API base.
  return FORCED_BASE_URL;
})();

export function apiUrl(path = '') {
  const base = API_BASE_URL || '';
  if (!path) return base;
  const normalizedPath = path.startsWith('/') ? path : `/${path}`;
  return `${base}${normalizedPath}`;
}
