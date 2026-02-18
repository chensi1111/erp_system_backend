const express = require("express");
const logger = require("../logger");
const db = require("../db");
const response = require("../utils/response_codes");
const router = express.Router();
const dayjs = require("dayjs")
const utc = require('dayjs/plugin/utc');
const timezone = require('dayjs/plugin/timezone');
dayjs.extend(utc);
dayjs.extend(timezone);
function sendError(res, code, msg, status = 400) {
  return res.status(status).json({ code, msg });
}
// 查詢列表
router.post("/list", async (req, res) => {
  const { page, pageSize, filter,sort } = req.body;
  const offset = (page - 1) * pageSize;
  if (page < 1 || pageSize < 1) {
    logger.warn("錯誤的分頁資訊")
    return sendError(res, response.invalid_pageInfo, "錯誤的分頁資訊");
  }
  const conditions = [];
  const values = [];
  let paramIndex = 1;

    if (filter) {
      // ILIKE不區分大小寫
      // %value%部分相符比對
      if (filter.product_id) {
        conditions.push(`product_id ILIKE $${paramIndex++}`);
        values.push(`%${filter.product_id}%`);
      }
      if (filter.specification) {
        conditions.push(`specification ILIKE $${paramIndex++}`);
        values.push(`%${filter.specification}%`);
      }
    }

    const whereClause = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
  try {
    const result =  await db.query(
      `SELECT product_id,product_name, specification,stock_qty
      FROM stock 
      ${whereClause} 
      ORDER BY product_id ${sort} 
      LIMIT $${paramIndex++} OFFSET $${paramIndex++}`,
      [...values,pageSize, offset]
    );
    const list = result.rows;
    // 查詢總筆數
    const totalResult = await db.query(
      `SELECT COUNT(*) as total FROM stock ${whereClause}`,
      values
    );
    const total = totalResult.rows[0].total;
    res.status(201).json({
      code: response.success,
      msg: "查詢成功",
      data: {
        list,
        total,
        page,
        pageSize,
        totalPages: Math.ceil(total / pageSize),
      }
    });
  } catch (error) {
    logger.error(error)
    return sendError(res, response.server_error, "伺服器錯誤，請稍後再試", 500);
  }
})
// 查詢詳細資料
router.post("/detail", async (req, res) => {
  const { specification } = req.body;
  if(!specification){
    logger.warn("缺少必要資料")
    return sendError(res, response.missing_info, '缺少必要資料');
  }
  try {
    const result =  await db.query(
      "SELECT * FROM stock WHERE specification = $1",
      [specification]
    );
    const restock = result.rows[0];
    if(!restock){
      logger.warn("查無資料")
      return sendError(res, response.not_found, "查無資料");
    }
    res.status(200).json({
      code: response.success,
      msg: "查詢成功",
      data: restock
    });
  } catch (error) {
    logger.error(error)
    return sendError(res, response.server_error, "伺服器錯誤，請稍後再試", 500);
  } 
})
// 修改
router.post("/update", async (req, res) => {
  let {specification,stock_qty} = req.body;
    if(!specification||!stock_qty){
      logger.warn("缺少必要資料")
      return sendError(res, response.missing_info, '缺少必要資料');
    }
    try {
    await db.query(
     `UPDATE stock SET stock_qty = $1 WHERE specification = $2`,
     [
      JSON.stringify(stock_qty),
      specification
    ]
    );
     res.status(200).json({
      code: response.success,
      msg: "修改成功",
    });
    } catch (error) {
      logger.error(error)
      return sendError(res, response.server_error, "伺服器錯誤，請稍後再試", 500);
    }
});
// 歷史紀錄
router.post("/history", async (req, res) => {
  const { page, pageSize, filter,sort } = req.body;
  const offset = (page - 1) * pageSize;
  if (page < 1 || pageSize < 1) {
    logger.warn("錯誤的分頁資訊")
    return sendError(res, response.invalid_pageInfo, "錯誤的分頁資訊");
  }
  const conditions = [];
  const values = [];
  let paramIndex = 1;

    if (filter) {
      // ILIKE不區分大小寫
      // %value%部分相符比對
      if (filter.product_id) {
        conditions.push(`product_id ILIKE $${paramIndex++}`);
        values.push(`%${filter.product_id}%`);
      }
      if (filter.specification) {
        conditions.push(`specification ILIKE $${paramIndex++}`);
        values.push(`%${filter.specification}%`);
      }
      if (filter.change_number) {
        conditions.push(`change_number ILIKE $${paramIndex++}`);
        values.push(`%${filter.change_number}%`);
      }
      if (filter.change_type) {
        conditions.push(`change_type ILIKE $${paramIndex++}`);
        values.push(`%${filter.change_type}%`);
      }
    }

    const whereClause = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
  try {
    const result =  await db.query(
      `SELECT product_id,product_name, specification,change_type,change_number,total_quantity
      FROM stock_history 
      ${whereClause} 
      ORDER BY create_date ${sort} 
      LIMIT $${paramIndex++} OFFSET $${paramIndex++}`,
      [...values,pageSize, offset]
    );
    const list = result.rows;
    // 查詢總筆數
    const totalResult = await db.query(
      `SELECT COUNT(*) as total FROM stock_history ${whereClause}`,
      values
    );
    const total = totalResult.rows[0].total;
    res.status(201).json({
      code: response.success,
      msg: "查詢成功",
      data: {
        list,
        total,
        page,
        pageSize,
        totalPages: Math.ceil(total / pageSize),
      }
    });
  } catch (error) {
    logger.error(error)
    return sendError(res, response.server_error, "伺服器錯誤，請稍後再試", 500);
  }
})
// 查詢詳細資料
router.post("/history_detail", async (req, res) => {
  const { change_number,change_type } = req.body;
  if(!change_number||change_type==undefined){
    logger.warn("缺少必要資料")
    return sendError(res, response.missing_info, '缺少必要資料');
  }
  try {
    const result =  await db.query(
      "SELECT * FROM stock_history WHERE change_number = $1 AND change_type = $2",
      [change_number,change_type]
    );
    const restock = result.rows[0];
    if(!restock){
      logger.warn("查無資料")
      return sendError(res, response.not_found, "查無資料");
    }
    res.status(200).json({
      code: response.success,
      msg: "查詢成功",
      data: restock
    });
  } catch (error) {
    logger.error(error)
    return sendError(res, response.server_error, "伺服器錯誤，請稍後再試", 500);
  } 
})
// 查詢安全庫存
router.post("/safe_list", async (req, res) => {
  const { page, pageSize, filter,sort } = req.body;
  const offset = (page - 1) * pageSize;
  if (page < 1 || pageSize < 1) {
    logger.warn("錯誤的分頁資訊")
    return sendError(res, response.invalid_pageInfo, "錯誤的分頁資訊");
  }
  const conditions = [];
  const values = [];
  let paramIndex = 1;

    if (filter) {
      // ILIKE不區分大小寫
      // %value%部分相符比對
      if (filter.product_id) {
        conditions.push(`product_id ILIKE $${paramIndex++}`);
        values.push(`%${filter.product_id}%`);
      }
      if (filter.specification) {
        conditions.push(`specification ILIKE $${paramIndex++}`);
        values.push(`%${filter.specification}%`);
      }
    }
    const safetyCondition = `
      EXISTS (
       SELECT 1 FROM jsonb_array_elements(stock_qty::jsonb) AS elem
       WHERE 
         elem ? 'safe_stock'
         AND COALESCE(NULLIF(elem->>'available_quantity','')::numeric, 0)
             < COALESCE(NULLIF(elem->>'safe_stock','')::numeric, 0)
      )
    `;
    const whereClause = conditions.length
    ? `WHERE ${conditions.join(" AND ")} AND ${safetyCondition}`
    : `WHERE ${safetyCondition}`;
  try {
    const result =  await db.query(
      `SELECT product_id,product_name, specification,stock_qty
      FROM stock 
      ${whereClause} 
      ORDER BY product_id ${sort} 
      LIMIT $${paramIndex++} OFFSET $${paramIndex++}`,
      [...values,pageSize, offset]
    );
    const list = result.rows;
    // 查詢總筆數
    const totalResult = await db.query(
      `SELECT COUNT(*) as total FROM stock ${whereClause}`,
      values
    );
    const total = totalResult.rows[0].total;
    res.status(201).json({
      code: response.success,
      msg: "查詢成功",
      data: {
        list,
        total,
        page,
        pageSize,
        totalPages: Math.ceil(total / pageSize),
      }
    });
  } catch (error) {
    logger.error(error)
    return sendError(res, response.server_error, "伺服器錯誤，請稍後再試", 500);
  }
})
// 查詢安全庫存
router.post("/safe_count", async (req, res) => {
   const safetyCondition = `
    EXISTS (
      SELECT 1 FROM jsonb_array_elements(stock_qty::jsonb) AS elem
      WHERE 
        elem ? 'safe_stock' 
        AND COALESCE(NULLIF(elem->>'available_quantity','')::numeric, 0) 
            < COALESCE(NULLIF(elem->>'safe_stock','')::numeric, 0)
    )
  `;
  try {
    const totalResult = await db.query(
      `SELECT COUNT(*) as total FROM stock WHERE ${safetyCondition}`
    );
    const total = totalResult.rows[0].total;
    res.status(201).json({
      code: response.success,
      msg: "查詢成功",
      data: {
        total
      }
    });
  } catch (error) {
    logger.error(error)
    return sendError(res, response.server_error, "伺服器錯誤，請稍後再試", 500);
  }
})
module.exports = router;