// controllers/healthController.js
// Handler para /health com informações de DB, cache, uptime, memória e últimos erros.
//
// Requer:
//  - ../db.js (CommonJS) exportando { getLocalPool, getCloudPool, testConnections }
//  - opcionalmente ./statusController e ./empresaController com __internal.* para debug

const os = require('os');
const { getLocalPool, getCloudPool, testConnections } = require('../db.js');

// tenta obter referências de debug se os controllers existirem
let statusControllerInternal = null;
let empresaControllerInternal = null;
try {
  const statusCtrl = require('./statusController');
  if (statusCtrl && statusCtrl.__internal) statusControllerInternal = statusCtrl.__internal;
} catch (e) { /* não crítico */ }

try {
  const empCtrl = require('./empresaController');
  if (empCtrl && empCtrl.__internal) empresaControllerInternal = empCtrl.__internal;
} catch (e) { /* não crítico */ }

function bytesToMB(n) {
  return Math.round((n / 1024 / 1024) * 100) / 100;
}

async function probePool(poolGetter) {
  try {
    const pool = await poolGetter();
    return {
      connected: !!pool && !!pool.connected,
      connectedPromise: !!pool && !!pool.connecting,
      // opcional: versão do driver, número de conexões não disponível diretamente
    };
  } catch (e) {
    return { connected: false, error: String(e && e.message ? e.message : e) };
  }
}

async function buildHealthPayload() {
  const start = Date.now();

  // 1) DB pools
  const localPoolStatusPromise = probePool(getLocalPool).catch(e => ({ connected: false, error: String(e) }));
  const cloudPoolStatusPromise = probePool(getCloudPool).catch(e => ({ connected: false, error: String(e) }));

  // 2) Testa conexões (se db.js expuser testConnections)
  let dbTestResult = { ok: true };
  try {
    if (typeof testConnections === 'function') {
      await testConnections();
      dbTestResult = { ok: true };
    }
  } catch (e) {
    dbTestResult = { ok: false, error: String(e && e.message ? e.message : e) };
  }

  const [localPoolStatus, cloudPoolStatus] = await Promise.all([localPoolStatusPromise, cloudPoolStatusPromise]);

  // 3) mem/uptime/node info
  const mem = process.memoryUsage();
  const sysMem = {
    totalMB: bytesToMB(os.totalmem()),
    freeMB: bytesToMB(os.freemem()),
  };

  // 4) Debug caches (opcional) - usa __internal dos controllers quando disponível
  let statusSummary = null;
  try {
    if (statusControllerInternal && typeof statusControllerInternal.statusCacheRef === 'function') {
      const sRef = statusControllerInternal.statusCacheRef();
      const lastGood = (statusControllerInternal.lastGoodPayloadRef && statusControllerInternal.lastGoodPayloadRef()) || null;
      statusSummary = {
        cache: !!sRef,
        cacheTimestamp: sRef && sRef.timestamp ? new Date(sRef.timestamp).toISOString() : null,
        hasLastGoodPayload: !!lastGood,
        operadoresCount: lastGood && Array.isArray(lastGood.operadores) ? lastGood.operadores.length : (sRef && sRef.data && Array.isArray(sRef.data.operadores) ? sRef.data.operadores.length : null)
      };
    }
  } catch (e) { statusSummary = { error: String(e && e.message ? e.message : e) }; }

  let empresaSummary = null;
  try {
    if (empresaControllerInternal && typeof empresaControllerInternal.cacheRef === 'function') {
      const ref = empresaControllerInternal.cacheRef();
      empresaSummary = {
        cache: !!ref,
        ts: ref && ref.ts ? new Date(ref.ts).toISOString() : null,
        count: Array.isArray(ref && ref.data) ? ref.data.length : null
      };
    }
  } catch (e) { empresaSummary = { error: String(e && e.message ? e.message : e) }; }

  // 5) last error (do statusController se disponível)
  let lastError = null;
  try {
    if (statusControllerInternal && typeof statusControllerInternal.lastErrorRef === 'function') {
      lastError = statusControllerInternal.lastErrorRef();
    }
  } catch (e) {
    lastError = String(e && e.message ? e.message : e);
  }

  const payload = {
    service: {
      name: process.env.SERVICE_NAME || 'backend-ranking',
      version: process.env.npm_package_version || process.env.VERSION || null,
      uptimeSeconds: Math.round(process.uptime()),
      now: new Date().toISOString(),
      elapsedMs: Date.now() - start
    },
    node: {
      version: process.version,
      platform: process.platform,
      pid: process.pid,
      memory: {
        rssMB: bytesToMB(mem.rss),
        heapTotalMB: bytesToMB(mem.heapTotal),
        heapUsedMB: bytesToMB(mem.heapUsed),
        externalMB: bytesToMB(mem.external || 0)
      },
      systemMemory: sysMem
    },
    db: {
      test: dbTestResult,
      localPool: localPoolStatus,
      cloudPool: cloudPoolStatus
    },
    caches: {
      status: statusSummary,
      empresas: empresaSummary
    },
    lastError: lastError
  };

  return payload;
}

/* ---------------------- Express handler ---------------------- */
async function getHealth(req, res) {
  try {
    const payload = await buildHealthPayload();
    // Se algo crítico (dbTestResult.ok === false) podemos retornar 503, mas para compatibilidade retornamos 200 com info
    res.json(payload);
  } catch (err) {
    console.error('❌ [healthController] erro:', err && err.message ? err.message : err);
    res.status(200).json({
      error: 'Erro ao montar health payload',
      message: String(err && err.message ? err.message : err)
    });
  }
}

/* ---------------------- exports ---------------------- */
module.exports = {
  getHealth,
  buildHealthPayload
};
