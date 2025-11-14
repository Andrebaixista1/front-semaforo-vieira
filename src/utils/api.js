// src/utils/api.js
// Resolve API base URL with env override and forced fallback for the remote API.

const rawEnvUrl = (process.env.REACT_APP_API_BASE_URL || '').trim();
const SAME_ORIGIN_FALLBACK = '/api';
const REMOTE_FALLBACK = 'https://ubuntu.sistemavieira.com.br:8003';

export const API_BASE_URL = (() => {
  // 1) If an environment variable provides the full URL, prefer it.
  if (rawEnvUrl) {
    return rawEnvUrl.replace(/\/+$/, '');
  }

  // 2) Default to same-origin `/api` so dev server and Vercel proxy can handle TLS.
  if (typeof window !== 'undefined') {
    return SAME_ORIGIN_FALLBACK;
  }

  // 3) Fallback for non-browser environments (tests/server-side).
  return REMOTE_FALLBACK;
})();

export function apiUrl(path = '') {
  const base = API_BASE_URL || '';
  if (!path) return base;
  const normalizedPath = path.startsWith('/') ? path : `/${path}`;
  return `${base}${normalizedPath}`;
}
