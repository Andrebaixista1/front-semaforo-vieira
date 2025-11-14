// services/fotoService.js
// Serviço responsável por obter URLs/paths de fotos de usuário (perfil).
// - Busca a coluna imagem_perfil na tabela operadores_new
// - Tenta CLOUD então LOCAL (fallback)
// - Cache em memória com TTL
// - Bulk fetch com concorrência limitada
// - Normalização / sanitização de caminhos (transforma em URL absoluta se necessário)
// - Exporta utilitários: fetchFotosMap, fetchFoto, sanitizeFotoPath, clearCache, getMetrics
//
// Dependências esperadas:
// - ../db.js deve exportar getLocalPool() e getCloudPool()
// - process.env.APP_BASE_URL (opcional) para transformar caminhos relativos em absolutos
// - process.env.FOTO_CACHE_MS (opcional) ttl do cache em ms

const path = require('path');
const fs = require('fs');

let getLocalPool, getCloudPool;
try {
  const db = require('../config/db.js');
  getLocalPool = db.getLocalPool;
  getCloudPool = db.getCloudPool;
} catch (e) {
  console.warn('⚠️ fotoService: não conseguiu importar ../db.js - funções de DB podem faltar.', e && e.message ? e.message : e);
}

// CONFIG
const CACHE_TTL = parseInt(process.env.FOTO_CACHE_MS || '15000', 10); // 15s padrão
const DEFAULT_CONCURRENCY = parseInt(process.env.FOTO_CONCURRENCY || '10', 10);
const APP_BASE = (process.env.APP_BASE_URL || (`http://localhost:${process.env.PORT || 8003}`)).replace(/\/$/, '');
const PUBLIC_DIR_CANDIDATES = [
  path.resolve(__dirname, '..', 'public'),
  path.resolve(__dirname, '..', '..', 'public'),
  path.resolve(process.cwd(), 'public')
];
const PUBLIC_DIR = PUBLIC_DIR_CANDIDATES.find(p => fs.existsSync(p)) || null;

// Estado interno
const cache = new Map(); // key = usuario_id, value = { fotoRaw, ts }
let metrics = {
  hits: 0,
  misses: 0,
  fetchCount: 0,
  fetchErrors: 0,
  lastFetchMs: 0,
  totalFetchedIds: 0
};

// HELPERS
function now() { return Date.now(); }

