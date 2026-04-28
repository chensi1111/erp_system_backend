function sendError(res, code, msg, status = 400) {
  return res.status(status).json({ code, msg });
}

module.exports = sendError;
