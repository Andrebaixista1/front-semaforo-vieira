// controllers/rankingController.js
// Controlador do /api/ranking com integração ao services/fotoService
// Persistência em dbo.ranking_operador (vendedor_id, nome, equipe, foto, valor_vendido, posicao, empresa, updated_at)

const { getLocalPool, getCloudPool, sql } = require('../config/db.js');

const DEBUG = !!process.env.DEBUG;
const DEFAULT_EMPRESA = process.env.DEFAULT_EMPRESA || 'VIEIRACRED';
const CACHE_MS = parseInt(process.env.RANKING_CACHE_MS || '15000', 10);
const SALES_BATCH_SIZE = parseInt(process.env.SALES_BATCH_SIZE || '300', 10);

const escapeSqlStr = s => String(s || '').replace(/'/g, "''");
const toInList = arr => arr.map(id => `'${escapeSqlStr(id)}'`).join(',');

// cache por empresa: { data, ts, isFetching, fetchPromise }
const rankingCacheMap = new Map();
const lastErrorMap = new Map();

/* ---------------------- fotoService (opcional) ---------------------- */
let fotoService = null;
try {
  fotoService = require('../services/fotoService.js');
  if (DEBUG) console.log('[rankingController] fotoService carregado.');
} catch (e) {
  if (DEBUG) console.log('[rankingController] fotoService não encontrado, usando fallback DB.');
  fotoService = null;
}

/* ---------------------- HELPERS (fallback DB) ---------------------- */

async function fetchFotosMapFromDb(ids = [], useCloud = true) {
  if (!ids || !ids.length) return new Map();
  const idsList = toInList(ids);
  const sqlFotos = `
    SELECT usuario_id, COALESCE(imagem_perfil, image_perfil) AS foto
    FROM operadores_new
    WHERE usuario_id IN (${idsList})
  `;
  try {
    const pool = await (useCloud ? getCloudPool() : getLocalPool());
    if (!pool) return new Map();
    const r = await pool.request().query(sqlFotos);
    const map = new Map();
    for (const row of r.recordset || []) {
      map.set(String(row.usuario_id), row.foto || '');
    }
    return map;
  } catch (e) {
    if (DEBUG) console.warn(`[rankingController] fetchFotosMapFromDb(${useCloud ? 'cloud' : 'local'}) erro:`, e && e.message ? e.message : e);
    throw e;
  }
}

async function fetchFotosMapFallback(ids = []) {
  try {
    return await fetchFotosMapFromDb(ids, true);
  } catch (eCloud) {
    try {
      return await fetchFotosMapFromDb(ids, false);
    } catch (eLocal) {
      if (DEBUG) console.error('[rankingController] fetchFotosMapFallback falhou cloud+local:', eLocal && eLocal.message ? eLocal.message : eLocal);
      return new Map();
    }
  }
}

/* ---------------------- FUNÇÃO PARA OBTENÇÃO DE FOTOS (PRINCIPAL) ---------------------- */

async function getFotosMap(ids = []) {
  if (!ids || !ids.length) return new Map();

  if (fotoService) {
    try {
      const fn = fotoService.getFotosMap || fotoService.fetchFotosMap || fotoService.fetchFotos;
      if (typeof fn === 'function') {
        const res = await fn(ids);
        if (res instanceof Map) return res;
        if (res && typeof res === 'object') {
          const m = new Map();
          if (Array.isArray(res)) {
            for (const item of res) {
              if (item && (item.id || item.usuario_id)) {
                const id = String(item.id || item.usuario_id);
                m.set(id, item.foto || item.fotoRaw || item.url || '');
              }
            }
          } else {
            for (const k of Object.keys(res)) m.set(String(k), res[k] || '');
          }
          return m;
        }
      }
    } catch (e) {
      if (DEBUG) console.warn('[rankingController] fotoService falhou — fallback para DB:', e && e.message ? e.message : e);
    }
  }

  return await fetchFotosMapFallback(ids);
}

/* ---------------------- HELPERS: vendas ---------------------- */

async function getSalesTodayForVendedorIds(ids = [], batchSize = SALES_BATCH_SIZE) {
  const acc = new Map();
  if (!ids || !ids.length) return acc;
  try {
    const pool = await getCloudPool();
    if (!pool) return acc;
    for (let i = 0; i < ids.length; i += batchSize) {
      const chunk = ids.slice(i, i + batchSize);
      const idsList = toInList(chunk);
      const q = `
        SELECT vendedor_id AS id, SUM(valor_referencia) AS valor
        FROM cadastrados
        WHERE vendedor_id IN (${idsList})
          AND CAST(data_cadastro AS DATE) = CAST(GETDATE() AS DATE)
        GROUP BY vendedor_id
      `;
      const r = await pool.request().query(q);
      for (const row of r.recordset || []) {
        const key = String(row.id);
        const prev = acc.get(key) || 0;
        acc.set(key, prev + (parseFloat(row.valor) || 0));
      }
    }
    return acc;
  } catch (e) {
    if (DEBUG) console.error('[rankingController] getSalesTodayForVendedorIds erro:', e && e.message ? e.message : e);
    throw e;
  }
}

/* ---------------------- PERSISTÊNCIA EM TABELA ranking_operador ---------------------- */

/**
 * Persiste ranking do dia na tabela dbo.ranking_operador
 * - empresa: string
 * - rows: [{ id, nome, equipe, foto, valorVendido, posicao }]
 */
async function saveRankingToTable(empresa = DEFAULT_EMPRESA, rows = []) {
  if (!Array.isArray(rows)) rows = [];
  let pool;
  try {
    pool = await getLocalPool();
    if (!pool) {
      if (DEBUG) console.warn('[rankingController] saveRankingToTable: local pool indisponível');
      return false;
    }

    const tx = new sql.Transaction(pool);
    await tx.begin();

    // Apaga registros do dia para a empresa
    const delReq = new sql.Request(tx);
    delReq.input('empresa', sql.VarChar, String(empresa));
    await delReq.query(`
      DELETE FROM dbo.ranking_operador
      WHERE empresa = @empresa
        AND CAST(updated_at AS DATE) = CAST(GETDATE() AS DATE)
    `);

    // Inserir linhas
    for (const r of rows) {
      const req = new sql.Request(tx);
      req.input('empresa', sql.VarChar, String(empresa));
      req.input('posicao', sql.Int, Number(r.posicao || 0));
      req.input('vendedor_id', sql.VarChar, String(r.id || ''));
      req.input('nome', sql.VarChar, r.nome || '');
      req.input('equipe', sql.VarChar, r.equipe || '');
      req.input('foto', sql.VarChar(sql.MAX), r.foto || null);
      // valor_vendido decimal(18,2)
      const valor = Number.isFinite(Number(r.valorVendido)) ? Number(r.valorVendido) : 0;
      req.input('valor_vendido', sql.Decimal(18, 2), valor);
      await req.query(`
        INSERT INTO dbo.ranking_operador
          (vendedor_id, nome, equipe, foto, valor_vendido, posicao, empresa, updated_at)
        VALUES
          (@vendedor_id, @nome, @equipe, @foto, @valor_vendido, @posicao, @empresa, SYSUTCDATETIME())
      `);
    }

    await tx.commit();
    if (DEBUG) console.log(`[rankingController] saveRankingToTable: salvo ${rows.length} registros para ${empresa}`);
    return true;
  } catch (e) {
    try { if (pool && pool.connected) { /* no-op */ } } catch (_) {}
    try { if (e && e.name) { /* no-op */ } } catch (_) {}
    try {
      if (e && e.transaction && typeof e.transaction.rollback === 'function') await e.transaction.rollback();
    } catch (_) {}
    console.error('[rankingController] saveRankingToTable erro:', e && e.message ? e.message : e);
    return false;
  }
}

/**
 * Lê ranking persistido para o dia atual a partir de updated_at
 * Retorna array de { id, nome, equipe, foto, valorVendido, posicao }
 */
async function getRankingFromTable(empresa = DEFAULT_EMPRESA) {
  try {
    const pool = await getLocalPool();
    if (!pool) return [];
    const req = pool.request();
    req.input('empresa', sql.VarChar, String(empresa));
    const r = await req.query(`
      SELECT vendedor_id AS id, nome, equipe, foto, valor_vendido AS valorVendido, posicao, empresa, updated_at
      FROM dbo.ranking_operador
      WHERE empresa = @empresa
        AND CAST(updated_at AS DATE) = CAST(GETDATE() AS DATE)
      ORDER BY posicao ASC
    `);
    return r.recordset || [];
  } catch (e) {
    console.error('[rankingController] getRankingFromTable erro:', e && e.message ? e.message : e);
    return [];
  }
}

/* ---------------------- LÓGICA DE ATUALIZAÇÃO ---------------------- */

async function updateRanking(empresa = DEFAULT_EMPRESA) {
  const key = String(empresa || DEFAULT_EMPRESA);
  if (DEBUG) console.log(`[rankingController] updateRanking iniciado para empresa='${key}'`);

  try {
    const poolLocal = await getLocalPool();
    if (!poolLocal) throw new Error('Pool LOCAL indisponível');

    // pegar vendedores
    const vendedoresQ = `
      SELECT id_new, Nome_Front AS nome, equipe, empresa
      FROM colaboradores
      WHERE empresa = @empresa
    `;
    const reqVend = poolLocal.request();
    reqVend.input('empresa', sql.VarChar, key);
    const vendRes = await reqVend.query(vendedoresQ);
    const vendedores = vendRes.recordset || [];

    if (!vendedores.length) {
      const outEmpty = [];
      rankingCacheMap.set(key, { data: outEmpty, ts: Date.now(), isFetching: false, fetchPromise: null });
      return outEmpty;
    }

    const vendedorIds = vendedores.map(v => String(v.id_new)).filter(Boolean);
    if (!vendedorIds.length) {
      const outEmpty = [];
      rankingCacheMap.set(key, { data: outEmpty, ts: Date.now(), isFetching: false, fetchPromise: null });
      return outEmpty;
    }

    // buscar vendas do dia
    let salesMap;
    try {
      salesMap = await getSalesTodayForVendedorIds(vendedorIds, SALES_BATCH_SIZE);
    } catch (e) {
      lastErrorMap.set(key, e);
      if (DEBUG) console.warn('[rankingController] falha ao buscar vendas na nuvem, tentando persistido...', e && e.message ? e.message : e);
      const persisted = await getRankingFromTable(key);
      if (persisted && persisted.length) return persisted;
      const old = rankingCacheMap.get(key);
      if (old && old.data) return old.data;
      return [];
    }

    if (!salesMap || salesMap.size === 0) {
      const outEmpty = [];
      rankingCacheMap.set(key, { data: outEmpty, ts: Date.now(), isFetching: false, fetchPromise: null });
      return outEmpty;
    }

    const allRows = Array.from(salesMap.entries()).map(([id, valor]) => ({ id: String(id), valorVendido: valor }));
    allRows.sort((a, b) => b.valorVendido - a.valorVendido);
    const topRows = allRows.slice(0, 5);
    const topIds = topRows.map(r => r.id);

    // buscar fotos (via fotoService / fallback DB)
    let fotosMap = new Map();
    try {
      fotosMap = await getFotosMap(topIds);
    } catch (e) {
      if (DEBUG) console.warn('[rankingController] getFotosMap erro, prosseguindo sem fotos:', e && e.message ? e.message : e);
      fotosMap = new Map();
    }

    // montar resultado
    const vendMap = new Map(vendedores.map(v => [String(v.id_new), v]));
    const result = topRows.map((r, idx) => {
      const vend = vendMap.get(r.id) || {};
      const rawFoto = String(fotosMap.get(r.id) || '').trim();
      const foto = (fotoService && typeof fotoService.sanitizeFotoPath === 'function')
        ? fotoService.sanitizeFotoPath(rawFoto)
        : (rawFoto || null);
      return {
        id: r.id,
        nome: vend.nome || 'Vendedor Não Encontrado',
        equipe: vend.equipe || 'N/A',
        foto,
        valorVendido: parseFloat(r.valorVendido) || 0,
        posicao: idx + 1,
        empresa: vend.empresa || key
      };
    });

    // salvar em background (não bloqueia a resposta)
    saveRankingToTable(key, result).catch(err => {
      if (DEBUG) console.warn('[rankingController] saveRankingToTable falhou (background):', err && err.message ? err.message : err);
    });

    rankingCacheMap.set(key, { data: result, ts: Date.now(), isFetching: false, fetchPromise: null });
    if (DEBUG) console.log(`[rankingController] atualizado para '${key}' (${result.length} registros)`);
    return result;
  } catch (err) {
    lastErrorMap.set(String(empresa || DEFAULT_EMPRESA), err);
    console.error('[rankingController] updateRanking erro:', err && err.message ? err.message : err);
    const cache = rankingCacheMap.get(String(empresa || DEFAULT_EMPRESA));
    if (cache) cache.isFetching = false;
    if (cache && cache.data) return cache.data;
    // tentar ler persistido como último recurso
    try {
      const persisted = await getRankingFromTable(empresa);
      if (persisted && persisted.length) return persisted;
    } catch (_) {}
    return [];
  }
}

/* ---------------------- HANDLER EXPRESS ---------------------- */

async function getRanking(req, res) {
  const empresa = String(req.query.empresa || DEFAULT_EMPRESA);
  const key = empresa;

  const now = Date.now();
  const cache = rankingCacheMap.get(key);
  if (cache && cache.data && (now - cache.ts) < CACHE_MS) {
    return res.json(cache.data);
  }

  if (cache && cache.isFetching && cache.fetchPromise) {
    try {
      const out = await cache.fetchPromise;
      return res.json(out || cache.data || []);
    } catch (e) {
      return res.json(cache.data || []);
    }
  }

  // disparar atualização e guardar promise
  const p = (async () => {
    try {
      const updated = await updateRanking(key);
      return updated;
    } catch (e) {
      throw e;
    } finally {
      const c = rankingCacheMap.get(key);
      if (c) { c.isFetching = false; c.fetchPromise = null; }
    }
  })();

  rankingCacheMap.set(key, { data: cache ? cache.data : null, ts: cache ? cache.ts : 0, isFetching: true, fetchPromise: p });

  try {
    const out = await p;
    return res.json(out || []);
  } catch (e) {
    const c = rankingCacheMap.get(key);
    return res.json((c && c.data) ? c.data : []);
  }
}

/* ---------------------- SCHEDULER ---------------------- */

function scheduleRankingUpdater(intervalMs = parseInt(process.env.UPDATE_INTERVAL_MS || '60000', 10), empresa = DEFAULT_EMPRESA) {
  updateRanking(empresa).catch(() => {});
  const id = setInterval(() => {
    updateRanking(empresa).catch(() => {});
  }, intervalMs);
  return id;
}

/* ---------------------- EXPORTS / DEBUG ---------------------- */
module.exports = {
  getRanking,
  updateRanking,
  scheduleRankingUpdater,
  __internal: {
    cacheMapRef: () => rankingCacheMap,
    lastErrorMapRef: () => lastErrorMap,
    saveRankingToTable,
    getRankingFromTable
  }
};
