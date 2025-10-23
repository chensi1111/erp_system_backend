const express = require('express');
const logger = require('../logger')
const db =require('../db')
const response=require('../utils/response_codes')
const router = express.Router();
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
        typeList
      }
    });
  } catch (error) {
    logger.error(error)
    return sendError(res, response.server_error, "伺服器錯誤，請稍後再試", 500);
  }
});
// 新增
router.post("/create", async (req, res) => {
    let { product_id, create_date, product_name,specification,manufactor,brand,size,product_type1,product_type2,product_type3,product_type4,price,sale_price, remark} = req.body;
    if(!product_id || !create_date || !product_name || !specification || !manufactor || !brand || !size || !price){
      logger.warn("缺少必要資料")
      return sendError(res, response.missing_info, '缺少必要資料');
    }
    if (!/^\d{1,20}$/.test(product_id)) {
      logger.warn("編號格式錯誤")
      return sendError(res, response.invalid_id, '編號格式錯誤，必須為1~20位數字');
    }
    if(product_name.length > 100){
      logger.warn("商品名稱長度超過限制")
      return sendError(res, response.invalid_name, '商品名稱長度超過限制');
    }
    if(specification.length > 100){
      logger.warn("品名規格長度超過限制")
      return sendError(res, response.invalid_specification, '品名規格長度超過限制');
    }
    if(manufactor.length > 10){
      logger.warn("廠商長度超過限制")
      return sendError(res, response.invalid_manufactor, '廠商長度超過限制');
    }
    if(brand.length > 10){
      logger.warn("品牌長度超過限制")
      return sendError(res, response.invalid_brand, '品牌長度超過限制');
    }
    if(size.length > 10){
      logger.warn("尺寸長度超過限制")
      return sendError(res, response.invalid_size, '尺寸長度超過限制');
    }
    if((product_type1 && product_type1.length > 10) || (product_type2 && product_type2.length > 10) || (product_type3 && product_type3.length > 10) || (product_type4 && product_type4.length > 10)){
      logger.warn("類別長度超過限制")
      return sendError(res, response.invalid_type, '類別長度超過限制');
    }
    if((isNaN(price) || price < 0)){
      logger.warn("錯誤的金額")
      return sendError(res, response.invalid_price, '錯誤的金額');
    }
    if(sale_price && (isNaN(sale_price) || sale_price < 0)){
      logger.warn("錯誤的特價金額")
      return sendError(res, response.invalid_sale_price, '錯誤的特價金額');
    }
    if(remark && remark.length > 100){
      logger.warn("備註長度超過限制")
      return sendError(res, response.invalid_remark, '備註長度超過限制');
    }

    try {
      const result = await db.query(
      "SELECT product_id, product_name,specification FROM product WHERE product_id = $1 OR product_name = $2 OR specification = $3",
      [product_id, product_name,specification]
    );
    const rows = result.rows
    for (const row of rows) {
      if (row.product_id === product_id) {
        logger.warn("編號已被使用")
        return sendError(res, response.id_conflict, "編號已被使用");
      }
      if (row.product_name === product_name) {
        logger.warn("名稱已被使用")
        return sendError(res, response.name_conflict, "名稱已被使用");
      }
      if(row.specification === specification) {
        logger.warn("品名規格已被使用")
        return sendError(res, response.specification_conflict, "品名規格已被使用");
      }
    }
    await db.query(
      "INSERT INTO product (product_id, create_date, product_name, specification, manufactor, brand, size, product_type1, product_type2, product_type3, product_type4, price, sale_price, remark) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)",
      [product_id, create_date, product_name, specification, manufactor, brand, size, product_type1, product_type2, product_type3, product_type4, price, sale_price, remark]
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
      if (filter.product_name) {
        conditions.push(`product_name ILIKE $${paramIndex++}`);
        values.push(`%${filter.product_name}%`);
      }
    }

    const whereClause = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
  try {
    const result =  await db.query(
      `SELECT product_id, product_name
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
  const { product_id } = req.body;
  if(!product_id){
    logger.warn("缺少必要資料")
    return sendError(res, response.missing_info, '缺少必要資料');
  }
  try {
    const result =  await db.query(
      "SELECT * FROM product WHERE product_id = $1",
      [product_id]
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
  let { product_id, create_date, product_name,specification,manufactor,brand,size,product_type1,product_type2,product_type3,product_type4,price,sale_price, remark} = req.body;
    if(!product_id || !create_date || !product_name || !specification || !manufactor || !brand || !size || !price){
      logger.warn("缺少必要資料")
      return sendError(res, response.missing_info, '缺少必要資料');
    }
    if (!/^\d{1,20}$/.test(product_id)) {
      logger.warn("編號格式錯誤")
      return sendError(res, response.invalid_id, '編號格式錯誤，必須為1~20位數字');
    }
    if(product_name.length > 100){
      logger.warn("商品名稱長度超過限制")
      return sendError(res, response.invalid_name, '商品名稱長度超過限制');
    }
    if(specification.length > 100){
      logger.warn("品名規格長度超過限制")
      return sendError(res, response.invalid_specification, '品名規格長度超過限制');
    }
    if(manufactor.length > 10){
      logger.warn("廠商長度超過限制")
      return sendError(res, response.invalid_manufactor, '廠商長度超過限制');
    }
    if(brand.length > 10){
      logger.warn("品牌長度超過限制")
      return sendError(res, response.invalid_brand, '品牌長度超過限制');
    }
    if(size.length > 10){
      logger.warn("尺寸長度超過限制")
      return sendError(res, response.invalid_size, '尺寸長度超過限制');
    }
    if((product_type1 && product_type1.length > 10) || (product_type2 && product_type2.length > 10) || (product_type3 && product_type3.length > 10) || (product_type4 && product_type4.length > 10)){
      logger.warn("類別長度超過限制")
      return sendError(res, response.invalid_type, '類別長度超過限制');
    }
    if((isNaN(price) || price < 0)){
      logger.warn("錯誤的金額")
      return sendError(res, response.invalid_price, '錯誤的金額');
    }
    if(sale_price && (isNaN(sale_price) || sale_price < 0)){
      logger.warn("錯誤的特價金額")
      return sendError(res, response.invalid_sale_price, '錯誤的特價金額');
    }
    if(remark && remark.length > 100){
      logger.warn("備註長度超過限制")
      return sendError(res, response.invalid_remark, '備註長度超過限制');
    }
    try {
     const nameResult = await db.query(
      "SELECT product_id FROM product WHERE product_name = $1 AND product_id <> $2",
      [product_name, product_id]
    );
    
    if (nameResult.rows.length > 0) {
      logger.warn("名稱已被使用");
      return sendError(res, response.name_conflict, "名稱已被使用");
    }
    const specificationResult = await db.query(
      "SELECT product_id FROM product WHERE specification = $1 AND product_id <> $2",
      [specification, product_id]
    );
    
    if (specificationResult.rows.length > 0) {
      logger.warn("品名規格已被使用");
      return sendError(res, response.specification_conflict, "品名規格已被使用");
    }
    await db.query(
     `UPDATE product SET product_name = $1,specification = $2,manufactor = $3,brand = $4,size = $5,product_type1 = $6,product_type2 = $7,product_type3 = $8,product_type4 = $9,price = $10,sale_price = $11,remark = $12 WHERE product_id = $13`,
     [
      product_name,
      specification,
      manufactor,
      brand,
      size,
      product_type1,
      product_type2,
      product_type3,
      product_type4,
      price,
      sale_price,
      remark,
      product_id,
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
  const { product_id } = req.body;
    if(!product_id){
      logger.warn("缺少必要資料")
      return sendError(res, response.missing_info, '缺少必要資料');
    }
    try {
      await db.query(
      "DELETE FROM product WHERE product_id = $1",
      [product_id]
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