const express = require('express');
const logger = require('../logger')
const db =require('../db')
const response=require('../utils/response_codes')
const router = express.Router();
function sendError(res, code, msg, status = 400) {
  return res.status(status).json({ code, msg });
}
function validateSizeList(size_list) {
  const sizes = size_list
    .split(',')
    .map(s => s.trim())
    .filter(Boolean); // 去掉空值

  const uniqueSizes = new Set(sizes);

  if (uniqueSizes.size !== sizes.length) {
    // 有重複
    return false;
  }

  return true;
}
// 新增
router.post("/create", async (req, res) => {
    let { size_id, create_date, size_name,size_list, remark} = req.body;
    if(!size_id || !create_date || !size_name|| !size_list){
      logger.warn("缺少必要資料")
      return sendError(res, response.missing_info, '缺少必要資料');
    }
    if (!/^\d{1,20}$/.test(size_id)) {
      logger.warn("編號格式錯誤")
      return sendError(res, response.invalid_id, '編號格式錯誤，必須為1~20位數字');
    }
    if(!validateSizeList(size_list)){
      logger.warn("尺碼列表有重複值")
      return sendError(res, response.invalid_size_list, '尺碼列表有重複值');
    }
    if(size_name.length > 100){
      logger.warn("尺寸名稱長度超過限制")
      return sendError(res, response.invalid_name, '尺寸名稱長度超過限制');
    }
    if(remark && remark.length > 100){
      logger.warn("備註長度超過限制")
      return sendError(res, response.invalid_remark, '備註長度超過限制');
    }
    try {
      const result = await db.query(
      "SELECT size_id, size_name FROM size WHERE size_id = $1 OR size_name = $2",
      [size_id, size_name]
    );
    const rows = result.rows
    for (const row of rows) {
      if (row.size_id === size_id) {
        logger.warn("編號已被使用")
        return sendError(res, response.id_conflict, "編號已被使用");
      }
      if (row.size_name === size_name) {
        logger.warn("名稱已被使用")
        return sendError(res, response.name_conflict, "名稱已被使用");
      }
    }
    await db.query(
      "INSERT INTO size (size_id, create_date, size_name, size_list, remark) VALUES ($1, $2, $3, $4, $5)",
      [size_id, create_date, size_name, size_list, remark]
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
      if (filter.size_id) {
        conditions.push(`size_id ILIKE $${paramIndex++}`);
        values.push(`%${filter.size_id}%`);
      }
      if (filter.size_name) {
        conditions.push(`size_name ILIKE $${paramIndex++}`);
        values.push(`%${filter.size_name}%`);
      }
    }

    const whereClause = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
  try {
    const result =  await db.query(
      `SELECT size_id, size_name ,size_list
      FROM size 
      ${whereClause} 
      ORDER BY size_id ${sort} 
      LIMIT $${paramIndex++} OFFSET $${paramIndex++}`,
      [...values,pageSize, offset]
    );
    const sizeList = result.rows;
    // 查詢總筆數
    const totalResult = await db.query(
      `SELECT COUNT(*) as total FROM size ${whereClause}`,
      values
    );
    const total = totalResult.rows[0].total;
    res.status(201).json({
      code: response.success,
      msg: "查詢成功",
      data: {
        list:sizeList,
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
  const { size_id } = req.body;
  if(!size_id){
    logger.warn("缺少必要資料")
    return sendError(res, response.missing_info, '缺少必要資料');
  }
  try {
    const result =  await db.query(
      "SELECT * FROM size WHERE size_id = $1",
      [size_id]
    );
    const size = result.rows[0];
    if(!size){
      logger.warn("查無此尺寸")
      return sendError(res, response.not_found, "查無此尺寸");
    }
    res.status(200).json({
      code: response.success,
      msg: "查詢成功",
      data: size
    });
  } catch (error) {
    logger.error(error)
    return sendError(res, response.server_error, "伺服器錯誤，請稍後再試", 500);
  } 
})
// 修改
router.post("/update", async (req, res) => {
  let { size_id, size_name, size_list, remark} = req.body;
    if(!size_id  || !size_name || !size_list){
      logger.warn("缺少必要資料")
      return sendError(res, response.missing_info, '缺少必要資料');
    }
    if (!/^\d{1,20}$/.test(size_id)) {
      logger.warn("編號格式錯誤")
      return sendError(res, response.invalid_id, '編號格式錯誤，必須為1~20位數字');
    }
    if(size_name.length > 100){
      logger.warn("尺寸名稱長度超過限制")
      return sendError(res, response.invalid_name, '尺寸名稱長度超過限制');
    }
    if(!validateSizeList(size_list)){
      logger.warn("尺碼列表有重複值")
      return sendError(res, response.invalid_size_list, '尺碼列表有重複值');
    }
    if(remark && remark.length > 100){
      logger.warn("備註長度超過限制")
      return sendError(res, response.invalid_remark, '備註長度超過限制');
    }
    try {
     const result = await db.query(
      "SELECT size_id FROM size WHERE size_name = $1 AND size_id <> $2",
      [size_name, size_id]
    );
    
    if (result.rows.length > 0) {
      logger.warn("名稱已被使用");
      return sendError(res, response.name_conflict, "名稱已被使用");
    }
    await db.query(
     `UPDATE size SET size_name = $1,size_list = $2,remark = $3 WHERE size_id = $4`,
     [
      size_name,
      size_list,
      remark,
      size_id,
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
  const { size_id } = req.body;
    if(!size_id){
      logger.warn("缺少必要資料")
      return sendError(res, response.missing_info, '缺少必要資料');
    }
    try {
      await db.query(
      "DELETE FROM size WHERE size_id = $1",
      [size_id]
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