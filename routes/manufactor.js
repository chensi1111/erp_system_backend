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
const taipeiTime = dayjs().tz('Asia/Taipei').format('YYYY-MM-DD HH:mm:ss');

function sendError(res, code, msg, status = 400) {
  return res.status(status).json({ code, msg });
}

// 新增
router.post("/create", async (req, res) => {
    let { manufactor_id, unified_number, manufactor_name, contact_person, phone, email, tax_rate, discount, ticket_period, remark} = req.body;
    if(!manufactor_id || !manufactor_name){
      logger.warn("缺少必要資料")
      return sendError(res, response.missing_info, '缺少必要資料');
    }
    if (!/^\d{1,5}$/.test(manufactor_id)) {
      logger.warn("編號格式錯誤")
      return sendError(res, response.invalid_id, '編號格式錯誤，必須為1~5位數字');
    }
    if (unified_number && !/^\d{8}$/.test(unified_number)) {
      logger.warn("統一編號格式錯誤")
      return sendError(res, response.invalid_unified_number, '統一編號格式錯誤，必須為8位數字');
    }
    if(manufactor_name.length > 20){
      logger.warn("廠商名稱長度超過限制")
      return sendError(res, response.invalid_name, '廠商名稱長度超過限制');
    }
    if(contact_person && contact_person.length > 10){
      logger.warn("聯絡人長度超過限制")
      return sendError(res, response.invalid_contact, '聯絡人長度超過限制');
    }
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (email &&　!emailRegex.test(email)) {
      logger.warn("Email格式錯誤")
      return sendError(res, response.invalid_email, "Email格式錯誤");
    }
    const phoneRegex = /^(09\d{8}|0\d{1,3}-?\d{6,8})$/;
    if (phone && !phoneRegex.test(phone)) {
      logger.warn("電話號碼格式錯誤")
      return sendError(res, response.invalid_phone, "電話號碼格式錯誤");
    }
    if(tax_rate && (tax_rate < 0 || !Number.isFinite(tax_rate))){
      logger.warn("稅率格式錯誤")
      return sendError(res, response.invalid_tax_rate, "稅率格式錯誤");
    }
    if(discount && (discount < 0|| !Number.isFinite(discount))){
      logger.warn("折扣格式錯誤")
      return sendError(res, response.invalid_discount, "折扣格式錯誤");
    }
    if(ticket_period && (ticket_period < 0|| !Number.isFinite(ticket_period))){
      logger.warn("票據期限格式錯誤")
      return sendError(res, response.invalid_ticket_period, "票據期限格式錯誤");
    }
    if(remark && remark.length > 100){
      logger.warn("備註長度超過限制")
      return sendError(res, response.invalid_remark, '備註長度超過限制');
    }
    try {
      const result = await db.query(
      "SELECT manufactor_id, manufactor_name FROM manufactor WHERE manufactor_id = $1 OR manufactor_name = $2",
      [manufactor_id, manufactor_name]
    );
    const rows = result.rows
    for (const row of rows) {
      if (row.manufactor_id === manufactor_id) {
        logger.warn("編號已被使用")
        return sendError(res, response.id_conflict, "編號已被使用");
      }
      if (row.manufactor_name === manufactor_name) {
        logger.warn("名稱已被使用")
        return sendError(res, response.name_conflict, "名稱已被使用");
      }
    }
    tax_rate = tax_rate || 0;
    discount = discount || 0;
    ticket_period = ticket_period || 0;
    await db.query(
      "INSERT INTO manufactor (manufactor_id, unified_number, create_date, manufactor_name, contact_person, phone, email, tax_rate, discount, ticket_period, remark) VALUES ($1, $2, $3, $4, $5 , $6, $7, $8, $9, $10, $11)",
      [manufactor_id, unified_number, taipeiTime, manufactor_name, contact_person, phone, email, tax_rate, discount, ticket_period, remark]
    );
     res.status(200).json({
      code: response.success,
      msg: "建立成功",
    });
    } catch (error) {
      logger.error(error)
      return sendError(res, response.server_error, "伺服器錯誤，請稍後再試", 500);
    }
  }
)
// 查詢列表
router.post("/list", async (req, res) => {
  const { page, pageSize, filter,sort } = req.body;
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
      if (filter.manufactor_id) {
        conditions.push(`manufactor_id ILIKE $${paramIndex++}`);
        values.push(`%${filter.manufactor_id}%`);
      }
      if (filter.manufactor_name) {
        conditions.push(`manufactor_name ILIKE $${paramIndex++}`);
        values.push(`%${filter.manufactor_name}%`);
      }
    }

    const whereClause = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
  try {
    const result =  await db.query(
      `SELECT manufactor_id, manufactor_name 
      FROM manufactor 
      ${whereClause} 
      ORDER BY manufactor_id ${sort} 
      LIMIT $${paramIndex++} OFFSET $${paramIndex++}`,
      [...values,pageSize, offset]
    );
    const manufactors = result.rows;
    // 查詢總筆數
    const totalResult = await db.query(
      `SELECT COUNT(*) as total FROM manufactor ${whereClause}`,
      values
    );
    const total = totalResult.rows[0].total;
    res.status(201).json({
      code: response.success,
      msg: "查詢成功",
      data: {
        list:manufactors,
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
// 查詢詳細資料
router.post("/detail", async (req, res) => {
  const { manufactor_id } = req.body;
  if(!manufactor_id){
    logger.warn("缺少必要資料")
    return sendError(res, response.missing_info, '缺少必要資料');
  }
  try {
    const result =  await db.query(
      "SELECT * FROM manufactor WHERE manufactor_id = $1",
      [manufactor_id]
    );
    const manufactor = result.rows[0];
    if(!manufactor){
      logger.warn("查無此廠商")
      return sendError(res, response.not_found, "查無此廠商");
    }
    res.status(200).json({
      code: response.success,
      msg: "查詢成功",
      data: manufactor
    });
  } catch (error) {
    logger.error(error)
    return sendError(res, response.server_error, "伺服器錯誤，請稍後再試", 500);
  } 
})
// 修改
router.post("/update", async (req, res) => {
  let { manufactor_id, unified_number, manufactor_name, contact_person, phone, email, tax_rate, discount, ticket_period, remark} = req.body;
    if(!manufactor_id  || !manufactor_name){
      logger.warn("缺少必要資料")
      return sendError(res, response.missing_info, '缺少必要資料');
    }
    if (!/^\d{1,5}$/.test(manufactor_id)) {
      logger.warn("編號格式錯誤")
      return sendError(res, response.invalid_id, '編號格式錯誤，必須為1~5位數字');
    }
    if (unified_number && !/^\d{8}$/.test(unified_number)) {
      logger.warn("統一編號格式錯誤")
      return sendError(res, response.invalid_unified_number, '統一編號格式錯誤，必須為8位數字');
    }
    if(manufactor_name.length > 20){
      logger.warn("廠商名稱長度超過限制")
      return sendError(res, response.invalid_name, '廠商名稱長度超過限制');
    }
    if(contact_person && contact_person.length > 10){
      logger.warn("聯絡人長度超過限制")
      return sendError(res, response.invalid_contact, '聯絡人長度超過限制');
    }
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (email &&　!emailRegex.test(email)) {
      logger.warn("Email格式錯誤")
      return sendError(res, response.invalid_email, "Email格式錯誤");
    }
    const phoneRegex = /^(09\d{8}|0\d{1,3}-?\d{6,8})$/;
    if (phone && !phoneRegex.test(phone)) {
      logger.warn("電話號碼格式錯誤")
      return sendError(res, response.invalid_phone, "電話號碼格式錯誤");
    }
    if(tax_rate && (tax_rate < 0 || !Number.isFinite(tax_rate))){
      logger.warn("稅率格式錯誤")
      return sendError(res, response.invalid_tax_rate, "稅率格式錯誤");
    }
    if(discount && (discount < 0|| !Number.isFinite(discount))){
      logger.warn("折扣格式錯誤")
      return sendError(res, response.invalid_discount, "折扣格式錯誤");
    }
    if(ticket_period && (ticket_period < 0|| !Number.isFinite(ticket_period))){
      logger.warn("票據期限格式錯誤")
      return sendError(res, response.invalid_ticket_period, "票據期限格式錯誤");
    }
    if(remark && remark.length > 100){
      logger.warn("備註長度超過限制")
      return sendError(res, response.invalid_remark, '備註長度超過限制');
    }
    try {
     const result = await db.query(
      "SELECT manufactor_id FROM manufactor WHERE manufactor_name = $1 AND manufactor_id <> $2",
      [manufactor_name, manufactor_id]
    );
    
    if (result.rows.length > 0) {
      logger.warn("名稱已被使用");
      return sendError(res, response.name_conflict, "名稱已被使用");
    }
    tax_rate = tax_rate || 0;
    discount = discount || 0;
    ticket_period = ticket_period || 0;
    await db.query(
     `UPDATE manufactor SET unified_number = $1,manufactor_name = $2,contact_person = $3,phone = $4,email = $5,tax_rate = $6,discount = $7,ticket_period = $8,remark = $9 WHERE manufactor_id = $10`,
     [
      unified_number,
      manufactor_name,
      contact_person,
      phone,
      email,
      tax_rate,
      discount,
      ticket_period,
      remark,
      manufactor_id,
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
router.post("/delete", async (req, res) => {
  const { manufactor_id } = req.body;
    if(!manufactor_id){
      logger.warn("缺少必要資料")
      return sendError(res, response.missing_info, '缺少必要資料');
    }
    try {
      await db.query(
      "DELETE FROM manufactor WHERE manufactor_id = $1",
      [manufactor_id]
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

module.exports = router;