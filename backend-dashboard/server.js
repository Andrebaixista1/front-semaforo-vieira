// ===============================================================
// server.js — Backend integrado e modularizado
// (status, empresa, ranking, health, debug, services monitor)
// Adaptado para: modo local (listen + schedulers) ou export para serverless
// ===============================================================

require('dotenv').config();
const path = require('path');
const os = require('os');
const fs = require('fs');
const express = require('express');
const cors = require('cors');

const app = express();
const PORT = process.env.PORT || 8003;

/* ----------------------- IMPORTS LOCAIS ----------------------- */
let sql, getLocalPool, getCloudPool, testConnections, closeConnections;
try {
  const db = require('./config/db.js');
  ({ sql, getLocalPool, getCloudPool, testConnections, closeConnections } = db);
} catch (e) {
  console.warn('⚠️ db.js não encontrado ou com erro:', e && e.message ? e.message : e);
}

// Controllers (fallback caso as rotas não existam)
let statusController, empresaController, rankingController, healthController;
try { statusController = require('./controllers/statusController'); } catch (e) { /* ignored */ }
try { empresaController = require('./controllers/empresaController'); } catch (e) { /* ignored */ }
try { rankingController = require('./controllers/rankingController'); } catch (e) { /* ignored */ }
try { healthController = require('./controllers/healthController'); } catch (e) { /* ignored */ }

// Rotas modulares
let empresaRoutes = null;
let statusRoutes = null;
let rankingRoutes = null;
let healthRoutes = null;
let debugRoutes = null;
try { empresaRoutes = require('./routes/empresaRoutes'); } catch (e) { /* ignored */ }
try { statusRoutes = require('./routes/statusRoutes'); } catch (e) { /* ignored */ }
try { rankingRoutes = require('./routes/rankingRoutes'); } catch (e) { /* ignored */ }
try { healthRoutes = require('./routes/healthRoutes'); } catch (e) { /* ignored */ }
try { debugRoutes = require('./routes/debugRoutes'); } catch (e) { /* ignored */ }

// Services (para endpoints internos)
let argusService = null;
let cacheService = null;
try { argusService = require('./services/argusService'); } catch (e) { /* ignored */ }
try { cacheService = require('./services/cacheService'); } catch (e) { /* ignored */ }

/* ----------------------- CONFIGURAÇÕES GERAIS ----------------------- */
app.use(cors());
app.use(express.json({ limit: '4mb' }));

const resolveBaseUrl = () => {
  const ifaces = os.networkInterfaces();
  for (const list of Object.values(ifaces)) {
    for (const a of list || []) {
      if (a.family === 'IPv4' && !a.internal) {
        return `http://${a.address}:${PORT}`;
      }
    }
  }
  return `http://localhost:${PORT}`;
};
const BASE_URL = (process.env.APP_BASE_URL || resolveBaseUrl()).replace(/\/$/, '');
console.log('🌐 BASE_URL:', BASE_URL);

// Servir arquivos estáticos (se houver)
const PUBLIC_DIR = [path.join(__dirname, 'public'), path.join(process.cwd(), 'public')]
  .find(p => fs.existsSync(p)) || path.join(__dirname, 'public');
if (fs.existsSync(PUBLIC_DIR)) app.use(express.static(PUBLIC_DIR));
console.log('📁 PUBLIC_DIR:', PUBLIC_DIR);

/* ---------------------------- ROTAS PRINCIPAIS ---------------------------- */

// Helper robusto para montar routers (evita crash se require retornar algo inválido)
function tryUseRouter(prefix, maybeRouter, name) {
  if (!maybeRouter) return false;
  try {
    // router pode ser função (Express router) ou middleware
    if (typeof maybeRouter === 'function' || (typeof maybeRouter === 'object' && maybeRouter !== null)) {
      app.use(prefix, maybeRouter);
      console.log(`✅ Rotas ${name} carregadas via ${prefix}`);
      return true;
    }
  } catch (e) {
    console.warn(`⚠️ Falha ao registrar ${name} em ${prefix}:`, e && e.message ? e.message : e);
  }
  return false;
}

