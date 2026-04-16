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
router.post("/list", async (req, res) => {
  const { page, pageSize, filter, sort, rangeType, customRange } = req.body;
  const offset = (page - 1) * pageSize;

  if (page < 1 || pageSize < 1) {
    logger.warn("錯誤的分頁資訊");
    return sendError(res, response.invalid_pageInfo, "錯誤的分頁資訊");
  }

  try {
    const values = [];
    let paramIndex = 1;

    // --------------------------
    // 組條件
    const conditions = [`s.status != 5`]; // 排除取消

    if (filter?.product_id) {
      conditions.push(`s.product_id ILIKE $${paramIndex++}`);
      values.push(`%${filter.product_id}%`);
    }
    if (filter?.specification) {
      conditions.push(`s.specification ILIKE $${paramIndex++}`);
      values.push(`%${filter.specification}%`);
    }
    if (filter?.product_name) {
      conditions.push(`s.product_name ILIKE $${paramIndex++}`);
      values.push(`%${filter.product_name}%`);
    }
    if (filter?.manufactor) {
      conditions.push(`p.manufactor ILIKE $${paramIndex++}`);
      values.push(`%${filter.manufactor}%`);
    }

    // 日期篩選：依 payment.paid_date
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

    // --------------------------
    // list 查詢
    const listQuery = `
      SELECT
        s.product_id,
        s.product_name,
        s.specification,
        st.cumulative_cost/st.cumulative_in_quantity as average_cost,

        -- 數量
        SUM(CASE WHEN s.status IN (0,3) THEN s.total_quantity ELSE 0 END) AS sale_quantity,
        SUM(CASE WHEN s.status = 1 THEN s.total_quantity ELSE 0 END) AS refund_quantity,
        SUM(CASE WHEN s.status = 2 THEN s.total_quantity ELSE 0 END) AS ordering_quantity,
        SUM(CASE WHEN s.status = 4 THEN s.total_quantity ELSE 0 END) AS return_order_quantity,
        -- 金額
        SUM(CASE WHEN s.status IN (0,3) THEN s.total_quantity * price ELSE 0 END) AS sale_amount,
        SUM(CASE WHEN s.status = 1 THEN s.total_quantity * price ELSE 0 END) AS refund_amount,
        SUM(CASE WHEN s.status = 2 THEN pm.amount ELSE 0 END) AS ordering_amount,
        SUM(CASE WHEN s.status = 4 THEN pm.amount ELSE 0 END) AS return_order_amount
      FROM sale s
      LEFT JOIN payment pm ON pm.order_no = s.order_no
      LEFT JOIN stock st ON st.product_id = s.product_id AND st.specification = s.specification
      LEFT JOIN product p ON s.specification = p.specification AND s.product_id = p.product_id
      ${whereClause}
      GROUP BY s.product_id, s.product_name, s.specification, st.cumulative_cost, st.cumulative_in_quantity
      ORDER BY s.product_id ${sort || "ASC"}
      LIMIT $${paramIndex++} OFFSET $${paramIndex++}
    `;

    const listResult = await db.query(listQuery, [...values, pageSize, offset]);
    const list = listResult.rows;


     // --------------------------
    // summary 查詢（加總同條件）
    const summaryQuery = `
      SELECT
        COALESCE(SUM(CASE WHEN s.status IN (0,3) THEN s.total_quantity ELSE 0 END), 0) AS sale_quantity,
        COALESCE(SUM(CASE WHEN s.status = 1 THEN s.total_quantity ELSE 0 END), 0) AS refund_quantity,
        COALESCE(SUM(CASE WHEN s.status = 2 THEN s.total_quantity ELSE 0 END), 0) AS ordering_quantity,
        COALESCE(SUM(CASE WHEN s.status = 4 THEN s.total_quantity ELSE 0 END), 0) AS return_order_quantity,
        -- 金額
        COALESCE(SUM(CASE WHEN s.status IN (0,3) THEN s.total_quantity * price ELSE 0 END), 0) AS sale_amount,
        COALESCE(SUM(CASE WHEN s.status = 1 THEN s.total_quantity * price ELSE 0 END), 0) AS refund_amount,
        COALESCE(SUM(CASE WHEN s.status = 2 THEN pm.amount ELSE 0 END), 0) AS ordering_amount,
        COALESCE(SUM(CASE WHEN s.status = 4 THEN pm.amount ELSE 0 END), 0) AS return_order_amount,
        SUM(
        (
          (CASE WHEN s.status IN (0,3) THEN s.total_quantity * price ELSE 0 END)
          - 
          (CASE WHEN s.status = 1 THEN s.total_quantity * price ELSE 0 END)
        )
        -
        (
          (
            (CASE WHEN s.status IN (0,3) THEN s.total_quantity ELSE 0 END)
            -
            (CASE WHEN s.status = 1 THEN s.total_quantity ELSE 0 END)
          )
          * (st.cumulative_cost / NULLIF(st.cumulative_in_quantity,0))
        )
      ) AS gross_profit
      FROM sale s
      LEFT JOIN payment pm ON pm.order_no = s.order_no
      LEFT JOIN stock st ON st.product_id = s.product_id AND st.specification = s.specification
      LEFT JOIN product p ON s.specification = p.specification AND s.product_id = p.product_id
      ${whereClause}
    `;

    const summaryResult = await db.query(summaryQuery, values);
    const summary = summaryResult.rows[0];

    // --------------------------

    const countQuery =`
     SELECT COUNT(*) AS total
      FROM (
        SELECT 1
         FROM sale s
         LEFT JOIN payment pm ON s.order_no = pm.order_no
         LEFT JOIN product p ON s.specification = p.specification AND s.product_id = p.product_id
          ${whereClause}
          GROUP BY s.product_id, s.product_name, s.specification ) t`
        ; 
    const countResult = await db.query(countQuery, values);
    const total = Number(countResult.rows[0].total);


    // --------------------------
    res.status(200).json({
      code: response.success,
      msg: "查詢成功",
      data: {
        list,
        page,
        pageSize,
        total,
        totalPages: Math.ceil(total / pageSize),
        summary
      },
    });

  } catch (error) {
    logger.error(error);
    return sendError(res, response.server_error, "伺服器錯誤，請稍後再試", 500);
  }
});
// 查詢詳細
router.post("/detail", async (req, res) => {
  const { specification, rangeType ,customRange} = req.body;
  const conditions = [];
  const values = [];
  let paramIndex = 1;
  conditions.push(`s.status != 5`);

  // 日期篩選
  let dateCondition = "";
  if (rangeType) {
    switch (rangeType) {
      case "today":
        dateCondition = `pm.paid_date::date = CURRENT_DATE`;
        break;
      case "thisWeek":
        dateCondition = `
        pm.paid_date >= date_trunc('week', CURRENT_DATE)
        AND pm.paid_date < date_trunc('week', CURRENT_DATE) + INTERVAL '1 week'
        `;
        break;
      case "thisMonth":
        dateCondition = `
        pm.paid_date >= date_trunc('month', CURRENT_DATE)
        AND pm.paid_date < date_trunc('month', CURRENT_DATE) + INTERVAL '1 month'
        `;
        break;
      case "custom":
        if (customRange?.start && customRange?.end) {
          dateCondition = `pm.paid_date BETWEEN $${paramIndex++} AND $${paramIndex++}`;
          values.push(customRange.start, customRange.end);
        }
        break;
    }
  }

  if (dateCondition) {
    conditions.push(dateCondition);
  }
  if (specification) {
    conditions.push(`s.specification = $${paramIndex++}`);
    values.push(specification);
  }

  const whereClause = conditions.length
    ? `WHERE ${conditions.join(" AND ")}`
    : "";
  try {
     const result = await db.query(
      `
      SELECT 
          s.product_id,
          s.product_name,
          s.specification,
          p.manufactor,
          p.brand,
          p.size,
          p.color,
          p.product_type1,
          p.product_type2,
          p.product_type3,
          p.product_type4,
          s.size_list,
          SUM(CASE WHEN s.status IN (0,3) THEN s.total_quantity ELSE 0 END) AS sale_quantity,
          SUM(CASE WHEN s.status = 1 THEN s.total_quantity ELSE 0 END) AS refund_quantity,
          SUM(CASE WHEN s.status = 2 THEN s.total_quantity ELSE 0 END) AS ordering_quantity,
          SUM(CASE WHEN s.status = 4 THEN s.total_quantity ELSE 0 END) AS return_order_quantity,
          SUM(CASE WHEN s.status IN (0,3) THEN (s.total_quantity * s.price) ELSE 0 END) AS sale_amount,
          SUM(CASE WHEN s.status = 1 THEN (s.total_quantity * s.price) ELSE 0 END) AS refund_amount,
          SUM(CASE WHEN s.status = 2 THEN pm.amount ELSE 0 END) AS ordering_amount,
          SUM(CASE WHEN s.status = 4 THEN pm.amount ELSE 0 END) AS return_order_amount,
          (st.cumulative_cost / NULLIF(st.cumulative_in_quantity,0)) AS average_cost

      FROM sale s
      LEFT JOIN product p 
          ON s.specification = p.specification AND s.product_id = p.product_id
      LEFT JOIN stock st
          ON s.specification = st.specification
      -- 子查詢過濾 payment，避免一筆 sale 重複 JOIN
      JOIN (
          SELECT DISTINCT ON (order_no) *
          FROM payment
          WHERE is_deleted = false
          ORDER BY order_no, paid_date DESC
      ) pm ON s.order_no = pm.order_no
      ${whereClause}
      GROUP BY 
          s.product_id,
          s.product_name,
          s.specification,
          p.manufactor,
          p.brand,
          p.size,
          p.color,
          p.product_type1,
          p.product_type2,
          p.product_type3,
          p.product_type4,
          s.size_list,
          st.cumulative_cost,
          st.cumulative_in_quantity
      `,
      [...values]
    );

    const summary = result.rows[0];
    res.status(201).json({
      code: response.success,
      msg: "查詢成功",
      data: {
        list:summary
      },
    });
  } catch (error) {
    logger.error(error);
    return sendError(res, response.server_error, "伺服器錯誤，請稍後再試", 500);
  }
});
// 查詢排名
router.post("/top_list", async (req, res) => {
  const { filter, rangeType, customRange } = req.body;

  try {
    const values = [];
    let paramIndex = 1;

    // --------------------------
    // 組條件
    const conditions = [`s.status != 5`]; // 排除取消

    if (filter?.product_id) {
      conditions.push(`s.product_id ILIKE $${paramIndex++}`);
      values.push(`%${filter.product_id}%`);
    }
    if (filter?.specification) {
      conditions.push(`s.specification ILIKE $${paramIndex++}`);
      values.push(`%${filter.specification}%`);
    }
    if (filter?.product_name) {
      conditions.push(`s.product_name ILIKE $${paramIndex++}`);
      values.push(`%${filter.product_name}%`);
    }

    // 日期篩選：依 payment.paid_date
    if (rangeType) {
      switch (rangeType) {
        case "today":
          conditions.push(`pg.first_paid_date::date = CURRENT_DATE`);
          break;
        case "7days":
          conditions.push(`pg.first_paid_date >= CURRENT_DATE - INTERVAL '7 days'`);
          break;
        case "1month":
          conditions.push(`pg.first_paid_date >= CURRENT_DATE - INTERVAL '1 month'`);
          break;
        case "custom":
          if (customRange?.start && customRange?.end) {
            conditions.push(`pg.first_paid_date BETWEEN $${paramIndex++} AND $${paramIndex++}`);
            values.push(customRange.start, customRange.end);
          }
          break;
      }
    }

    const whereClause = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";

    // --------------------------
    // Top 10 查詢
    const topQuery = `
      WITH payment_grouped AS (
        SELECT
          order_no,
          MIN(paid_date) AS first_paid_date,
          SUM(CASE WHEN type = 0 THEN amount ELSE 0 END) AS sale_amount,
          SUM(CASE WHEN type = 1 THEN amount ELSE 0 END) AS refund_amount,
          SUM(CASE WHEN type = 2 THEN amount ELSE 0 END) AS order_amount,
          SUM(CASE WHEN type = 3 THEN amount ELSE 0 END) AS pickup_amount,
          SUM(CASE WHEN type = 4 THEN amount ELSE 0 END) AS return_order_amount
        FROM payment
        WHERE is_deleted = false
        GROUP BY order_no
      )
      SELECT
        s.product_id,
        s.specification,
        p.brand,
        p.color,
        p.product_type1,
        p.product_type2,
        p.product_type3,
        p.product_type4,
        st.cumulative_cost/st.cumulative_in_quantity AS average_cost,

        -- 數量
        SUM(CASE WHEN s.status IN (0,3) THEN s.total_quantity ELSE 0 END) AS sale_quantity,
        SUM(CASE WHEN s.status = 1 THEN s.total_quantity ELSE 0 END) AS refund_quantity,
        SUM(CASE WHEN s.status = 2 THEN s.total_quantity ELSE 0 END) AS ordering_quantity,
        SUM(CASE WHEN s.status = 4 THEN s.total_quantity ELSE 0 END) AS return_order_quantity,

        -- 金額
        SUM(
          CASE 
            WHEN s.status IN (0,3) THEN pg.sale_amount + pg.pickup_amount + pg.order_amount
            ELSE 0
          END
        ) AS sale_amount,
        SUM(pg.refund_amount) AS refund_amount,
        SUM(CASE WHEN s.status = 2 THEN pg.order_amount ELSE 0 END) AS order_amount,
        SUM(pg.return_order_amount) AS return_order_amount

      FROM sale s
      LEFT JOIN payment_grouped pg ON pg.order_no = s.order_no
      LEFT JOIN product p ON s.specification = p.specification AND s.product_id = p.product_id
      LEFT JOIN stock st ON st.product_id = s.product_id AND st.specification = s.specification
      ${whereClause}
      GROUP BY s.product_id, s.specification,p.brand,p.color,p.product_type1,p.product_type2,p.product_type3,p.product_type4, st.cumulative_cost, st.cumulative_in_quantity
      ORDER BY 
      sale_quantity DESC NULLS LAST,
      sale_amount DESC NULLS LAST
      LIMIT 10
    `;

    const topResult = await db.query(topQuery, values);
    const topList = topResult.rows;

    res.status(200).json({
      code: response.success,
      msg: "查詢成功",
      data: {
        list: topList
      }
    });

  } catch (error) {
    logger.error(error);
    return sendError(res, response.server_error, "伺服器錯誤，請稍後再試", 500);
  }
});

