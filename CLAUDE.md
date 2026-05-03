# 全域 Harness

## 語言
- 一律使用繁體中文，台灣用語
- 程式碼中的變數、函式、註解使用英文

## 安全
- 禁止在對話或程式碼中貼出密碼、金鑰、Token
- 機密資料從環境變數或 .env 讀取
- 禁止讀取或修改 .env、.git\、node_modules\、C:\Users\[使用者]\.ssh\ 等敏感目錄或其內容
- 刪除操作只能針對明確指定的檔案，刪除前列出內容並確認
- 執行以下指令前**必須**明確告訴我你要跑什麼、影響範圍為何，等我確認才執行：
  - PowerShell 的 Remove-Item -Recurse、Get-ChildItem | Remove-Item 批次刪除
  - Git Bash 的 rm -rf、find ... -delete
  - git push --force、git reset --hard、git clean -fd
  - 資料庫的 DROP、TRUNCATE、DELETE FROM ... WHERE（沒 WHERE 更要確認）
  - 任何會修改生產環境 config、部署腳本、CI pipeline 的改動
- 這些是「破壞後很難救」的操作，額外一次確認永遠比事後回滾划算

## 工作狀態管理

本專案為個人專案，只使用 .scratch\local\（不進 git），不需要 .scratch\shared\。

### 個人用（.scratch\local\，不進 git）
- current-task.md — 目前在做什麼、做到哪裡
- handoff.md — 自己跨 session 接續用（記「整體狀態、下次開機做什麼」）
- plans\ — Superpowers writing-plans skill 產出的單任務計畫檔（選配）
- decisions.md — 架構和技術決策紀錄（個人專案也記，方便日後回溯）
- 每次開始任務時，讀取 .scratch\local\current-task.md（如果有）
- 每完成一個有意義的步驟，更新 .scratch\local\current-task.md
- 任務結束或中斷時，更新 .scratch\local\handoff.md
- 當我說「暫停」「先到這」「今天先這樣」或任何表示要中斷的話，主動統整並更新 handoff.md，不需要等我下達具體指令

### handoff.md 與 Superpowers plan 檔的分工
- 探索式工作（查 bug、評估技術、環境設定）→ 只寫 handoff.md，不需要建 plan
- 多步驟功能實作 → 用 /superpowers:writing-plans 產出 plan 檔，再用 /superpowers:executing-plans <plan> 執行
- 有在跑 plan 時，handoff.md 不要複製 plan 內容，只記「正在執行 xxx.md 的 step N/M」+ 當前卡點
- 跨 session 接續：先讀 handoff.md 看整體，若提到 plan 檔再讀 plan

### Plan 檔位置
- 一律放 .scratch\local\plans\，不進 git

## Context 管理
- 不要一次讀入整個 routes\
- 先讀 app.js 與目錄結構（routes\、middleware\、utils\），確認要改哪些檔案
- 只讀跟當前任務相關的檔案
- 理解某個 endpoint 行為時，優先讀對應的 route 檔 + 它用到的 middleware / utils，不要連帶讀無關 route

## 搜尋與查證
- API 和函式庫相關內容，先查官方文件再開始
- 查到的結果如果跟已知知識衝突，告訴我讓我判斷

## 決策規則
### 要問我的
- 架構層級決策（引入新依賴、改資料結構）
- 刪除檔案或大量重構
- 不確定需求的意思

### 可以自己判斷的
- 命名、格式（遵循專案既有慣例）
- 錯誤處理的實作細節
- 測試案例的設計

### 判斷原則
- 選最簡單、最明確的做法
- 偏好 explicit 而非 implicit
- 不確定就選保守的方式

### 舊專案紅線
- 除非明確要求，絕對禁止修改當前任務範圍外的程式碼，即使你認為它寫得不好
- 發現需要重構的地方，記錄到 .scratch\local\decisions.md，作為獨立任務提出
- 未來若導入測試框架，補測試時不要為了「讓程式碼更好測試」而重構生產程式碼，用 mock/stub 處理

## 品質關卡
- 每次實作完成後，必須逐項跑過下方「實作完成後的自動檢查」
- 每一項都要明確回報「通過」或「不適用」，不能跳過
- 如果有任何一項不通過，修完再重新跑一次，全部通過才能 commit

## 實作完成後的自動檢查

每次改完程式碼，依序跑這幾項。每一項回報「通過 / 不適用 / 不通過＋錯誤摘要」。

### 1. 啟動 / Syntax 檢查
```
npm run dev
```
- 等同 `nodemon --legacy-watch app.js`，會自動重新載入並檢查 require / syntax
- 通過條件：終端出現 `Server running on port ...`，無 require 失敗、無 SyntaxError、無 unhandled rejection
- 已在跑 dev server 時：存檔讓 nodemon 自動重啟，看終端輸出有沒有錯誤即可，不用重啟整支
- 不適用：純文件 / `.scratch\` 內容變更（未動到 .js 檔）

### 2. API 手動驗證（後端改動必跑）
- 動到 routes\、middleware\、utils\、app.js、db.js、logger.js 內任何會影響 endpoint 的檔案，就要手動驗證
- 由我（AI）列出「該打哪些 endpoint 與情境」，由你用 Postman / curl / 前端實際打過：
  - golden path（正常流程）打一次，確認 status code、回傳結構符合預期
  - 至少一個 edge case：缺欄位 / 權限不足（無 token、token 過期）/ 空資料 / 邊界值（負數、零、極大值）
  - 涉及寫入（POST/PATCH/DELETE）要確認 DB 實際狀態變更正確、無多餘副作用
  - 留意 winston log（檔案 + 終端）有沒有新的 error / warn
- 我沒辦法直接打 API 或操作 DB，所以實際驗證由你做、回報結果給我
- 不適用：只動到註解、未被任何 route require 的檔案、純常數調整且不影響行為

### 3. 資料庫變更
- 如果改動牽涉 schema（新欄位、改型別、加索引、改 constraint），列出需要在資料庫執行的 DDL 給你確認
- DDL **絕對不要自動跑**（連 dev DB 也不行），一律列出 SQL 等你決定何時、在哪個環境執行
- 通過條件：列出的 DDL 你已在對應環境執行完畢，且 API 驗證通過
- 不適用：純讀取 query 改動、純 application 邏輯改動、未動到任何 SQL

### 4. 測試
- 目前專案沒有測試框架（無 vitest / jest / mocha 設定），此項一律標記為「不適用」
- 之後若導入測試框架，要回來補上對應指令

### 回報格式範例
```
- 啟動 / Syntax：通過（nodemon 重啟成功，無 error）
- API 驗證：待你用 Postman / 前端確認
  - 受影響 endpoint：
    - GET  /api/restock?manufactorId=xxx
    - POST /api/restock
    - POST /api/restock/cancel
  - 該測：
    - 列表載入 + 廠商篩選（含篩無資料情境）
    - 新增進貨單（正常 / 缺欄位 / 無 token）
    - 取消進貨後庫存正確扣回（含扣到負數的情境）
- DB 變更：無
- 測試：不適用（專案無測試框架）
```

## Windows 特有
- 檔案路徑使用反斜線（\）或正斜線（/）皆可，但寫入設定檔時請統一風格
- 避免假設 POSIX 工具存在（sed、awk、grep），如需文字處理優先用 PowerShell cmdlet
- 執行 PowerShell 腳本前先確認 ExecutionPolicy 為 RemoteSigned 以上