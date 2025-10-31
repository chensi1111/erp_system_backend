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
const taipeiTime = dayjs().tz('Asia/Taipei').format('YYYY-MM-DD HH:mm:ss');
const { randomUUID } = require("crypto");
function sendError(res, code, msg, status = 400) {
  return res.status(status).json({ code, msg });
}
// 獲取商品規格選項
router.post("/specification", async (req, res) => {
  let { product_id } = req.body;
  if (!product_id) {
    logger.warn("缺少必要資料");
    return sendError(res, response.missing_info, "缺少必要資料");
  }
  try {
    const result = await db.query(
      `SELECT specification from product WHERE product_id = $1`,[product_id]
    )
    if(!result.rows.length){
      logger.warn("找不到商品資料");
      return sendError(res, response.not_found, "找不到商品資料");
    }
    res.status(200).json({
      code: response.success,
      msg: "獲取成功",
      data: result.rows,
    });
  } catch (error) {
    logger.error(error);
    return sendError(res, response.server_error, "伺服器錯誤，請稍後再試", 500);
  }
})
// 對應資料
router.post("/productInfo", async (req, res) => {
  let { specification } = req.body;
  if (!specification) {
    logger.warn("缺少必要資料");
    return sendError(res, response.missing_info, "缺少必要資料");
  }
  try {
    const result = await db.query(
      `
    SELECT 
      p.product_name,
      p.manufactor,
      p.brand,
      p.size,
      p.color,
      p.product_type1,
      p.product_type2,
      p.product_type3,
      p.product_type4,
      s.size_list
     FROM product p
     LEFT JOIN manufactor m ON p.manufactor = m.manufactor_id
     LEFT JOIN brand b ON p.brand = b.brand_id
     LEFT JOIN size s ON p.size = s.size_id
     LEFT JOIN color c ON p.color = c.color_id
     LEFT JOIN type t1 ON p.product_type1 = t1.type_id
     LEFT JOIN type t2 ON p.product_type2 = t2.type_id
     LEFT JOIN type t3 ON p.product_type3 = t3.type_id
     LEFT JOIN type t4 ON p.product_type4 = t4.type_id
     WHERE p.specification = $1
     `,
      [specification]
    );

    res.status(200).json({
      code: response.success,
      msg: "獲取成功",
      data: result.rows[0],
    });
  } catch (error) {
    logger.error(error);
    return sendError(res, response.server_error, "伺服器錯誤，請稍後再試", 500);
  }
});
// 新增資料
router.post("/create", async (req, res) => {
  let {
    transaction,
    product_id,
    specification,
    product_name,
    manufactor_id,
    brand_id,
    size_id,
    size_list,
    color_id,
    quantities,
    price,
    total_quantity,
    remark,
    product_type1,
    product_type2,
    product_type3,
    product_type4,
  } = req.body;
  if (
    !transaction ||
    !product_id ||
    !specification ||
    !product_name ||
    !manufactor_id ||
    !brand_id ||
    !size_id ||
    !size_list ||
    !color_id ||
    !quantities ||
    !total_quantity ||
    !price
  ) {
    logger.warn("缺少必要資料");
    return sendError(res, response.missing_info, "缺少必要資料");
  }
  if (!/^\d{1,20}$/.test(product_id)) {
    logger.warn("編號格式錯誤");
    return sendError(
      res,
      response.invalid_id,
      "編號格式錯誤，必須為1~20位數字"
    );
  }
  if (product_name.length > 20) {
    logger.warn("商品名稱長度超過限制");
    return sendError(res, response.invalid_name, "商品名稱長度超過限制");
  }
  if (specification.length > 20) {
    logger.warn("商品規格長度超過限制");
    return sendError(
      res,
      response.invalid_specification,
      "商品規格長度超過限制"
    );
  }
  if (manufactor_id.length > 5) {
    logger.warn("廠商長度超過限制");
    return sendError(res, response.invalid_manufactor, "廠商長度超過限制");
  }
  if (brand_id.length > 5) {
    logger.warn("品牌長度超過限制");
    return sendError(res, response.invalid_brand, "品牌長度超過限制");
  }
  if (size_id.length > 5) {
    logger.warn("尺寸長度超過限制");
    return sendError(res, response.invalid_size, "尺寸長度超過限制");
  }
  if (color_id.length > 5) {
    logger.warn("顏色長度超過限制");
    return sendError(res, response.invalid_color, "顏色長度超過限制");
  }
  if (
    (product_type1 && product_type1.length > 5) ||
    (product_type2 && product_type2.length > 5) ||
    (product_type3 && product_type3.length > 5) ||
    (product_type4 && product_type4.length > 5)
  ) {
    logger.warn("類別長度超過限制");
    return sendError(res, response.invalid_type, "類別長度超過限制");
  }
  if (isNaN(price) || price < 0) {
    logger.warn("錯誤的金額");
    return sendError(res, response.invalid_price, "錯誤的金額");
  }
  if (remark && remark.length > 100) {
    logger.warn("備註長度超過限制");
    return sendError(res, response.invalid_remark, "備註長度超過限制");
  }
  // 產生單號
  const datePart = dayjs().format("YYYYMMDDHHmm");
  const randomPart = randomUUID().replace(/-/g, "").slice(0, 3).toUpperCase();
  const restock_id = `R${datePart}-${randomPart}`;


  const client = await db.connect()
  try {
    await client.query('BEGIN');
    await client.query(
      "INSERT INTO restock (transaction, restock_id, product_id, create_date, product_name, specification, manufactor_id, brand_id, size_id,color_id, type1_id, type2_id, type3_id, type4_id, price, remark,size_list,quantities,total_quantity) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19)",
      [
        transaction,
        restock_id,
        product_id,
        taipeiTime,
        product_name,
        specification,
        manufactor_id,
        brand_id,
        size_id,
        color_id,
        product_type1,
        product_type2,
        product_type3,
        product_type4,
        price,
        remark,
        size_list,
        JSON.stringify(quantities),
        total_quantity
      ]
    );
    // 查詢舊的進價
    const costResult = await client.query(
      `SELECT average_cost FROM product WHERE product_id = $1`,
      [product_id]
    );
    const quantityResult = await client.query(
      `SELECT total_quantity FROM stock WHERE product_id = $1`,
      [product_id]
    );
    const currentAverageCost = Number(costResult.rows[0]?.average_cost) || 0;
    const currentTotalQty = Number(quantityResult.rows[0]?.total_quantity) || 0;
    // 平均進價
    const newAverageCost = Math.round(
      (currentAverageCost * currentTotalQty + price * total_quantity) /
      (currentTotalQty + total_quantity)
    );
    // 更新商品進價
    await client.query(
        `UPDATE product
         SET last_cost = $1, average_cost = $2
         WHERE product_id = $3`,
        [price,newAverageCost,product_id]
      ); 
    const result = await client.query(
      "SELECT product_id, specification,stock_qty,total_quantity FROM stock WHERE product_id = $1 AND specification = $2",
      [product_id, specification]
    );

    if (result.rows.length === 0) {
      // 不存在,新增庫存
      await client.query(
        `INSERT INTO stock (product_id, product_name, specification, stock_qty,total_quantity, last_in_date)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [product_id,product_name, specification, JSON.stringify(quantities),total_quantity, taipeiTime]
      );
  
    } else {
      // 已存在,更新庫存數量
        const currentStock = result.rows[0].stock_qty;
        const currentTotal = result.rows[0].total_quantity;
        const mergedTotal = currentTotal + total_quantity;
        const mergedStock = currentStock.map(item => {
          const newItem = quantities.find(q => q.size === item.size);
          const addQty = parseInt(newItem?.quantity || "0", 10);
          const oldQty = parseInt(item.quantity || "0", 10);
          return {
            size: item.size,
            quantity: (oldQty + addQty).toString()
          };
        });
      await client.query(
        `UPDATE stock
         SET stock_qty = $1,total_quantity = $2 , last_in_date = $3
         WHERE product_id = $4 AND specification = $5`,
        [JSON.stringify(mergedStock),mergedTotal, taipeiTime, product_id, specification]
      );
    }
    // 庫存紀錄
    await client.query(
        `INSERT INTO stock_history (product_id, product_name, specification, quantities, create_date,change_number,change_type,total_quantity)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [product_id,product_name, specification, JSON.stringify(quantities), taipeiTime,restock_id,'進貨',total_quantity]
      );
    await client.query('COMMIT');
    res.status(200).json({
      code: response.success,
      msg: "建立成功",
    });
  } catch (error) {
    logger.error(error);
    await client.query('ROLLBACK');
    return sendError(res, response.server_error, "伺服器錯誤，請稍後再試", 500);
  } finally {
    client.release();
  }
});
// 查詢列表
router.post("/list", async (req, res) => {
  const { page, pageSize, filter,sort,isToday } = req.body;
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
      if (filter.restock_id) {
        conditions.push(`restock_id ILIKE $${paramIndex++}`);
        values.push(`%${filter.restock_id}%`);
      }
      if (filter.transaction) {
        conditions.push(`transaction ILIKE $${paramIndex++}`);
        values.push(`%${filter.transaction}%`);
      }
    }
    if (isToday) {
    const today = dayjs().format("YYYY-MM-DD");
    conditions.push(`create_date::date = $${paramIndex++}`);
    values.push(today);
  }

    const whereClause = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
  try {
    const result =  await db.query(
      `SELECT restock_id, transaction
      FROM restock 
      ${whereClause} 
      ORDER BY restock_id ${sort} 
      LIMIT $${paramIndex++} OFFSET $${paramIndex++}`,
      [...values,pageSize, offset]
    );
    const list = result.rows;
    // 查詢總筆數
    const totalResult = await db.query(
      `SELECT COUNT(*) as total FROM restock ${whereClause}`,
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
// 刪除
router.post("/delete", async (req, res) => {
  const { restock_id } = req.body;
    if(!restock_id){
      logger.warn("缺少必要資料")
      return sendError(res, response.missing_info, '缺少必要資料');
    }
    try {
      await db.query(
      "DELETE FROM restock WHERE restock_id = $1",
      [restock_id]
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
// 查詢詳細資料
router.post("/detail", async (req, res) => {
  const { restock_id } = req.body;
  if(!restock_id){
    logger.warn("缺少必要資料")
    return sendError(res, response.missing_info, '缺少必要資料');
  }
  try {
    const result =  await db.query(
      "SELECT * FROM restock WHERE restock_id = $1",
      [restock_id]
    );
    const restock = result.rows[0];
    if(!restock){
      logger.warn("查無此單")
      return sendError(res, response.not_found, "查無此單");
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
  let { restock_id,transaction,quantities,price, remark} = req.body;
    if(!restock_id ||!transaction||!quantities||!price){
      logger.warn("缺少必要資料")
      return sendError(res, response.missing_info, '缺少必要資料');
    }
    if(transaction!=='買斷' && transaction!=='寄賣'){
      logger.warn("錯誤的交易類型")
      return sendError(res, response.invalid_transaction,'錯誤的交易類型')
    }
    if((isNaN(price) || price < 0)){
      logger.warn("錯誤的金額")
      return sendError(res, response.invalid_price, '錯誤的金額');
    }
    if(remark && remark.length > 100){
      logger.warn("備註長度超過限制")
      return sendError(res, response.invalid_remark, '備註長度超過限制');
    }
    try {
    await db.query(
     `UPDATE restock SET transaction = $1, quantities = $2, price = $3,  remark = $4 WHERE restock_id = $5`,
     [
      transaction,
      quantities,
      price,
      remark,
      restock_id
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
module.exports = router;
