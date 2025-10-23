const express = require('express');
const logger = require('../logger')
const db =require('../db')
const response=require('../utils/response_codes')
const router = express.Router();
function sendError(res, code, msg, status = 400) {
  return res.status(status).json({ code, msg });
}
// 新增
router.post("/create", async (req, res) => {
    let { brand_id, create_date, brand_name, remark} = req.body;
    if(!brand_id || !create_date || !brand_name){
      logger.warn("缺少必要資料")
      return sendError(res, response.missing_info, '缺少必要資料');
    }
    if (!/^\d{1,20}$/.test(brand_id)) {
      logger.warn("編號格式錯誤")
      return sendError(res, response.invalid_id, '編號格式錯誤，必須為1~20位數字');
    }
    if(brand_name.length > 100){
      logger.warn("品牌名稱長度超過限制")
      return sendError(res, response.invalid_name, '品牌名稱長度超過限制');
    }
    if(remark && remark.length > 100){
      logger.warn("備註長度超過限制")
      return sendError(res, response.invalid_remark, '備註長度超過限制');
    }
    try {
      const result = await db.query(
      "SELECT brand_id, brand_name FROM brand WHERE brand_id = $1 OR brand_name = $2",
      [brand_id, brand_name]
    );
    const rows = result.rows
    for (const row of rows) {
      if (row.brand_id === brand_id) {
        logger.warn("編號已被使用")
        return sendError(res, response.id_conflict, "編號已被使用");
      }
      if (row.brand_name === brand_name) {
        logger.warn("名稱已被使用")
        return sendError(res, response.name_conflict, "名稱已被使用");
      }
    }
    await db.query(
      "INSERT INTO brand (brand_id, create_date, brand_name, remark) VALUES ($1, $2, $3, $4)",
      [brand_id, create_date, brand_name, remark]
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
      if (filter.brand_id) {
        conditions.push(`brand_id ILIKE $${paramIndex++}`);
        values.push(`%${filter.brand_id}%`);
      }
      if (filter.brand_name) {
        conditions.push(`brand_name ILIKE $${paramIndex++}`);
        values.push(`%${filter.brand_name}%`);
      }
    }

    const whereClause = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
  try {
    const result =  await db.query(
      `SELECT brand_id, brand_name
      FROM brand 
      ${whereClause} 
      ORDER BY brand_id ${sort} 
      LIMIT $${paramIndex++} OFFSET $${paramIndex++}`,
      [...values,pageSize, offset]
    );
    const list = result.rows;
    // 查詢總筆數
    const totalResult = await db.query(
      `SELECT COUNT(*) as total FROM brand ${whereClause}`,
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
  const { brand_id } = req.body;
  if(!brand_id){
    logger.warn("缺少必要資料")
    return sendError(res, response.missing_info, '缺少必要資料');
  }
  try {
    const result =  await db.query(
      "SELECT * FROM brand WHERE brand_id = $1",
      [brand_id]
    );
    const brand = result.rows[0];
    if(!brand){
      logger.warn("查無此品牌")
      return sendError(res, response.not_found, "查無此品牌");
    }
    res.status(200).json({
      code: response.success,
      msg: "查詢成功",
      data: brand
    });
  } catch (error) {
    logger.error(error)
    return sendError(res, response.server_error, "伺服器錯誤，請稍後再試", 500);
  } 
})
// 修改
router.post("/update", async (req, res) => {
  let { brand_id, brand_name, remark} = req.body;
    if(!brand_id  || !brand_name){
      logger.warn("缺少必要資料")
      return sendError(res, response.missing_info, '缺少必要資料');
    }
    if (!/^\d{1,20}$/.test(brand_id)) {
      logger.warn("編號格式錯誤")
      return sendError(res, response.invalid_id, '編號格式錯誤，必須為1~20位數字');
    }
    if(brand_name.length > 100){
      logger.warn("品牌名稱長度超過限制")
      return sendError(res, response.invalid_name, '品牌名稱長度超過限制');
    }
    if(remark && remark.length > 100){
      logger.warn("備註長度超過限制")
      return sendError(res, response.invalid_remark, '備註長度超過限制');
    }
    try {
     const result = await db.query(
      "SELECT brand_id FROM brand WHERE brand_name = $1 AND brand_id <> $2",
      [brand_name, brand_id]
    );
    
    if (result.rows.length > 0) {
      logger.warn("名稱已被使用");
      return sendError(res, response.name_conflict, "名稱已被使用");
    }
    await db.query(
     `UPDATE brand SET brand_name = $1,remark = $2 WHERE brand_id = $3`,
     [
      brand_name,
      remark,
      brand_id,
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
  const { brand_id } = req.body;
    if(!brand_id){
      logger.warn("缺少必要資料")
      return sendError(res, response.missing_info, '缺少必要資料');
    }
    try {
      await db.query(
      "DELETE FROM brand WHERE brand_id = $1",
      [brand_id]
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