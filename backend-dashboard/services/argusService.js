// ===============================================================
// services/argusService.js
// Integração avançada com a API Argus (status dos operadores)
// Agora com cache centralizado via cacheService.js
// ===============================================================

const axios = require('axios');
const { cache } = require('./cacheService');

// ------------------------- CONFIGURAÇÕES -------------------------
const BASE_URL = process.env.ARGUS_BASE_URL || 'https://argus.app.br/apiargus';
const API_PATH = process.env.ARGUS_ENDPOINT || '/cmd/statusoperadores';
const API_KEY = process.env.ARGUS_API_KEY || process.env.TOKEN_ARGUS || null;

const REQUEST_TIMEOUT = parseInt(process.env.ARGUS_TIMEOUT || '8000', 10);
const CACHE_KEY = 'argus:status';
const CACHE_DURATION = parseInt(process.env.ARGUS_CACHE_MS || '15000', 10);
const MAX_RETRIES = parseInt(process.env.ARGUS_MAX_RETRIES || '3', 10);
const RETRY_DELAY = parseInt(process.env.ARGUS_RETRY_DELAY || '1000', 10);

// ------------------------- ESTADO INTERNO -------------------------
let isFetching = false;
let queue = []; // fila de promessas pendentes
let metrics = {
  totalRequests: 0,
  totalErrors: 0,
  lastDurationMs: 0,
  lastError: null,
  lastSuccess: null,
  cachedHits: 0,
  queuedWaits: 0,
};

// ------------------------- HELPERS -------------------------
const delay = ms => new Promise(res => setTimeout(res, ms));

function log(...args) {
  if (process.env.NODE_ENV !== 'production') {
    console.log('[ArgusService]', ...args);
  }
}

/**
 * Retorna dados do cache (via cacheService)
 */
function getCachedData() {
  const cached = cache.get(CACHE_KEY);
  if (cached) {
    metrics.cachedHits++;
    return { data: cached, cached: true, timestamp: Date.now() };
  }
  return null;
}

/**
 * Executa requisição HTTP ao Argus com retry automático
 */
async function requestArgusData() {
  const headers = API_KEY ? { 'Token-Signature': API_KEY } : {};
  const url = `${BASE_URL}${API_PATH.startsWith('/') ? API_PATH : '/' + API_PATH}`;

  let attempt = 0;
  const start = Date.now();

  while (attempt < MAX_RETRIES) {
    attempt++;
    try {
      metrics.totalRequests++;

      const response = await axios.get(url, { headers, timeout: REQUEST_TIMEOUT });
      if (!response?.data) throw new Error('Resposta vazia do Argus');

      const data = response.data;
      if (data.codStatus && data.codStatus !== 1)
        throw new Error(`Argus retornou codStatus=${data.codStatus}`);

      // Atualiza cache centralizado
      cache.set(CACHE_KEY, data, CACHE_DURATION);

      metrics.lastDurationMs = Date.now() - start;
      metrics.lastSuccess = new Date();
      metrics.lastError = null;

      log(`✅ Argus atualizado (${metrics.lastDurationMs}ms)`);
      return { data, cached: false, timestamp: Date.now() };
    } catch (err) {
      metrics.totalErrors++;
      metrics.lastError = err.message;
      log(`⚠️ Tentativa ${attempt}/${MAX_RETRIES} falhou: ${err.message}`);
      if (attempt < MAX_RETRIES) await delay(RETRY_DELAY);
      else throw err;
    }
  }
}

/**
 * Aguarda execução em andamento
 */
async function waitForFetch() {
  return new Promise((resolve, reject) => {
    metrics.queuedWaits++;
    queue.push({ resolve, reject });
  });
}

/**
 * Libera todas as promessas pendentes
 */
function resolveQueue(result, error = null) {
  queue.forEach(({ resolve, reject }) => {
    if (error) reject(error);
    else resolve(result);
  });
  queue = [];
}

// ------------------------- FUNÇÃO PRINCIPAL -------------------------
/**
 * Obtém dados do Argus, com cache, fila e retry.
 * @param {boolean} force - Ignora cache e força nova consulta.
 */
async function fetchArgusData(force = false) {
  // 1️⃣ Checa cache global
  const cached = getCachedData();
  if (cached && !force) return cached;

  // 2️⃣ Evita múltiplas chamadas simultâneas
  if (isFetching) {
    log('🔄 Aguardando fetch Argus em andamento...');
    return waitForFetch();
  }

  // 3️⃣ Faz requisição real
  isFetching = true;
  try {
    const result = await requestArgusData();
    resolveQueue(result);
    return result;
  } catch (err) {
    log('❌ Erro em fetchArgusData:', err.message);
    resolveQueue(null, err);
    throw err;
  } finally {
    isFetching = false;
  }
}

/**
 * Testa a conectividade com o Argus (para uso em /health)
 */
async function testArgusConnection() {
  try {
    await fetchArgusData(true);
    return true;
  } catch {
    return false;
  }
}

// ------------------------- EXPORTS -------------------------
module.exports = {
  fetchArgusData,
  testArgusConnection,
  getMetrics: () => metrics,
  getCache: () => cache.get(CACHE_KEY),
};
