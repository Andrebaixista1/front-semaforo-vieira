const { createProxyMiddleware } = require('http-proxy-middleware');

const TARGET = process.env.REACT_APP_DEV_API_TARGET || 'https://ubuntu.sistemavieira.com.br:8003';

module.exports = function setupProxy(app) {
  app.use(
    '/api',
    createProxyMiddleware({
      target: TARGET,
      changeOrigin: true,
      secure: false, // aceitamos certificado autoassinado da API
      logLevel: 'silent'
    })
  );
};
