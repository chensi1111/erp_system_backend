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
// 新增
router.post("/create", async (req, res) => {
    let { type_id,  type_name, remark} = req.body;
    if(!type_id || !type_name){
      logger.warn("缺少必要資料")
      return sendError(res, response.missing_info, '缺少必要資料');
    }
    if (!/^\d{1,5}$/.test(type_id)) {
      logger.warn("編號格式錯誤")
      return sendError(res, response.invalid_id, '編號格式錯誤，必須為1~5位數字');
    }
    if(type_name.length > 20){
      logger.warn("類別名稱長度超過限制")
      return sendError(res, response.invalid_name, '類別名稱長度超過限制');
    }
    if(remark && remark.length > 100){
      logger.warn("備註長度超過限制")
      return sendError(res, response.invalid_remark, '備註長度超過限制');
    }
    try {
      const result = await db.query(
      "SELECT type_id, type_name FROM type WHERE type_id = $1 OR type_name = $2",
      [type_id, type_name]
    );
    const rows = result.rows
    for (const row of rows) {
      if (row.type_id === type_id) {
        logger.warn("編號已被使用")
        return sendError(res, response.id_conflict, "編號已被使用");
      }
      if (row.type_name === type_name) {
        logger.warn("名稱已被使用")
        return sendError(res, response.name_conflict, "名稱已被使用");
      }
    }
    const taipeiTime = dayjs().tz('Asia/Taipei').format('YYYY-MM-DD HH:mm:ss');
    await db.query(
      "INSERT INTO type (type_id, create_date, type_name, remark) VALUES ($1, $2, $3, $4)",
      [type_id, taipeiTime, type_name, remark]
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
      if (filter.type_id) {
        conditions.push(`type_id ILIKE $${paramIndex++}`);
        values.push(`%${filter.type_id}%`);
      }
      if (filter.type_name) {
        conditions.push(`type_name ILIKE $${paramIndex++}`);
        values.push(`%${filter.type_name}%`);
      }
    }

    const whereClause = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
  try {
    const result =  await db.query(
      `SELECT type_id, type_name
      FROM type 
      ${whereClause} 
      ORDER BY type_id ${sort} 
      LIMIT $${paramIndex++} OFFSET $${paramIndex++}`,
      [...values,pageSize, offset]
    );
    const typeList = result.rows;
    // 查詢總筆數
    const totalResult = await db.query(
      `SELECT COUNT(*) as total FROM type ${whereClause}`,
      values
    );
    const total = totalResult.rows[0].total;
    res.status(201).json({
      code: response.success,
      msg: "查詢成功",
      data: {
        list:typeList,
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
  const { type_id } = req.body;
  if(!type_id){
    logger.warn("缺少必要資料")
    return sendError(res, response.missing_info, '缺少必要資料');
  }
  try {
    const result =  await db.query(
      "SELECT * FROM type WHERE type_id = $1",
      [type_id]
    );
    const type = result.rows[0];
    if(!type){
      logger.warn("查無此類別")
      return sendError(res, response.not_found, "查無此類別");
    }
    res.status(200).json({
      code: response.success,
      msg: "查詢成功",
      data: type
    });
  } catch (error) {
    logger.error(error)
    return sendError(res, response.server_error, "伺服器錯誤，請稍後再試", 500);
  } 
})
// 修改
router.post("/update", async (req, res) => {
  let { type_id, type_name, remark} = req.body;
    if(!type_id  || !type_name){
      logger.warn("缺少必要資料")
      return sendError(res, response.missing_info, '缺少必要資料');
    }
    if (!/^\d{1,5}$/.test(type_id)) {
      logger.warn("編號格式錯誤")
      return sendError(res, response.invalid_id, '編號格式錯誤，必須為1~5位數字');
    }
    if(type_name.length > 20){
      logger.warn("類別名稱長度超過限制")
      return sendError(res, response.invalid_name, '類別名稱長度超過限制');
    }
    if(remark && remark.length > 100){
      logger.warn("備註長度超過限制")
      return sendError(res, response.invalid_remark, '備註長度超過限制');
    }
    try {
     const result = await db.query(
      "SELECT type_id FROM type WHERE type_name = $1 AND type_id <> $2",
      [type_name, type_id]
    );
    
    if (result.rows.length > 0) {
      logger.warn("名稱已被使用");
      return sendError(res, response.name_conflict, "名稱已被使用");
    }
    await db.query(
     `UPDATE type SET type_name = $1,remark = $2 WHERE type_id = $3`,
     [
      type_name,
      remark,
      type_id,
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
  const { type_id } = req.body;
    if(!type_id){
      logger.warn("缺少必要資料")
      return sendError(res, response.missing_info, '缺少必要資料');
    }
    try {
      await db.query(
      "DELETE FROM type WHERE type_id = $1",
      [type_id]
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