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
// 查詢列表
router.post("/list", async (req, res) => {
  const { page, pageSize, filter, sort, rangeType, customRange } = req.body;
  const offset = (page - 1) * pageSize;

  if (page < 1 || pageSize < 1) {
    logger.warn("錯誤的分頁資訊");
    return sendError(res, response.invalid_pageInfo, "錯誤的分頁資訊");
  }

  const saleFilter = [];
  const paymentFilter = [];
  const values = [];
  let paramIndex = 1;

  // --------------------------
  // sale 篩選
  if (filter) {
    if (filter.product_id) {
      saleFilter.push(`s.product_id ILIKE $${paramIndex++}`);
      values.push(`%${filter.product_id}%`);
    }
    if (filter.specification) {
      saleFilter.push(`s.specification ILIKE $${paramIndex++}`);
      values.push(`%${filter.specification}%`);
    }
    if (filter.product_name) {
      saleFilter.push(`s.product_name ILIKE $${paramIndex++}`);
      values.push(`%${filter.product_name}%`);
    }
  }

  // payment 日期篩選
  if (rangeType) {
    switch (rangeType) {
      case "today":
        paymentFilter.push(`pm.paid_at::date = CURRENT_DATE`);
        break;
      case "7days":
        paymentFilter.push(`pm.paid_at >= CURRENT_DATE - INTERVAL '7 days'`);
        break;
      case "1month":
        paymentFilter.push(`pm.paid_at >= CURRENT_DATE - INTERVAL '1 month'`);
        break;
      case "custom":
        if (customRange?.start && customRange?.end) {
          paymentFilter.push(`pm.paid_at BETWEEN $${paramIndex++} AND $${paramIndex++}`);
          values.push(customRange.start, customRange.end);
        }
        break;
    }
  }

  const saleWhere = saleFilter.length ? `AND ${saleFilter.join(" AND ")}` : "";
  const paymentWhere = paymentFilter.length ? `AND ${paymentFilter.join(" AND ")}` : "";

  try {
    // --------------------------
    // 1️⃣ list 查詢
    const listResult = await db.query(
      `
      WITH payment_grouped AS (
        SELECT
          order_no,
          SUM(CASE WHEN type='訂貨' THEN amount ELSE 0 END) AS prepaid_amount,
          SUM(CASE WHEN type='收貨' THEN amount ELSE 0 END) AS remaining_amount,
          SUM(CASE WHEN type='銷貨' THEN amount ELSE 0 END) AS paid_amount,
          SUM(amount) AS total_amount
        FROM payment pm
        WHERE is_deleted = false
        ${paymentWhere}
        GROUP BY order_no
      ),
      sale_summary AS (
        SELECT
          s.product_id,
          s.product_name,
          s.specification,
          SUM(CASE WHEN s.status='訂貨' THEN s.total_quantity ELSE 0 END) AS order_quantity,
          SUM(CASE WHEN s.status IN ('收貨','銷貨') THEN s.total_quantity ELSE 0 END) AS total_quantity,
          SUM(CASE WHEN s.status IN ('收貨','銷貨') THEN s.total_quantity * p.average_cost ELSE 0 END) AS total_cost,
          SUM(COALESCE(pg.prepaid_amount,0)) AS prepaid_amount,
          SUM(COALESCE(pg.remaining_amount,0)) AS remaining_amount,
          SUM(COALESCE(pg.paid_amount,0)) AS paid_amount,
          SUM(COALESCE(pg.total_amount,0)) AS total_amount
        FROM sale s
        LEFT JOIN payment_grouped pg ON s.order_no = pg.order_no
        JOIN product p ON s.product_id = p.product_id AND s.specification = p.specification
        WHERE s.status != '取消'
        ${saleWhere}
        GROUP BY s.product_id, s.product_name, s.specification, p.average_cost
      )
      SELECT *
      FROM sale_summary
      ORDER BY product_id ${sort || "ASC"}
      LIMIT $${paramIndex++} OFFSET $${paramIndex++};
      `,
      [...values, pageSize, offset]
    );

    const list = listResult.rows;

    // --------------------------
    // 2️⃣ 總筆數
    const countResult = await db.query(
      `
      SELECT COUNT(*) AS total
      FROM (
        SELECT 1
        FROM sale s
        WHERE s.status != '取消'
        ${saleWhere}
        GROUP BY s.product_id, s.product_name, s.specification
      ) t;
      `,
      values
    );
    const total = countResult.rows[0].total;

    // --------------------------
    // 3️⃣ summary 統計
    const summaryResult = await db.query(
      `
      WITH payment_grouped AS (
        SELECT
          order_no,
          SUM(CASE WHEN type='訂貨' THEN amount ELSE 0 END) AS prepaid_amount,
          SUM(CASE WHEN type='收貨' THEN amount ELSE 0 END) AS remaining_amount,
          SUM(CASE WHEN type='銷貨' THEN amount ELSE 0 END) AS paid_amount
        FROM payment pm
        WHERE is_deleted = false
        ${paymentWhere}
        GROUP BY order_no
      )
      SELECT
        COALESCE(SUM(CASE WHEN s.status='銷貨' THEN s.total_quantity ELSE 0 END),0) AS total_paid_quantity,
        COALESCE(SUM(CASE WHEN s.status='訂貨' THEN s.total_quantity ELSE 0 END),0) AS total_order_quantity,
        COALESCE(SUM(CASE WHEN s.status='收貨' THEN s.total_quantity ELSE 0 END),0) AS total_pickup_quantity,
        COALESCE(SUM(pg.prepaid_amount),0) AS total_prepaid,
        COALESCE(SUM(pg.remaining_amount),0) AS total_remaining,
        COALESCE(SUM(pg.paid_amount),0) AS total_paid,
        COALESCE(SUM(s.handing_fee),0) AS total_handing_fee,
        COALESCE(SUM(CASE WHEN s.status IN ('收貨','銷貨') THEN s.total_quantity * p.average_cost ELSE 0 END),0) AS total_cost,
        COALESCE(SUM(CASE WHEN s.status IN ('收貨','銷貨') THEN s.total_quantity * s.price ELSE 0 END),0)
        -
        COALESCE(SUM(CASE WHEN s.status IN ('收貨','銷貨') THEN s.total_quantity * p.average_cost ELSE 0 END),0) AS total_profit
      FROM sale s
      LEFT JOIN payment_grouped pg ON s.order_no = pg.order_no
      JOIN product p ON s.product_id = p.product_id AND s.specification = p.specification
      WHERE s.status != '取消'
      ${saleWhere};
      `,
      values
    );

    const summary = summaryResult.rows[0];

    res.status(200).json({
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


// 查詢詳細
router.post("/detail", async (req, res) => {
  const { specification, rangeType ,customRange} = req.body;
  const conditions = [];
  const values = [];
  let paramIndex = 1;
  conditions.push(`is_deleted = false`);

  // 日期篩選
  let dateCondition = "";
  if (rangeType) {
    switch (rangeType) {
      case "today":
        dateCondition = `s.create_date::date = CURRENT_DATE`;
        break;
      case "thisWeek":
        dateCondition = `
        s.create_date >= date_trunc('week', CURRENT_DATE)
        AND s.create_date < date_trunc('week', CURRENT_DATE) + INTERVAL '1 week'
        `;
        break;
      case "thisMonth":
        dateCondition = `
        s.create_date >= date_trunc('month', CURRENT_DATE)
        AND s.create_date < date_trunc('month', CURRENT_DATE) + INTERVAL '1 month'
        `;
        break;
      case "custom":
        if (customRange?.start && customRange?.end) {
          dateCondition = `s.create_date BETWEEN $${paramIndex++} AND $${paramIndex++}`;
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
          SUM(s.handing_fee) AS handing_fee,
          SUM(s.total_quantity) AS total_quantity,
          SUM(s.total_quantity * s.price) AS total_sales,
          SUM(s.total_quantity * p.average_cost) AS total_cost,
          SUM(s.total_quantity * (s.price - COALESCE(p.average_cost, 0))) AS total_profit
      FROM sale s
      LEFT JOIN product p ON s.specification = p.specification
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
      s.size_list
      `,
      [...values]
    );
    const sizeResult = await db.query(
    `
      SELECT 
        (elem->>'size') AS size,
        SUM(COALESCE(NULLIF(elem->>'quantity', '')::int, 0)) AS total_quantity
      FROM sale s,
      LATERAL jsonb_array_elements(s.quantities::jsonb) AS elem
      ${whereClause}
      GROUP BY (elem->>'size')
      ORDER BY (elem->>'size')::numeric
    `,
    [...values]
    );

    const summary = result.rows[0];
    const sizes = sizeResult.rows
    res.status(201).json({
      code: response.success,
      msg: "查詢成功",
      data: {
        list:{
            ...summary,
            sizes
        }
      },
    });
  } catch (error) {
    logger.error(error);
    return sendError(res, response.server_error, "伺服器錯誤，請稍後再試", 500);
  }
});
// 查詢排名
router.post("/rank_list", async (req, res) => {
  const { rangeType ,customRange} = req.body;

  const conditions = [];
  const values = [];
  let paramIndex = 1;
  conditions.push(`is_deleted = false`);

  // 日期篩選
  let dateCondition = "";
  if (rangeType) {
    switch (rangeType) {
      case "today":
        dateCondition = `s.create_date::date = CURRENT_DATE`;
        break;
      case "7days":
        dateCondition = `s.create_date >= CURRENT_DATE - INTERVAL '7 days'`;
        break;
      case "1month":
        dateCondition = `s.create_date >= CURRENT_DATE - INTERVAL '1 month'`;
        break;
      case "custom":
        if (customRange?.start && customRange?.end) {
          dateCondition = `s.create_date BETWEEN $${paramIndex++} AND $${paramIndex++}`;
          values.push(customRange.start, customRange.end);
        }
        break;
    }
  }

  if (dateCondition) {
    conditions.push(dateCondition);
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
        p.brand,
        p.color,
        p.product_type1,
        p.product_type2,
        p.product_type3,
        p.product_type4,
        SUM(s.total_quantity) AS total_quantity,
        SUM(s.total_quantity * s.price) AS total_sales,
        SUM(s.total_quantity * (s.price - COALESCE(p.average_cost, 0))) AS total_profit
      FROM sale s
      LEFT JOIN product p ON s.specification = p.specification
      ${whereClause}
      GROUP BY 
      s.product_id,
      s.product_name,
      s.specification,
      p.brand,
      p.color,
      p.product_type1,
      p.product_type2,
      p.product_type3,
      p.product_type4
      ORDER BY SUM(s.total_quantity) DESC
      LIMIT 10
      `,
      values
    );

    const list = result.rows;
    res.status(201).json({
      code: response.success,
      msg: "查詢成功",
      data: {
        list
      },
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
  const { manufactor, selectedDate } = req.body;
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
        -- 褪貨總金額
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
      `,
      values
    );

    const summary = result.rows;
    res.status(201).json({
      code: response.success,
      msg: "查詢成功",
      data: {
        list: summary
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
  conditions.push(`s.is_deleted = false`);

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
      s.create_date >= $${paramIndex++}::date 
      AND s.create_date < ($${paramIndex++}::date + interval '1 month')
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
          SUM(s.total_quantity) AS total_quantity,
          SUM(s.total_quantity * s.price) AS total_price
      FROM sale s
      LEFT JOIN product p ON s.specification = p.specification
      LEFT JOIN manufactor m ON p.manufactor = m.manufactor_id
      ${whereClause}
      GROUP BY p.manufactor,m.manufactor_name
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
        LEFT JOIN product p ON s.specification = p.specification
        ${whereClause}
        GROUP BY p.manufactor
      ) AS grouped
      `,
      values
    );
    const total = countResult.rows[0].total;

    const summaryResult = await db.query(
      `
      SELECT 
          COALESCE(SUM(s.total_quantity), 0) AS total_sale_volume,
          COALESCE(SUM(s.total_quantity * s.price), 0) AS total_sale_amount
      FROM sale s
      LEFT JOIN product p ON s.specification = p.specification
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
  const { manufactor ,selectedDate} = req.body;
  const conditions = [];
  const values = [];
  let paramIndex = 1;
  conditions.push(`is_deleted = false`);
  if (selectedDate) {
    const startDate = `${selectedDate}-01`;
    conditions.push(`
      s.create_date >= $${paramIndex++}::date 
      AND s.create_date < ($${paramIndex++}::date + interval '1 month')
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
  try {
     const result = await db.query(
      `
      SELECT 
          s.sale_id,
          s.create_date,
          s.price,
          s.total_quantity,
          (s.total_quantity * s.price) AS total_price
      FROM sale s
      LEFT JOIN product p ON s.specification = p.specification
      LEFT JOIN manufactor m ON p.manufactor = m.manufactor_id
      ${whereClause}
      ORDER BY s.create_date DESC
      `,
      values
    );

    const summary = result.rows;
    res.status(201).json({
      code: response.success,
      msg: "查詢成功",
      data: {
        list: summary
      },
    });
  } catch (error) {
    logger.error(error);
    return sendError(res, response.server_error, "伺服器錯誤，請稍後再試", 500);
  }
});
module.exports = router;