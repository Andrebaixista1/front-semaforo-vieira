// controllers/empresaController.js
// Controlador para listar empresas (distinct) a partir da tabela `colaboradores`.
// Exporta:
//  - getEmpresas(req,res,next)    -> handler Express
//  - updateEmpresas()             -> força atualização e retorna o array
//  - scheduleEmpresasUpdater(ms)  -> inicia setInterval e retorna intervalId
//  - __internal.*                 -> referências para debugging

const { getLocalPool, sql } = require('../db'); // espera-se db.js CommonJS exportando getLocalPool, sql
const DEBUG = !!process.env.DEBUG;

const CACHE_MS = parseInt(process.env.EMPRESA_CACHE_MS || '60000', 10); // default 60s

let empresasCache = {
  data: null,
  ts: 0,
  isFetching: false,
  fetchPromise: null
};

let lastError = null;

/* ---------------------- updateEmpresas ---------------------- */
/**
 * Consulta DB local e atualiza o cache com a lista de empresas (distinct).
 * Retorna array de strings.
 */
async function updateEmpresas() {
  try {
    if (DEBUG) console.log('🔄 [empresaController] updateEmpresas iniciado');
    const poolLocal = await getLocalPool();
    if (!poolLocal) {
      throw new Error('Pool LOCAL indisponível');
    }

    const q = `
      SELECT DISTINCT empresa
      FROM colaboradores
      WHERE empresa IS NOT NULL AND empresa != ''
      ORDER BY empresa
    `;

    const r = await poolLocal.request().query(q);
    const empresas = (r.recordset || []).map(row => String(row.empresa).trim()).filter(Boolean);

    empresasCache = {
      data: empresas,
      ts: Date.now(),
      isFetching: false,
      fetchPromise: null
    };

    if (DEBUG) console.log(`✅ [empresaController] atualizado (${empresas.length})`);
    return empresas;
  } catch (err) {
    lastError = err;
    console.error('❌ [empresaController] updateEmpresas erro:', err && err.message ? err.message : err);
    // garantir estado consistente
    if (empresasCache) empresasCache.isFetching = false;
    // fallback: retornar último cache se existir
    if (empresasCache && Array.isArray(empresasCache.data)) {
      return empresasCache.data;
    }
    return [];
  }
}

/* ---------------------- getEmpresas (Express handler) ---------------------- */
/**
 * Handler para /api/empresas
 * Usa cache com TTL e evita simultâneas execuções repetidas da query.
 */
async function getEmpresas(req, res, next) {
  try {
    const now = Date.now();
    if (empresasCache.data && (now - empresasCache.ts) < CACHE_MS) {
      return res.json(empresasCache.data);
    }

    if (empresasCache.isFetching && empresasCache.fetchPromise) {
      // outra requisição já está buscando -> aguardamos
      const out = await empresasCache.fetchPromise.catch(() => null);
      return res.json(out || empresasCache.data || []);
    }

    // dispara atualização e guarda a promise para concorrentes
    empresasCache.isFetching = true;
    empresasCache.fetchPromise = updateEmpresas();

    const payload = await empresasCache.fetchPromise;
    return res.json(payload);
  } catch (err) {
    lastError = err;
    console.error('❌ [empresaController] getEmpresas erro:', err && err.message ? err.message : err);
    // fallback: ultimo cache ou array vazio
    if (empresasCache && Array.isArray(empresasCache.data)) {
      return res.json(empresasCache.data);
    }
    return res.status(200).json([]);
  } finally {
    // nota: updateEmpresas limpa isFetching/fetchPromise ao completar
  }
}

/* ---------------------- scheduleEmpresasUpdater ---------------------- */
/**
 * Inicia um setInterval que chama updateEmpresas() a cada intervalMs.
 * Retorna o intervalId.
 */
function scheduleEmpresasUpdater(intervalMs = parseInt(process.env.UPDATE_INTERVAL_MS || '60000', 10)) {
  // execução imediata não bloqueante
  updateEmpresas().catch(() => {});
  const id = setInterval(() => {
    updateEmpresas().catch(() => {});
  }, intervalMs);
  return id;
}

/* ---------------------- Exports / Debug ---------------------- */
module.exports = {
  getEmpresas,
  updateEmpresas,
  scheduleEmpresasUpdater,
  __internal: {
    cacheRef: () => empresasCache,
    lastErrorRef: () => lastError
  }
};
