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


// 新增
router.post("/create", async (req, res) => {
    let { color_id,  color_name, remark} = req.body;
    if(!color_id || !color_name){
      logger.warn("缺少必要資料")
      return sendError(res, response.missing_info, '缺少必要資料');
    }
    if (!/^[A-Za-z0-9]{1,5}$/.test(color_id)) {
      logger.warn("編號格式錯誤")
      return sendError(res, response.invalid_id, '編號格式錯誤，必須為1~5位英數字');
    }
    if(color_name.length > 20){
      logger.warn("顏色名稱長度超過限制")
      return sendError(res, response.invalid_name, '顏色名稱長度超過限制');
    }
    if(remark && remark.length > 100){
      logger.warn("備註長度超過限制")
      return sendError(res, response.invalid_remark, '備註長度超過限制');
    }
    try {
      const result = await db.query(
      "SELECT color_id, color_name FROM color WHERE color_id = $1 OR color_name = $2",
      [color_id, color_name]
    );
    const rows = result.rows
    for (const row of rows) {
      if (row.color_id === color_id) {
        logger.warn("編號已被使用")
        return sendError(res, response.id_conflict, "編號已被使用");
      }
      if (row.color_name === color_name) {
        logger.warn("名稱已被使用")
        return sendError(res, response.name_conflict, "名稱已被使用");
      }
    }
    const taipeiTime = dayjs().tz('Asia/Taipei').format('YYYY-MM-DD HH:mm:ss');
    await db.query(
      "INSERT INTO color (color_id, create_date, color_name, remark) VALUES ($1, $2, $3, $4)",
      [color_id, taipeiTime, color_name, remark]
    );
     res.status(200).json({
      code: response.success,
      msg: "建立成功",
    });
    } catch (error) {
      logger.error(error)
      return sendError(res, response.server_error, "伺服器錯誤，請稍後再試", 500);
    }
  }
)
// 查詢列表
router.post("/list", async (req, res) => {
  const { page, pageSize, filter,sort } = req.body;
  const safeSort = ['ASC', 'DESC'].includes(String(sort).toUpperCase()) ? String(sort).toUpperCase() : 'ASC';
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
      if (filter.color_id) {
        conditions.push(`color_id ILIKE $${paramIndex++}`);
        values.push(`%${filter.color_id}%`);
      }
      if (filter.color_name) {
        conditions.push(`color_name ILIKE $${paramIndex++}`);
        values.push(`%${filter.color_name}%`);
      }
    }

    const whereClause = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
  try {
    const result =  await db.query(
      `SELECT color_id, color_name
      FROM color 
      ${whereClause} 
      ORDER BY color_id ${safeSort}
      LIMIT $${paramIndex++} OFFSET $${paramIndex++}`,
      [...values,pageSize, offset]
    );
    const colorList = result.rows;
    // 查詢總筆數
    const totalResult = await db.query(
      `SELECT COUNT(*) as total FROM color ${whereClause}`,
      values
    );
    const total = totalResult.rows[0].total;
    res.status(201).json({
      code: response.success,
      msg: "查詢成功",
      data: {
        list:colorList,
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
  const { color_id } = req.body;
  if(!color_id){
    logger.warn("缺少必要資料")
    return sendError(res, response.missing_info, '缺少必要資料');
  }
  try {
    const result =  await db.query(
      "SELECT * FROM color WHERE color_id = $1",
      [color_id]
    );
    const color = result.rows[0];
    if(!color){
      logger.warn("查無此顏色")
      return sendError(res, response.not_found, "查無此顏色");
    }
    res.status(200).json({
      code: response.success,
      msg: "查詢成功",
      data: color
    });
  } catch (error) {
    logger.error(error)
    return sendError(res, response.server_error, "伺服器錯誤，請稍後再試", 500);
  } 
})
// 修改
router.post("/update", async (req, res) => {
  let { color_id, color_name, remark} = req.body;
    if(!color_id  || !color_name){
      logger.warn("缺少必要資料")
      return sendError(res, response.missing_info, '缺少必要資料');
    }
    if (!/^\d{1,5}$/.test(color_id)) {
      logger.warn("編號格式錯誤")
      return sendError(res, response.invalid_id, '編號格式錯誤，必須為1~5位數字');
    }
    if(color_name.length > 20){
      logger.warn("顏色名稱長度超過限制")
      return sendError(res, response.invalid_name, '顏色名稱長度超過限制');
    }
    if(remark && remark.length > 100){
      logger.warn("備註長度超過限制")
      return sendError(res, response.invalid_remark, '備註長度超過限制');
    }
    try {
     const result = await db.query(
      "SELECT color_id FROM color WHERE color_name = $1 AND color_id <> $2",
      [color_name, color_id]
    );
    
    if (result.rows.length > 0) {
      logger.warn("名稱已被使用");
      return sendError(res, response.name_conflict, "名稱已被使用");
    }
    await db.query(
     `UPDATE color SET color_name = $1,remark = $2 WHERE color_id = $3`,
     [
      color_name,
      remark,
      color_id,
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
router.post("/delete", async (req, res) => {
  const { color_id } = req.body;
    if(!color_id){
      logger.warn("缺少必要資料")
      return sendError(res, response.missing_info, '缺少必要資料');
    }
    try {
      await db.query(
      "DELETE FROM color WHERE color_id = $1",
      [color_id]
    );
      res.status(200).json({
      code: response.success,
      msg: "刪除成功",
    });
  } catch (error) {
      logger.error(error)
      return sendError(res, response.server_error, "伺服器錯誤，請稍後再試", 500);
  }
})

module.exports = router;