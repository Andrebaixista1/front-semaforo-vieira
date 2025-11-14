// routes/debugRoutes.js
// Rotas de debug / inspeção para desenvolvimento
// Uso: app.use('/', require('./routes/debugRoutes'));
/* eslint-disable no-console */

const express = require('express');
const fs = require('fs');
const path = require('path');

const router = express.Router();

// imports defensivos dos controllers / db
let statusController = null;
let empresaController = null;
let rankingController = null;
let healthController = null;
let db = null;

try { statusController = require('../controllers/statusController'); } catch (e) { /* ignore */ }
try { empresaController = require('../controllers/empresaController'); } catch (e) { /* ignore */ }
try { rankingController = require('../controllers/rankingController'); } catch (e) { /* ignore */ }
try { healthController = require('../controllers/healthController'); } catch (e) { /* ignore */ }
try { db = require('../db.js'); } catch (e) { /* ignore */ }

const DEBUG_TOKEN = process.env.DEBUG_TOKEN || null;

// middleware opcional: exige token quando DEBUG_TOKEN está definido
function requireDebugAuth(req, res, next) {
  if (!DEBUG_TOKEN) return next();
  const token = req.headers['x-debug-token'] || req.query.debug_token;
  if (token && token === DEBUG_TOKEN) return next();
  return res.status(401).json({ error: 'Unauthorized (debug token)' });
}

// util: probe pool getter
async function probePool(poolGetter) {
  try {
    if (!poolGetter || typeof poolGetter !== 'function') return { ok: false, msg: 'poolGetter not available' };
    const pool = await poolGetter();
    return { ok: true, connected: !!pool && !!pool.connected, connecting: !!pool && !!pool.connecting };
  } catch (e) {
    return { ok: false, error: String(e && e.message ? e.message : e) };
  }
}

// 1) Listar public dir
router.get('/_debug/ls-public', requireDebugAuth, (req, res) => {
  try {
    const candidates = [
      path.join(__dirname, '..', 'public'),
      path.join(process.cwd(), 'public'),
      path.resolve(process.cwd(), 'public'),
    ];
    const dir = candidates.find(p => fs.existsSync(p)) || candidates[0];
    let files = [];
    try { files = fs.readdirSync(dir); } catch (e) { files = []; }
    res.json({ dir, exists: fs.existsSync(dir), files });
  } catch (e) {
    res.status(500).json({ error: String(e && e.message ? e.message : e) });
  }
});

// 2) Pools status
router.get('/_debug/pools', requireDebugAuth, async (req, res) => {
  try {
    if (!db) return res.json({ error: 'db.js não disponível' });
    const local = await probePool(db.getLocalPool);
    const cloud = await probePool(db.getCloudPool);
    res.json({ local, cloud });
  } catch (e) {
    res.status(500).json({ error: String(e && e.message ? e.message : e) });
  }
});

// 3) status-cache (do statusController)
router.get('/_debug/status-cache', requireDebugAuth, (req, res) => {
  try {
    if (!statusController || !statusController.__internal || typeof statusController.__internal.statusCacheRef !== 'function') {
      return res.json({ error: 'statusController.__internal.statusCacheRef indisponível' });
    }
    const ref = statusController.__internal.statusCacheRef();
    // clonar parcialmente para evitar expor funções/refs internas
    const safe = {
      hasData: !!ref && !!ref.data,
      timestamp: ref && ref.timestamp ? new Date(ref.timestamp).toISOString() : null,
      isFetching: !!ref && !!ref.isFetching,
      summary: ref && ref.data ? { operadores: Array.isArray(ref.data.operadores) ? ref.data.operadores.length : null, horario_atual: ref.data.horario_atual } : null
    };
    res.json({ raw: ref, safe });
  } catch (e) {
    res.status(500).json({ error: String(e && e.message ? e.message : e) });
  }
});

// 4) ranking-cache (do rankingController)
router.get('/_debug/ranking-cache', requireDebugAuth, (req, res) => {
  try {
    if (!rankingController || !rankingController.__internal || typeof rankingController.__internal.cacheMapRef !== 'function') {
      return res.json({ error: 'rankingController.__internal.cacheMapRef indisponível' });
    }
    const map = rankingController.__internal.cacheMapRef();
    const keys = [];
    for (const k of map.keys()) {
      const entry = map.get(k);
      keys.push({ empresa: k, hasData: !!entry.data, ts: entry.ts ? new Date(entry.ts).toISOString() : null, isFetching: !!entry.isFetching });
    }
    res.json({ keys, size: map.size });
  } catch (e) {
    res.status(500).json({ error: String(e && e.message ? e.message : e) });
  }
});

// 5) empresas-cache (do empresaController)
router.get('/_debug/empresas-cache', requireDebugAuth, (req, res) => {
  try {
    if (!empresaController || !empresaController.__internal || typeof empresaController.__internal.cacheRef !== 'function') {
      return res.json({ error: 'empresaController.__internal.cacheRef indisponível' });
    }
    const ref = empresaController.__internal.cacheRef();
    res.json({
      hasData: !!ref && Array.isArray(ref.data),
      ts: ref && ref.ts ? new Date(ref.ts).toISOString() : null,
      count: Array.isArray(ref.data) ? ref.data.length : 0,
      sample: Array.isArray(ref.data) ? ref.data.slice(0, 20) : []
    });
  } catch (e) {
    res.status(500).json({ error: String(e && e.message ? e.message : e) });
  }
});

