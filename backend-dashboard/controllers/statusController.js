// controllers/statusController.js
// Versão ajustada: detecta colunas, persiste em status_operador (tempoStatus preferencial),
// conta colaboradores ativos (Status = 1) e expõe totalActive, logados no GET.

const axios = require('axios');
const { promisify } = require('util');
const sleep = promisify(setTimeout);

const { getLocalPool, sql } = require('../config/db.js'); // ajuste se o path for diferente

// ---------- Config ----------
const ARGUS_TIMEOUT        = parseInt(process.env.ARGUS_TIMEOUT || '5000', 10);
const ARGUS_CONCURRENCY    = parseInt(process.env.ARGUS_CONCURRENCY || '6', 10);
const ARGUS_RETRY          = parseInt(process.env.ARGUS_RETRY || '2', 10);
const ARGUS_RETRY_DELAY_MS = parseInt(process.env.ARGUS_RETRY_DELAY_MS || '400', 10);
const STATUS_CACHE_MS      = parseInt(process.env.STATUS_CACHE_MS || process.env.CACHE_DURATION || '15000', 10);
const UPDATE_INTERVAL_MS   = parseInt(process.env.UPDATE_INTERVAL_MS || '60000', 10);
const ARGUS_TOKEN          = process.env.TOKEN_ARGUS || null;

const EMPRESA_FILTRO = process.env.EMPRESA_STATUS || process.env.EMPRESA || 'VIEIRACRED';
const CARGO_FILTRO   = process.env.CARGO_STATUS   || process.env.CARGO   || 'Operador de Vendas';
const TABELA_COLAB   = process.env.TABELA_COLAB   || 'dbo.colaboradores';     // tabela fonte
const TABELA_STATUS  = process.env.TABELA_STATUS  || 'dbo.status_operador';   // tabela destino

// --------- Facilidade de ajuste (env) ----------
const LOG_EMPRESA = process.env.LOG_EMPRESA || EMPRESA_FILTRO; // empresa para contar logados
// LOG_EQUIPES example: "Atendimento,Operador de Vendas"
const LOG_EQUIPES = process.env.LOG_EQUIPES
  ? process.env.LOG_EQUIPES.split(',').map(s => s.trim()).filter(Boolean)
  : []; // vazio = não filtra por equipes

// ---------- Estado interno ----------
const state = {
  cache: { data: null, ts: 0 },
  isFetching: false,
  failCount: 0,
  nextAllowedAt: 0,
  lastError: null,
  schedulerId: null,
  _argusAuthFailed: false,
  _colsCache: {},   // cache de colunas: { 'dbo.colaboradores': Set(...) , ... }
};

// helpers de tempo
const now = () => Date.now();
const ms  = (s) => s * 1000;

// ---------- Util ----------
async function processBatch(items = [], fn, concurrency = 5, throttleMs = 50) {
  const out = [];
  for (let i = 0; i < items.length; i += concurrency) {
    const chunk = items.slice(i, i + concurrency);
    const res = await Promise.all(chunk.map(it => fn(it).catch(err => {
      state.lastError = err;
      console.error('❌ processBatch item error:', err?.message || err);
      return null;
    })));
    out.push(...res.filter(Boolean));
    if (items.length > concurrency && throttleMs > 0) await sleep(throttleMs);
  }
  return out;
}

function parseTableName(fullName = 'dbo.colaboradores') {
  const parts = fullName.replace(/\[|\]/g, '').split('.');
  if (parts.length === 2) return { schema: parts[0], table: parts[1] };
  if (parts.length === 1) return { schema: 'dbo', table: parts[0] };
  return { schema: parts[0], table: parts.slice(1).join('_') };
}

function findFirst(colsSet, candidates = []) {
  // colsSet: Set of lowercased column names
  for (const c of candidates) {
    if (colsSet.has(String(c).toLowerCase())) return String(c); // retornamos o candidato
  }
  return null;
}

