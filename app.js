const cors = require('cors');
const express = require('express');
const logger= require('./logger');
const UAParser = require("ua-parser-js");

// 必要：Node 22+ 預設在 unhandled rejection 會 crash；接住後 log 即可，不退出 process
process.on('unhandledRejection', (reason) => {
  logger.error('unhandledRejection', {
    reason: reason instanceof Error ? reason.stack : String(reason),
  });
});
process.on('uncaughtException', (err) => {
  logger.error('uncaughtException', { message: err.message, stack: err.stack });
});

const app = express();
const cookieParser = require("cookie-parser")
const port = process.env.PORT || 3000;
const manufactorRouter = require('./routes/manufactor');
const sizeRouter = require('./routes/size');
const typeRouter = require('./routes/type');
const brandRouter = require('./routes/brand');
const productRouter = require('./routes/product');
const restockRouter = require('./routes/restock')
const colorRouter = require('./routes/color')
const stockRouter = require('./routes/stock')
const saleRouter = require('./routes/sale')
const reportRouter = require('./routes/report')
const dashboardRouter = require('./routes/dashboard')
const corsOptions = {
  origin: process.env.BASE_URL,
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
  credentials: true
};

// 套用到所有 API

app.use(cookieParser());
app.use(cors(corsOptions));
// app.use(express.json()); 
// app.use(express.urlencoded({ extended: true }));
app.use(express.json({ limit: "10mb" }));
app.use(express.urlencoded({ limit: "10mb", extended: true }));

// Logging middleware
app.use((req, res, next) => {
  const start = Date.now();

  res.on("finish", () => {
    const duration = Date.now() - start;
    const parser = new UAParser(req.headers["user-agent"]);
    const uaResult = parser.getResult();
    const deviceType = uaResult.device.type || "desktop";
    const browserName = uaResult.browser.name || "unknown";
    const browserVersion = uaResult.browser.version || "unknown";
    const userId = req.user ? req.user.userId : "anonymous";

    let level = "info";
    if (res.statusCode >= 500) level = "error";
    else if (res.statusCode >= 400) level = "warn";
    const ip = req.headers['x-forwarded-for']?.split(',')[0].trim() || req.socket.remoteAddress;

    logger.log({
      level,
      message: `${req.method} ${req.originalUrl}`,
      userId,
      statusCode: res.statusCode,
      duration: `${duration}ms`,
      ip,
      userAgent: { deviceType, browserName, browserVersion }
    });
  });

  next();
});
app.use('/api/manufactor', manufactorRouter); 
app.use('/api/size', sizeRouter);
app.use('/api/type', typeRouter);
app.use('/api/brand', brandRouter);
app.use('/api/product', productRouter);
app.use('/api/restock', restockRouter)
app.use('/api/color', colorRouter)
app.use('/api/stock',stockRouter)
app.use('/api/sale',saleRouter)
app.use('/api/report', reportRouter)
app.use('/api/dashboard', dashboardRouter)

app.listen(port, () => {
  console.log(`Server running on port ${port}`);
});
