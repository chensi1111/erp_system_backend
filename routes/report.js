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
  const { page, pageSize, filter, sort, rangeType ,customRange} = req.body;
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
      if (filter.product_id) {
        conditions.push(`s.product_id ILIKE $${paramIndex++}`);
        values.push(`%${filter.product_id}%`);
      }
      if (filter.specification) {
        conditions.push(`s.specification ILIKE $${paramIndex++}`);
        values.push(`%${filter.specification}%`);
      }
      if (filter.product_name) {
        conditions.push(`s.product_name ILIKE $${paramIndex++}`);
        values.push(`%${filter.product_name}%`);
      }
    }
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
          SUM(s.total_quantity) AS total_quantity,
          SUM(s.total_quantity * s.price) AS total_sales,
          SUM(s.total_quantity * (s.price - COALESCE(p.average_cost, 0))) AS total_profit
      FROM sale s
      LEFT JOIN product p ON s.specification = p.specification
      ${whereClause}
      GROUP BY s.product_id, s.product_name, s.specification
      ORDER BY s.product_id ${sort}
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
        GROUP BY s.product_id, s.product_name, s.specification
      ) AS grouped
      `,
      values
    );
    const total = countResult.rows[0].total;

    const summaryResult = await db.query(
      `
      SELECT 
          COALESCE(SUM(s.handing_fee), 0) AS total_fee,
          COALESCE(SUM(s.total_quantity), 0) AS total_sales_volume,
          COALESCE(SUM(s.total_quantity * s.price), 0) AS total_sales_amount,
          COALESCE(SUM(s.total_quantity * (COALESCE(p.average_cost, 0))), 0) AS total_cost,
          COALESCE(SUM(s.total_quantity * (s.price - COALESCE(p.average_cost, 0))), 0) AS total_profit
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
  const { page, pageSize, filter, sort, selectedDate} = req.body;
  const offset = (page - 1) * pageSize;
  if (page < 1 || pageSize < 1) {
    logger.warn("錯誤的分頁資訊");
    return sendError(res, response.invalid_pageInfo, "錯誤的分頁資訊");
  }
  const conditions = [];
  const values = [];
  let paramIndex = 1;
  conditions.push(`r.is_deleted = false`);

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
      r.create_date >= $${paramIndex++}::date 
      AND r.create_date < ($${paramIndex++}::date + interval '1 month')
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
          SUM(r.total_quantity) AS total_quantity,
          SUM(r.total_quantity * r.price) AS total_restock
      FROM restock r
      LEFT JOIN product p ON r.specification = p.specification
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
        FROM restock r
        LEFT JOIN product p ON r.specification = p.specification
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
          COALESCE(SUM(r.total_quantity), 0) AS total_restock_volume,
          COALESCE(SUM(r.total_quantity * r.price), 0) AS total_restock_amount
      FROM restock r
      LEFT JOIN product p ON r.specification = p.specification
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
// 查詢廠商進貨明細
router.post("/restock_detail", async (req, res) => {
  const { manufactor ,selectedDate} = req.body;
  const conditions = [];
  const values = [];
  let paramIndex = 1;
  conditions.push(`is_deleted = false`);
  if (selectedDate) {
    const startDate = `${selectedDate}-01`;
    conditions.push(`
      r.create_date >= $${paramIndex++}::date 
      AND r.create_date < ($${paramIndex++}::date + interval '1 month')
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
          r.restock_id,
          r.create_date,
          r.price,
          r.total_quantity,
          (r.total_quantity * r.price) AS total_price
      FROM restock r
      LEFT JOIN product p ON r.specification = p.specification
      LEFT JOIN manufactor m ON p.manufactor = m.manufactor_id
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