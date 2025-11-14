// routes/statusRoutes.js — Rotas relacionadas ao status de operadores
const express = require('express');
const router = express.Router();

let statusController = null;
try {
  statusController = require('../controllers/statusController.js');
} catch (e) {
  console.warn('⚠️ statusController não encontrado:', e && e.message ? e.message : e);
}

// Token opcional para proteger rotas de debug/admin
const DEBUG_TOKEN = process.env.DEBUG_TOKEN || null;

/**
 * Middleware opcional de autenticação para rotas de debug/admin
 */
function requireDebugAuth(req, res, next) {
  if (!DEBUG_TOKEN) return next(); // sem token = modo dev livre
  const token = req.headers['x-debug-token'] || req.query.debug_token || req.headers['authorization'];
  if (token && (token === DEBUG_TOKEN || token === `Bearer ${DEBUG_TOKEN}`)) return next();
  return res.status(401).json({ error: 'Unauthorized (debug token inválido ou ausente)' });
}

/* -------------------------
   GET /api/status-operadores
   (rota pública)
------------------------- */
router.get('/api/status-operadores', async (req, res) => {
  try {
    if (!statusController || typeof statusController.getStatusOperadores !== 'function') {
      return res.status(200).json({ operadores: [], msg: 'statusController não disponível' });
    }
    // delega toda a lógica ao controller (ele usa req,res)
    return await statusController.getStatusOperadores(req, res);
  } catch (e) {
    console.error('❌ [statusRoutes] /api/status-operadores erro:', e && e.message ? e.message : e);
    return res.status(500).json({ error: e && e.message ? e.message : String(e) });
  }
});

/* -------------------------
   POST /api/status/refresh
   (força atualização imediata pelo controller)
   Protegida por requireDebugAuth
------------------------- */
router.post('/api/status/refresh', requireDebugAuth, async (req, res) => {
  try {
    if (!statusController) return res.status(501).json({ error: 'statusController indisponível' });

    if (typeof statusController.updateStatusOperadores === 'function') {
      // chama a atualização explícita e retorna o payload atualizado
      const updated = await statusController.updateStatusOperadores();
      return res.json({ ok: true, updated });
    }

    return res.status(501).json({ error: 'Método updateStatusOperadores não existe no controller' });
  } catch (e) {
    console.error('❌ [statusRoutes] /api/status/refresh erro:', e && e.message ? e.message : e);
    return res.status(500).json({ error: e && e.message ? e.message : String(e) });
  }
});

/* -------------------------
   GET /_debug/status-cache
   (inspeciona cache atual)
   Protegida por requireDebugAuth
------------------------- */
router.get('/_debug/status-cache', requireDebugAuth, (req, res) => {
  try {
    if (!statusController || !statusController.__internal || typeof statusController.__internal.statusCacheRef !== 'function') {
      return res.json({ available: false, msg: 'Cache interno não disponível' });
    }

    const ref = statusController.__internal.statusCacheRef();
    // estrutura defensiva: pode ser { data, timestamp, isFetching, fetchPromise } ou outro nome
    const ts = ref && (ref.timestamp || ref.ts || 0);
    const data = ref && (ref.data || ref.operadores || null);

    res.json({
      available: true,
      ts: ts ? new Date(ts).toISOString() : null,
      isFetching: !!(ref && ref.isFetching),
      count: Array.isArray(data) ? data.length : (data && data.operadores ? data.operadores.length : null),
      sample: Array.isArray(data) ? data.slice(0, 20) : (data && data.operadores ? data.operadores.slice(0, 20) : data)
    });
  } catch (e) {
    console.error('❌ [statusRoutes] _debug/status-cache erro:', e && e.message ? e.message : e);
    res.status(500).json({ error: e && e.message ? e.message : String(e) });
  }
});

/* -------------------------
   GET /_debug/status-last
   (retorna último payload bom + último erro)
   Protegida por requireDebugAuth
------------------------- */
router.get('/_debug/status-last', requireDebugAuth, (req, res) => {
  try {
    const internal = statusController && statusController.__internal;
    if (!internal) return res.json({ available: false, msg: 'Internals do controller não disponíveis' });

    const lastGood = typeof internal.lastGoodPayloadRef === 'function' ? internal.lastGoodPayloadRef() : null;
    const lastErr = typeof internal.lastErrorRef === 'function' ? internal.lastErrorRef() : null;
    return res.json({ available: true, lastGood, lastError: lastErr ? (lastErr.message || String(lastErr)) : null });
  } catch (e) {
    console.error('❌ [statusRoutes] _debug/status-last erro:', e && e.message ? e.message : e);
    res.status(500).json({ error: e && e.message ? e.message : String(e) });
  }
});

/* -------------------------
   POST /_debug/status-clear
   (limpa cache manualmente)
   Protegida por requireDebugAuth
------------------------- */
router.post('/_debug/status-clear', requireDebugAuth, (req, res) => {
  try {
    const internal = statusController && statusController.__internal;
    if (!internal || typeof internal.statusCacheRef !== 'function') {
      return res.json({ ok: false, msg: 'statusController.__internal.statusCacheRef indisponível' });
    }

    const ref = internal.statusCacheRef();
    if (ref) {
      if (ref.data) ref.data = null;
      if (typeof ref.timestamp !== 'undefined') ref.timestamp = 0;
      if (typeof ref.ts !== 'undefined') ref.ts = 0;
      ref.isFetching = false;
      ref.fetchPromise = null;
    }

    return res.json({ ok: true, cleared: true });
  } catch (e) {
    console.error('❌ [statusRoutes] _debug/status-clear erro:', e && e.message ? e.message : e);
    res.status(500).json({ error: e && e.message ? e.message : String(e) });
  }
});

module.exports = router;