// 6) fotos: busca fotos em operadores_new (tenta cloud -> local)
router.get('/_debug/fotos', requireDebugAuth, async (req, res) => {
  try {
    const ids = String(req.query.ids || '').split(',').map(s => s.trim()).filter(Boolean).slice(0, 200);
    if (!ids.length) return res.status(400).json({ error: 'ids query param required, ex: ?ids=1,2,3' });

    if (!db) return res.status(500).json({ error: 'db.js não disponível' });

    const idsList = ids.map(id => `'${String(id).replace(/'/g, "''")}'`).join(',');

    const q = `
      SELECT usuario_id, COALESCE(imagem_perfil, image_perfil, '') AS foto
      FROM operadores_new
      WHERE usuario_id IN (${idsList})
    `;

    // try cloud first
    let rows = [];
    try {
      const poolCloud = await db.getCloudPool();
      if (poolCloud) {
        const r = await poolCloud.request().query(q);
        rows = r.recordset || [];
      }
    } catch (eCloud) {
      // fallback local
      try {
        const poolLocal = await db.getLocalPool();
        if (poolLocal) {
          const r2 = await poolLocal.request().query(q);
          rows = r2.recordset || [];
        }
      } catch (eLocal) {
        return res.status(500).json({ error: 'Falha ao consultar fotos (cloud+local)', cloudError: String(eCloud && eCloud.message ? eCloud.message : eCloud), localError: String(eLocal && eLocal.message ? eLocal.message : eLocal) });
      }
    }

    const map = {};
    for (const row of rows) map[String(row.usuario_id)] = row.foto || '';
    res.json({ requested: ids, found: Object.keys(map).length, map });
  } catch (e) {
    res.status(500).json({ error: String(e && e.message ? e.message : e) });
  }
});

// 7) health-full via healthController
router.get('/_debug/health-full', requireDebugAuth, async (req, res) => {
  try {
    if (!healthController || typeof healthController.buildHealthPayload !== 'function') {
      return res.status(500).json({ error: 'healthController.buildHealthPayload indisponível' });
    }
    const payload = await healthController.buildHealthPayload();
    return res.json(payload);
  } catch (e) {
    return res.status(500).json({ error: String(e && e.message ? e.message : e) });
  }
});

// 8) last-error agregado
router.get('/_debug/last-error', requireDebugAuth, (req, res) => {
  try {
    const out = {};
    try { out.status_lastError = statusController && statusController.__internal && typeof statusController.__internal.lastErrorRef === 'function' ? statusController.__internal.lastErrorRef() : null; } catch (e) { out.status_lastError = String(e && e.message ? e.message : e); }
    try { out.empresa_lastError = empresaController && empresaController.__internal && typeof empresaController.__internal.lastErrorRef === 'function' ? empresaController.__internal.lastErrorRef() : null; } catch (e) { out.empresa_lastError = String(e && e.message ? e.message : e); }
    try { out.ranking_lastError = rankingController && rankingController.__internal && typeof rankingController.__internal.lastErrorMapRef === 'function' ? Array.from(rankingController.__internal.lastErrorMapRef().entries()).map(([k,v]) => ({ empresa: k, err: String(v && v.message ? v.message : v) })) : null; } catch (e) { out.ranking_lastError = String(e && e.message ? e.message : e); }
    res.json(out);
  } catch (e) {
    res.status(500).json({ error: String(e && e.message ? e.message : e) });
  }
});

// 9) clear caches (POST) — limpa caches internos dos controllers
router.post('/_debug/clear-caches', requireDebugAuth, async (req, res) => {
  const result = {};
  try {
    // statusController: tenta zerar statusCache
    try {
      if (statusController && statusController.__internal && typeof statusController.__internal.statusCacheRef === 'function') {
        const s = statusController.__internal.statusCacheRef();
        if (s) { s.data = null; s.timestamp = 0; s.isFetching = false; s.fetchPromise = null; result.status = 'cleared'; } else result.status = 'no-ref';
      } else result.status = 'not-available';
    } catch (e) { result.status = `error: ${String(e && e.message ? e.message : e)}`; }

    // empresaController
    try {
      if (empresaController && empresaController.__internal && typeof empresaController.__internal.cacheRef === 'function') {
        const c = empresaController.__internal.cacheRef();
        if (c) { c.data = null; c.ts = 0; c.isFetching = false; c.fetchPromise = null; result.empresas = 'cleared'; } else result.empresas = 'no-ref';
      } else result.empresas = 'not-available';
    } catch (e) { result.empresas = `error: ${String(e && e.message ? e.message : e)}`; }

    // rankingController
    try {
      if (rankingController && rankingController.__internal && typeof rankingController.__internal.cacheMapRef === 'function') {
        const map = rankingController.__internal.cacheMapRef();
        if (map && typeof map.clear === 'function') { map.clear(); result.ranking = 'cleared'; } else result.ranking = 'no-map';
      } else result.ranking = 'not-available';
    } catch (e) { result.ranking = `error: ${String(e && e.message ? e.message : e)}`; }

    return res.json({ ok: true, result });
  } catch (e) {
    return res.status(500).json({ error: String(e && e.message ? e.message : e) });
  }
});

module.exports = router;
