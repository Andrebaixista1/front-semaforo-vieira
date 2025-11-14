// db.js — dois bancos no mesmo servidor (mesmas credenciais)
// getLocalPool()  -> conecta em "colaboradores"
// getCloudPool()  -> conecta em "vieira_online" (ALIAS, sem servidor cloud)

const sql = require('mssql');

const DEBUG = (process.env.NODE_ENV || 'development') !== 'production';
const log  = (...a) => { if (DEBUG) console.log('[db]', ...a); };
const warn = (...a) => { if (DEBUG) console.warn('[db]', ...a); };

/* =========================
   Credenciais únicas (host)
   ========================= */
const HOST = process.env.DB_HOST || process.env.DB_LOCAL_HOST || 'localhost';
const USER = process.env.DB_USER || process.env.DB_USERNAME || process.env.DB_LOCAL_USER || '';
const PASS = process.env.DB_PASSWORD || process.env.DB_PASS || process.env.DB_LOCAL_PASSWORD || '';
const PORT = parseInt(process.env.DB_PORT || '1433', 10);

// TLS/Timeouts
const ENC   = (process.env.DB_ENCRYPT    || 'true').toLowerCase() === 'true';
const TRUST = (process.env.DB_TRUST_CERT || 'true').toLowerCase() === 'true';
const CTIME = parseInt(process.env.DB_CONNECT_TIMEOUT_MS || '15000', 10);
const RTIME = parseInt(process.env.DB_REQUEST_TIMEOUT_MS || '30000', 10);

// Pool
const POOL_MAX  = parseInt(process.env.DB_POOL_MAX || '10', 10);
const POOL_MIN  = parseInt(process.env.DB_POOL_MIN || '0', 10);
const POOL_IDLE = parseInt(process.env.DB_POOL_IDLE_MS || '15000', 10);

// Nomes dos bancos (podem ser sobrepostos por .env)
const DB_COLAB = process.env.DB_NAME_COLABORADORES || 'colaboradores';
const DB_VION  = process.env.DB_NAME_VIEIRA_ONLINE  || 'vieira_online';

/* =========================
   Helpers de configuração
   ========================= */
function makeCfg(databaseName) {
  if (!HOST || !USER || !PASS || !databaseName) {
    throw new Error(`Config inválida: HOST/USER/PASS/DB ausentes (db=${databaseName || 'N/A'})`);
  }
  return {
    server: HOST,
    user:   USER,
    password: PASS,
    database: databaseName,
    port: PORT,
    pool: { max: POOL_MAX, min: POOL_MIN, idleTimeoutMillis: POOL_IDLE },
    options: {
      encrypt: ENC,
      trustServerCertificate: TRUST,
      enableArithAbort: true,
      connectTimeout: CTIME,
      requestTimeout: RTIME,
    }
  };
}

const cfgColaboradores = makeCfg(DB_COLAB);
const cfgVieiraOnline  = makeCfg(DB_VION);

/* =========================
   Estado (memoização)
   ========================= */
let _poolColabPromise = null;
let _poolVieiraPromise = null;

/* =========================
   Retry de conexão
   ========================= */
async function createPoolWithRetry(cfg, name, attempts = 3, delayMs = 1000) {
  let lastErr = null;
  for (let i = 0; i < attempts; i++) {
    try {
      const pool = new sql.ConnectionPool(cfg);
      const connected = await pool.connect();
      connected.on('error', (err) => {
        console.error(`[db][${name}] pool error:`, err && err.message ? err.message : err);
      });
      log(`✅ conectado: ${name} @ ${cfg.server}/${cfg.database}`);
      return connected;
    } catch (err) {
      lastErr = err;
      warn(`tentativa ${i + 1}/${attempts} falhou para ${name}:`, err && err.message ? err.message : err);
      if (i + 1 < attempts) await new Promise(r => setTimeout(r, delayMs));
    }
  }
  throw new Error(`Não foi possível conectar ${name}: ${lastErr && lastErr.message ? lastErr.message : lastErr}`);
}

/* =========================
   Pools
   ========================= */
async function getPoolColaboradores() {
  if (_poolColabPromise) {
    try {
      const p = await _poolColabPromise;
      if (p && p.connected) return p;
    } catch { _poolColabPromise = null; }
  }
  _poolColabPromise = createPoolWithRetry(cfgColaboradores, 'colaboradores', 3, 1000)
    .catch(e => { _poolColabPromise = null; throw e; });
  return _poolColabPromise;
}

async function getPoolVieiraOnline() {
  if (_poolVieiraPromise) {
    try {
      const p = await _poolVieiraPromise;
      if (p && p.connected) return p;
    } catch { _poolVieiraPromise = null; }
  }
  _poolVieiraPromise = createPoolWithRetry(cfgVieiraOnline, 'vieira_online', 3, 1000)
    .catch(e => { _poolVieiraPromise = null; throw e; });
  return _poolVieiraPromise;
}

/* =========================
   Exports esperados
   ========================= */
// Mantém compatibilidade com server.js:
// - getLocalPool()  -> colaboradores
// - getCloudPool()  -> vieira_online (alias)
async function getLocalPool()  { return getPoolColaboradores(); }
async function getCloudPool()  { return getPoolVieiraOnline(); }

async function testConnections() {
  const out = { local: false, cloud: false, details: {} };
  try {
    const p1 = await getPoolColaboradores();
    const r1 = await p1.request().query('SELECT 1 AS ok');
    out.local = true; out.details.local = r1.recordset?.[0] || { ok: 1 };
  } catch (e) {
    out.details.local = e?.message || String(e);
  }
  try {
    const p2 = await getPoolVieiraOnline();
    const r2 = await p2.request().query('SELECT 1 AS ok');
    out.cloud = true; out.details.cloud = r2.recordset?.[0] || { ok: 1 };
  } catch (e) {
    out.details.cloud = e?.message || String(e);
  }
  log('testConnections:', out);
  return out;
}

async function closeConnections() {
  const closers = [];
  if (_poolColabPromise) {
    try { const p = await _poolColabPromise; if (p?.close) closers.push(p.close()); } catch {}
    _poolColabPromise = null;
  }
  if (_poolVieiraPromise) {
    try { const p = await _poolVieiraPromise; if (p?.close) closers.push(p.close()); } catch {}
    _poolVieiraPromise = null;
  }
  await Promise.allSettled(closers);
}

module.exports = {
  sql,
  getLocalPool,    // -> colaboradores
  getCloudPool,    // -> vieira_online (alias)
  testConnections,
  closeConnections,
  __internal: {
    cfgColaboradores,
    cfgVieiraOnline,
    _getLocalPoolPromise: () => _poolColabPromise,
    _getCloudPoolPromise: () => _poolVieiraPromise,
  }
};