// Health
if (!tryUseRouter('/', healthRoutes, 'healthRoutes')) {
  if (healthController && typeof healthController.getHealth === 'function') {
    app.get('/health', healthController.getHealth);
    console.log('⚙️ /health carregada diretamente via healthController');
  } else {
    app.get('/health', (req, res) => res.json({ ok: true, ts: new Date().toISOString() }));
    console.log('⚙️ /health fallback padrão ativa');
  }
}

// Status
if (!tryUseRouter('/', statusRoutes, 'statusRoutes')) {
  if (statusController && typeof statusController.getStatusOperadores === 'function') {
    app.get('/api/status-operadores', statusController.getStatusOperadores);
    console.log('⚙️ /api/status-operadores carregada diretamente');
  } else {
    console.log('⚠️ statusController não disponível — /api/status-operadores não montada');
  }
}

// Ranking
if (!tryUseRouter('/', rankingRoutes, 'rankingRoutes')) {
  if (rankingController && typeof rankingController.getRanking === 'function') {
    app.get('/api/ranking', rankingController.getRanking);
    console.log('⚙️ /api/ranking carregada diretamente');
  } else {
    console.log('⚠️ rankingController não disponível — /api/ranking não montada');
  }
}

// Empresas
if (!tryUseRouter('/', empresaRoutes, 'empresaRoutes')) {
  if (empresaController && typeof empresaController.getEmpresas === 'function') {
    app.get('/api/empresas', empresaController.getEmpresas);
    console.log('⚙️ /api/empresas carregada diretamente');
  } else {
    console.log('⚠️ empresaController não disponível — /api/empresas não montada');
  }
}

// Debug
if (!tryUseRouter('/', debugRoutes, 'debugRoutes')) {
  app.get('/_debug/last-error', (req, res) => res.json({ now: new Date().toISOString() }));
  console.log('⚙️ /_debug/last-error padrão ativa');
}

/* ---------------------------- ENDPOINTS DOS SERVICES ---------------------------- */

// Endpoint métricas Argus (se service presente)
if (argusService) {
  try {
    app.get('/api/_argus-metrics', async (req, res) => {
      try {
        const metrics = typeof argusService.getMetrics === 'function' ? argusService.getMetrics() : {};
        const cacheInfo = typeof argusService.getCache === 'function' ? argusService.getCache() : null;
        res.json({ ok: true, source: 'argusService', metrics, cache: cacheInfo, lastUpdate: new Date().toISOString() });
      } catch (err) {
        res.status(500).json({ ok: false, error: err && err.message ? err.message : String(err) });
      }
    });

    app.get('/api/_argus-test', async (req, res) => {
      try {
        const ok = typeof argusService.testArgusConnection === 'function' ? await argusService.testArgusConnection() : false;
        res.json({ ok, ts: new Date().toISOString() });
      } catch (err) {
        res.status(500).json({ ok: false, error: err && err.message ? err.message : String(err) });
      }
    });

    console.log('✅ Endpoints de monitoramento Argus habilitados');
  } catch (e) {
    console.warn('⚠️ Não foi possível montar endpoints Argus:', e && e.message ? e.message : e);
  }
}

// Endpoint cache global (se service presente)
if (cacheService && cacheService.cache) {
  try {
    app.get('/api/_cache-info', (req, res) => {
      try {
        const metrics = typeof cacheService.cache.getMetrics === 'function' ? cacheService.cache.getMetrics() : {};
        res.json({ ok: true, metrics, timestamp: new Date().toISOString() });
      } catch (err) {
        res.status(500).json({ ok: false, error: err && err.message ? err.message : String(err) });
      }
    });

    app.delete('/api/_cache-clear', (req, res) => {
      try {
        if (typeof cacheService.cache.clear === 'function') cacheService.cache.clear();
        res.json({ ok: true, message: 'Cache global limpo com sucesso.' });
      } catch (err) {
        res.status(500).json({ ok: false, error: err && err.message ? err.message : String(err) });
      }
    });

    console.log('✅ Endpoints de cacheService habilitados');
  } catch (e) {
    console.warn('⚠️ Não foi possível montar endpoints cacheService:', e && e.message ? e.message : e);
  }
}

/* ---------------------------- AGENDADORES (INICIALIZAÇÃO CONTROLADA) ---------------------------- */

