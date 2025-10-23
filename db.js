const { Pool } = require('pg');
require('dotenv').config();

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

module.exports = pool;