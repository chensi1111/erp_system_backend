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
      s.size_list,
      st.stock_qty
     FROM product p
     LEFT JOIN size s ON p.size = s.size_id
     LEFT JOIN stock st ON p.product_id = st.product_id AND p.specification = st.specification
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
    transaction,// 0=買斷 1=寄賣
    date,
    manufactor,
    remark,
    productList,
    type, // 0=進貨、1=退貨
  } = req.body;

  if (transaction === undefined|| !date || !manufactor || !productList || type === undefined) {
    return sendError(res, response.missing_info, "缺少必要資料");
  }

  if (remark && remark.length > 100) {
    return sendError(res, response.invalid_remark, "備註長度超過限制");
  }

  // 單號
  const datePart = dayjs().format("YYYYMMDDHHmm");
  const randomPart = randomUUID().replace(/-/g, "").slice(0, 3).toUpperCase();
  const restock_id = `R${datePart}-${randomPart}`;
  const taipeiTime = dayjs().tz("Asia/Taipei").format("YYYY-MM-DD HH:mm:ss");

  const client = await db.connect();
  try {
    await client.query("BEGIN");

    // 建立 restock 主表
    await client.query(
      `INSERT INTO restock (type, transaction, restock_id, date, create_date, manufactor, remark)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [type, transaction, restock_id, date, taipeiTime, manufactor, remark]
    );

    // 處理商品
    for (const item of productList) {
      const {
        product_id,
        specification,
        quantities,
        total_quantity,
        price,
        product_name,
      } = item;

      const qtyInt = Number(total_quantity || 0);
      const unitPrice = Number(price || 0);
      const costDelta = unitPrice * qtyInt;

      // 取得累積成本與庫存
      const qtyResult = await client.query(
        `SELECT stock_qty, total_quantity, last_in_date, cumulative_cost, last_cost,cumulative_in_quantity
         FROM stock WHERE product_id = $1 AND specification = $2`,
        [product_id, specification]
      );
      const exists = qtyResult.rows.length > 0;

      // 資料存在時的累積成本與庫存
      const currentCumulativeCost = exists ? Number(qtyResult.rows[0].cumulative_cost || 0) : 0;
      const currentTotalQty = exists ? Number(qtyResult.rows[0].total_quantity || 0) : 0;
      const currentStock = exists ? (qtyResult.rows[0].stock_qty || []) : [];
      const currentCumulativeInQty = exists ? Number(qtyResult.rows[0].cumulative_in_quantity || 0) : 0;

      // 退貨商品必須存在於庫存中
      if (!exists && type === 1) {
        await client.query("ROLLBACK");
        return sendError(res, response.not_found, `退貨商品不存在於庫存 商品型號=${product_id} 商品規格=${specification}`);
      }
      if (type === 1 && currentTotalQty < qtyInt) {
        await client.query("ROLLBACK");
        return sendError(res, response.not_enough, `退貨數量不可超過庫存 商品型號=${product_id} 商品規格=${specification}`);
      }

      // type = 0 → 進貨 ,type = 1 → 退貨
      let newCumulativeCost
      let newCumulativeInQty

      if (type === 0) {
        newCumulativeCost = currentCumulativeCost + costDelta;
        newCumulativeInQty = currentCumulativeInQty + qtyInt;
      }else if (type === 1) {
        newCumulativeCost = currentCumulativeCost - costDelta
        newCumulativeInQty = currentCumulativeInQty - qtyInt;
      }
      const newTotalQty = type === 0 ? currentTotalQty + qtyInt : currentTotalQty - qtyInt;

        // 初次進貨，建立庫存資料
        if (!exists && type === 0) {
        const normalizedQty = (quantities || []).map(q => ({
          size: q.size,
          safe_stock: q.safe_stock ?? "",
          all_quantity: String(Number(q.all_quantity || 0)),
          reserved_quantity: String(Number(q.reserved_quantity || 0) || ""),
          available_quantity: String(Number(q.available_quantity || 0) || ""),
        }));

        await client.query(
          `INSERT INTO stock
           (product_id, product_name, specification, stock_qty, total_quantity, last_in_date, last_cost, cumulative_cost,cumulative_in_quantity)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
          [
            product_id,
            product_name,
            specification,
            JSON.stringify(normalizedQty),
            newTotalQty,
            taipeiTime,
            type === 0 ? unitPrice : null,
            newCumulativeCost,
            newCumulativeInQty
          ]
        );
      } else {
        // 有庫存，更新庫存資料
        const updatedStock = (currentStock || []).map( (oldItem) => {
          const changeItem = (quantities || []).find(q => String(q.size) === String(oldItem.size));
          const changeQty = Number(changeItem?.all_quantity || 0);

          const oldAll = Number(oldItem.all_quantity || 0);
          const oldReserved = Number(oldItem.reserved_quantity || 0);

          let newAll = type === 0 ? oldAll + changeQty : oldAll - changeQty;

          // 檢查庫存量
          // if (newAll < oldReserved) {
          //   throw new Error(`庫存不可低於預留數量 尺寸=${oldItem.size} (預留=${oldReserved} 更新=${newAll})`);
          // }

          const newAvailable = newAll - oldReserved;

          return {
            ...oldItem,
            all_quantity: String(newAll),
            available_quantity: String(newAvailable)
          };
        });

        await client.query(
          `UPDATE stock
           SET stock_qty = $1,
               total_quantity = $2,
               last_in_date = $3,
               last_cost = $4,
               cumulative_cost = $5,
               cumulative_in_quantity = $6
           WHERE product_id = $7 AND specification = $8`,
          [
            JSON.stringify(updatedStock),
            newTotalQty,
            type === 0 ? taipeiTime : qtyResult.rows[0].last_in_date,
            type === 0 ? unitPrice : qtyResult.rows[0].last_cost,
            newCumulativeCost,
            newCumulativeInQty,
            product_id,
            specification
          ]
        );
      }

      // === 新增歷史紀錄 ===
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
          type === 0 ? 10 : 12, 
          type === 0 ? total_quantity : total_quantity,
          price,
        ]
      );
    }

    await client.query("COMMIT");
    return res.json({
      code: response.success,
      msg: "建立成功",
    });
  } catch (err) {
    await client.query("ROLLBACK");
    return sendError(res, response.server_error, err.message || "伺服器錯誤");
  } finally {
    client.release();
  }
});
// 查詢列表
router.post("/list", async (req, res) => {
  const { page, pageSize, filter,sort,rangeType,customRange } = req.body;
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
    if (rangeType) {
      switch (rangeType) {
        case "today":
          conditions.push(`date::date = CURRENT_DATE`);
          break;
        case "7days":
          conditions.push(`date >= CURRENT_DATE - INTERVAL '7 days'`);
          break;
        case "1month":
          conditions.push(`date >= CURRENT_DATE - INTERVAL '1 month'`);
          break;
        case "custom":
          if (customRange?.start && customRange?.end) {
            conditions.push(`date BETWEEN $${paramIndex++} AND $${paramIndex++}`);
            values.push(customRange.start, customRange.end);
          }
          break;
      }
    }

    const whereClause = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
  try {
    const result = await db.query(
      `
      SELECT 
       restock_id,
       manufactor,
       date,
       type,

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
          COALESCE(SUM(sh.total_quantity) FILTER (WHERE sh.change_type = 10), 0) AS total_in_quantity,
          COALESCE(SUM(sh.total_quantity * sh.price) FILTER (WHERE sh.change_type = 10), 0) AS total_in_price,

          COALESCE(SUM(sh.total_quantity) FILTER (WHERE sh.change_type = 12), 0) AS total_out_quantity,
          COALESCE(SUM(sh.total_quantity * sh.price) FILTER (WHERE sh.change_type = 12), 0) AS total_out_price
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
        summary
      }
    });
  } catch (error) {
    logger.error(error)
    return sendError(res, response.server_error, "伺服器錯誤，請稍後再試", 500);
  }
})
// 刪除（取消進貨/退貨）
router.post("/delete", async (req, res) => {
  const { restock_id, type } = req.body; // type: 0=進貨, 1=退貨

  if (!restock_id || type === undefined) {
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

    // 查詢所有 stock_history 明細
    const changeType = type === 0 ? 10 : 12;
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
         AND change_type = $2`,
      [restock_id, changeType]
    );

    if (historyRes.rows.length === 0) {
      await client.query("ROLLBACK");
      return sendError(res, response.not_found, `找不到紀錄`);
    }

    // 逐筆處理每個商品
    for (const row of historyRes.rows) {
      const { product_id, product_name, specification, quantities, total_quantity, price } = row;

      // 查詢庫存
      const stockRes = await client.query(
        `SELECT stock_qty, total_quantity, cumulative_cost, cumulative_in_quantity
         FROM stock 
         WHERE product_id = $1 AND specification = $2`,
        [product_id, specification]
      );

      if (stockRes.rows.length === 0) {
        await client.query("ROLLBACK");
        return sendError(res, response.not_found,
          `找不到庫存 商品型號=${product_id}, 商品規格=${specification}`
        );
      }

      const { stock_qty, total_quantity: stock_total_qty, cumulative_cost, cumulative_in_quantity} = stockRes.rows[0];

      // 更新庫存數量
      const updatedStockQty = stock_qty.map((stockItem) => {
        const changeItem = quantities.find((q) => q.size === stockItem.size);
        const changeQty = Number(changeItem?.all_quantity || 0);

        const oldAll = Number(stockItem.all_quantity);
        const oldReserved = Number(stockItem.reserved_quantity || 0);

        let newAll, newAvailable;

        if (type === 0) {
          // 取消進貨 → 減少庫存
          newAll = oldAll - changeQty;
          newAvailable = newAll - oldReserved;

          if (newAll < oldReserved) {
            throw new Error(`庫存不足 尺寸=${stockItem.size}`);
          }

        } else {
          // 取消退貨 → 增加庫存
          newAll = oldAll + changeQty;
          newAvailable = newAll - oldReserved;
        }

        return {
          ...stockItem,
          all_quantity: newAll.toString(),
          available_quantity: newAvailable.toString(),
        };
      });

      // 更新整體庫存總量
      const newTotalQty =
        type === 0
          ? stock_total_qty - total_quantity
          : stock_total_qty + total_quantity;

      // 更新累積成本
      const currentCost = Number(cumulative_cost || 0);
      const currentInQty = Number(cumulative_in_quantity || 0);
      const costChange = Number(total_quantity) * Number(price);

      const newCumulativeCost =
        type === 0
          ? currentCost - costChange   // 取消進貨 → 減少成本
          : currentCost + costChange;  // 取消退貨 → 增加成本
      const newCumulativeInQty =
        type === 0
          ? currentInQty - Number(total_quantity) // 取消進貨 → 數量減少
          : currentInQty + Number(total_quantity) // 取消退貨 → 數量增加（加回）

      // 找最近有效的進貨，用於回推 last_in_date 與 last_cost
      const lastStockHistory = await client.query(
        `SELECT sh.create_date, sh.price
         FROM stock_history sh
         JOIN restock r ON r.restock_id = sh.change_number
         WHERE sh.product_id=$1
           AND sh.specification=$2
           AND sh.change_type=10
           AND sh.change_number != $3
           AND r.is_deleted = false
         ORDER BY sh.create_date DESC
         LIMIT 1`,
        [product_id, specification, restock_id]
      );

      const lastDate = lastStockHistory.rows[0]?.create_date || null;
      const lastCost = lastStockHistory.rows[0]?.price || null;

      // 更新 stock
      await client.query(
        `UPDATE stock 
         SET stock_qty = $1, 
             total_quantity = $2,
             cumulative_cost = $3,
             cumulative_in_quantity = $4,
             last_in_date = $5,
             last_cost = $6
         WHERE product_id = $7 AND specification = $8`,
        [
          JSON.stringify(updatedStockQty),
          newTotalQty,
          newCumulativeCost,
          newCumulativeInQty,
          lastDate,
          lastCost,
          product_id,
          specification
        ]
      );

      // 寫入 stock_history（取消紀錄）
      const taipeiTime = dayjs().tz("Asia/Taipei").format("YYYY-MM-DD HH:mm:ss");
      const cancelType = type === 0 ? 11 : 13;

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
          restock_id,
          cancelType,
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
    const cleanMsg = error.message.replace(/\x1b\[[0-9;]*m/g, "");
    await client.query("ROLLBACK");
    return sendError(res, response.server_error, cleanMsg || "伺服器錯誤");
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
      `SELECT type,restock_id, manufactor, transaction, date, create_date, remark
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

