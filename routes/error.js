// routes/error.js
const express = require("express");
const router = express.Router();

router.get("/", async (req, res) => {
  /*  
    #swagger.tags = ['system']
    #swagger.summary = '錯誤代碼查詢'
    #swagger.description = '列出所有錯誤代碼與對應說明'
    #swagger.responses[200] = {
        description: "成功",
        content: {
            "application/json": {
                schema: {
                    type: "array",
                    items: {
                      type: "object",
                      properties: {
                          code: { type: "string", example: "000" },
                          msg: { type: "string", example: "成功" }
                        }
                    }
                }
            }
        }
    }
*/
  const errorCodes = [
    { code: "000", msg: "成功" },
    { code: "001", msg: "缺少必要資訊" },
    { code: "002", msg: "帳號格式錯誤" },
    { code: "003", msg: "密碼格式錯誤" },
    { code: "004", msg: "姓名格式錯誤" },
    { code: "005", msg: "Email 格式錯誤" },
    { code: "006", msg: "Refresh Token 無效" },
    { code: "007", msg: "Access Token 無效" },
    { code: "008", msg: "分頁資訊錯誤" },
    { code: "009", msg: "驗證碼格式錯誤" },
    { code: "010", msg: "手機號碼格式錯誤" },
    { code: "011", msg: "時間格式錯誤" },
    { code: "012", msg: "日期格式錯誤" },
    { code: "013", msg: "備註格式錯誤" },
    { code: "014", msg: "價格格式錯誤" },
    { code: "015", msg: "人數格式錯誤" },
    { code: "016", msg: "主題格式錯誤" },
    { code: "017", msg: "過敏資訊錯誤" },
    { code: "018", msg: "Token 無效" },
    { code: "019", msg: "提供的資訊不正確" },
    { code: "101", msg: "帳號已存在" },
    { code: "102", msg: "Email 已被使用" },
    { code: "103", msg: "驗證碼衝突" },
    { code: "201", msg: "密碼錯誤" },
    { code: "202", msg: "驗證碼錯誤" },
    { code: "203", msg: "驗證碼已過期" },
    { code: "204", msg: "已超過可取消時間" },
    { code: "301", msg: "找不到使用者" },
    { code: "302", msg: "找不到帳號" },
    { code: "303", msg: "找不到驗證碼" },
    { code: "304", msg: "找不到訂單" },
    { code: "305", msg: "容量已滿" },
    { code: "401", msg: "未授權存取" },
    { code: "402", msg: "無權限操作" },
    { code: "500", msg: "伺服器錯誤" },
    { code: "501", msg: "驗證錯誤" },
    { code: "502", msg: "無法重複取消訂單" },
  ];

  res.status(200).json(errorCodes);
});

module.exports = router;
