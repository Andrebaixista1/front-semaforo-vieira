// services/updateService.js
// Serviço genérico para executar/agenda jobs de atualização (status, ranking, empresas...)
// Características:
//  - retries com exponential backoff + jitter
//  - evita execuções concorrentes do mesmo job
//  - agendamento via setInterval
//  - coleta métricas simples por job
// Uso sugerido:
// const updateService = require('./services/updateService');
// updateService.scheduleDefaultJobs({ statusController, rankingController, empresaController }, { intervalMs: 60000 });

const DEFAULT_RETRIES = parseInt(process.env.UPDATE_MAX_RETRIES || '3', 10);
const DEFAULT_RETRY_BASE_MS = parseInt(process.env.UPDATE_RETRY_BASE_MS || '500', 10);
const DEFAULT_INTERVAL_MS = parseInt(process.env.UPDATE_INTERVAL_MS || '60000', 10);
const DEBUG = !!process.env.DEBUG;

function log(...args) {
  if (process.env.NODE_ENV !== 'production') console.log('[updateService]', ...args);
}

/* ------------------------------
   Estado interno / registries
   ------------------------------ */
const jobs = new Map(); // jobName -> { fn, intervalMs, intervalId, isRunning, metrics, opts }

/* ------------------------------
   Util helpers
   ------------------------------ */
function sleep(ms) {
  return new Promise(res => setTimeout(res, ms));
}

function randJitter(maxMs) {
  return Math.floor(Math.random() * maxMs);
}

function safeString(s) {
  return (s == null) ? '' : String(s);
}

/* ------------------------------
   Execução segura com retries
   ------------------------------ */
async function runWithRetry(fn, opts = {}) {
  const {
    retries = DEFAULT_RETRIES,
    retryBaseMs = DEFAULT_RETRY_BASE_MS,
    jitter = true,
    jobName = '(unnamed)'
  } = opts;

  let attempt = 0;
  const start = Date.now();

  while (attempt <= retries) {
    attempt++;
    try {
      const result = await fn();
      return { ok: true, result, attempts: attempt, durationMs: Date.now() - start };
    } catch (err) {
      const isLast = attempt > retries - 1; // if attempt > retries-1 means next is last? simpler: when attempt > retries => fail
      const errMsg = (err && err.message) ? err.message : String(err);
      log(`job=${jobName} attempt=${attempt} failed: ${errMsg}`);
      if (attempt > retries) {
        return { ok: false, error: err, attempts: attempt, durationMs: Date.now() - start };
      }
      // backoff exponential
      const backoff = Math.pow(2, attempt - 1) * retryBaseMs;
      const jitterMs = jitter ? randJitter(Math.min(500, backoff)) : 0;
      const delayMs = backoff + jitterMs;
      await sleep(delayMs);
    }
  }
  return { ok: false, error: new Error('Máximo de retries atingido'), attempts: attempt, durationMs: Date.now() - start };
}

/* ------------------------------
   API: criar / registrar job
   ------------------------------ */
/**
 * registerJob(jobName, fn, intervalMs, opts)
 * - jobName: string único
 * - fn: async function() que executa o trabalho (deve tratar seu próprio erro se desejar)
 * - intervalMs: se informado, será usado no scheduler; se omitido, não agenda automaticamente
 * - opts: { retries, retryBaseMs, jitter, runOnRegister }
 */
function registerJob(jobName, fn, intervalMs = null, opts = {}) {
  if (!jobName || typeof fn !== 'function') {
    throw new Error('registerJob requer jobName (string) e fn (function)');
  }
  if (jobs.has(jobName)) {
    // atualiza a função/intervalo/opts se já existir
    const old = jobs.get(jobName);
    old.fn = fn;
    old.opts = { ...(old.opts || {}), ...(opts || {}) };
    if (intervalMs != null) old.intervalMs = intervalMs;
    return jobs.get(jobName);
  }

  const info = {
    fn,
    intervalMs: intervalMs || null,
    intervalId: null,
    isRunning: false,
    lastRunAt: null,
    metrics: {
      lastDurationMs: null,
      lastError: null,
      lastSuccessAt: null,
      runs: 0,
      successes: 0,
      failures: 0,
      attempts: 0
    },
    opts: opts || {}
  };
  jobs.set(jobName, info);
  // se runOnRegister estiver setado, executa uma vez imediatamente (não bloqueante)
  if (opts.runOnRegister) {
    runJobNow(jobName).catch(() => {});
  }
  return info;
}

/* ------------------------------
   API: executar job agora
   ------------------------------ */
/**
 * runJobNow(jobName, runOpts)
 * - retorna promessa que resolve com { ok, result?, error? }
 */
async function runJobNow(jobName, runOpts = {}) {
  const info = jobs.get(jobName);
  if (!info) throw new Error(`Job '${jobName}' não registrado`);
  if (info.isRunning) {
    // evita concorrência: retornamos info atual para o chamador
    return { ok: false, error: new Error('Job já em execução'), alreadyRunning: true };
  }

  info.isRunning = true;
  info.lastRunAt = Date.now();
  info.metrics.runs = (info.metrics.runs || 0) + 1;
  const mergedOpts = { ...(info.opts || {}), ...(runOpts || {}) };

  const wrapper = async () => {
    try {
      const res = await info.fn();
      return res;
    } catch (e) {
      throw e;
    }
  };

  const retryRes = await runWithRetry(wrapper, { retries: mergedOpts.retries, retryBaseMs: mergedOpts.retryBaseMs, jitter: mergedOpts.jitter, jobName });

  info.metrics.lastDurationMs = retryRes.durationMs || null;
  info.metrics.attempts = (info.metrics.attempts || 0) + (retryRes.attempts || 0);

  if (retryRes.ok) {
    info.metrics.successes = (info.metrics.successes || 0) + 1;
    info.metrics.lastSuccessAt = new Date();
    info.metrics.lastError = null;
    info.isRunning = false;
    return { ok: true, result: retryRes.result };
  } else {
    info.metrics.failures = (info.metrics.failures || 0) + 1;
    info.metrics.lastError = safeString(retryRes.error && retryRes.error.message ? retryRes.error.message : retryRes.error);
    info.isRunning = false;
    return { ok: false, error: retryRes.error };
  }
}

