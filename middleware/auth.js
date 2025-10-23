const logger = require('../logger')
const response = require("../utils/response_codes");
const jwt = require('jsonwebtoken');
const SECRET_KEY = process.env.JWT_ACCESS_SECRET;
const API_KEY = process.env.API_SECRET
function sendError(res, code, msg, status = 400) {
  return res.status(status).json({ code, msg });
}
function verifyToken(req, res, next) {
  const authHeader = req.headers['authorization']; 
  const token = authHeader && authHeader.split(' ')[1];

  if (!token) {
    logger.warn('缺少 access token')
    return sendError(res, response.unauthorized, '缺少 access token', 401);
  }
  try {
    const decoded = jwt.verify(token, SECRET_KEY);
    req.user = decoded; 
    next(); 
  } catch (err) {
    logger.warn(err)
    sendError(res, response.invalid_accessToken, '無效的 access token', 401);
  }
}
function verifyAPI(req, res, next) {
  const token = req.headers['x-api-token'];

  if (!token) {
    logger.warn('缺少 api token');
    return sendError(res, response.unauthorized, '缺少 api token', 401);
  }
  if (token !== API_KEY) {
    logger.warn('無效的 api token');
    return sendError(res, response.invalid_token, '無效的 api token', 401);
  }

  next();
}

module.exports = {verifyToken,verifyAPI};