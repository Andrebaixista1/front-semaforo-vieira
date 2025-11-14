// routes/healthRoutes.js
const { Router } = require('express');
const router = Router();

let testConnections = null;
try {
  // importa de forma segura (não quebra se o db falhar)
  ({ testConnections } = require('../config/db.js'));
} catch (e) {
  // segue sem testConnections
}

/**
 * GET /health
 * - Status básico da aplicação
 * - (Opcional) status dos bancos via testConnections()
 */
router.get('/health', async (req, res) => {
  const base = {
    ok: true,
    ts: new Date().toISOString(),
    uptimeSec: Math.round(process.uptime()),
    pid: process.pid,
  };

  // Se conseguirmos testar conexões, agrega no payload
  if (typeof testConnections === 'function') {
    try {
      const conn = await testConnections();
      return res.json({ ...base, db: conn });
    } catch (e) {
      return res.json({ ...base, db: { error: e?.message || String(e) } });
    }
  }

  return res.json(base);
});

/**
 * GET /_debug/last-error
 * - Endpoint utilitário simples de debug
 */
router.get('/_debug/last-error', (req, res) => {
  res.json({ now: new Date().toISOString(), msg: 'ok' });
});

module.exports = router; // <-- importante: exporta um Router
