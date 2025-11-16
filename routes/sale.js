const express = require("express");
const logger = require("../logger");
const db = require("../db");
const response = require("../utils/response_codes");
const router = express.Router();
const dayjs = require("dayjs");
const utc = require("dayjs/plugin/utc");
const timezone = require("dayjs/plugin/timezone");
dayjs.extend(utc);
dayjs.extend(timezone);

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
      `SELECT specification from product WHERE product_id = $1`,
      [product_id]
    );
    if (!result.rows.length) {
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
});
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
      p.recommended_price,
      p.last_cost,
      p.average_cost,
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
    quantities,
    size_list,
    price,
    total_quantity,
    remark,
    handing_fee
  } = req.body;
  if (
    !transaction ||
    !product_id ||
    !specification ||
    !product_name ||
    !quantities ||
    !size_list ||
    !total_quantity ||
    !price
  ) {
    logger.warn("缺少必要資料");
    return sendError(res, response.missing_info, "缺少必要資料");
  }
  if (isNaN(price) || price < 0) {
    logger.warn("錯誤的金額");
    return sendError(res, response.invalid_price, "錯誤的金額");
  }
  if (handing_fee && (isNaN(handing_fee) || handing_fee < 0)) {
    logger.warn("錯誤的手續費");
    return sendError(res, response.invalid_handing_fee, "錯誤的手續費");
  }
  if (remark && remark.length > 100) {
    logger.warn("備註長度超過限制");
    return sendError(res, response.invalid_remark, "備註長度超過限制");
  }
  // 產生單號
  const datePart = dayjs().format("YYYYMMDDHHmm");
  const randomPart = randomUUID().replace(/-/g, "").slice(0, 3).toUpperCase();
  const sale_id = `S${datePart}-${randomPart}`;
  const taipeiTime = dayjs().tz("Asia/Taipei").format("YYYY-MM-DD HH:mm:ss");
  const client = await db.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      "INSERT INTO sale (transaction, sale_id, product_id, create_date, product_name, specification,  price, size_list, quantities, total_quantity, remark,handing_fee) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10 ,$11,$12)",
      [
        transaction,
        sale_id,
        product_id,
        taipeiTime,
        product_name,
        specification,
        price,
        size_list,
        JSON.stringify(quantities),
        total_quantity,
        remark,
        handing_fee
      ]
    );
    const result = await client.query(
      "SELECT product_id, specification,stock_qty,total_quantity FROM stock WHERE product_id = $1 AND specification = $2",
      [product_id, specification]
    );

    if (result.rows.length === 0) {
      logger.warn("商品不存在");
      return sendError(res, response.not_found, "商品不存在");
    } else {
      // 檢查庫存
      const currentStock = result.rows[0].stock_qty;
      const currentTotal = result.rows[0].total_quantity;

      let insufficientSizes = [];
      for (const soldItem of quantities) {
        const stockItem = currentStock.find((s) => s.size === soldItem.size);
        const available = parseInt(stockItem?.available_quantity || "0", 10);
        const soldQty = parseInt(soldItem.quantity || "0", 10);
        if (soldQty > available) {
          insufficientSizes.push({
            size: soldItem.size,
            available,
            requested: soldQty,
          });
        }
      }
      if (insufficientSizes.length > 0) {
        await client.query("ROLLBACK");
        logger.warn("庫存不足");
        return sendError(
          res,
          response.insufficient_stock,
          `以下尺寸庫存不足: ${insufficientSizes
            .map((s) => `${s.size}(庫存${s.available}，需求${s.requested})`)
            .join(", ")}`
        );
      }
      const newTotal = Math.max(currentTotal - total_quantity, 0);
      // 扣除庫存
      const updatedStock = currentStock.map((stockItem) => {
        const soldItem = quantities.find((q) => q.size === stockItem.size);
        const soldQty = parseInt(soldItem?.quantity || "0", 10);
        const oldQty = parseInt(stockItem.available_quantity || "0", 10);
        const oldAllQty = parseInt(stockItem.all_quantity || "0", 10);
        return {
          ...stockItem,
          available_quantity: Math.max(oldQty - soldQty, 0),
          all_quantity: Math.max(oldAllQty - soldQty, 0),
        };
      });

      await client.query(
        `UPDATE stock
          SET stock_qty = $1, total_quantity = $2, last_out_date = $3
          WHERE product_id = $4 AND specification = $5`,
        [
          JSON.stringify(updatedStock),
          newTotal,
          taipeiTime,
          product_id,
          specification,
        ]
      );
    }
    // 庫存紀錄
    await client.query(
      `INSERT INTO stock_history (product_id, product_name, specification, quantities, create_date,change_number,change_type,total_quantity,price)
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [
        product_id,
        product_name,
        specification,
        JSON.stringify(quantities),
        taipeiTime,
        sale_id,
        "銷貨",
        total_quantity,
        price
      ]
    );
    await client.query("COMMIT");
    res.status(200).json({
      code: response.success,
      msg: "建立成功",
    });
  } catch (error) {
    logger.error(error);
    await client.query("ROLLBACK");
    return sendError(res, response.server_error, "伺服器錯誤，請稍後再試", 500);
  } finally {
    client.release();
  }
});
// 查詢列表
router.post("/list", async (req, res) => {
  const { page, pageSize, filter, sort, isToday } = req.body;
  const offset = (page - 1) * pageSize;
  if (page < 1 || pageSize < 1) {
    logger.warn("錯誤的分頁資訊");
    return sendError(res, response.invalid_pageInfo, "錯誤的分頁資訊");
  }
  const conditions = [];
  const values = [];
  let paramIndex = 1;
  conditions.push(`is_deleted = false`);

  if (filter) {
    // ILIKE不區分大小寫
    // %value%部分相符比對
    if (filter.sale_id) {
      conditions.push(`sale_id ILIKE $${paramIndex++}`);
      values.push(`%${filter.sale_id}%`);
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

  const whereClause = conditions.length
    ? `WHERE ${conditions.join(" AND ")}`
    : "";
  try {
    const result = await db.query(
      `SELECT sale_id, transaction, create_date
      FROM sale 
      ${whereClause} 
      ORDER BY sale_id ${sort} 
      LIMIT $${paramIndex++} OFFSET $${paramIndex++}`,
      [...values, pageSize, offset]
    );
    const list = result.rows;
    // 查詢總筆數
    const totalResult = await db.query(
      `SELECT COUNT(*) as total FROM sale ${whereClause}`,
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
      },
    });
  } catch (error) {
    logger.error(error);
    return sendError(res, response.server_error, "伺服器錯誤，請稍後再試", 500);
  }
});
// 刪除
router.post("/delete", async (req, res) => {
  const { sale_id } = req.body;
  if (!sale_id) {
    logger.warn("缺少必要資料");
    return sendError(res, response.missing_info, "缺少必要資料");
  }
  const client = await db.connect();
  try {
    await client.query("BEGIN");
    await client.query(`UPDATE sale SET is_deleted = $1 WHERE sale_id = $2`, [
      true,
      sale_id,
    ]);
    const saleResult = await client.query(
      `SELECT s.product_id,s.product_name, s.specification, s.quantities,s.total_quantity as sale_total_quantity,
      st.stock_qty, st.total_quantity as stock_total_quantity , sh.price
      FROM sale s
      JOIN stock st 
      ON s.product_id = st.product_id 
      AND s.specification = st.specification
      LEFT JOIN stock_history sh
      ON sh.change_number = s.sale_id
      WHERE s.sale_id = $1`,
      [sale_id]
    );
    if (saleResult.rows.length === 0) {
      await client.query("ROLLBACK");
      logger.warn("找不到紀錄");
      return sendError(res, response.not_found, "找不到記錄");
    }
    // 回補庫存
    const { stock_qty, quantities,product_name, product_id, specification,sale_total_quantity,stock_total_quantity,price } = saleResult.rows[0];
    const updatedStock = stock_qty.map((stockItem) => {
      const soldItem = quantities.find((q) => q.size === stockItem.size);
      const soldQty = parseInt(soldItem?.quantity || "0", 10);
      const oldQty = parseInt(stockItem.available_quantity || "0", 10);
      const oldAllQty = parseInt(stockItem.all_quantity || "0", 10);
      return {
         ...stockItem,
         available_quantity: Math.max(oldQty - soldQty, 0),
         all_quantity: Math.max(oldAllQty - soldQty, 0),
      };
    });
    const updateQuantity = sale_total_quantity + stock_total_quantity
    const taipeiTime = dayjs().tz("Asia/Taipei").format("YYYY-MM-DD HH:mm:ss");
    await client.query(
      `UPDATE stock SET stock_qty = $1, total_quantity = $2 WHERE product_id = $3 AND specification = $4`,
      [JSON.stringify(updatedStock),updateQuantity, product_id, specification]
    );
     // 庫存紀錄
    const changeKey = `${sale_id}-c`;
    await client.query(
      `INSERT INTO stock_history (product_id, product_name, specification, quantities, create_date,change_number,change_type,total_quantity,price)
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [
        product_id,
        product_name,
        specification,
        JSON.stringify(quantities),
        taipeiTime,
        changeKey,
        "銷貨取消",
        sale_total_quantity,
        price
      ]
    );

    await client.query("COMMIT");
    res.status(200).json({
      code: response.success,
      msg: "刪除成功",
    });
  } catch (error) {
    logger.error(error);
    await client.query("ROLLBACK");
    return sendError(res, response.server_error, "伺服器錯誤，請稍後再試", 500);
  } finally {
    client.release();
  }
});
// 查詢詳細資料
router.post("/detail", async (req, res) => {
  const { sale_id } = req.body;
  if (!sale_id) {
    logger.warn("缺少必要資料");
    return sendError(res, response.missing_info, "缺少必要資料");
  }
  try {
    const result = await db.query(
      `
      SELECT 
        s.*,
        p.manufactor,
        p.brand,
        p.size,
        p.color,
        p.product_type1,
        p.product_type2,
        p.product_type3,
        p.product_type4,
        p.average_cost
      FROM sale s
      JOIN product p ON s.specification = p.specification
      WHERE s.sale_id = $1
      `,
      [sale_id]
    );
    const sale = result.rows[0];
    if (!sale) {
      logger.warn("查無此單");
      return sendError(res, response.not_found, "查無此單");
    }
    res.status(200).json({
      code: response.success,
      msg: "查詢成功",
      data: sale,
    });
  } catch (error) {
    logger.error(error);
    return sendError(res, response.server_error, "伺服器錯誤，請稍後再試", 500);
  }
});

module.exports = router;
