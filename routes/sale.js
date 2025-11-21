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
    handing_fee,
    date,
    pay
  } = req.body;
  if (
    !transaction ||
    !product_id ||
    !specification ||
    !product_name ||
    !quantities ||
    !size_list ||
    !total_quantity ||
    !price ||
    !date ||
    !pay
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
  const order_no = `S${datePart}-${randomPart}`;
  const taipeiTime = dayjs().tz("Asia/Taipei").format("YYYY-MM-DD HH:mm:ss");
  const client = await db.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      "INSERT INTO sale (transaction, order_no, product_id, create_date, product_name, specification,  price, size_list, quantities, total_quantity, remark,handing_fee,pay,status) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)",
      [
        transaction,
        order_no,
        product_id,
        taipeiTime,
        product_name,
        specification,
        price,
        size_list,
        JSON.stringify(quantities),
        total_quantity,
        remark,
        handing_fee,
        pay,
        '銷貨'
      ]
    );
     await client.query(
      "INSERT INTO payment (order_no, amount, type, paid_at, paid_date) VALUES ($1, $2, $3, $4, $5)",
      [
        order_no,
        price * total_quantity,
        '銷貨',
        taipeiTime,
        date
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
          date,
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
        order_no,
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
// 新增資料
router.post("/create_order", async (req, res) => {
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
    transaction,
    pay,
    date
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
    !transaction ||
    !pay ||
    !date
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
  const order_no = `O${datePart}-${randomPart}`;
  const taipeiTime = dayjs().tz("Asia/Taipei").format("YYYY-MM-DD HH:mm:ss");
  const client = await db.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      "INSERT INTO sale ( order_no,transaction, product_id, create_date, product_name, specification,  price, size_list, quantities, total_quantity, remark,pay,status) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)",
      [
        order_no,
        transaction,
        product_id,
        taipeiTime,
        product_name,
        specification,
        price,
        size_list,
        JSON.stringify(quantities),
        total_quantity,
        remark,
        pay,
        '訂貨'
      ]
    );
    await client.query(
      "INSERT INTO payment (order_no, amount, type, paid_at, paid_date) VALUES ($1, $2, $3, $4, $5)",
      [
        order_no,
        prepaid_price,
        '訂貨',
        taipeiTime,
        date
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
        order_no,
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
  const { page, pageSize, filter, sort,showOneDay,selectedDate  } = req.body;
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
    if (filter.order) {
      conditions.push(`order ILIKE $${paramIndex++}`);
      values.push(`%${filter.order}%`);
    }
    if (filter.product_id) {
      conditions.push(`product_id ILIKE $${paramIndex++}`);
      values.push(`%${filter.product_id}%`);
    }
    if (filter.specification) {
      conditions.push(`specification ILIKE $${paramIndex++}`);
      values.push(`%${filter.specification}%`);
    }
  }
  if (showOneDay && selectedDate) {
    conditions.push(`paid_date >= $${paramIndex} AND paid_date < $${paramIndex + 1}`);
  
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
      `SELECT s.*, p.average_cost, pm.type, pm.amount, pm.paid_at, pm.paid_date
      FROM sale s
      LEFT JOIN product p ON s.product_id = p.product_id AND s.specification = p.specification
      JOIN payment pm ON s.order_no = pm.order_no
      ${whereClause} 
      ORDER BY create_date ${sort} 
      LIMIT $${paramIndex++} OFFSET $${paramIndex++}`,
      [...values, pageSize, offset]
    );
    const list = result.rows;
    // 查詢總筆數
    const totalResult = await db.query(
      `SELECT COUNT(*) as total 
      FROM sale s
      JOIN payment pm ON s.order_no = pm.order_no
      ${whereClause}`,
      values
    );
    const total = totalResult.rows[0].total;

    const summaryResult = await db.query(
  `
    SELECT
       COALESCE(SUM(CASE WHEN pm.type = '訂貨' THEN pm.amount ELSE 0 END),0) AS total_prepaid,
       COALESCE(SUM(CASE WHEN pm.type = '收貨' THEN pm.amount ELSE 0 END),0) AS total_remaining,
       COALESCE(SUM(CASE WHEN pm.type = '銷貨' THEN pm.amount ELSE 0 END),0) AS total_paid,
       COALESCE(SUM(CASE WHEN pm.type != '訂貨' THEN s.total_quantity * p.average_cost ELSE 0 END),0) AS total_cost,
       COALESCE(SUM(CASE WHEN pm.type != '訂貨' THEN s.total_quantity * (s.price - p.average_cost) ELSE 0 END),0) AS total_profit,
       COALESCE(SUM(CASE WHEN pm.type = '銷貨' THEN s.handing_fee ELSE 0 END),0) AS total_handing_fee
    FROM sale s
      LEFT JOIN product p ON s.product_id = p.product_id AND s.specification = p.specification
      JOIN payment pm ON s.order_no = pm.order_no
    ${whereClause}
  `,
  values
);
  const summary =summaryResult.rows[0]
    res.status(201).json({
      code: response.success,
      msg: "查詢成功",
      data: {
        list,
        total,
        page,
        pageSize,
        totalPages: Math.ceil(total / pageSize),
        summary
      },
    });
  } catch (error) {
    logger.error(error);
    return sendError(res, response.server_error, "伺服器錯誤，請稍後再試", 500);
  }
});
// 刪除
router.post("/delete", async (req, res) => {
  const { order_no } = req.body;
  if (!order_no) {
    logger.warn("缺少必要資料");
    return sendError(res, response.missing_info, "缺少必要資料");
  }
  const client = await db.connect();
  try {
    await client.query("BEGIN");
    await client.query(`UPDATE payment SET is_deleted = $1 WHERE order_no = $2 AND type = $3`, [
      true,
      order_no,
      '銷貨'
    ]);
    await client.query(`UPDATE sale SET status = $1 WHERE order_no = $2`, [
      '取消',
      order_no,
    ]);
    const saleResult = await client.query(
      `SELECT s.product_id,s.product_name, s.specification, s.quantities,s.total_quantity as sale_total_quantity,
      st.stock_qty, st.total_quantity as stock_total_quantity , sh.price
      FROM sale s
      JOIN stock st 
      ON s.product_id = st.product_id 
      AND s.specification = st.specification
      LEFT JOIN stock_history sh
      ON sh.change_number = s.order_no
      WHERE s.order_no = $1`,
      [order_no]
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
    const changeKey = `${order_no}-c`;
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
// 刪除訂貨
router.post("/delete_order", async (req, res) => {
  const { order_no } = req.body;
  if (!order_no) {
    logger.warn("缺少必要資料");
    return sendError(res, response.missing_info, "缺少必要資料");
  }
  const client = await db.connect();
  try {
    await client.query("BEGIN");
    const orderStatus = await client.query(
      `SELECT *
      FROM sale
      WHERE order_no = $1
      AND status = '收貨'`,
      [order_no]
    );
    if (orderStatus.rows.length > 0) {
      await client.query("ROLLBACK");
      logger.warn("此訂單已有收貨紀錄，無法刪除");
      return sendError(res, response.invalid_action, "此訂單已有收貨紀錄，無法刪除");
    }
    await client.query(`UPDATE payment SET is_deleted = $1 WHERE order_no = $2 AND type = $3`, [
      true,
      order_no,
      '訂貨'
    ]);
    await client.query(`UPDATE sale SET status = $1 WHERE order_no = $2`, [
      '取消',
      order_no,
    ]);
    const orderResult = await client.query(
      `SELECT s.product_id,s.product_name, s.specification, s.quantities,s.total_quantity as sale_total_quantity,
      st.stock_qty, st.total_quantity as stock_total_quantity ,sh.price, sh.prepaid_price, sh.remaining_price
      FROM sale s
      JOIN stock st 
      ON s.product_id = st.product_id 
      AND s.specification = st.specification
      LEFT JOIN stock_history sh
      ON sh.change_number = s.order_no
      WHERE s.order_no = $1`,
      [order_no]
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
    const changeKey = `${order_no}-c`;
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
// 刪除收貨
router.post("/delete_pickup", async (req, res) => {
  const { order_no } = req.body;
  if (!order_no) {
    logger.warn("缺少必要資料");
    return sendError(res, response.missing_info, "缺少必要資料");
  }
  const client = await db.connect();
  try {
    await client.query("BEGIN");
    await client.query(`UPDATE payment SET is_deleted = $1 WHERE order_no = $2 AND type = $3`, [
      true,
      order_no,
      '收貨'
    ]);
    await client.query(`UPDATE sale SET status = $1 WHERE order_no = $2`, [
      '訂貨',
      order_no,
    ]);
    const orderResult = await client.query(
      `SELECT s.product_id,s.product_name, s.specification, s.quantities,s.total_quantity as sale_total_quantity,
      st.stock_qty, st.total_quantity as stock_total_quantity ,sh.price, sh.prepaid_price, sh.remaining_price
      FROM sale s
      JOIN stock st 
      ON s.product_id = st.product_id 
      AND s.specification = st.specification
      LEFT JOIN stock_history sh
      ON s.order_no = sh.change_number
      WHERE s.order_no = $1`,
      [order_no]
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
      const oldReservedQty = parseInt(stockItem.reserved_quantity || "0", 10);
      const oldAllQty = parseInt(stockItem.all_quantity || "0", 10);
      return {
        ...stockItem,
        reserved_quantity:Math.max(oldReservedQty + soldQty, 0),
        all_quantity: Math.max(oldAllQty + soldQty, 0),
      };
    });
    const updateQuantity = sale_total_quantity + stock_total_quantity
    const taipeiTime = dayjs().tz("Asia/Taipei").format("YYYY-MM-DD HH:mm:ss");
    await client.query(
      `UPDATE stock SET stock_qty = $1, total_quantity = $2 WHERE product_id = $3 AND specification = $4`,
      [JSON.stringify(updatedStock),updateQuantity, product_id, specification]
    );
    //  庫存紀錄
    const changeKey = `${order_no}-c`;
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
        "收貨取消",
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
  const { order_no,type } = req.body;
  if (!order_no||!type) {
    logger.warn("缺少必要資料");
    return sendError(res, response.missing_info, "缺少必要資料");
  }
  try {
    const result = await db.query(
      `
      SELECT 
        s.*,
        pm.amount,
        pm.type,
        pm.paid_at,
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
      AND s.product_id = p.product_id
      JOIN payment pm ON s.order_no = pm.order_no
      WHERE s.order_no = $1
      AND pm.type = $2
      `,
      [order_no,type]
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
// 訂貨完成
router.post("/order_complete", async (req, res) => {
  const { order_no } = req.body;
  if (!order_no) {
    logger.warn("缺少必要資料");
    return sendError(res, response.missing_info, "缺少必要資料");
  }
  const client = await db.connect();
  try {
    await client.query("BEGIN");
    await client.query(`UPDATE sale SET status = $1 WHERE order_no = $2`, [
      '收貨',
      order_no,
    ]);
    const orderResult = await client.query(
      `
      SELECT 
      s.*,pm.amount
      FROM sale s
      JOIN payment pm 
      ON s.order_no = pm.order_no
      AND pm.type = '訂貨'
      WHERE s.order_no = $1
      `,
      [order_no]
    );
    const order = orderResult.rows[0];
    if (!order) {
      logger.warn("查無此單");
      await client.query("ROLLBACK");
      return sendError(res, response.not_found, "查無此單");
    }
    const taipeiDate = dayjs().tz("Asia/Taipei").format("YYYY-MM-DD");
    const taipeiTime = dayjs().tz("Asia/Taipei").format("YYYY-MM-DD HH:mm:ss");
    const remainingPrice = order.price - order.amount;
    await client.query(
      "INSERT INTO payment (order_no, amount, type, paid_at, paid_date) VALUES ($1, $2, $3, $4, $5)",
      [
        order_no,
        remainingPrice,
        '收貨',
        taipeiTime,
        taipeiDate
      ]
    );
   
    const productResult = await client.query(
      "SELECT product_id, specification,stock_qty,total_quantity FROM stock WHERE product_id = $1 AND specification = $2",
      [order.product_id, order.specification]
    );

    if (productResult.rows.length === 0) {
      logger.warn("商品不存在");
      await client.query("ROLLBACK");
      return sendError(res, response.not_found, "商品不存在");
    } else {
      // 檢查庫存
      const currentStock = productResult.rows[0].stock_qty;
      const currentTotal = productResult.rows[0].total_quantity;

      let insufficientSizes = [];
      for (const soldItem of order.quantities) {
        const stockItem = currentStock.find((s) => s.size === soldItem.size);
        const reserved = parseInt(stockItem?.reserved_quantity || "0", 10);
        const soldQty = parseInt(soldItem.quantity || "0", 10);
        if (soldQty > reserved) {
          insufficientSizes.push({
            size: soldItem.size,
            reserved,
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
            .map((s) => `${s.size}(預留庫存${s.reserved}，需求${s.requested})`)
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
      `INSERT INTO stock_history (product_id, product_name, specification, quantities, create_date,change_number,change_type,total_quantity,price,prepaid_price,remaining_price)
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
      [
        order.product_id,
        order.product_name,
        order.specification,
        JSON.stringify(order.quantities),
        taipeiTime,
        order_no,
        "收貨",
        order.total_quantity,
        order.price,
        order.amount,
        remainingPrice
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