// ---------- Argus: fetch com retries e tratamento de 403 ----------
async function fetchArgusForRamal(ramal) {
  if (!ARGUS_TOKEN || !ramal) return null;
  if (state._argusAuthFailed) return null;

  const url = `https://argus.app.br/apiargus/cmd/statusoperador`;
  const params = { ramal };

  let lastErr = null;
  for (let attempt = 0; attempt <= ARGUS_RETRY; attempt++) {
    try {
      const resp = await axios.get(url, {
        params,
        headers: { 'Token-Signature': ARGUS_TOKEN },
        timeout: ARGUS_TIMEOUT,
        validateStatus: () => true,
      });

      if (resp.status === 200 && resp.data) {
        const st = resp.data.statusOperador || {};
        if (resp.data.codStatus && resp.data.codStatus !== 1) {
          // codStatus diferente de 1 -> sem dado válido
          return null;
        }
        return {
          ramal,
          descricaoStatus: st.descricaoStatus || '',
          tempoStatusSegundos: Math.floor((st.tempoStatus || 0) / 1000),
          raw: resp.data
        };
      }

      if (resp.status === 403) {
        console.error(`[Argus] 403 Forbidden ao consultar ramal ${ramal}. Verifique TOKEN_ARGUS.`);
        state._argusAuthFailed = true;
        return null;
      }

      if (resp.status === 400) {
        // provável ramal inválido -> não re-tentar
        console.warn(`[Argus] 400 para ramal ${ramal} -> ignorando. Resp:`, resp.data);
        return null;
      }

      // 5xx -> log e retry conforme laço
      if (resp.status >= 500) {
        console.warn(`[Argus] ${resp.status} (server error) para ramal ${ramal}. Resp:`, resp.data);
        lastErr = new Error(`HTTP ${resp.status} - ${resp.statusText || ''}`);
        if (attempt < ARGUS_RETRY) {
          await sleep(ARGUS_RETRY_DELAY_MS * (attempt + 1));
          continue;
        }
        return null;
      }

      lastErr = new Error(`HTTP ${resp.status} - ${resp.statusText || ''}`);
      if (attempt < ARGUS_RETRY) await sleep(ARGUS_RETRY_DELAY_MS * (attempt + 1));
    } catch (err) {
      lastErr = err;
      if (attempt < ARGUS_RETRY) {
        await sleep(ARGUS_RETRY_DELAY_MS * (attempt + 1));
        continue;
      }
      console.error(`❌ fetchArgusForRamal(${ramal}) ->`, err?.message || err);
      return null;
    }
  }

  if (lastErr) console.warn(`fetchArgusForRamal final failure ramal=${ramal} -> ${lastErr.message || lastErr}`);
  return null;
}

// ---------- Detectar colunas de uma tabela (cacheado) ----------
async function detectColumns(pool, fullTableName) {
  if (!pool) return new Set();
  if (state._colsCache[fullTableName]) return state._colsCache[fullTableName];

  try {
    const { schema, table } = parseTableName(fullTableName);
    const q = `
      SELECT COLUMN_NAME
      FROM INFORMATION_SCHEMA.COLUMNS
      WHERE TABLE_SCHEMA = @schema AND TABLE_NAME = @table
    `;
    const r = await pool.request()
      .input('schema', sql.NVarChar, schema)
      .input('table', sql.NVarChar, table)
      .query(q);

    const cols = new Set((r.recordset || []).map(x => String(x.COLUMN_NAME).toLowerCase()));
    state._colsCache[fullTableName] = cols;
    return cols;
  } catch (e) {
    console.warn(`[statusController] detectColumns erro para ${fullTableName}:`, e?.message || e);
    state._colsCache[fullTableName] = new Set();
    return new Set();
  }
}

