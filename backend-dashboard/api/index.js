// api/index.js
const serverless = require('serverless-http');

let srv;
try {
  srv = require('../server'); // caminho relativo à pasta /api
} catch (err) {
  console.error('Erro ao importar ../server:', err && err.message ? err.message : err);
  throw err;
}

// Normaliza o export do server (pode ser o próprio app, { app }, default, etc.)
const app =
  typeof srv === 'function' ? srv :
  (srv && (typeof srv.app === 'function')) ? srv.app :
  (srv && srv.default && typeof srv.default === 'function') ? srv.default :
  null;

if (!app || typeof app !== 'function') {
  throw new Error('Export inválido do server: espere um Express `app` exportado em ../server');
}

module.exports = serverless(app);