// 查詢廠商進貨列表
router.post("/restock_list", async (req, res) => {
  const { page, pageSize, filter, sort = "ASC", selectedDate } = req.body;
  const offset = (page - 1) * pageSize;

  if (page < 1 || pageSize < 1) {
    return sendError(res, response.invalid_pageInfo, "錯誤的分頁資訊");
  }

  const conditions = ["r.is_deleted = false"];
  const values = [];
  let idx = 1;

  // 廠商搜尋
  if (filter?.manufactor) {
    conditions.push(`r.manufactor ILIKE $${idx++}`);
    values.push(`%${filter.manufactor}%`);
  }
  // 月份搜尋
  if (selectedDate) {
    const startDate = `${selectedDate}-01`;
    conditions.push(`
      r.date >= $${idx}::date 
      AND r.date < ($${idx}::date + interval '1 month')
    `);
    values.push(startDate);
    idx++;
  }

  const whereClause = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";

  try {
    const listResult = 
      await db.query(
      `
      SELECT 
        r.manufactor,
        m.manufactor_name,
        (
          SELECT COALESCE(SUM(sh.total_quantity), 0)
          FROM stock_history sh
          WHERE sh.change_type = 10
          AND sh.change_number IN (
            SELECT restock_id FROM restock 
            WHERE manufactor = r.manufactor
            AND is_deleted = false
              ${selectedDate ? `AND date >= $${idx - 1}::date AND date < ($${idx - 1}::date + interval '1 month')` : ""}
          )
        ) AS total_in_quantity,
        (
          SELECT COALESCE(SUM(sh.total_quantity * sh.price), 0)
          FROM stock_history sh
          WHERE sh.change_type = 10
          AND sh.change_number IN (
            SELECT restock_id FROM restock 
            WHERE manufactor = r.manufactor
            AND is_deleted = false
              ${selectedDate ? `AND date >= $${idx - 1}::date AND date < ($${idx - 1}::date + interval '1 month')` : ""}
          )
        ) AS total_in_price,
        (
          SELECT COALESCE(SUM(sh.total_quantity), 0)
          FROM stock_history sh
          WHERE sh.change_type = 12
          AND sh.change_number IN (
            SELECT restock_id FROM restock 
            WHERE manufactor = r.manufactor
            AND is_deleted = false
              ${selectedDate ? `AND date >= $${idx - 1}::date AND date < ($${idx - 1}::date + interval '1 month')` : ""}
          )
        ) AS total_return_quantity,
        (
          SELECT COALESCE(SUM(sh.total_quantity * sh.price), 0)
          FROM stock_history sh
          WHERE sh.change_type = 12
          AND sh.change_number IN (
            SELECT restock_id FROM restock 
            WHERE manufactor = r.manufactor
            AND is_deleted = false
              ${selectedDate ? `AND date >= $${idx - 1}::date AND date < ($${idx - 1}::date + interval '1 month')` : ""}
          )
        ) AS total_return_price
      FROM restock r
      LEFT JOIN manufactor m ON r.manufactor = m.manufactor_id
      ${whereClause}
      GROUP BY r.manufactor, m.manufactor_name
      ORDER BY r.manufactor ${sort}
      LIMIT $${idx++} OFFSET $${idx++}
    `,
      [...values, pageSize, offset]
    )
    const list =listResult.rows

    // 總筆數
    const totalResult = await db.query(
      `
      SELECT COUNT(*) AS total
      FROM (
        SELECT r.manufactor
        FROM restock r
        ${whereClause}
        GROUP BY r.manufactor
      ) t
      `,
      values
    );
    const total = totalResult.rows[0].total;

    // summary
    const summaryResult = await db.query(
  `
  SELECT 
    -- 全部進貨數量
    (
      SELECT COALESCE(SUM(sh.total_quantity), 0)
      FROM stock_history sh
      WHERE sh.change_type = 10
        AND sh.change_number IN (
          SELECT restock_id FROM restock r
          ${whereClause.replace("r.", "")}
        )
    ) AS total_in_quantity,

    -- 全部進貨金額
    (
      SELECT COALESCE(SUM(sh.total_quantity * sh.price), 0)
      FROM stock_history sh
      WHERE sh.change_type = 10
        AND sh.change_number IN (
          SELECT restock_id FROM restock r
          ${whereClause.replace("r.", "")}
        )
    ) AS total_in_price,

    -- 全部退貨數量
    (
      SELECT COALESCE(SUM(sh.total_quantity), 0)
      FROM stock_history sh
      WHERE sh.change_type = 12
        AND sh.change_number IN (
          SELECT restock_id FROM restock r
          ${whereClause.replace("r.", "")}
        )
    ) AS total_return_quantity,

    -- 全部退貨金額
    (
      SELECT COALESCE(SUM(sh.total_quantity * sh.price), 0)
      FROM stock_history sh
      WHERE sh.change_type = 12
        AND sh.change_number IN (
          SELECT restock_id FROM restock r
          ${whereClause.replace("r.", "")}
        )
    ) AS total_return_price
  `,
  values
);

    const summary = summaryResult.rows[0];

    res.status(201).json({
      code: response.success,
      msg: "查詢成功",
      data: { list, total, summary, page, pageSize, totalPages: Math.ceil(total / pageSize) },
    });
  } catch (err) {
    logger.error(err);
    return sendError(res, response.server_error, "伺服器錯誤，請稍後再試");
  }
});
// 查詢廠商進貨明細
router.post("/restock_detail", async (req, res) => {
  const { manufactor, selectedDate, page = 1, pageSize = 10 } = req.body;

  if (page < 1 || pageSize < 1) {
    logger.warn("錯誤的分頁資訊");
    return sendError(res, response.invalid_pageInfo, "錯誤的分頁資訊");
  }

  const offset = (page - 1) * pageSize;
  const conditions = [];
  const values = [];
  let paramIndex = 1;

  // 基本條件
  conditions.push(`r.is_deleted = false`);

  if (selectedDate) {
    const startDate = `${selectedDate}-01`;
    conditions.push(`
      r.date >= $${paramIndex++}::date
      AND r.date < ($${paramIndex++}::date + interval '1 month')
    `);
    values.push(startDate, startDate);
  }

  if (manufactor) {
    conditions.push(`r.manufactor = $${paramIndex++}`);
    values.push(manufactor);
  }

  const whereClause = conditions.length
    ? `WHERE ${conditions.join(" AND ")}`
    : "";

  try {
    const result = await db.query(
      `
      SELECT 
        r.restock_id,
        r.create_date,
        r.date,
        r.manufactor,
        m.manufactor_name,

        -- 進貨總數量
        (
          SELECT COALESCE(SUM(sh.total_quantity), 0)
          FROM stock_history sh
          WHERE sh.change_number = r.restock_id
          AND sh.change_type = 10
        ) AS total_in_quantity,

        -- 進貨總金額
        (
          SELECT COALESCE(SUM(sh.total_quantity * sh.price), 0)
          FROM stock_history sh
          WHERE sh.change_number = r.restock_id
          AND sh.change_type = 10
        ) AS total_in_price,

        -- 退貨總數量
        (
          SELECT COALESCE(SUM(sh.total_quantity), 0)
          FROM stock_history sh
          WHERE sh.change_number = r.restock_id
          AND sh.change_type = 12
        ) AS total_return_quantity,

        -- 退貨總金額
        (
          SELECT COALESCE(SUM(sh.total_quantity * sh.price), 0)
          FROM stock_history sh
          WHERE sh.change_number = r.restock_id
          AND sh.change_type = 12
        ) AS total_return_price

      FROM restock r
      LEFT JOIN manufactor m ON r.manufactor = m.manufactor_id
      ${whereClause}
      ORDER BY r.create_date DESC
      LIMIT $${paramIndex++} OFFSET $${paramIndex++}
      `,
      [...values, pageSize, offset]
    );

    const list = result.rows;

    const countResult = await db.query(
      `
      SELECT COUNT(*) AS total
      FROM restock r
      ${whereClause}
      `,
      values
    );

    const total = Number(countResult.rows[0].total);
    const totalPages = Math.ceil(total / pageSize);

    res.status(201).json({
      code: response.success,
      msg: "查詢成功",
      data: {
        list,
        total,
        page,
        pageSize,
        totalPages
      },
    });
  } catch (error) {
    logger.error(error);
    return sendError(res, response.server_error, "伺服器錯誤，請稍後再試", 500);
  }
});