// ---------- LER (GET) — entrega pro front (lê status_operador, totalActive, logados) ----------
async function getStatusOperadores(req, res) {
  try {
    const t = now();
    if (state.cache.data && (t - state.cache.ts) < STATUS_CACHE_MS) {
      return res.json(state.cache.data);
    }

    const pool = await getLocalPool();
    if (!pool) throw new Error('Pool DB indisponível');

    // detectar colunas das duas tabelas
    const colabCols = await detectColumns(pool, TABELA_COLAB);
    const statusCols = await detectColumns(pool, TABELA_STATUS);

    // detectar coluna de status em colaboradores (para contar ativos)
    const statusCandidates = ['Status','status','ativo','is_active','situacao','situacao_id','ativo_flag','status_id','ativo_int','status_col'];
    let foundStatusCol = null;
    for (const cand of statusCandidates) {
      if (colabCols.has(String(cand).toLowerCase())) { foundStatusCol = cand; break; }
    }

    // 1) contar colaboradores ativos (empresa = EMPRESA_FILTRO AND [foundStatusCol] = 1)
    let totalActive = 0;
    try {
      if (foundStatusCol) {
        const countQ = `
          SELECT COUNT(1) AS total_ativos
          FROM ${TABELA_COLAB}
          WHERE ${colabCols.has('empresa') ? '[empresa] = @empresa' : '1=1'}
            AND [${foundStatusCol}] = 1
        `;
        const rc = await pool.request().input('empresa', sql.VarChar(200), EMPRESA_FILTRO).query(countQ);
        totalActive = (rc && rc.recordset && rc.recordset[0] && Number(rc.recordset[0].total_ativos)) || 0;
      } else {
        console.warn('[statusController] coluna de status não encontrada em colaboradores; totalActive ficará 0.');
        totalActive = 0;
      }
    } catch (eCount) {
      console.warn('[statusController] falha ao contar colaboradores ativos:', eCount?.message || eCount);
      totalActive = 0;
    }

    // ---------- preparar JOIN entre status_operador (s) e colaboradores (c) quando possível ----------
    // detectar id_argus em ambas as tabelas
    const idArgusStatus = findFirst(statusCols, ['id_argus', 'ramal']);
    const idArgusColab  = findFirst(colabCols,  ['id_argus', 'ramal']);

    // columnas de nome/equipe preferenciais no colaborador
    const colabNomeFront = findFirst(colabCols, ['Nome_Front','nome_front','nomefront']);
    const colabNome = findFirst(colabCols, ['Nome','nome','name']);
    const colabEquipe = findFirst(colabCols, ['equipe','team','grupo']);

    // columnas do status table
    const statusNome = findFirst(statusCols, ['nome','nome_front','name']);
    const statusEquipe = findFirst(statusCols, ['equipe','team']);
    const descCol = findFirst(statusCols, ['descricaoStatus', 'status_operador', 'descricao_status', 'status']);
    const tempoCol = statusCols.has('tempostatus') ? 'tempoStatus'
                   : (statusCols.has('tempo_status') ? 'tempo_status'
                   : (statusCols.has('tempo_status_segundos') ? 'tempo_status_segundos' : null));
    const updatedAtCol = findFirst(statusCols, ['updated_at', 'updatedat', 'updatedAt', 'data_update']);

    // montar FROM com JOIN qualificado se possível
    let fromJoin;
    let whereClause = '';
    const paramsReq = pool.request().input('empresa', sql.VarChar(200), EMPRESA_FILTRO);

    if (idArgusStatus && idArgusColab) {
      fromJoin = `FROM ${TABELA_STATUS} s LEFT JOIN ${TABELA_COLAB} c ON s.[${idArgusStatus}] = c.[${idArgusColab}]`;
      // filtrar por empresa e somente colaboradores ativos (quando coluna encontrada)
      if (foundStatusCol && colabCols.has('empresa')) {
        whereClause = `WHERE COALESCE(c.[${foundStatusCol}], 0) = 1 AND c.[empresa] = @empresa`;
      } else if (colabCols.has('empresa')) {
        // sem coluna de status, ao menos filtra por empresa se possível
        whereClause = `WHERE c.[empresa] = @empresa`;
      } else if (findFirst(statusCols, ['empresa'])) {
        // se status table tem empresa, filtra lá
        const statusEmpresa = findFirst(statusCols, ['empresa']);
        whereClause = `WHERE s.[${statusEmpresa}] = @empresa`;
      } else {
        whereClause = `WHERE 1=1`;
      }
    } else {
      // sem join possível, fazemos SELECT direto de status table (mesmo tratamento de empresa)
      fromJoin = `FROM ${TABELA_STATUS} s`;
      if (findFirst(statusCols, ['empresa'])) {
        const statusEmpresa = findFirst(statusCols, ['empresa']);
        whereClause = `WHERE s.[${statusEmpresa}] = @empresa`;
      } else {
        whereClause = `WHERE 1=1`;
      }
    }

    // montar SELECT com COALESCE para nome/equipe (preferir Nome_Front da tabela colaboradores)
    const selectParts = [];

    // id_argus: prefer s.[idArgusStatus] (se existir), alias para id_argus
    if (idArgusStatus) selectParts.push(`s.[${idArgusStatus}] AS id_argus`);
    else selectParts.push(`NULL AS id_argus`);

    // id_new: prefer c.id_new then s.id_new
    const colabIdNew = findFirst(colabCols, ['id_new', 'usuario_id']);
    const statusIdNew = findFirst(statusCols, ['id_new', 'usuario_id']);
    if (colabIdNew && statusIdNew) {
      selectParts.push(`COALESCE(c.[${colabIdNew}], s.[${statusIdNew}]) AS id_new`);
    } else if (colabIdNew) {
      selectParts.push(`c.[${colabIdNew}] AS id_new`);
    } else if (statusIdNew) {
      selectParts.push(`s.[${statusIdNew}] AS id_new`);
    } else {
      selectParts.push(`NULL AS id_new`);
    }

    // nome: prefer c.Nome_Front -> c.Nome -> s.nome
    const nomeExprParts = [];
    if (colabNomeFront) nomeExprParts.push(`c.[${colabNomeFront}]`);
    if (colabNome) nomeExprParts.push(`c.[${colabNome}]`);
    if (statusNome) nomeExprParts.push(`s.[${statusNome}]`);
    const nomeExpr = nomeExprParts.length ? `COALESCE(${nomeExprParts.join(', ')}, '') AS nome` : `'' AS nome`;
    selectParts.push(nomeExpr);

    // equipe: prefer c.equipe -> s.equipe -> ''
    const equipeExprParts = [];
    if (colabEquipe) equipeExprParts.push(`c.[${colabEquipe}]`);
    if (statusEquipe) equipeExprParts.push(`s.[${statusEquipe}]`);
    const equipeExpr = equipeExprParts.length ? `COALESCE(${equipeExprParts.join(', ')}, '') AS equipe` : `'' AS equipe`;
    selectParts.push(equipeExpr);

    // descricaoStatus
    if (descCol) selectParts.push(`s.[${descCol}] AS descricaoStatus`);
    else selectParts.push(`'' AS descricaoStatus`);

    // tempoStatus (prioriza coluna de status table encontrada)
    if (tempoCol) selectParts.push(`s.[${tempoCol}] AS tempoStatus`);
    else selectParts.push(`0 AS tempoStatus`);

    // updated_at
    if (updatedAtCol) selectParts.push(`s.[${updatedAtCol}] AS updated_at`);
    else selectParts.push(`GETDATE() AS updated_at`);

    // ORDER BY: qualificar explicitamente evitando Ambiguous
    // order equipe then nome (usamos COALESCE já qualificado)
    const orderEquipeExpr = equipeExprParts.length
      ? `COALESCE(${equipeExprParts.join(', ')}, '')`
      : `''`;
    const orderNomeExpr = nomeExprParts.length
      ? `COALESCE(${nomeExprParts.join(', ')}, '')`
      : `''`;

    const q = `
      SELECT ${selectParts.join(', ')}
      ${fromJoin}
      ${whereClause}
      ORDER BY ${orderEquipeExpr}, ${orderNomeExpr}
    `;

    const r = await paramsReq.query(q);
    const rows = r.recordset || [];

    // mapear operadores (somente participantes ativos já filtrados quando possível)
    const operadores = rows.map(row => ({
      nome: row.nome || '',
      equipe: row.equipe || '',
      descricaoStatus: row.descricaoStatus || '',
      tempoStatus: Number(row.tempoStatus) || 0,
      ramal: row.id_argus || null,
      usuario_id: row.id_new ? String(row.id_new) : null,
      updated_at: row.updated_at ? new Date(row.updated_at).toISOString() : null
    }));

    // ----------------- calcular 'logados' conforme regras -----------------
    // Tentativa eficiente: COUNT direto no banco respeitando:
    // - colaborador ativo (foundStatusCol = 1)
    // - empresa = LOG_EMPRESA
    // - equipes IN (LOG_EQUIPES) se fornecida
    let logados = 0;
    try {
      if (idArgusStatus && idArgusColab && foundStatusCol && LOG_EMPRESA) {
        if (LOG_EQUIPES && LOG_EQUIPES.length) {
          const reqCount = pool.request().input('logEmpresa', sql.VarChar(200), LOG_EMPRESA);
          LOG_EQUIPES.forEach((t, i) => reqCount.input(`t${i}`, sql.VarChar(200), t));

          const teamPlaceholders = LOG_EQUIPES.map((_, i) => `@t${i}`).join(',');

          // montar condição de equipe tentando usar c.[colabEquipe] primeiro, fallback s.[statusEquipe]
          const teamConditions = [];
          if (colabEquipe) teamConditions.push(`c.[${colabEquipe}] IN (${teamPlaceholders})`);
          if (statusEquipe) teamConditions.push(`s.[${statusEquipe}] IN (${teamPlaceholders})`);
          const teamCondSql = teamConditions.length ? `AND (${teamConditions.join(' OR ')})` : '';

          const countQ = `
            SELECT COUNT(DISTINCT s.[${idArgusStatus}]) AS total_logados
            FROM ${TABELA_STATUS} s
            LEFT JOIN ${TABELA_COLAB} c ON s.[${idArgusStatus}] = c.[${idArgusColab}]
            WHERE COALESCE(c.[${foundStatusCol}], 0) = 1
              AND c.[empresa] = @logEmpresa
              ${teamCondSql}
          `;
          const rc2 = await reqCount.query(countQ);
          logados = (rc2 && rc2.recordset && Number(rc2.recordset[0].total_logados)) || 0;
        } else {
          const rc2 = await pool.request()
            .input('logEmpresa', sql.VarChar(200), LOG_EMPRESA)
            .query(`
              SELECT COUNT(DISTINCT s.[${idArgusStatus}]) AS total_logados
              FROM ${TABELA_STATUS} s
              LEFT JOIN ${TABELA_COLAB} c ON s.[${idArgusStatus}] = c.[${idArgusColab}]
              WHERE COALESCE(c.[${foundStatusCol}], 0) = 1
                AND c.[empresa] = @logEmpresa
            `);
          logados = (rc2 && rc2.recordset && Number(rc2.recordset[0].total_logados)) || 0;
        }
      } else {
        // fallback em memória: conta operadores já carregados verificando equipe quando necessário
        logados = operadores.filter(op => {
          if (LOG_EQUIPES && LOG_EQUIPES.length) {
            if (!op.equipe) return false;
            if (!LOG_EQUIPES.includes(String(op.equipe).trim())) return false;
          }
          return true;
        }).length;
      }
    } catch (eLog) {
      console.warn('[statusController] falha ao contar logados:', eLog?.message || eLog);
      logados = operadores.filter(op => {
        if (LOG_EQUIPES && LOG_EQUIPES.length) {
          if (!op.equipe) return false;
          if (!LOG_EQUIPES.includes(String(op.equipe).trim())) return false;
        }
        return true;
      }).length;
    }

    // ----------------- payload -----------------
    const payload = {
      operadores,
      horario_atual: t,
      total: operadores.length,
      totalActive,        // total de colaboradores ativos na tabela colaboradores
      logados,            // total de operadores "logados" filtrados por empresa/equipes/ativos
      logados_total: logados
    };

    state.cache = { data: payload, ts: t };
    console.log(`[status][GET] total=${operadores.length} totalActive=${totalActive} logados=${logados}`);

    // dispara uma atualização assíncrona (respeita backoff/single flight)
    updateStatusOperadores().catch(() => {});

    return res.json(payload);
  } catch (err) {
    state.lastError = err;
    console.error('❌ getStatusOperadores erro:', err?.message || err);
    if (state.cache.data) return res.json(state.cache.data);
    return res.status(200).json({ operadores: [], totalActive: 0, logados: 0, logados_total: 0 });
  }
}

