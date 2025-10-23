const jwt = require('jsonwebtoken');
const JWT_ACCESS_SECRET = process.env.JWT_ACCESS_SECRET;
const JWT_REFRESH_SECRET = process.env.JWT_REFRESH_SECRET;
const JWT_RESET_PASSWORD_SECRET = process.env.JWT_RESET_PASSWORD_SECRET;
const crypto = require("crypto");

const ACCESS_EXPIRES_IN = '15m';
const REFRESH_EXPIRES_IN = '7d';
const RESET_EXPIRES_IN = '10m';

function generateTokens(payload) {
  return {
    accessToken: jwt.sign(payload, JWT_ACCESS_SECRET, { expiresIn: ACCESS_EXPIRES_IN }),
    refreshToken: jwt.sign(payload, JWT_REFRESH_SECRET, { expiresIn: REFRESH_EXPIRES_IN }),
  };
}
function generateResetToken(payload) {
  return jwt.sign(payload, JWT_RESET_PASSWORD_SECRET, { expiresIn: RESET_EXPIRES_IN });
}
function generateCancelToken(){
  return crypto.randomBytes(32).toString("hex");
}
module.exports = {
  generateTokens,
  generateResetToken,
  generateCancelToken
};