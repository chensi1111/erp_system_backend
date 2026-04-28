const express = require('express');
const logger = require('../logger')
const db =require('../db')
const response=require('../utils/response_codes')
const sendError = require('../utils/send_error');
const router = express.Router();
const dayjs = require("dayjs")
const utc = require('dayjs/plugin/utc');
const timezone = require('dayjs/plugin/timezone');
dayjs.extend(utc);
dayjs.extend(timezone);

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
    WHERE pm.is_deleted = false
    AND pm.paid_date >= $1::date 
    AND pm.paid_date < $2::date
  `;
  const restockWhere = `
    WHERE r.is_deleted = false
    AND r.date >= $1::date 
    AND r.date < $2::date
  `;

  // Sale 查詢
  const saleResult = await db.query(
    `
    SELECT
      COALESCE(SUM(CASE WHEN s.status IN (0, 3) THEN s.total_quantity ELSE 0 END), 0) AS total_sale_volume,
      COALESCE(SUM(CASE WHEN s.status IN (0, 3) THEN s.total_quantity * s.price ELSE 0 END), 0) AS total_sale_amount,
      COALESCE(SUM(CASE WHEN s.status = 1 THEN s.total_quantity ELSE 0 END), 0) AS total_refund_volume,
      COALESCE(SUM(CASE WHEN s.status = 1 THEN s.total_quantity * s.price ELSE 0 END), 0) AS total_refund_amount,
      COALESCE(MAX(st.cumulative_cost), 0) AS cumulative_cost,
      COALESCE(MAX(st.cumulative_in_quantity), 0) AS cumulative_in_quantity
    FROM sale s
    LEFT JOIN product p ON s.specification = p.specification AND s.product_id = p.product_id
    JOIN payment pm ON s.order_no = pm.order_no
    LEFT JOIN stock st ON s.specification = st.specification AND s.product_id = st.product_id
    ${saleWhere}
    `
    ,
    [range.start, range.end]
  );

  // 計算平均成本 (避免除以 0)
  const cumulative_cost = saleResult.rows[0]?.cumulative_cost ?? 0;
  const cumulative_in_quantity = saleResult.rows[0]?.cumulative_in_quantity ?? 0;
  const avg_cost = cumulative_in_quantity ? cumulative_cost / cumulative_in_quantity : 0;

  // Restock 查詢
  const restockResult = await db.query(
    `
    SELECT 
      COALESCE(SUM(sh.total_quantity), 0) AS total_restock_volume,
      COALESCE(SUM(sh.total_quantity * sh.price), 0) AS total_restock_amount
    FROM restock r
    JOIN stock_history sh ON r.restock_id = sh.change_number
    ${restockWhere}
    `,
    [range.start, range.end]
  );

  return {
    month: alias,
    sale: {
      total_sale_volume: saleResult.rows[0]?.total_sale_volume ?? 0,
      total_sale_amount: saleResult.rows[0]?.total_sale_amount ?? 0,
      total_refund_volume: saleResult.rows[0]?.total_refund_volume ?? 0,
      total_refund_amount: saleResult.rows[0]?.total_refund_amount ?? 0,
      cumulative_cost,
      cumulative_in_quantity,
      avg_cost
    },
    restock: {
      total_restock_volume: restockResult.rows[0]?.total_restock_volume ?? 0,
      total_restock_amount: restockResult.rows[0]?.total_restock_amount ?? 0,
    }
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
      WHERE pm.is_deleted = false
      AND pm.paid_date >= $1::date 
      AND pm.paid_date < $2::date
    `;
    const restockWhere = `
      WHERE r.is_deleted = false
      AND r.date >= $1::date 
      AND r.date < $2::date
    `;

    const saleResult = await db.query(
      `
      SELECT
        COALESCE(SUM(CASE WHEN s.status IN (0, 3) THEN s.total_quantity ELSE 0 END), 0) AS total_sale_volume,
        COALESCE(SUM(CASE WHEN s.status IN (0, 3) THEN s.total_quantity * s.price ELSE 0 END), 0) AS total_sale_amount,
        COALESCE(SUM(CASE WHEN s.status = 1 THEN s.total_quantity ELSE 0 END), 0) AS total_refund_volume,
        COALESCE(SUM(CASE WHEN s.status = 1 THEN s.total_quantity * s.price ELSE 0 END), 0) AS total_refund_amount
      FROM sale s
      LEFT JOIN product p ON s.specification = p.specification
      JOIN payment pm ON s.order_no = pm.order_no
      ${saleWhere}
      `,
      [range.start, range.end]
    );

    const restockResult = await db.query(
      `
      SELECT 
        COALESCE(SUM(sh.total_quantity), 0) AS total_restock_volume,
        COALESCE(SUM(sh.total_quantity * sh.price), 0) AS total_restock_amount
      FROM restock r
      JOIN stock_history sh ON r.restock_id = sh.change_number
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