// ---------- ATUALIZAÇÃO (Argus -> status_operador) ----------
async function updateStatusOperadores() {
  const t = now();

  if (t < state.nextAllowedAt) {
    const wait = state.nextAllowedAt - t;
    return { skipped: true, reason: 'backoff', nextTryInMs: wait };
  }

  if (state.isFetching) {
    return { skipped: true, reason: 'in-flight' };
  }

  if (!ARGUS_TOKEN) {
    console.warn('[statusController] TOKEN_ARGUS não definido — pulando atualização.');
    return { skipped: true, reason: 'no-token' };
  }
  if (state._argusAuthFailed) {
    console.warn('[statusController] Argus auth falhou anteriormente (403). Atualize TOKEN_ARGUS e reinicie para retomar.');
    return { skipped: true, reason: 'argus-auth-failed' };
  }

  console.log('🔄 [statusController] updateStatusOperadores iniciado');
  state.isFetching = true;

  try {
    const pool = await getLocalPool();
    if (!pool) throw new Error('Pool DB indisponível');

    const colabCols = await detectColumns(pool, TABELA_COLAB);
    const statusCols = await detectColumns(pool, TABELA_STATUS);

    if (!colabCols.has('id_argus') && !colabCols.has('ramal')) {
      console.warn('[statusController] a tabela colaboradores não possui a coluna id_argus/ramal.');
      resetBackoff();
      return { updated: 0 };
    }

    // construir SELECT dos ramais: pegamos id_argus e id_new (se disponível)
    const idNewCandidate = colabCols.has('id_new') ? 'id_new' : (colabCols.has('usuario_id') ? 'usuario_id' : null);
    const selectCols = [
      'id_argus',
      idNewCandidate ? `[${idNewCandidate}] AS id_new` : 'NULL AS id_new',
    ].join(', ');

    const qr = `
      SELECT ${selectCols}
      FROM ${TABELA_COLAB}
      WHERE ${colabCols.has('empresa') ? '[empresa] = @empresa' : '1=1'}
        AND id_argus IS NOT NULL
        AND id_argus <> ''
    `;

    const rr = await pool.request().input('empresa', sql.VarChar(200), EMPRESA_FILTRO).query(qr);
    const ramais = rr.recordset || [];

    if (!ramais.length) {
      console.log('ℹ️ [statusController] nenhum ramal encontrado para atualização.');
      resetBackoff();
      return { updated: 0 };
    }

    // 2) consultar Argus em batches concorrentes
    const resultados = await processBatch(
      ramais,
      async item => {
        const arg = await fetchArgusForRamal(item.id_argus);
        if (!arg) return null;
        return {
          id_argus: item.id_argus,
          descricaoStatus: arg.descricaoStatus || '',
          tempoStatusSegundos: arg.tempoStatusSegundos || 0,
          id_new: item.id_new || null
        };
      },
      ARGUS_CONCURRENCY,
      75
    );

    const updates = resultados.filter(Boolean);
    if (!updates.length) {
      console.log('ℹ️ [statusController] nenhuma atualização obtida do Argus.');
      resetBackoff();
      return { updated: 0 };
    }

    // 3) persistir no status_operador (upsert tolerante)
    let updatedCount = 0;

    // preferências: usar 'tempoStatus' como coluna destino quando existir
    const tempoDest = statusCols.has('tempostatus') ? 'tempoStatus'
                   : (statusCols.has('tempo_status') ? 'tempo_status'
                   : (statusCols.has('tempo_status_segundos') ? 'tempo_status_segundos' : null));
    const descDest = findFirst(statusCols, ['descricaoStatus', 'status_operador', 'descricao_status', 'status']);
    const idArgusDest = findFirst(statusCols, ['id_argus', 'ramal']);
    const idNewDest = findFirst(statusCols, ['id_new', 'usuario_id']);
    const nomeDest = findFirst(statusCols, ['nome', 'nome_front']);
    const empresaDest = findFirst(statusCols, ['empresa']);
    const updatedAtDest = findFirst(statusCols, ['updated_at', 'updatedat', 'updatedAt']);

    if (!idArgusDest) {
      console.warn('[statusController] tabela status_operador não possui coluna id_argus/ramal — impossível atualizar por ramal.');
      return { updated: 0, warning: 'status table sem id_argus' };
    }

    for (const u of updates) {
      try {
        // montar UPDATE dinâmico
        const sets = [];
        const req = pool.request().input('ramal', sql.VarChar(200), String(u.id_argus));

        if (descDest) { sets.push(`[${descDest}] = @status`); req.input('status', sql.VarChar(500), String(u.descricaoStatus || '')); }
        if (tempoDest) { sets.push(`[${tempoDest}] = @tempo`); req.input('tempo', sql.Int, Number(u.tempoStatusSegundos) || 0); }
        if (idNewDest && u.id_new != null) { sets.push(`[${idNewDest}] = @idnew`); req.input('idnew', sql.VarChar(100), String(u.id_new)); }
        if (nomeDest) { /* opcional: não temos nome do Argus, pulamos */ }
        if (empresaDest) { sets.push(`[${empresaDest}] = @empresa`); req.input('empresa', sql.VarChar(200), EMPRESA_FILTRO); }
        if (updatedAtDest) sets.push(`[${updatedAtDest}] = GETDATE()`);

        if (sets.length > 0) {
          const updateSql = `UPDATE ${TABELA_STATUS} SET ${sets.join(', ')} WHERE [${idArgusDest}] = @ramal`;
          const updRes = await req.query(updateSql);
          const rowsAffected = (updRes && updRes.rowsAffected && updRes.rowsAffected.reduce((a,b)=>a+b,0)) || 0;
          if (rowsAffected > 0) {
            updatedCount += rowsAffected;
            continue;
          }
        }

        // se não atualizou, tentar INSERT
        const insertCols = [];
        const insertVals = [];
        const insertReq = pool.request();
        insertReq.input('ramal', sql.VarChar(200), String(u.id_argus));
        insertCols.push(`[${idArgusDest}]`); insertVals.push('@ramal');

        if (descDest) { insertCols.push(`[${descDest}]`); insertVals.push('@status'); insertReq.input('status', sql.VarChar(500), String(u.descricaoStatus || '')); }
        if (tempoDest) { insertCols.push(`[${tempoDest}]`); insertVals.push('@tempo'); insertReq.input('tempo', sql.Int, Number(u.tempoStatusSegundos) || 0); }
        if (idNewDest && u.id_new != null) { insertCols.push(`[${idNewDest}]`); insertVals.push('@idnew'); insertReq.input('idnew', sql.VarChar(100), String(u.id_new)); }
        if (empresaDest) { insertCols.push(`[${empresaDest}]`); insertVals.push('@empresa'); insertReq.input('empresa', sql.VarChar(200), EMPRESA_FILTRO); }
        if (updatedAtDest) { insertCols.push(`[${updatedAtDest}]`); insertVals.push('GETDATE()'); }

        const insertSql = `INSERT INTO ${TABELA_STATUS} (${insertCols.join(', ')}) VALUES (${insertVals.join(', ')})`;
        await insertReq.query(insertSql);
        updatedCount++;
      } catch (e) {
        console.warn('[statusController] falha ao gravar upsert p/ ramal', u.id_argus, e?.message || e);
      }
    }

    // 4) Invalida cache
    state.cache = { data: null, ts: 0 };

    console.log(`✅ [statusController] updateStatusOperadores finalizado — gravados: ${updatedCount}`);
    resetBackoff();
    return { updated: updatedCount };
  } catch (err) {
    state.lastError = err;
    console.error('❌ [statusController] updateStatusOperadores erro:', err?.message || err);
    increaseBackoff();
    if (err && String(err).toLowerCase().includes('403')) state._argusAuthFailed = true;
    return { updated: 0, error: err?.message || String(err) };
  } finally {
    state.isFetching = false;
  }
}

