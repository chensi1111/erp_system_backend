const express = require("express");
const logger = require("../logger");
const db = require("../db");
const response = require("../utils/response_codes");
const sendError = require("../utils/send_error");
const router = express.Router();
const dayjs = require("dayjs");
const utc = require("dayjs/plugin/utc");
const timezone = require("dayjs/plugin/timezone");
dayjs.extend(utc);
dayjs.extend(timezone);

const { randomUUID } = require("crypto");

// 新增資料
router.post("/create", async (req, res) => {
  let {
    product_id,
    specification,
    product_name,
    quantities,
    size_list,
    price,
    prepaid_price,
    remaining_price,
    total_quantity,
    remark,
    date,
    type
  } = req.body;
  if (
    !product_id ||
    !product_id ||
    !specification ||
    !product_name ||
    !quantities ||
    !size_list ||
    !total_quantity ||
    !price ||
    !prepaid_price ||
    !remaining_price ||
    !date ||
    !type
  ) {
    logger.warn("缺少必要資料");
    return sendError(res, response.missing_info, "缺少必要資料");
  }
  if (isNaN(price) || price < 0) {
    logger.warn("錯誤的金額");
    return sendError(res, response.invalid_price, "錯誤的金額");
  }
  if (isNaN(prepaid_price) || price < 0) {
    logger.warn("訂金錯誤");
    return sendError(res, response.invalid_price, "訂金錯誤");
  }
  if (isNaN(remaining_price) || price < 0) {
    logger.warn("剩餘金額錯誤");
    return sendError(res, response.invalid_price, "剩餘金額錯誤");
  }
  if (remark && remark.length > 100) {
    logger.warn("備註長度超過限制");
    return sendError(res, response.invalid_remark, "備註長度超過限制");
  }
  // 產生單號
  const datePart = dayjs().format("YYYYMMDDHHmm");
  const randomPart = randomUUID().replace(/-/g, "").slice(0, 3).toUpperCase();
  const order_id = `O${datePart}-${randomPart}`;
  const taipeiTime = dayjs().tz("Asia/Taipei").format("YYYY-MM-DD HH:mm:ss");
  const client = await db.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      "INSERT INTO orders ( order_id, product_id, create_date,date, product_name, specification,  price, prepaid_price, remaining_price, size_list, quantities, total_quantity, remark) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10,$11,$12,$13 )",
      [
        order_id,
        product_id,
        taipeiTime,
        date,
        product_name,
        specification,
        price,
        prepaid_price,
        remaining_price,
        size_list,
        JSON.stringify(quantities),
        total_quantity,
        remark,
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
      // 預留庫存
      const updatedStock = currentStock.map((stockItem) => {
        const soldItem = quantities.find((q) => q.size === stockItem.size);
        const soldQty = parseInt(soldItem?.quantity || "0", 10);
        const oldQty = parseInt(stockItem.available_quantity || "0", 10);
        const oldReservedQty = parseInt(stockItem.reserved_quantity || "0", 10);
        return {
          ...stockItem,
          available_quantity: Math.max(oldQty - soldQty, 0),
          reserved_quantity: Math.max(oldReservedQty + soldQty, 0),
        };
      });

      await client.query(
        `UPDATE stock
          SET stock_qty = $1, total_quantity = $2, last_out_date = $3
          WHERE product_id = $4 AND specification = $5`,
        [
          JSON.stringify(updatedStock),
          newTotal,
          date,
          product_id,
          specification,
        ]
      );
    }
    // 庫存紀錄
    await client.query(
      `INSERT INTO stock_history (product_id, product_name, specification, quantities, create_date,change_number,change_type,total_quantity,price,prepaid_price,remaining_price)
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
      [
        product_id,
        product_name,
        specification,
        JSON.stringify(quantities),
        taipeiTime,
        order_id,
        "訂貨",
        total_quantity,
        price,
        prepaid_price,
        remaining_price
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
  const { page, pageSize, filter, sort,showOneDay,selectedDate } = req.body;
  const safeSort = ['ASC', 'DESC'].includes(String(sort).toUpperCase()) ? String(sort).toUpperCase() : 'ASC';
  const offset = (page - 1) * pageSize;
  if (page < 1 || pageSize < 1) {
    logger.warn("錯誤的分頁資訊");
    return sendError(res, response.invalid_pageInfo, "錯誤的分頁資訊");
  }
  const conditions = [];
  const values = [];
  let paramIndex = 1;
  conditions.push(`is_deleted = false`);
  conditions.push(`is_complete = false`);

  if (filter) {
    // ILIKE不區分大小寫
    // %value%部分相符比對
    if (filter.order_id) {
      conditions.push(`order_id ILIKE $${paramIndex++}`);
      values.push(`%${filter.order_id}%`);
    }
    if (filter.product_id) {
      conditions.push(`product_id ILIKE $${paramIndex++}`);
      values.push(`%${filter.product_id}%`);
    }
  }
  if (showOneDay && selectedDate) {
      conditions.push(`date >= $${paramIndex} AND date < $${paramIndex + 1}`);
    
      const start = dayjs.utc(selectedDate).startOf("day");
      const end = start.add(1, "day");
    
      values.push(start.toISOString()); 
      values.push(end.toISOString());
    
      paramIndex += 2;
    }

  const whereClause = conditions.length
    ? `WHERE ${conditions.join(" AND ")}`
    : "";
  try {
    const result = await db.query(
      `SELECT order_id, product_id,create_date,date, specification, price,total_quantity,prepaid_price,quantities
      FROM orders 
      ${whereClause} 
      ORDER BY order_id ${safeSort}
      LIMIT $${paramIndex++} OFFSET $${paramIndex++}`,
      [...values, pageSize, offset]
    );
    const list = result.rows;
    // 查詢總筆數
    const totalResult = await db.query(
      `SELECT COUNT(*) as total FROM orders ${whereClause}`,
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
  const { order_id } = req.body;
  if (!order_id) {
    logger.warn("缺少必要資料");
    return sendError(res, response.missing_info, "缺少必要資料");
  }
  const client = await db.connect();
  try {
    await client.query("BEGIN");
    await client.query(`UPDATE orders SET is_deleted = $1 WHERE order_id = $2`, [
      true,
      order_id,
    ]);
    const orderResult = await client.query(
      `SELECT o.product_id,o.product_name, o.specification, o.quantities,o.total_quantity as sale_total_quantity,
      st.stock_qty, st.total_quantity as stock_total_quantity ,sh.price, sh.prepaid_price, sh.remaining_price
      FROM orders o
      JOIN stock st 
      ON o.product_id = st.product_id 
      AND o.specification = st.specification
      LEFT JOIN stock_history sh
      ON sh.change_number = o.order_id
      WHERE o.order_id = $1`,
      [order_id]
    );
    if (orderResult.rows.length === 0) {
      await client.query("ROLLBACK");
      logger.warn("找不到紀錄");
      return sendError(res, response.not_found, "找不到記錄");
    }
    // 回補庫存
    const { stock_qty, quantities,product_name, product_id, specification,sale_total_quantity,stock_total_quantity,price,prepaid_price,remaining_price } = orderResult.rows[0];
    const updatedStock = stock_qty.map((stockItem) => {
      const soldItem = quantities.find((q) => q.size === stockItem.size);
      const soldQty = parseInt(soldItem?.quantity || "0", 10);
      const oldAvailableQty = parseInt(stockItem.available_quantity || "0", 10);
      const oldReservedQty = parseInt(stockItem.reserved_quantity || "0", 10);
      return {
        ...stockItem,
        available_quantity: Math.max(oldAvailableQty + soldQty, 0),
        reserved_quantity: Math.max(oldReservedQty - soldQty, 0),
      };
    });
    const updateQuantity = sale_total_quantity + stock_total_quantity
    const taipeiTime = dayjs().tz("Asia/Taipei").format("YYYY-MM-DD HH:mm:ss");
    await client.query(
      `UPDATE stock SET stock_qty = $1, total_quantity = $2 WHERE product_id = $3 AND specification = $4`,
      [JSON.stringify(updatedStock),updateQuantity, product_id, specification]
    );
     // 庫存紀錄
    const changeKey = `${order_id}-c`;
    await client.query(
      `INSERT INTO stock_history (product_id, product_name, specification, quantities, create_date,change_number,change_type,total_quantity,price,prepaid_price,remaining_price)
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9,$10,$11)`,
      [
        product_id,
        product_name,
        specification,
        JSON.stringify(quantities),
        taipeiTime,
        changeKey,
        "訂貨取消",
        sale_total_quantity,
        price,
        prepaid_price,
        remaining_price
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
  const { order_id } = req.body;
  if (!order_id) {
    logger.warn("缺少必要資料");
    return sendError(res, response.missing_info, "缺少必要資料");
  }
  try {
    const result = await db.query(
      `
      SELECT 
        o.*,
        p.manufactor,
        p.brand,
        p.size,
        p.color,
        p.product_type1,
        p.product_type2,
        p.product_type3,
        p.product_type4
      FROM orders o
      JOIN product p ON o.specification = p.specification
      WHERE o.order_id = $1
      `,
      [order_id]
    );
    const order = result.rows[0];
    if (!order) {
      logger.warn("查無此單");
      return sendError(res, response.not_found, "查無此單");
    }
    res.status(200).json({
      code: response.success,
      msg: "查詢成功",
      data: order,
    });
  } catch (error) {
    logger.error(error);
    return sendError(res, response.server_error, "伺服器錯誤，請稍後再試", 500);
  }
});
router.post("/complete", async (req, res) => {
  const { order_id } = req.body;
  if (!order_id) {
    logger.warn("缺少必要資料");
    return sendError(res, response.missing_info, "缺少必要資料");
  }
  const client = await db.connect();
  try {
    await client.query("BEGIN");
    const orderResult = await client.query(
      `
      SELECT 
        o.*,
        p.manufactor,
        p.brand,
        p.size,
        p.color,
        p.product_type1,
        p.product_type2,
        p.product_type3,
        p.product_type4
      FROM orders o
      JOIN product p ON o.specification = p.specification
      WHERE o.order_id = $1
      `,
      [order_id]
    );
    const order = orderResult.rows[0];
    if (!order) {
      logger.warn("查無此單");
      return sendError(res, response.not_found, "查無此單");
    }
    await client.query(`UPDATE orders SET is_complete = $1 WHERE order_id = $2`, [
      true,
      order_id,
    ]);
    // 建立銷貨
    // 產生單號
    const datePart = dayjs().format("YYYYMMDDHHmm");
    const randomPart = randomUUID().replace(/-/g, "").slice(0, 3).toUpperCase();
    const sale_id = `S${datePart}-${randomPart}`;
    const taipeiTime = dayjs().tz("Asia/Taipei").format("YYYY-MM-DD HH:mm:ss");
    const taipeiDate = dayjs().tz("Asia/Taipei").format("YYYY-MM-DD");
    await client.query(
      "INSERT INTO sale (transaction, sale_id, product_id, create_date,date, product_name, specification,  price, size_list, quantities, total_quantity, remark) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10 ,$11,$12)",
      [
        '現場',
        sale_id,
        order.product_id,
        taipeiTime,
        taipeiDate,
        order.product_name,
        order.specification,
        order.price,
        order.size_list,
        JSON.stringify(order.quantities),
        order.total_quantity,
        order.remark,
      ]
    );
    const productResult = await client.query(
      "SELECT product_id, specification,stock_qty,total_quantity FROM stock WHERE product_id = $1 AND specification = $2",
      [order.product_id, order.specification]
    );

    if (productResult.rows.length === 0) {
      logger.warn("商品不存在");
      return sendError(res, response.not_found, "商品不存在");
    } else {
      // 檢查庫存
      const currentStock = productResult.rows[0].stock_qty;
      const currentTotal = productResult.rows[0].total_quantity;

      let insufficientSizes = [];
      for (const soldItem of order.quantities) {
        const stockItem = currentStock.find((s) => s.size === soldItem.size);
        const available = parseInt(stockItem?.reserved_quantity || "0", 10);
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
          `以下尺寸預留庫存不足: ${insufficientSizes
            .map((s) => `${s.size}(預留庫存${s.available}，需求${s.requested})`)
            .join(", ")}`
        );
      }
      const newTotal = Math.max(currentTotal - order.total_quantity, 0);
      // 扣除庫存
      const updatedStock = currentStock.map((stockItem) => {
        const soldItem = order.quantities.find((q) => q.size === stockItem.size);
        const soldQty = parseInt(soldItem?.quantity || "0", 10);
        const oldReservedQty = parseInt(stockItem.reserved_quantity || "0", 10);
        const oldAllQty = parseInt(stockItem.all_quantity || "0", 10);
        return {
          ...stockItem,
          reserved_quantity:Math.max(oldReservedQty - soldQty, 0),
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
          taipeiDate,
          order.product_id,
          order.specification,
        ]
      );
    }
    // 庫存紀錄
    await client.query(
      `INSERT INTO stock_history (product_id, product_name, specification, quantities, create_date,change_number,change_type,total_quantity,price)
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [
        order.product_id,
        order.product_name,
        order.specification,
        JSON.stringify(order.quantities),
        taipeiTime,
        sale_id,
        "銷貨",
        order.total_quantity,
        order.price
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
})
module.exports = router;
