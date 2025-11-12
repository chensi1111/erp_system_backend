const express = require('express');
const logger = require('../logger')
const db =require('../db')
const response=require('../utils/response_codes')
const router = express.Router();
const dayjs = require("dayjs")
const utc = require('dayjs/plugin/utc');
const timezone = require('dayjs/plugin/timezone');
dayjs.extend(utc);
dayjs.extend(timezone);

function sendError(res, code, msg, status = 400) {
  return res.status(status).json({ code, msg });
}
router.post("/list", async (req, res) => {
  // 使用台灣時區
  const now = dayjs().tz("Asia/Taipei");
  const thisMonth = now.format("YYYY-MM");
  const lastMonth = now.subtract(1, "month").format("YYYY-MM");

  // 建立查詢月份區間
  const buildDateRange = (month) => ({
    start: dayjs(`${month}-01`).format("YYYY-MM-DD"),
    end: dayjs(`${month}-01`).add(1, "month").format("YYYY-MM-DD"),
  });

  const thisMonthRange = buildDateRange(thisMonth);
  const lastMonthRange = buildDateRange(lastMonth);

  // 查詢模板函式
  const queryData = async (range, alias) => {
    const saleWhere = `
      WHERE s.is_deleted = false
      AND s.create_date >= $1::date 
      AND s.create_date < $2::date
    `;
    const restockWhere = `
      WHERE r.is_deleted = false
      AND r.create_date >= $1::date 
      AND r.create_date < $2::date
    `;

    const saleResult = await db.query(
      `
      SELECT
        COALESCE(SUM(s.handing_fee), 0) AS total_fee, 
        COALESCE(SUM(s.total_quantity), 0) AS total_sale_volume,
        COALESCE(SUM(s.total_quantity * s.price), 0) AS total_sale_amount,
        SUM(s.total_quantity * (s.price - COALESCE(p.average_cost, 0))) AS total_profit
      FROM sale s
      LEFT JOIN product p ON s.specification = p.specification
      ${saleWhere}
      `,
      [range.start, range.end]
    );

    const restockResult = await db.query(
      `
      SELECT 
        COALESCE(SUM(r.total_quantity), 0) AS total_restock_volume,
        COALESCE(SUM(r.total_quantity * r.price), 0) AS total_restock_amount
      FROM restock r
      ${restockWhere}
      `,
      [range.start, range.end]
    );

    return {
      month: alias,
      sale: saleResult.rows[0],
      restock: restockResult.rows[0],
    };
  };

  try {
    // 分別查詢
    const [thisMonthData, lastMonthData] = await Promise.all([
      queryData(thisMonthRange, thisMonth),
      queryData(lastMonthRange, lastMonth),
    ]);

    res.status(200).json({
      code: response.success,
      msg: "查詢成功",
      data: {
        thisMonth: thisMonthData,
        lastMonth: lastMonthData,
      },
    });
  } catch (error) {
    logger.error(error);
    return sendError(res, response.server_error, "伺服器錯誤，請稍後再試", 500);
  }
});
router.post("/year", async (req, res) => {
  const now = dayjs().tz("Asia/Taipei");
  const currentYear = now.year();
  const currentMonth = now.month() + 1; // 0~11，所以要 +1

  // 生成今年已到的月份 1~currentMonth
  const months = Array.from({ length: currentMonth }, (_, i) => i + 1);

  // 建立月份區間
  const buildDateRange = (year, month) => ({
    start: dayjs(`${year}-${month}-01`).format("YYYY-MM-DD"),
    end: dayjs(`${year}-${month}-01`).add(1, "month").format("YYYY-MM-DD"),
  });
  // 查詢模板函式
  const queryData = async (range, alias) => {
    const saleWhere = `
      WHERE s.is_deleted = false
      AND s.create_date >= $1::date 
      AND s.create_date < $2::date
    `;
    const restockWhere = `
      WHERE r.is_deleted = false
      AND r.create_date >= $1::date 
      AND r.create_date < $2::date
    `;

    const saleResult = await db.query(
      `
      SELECT
        COALESCE(SUM(s.handing_fee), 0) AS total_fee, 
        COALESCE(SUM(s.total_quantity), 0) AS total_sale_volume,
        COALESCE(SUM(s.total_quantity * s.price), 0) AS total_sale_amount,
        SUM(s.total_quantity * (s.price - COALESCE(p.average_cost, 0))) AS total_profit
      FROM sale s
      LEFT JOIN product p ON s.specification = p.specification
      ${saleWhere}
      `,
      [range.start, range.end]
    );

    const restockResult = await db.query(
      `
      SELECT 
        COALESCE(SUM(r.total_quantity), 0) AS total_restock_volume,
        COALESCE(SUM(r.total_quantity * r.price), 0) AS total_restock_amount
      FROM restock r
      ${restockWhere}
      `,
      [range.start, range.end]
    );

    return {
      month: alias,
      sale: saleResult.rows[0],
      restock: restockResult.rows[0],
    };
  };

  try {
    const monthDataList = await Promise.all(
      months.map(async (m) => {
        const range = buildDateRange(currentYear, m);
        return queryData(range, `${currentYear}-${m.toString().padStart(2, "0")}`);
      })
    );

    res.status(200).json({
      code: response.success,
      msg: "查詢成功",
      data: monthDataList,
    });
  } catch (error) {
    logger.error(error);
    return sendError(res, response.server_error, "伺服器錯誤，請稍後再試", 500);
  }
});
module.exports = router;