function resetBackoff() {
  state.failCount = 0;
  state.nextAllowedAt = 0;
}

function increaseBackoff() {
  state.failCount = Math.min(state.failCount + 1, 6);
  const delaySec = Math.min(15 * Math.pow(2, state.failCount - 1), 300);
  state.nextAllowedAt = now() + ms(delaySec);
  console.warn(`[statusController] backoff: próxima tentativa em ${delaySec}s`);
}

// ---------- Scheduler ----------
function scheduleStatusUpdater(intervalMs = UPDATE_INTERVAL_MS) {
  if (state.schedulerId) return state.schedulerId;
  updateStatusOperadores().catch(() => {});
  state.schedulerId = setInterval(async () => {
    const t = now();
    if (state.isFetching || t < state.nextAllowedAt) return;
    updateStatusOperadores().catch(() => {});
  }, Math.max(10000, intervalMs));
  return state.schedulerId;
}

// ---------- Exports ----------
module.exports = {
  getStatusOperadores,
  updateStatusOperadores,
  scheduleStatusUpdater,
  __internal: {
    statusCacheRef: () => state,
    lastGoodPayloadRef: () =>
      state.cache?.data ? { ts: state.cache.ts, count: state.cache.data?.operadores?.length || 0 } : null,
    lastErrorRef: () => state.lastError,
    _colsCacheRef: () => state._colsCache,
  },
};
