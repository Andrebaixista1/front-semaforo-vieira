// ===============================================================
// services/cacheService.js
// Serviço genérico de cache em memória com TTL, limpeza automática e métricas
// ===============================================================

class CacheService {
  constructor(defaultTTL = 60000) {
    this.cache = new Map();
    this.defaultTTL = defaultTTL;
    this.metrics = {
      hits: 0,
      misses: 0,
      sets: 0,
      deletes: 0,
      size: 0,
      lastCleanup: null,
    };

    // Executa limpeza automática a cada 2x o TTL padrão
    setInterval(() => this.cleanup(), defaultTTL * 2).unref();
  }

  /**
   * Gera uma chave única (string) para armazenar no cache
   */
  _key(key) {
    if (typeof key === 'object') return JSON.stringify(key);
    return String(key);
  }

  /**
   * Define um valor no cache
   * @param {string|object} key 
   * @param {*} value 
   * @param {number} ttl - Tempo de vida em ms (opcional)
   */
  set(key, value, ttl = this.defaultTTL) {
    const k = this._key(key);
    const expiresAt = Date.now() + ttl;
    this.cache.set(k, { value, expiresAt });
    this.metrics.sets++;
    this.metrics.size = this.cache.size;
    return value;
  }

  /**
   * Retorna um valor do cache (ou null se expirado)
   * @param {string|object} key 
   */
  get(key) {
    const k = this._key(key);
    const entry = this.cache.get(k);
    if (!entry) {
      this.metrics.misses++;
      return null;
    }
    if (Date.now() > entry.expiresAt) {
      this.cache.delete(k);
      this.metrics.misses++;
      this.metrics.size = this.cache.size;
      return null;
    }
    this.metrics.hits++;
    return entry.value;
  }

  /**
   * Retorna true se a chave existir e ainda não tiver expirado
   */
  has(key) {
    const k = this._key(key);
    const entry = this.cache.get(k);
    return entry && Date.now() < entry.expiresAt;
  }

  /**
   * Remove uma chave do cache
   */
  delete(key) {
    const k = this._key(key);
    const deleted = this.cache.delete(k);
    if (deleted) {
      this.metrics.deletes++;
      this.metrics.size = this.cache.size;
    }
    return deleted;
  }

  /**
   * Limpa todas as chaves expiradas
   */
  cleanup() {
    const now = Date.now();
    let removed = 0;
    for (const [k, entry] of this.cache.entries()) {
      if (entry.expiresAt <= now) {
        this.cache.delete(k);
        removed++;
      }
    }
    this.metrics.lastCleanup = new Date().toISOString();
    this.metrics.size = this.cache.size;
    if (removed > 0 && process.env.NODE_ENV !== 'production') {
      console.log(`[CacheService] 🧹 Limpou ${removed} entradas expiradas`);
    }
  }

  /**
   * Limpa TODO o cache manualmente
   */
  clear() {
    this.cache.clear();
    this.metrics.size = 0;
  }

  /**
   * Retorna estatísticas e estado atual do cache
   */
  getMetrics() {
    return {
      ...this.metrics,
      cacheSize: this.cache.size,
      keys: this.cache.size,
      uptimeMs: process.uptime() * 1000,
    };
  }
}

// ---------------------- Instância única ----------------------
const globalCache = new CacheService(parseInt(process.env.CACHE_TTL_DEFAULT || '60000', 10));

module.exports = {
  CacheService,
  cache: globalCache,
};