function escapeSqlStr(s = '') {
  return String(s).replace(/'/g, "''");
}

function toInList(arr = []) {
  return arr.map(id => `'${escapeSqlStr(String(id))}'`).join(',');
}

function isValidImageUrl(url) {
  if (!url || typeof url !== 'string') return false;
  const s = url.trim();
  if (!s || s.toLowerCase() === 'false' || s.toLowerCase() === 'null') return false;
  if (s.startsWith('/')) return true;
  if (s.startsWith('./') || s.startsWith('../')) return true;
  if (/^[\w\-./]+\.(png|jpe?g|gif|webp)$/i.test(s)) return true;
  if (/^data:image\/[a-zA-Z]+;base64,/.test(s)) return true;
  try { const u = new URL(s); return u.protocol === 'http:' || u.protocol === 'https:'; } catch { return false; }
}

function toAbsoluteUrl(p) {
  if (!p) return '';
  const s = String(p).trim();
  try { new URL(s); return s; } catch (e) { /* não é absoluta */ }
  if (s.startsWith('/')) return `${APP_BASE}${s}`;
  return `${APP_BASE}/${s.replace(/^\.?\//, '')}`;
}

/**
 * Sanitize path: trata "logo-vieira.*" e strings inválidas retornando ícone padrão.
 * Se tiver public dir e arquivo existir, retorna url absoluta para /<file>
 */
function sanitizeFotoPath(raw) {
  const s = (raw || '').trim();
  if (!s) return `${toAbsoluteUrl('/vieira-icone.jpg')}?v=1`;

  const lower = s.toLowerCase();
  if (lower.includes('logo-vieira') || lower.includes('logo_vieira') ||
      lower.endsWith('logo-vieira.jpeg') || lower.endsWith('logo-vieira.jpg') || lower.endsWith('logo-vieira.png')) {
    return `${toAbsoluteUrl('/vieira-icone.jpg')}?v=1`;
  }

  if (/^https?:\/\//i.test(s) || /^data:image\/[a-zA-Z]+;base64,/.test(s)) return s;

  if (s.startsWith('/')) {
    if (PUBLIC_DIR) {
      try {
        const p = path.join(PUBLIC_DIR, s.replace(/^\//, ''));
        if (fs.existsSync(p)) return `${APP_BASE}${s}`;
      } catch (e) { /* ignora */ }
    }
    return `${APP_BASE}${s}`;
  }

  if (/^[\w\-./]+\.(png|jpe?g|gif|webp)$/i.test(s)) {
    if (PUBLIC_DIR) {
      try {
        const p = path.join(PUBLIC_DIR, s.replace(/^\.\//, ''));
        if (fs.existsSync(p)) return `${APP_BASE}/${s.replace(/^\.\//, '')}`;
      } catch (e) { /* ignora */ }
    }
    return toAbsoluteUrl(`/${s.replace(/^\.\//, '')}`);
  }

  return `${toAbsoluteUrl('/vieira-icone.jpg')}?v=1`;
}

// PROCESS BATCH helper com concorrência
async function processBatch(items = [], fn, concurrency = DEFAULT_CONCURRENCY, throttleMs = 50) {
  const out = [];
  for (let i = 0; i < items.length; i += concurrency) {
    const chunk = items.slice(i, i + concurrency);
    const res = await Promise.all(chunk.map(it => fn(it).catch(err => {
      metrics.fetchErrors++;
      console.error('fotoService processBatch item error:', err && err.message ? err.message : err);
      return null;
    })));
    out.push(...res.filter(Boolean));
    if (items.length > concurrency && throttleMs > 0) await new Promise(r => setTimeout(r, throttleMs));
  }
  return out;
}

/* ---------------------------- LÓGICA DE BUSCA ---------------------------- */

/**
 * Query para buscar fotos na tabela operadores_new usando coluna imagem_perfil
 * Retorna Map(usuario_id -> fotoRawString)
 */
async function fetchFotosFromDb(ids = [], useCloud = true) {
  if (!ids || !ids.length) return new Map();
  const idsList = toInList(ids);
  const sqlQuery = `
    SELECT usuario_id, COALESCE(imagem_perfil, '') AS foto
    FROM operadores_new
    WHERE usuario_id IN (${idsList})
  `;
  const map = new Map();
  const t0 = now();
  try {
    const pool = useCloud ? await (getCloudPool && getCloudPool()) : await (getLocalPool && getLocalPool());
    if (!pool) throw new Error(`Pool ${useCloud ? 'CLOUD' : 'LOCAL'} indisponível`);
    const r = await pool.request().query(sqlQuery);
    for (const row of (r.recordset || [])) {
      map.set(String(row.usuario_id), row.foto || '');
    }
    metrics.fetchCount++;
    metrics.totalFetchedIds += ids.length;
    metrics.lastFetchMs = now() - t0;
    return map;
  } catch (err) {
    metrics.fetchErrors++;
    throw err;
  }
}

/**
 * fetchFotosMap(ids, opts)
 * - ids: array de ids (strings ou numbers)
 * - opts: { concurrency, useCache, preferCloud }
 * Retorna Map(usuario_id -> fotoSanitizedUrl)
 */
async function fetchFotosMap(ids = [], opts = {}) {
  const concurrency = opts.concurrency || DEFAULT_CONCURRENCY;
  const useCache = opts.useCache !== false; // padrão true
  const preferCloud = opts.preferCloud !== false; // padrão true

  const outMap = new Map();
  const toFetch = [];

  // consulta cache primeiro
  for (const rawId of ids) {
    const id = String(rawId);
    if (useCache && cache.has(id)) {
      const rec = cache.get(id);
      if (rec && (now() - rec.ts) < CACHE_TTL && rec.fotoRaw !== undefined) {
        metrics.hits++;
        outMap.set(id, sanitizeFotoPath(rec.fotoRaw));
        continue;
      } else {
        cache.delete(id);
      }
    }
    metrics.misses++;
    toFetch.push(id);
  }

  if (!toFetch.length) return outMap;

  const fetchOrder = preferCloud ? [true, false] : [false, true];

  let remaining = new Set(toFetch);
  for (const useCloud of fetchOrder) {
    if (!remaining.size) break;
    const chunkIds = Array.from(remaining);
    try {
      const BATCH_SIZE = 300;
      for (let i = 0; i < chunkIds.length; i += BATCH_SIZE) {
        const batch = chunkIds.slice(i, i + BATCH_SIZE);
        let mapDb = new Map();
        try {
          mapDb = await fetchFotosFromDb(batch, useCloud);
        } catch (err) {
          console.warn(`fotoService: falha buscando ${useCloud ? 'CLOUD' : 'LOCAL'} - ${err && err.message ? err.message : err}`);
          continue;
        }
        for (const id of batch) {
          const raw = mapDb.get(String(id));
          if (raw !== undefined) {
            const sanitized = sanitizeFotoPath(raw);
            outMap.set(String(id), sanitized);
            cache.set(String(id), { fotoRaw: raw, ts: now() });
            remaining.delete(id);
          }
        }
      }
    } catch (err) {
      console.error('fotoService fetch loop error:', err && err.message ? err.message : err);
    }
  }

  // fallback para ids não encontrados
  for (const id of Array.from(remaining)) {
    const fallback = sanitizeFotoPath(null);
    outMap.set(String(id), fallback);
    cache.set(String(id), { fotoRaw: '', ts: now() });
  }

  return outMap;
}

/**
 * fetchFoto(id, opts) -> string (url)
 */
async function fetchFoto(id, opts = {}) {
  const map = await fetchFotosMap([id], opts);
  return map.get(String(id));
}

/* ---------------------------- UTILITÁRIOS ---------------------------- */
function clearCache() {
  cache.clear();
  metrics = { hits: 0, misses: 0, fetchCount: 0, fetchErrors: 0, lastFetchMs: 0, totalFetchedIds: 0 };
}

function getMetrics() {
  return { ...metrics, cacheSize: cache.size, cacheTTL: CACHE_TTL };
}

function getCacheSnapshot() {
  const out = {};
  for (const [k, v] of cache.entries()) {
    out[k] = { ts: v.ts, fotoRaw: (v.fotoRaw && String(v.fotoRaw).slice(0, 100)) || '' };
  }
  return out;
}

/* ---------------------------- EXPORTS ---------------------------- */
module.exports = {
  fetchFotosMap,
  fetchFoto,
  sanitizeFotoPath,
  clearCache,
  getMetrics,
  getCacheSnapshot
};
