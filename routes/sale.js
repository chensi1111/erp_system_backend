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
       `
      SELECT specification 
      FROM product 
      WHERE product_id ILIKE $1
      `,
      [`%${product_id}%`]  // 模糊搜尋
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
      p.product_id,
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
      s.size_list,
      st.cumulative_cost,
      st.last_cost,
      st.stock_qty,
      st.cumulative_in_quantity
     FROM product p
      LEFT JOIN size s ON p.size = s.size_id
      JOIN stock st ON p.product_id = st.product_id AND p.specification = st.specification
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
// 新增資料（銷貨 / 退貨）
router.post("/create", async (req, res) => {
  let {
    transaction, // 0:現場
    product_id,
    specification,
    product_name,
    quantities,
    size_list,
    price,
    total_quantity,
    remark,
    date,
    pay,
    type,  // 0:銷貨, 1:退貨
  } = req.body;

  if (
    transaction === undefined||
    !product_id ||
    !specification ||
    !product_name ||
    !quantities ||
    !size_list ||
    !total_quantity ||
    !price ||
    !date ||
    pay === undefined ||
    type === undefined
  ) {
    logger.warn("缺少必要資料");
    return sendError(res, response.missing_info, "缺少必要資料");
  }

  if (isNaN(price) || price < 0) {
    return sendError(res, response.invalid_price, "錯誤的金額");
  }

  if (remark && remark.length > 100) {
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

    // 建立 sale 記錄
    await client.query(
      `INSERT INTO sale (
        transaction, order_no, product_id, create_date, product_name,
        specification, price, size_list, quantities, total_quantity,
        remark, pay, status
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
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
        pay,
        type, // 0銷貨、1退貨
      ]
    );

    // 建立付款/退款記錄
    await client.query(
      `INSERT INTO payment (order_no, amount, type, paid_at, paid_date)
       VALUES ($1, $2, $3, $4, $5)`,
      [
        order_no,
        price * total_quantity,
        type,
        taipeiTime,
        date,
      ]
    );

    // 查庫存
    const result = await client.query(
      `SELECT product_id, specification, stock_qty, total_quantity
       FROM stock WHERE product_id = $1 AND specification = $2`,
      [product_id, specification]
    );

    if (result.rows.length === 0) {
      return sendError(res, response.not_found, "商品不存在");
    }

    const currentStock = result.rows[0].stock_qty || [];
    const currentTotal = result.rows[0].total_quantity || 0;

    // ---------------------------------------------------------
    //   type = 0 → 銷貨：需要檢查庫存
    // ---------------------------------------------------------
    // if (type === 0) {
    //   let insufficientSizes = [];

    //   for (const soldItem of quantities) {
    //     const stockItem = currentStock.find((s) => s.size === soldItem.size);
    //     const available = parseInt(stockItem?.available_quantity || "0", 10);
    //     const soldQty = parseInt(soldItem.quantity || "0", 10);

    //     if (soldQty > available) {
    //       insufficientSizes.push({
    //         size: soldItem.size,
    //         available,
    //         requested: soldQty,
    //       });
    //     }
    //   }

    //   if (insufficientSizes.length > 0) {
    //     await client.query("ROLLBACK");
    //     return sendError(
    //       res,
    //       response.insufficient_stock,
    //       `以下尺寸庫存不足: ${insufficientSizes
    //         .map((s) => `${s.size}(庫存${s.available}，需求${s.requested})`)
    //         .join(", ")}`
    //     );
    //   }
    // }

    // ---------------------------------------------------------
    //   更新庫存（銷貨扣庫存 & 退貨加庫存）
    // ---------------------------------------------------------
    const updatedStock = currentStock.map((stockItem) => {
      const qItem = quantities.find((q) => q.size === stockItem.size);
      const qty = parseInt(qItem?.quantity || "0", 10);

      const oldAvail = parseInt(stockItem.available_quantity || "0", 10);
      const oldAllQty = parseInt(stockItem.all_quantity || "0", 10);

      if (type === 0) {
        // 銷貨 
        return {
          ...stockItem,
          available_quantity: oldAvail - qty,
          all_quantity: oldAllQty - qty,
        };
      } else {
        // 退貨 
        return {
          ...stockItem,
          available_quantity: oldAvail + qty,
          all_quantity: oldAllQty + qty,
        };
      }
    });

    // total_quantity 依 type 更新
    const newTotal =
      type === 0
        ? currentTotal - total_quantity
        : currentTotal + total_quantity;

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

    // ---------------------------------------------------------
    //   新增 stock_history
    // ---------------------------------------------------------
    await client.query(
      `INSERT INTO stock_history
       (product_id, product_name, specification, quantities, create_date, change_number, change_type, total_quantity, price)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [
        product_id,
        product_name,
        specification,
        JSON.stringify(quantities),
        taipeiTime,
        order_no,
        type === 0 ? 0 : 2,
        total_quantity,
        price,
      ]
    );

    await client.query("COMMIT");

    return res.status(200).json({
      code: response.success,
      msg: "建立成功",
    });
  } catch (error) {
    logger.error(error);
    await client.query("ROLLBACK");
    return sendError(res, response.server_error, "伺服器錯誤", 500);
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
    transaction === undefined ||
    pay === undefined ||
    !date ||
    type === undefined
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
        type
      ]
    );
    await client.query(
      "INSERT INTO payment (order_no, amount, type, paid_at, paid_date) VALUES ($1, $2, $3, $4, $5)",
      [
        order_no,
        prepaid_price,
        2,
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
      // if (insufficientSizes.length > 0) {
      //   await client.query("ROLLBACK");
      //   logger.warn("庫存不足");
      //   return sendError(
      //     res,
      //     response.insufficient_stock,
      //     `以下尺寸庫存不足: ${insufficientSizes
      //       .map((s) => `${s.size}(庫存${s.available}，需求${s.requested})`)
      //       .join(", ")}`
      //   );
      // }
      const newTotal = currentTotal - total_quantity;
      // 預留庫存
      const updatedStock = currentStock.map((stockItem) => {
        const soldItem = quantities.find((q) => q.size === stockItem.size);
        const soldQty = parseInt(soldItem?.quantity || "0", 10);
        const oldQty = parseInt(stockItem.available_quantity || "0", 10);
        const oldReservedQty = parseInt(stockItem.reserved_quantity || "0", 10);
        return {
          ...stockItem,
          available_quantity: oldQty - soldQty,
          reserved_quantity: oldReservedQty + soldQty,
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
        4,
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
  const { page, pageSize, filter, sort, rangeType, customRange } = req.body;
  const offset = (page - 1) * pageSize;

  if (page < 1 || pageSize < 1) {
    logger.warn("錯誤的分頁資訊");
    return sendError(res, response.invalid_pageInfo, "錯誤的分頁資訊");
  }

  const conditions = ["is_deleted = false"];
  const values = [];
  let paramIndex = 1;

  // ---- 搜尋過濾 ----
  if (filter) {
    if (filter.order_no) {
      conditions.push(`s.order_no ILIKE $${paramIndex++}`);
      values.push(`%${filter.order_no}%`);
    }
    if (filter.product_id) {
      conditions.push(`s.product_id ILIKE $${paramIndex++}`);
      values.push(`%${filter.product_id}%`);
    }
    if (filter.specification) {
      conditions.push(`s.specification ILIKE $${paramIndex++}`);
      values.push(`%${filter.specification}%`);
    }
  }

    if (rangeType) {
      switch (rangeType) {
        case "today":
          conditions.push(`pm.paid_date::date = CURRENT_DATE`);
          break;
        case "7days":
          conditions.push(`pm.paid_date >= CURRENT_DATE - INTERVAL '7 days'`);
          break;
        case "1month":
          conditions.push(`pm.paid_date >= CURRENT_DATE - INTERVAL '1 month'`);
          break;
        case "custom":
          if (customRange?.start && customRange?.end) {
            conditions.push(`pm.paid_date BETWEEN $${paramIndex++} AND $${paramIndex++}`);
            values.push(customRange.start, customRange.end);
          }
          break;
      }
    }

  const whereClause = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";

  try {
    // ---- 查詢列表 ----
    const result = await db.query(
      `
      SELECT 
        s.*, 
        st.cumulative_cost/st.cumulative_in_quantity as average_cost,
        pm.type, 
        pm.amount, 
        pm.paid_at,
        pm.paid_date
      FROM sale s
      LEFT JOIN stock st 
        ON s.product_id = st.product_id 
        AND s.specification = st.specification
      JOIN payment pm 
        ON s.order_no = pm.order_no
      ${whereClause}
      ORDER BY paid_date ${sort}
      LIMIT $${paramIndex++} OFFSET $${paramIndex++}
      `,
      [...values, pageSize, offset]
    );

    const list = result.rows;

    // ---- 查詢總筆數 ----
    const totalResult = await db.query(
      `
      SELECT COUNT(*) as total
      FROM sale s
      JOIN payment pm ON s.order_no = pm.order_no
      ${whereClause}
      `,
      values
    );

    const total = totalResult.rows[0].total;

    // ---- 查詢統計資訊 ----
    const summaryResult = await db.query(
      `
      SELECT
        -- 訂貨金額
        COALESCE(SUM(CASE WHEN pm.type = 2 THEN pm.amount ELSE 0 END), 0) AS total_prepaid,

        -- 退訂金額
        COALESCE(SUM(CASE WHEN pm.type = 4 THEN pm.amount ELSE 0 END), 0) AS total_refund_prepaid,

        -- 取貨金額
        COALESCE(SUM(CASE WHEN pm.type = 3 THEN pm.amount ELSE 0 END), 0) AS total_remaining,

        -- 銷貨收入
        COALESCE(SUM(CASE WHEN pm.type = 0 THEN pm.amount ELSE 0 END), 0) AS total_paid,

        -- 退貨退款
        COALESCE(SUM(CASE WHEN pm.type = 1 THEN pm.amount ELSE 0 END), 0) AS total_return,

        -- 銷貨量
        COALESCE(SUM(CASE WHEN pm.type = 0 THEN s.total_quantity ELSE 0 END), 0) AS total_sale_qty,

        -- 退貨量
        COALESCE(SUM(CASE WHEN pm.type = 1 THEN s.total_quantity ELSE 0 END), 0) AS total_return_qty,

        -- 訂貨量
        COALESCE(SUM(CASE WHEN pm.type = 2 THEN s.total_quantity ELSE 0 END), 0) AS total_prepaid_qty,

        -- 退訂貨量
        COALESCE(SUM(CASE WHEN pm.type = 4 THEN s.total_quantity ELSE 0 END), 0) AS total_refund_prepaid_qty,

        -- 取貨量
        COALESCE(SUM(CASE WHEN pm.type = 3 THEN s.total_quantity ELSE 0 END), 0) AS total_remaining_qty,

        -- 日結餘額 (End-of-Day Cash Balance)
        (
         COALESCE(SUM(CASE WHEN pm.type IN (0,3,2) THEN pm.amount ELSE 0 END), 0)
         -
          COALESCE(SUM(CASE WHEN pm.type IN (1,4) THEN pm.amount ELSE 0 END), 0)
        ) AS end_of_day_balance,

        ------------------------------------------------------------------
        -- 淨成本 = 銷貨成本 - 退貨成本
        ------------------------------------------------------------------
        (
          COALESCE(SUM(
            CASE WHEN pm.type IN (0, 3)
              THEN (s.total_quantity * (st.cumulative_cost / NULLIF(st.cumulative_in_quantity, 0)))
              ELSE 0 END
          ), 0)
          -
          COALESCE(SUM(
            CASE WHEN pm.type = 1
              THEN (s.total_quantity * (st.cumulative_cost / NULLIF(st.cumulative_in_quantity, 0)))
              ELSE 0 END
          ), 0)
        ) AS net_cost,
         
        ------------------------------------------------------------------
        -- 淨毛利（淨收入 - 淨成本）
        ------------------------------------------------------------------
        (
          (
            COALESCE(SUM(CASE WHEN pm.type IN (0,3) THEN s.price * s.total_quantity ELSE 0 END), 0)
            -
            COALESCE(SUM(CASE WHEN pm.type = 1 THEN s.price * s.total_quantity ELSE 0 END), 0)
          )
          -
          (
            COALESCE(SUM(
              CASE WHEN pm.type IN (0,3)
                THEN (s.total_quantity * (st.cumulative_cost / NULLIF(st.cumulative_in_quantity,0)))
                ELSE 0 END
            ), 0)
            -
            COALESCE(SUM(
              CASE WHEN pm.type = 1
                THEN (s.total_quantity * (st.cumulative_cost / NULLIF(st.cumulative_in_quantity,0)))
                ELSE 0 END
            ), 0)
          )
        ) AS net_gross_profit,
        ------------------------------------------------------------------
        -- 淨毛利率（淨收入 - 淨成本）/ 淨收入 * 100%
        ------------------------------------------------------------------
        ROUND(
          (
            (
              COALESCE(SUM(CASE WHEN pm.type IN (0,3) THEN s.price * s.total_quantity::numeric ELSE 0 END),0)
              -
              COALESCE(SUM(CASE WHEN pm.type = 1 THEN s.price * s.total_quantity::numeric ELSE 0 END),0)
            )
            -
            (
              COALESCE(SUM(CASE WHEN pm.type IN (0,3)
                    THEN s.total_quantity * (st.cumulative_cost / NULLIF(st.cumulative_in_quantity,0))::numeric
                    ELSE 0 END),0)
              -
              COALESCE(SUM(CASE WHEN pm.type = 1
                    THEN s.total_quantity * (st.cumulative_cost / NULLIF(st.cumulative_in_quantity,0))::numeric
                    ELSE 0 END),0)
            )
          )
          /
           NULLIF(
            ABS(
              (
                COALESCE(SUM(CASE WHEN pm.type IN (0,3) THEN s.price * s.total_quantity::numeric ELSE 0 END),0)
                -
                COALESCE(SUM(CASE WHEN pm.type = 1 THEN s.price * s.total_quantity::numeric ELSE 0 END),0)
              )
            ), 0
          )
          * 100
        , 2) AS net_gross_profit_percentage
         
      FROM sale s
      LEFT JOIN stock st
        ON s.product_id = st.product_id 
        AND s.specification = st.specification
      JOIN payment pm
        ON s.order_no = pm.order_no
      ${whereClause}
      `,
      values
    );

    const summary = summaryResult.rows[0];

    // ---- 回傳結果 ----
    res.status(201).json({
      code: response.success,
      msg: "查詢成功",
      data: {
        list,
        total,
        page,
        pageSize,
        totalPages: Math.ceil(total / pageSize),
        summary,
      },
    });
  } catch (error) {
    logger.error(error);
    return sendError(res, response.server_error, "伺服器錯誤，請稍後再試", 500);
  }
});
// 查詢訂單列表
router.post("/order_list", async (req, res) => {
  const { page, pageSize, sort } = req.body;
  const offset = (page - 1) * pageSize;

  if (page < 1 || pageSize < 1) {
    logger.warn("錯誤的分頁資訊");
    return sendError(res, response.invalid_pageInfo, "錯誤的分頁資訊");
  }

  try {
    // ---- 查詢列表 ----
    const result = await db.query(
      `
      SELECT 
        s.order_no,
        s.product_id,
        s.specification,
        s.quantities,
        s.total_quantity,
        s.price*s.total_quantity as total_price,  
        pm.amount, 
        pm.paid_at,
        pm.paid_date
      FROM sale s
      JOIN payment pm 
        ON s.order_no = pm.order_no
      WHERE s.status = 2 AND pm.is_deleted = false
      ORDER BY paid_date ${sort}
      LIMIT $1 OFFSET $2
      `,
      [pageSize, offset]
    );

    const list = result.rows;

    // ---- 查詢總筆數 ----
    const totalResult = await db.query(
      `
      SELECT COUNT(*) as total
      FROM sale s
      JOIN payment pm ON s.order_no = pm.order_no
      WHERE s.status = 2 AND pm.is_deleted = false
      `
    );

    const total = totalResult.rows[0].total;

    // ---- 回傳結果 ----
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
      0
    ]);
    await client.query(`UPDATE sale SET status = $1 WHERE order_no = $2`, [
      5,
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
         available_quantity: oldQty + soldQty,
         all_quantity: oldAllQty + soldQty,
      };
    });
    const updateQuantity = sale_total_quantity + stock_total_quantity
    const taipeiTime = dayjs().tz("Asia/Taipei").format("YYYY-MM-DD HH:mm:ss");
    await client.query(
      `UPDATE stock SET stock_qty = $1, total_quantity = $2 WHERE product_id = $3 AND specification = $4`,
      [JSON.stringify(updatedStock),updateQuantity, product_id, specification]
    );
     // 庫存紀錄
    const changeKey = `${order_no}`;
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
        1,
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
// 刪除
router.post("/delete_refund", async (req, res) => {
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
      1
    ]);
    await client.query(`UPDATE sale SET status = $1 WHERE order_no = $2`, [
      3,
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
         available_quantity: oldQty - soldQty,
         all_quantity: oldAllQty - soldQty,
      };
    });
    const updateQuantity = sale_total_quantity + stock_total_quantity
    const taipeiTime = dayjs().tz("Asia/Taipei").format("YYYY-MM-DD HH:mm:ss");
    await client.query(
      `UPDATE stock SET stock_qty = $1, total_quantity = $2 WHERE product_id = $3 AND specification = $4`,
      [JSON.stringify(updatedStock),updateQuantity, product_id, specification]
    );
     // 庫存紀錄
    const changeKey = `${order_no}`;
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
        3,
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
  const { order_no,type } = req.body;
  if (!order_no||type===undefined) {
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
      AND status = $2`,
      [order_no,3]
    );
    if (orderStatus.rows.length > 0) {
      await client.query("ROLLBACK");
      logger.warn("此訂單已有取貨紀錄，無法刪除");
      return sendError(res, response.invalid_action, "此訂單已有取貨紀錄，無法刪除");
    }
    const taipeiTime = dayjs().tz("Asia/Taipei").format("YYYY-MM-DD HH:mm:ss");
    if(type===5){
      await client.query(`UPDATE payment SET is_deleted = $1, type = $2 WHERE order_no = $3 AND type = $4`, [
      true,
      5,
      order_no,
      2
    ]);
    }else{
      await client.query(`UPDATE payment SET type = $1,paid_date =$2 WHERE order_no = $3 AND type = $4`, [
      4,
      taipeiTime,
      order_no,
      2
    ]);
    }
    await client.query(`UPDATE sale SET status = $1 WHERE order_no = $2`, [
      type,
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
        available_quantity: oldAvailableQty + soldQty,
        reserved_quantity: oldReservedQty - soldQty,
      };
    });
    const updateQuantity = sale_total_quantity + stock_total_quantity
    await client.query(
      `UPDATE stock SET stock_qty = $1, total_quantity = $2 WHERE product_id = $3 AND specification = $4`,
      [JSON.stringify(updatedStock),updateQuantity, product_id, specification]
    );
     // 庫存紀錄
    const changeKey = `${order_no}`;
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
        type,
        sale_total_quantity,
        price*sale_total_quantity,
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
// 刪除取貨
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
      3
    ]);
    await client.query(`UPDATE sale SET status = $1 WHERE order_no = $2`, [
      2,
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
        reserved_quantity:oldReservedQty + soldQty,
        all_quantity: oldAllQty + soldQty,
      };
    });
    const updateQuantity = sale_total_quantity + stock_total_quantity
    const taipeiTime = dayjs().tz("Asia/Taipei").format("YYYY-MM-DD HH:mm:ss");
    await client.query(
      `UPDATE stock SET stock_qty = $1, total_quantity = $2 WHERE product_id = $3 AND specification = $4`,
      [JSON.stringify(updatedStock),updateQuantity, product_id, specification]
    );
    //  庫存紀錄
    const changeKey = `${order_no}`;
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
        7,
        sale_total_quantity,
        price*sale_total_quantity,
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
  if (!order_no||type===undefined) {
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
        st.cumulative_cost / st.cumulative_in_quantity as average_cost 
      FROM sale s
      JOIN product p ON s.specification = p.specification AND s.product_id = p.product_id
      JOIN payment pm ON s.order_no = pm.order_no
      JOIN stock st ON s.specification = st.specification AND s.product_id = st.product_id
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
    const orderStatus = await client.query(`
      SELECT 
      s.status
      FROM sale s
      WHERE s.order_no = $1 AND s.status = $2
      `,
    [order_no,3])
    if(orderStatus.rows[0]){
      logger.warn("此訂單已有取貨紀錄，無法重複取貨");
      await client.query("ROLLBACK");
      return sendError(res, response.not_allow, "此訂單已有取貨紀錄，無法重複取貨");
    }
    await client.query(`UPDATE sale SET status = $1 WHERE order_no = $2`, [
      3,
      order_no,
    ]);
    const orderResult = await client.query(
      `
      SELECT 
      s.*,pm.amount
      FROM sale s
      JOIN payment pm 
      ON s.order_no = pm.order_no
      AND pm.type = 2
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
    const remainingPrice = (order.price*order.total_quantity) - order.amount;
    await client.query(
      "INSERT INTO payment (order_no, amount, type, paid_at, paid_date) VALUES ($1, $2, $3, $4, $5)",
      [
        order_no,
        remainingPrice,
        3,
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
      // if (insufficientSizes.length > 0) {
      //   await client.query("ROLLBACK");
      //   logger.warn("庫存不足");
      //   return sendError(
      //     res,
      //     response.insufficient_stock,
      //     `以下尺寸預留庫存不足: ${insufficientSizes
      //       .map((s) => `${s.size}(預留庫存${s.reserved}，需求${s.requested})`)
      //       .join(", ")}`
      //   );
      // }
      const newTotal = currentTotal - order.total_quantity;
      // 扣除庫存
      const updatedStock = currentStock.map((stockItem) => {
        const soldItem = order.quantities.find((q) => q.size === stockItem.size);
        const soldQty = parseInt(soldItem?.quantity || "0", 10);
        const oldReservedQty = parseInt(stockItem.reserved_quantity || "0", 10);
        const oldAllQty = parseInt(stockItem.all_quantity || "0", 10);
        return {
          ...stockItem,
          reserved_quantity:oldReservedQty - soldQty,
          all_quantity: oldAllQty - soldQty,
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
        6,
        order.total_quantity,
        order.price*order.total_quantity,
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