// 查詢廠商銷貨列表
router.post("/sale_list", async (req, res) => {
  const { page, pageSize, filter, sort, selectedDate} = req.body;
  const offset = (page - 1) * pageSize;
  if (page < 1 || pageSize < 1) {
    logger.warn("錯誤的分頁資訊");
    return sendError(res, response.invalid_pageInfo, "錯誤的分頁資訊");
  }
  const conditions = [];
  const values = [];
  let paramIndex = 1;

  if (filter) {
      // ILIKE不區分大小寫
      // %value%部分相符比對
      if (filter.manufactor) {
        conditions.push(`p.manufactor ILIKE $${paramIndex++}`);
        values.push(`%${filter.manufactor}%`);
      }
      if (filter.manufactor_name) {
        conditions.push(`m.manufactor_name ILIKE $${paramIndex++}`);
        values.push(`%${filter.manufactor_name}%`);
      }
    }
   if (selectedDate) {
    const startDate = `${selectedDate}-01`;
    conditions.push(`
      pm.paid_date >= $${paramIndex++}::date 
      AND pm.paid_date < ($${paramIndex++}::date + interval '1 month')
    `);
    values.push(startDate, startDate);
  }
  const whereClause = conditions.length
    ? `WHERE ${conditions.join(" AND ")}`
    : "";
  try {
      const result = await db.query(
      `
      SELECT 
          p.manufactor,
          m.manufactor_name,

          -- 銷貨數量 (0,3 加；1 減)
          SUM(
            CASE 
              WHEN pm.type IN (0, 3) THEN s.total_quantity     -- 銷貨 & 取貨
              WHEN pm.type = 1 THEN -s.total_quantity          -- 退貨
              ELSE 0
            END
          ) AS sale_quantity,

          -- 銷貨金額
          SUM(
            CASE 
              WHEN pm.type IN (0, 3) THEN (s.total_quantity * s.price)
              WHEN pm.type = 1 THEN -(s.total_quantity * s.price)
              ELSE 0
            END
          ) AS sale_amount,

          -- 訂貨數量 (2 加；4 減)
          SUM(
            CASE
              WHEN s.status = 2 THEN s.total_quantity           -- 訂貨
              WHEN s.status = 4 THEN -s.total_quantity          -- 退訂
              ELSE 0
            END
          ) AS order_quantity,

          -- 訂貨金額
          SUM(
            CASE
              WHEN s.status = 2 THEN pm.amount
              WHEN s.status = 4 THEN -pm.amount
              ELSE 0
            END
          ) AS order_amount

      FROM sale s
      JOIN product p ON s.specification = p.specification
      JOIN manufactor m ON p.manufactor = m.manufactor_id
      JOIN payment pm ON s.order_no = pm.order_no
      ${whereClause}
      AND pm.is_deleted = false
      GROUP BY p.manufactor, m.manufactor_name
      ORDER BY p.manufactor ${sort}
      LIMIT $${paramIndex++} OFFSET $${paramIndex++}
      `,
      [...values, pageSize, offset]
    );

    const list = result.rows;
    // 查詢總筆數
     const countResult = await db.query(
      `
      SELECT COUNT(*) AS total
        FROM (
          SELECT 1
          FROM sale s
          JOIN product p ON s.specification = p.specification
          JOIN payment pm ON s.order_no = pm.order_no
          ${whereClause}
          AND pm.is_deleted = false
          GROUP BY p.manufactor
        ) AS grouped
      `,
      values
    );
    const total = countResult.rows[0].total;

    const summaryResult = await db.query(
      `
     SELECT 
        -- 銷貨數量
        COALESCE(SUM(
          CASE 
            WHEN pm.type IN (0,3) THEN s.total_quantity
            WHEN pm.type = 1 THEN -s.total_quantity
            ELSE 0
          END
        ), 0) AS total_sale_volume,

        -- 銷貨總額
        COALESCE(SUM(
          CASE 
            WHEN pm.type IN (0,3) THEN (s.total_quantity * s.price)
            WHEN pm.type = 1 THEN -(s.total_quantity * s.price)
            ELSE 0
          END
        ), 0) AS total_sale_amount,

        -- 訂貨數量
        COALESCE(SUM(
          CASE 
            WHEN s.status = 2 THEN s.total_quantity
            WHEN s.status = 4 THEN -s.total_quantity
            ELSE 0
          END
        ), 0) AS total_order_volume,

        -- 訂貨總額
        COALESCE(SUM(
          CASE 
            WHEN s.status = 2 THEN pm.amount
            WHEN s.status = 4 THEN -pm.amount
            ELSE 0
          END
        ), 0) AS total_order_amount

      FROM sale s
      JOIN product p ON s.specification = p.specification
      JOIN payment pm ON s.order_no = pm.order_no
      ${whereClause}
      AND pm.is_deleted = false
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
        summary,
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
// 查詢廠商銷貨明細
router.post("/sale_detail", async (req, res) => {
  const { manufactor, selectedDate, page, pageSize } = req.body;

  const conditions = [];
  const values = [];
  let paramIndex = 1;

  conditions.push(`pm.is_deleted = false`);

  if (selectedDate) {
    const startDate = `${selectedDate}-01`;
    conditions.push(`
      pm.paid_date >= $${paramIndex++}::date 
      AND pm.paid_date < ($${paramIndex++}::date + interval '1 month')
    `);
    values.push(startDate, startDate);
  }

  if (manufactor) {
    conditions.push(`m.manufactor_id = $${paramIndex++}`);
    values.push(manufactor);
  }

  const whereClause = conditions.length
    ? `WHERE ${conditions.join(" AND ")}`
    : "";

  const offset = (page - 1) * pageSize;

  try {
    const listResult = await db.query(
      `
      SELECT 
          s.order_no,
          s.specification,
          s.product_id,
          s.total_quantity,
          pm.type,
          pm.amount,
          pm.paid_date,
          pm.paid_at
      FROM sale s
      LEFT JOIN product p 
          ON s.specification = p.specification 
         AND s.product_id = p.product_id
      LEFT JOIN manufactor m 
          ON p.manufactor = m.manufactor_id
      JOIN payment pm 
          ON s.order_no = pm.order_no
      ${whereClause}
      ORDER BY pm.paid_at DESC
      LIMIT $${paramIndex++} OFFSET $${paramIndex++}
      `,
      [...values, pageSize, offset]
    );

    const list = listResult.rows;

    const countResult = await db.query(
      `
      SELECT COUNT(*) AS total
      FROM sale s
      LEFT JOIN product p 
          ON s.specification = p.specification 
         AND s.product_id = p.product_id
      LEFT JOIN manufactor m 
          ON p.manufactor = m.manufactor_id
      JOIN payment pm 
          ON s.order_no = pm.order_no
      ${whereClause}
      `,
      values
    );

    const total = Number(countResult.rows[0].total);
    const totalPages = Math.ceil(total / pageSize);

    res.status(201).json({
      code: response.success,
      msg: "查詢成功",
      data: {
        list,
        total,
        page,
        pageSize,
        totalPages,
      },
    });
  } catch (error) {
    logger.error(error);
    return sendError(res, response.server_error, "伺服器錯誤，請稍後再試", 500);
  }
});
module.exports = router;