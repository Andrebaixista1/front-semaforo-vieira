// routes/empresaRoutes.js
/* Rotas para empresas (listagem + refresh + debug)
   Uso: app.use('/', require('./routes/empresaRoutes'));
*/

const express = require('express');
const router = express.Router();

let empresaController = null;
let db = null;
try { empresaController = require('../controllers/empresaController'); } catch (e) { /* será tratado nas rotas */ }
try { db = require('../db.js'); } catch (e) { /* opcional */ }

const DEBUG_TOKEN = process.env.DEBUG_TOKEN || null;

// middleware opcional de proteção para rotas de debug
function requireDebugAuth(req, res, next) {
  if (!DEBUG_TOKEN) return next();
  const token = req.headers['x-debug-token'] || req.query.debug_token;
  if (token && token === DEBUG_TOKEN) return next();
  return res.status(401).json({ error: 'Unauthorized (debug token)' });
}

/* -------------------------
   API pública: /api/empresas
   ------------------------- */
router.get('/api/empresas', async (req, res) => {
  try {
    if (!empresaController || typeof empresaController.getEmpresas !== 'function') {
      return res.status(200).json([]); // fallback amigável
    }
    return await empresaController.getEmpresas(req, res);
  } catch (e) {
    console.error('❌ [empresaRoutes] /api/empresas erro:', e && e.message ? e.message : e);
    // compatibilidade: nunca 500 para endpoint público (segue padrão do seu app)
    return res.status(200).json([]);
  }
});

/* -------------------------
   Forçar refresh (admin/dev)
   POST /api/empresas/refresh
   ------------------------- */
router.post('/api/empresas/refresh', async (req, res) => {
  try {
    if (!empresaController) return res.status(501).json({ error: 'empresaController indisponível' });

    // if controller exposes updateEmpresas( ) use it; otherwise try schedule/update hook
    if (typeof empresaController.updateEmpresas === 'function') {
      const updated = await empresaController.updateEmpresas();
      return res.json({ ok: true, updated: Array.isArray(updated) ? updated.length : null, data: updated });
    }

    if (typeof empresaController.__internal === 'object' && typeof empresaController.__internal.forceUpdate === 'function') {
      const updated = await empresaController.__internal.forceUpdate();
      return res.json({ ok: true, updated: Array.isArray(updated) ? updated.length : null, data: updated });
    }

    return res.status(501).json({ error: 'Refresh não suportado pelo controller' });
  } catch (e) {
    console.error('❌ [empresaRoutes] refresh erro:', e && e.message ? e.message : e);
    return res.status(500).json({ error: String(e && e.message ? e.message : e) });
  }
});

/* -------------------------
   Debug: inspecionar cache
   GET /_debug/empresas-cache
   ------------------------- */
router.get('/_debug/empresas-cache', requireDebugAuth, (req, res) => {
  try {
    if (!empresaController || !empresaController.__internal || typeof empresaController.__internal.cacheRef !== 'function') {
      return res.status(200).json({ available: false, msg: 'empresaController.__internal.cacheRef indisponível' });
    }
    const ref = empresaController.__internal.cacheRef();
    return res.json({
      available: true,
      ts: ref && ref.ts ? new Date(ref.ts).toISOString() : null,
      count: Array.isArray(ref && ref.data) ? ref.data.length : 0,
      sample: Array.isArray(ref && ref.data) ? ref.data.slice(0, 30) : null
    });
  } catch (e) {
    console.error('❌ [empresaRoutes] _debug/empresas-cache erro:', e && e.message ? e.message : e);
    return res.status(500).json({ error: String(e && e.message ? e.message : e) });
  }
});

/* -------------------------
   Debug: limpar cache
   POST /_debug/empresas-clear
   ------------------------- */
router.post('/_debug/empresas-clear', requireDebugAuth, (req, res) => {
  try {
    if (!empresaController || !empresaController.__internal || typeof empresaController.__internal.cacheRef !== 'function') {
      return res.status(200).json({ available: false, msg: 'empresaController.__internal.cacheRef indisponível' });
    }
    const ref = empresaController.__internal.cacheRef();
    if (ref) {
      ref.data = null;
      ref.ts = 0;
      ref.isFetching = false;
      ref.fetchPromise = null;
      return res.json({ ok: true, cleared: true });
    }
    return res.json({ ok: false, msg: 'cacheRef retornou nulo' });
  } catch (e) {
    console.error('❌ [empresaRoutes] _debug/empresas-clear erro:', e && e.message ? e.message : e);
    return res.status(500).json({ error: String(e && e.message ? e.message : e) });
  }
});

module.exports = router;
