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
// 表格資訊
router.post("/info", async (req, res) => {
  try {
    const manufactorResult =  await db.query(
      `SELECT manufactor_id, manufactor_name 
      FROM manufactor 
      `
    );
    const manufactorList = manufactorResult.rows;
    const brandResult =  await db.query(
      `SELECT brand_id, brand_name 
      FROM brand 
      `
    );
    const brandList = brandResult.rows;
    const sizeResult =  await db.query(
      `SELECT size_id, size_name 
      FROM size 
      `
    );
    const sizeList = sizeResult.rows;
    const colorResult =  await db.query(
      `SELECT color_id, color_name 
      FROM color 
      `
    );
    const colorList = colorResult.rows;
    const typeResult =  await db.query(
      `SELECT type_id, type_name 
      FROM type 
      `
    );
    const typeList = typeResult.rows;
    res.status(200).json({
      code: response.success,
      msg: "查詢成功",
      data: {
        manufactorList,
        brandList,
        sizeList,
        colorList,
        typeList
      }
    });
  } catch (error) {
    logger.error(error)
    return sendError(res, response.server_error, "伺服器錯誤，請稍後再試", 500);
  }
});
// 表格資訊
router.post("/productList", async (req, res) => {
  try {
    const result =  await db.query(
      `SELECT specification, product_name 
      FROM product 
      `
    );
    const productList = result.rows
    
    res.status(200).json({
      code: response.success,
      msg: "查詢成功",
      data: {
        productList
      }
    });
  } catch (error) {
    logger.error(error)
    return sendError(res, response.server_error, "伺服器錯誤，請稍後再試", 500);
  }
});
// 新增
router.post("/create", async (req, res) => {
    let { product_id, product_name,specification,manufactor,brand,size,color,product_type1,product_type2,product_type3,product_type4,recommended_price,purchase_price, remark} = req.body;
    if(!product_id || !product_name || !specification || !manufactor || !brand || !size || !color || !recommended_price || !purchase_price){
      logger.warn("缺少必要資料")
      return sendError(res, response.missing_info, '缺少必要資料');
    }
    if (!/^\d{1,20}$/.test(product_id)) {
      logger.warn("編號格式錯誤")
      return sendError(res, response.invalid_id, '編號格式錯誤，必須為1~20位數字');
    }
    if(product_name.length > 20){
      logger.warn("商品名稱長度超過限制")
      return sendError(res, response.invalid_name, '商品名稱長度超過限制');
    }
    if(specification.length > 20){
      logger.warn("商品規格長度超過限制")
      return sendError(res, response.invalid_specification, '商品規格長度超過限制');
    }
    if(manufactor.length > 5){
      logger.warn("廠商長度超過限制")
      return sendError(res, response.invalid_manufactor, '廠商長度超過限制');
    }
    if(brand.length > 5){
      logger.warn("品牌長度超過限制")
      return sendError(res, response.invalid_brand, '品牌長度超過限制');
    }
    if(size.length > 5){
      logger.warn("尺寸長度超過限制")
      return sendError(res, response.invalid_size, '尺寸長度超過限制');
    }
    if(color.length > 5){
      logger.warn("顏色長度超過限制")
      return sendError(res, response.invalid_color, '顏色長度超過限制');
    }
    if((product_type1 && product_type1.length > 5) || (product_type2 && product_type2.length > 5) || (product_type3 && product_type3.length > 5) || (product_type4 && product_type4.length > 5)){
      logger.warn("類別長度超過限制")
      return sendError(res, response.invalid_type, '類別長度超過限制');
    }
    if((isNaN(recommended_price) || recommended_price < 0)){
      logger.warn("錯誤的金額")
      return sendError(res, response.invalid_price, '錯誤的金額');
    }
    if((isNaN(purchase_price) || purchase_price < 0)){
      logger.warn("錯誤的金額")
      return sendError(res, response.invalid_price, '錯誤的金額');
    }
    if(remark && remark.length > 100){
      logger.warn("備註長度超過限制")
      return sendError(res, response.invalid_remark, '備註長度超過限制');
    }

    try {
    const result = await db.query(
      "SELECT specification FROM product WHERE product_id = $1 AND specification = $2",
      [product_id,specification]
    );
    if (result.rows.length > 0) {
      logger.warn("商品已存在");
      return sendError(res, response.specification_conflict, "商品已存在");
    }
    const taipeiTime = dayjs().tz('Asia/Taipei').format('YYYY-MM-DD HH:mm:ss');
    await db.query(
      "INSERT INTO product (product_id, create_date, product_name, specification, manufactor, brand, size, color, product_type1, product_type2, product_type3, product_type4, recommended_price,purchase_price, remark) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)",
      [product_id, taipeiTime, product_name, specification, manufactor, brand, size, color, product_type1, product_type2, product_type3, product_type4, recommended_price,purchase_price, remark]
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
      if (filter.product_id) {
        conditions.push(`product_id ILIKE $${paramIndex++}`);
        values.push(`%${filter.product_id}%`);
      }
      if (filter.specification) {
        conditions.push(`specification ILIKE $${paramIndex++}`);
        values.push(`%${filter.specification}%`);
      }
      if (filter.product_name) {
        conditions.push(`product_name ILIKE $${paramIndex++}`);
        values.push(`%${filter.product_name}%`);
      }
    }

    const whereClause = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
  try {
    const result =  await db.query(
      `SELECT product_id, product_name,specification
      FROM product 
      ${whereClause} 
      ORDER BY product_id ${sort} 
      LIMIT $${paramIndex++} OFFSET $${paramIndex++}`,
      [...values,pageSize, offset]
    );
    const list = result.rows;
    // 查詢總筆數
    const totalResult = await db.query(
      `SELECT COUNT(*) as total FROM product ${whereClause}`,
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
  const { specification,product_id } = req.body;
  if(!specification || !product_id){
    logger.warn("缺少必要資料")
    return sendError(res, response.missing_info, '缺少必要資料');
  }
  try {
    const result =  await db.query(
      `SELECT p.*,s.last_cost,s.cumulative_cost,s.total_quantity
      FROM product p
      LEFT JOIN stock s ON p.product_id = s.product_id AND p.specification = s.specification
      WHERE p.specification = $1 AND p.product_id = $2`,
      [specification,product_id]
    );
    const product = result.rows[0];
    if(!product){
      logger.warn("查無此商品")
      return sendError(res, response.not_found, "查無此商品");
    }
    res.status(200).json({
      code: response.success,
      msg: "查詢成功",
      data: product
    });
  } catch (error) {
    logger.error(error)
    return sendError(res, response.server_error, "伺服器錯誤，請稍後再試", 500);
  } 
})
// 修改
router.post("/update", async (req, res) => {
  let { product_id, create_date, product_name,specification,manufactor,brand,size,color,product_type1,product_type2,product_type3,product_type4,recommended_price,purchase_price, remark} = req.body;
    if(!product_id || !create_date || !product_name || !specification || !manufactor || !brand || !size || !color || !recommended_price ||!purchase_price){
      logger.warn("缺少必要資料")
      return sendError(res, response.missing_info, '缺少必要資料');
    }
    if (!/^\d{1,20}$/.test(product_id)) {
      logger.warn("編號格式錯誤")
      return sendError(res, response.invalid_id, '編號格式錯誤，必須為1~20位數字');
    }
    if(product_name.length > 20){
      logger.warn("商品名稱長度超過限制")
      return sendError(res, response.invalid_name, '商品名稱長度超過限制');
    }
    if(specification.length > 20){
      logger.warn("商品規格長度超過限制")
      return sendError(res, response.invalid_specification, '商品規格長度超過限制');
    }
    if(manufactor.length > 5){
      logger.warn("廠商長度超過限制")
      return sendError(res, response.invalid_manufactor, '廠商長度超過限制');
    }
    if(brand.length > 5){
      logger.warn("品牌長度超過限制")
      return sendError(res, response.invalid_brand, '品牌長度超過限制');
    }
    if(size.length > 5){
      logger.warn("尺寸長度超過限制")
      return sendError(res, response.invalid_size, '尺寸長度超過限制');
    }
    if(color.length > 5){
      logger.warn("顏色長度超過限制")
      return sendError(res, response.invalid_color, '顏色長度超過限制');
    }
    if((product_type1 && product_type1.length > 5) || (product_type2 && product_type2.length > 5) || (product_type3 && product_type3.length > 5) || (product_type4 && product_type4.length > 5)){
      logger.warn("類別長度超過限制")
      return sendError(res, response.invalid_type, '類別長度超過限制');
    }
    if((isNaN(recommended_price) || recommended_price < 0)){
      logger.warn("錯誤的金額")
      return sendError(res, response.invalid_price, '錯誤的金額');
    }
    if((isNaN(purchase_price) || purchase_price < 0)){
      logger.warn("錯誤的金額")
      return sendError(res, response.invalid_price, '錯誤的金額');
    }
    if(remark && remark.length > 100){
      logger.warn("備註長度超過限制")
      return sendError(res, response.invalid_remark, '備註長度超過限制');
    }
    try {
    await db.query(
     `UPDATE product SET product_name = $1,manufactor = $2,brand = $3,size = $4,color = $5,product_type1 = $6,product_type2 = $7,product_type3 = $8,product_type4 = $9,recommended_price = $10,purchase_price = $11,remark = $12 WHERE specification = $13`,
     [
      product_name,
      manufactor,
      brand,
      size,
      color,
      product_type1,
      product_type2,
      product_type3,
      product_type4,
      recommended_price,
      purchase_price,
      remark,
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
router.post("/delete", async (req, res) => {
  const { specification } = req.body;
    if(!specification){
      logger.warn("缺少必要資料")
      return sendError(res, response.missing_info, '缺少必要資料');
    }
    try {
      await db.query(
      "DELETE FROM product WHERE specification = $1",
      [specification]
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