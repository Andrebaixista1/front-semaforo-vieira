// ===============================================================
// routes/rankingRoutes.js — Rotas relacionadas ao ranking de vendas
// ===============================================================

const express = require('express');
const router = express.Router();

let rankingController = null;
try {
  rankingController = require('../controllers/rankingController');
} catch (e) {
  console.warn('⚠️ rankingController não encontrado:', e.message);
}

// Token opcional para proteger rotas administrativas e debug
const DEBUG_TOKEN = process.env.DEBUG_TOKEN || null;

/**
 * Middleware opcional de autenticação para rotas admin/debug
 */
function requireDebugAuth(req, res, next) {
  if (!DEBUG_TOKEN) return next(); // sem token = modo dev livre
  const token = req.headers['x-debug-token'] || req.query.debug_token;
  if (token && token === DEBUG_TOKEN) return next();
  return res.status(401).json({ error: 'Unauthorized (debug token inválido ou ausente)' });
}

/* -------------------------
   GET /api/ranking
   (rota pública)
------------------------- */
router.get('/api/ranking', async (req, res) => {
  try {
    if (!rankingController || typeof rankingController.getRanking !== 'function') {
      return res.status(200).json({ ranking: [], msg: 'rankingController não disponível' });
    }
    await rankingController.getRanking(req, res);
  } catch (e) {
    console.error('❌ [rankingRoutes] /api/ranking erro:', e.message);
    res.status(500).json({ error: e.message });
  }
});

/* -------------------------
   POST /api/ranking/refresh
   (força atualização imediata)
------------------------- */
router.post('/api/ranking/refresh', requireDebugAuth, async (req, res) => {
  try {
    if (!rankingController) {
      return res.status(501).json({ error: 'rankingController indisponível' });
    }

    // método dedicado no controller
    if (typeof rankingController.updateRanking === 'function') {
      const updated = await rankingController.updateRanking();
      return res.json({ ok: true, updated });
    }

    // fallback via __internal
    if (rankingController.__internal?.forceUpdate) {
      const result = await rankingController.__internal.forceUpdate();
      return res.json({ ok: true, result });
    }

    return res.status(501).json({ error: 'Método de atualização não encontrado no controller' });
  } catch (e) {
    console.error('❌ [rankingRoutes] refresh erro:', e.message);
    res.status(500).json({ error: e.message });
  }
});

/* -------------------------
   GET /_debug/ranking-cache
   (visualiza cache em memória)
------------------------- */
router.get('/_debug/ranking-cache', requireDebugAuth, (req, res) => {
  try {
    if (!rankingController?.__internal?.cacheRef) {
      return res.json({ available: false, msg: 'Cache interno não disponível' });
    }

    const ref = rankingController.__internal.cacheRef();
    res.json({
      available: true,
      ts: ref?.ts ? new Date(ref.ts).toISOString() : null,
      count: Array.isArray(ref?.data) ? ref.data.length : 0,
      sample: Array.isArray(ref?.data) ? ref.data.slice(0, 10) : null,
    });
  } catch (e) {
    console.error('❌ [rankingRoutes] _debug/ranking-cache erro:', e.message);
    res.status(500).json({ error: e.message });
  }
});

/* -------------------------
   POST /_debug/ranking-clear
   (limpa cache manualmente)
------------------------- */
router.post('/_debug/ranking-clear', requireDebugAuth, (req, res) => {
  try {
    if (!rankingController?.__internal?.cacheRef) {
      return res.json({ ok: false, msg: 'rankingController.__internal.cacheRef indisponível' });
    }

    const ref = rankingController.__internal.cacheRef();
    if (ref) {
      ref.data = null;
      ref.ts = 0;
      ref.isFetching = false;
      ref.fetchPromise = null;
    }

    res.json({ ok: true, cleared: true });
  } catch (e) {
    console.error('❌ [rankingRoutes] _debug/ranking-clear erro:', e.message);
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
