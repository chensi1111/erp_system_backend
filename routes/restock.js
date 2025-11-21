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
const { randomUUID } = require("crypto");
function sendError(res, code, msg, status = 400) {
  return res.status(status).json({ code, msg });
}
// 獲取商品規格選項
router.post("/specification", async (req, res) => {
  let { specification } = req.body;
  if (!specification) {
    logger.warn("缺少必要資料");
    return sendError(res, response.missing_info, "缺少必要資料");
  }
  try {
    const result = await db.query(
      `SELECT product_id from product WHERE specification = $1`,[specification]
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
// 獲取廠商的商品資料
router.post("/productList", async (req, res) => {
  let { manufactor } = req.body;
  if (!manufactor) {
    logger.warn("請先輸入廠商");
    return sendError(res, response.missing_info, "請先輸入廠商");
  }
  try {
    const result = await db.query(
      // 去除重複值
      `SELECT DISTINCT specification from product WHERE manufactor = $1`,[manufactor]
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
  let { specification,product_id } = req.body;
  if (!specification||!product_id) {
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
      p.purchase_price,
      s.size_list
     FROM product p
     LEFT JOIN size s ON p.size = s.size_id
     WHERE p.specification = $1 AND p.product_id = $2
     `,
      [specification,product_id]
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
    date,
    manufactor,
    remark,
    productList
  } = req.body;
  if (
    !transaction ||
    !date ||
    !manufactor ||
    !productList 
  ) {
    logger.warn("缺少必要資料");
    return sendError(res, response.missing_info, "缺少必要資料");
  }
  if (remark && remark.length > 100) {
    logger.warn("備註長度超過限制");
    return sendError(res, response.invalid_remark, "備註長度超過限制");
  }
  // 產生單號
  const datePart = dayjs().format("YYYYMMDDHHmm");
  const randomPart = randomUUID().replace(/-/g, "").slice(0, 3).toUpperCase();
  const restock_id = `R${datePart}-${randomPart}`;

  const taipeiTime = dayjs().tz('Asia/Taipei').format('YYYY-MM-DD HH:mm:ss');
  const client = await db.connect()
  try {
    await client.query('BEGIN');
    await client.query(
      "INSERT INTO restock (transaction, restock_id, date, create_date, manufactor, remark) VALUES ($1, $2, $3, $4, $5 ,$6)",
      [
        transaction,
        restock_id,
        date,
        taipeiTime,
        manufactor,
        remark
      ]
    );
     // *********** 逐一處理商品 ***********
    for (const item of productList) {
      const {
        product_id,
        specification,
        quantities,
        total_quantity,
        price,
        total_price,
        product_name
      } = item;

      // 取得平均成本 oldCost * oldQty
      const costResult = await client.query(
        `SELECT average_cost FROM product WHERE product_id = $1 AND specification = $2`,
        [product_id,specification]
      );
      const quantityResult = await client.query(
        `SELECT total_quantity FROM stock WHERE product_id = $1 AND specification = $2`,
        [product_id,specification]
      );

      const currentAverageCost = Number(costResult.rows[0]?.average_cost) || 0;
      const currentTotalQty = Number(quantityResult.rows[0]?.total_quantity) || 0;

      // 計算新的平均成本
      const newAverageCost = Math.round(
        (currentAverageCost * currentTotalQty + total_price) /
        (currentTotalQty + total_quantity)
      );

      // 更新商品進價
      await client.query(
        `UPDATE product
         SET last_cost = $1, average_cost = $2
         WHERE product_id = $3 AND specification = $4`,
        [price, newAverageCost, product_id, specification]
      );

      // ===== 更新庫存 =====
      const stockResult = await client.query(
        `SELECT product_id, specification, stock_qty, total_quantity
         FROM stock 
         WHERE product_id = $1 AND specification = $2`,
        [product_id, specification]
      );

      if (stockResult.rows.length === 0) {
        // 商品不存在 → 插入新庫存
        await client.query(
          `INSERT INTO stock (product_id, product_name, specification, stock_qty, total_quantity, last_in_date)
           VALUES ($1, $2, $3, $4, $5, $6)`,
          [
            product_id,
            product_name,
            specification,
            JSON.stringify(quantities),
            total_quantity,
            date
          ]
        );
      } else {
        // 已存在 → 更新庫存
        const currentStock = stockResult.rows[0].stock_qty;
        const currentTotal = stockResult.rows[0].total_quantity;

        const mergedTotal = currentTotal + total_quantity;

        const mergedStock = currentStock.map(itemOld => {
          const newItem = quantities.find(q => q.size === itemOld.size);
          const addQty = Number(newItem?.all_quantity || 0);
          const oldAllQty = Number(itemOld.all_quantity || 0);
          const reservedQty = Number(itemOld.reserved_quantity || 0);

          const newAllQty = oldAllQty + addQty;
          const newAvailableQty = newAllQty - reservedQty;

          return {
            ...itemOld,
            all_quantity: newAllQty.toString(),
            available_quantity: newAvailableQty.toString()
          };
        });

        await client.query(
          `UPDATE stock
           SET stock_qty = $1, total_quantity = $2, last_in_date = $3
           WHERE product_id = $4 AND specification = $5`,
          [
            JSON.stringify(mergedStock),
            mergedTotal,
            taipeiTime,
            product_id,
            specification
          ]
        );
      }

      // ===== 新增庫存紀錄 =====
      await client.query(
        `INSERT INTO stock_history
         (product_id, product_name, specification, quantities, create_date, change_number, change_type, total_quantity, price)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
        [
          product_id,
          product_name,
          specification,
          JSON.stringify(quantities),
          taipeiTime,
          restock_id,
          "進貨",
          total_quantity,
          price
        ]
      );
    }

    await client.query("COMMIT");
    res.status(200).json({
      code: response.success,
      msg: "建立成功"
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
  const { page, pageSize, filter,sort,showOneDay,selectedDate } = req.body;
  const offset = (page - 1) * pageSize;
  if (page < 1 || pageSize < 1) {
    logger.warn("錯誤的分頁資訊")
    return sendError(res, response.invalid_pageInfo, "錯誤的分頁資訊");
  }
  const conditions = [];
  const values = [];
  let paramIndex = 1;
  conditions.push(`is_deleted = false`);

    if (filter) {
      // ILIKE不區分大小寫
      // %value%部分相符比對
      if (filter.restock_id) {
        conditions.push(`restock_id ILIKE $${paramIndex++}`);
        values.push(`%${filter.restock_id}%`);
      }
      if (filter.manufactor) {
        conditions.push(`manufactor ILIKE $${paramIndex++}`);
        values.push(`%${filter.manufactor}%`);
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

    const whereClause = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
  try {
    const result = await db.query(
      `
      SELECT 
       restock_id,
       manufactor,
       date,

       (
         SELECT COALESCE(SUM(total_quantity), 0)
          FROM stock_history 
          WHERE change_number = restock.restock_id
        ) AS total_quantity,

        (
          SELECT COALESCE(SUM(total_quantity * price), 0)
          FROM stock_history 
          WHERE change_number = restock.restock_id
       ) AS total_price

    FROM restock
     ${whereClause}
     ORDER BY restock_id ${sort}
     LIMIT $${paramIndex++} OFFSET $${paramIndex++}
     `,
     [...values, pageSize, offset]
    );
    const list = result.rows;
    // 查詢總筆數
    const totalResult = await db.query(
      `SELECT COUNT(*) as total FROM restock ${whereClause}`,
      values
    );
    const total = totalResult.rows[0].total;
    const summaryResult = await db.query(
    `
      SELECT
        COALESCE(SUM(sh.total_quantity), 0) AS total_quantity_sum,
        COALESCE(SUM(sh.total_quantity * sh.price), 0) AS total_price_sum
      FROM stock_history sh
      JOIN restock r ON sh.change_number = r.restock_id
      ${whereClause}
    `,
    values
  );

    const summary = summaryResult.rows[0];
    res.status(201).json({
      code: response.success,
      msg: "查詢成功",
      data: {
        list,
        total,
        page,
        pageSize,
        totalPages: Math.ceil(total / pageSize),
        total_quantity_sum: summary.total_quantity_sum,
        total_price_sum: summary.total_price_sum,
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

  if (!restock_id) {
    logger.warn("缺少必要資料");
    return sendError(res, response.missing_info, "缺少必要資料");
  }

  const client = await db.connect();

  try {
    await client.query("BEGIN");

    // 標記 restock 為刪除
    await client.query(
      `UPDATE restock SET is_deleted = true WHERE restock_id = $1`,
      [restock_id]
    );

    // 查詢所有 stock_history 明細）
    const historyRes = await client.query(
      `SELECT 
          product_id,
          product_name,
          specification,
          quantities,
          total_quantity,
          price
       FROM stock_history
       WHERE change_number = $1
       AND change_type = '進貨'`,
      [restock_id]
    );

    if (historyRes.rows.length === 0) {
      await client.query("ROLLBACK");
      return sendError(res, response.not_found, "找不到進貨紀錄");
    }

    // 逐筆處理每個商品
    for (const row of historyRes.rows) {
      const {
        product_id,
        product_name,
        specification,
        quantities,
        total_quantity,
        price
      } = row;

      // 查詢該商品的庫存
      const stockRes = await client.query(
        `SELECT stock_qty, total_quantity
         FROM stock
         WHERE product_id = $1 AND specification = $2`,
        [product_id, specification]
      );

      if (stockRes.rows.length === 0) {
        throw new Error(`找不到庫存 product_id=${product_id}, spec=${specification}`);
      }

      const {
        stock_qty,
        total_quantity: stock_total_qty
      } = stockRes.rows[0];

      // 回補庫存 (依 size 回補)
      console.log(stockRes.rows[0],'舊庫存')
      const updatedStockQty = stock_qty.map((stockItem) => {
        const soldItem = quantities.find((q) => q.size === stockItem.size);
        const soldQty = parseInt(soldItem?.all_quantity || "0", 10);

        const oldAll = parseInt(stockItem.all_quantity || "0", 10);
        const oldAvailable = parseInt(stockItem.available_quantity || "0", 10);

        const newAll = oldAll - soldQty;
        const newAvailable = oldAvailable - soldQty;

        return {
          ...stockItem,
          all_quantity: newAll.toString(),
          available_quantity: newAvailable.toString(),
        };
      });

      const newTotalQty = stock_total_qty - total_quantity;
      console.log(updatedStockQty,newTotalQty,product_id,specification,'test')
      // 更新庫存
      await client.query(
        `UPDATE stock 
         SET stock_qty = $1,
         total_quantity = $2
         WHERE product_id = $3 AND specification = $4`,
        [
          JSON.stringify(updatedStockQty),
          newTotalQty,
          product_id,
          specification
        ]
      );

      // 寫入 stock_history（進貨取消）
      const changeKey = `${restock_id}-c`;
      const taipeiTime = dayjs().tz("Asia/Taipei").format("YYYY-MM-DD HH:mm:ss");

      await client.query(
        `INSERT INTO stock_history 
         (product_id, product_name, specification, quantities, create_date,
          change_number, change_type, total_quantity, price)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
        [
          product_id,
          product_name,
          specification,
          JSON.stringify(quantities),
          taipeiTime,
          changeKey,
          "進貨取消",
          total_quantity,
          price
        ]
      );
    }

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
  const { restock_id } = req.body;
  if (!restock_id) return sendError(res, response.missing_info, '缺少必要資料');

  try {
    // restock 主資料
    const restockInfo = await db.query(
      `SELECT restock_id, manufactor, transaction, date, create_date, remark
       FROM restock
       WHERE restock_id = $1`,
      [restock_id]
    );

    if (restockInfo.rows.length === 0)
      return sendError(res, response.not_found, "查無此單");

    // stock_history 多筆資料
    const stockHistory = await db.query(
      `SELECT product_id, specification, quantities, total_quantity, price
       FROM stock_history
       WHERE change_number = $1`,
      [restock_id]
    );

    res.status(200).json({
      code: response.success,
      msg: "查詢成功",
      data: {
        restock: restockInfo.rows[0], 
        items: stockHistory.rows       
      }
    });

  } catch (error) {
    logger.error(error);
    return sendError(res, response.server_error, "伺服器錯誤，請稍後再試", 500);
  }
});

module.exports = router;

