const { Pool } = require('pg');
const logger = require('./logger');
require('dotenv').config({
  path: process.env.NODE_ENV === 'production'
    ? '.env.production'
    : '.env'
});

const url = new URL(process.env.DATABASE_URL);

const pool = new Pool({
  host: url.hostname,
  port: url.port,
  user: url.username,
  password: url.password,
  database: url.pathname.slice(1), // 去除開頭的 "/"
  ssl: {
    require: true,
    rejectUnauthorized: false,
  },
});

// 必要：pg pool 閒置 client 出錯（DB 重啟 / 網路斷線）時，沒接 'error' 會直接 crash process
pool.on('error', (err) => {
  logger.error('pg pool idle client error', { message: err.message, stack: err.stack });
});

module.exports = pool;