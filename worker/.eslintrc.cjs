// Worker code runs in Cloudflare Workers (service-worker globals) and its tests in Node.
module.exports = {
  env: {
    browser: false,
    worker: true,
    node: true,
    es2022: true,
  },
  parserOptions: {
    ecmaVersion: 2022,
  },
};