/* ------------------------------
   API: scheduleJob / stopJob / stopAll
   ------------------------------ */
function scheduleJob(jobName, intervalMs = DEFAULT_INTERVAL_MS) {
  const info = jobs.get(jobName);
  if (!info) throw new Error(`Job '${jobName}' não registrado`);
  // se já agendado, limpa primeiro
  if (info.intervalId) {
    clearInterval(info.intervalId);
    info.intervalId = null;
  }
  info.intervalMs = intervalMs;
  // agenda execução periódica (não bloqueante)
  info.intervalId = setInterval(() => {
    // dispara sem aguardar; runJobNow cuida de evitar concorrência
    runJobNow(jobName).catch(err => {
      log(`scheduleJob ${jobName} erro interno:`, err && err.message ? err.message : err);
    });
  }, intervalMs);
  // executar imediatamente uma vez (fire-and-forget) para aquecer cache
  runJobNow(jobName).catch(() => {});
  return info.intervalId;
}

function stopJob(jobName) {
  const info = jobs.get(jobName);
  if (!info) return false;
  if (info.intervalId) {
    clearInterval(info.intervalId);
    info.intervalId = null;
  }
  return true;
}

function stopAll() {
  for (const [name, info] of jobs.entries()) {
    if (info.intervalId) {
      clearInterval(info.intervalId);
      info.intervalId = null;
    }
  }
  return true;
}

/* ------------------------------
   API: introspecção / metrics
   ------------------------------ */
function getJobInfo(jobName) {
  const info = jobs.get(jobName);
  if (!info) return null;
  return {
    intervalMs: info.intervalMs,
    isRunning: info.isRunning,
    lastRunAt: info.lastRunAt,
    metrics: info.metrics
  };
}

function listJobs() {
  const out = [];
  for (const [name, info] of jobs.entries()) {
    out.push({ name, intervalMs: info.intervalMs, isRunning: info.isRunning, lastRunAt: info.lastRunAt, metrics: info.metrics });
  }
  return out;
}

/* ------------------------------
   Helpers: registrar jobs padrão (integração com controllers)
   ------------------------------ */

/**
 * scheduleDefaultJobs(controllers, opts)
 * controllers: { statusController, rankingController, empresaController }
 * opts: { intervalMs, retries, retryBaseMs, runOnRegister }
 */
function scheduleDefaultJobs(controllers = {}, opts = {}) {
  const intervalMs = opts.intervalMs || DEFAULT_INTERVAL_MS;
  const commonOpts = {
    retries: opts.retries != null ? opts.retries : DEFAULT_RETRIES,
    retryBaseMs: opts.retryBaseMs != null ? opts.retryBaseMs : DEFAULT_RETRY_BASE_MS,
    jitter: opts.jitter != null ? opts.jitter : true,
    runOnRegister: opts.runOnRegister != null ? opts.runOnRegister : true
  };

  // status
  if (controllers.statusController && typeof controllers.statusController.updateStatusOperadores === 'function') {
    registerJob('status', async () => {
      return controllers.statusController.updateStatusOperadores();
    }, intervalMs, commonOpts);
    scheduleJob('status', intervalMs);
    log('scheduleDefaultJobs: status registrado');
  } else {
    log('scheduleDefaultJobs: statusController.updateStatusOperadores não disponível');
  }

  // ranking
  if (controllers.rankingController && typeof controllers.rankingController.updateRanking === 'function') {
    registerJob('ranking', async () => {
      // aceita opcional empresa via env/default
      const empresa = process.env.DEFAULT_EMPRESA || 'VIEIRACRED';
      return controllers.rankingController.updateRanking(empresa);
    }, intervalMs, commonOpts);
    scheduleJob('ranking', intervalMs);
    log('scheduleDefaultJobs: ranking registrado');
  } else {
    log('scheduleDefaultJobs: rankingController.updateRanking não disponível');
  }

  // empresas (empresaController deve exportar updateEmpresas ou similar)
  if (controllers.empresaController) {
    const fnName = controllers.empresaController.updateEmpresas ? 'updateEmpresas' : (controllers.empresaController.refreshEmpresas ? 'refreshEmpresas' : null);
    if (fnName && typeof controllers.empresaController[fnName] === 'function') {
      registerJob('empresas', async () => {
        return controllers.empresaController[fnName]();
      }, intervalMs, commonOpts);
      scheduleJob('empresas', intervalMs);
      log('scheduleDefaultJobs: empresas registrado');
    } else {
      log('scheduleDefaultJobs: empresaController sem função update disponível');
    }
  }

  return listJobs();
}

/* ------------------------------
   Exports
   ------------------------------ */
module.exports = {
  // registro / controle
  registerJob,
  scheduleJob,
  stopJob,
  stopAll,
  runJobNow,
  getJobInfo,
  listJobs,
  // convenience
  scheduleDefaultJobs,
};