let _statusIntervalId = null;
let _empIntervalId = null;
let _rankIntervalId = null;

function startSchedulers() {
  try {
    if (statusController && typeof statusController.scheduleStatusUpdater === 'function') {
      _statusIntervalId = statusController.scheduleStatusUpdater(parseInt(process.env.UPDATE_INTERVAL_MS || '60000', 10));
      console.log('⏱️ Atualizador de Status agendado');
    }
  } catch (e) { console.warn('⚠️ startSchedulers status:', e && e.message ? e.message : e); }

  try {
    if (empresaController && typeof empresaController.scheduleEmpresasUpdater === 'function') {
      _empIntervalId = empresaController.scheduleEmpresasUpdater(parseInt(process.env.UPDATE_INTERVAL_MS || '60000', 10));
      console.log('⏱️ Atualizador de Empresas agendado');
    }
  } catch (e) { console.warn('⚠️ startSchedulers empresa:', e && e.message ? e.message : e); }

  try {
    if (rankingController && typeof rankingController.scheduleRankingUpdater === 'function') {
      _rankIntervalId = rankingController.scheduleRankingUpdater(parseInt(process.env.UPDATE_INTERVAL_MS || '60000', 10));
      console.log('⏱️ Atualizador de Ranking agendado');
    }
  } catch (e) { console.warn('⚠️ startSchedulers ranking:', e && e.message ? e.message : e); }
}

function stopSchedulers() {
  try { if (_statusIntervalId) clearInterval(_statusIntervalId); } catch (_) {}
  try { if (_empIntervalId) clearInterval(_empIntervalId); } catch (_) {}
  try { if (_rankIntervalId) clearInterval(_rankIntervalId); } catch (_) {}
}

/* ---------------------------- START (LISTEN) ---------------------------- */

/**
 * Política:
 * - Se executado diretamente (node server.js) => iniciamos listen + schedulers
 * - Se importado (require('./server')) => exportamos app para uso por serverless wrapper
 */
if (require.main === module) {
  (async () => {
    const server = app.listen(PORT, async () => {
      console.log(`🚀 Servidor LOCAL rodando na porta ${PORT}`);
    });

    // inicializa schedulers a menos que explicitamente desabilitado
    const disableSched = (process.env.DISABLE_SCHEDULERS || 'false').toLowerCase() === 'true';
    if (!disableSched) {
      startSchedulers();
    } else {
      console.log('⚠️ Schedulers desabilitados via DISABLE_SCHEDULERS=true');
    }

    // Testar conexões se disponível
    try {
      if (typeof testConnections === 'function') {
        const res = await testConnections();
        console.log('🔌 testConnections:', res);
      }
    } catch (e) {
      console.warn('⚠️ testConnections falhou:', e && e.message ? e.message : e);
    }

    // Retornar server instance caso alguém precise
    // (não guardamos em módulo global para não vazar entre imports)
    return server;
  })().catch(err => {
    console.error('❌ Erro ao iniciar servidor local:', err && err.message ? err.message : err);
    process.exit(1);
  });
} else {
  // Modo importado (serverless) — não iniciar schedulers automaticamente.
  console.log('ℹ️ server.js importado como módulo — não iniciando listen nem schedulers (serverless mode).');
}

/* ---------------------------- ENCERRAMENTO LIMPO ---------------------------- */
async function gracefulShutdown(signal) {
  console.log(`🛑 Encerrando servidor... (signal=${signal})`);
  try {
    stopSchedulers();

    if (typeof closeConnections === 'function') {
      await closeConnections();
      console.log('🔌 Conexões fechadas com sucesso.');
    }
  } catch (e) {
    console.warn('⚠️ Erro ao encerrar servidor:', e && e.message ? e.message : e);
  } finally {
    process.exit(0);
  }
}

// Eventos de encerramento e falhas não tratadas
process.on('SIGINT', () => gracefulShutdown('SIGINT'));
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('unhandledRejection', r => console.error('⚠️ UnhandledRejection:', r));
process.on('uncaughtException', e => console.error('⚠️ UncaughtException:', e && e.stack ? e.stack : e));

/* ---------------------------- EXPORTA APP ---------------------------- */
module.exports = app;
