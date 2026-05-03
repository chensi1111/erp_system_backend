# 銷貨／訂貨領域知識（sale-domain）

> 適用範圍：[routes/sale.js](../routes/sale.js)、以及任何會動到 `sale`、`payment`、`stock`、`stock_history` 四張表的 task。

---

## 1. 涉及的資料表

| 表 | 用途 |
|---|---|
| `sale` | 一張單據的主檔（銷貨／退貨／訂貨／取貨皆共用此表） |
| `payment` | 對應 sale 的金流流水（一張單可能對到多筆 payment） |
| `stock` | 商品某一規格的當前庫存狀態（單列代表一個 product_id + specification） |
| `stock_history` | 庫存異動紀錄（每次動 stock 都應該補一筆） |

### 1.1 `sale` 主要欄位

| 欄位 | 語意 | 備註 |
|---|---|---|
| `order_no` | 單號，主鍵性質 | `/create` 產 `S` 開頭、`/create_order` 產 `O` 開頭 |
| `transaction` | 通路別 | `0=現場`，其他值未使用 |
| `status` | **單據目前狀態** | `0=銷貨, 1=退貨, 2=建立訂貨(只收訂金), 3=訂貨交付(收尾款), 4=取消訂貨, 5=此單取消`。建單時由路由參數 `type` 直接寫入，後續操作才會改值。詳見 §2.1 |
| `pay` | 付款方式 | `0=現金, 1=刷卡, 2=現金券` |
| `product_id` + `specification` | 商品與規格識別 | |
| `product_name` | 商品名稱（建單時寫入的快照） | |
| `quantities` | JSON 陣列：`[{size, quantity}, ...]` | |
| `size_list` | 對應 `size` 表的 size_id | |
| `total_quantity` | 該筆單據的總數量（所有 size 加總） | |
| `price` | **單價**（不是總價） | |
| `create_date` | 建單時間 | |
| `remark` | 備註，最大 100 字元 | |

> 註：DDL 中 sale 表**沒有 `type` 欄位**，也**沒有 `is_deleted`**。路由內看到的 `type` 是 `req.body` 上的參數，會被寫入 `sale.status`。[routes/sale.js:499](../routes/sale.js#L499) 的 `is_deleted = false` 沒加 prefix，但實際上整個 JOIN 裡只有 `payment` 有此欄位，PG 會自動 bind；不過寫法仍應補成 `pm.is_deleted` 才嚴謹（見 §6）。

#### sale表DDL
CREATE TABLE public.sale (
	id serial4 NOT NULL,
	"transaction" int4 NOT NULL,
	order_no varchar(20) NOT NULL,
	product_id varchar(20) NOT NULL,
	specification varchar(20) NOT NULL,
	create_date timestamp NOT NULL,
	product_name varchar(20) NOT NULL,
	price int4 NOT NULL,
	quantities jsonb NOT NULL,
	total_quantity int4 NOT NULL,
	remark varchar(100) NULL,
	size_list varchar(50) NOT NULL,
	pay int4 NOT NULL,
	status int4 NOT NULL,
	CONSTRAINT sale_pk PRIMARY KEY (id)
);

### 1.2 `payment` 主要欄位

| 欄位 | 語意 |
|---|---|
| `order_no` | 對應 `sale.order_no`（一對多） |
| `amount` | 該筆金流的金額 |
| `type` | **金流種類**，見 §2.3 |
| `paid_at` | 系統紀錄時間（datetime） |
| `paid_date` | 對帳用的入帳日（date） |
| `is_deleted` | 軟刪除旗標 |

#### payment表DDL

CREATE TABLE public.payment (
	id serial4 NOT NULL,
	order_no varchar(20) NOT NULL,
	amount int4 NOT NULL,
	"type" int4 NOT NULL,
	paid_at timestamp NOT NULL,
	paid_date date NOT NULL,
	is_deleted bool DEFAULT false NOT NULL,
	CONSTRAINT payment_pk PRIMARY KEY (id)
);

### 1.3 `stock` 主要欄位

| 欄位 | 語意 | 備註 |
|---|---|---|
| `product_id` + `specification` | 複合識別 | DDL 上未做 UNIQUE 拘束，邏輯上應該唯一 |
| `stock_qty` | JSON 陣列：每個 size 的庫存物件 | 詳見 §1.5 |
| `total_quantity` | `stock_qty[*].all_quantity` 的加總（不變式） | 任何動到 `all_quantity` 的操作必須同步更新此欄位；任何**沒**動 `all_quantity` 的操作就**不該**動此欄位。違反者見 §6.2 |
| `product_name` | 商品名稱快照 | |
| `cumulative_cost` | 累計進貨成本 | 用於計算平均成本 |
| `cumulative_in_quantity` | 累計進貨數量 | 平均成本 = `cumulative_cost / cumulative_in_quantity` |
| `last_cost` | 上一次進貨單價 | |
| `last_in_date` | 最後進貨日 | sale 流程不會動，由 restock 流程維護 |
| `last_out_date` | 最後出貨日 | ⚠️ 各路由寫入的型別不一致（taipeiTime / taipeiDate / 前端傳的 `date`），見 §6 |

#### stock表DDL

CREATE TABLE public.stock (
	id serial4 NOT NULL,
	product_id varchar(20) NOT NULL,
	specification varchar(20) NOT NULL,
	stock_qty jsonb NOT NULL,
	last_in_date timestamp NULL,
	last_out_date timestamp NULL,
	product_name varchar(20) NOT NULL,
	total_quantity int4 NULL,
	cumulative_cost int4 NULL,
	last_cost int4 NULL,
	cumulative_in_quantity int4 NULL,
	CONSTRAINT stock_pk PRIMARY KEY (id)
);

### 1.4 `stock_history` 主要欄位

| 欄位 | 語意 |
|---|---|
| `change_number` | 異動來源單號（多半 = `sale.order_no`） |
| `change_type` | 異動類型，見 §2.4 |
| `quantities` | 該筆異動影響的 size × 數量 |
| `total_quantity` | 該筆異動的總數 |
| `price` | 單價（不是總價）。⚠️ 歷史資料中 `change_type IN (5, 6, 7)` 的列在 §6.8 修正前是總價，未做 reconciliation，查歷史時要分段判斷 |
| `prepaid_price` / `remaining_price` | 訂貨流程才會帶值 |
| `product_name` | 商品名稱快照 | |
| `create_date` | 異動時間 |
| `reason` | 異動原因說明 | DDL 有但 sale 流程內目前都沒寫入，未來補手動調整時會用到 |

#### stock_history DDL

CREATE TABLE public.stock_history (
	id serial4 NOT NULL,
	product_id varchar(20) NOT NULL,
	specification varchar(20) NOT NULL,
	change_type int4 NOT NULL,
	change_number varchar(20) NOT NULL,
	quantities jsonb NOT NULL,
	reason varchar(50) NULL,
	create_date timestamp NOT NULL,
	product_name varchar(20) NOT NULL,
	total_quantity int4 NOT NULL,
	price int4 NULL,
	prepaid_price int4 NULL,
	remaining_price int4 NULL,
	CONSTRAINT stock_history_pk PRIMARY KEY (id)
);

### 1.5 `stock.stock_qty` 的 JSON 結構

每個元素代表一個 size 的庫存狀態：

```json
{
  "size": "M",
  "safe_stock": "",             // 安全庫存
  "available_quantity": "10",   // 可售（未被預訂占用）
  "reserved_quantity": "2",     // 已被訂貨單預留、尚未取貨
  "all_quantity": "12"          // 實體還在倉庫的數量
}
```

> ⚠️ 數字目前是**字串**形式（路由內到處 `parseInt(... || "0", 10)`）。新增/修改時請維持字串，避免破壞既有讀取邏輯。

---

## 2. 狀態碼總表

### 2.1 路由參數 `type`（不是 sale 表欄位）

`type` 是 `/create` 與 `/create_order` 從 `req.body` 取得的參數，建單時被寫入 `sale.status`（[routes/sale.js:162](../routes/sale.js#L162)、[routes/sale.js:380](../routes/sale.js#L380)）。`sale` 表本身沒有獨立的 `type` 欄位。

| 路由 | 前端傳的 `type` 值 | 對應到 `sale.status` |
|---|---|---|
| `/create` | `0` | 0（銷貨） |
| `/create` | `1` | 1（退貨） |
| `/create_order` | `2` | 2（建立訂貨） |
| `/delete_order` | `4` 或 `5` | 4（取消訂貨／退訂金）或 5（此單取消） |

### 2.2 `sale.status`

| 值 | 含意 | 進入此狀態的路由 |
|---|---|---|
| 0 | 銷貨 | `/create`（type=0 建立後） |
| 1 | 退貨 | `/create`（type=1 建立後） |
| 2 | 建立訂貨（只收訂金） | `/create_order` 建立後 ／ `/delete_pickup` 撤銷取貨後退回 |
| 3 | 訂貨交付（收尾款） | `/order_complete` |
| 4 | 取消訂貨（退訂金） | `/delete_order` 帶 `type=4` |
| 5 | 此單取消 | `/delete`（刪銷貨）／`/delete_order` 帶 `type=5` |

> ⚠️ Bug：`/delete_refund` 把 sale.status 改成 `3`（[routes/sale.js:894-897](../routes/sale.js#L894-L897)），但 status=3 的業務語意是「訂貨交付（收尾款）」。原作者疑似把 `sale.status` 與 `stock_history.change_type=3`（前台退貨取消）寫混了。修法：改成 `5`（此單取消）。詳見 §6.13。

### 2.3 `payment.type`

| 值 | 含意 | 出處 |
|---|---|---|
| 0 | 銷貨收款 | `/create`（type=0） |
| 1 | 退貨退款 | `/create`（type=1） |
| 2 | 訂金 | `/create_order` 寫死 [routes/sale.js:388](../routes/sale.js#L388) |
| 3 | 取貨尾款 | `/order_complete` 寫死 [routes/sale.js:1263](../routes/sale.js#L1263) |
| 4 | 退訂金 | `/delete_order` 帶 `type=4` 時把原本 type=2 的 payment 改成 4 |
| 5 | 取消這筆單 | `/delete_order` 帶 `type=5` 時把原本 type=2 的 payment 改成 5 並軟刪。語意上適用於任何要「整單作廢、不發生金流」的場景 |

`/list` summary 對 type 的歸類（[routes/sale.js:580-619](../routes/sale.js#L580-L619)）：

- **收入面**：`type IN (0, 2, 3)`（銷貨、訂金、取貨尾款）
- **退款面**：`type IN (1, 4)`（退貨、退訂金）
- `type=5` 不計入任何一邊（取消不發生金流）

### 2.4 `stock_history.change_type`

完整對照表（含 restock 用值）：

| 值 | 含意 | sale.js 中對應的路由 |
|---|---|---|
| 0 | 前台銷貨 | `/create`（type=0） |
| 1 | 前台銷貨取消 | `/delete` |
| 2 | 前台退貨 | `/create`（type=1） |
| 3 | 前台退貨取消 | `/delete_refund` |
| 4 | 前台訂貨 | `/create_order` |
| 5 | 前台訂貨取消（含退訂金與整單作廢兩種情況） | `/delete_order`（type=4 與 type=5 皆寫此值） |
| 6 | 前台取貨 | `/order_complete` |
| 7 | 前台取貨取消 | `/delete_pickup` |
| 8 | （設計時保留，未使用） | — |
| 9 | （設計時保留，未使用） | — |
| 10 | 廠商進貨 | restock.js |
| 11 | 廠商進貨取消 | restock.js |
| 12 | 廠商退貨 | restock.js |
| 13 | 廠商退貨取消 | restock.js |

> 不論 `/delete_order` 帶 `type=4`（退訂金）或 `type=5`（取消這筆單），對庫存而言都歸類為「前台訂貨取消」，`change_type` 統一寫 `5`。type=4 與 type=5 的差異只反映在 `payment` 與 `sale.status`，不在 stock_history。
> 8、9 雖在編號表中保留，但業務上沒有對應事件，視為設計時錯誤，**不要在新代碼中寫入這兩個值**。

### 2.5 `transaction`

| 值 | 含意 |
|---|---|
| 0 | 現場 ✅ [routes/sale.js:92](../routes/sale.js#L92) |

> 目前唯一通路。未來若新增線上／寄送等通路再擴充。

---

## 3. 庫存欄位變化矩陣

下表整理「每種操作」對 `stock_qty` 中各 size 物件、以及 `stock.total_quantity` 的影響。`+q` 表示加上該 size 的銷售/退貨數量，`-q` 表示減去。

| 操作 | available | reserved | all_quantity | 應有的 total_quantity | 實際 total_quantity |
|---|---|---|---|---|---|
| `/create` 銷貨 (type=0) | -q | – | -q | -total | -total ✓ |
| `/create` 退貨 (type=1) | +q | – | +q | +total | +total ✓ |
| `/create_order` 訂貨 | -q | +q | – | **0** | 0 ✓ |
| `/order_complete` 取貨完成 | – | -q | -q | -total | -total ✓ |
| `/delete` 撤銷銷貨 | +q | – | +q | +total | +total ✓ |
| `/delete_refund` 撤銷退貨 | -q | – | -q | -total | -total ✓ |
| `/delete_order` 撤銷訂貨 | +q | -q | – | **0** | 0 ✓ |
| `/delete_pickup` 撤銷取貨 | – | +q | +q | +total | +total ✓ |

> **不變式 1**：`stock.total_quantity = Σ stock_qty[*].all_quantity`。動了 `all_quantity` 才能動 `total_quantity`，反之亦然。
> **不變式 2**：`available_quantity = all_quantity - reserved_quantity`。任何操作後若不滿足這個等式，邏輯一定寫錯。
>
> ⚠️ 歷史偏差：在 §6.2 修正前，`/create_order` 與 `/delete_order` 都會錯誤地動 `total_quantity`。已交付過的訂貨每筆讓 `stock.total_quantity` 永久少 `total`；修正前已建單、修正後才完成或取消的 in-flight 訂貨也會繼續累積偏差。本次未校正歷史資料，需要時再寫獨立 reconciliation script 處理。

---

## 4. 業務流程地圖

### 4.1 現場銷貨／退貨（單步驟）

```
建單
  /create  type=0 (銷貨) ──► sale.status=0, payment.type=0, change_type=0
  /create  type=1 (退貨) ──► sale.status=1, payment.type=1, change_type=2

撤銷
  /delete         ──► sale.status=5, payment.is_deleted=true(type=0), change_type=1
  /delete_refund  ──► sale.status=3 ⚠️應為5, payment.is_deleted=true(type=1), change_type=3
```

### 4.2 訂貨 → 取貨完成（兩步驟）

```
建單
  /create_order  ──► sale.status=2, payment.type=2 (訂金), change_type=4

完成
  /order_complete ──► sale.status=3, payment +1 筆 type=3 (尾款), change_type=6

撤銷分支
  在 status=2 時:
    /delete_order  type=4  ──► sale.status=4, payment.type=2→4, change_type=5
    /delete_order  type=5  ──► sale.status=5, payment.type=2→5+is_deleted, change_type=5

  在 status=3 時:
    /delete_pickup ──► sale.status=2 (退回建立訂貨), payment(type=3).is_deleted=true,
                       change_type=7
    /delete_order 會被 §4.3 守門擋掉（status=3 拒絕）
```

### 4.3 重要的單步驟守門

| 守門 | 位置 | 行為 |
|---|---|---|
| `/delete_order` 不允許在 status=3 後執行 | [routes/sale.js:975-986](../routes/sale.js#L975-L986) | 訂貨已交付後不能再走訂貨取消 |
| `/order_complete` 不允許重複完成 | [routes/sale.js:1221-1232](../routes/sale.js#L1221-L1232) | 已 status=3 則拒絕 |

---

## 5. 單號規則

| Prefix | 路由 | 範例 |
|---|---|---|
| `S` + `YYYYMMDDHHmm` + `-` + 3 hex | `/create`（銷貨／退貨） | `S202604291623-A1F` |
| `O` + 同上 | `/create_order`（訂貨） | `O202604291623-9C2` |

> ⚠️ 3 hex 字尾僅 4096 種，同一分鐘內高併發會撞號。若 `order_no` 上有 UNIQUE 拘束會拋 PG error 進入 catch → ROLLBACK，使用者只看到「伺服器錯誤」。

---

## 6. 已知問題與不一致（修正前請當作雷區）

> 這一節是給未來來改 sale 的 Claude／你自己的警示。詳細分析在 [routes/sale.js](../routes/sale.js) 的程式碼審查記錄。

1. ~~**`/create` 與 `/create_order` 早返回未 ROLLBACK**~~ **[已修]** 兩處 `sendError` 前補上 `await client.query("ROLLBACK")`。
2. ~~**`/create_order` 與 `/delete_order` 不應動 `total_quantity`**~~ **[已修]** 兩個路由的 `UPDATE stock` 都已移除 `total_quantity = $X` 子句與對應參數宣告。歷史資料偏差未校正（決策保留），如需處理見 §3 注意事項。
3. ~~**`/delete_refund` 的 `total_quantity` 加法方向反了**~~ **[已修]** `updateQuantity` 改為 `stock_total_quantity - sale_total_quantity`。
4. ~~**`/create_order` 三段金額驗證的變數寫錯**~~ **[已修]** `prepaid_price`、`remaining_price` 兩段驗證的右側比較對象從 `price < 0` 改為各自的變數。
5. ~~**`/create_order` 必填欄位寫了兩次同一個**~~ **[已修]** 重複的 `!product_id` 改為 `!remaining_price`，補上漏檢查的欄位。
6. ~~**庫存讀寫沒有 row-level lock**~~ **[已修]** 所有交易內讀 stock 的 SELECT 都加上 `FOR UPDATE`：`/create`、`/create_order`、`/order_complete` 用 `FOR UPDATE`；`/delete`、`/delete_refund`、`/delete_order`、`/delete_pickup` 的 JOIN SELECT 用 `FOR UPDATE OF st`（避開 `LEFT JOIN stock_history`）；`/delete` 的 status 守門也加 `FOR UPDATE`，避免並發兩個 `/delete` 都通過 status=0 檢查。
7. ~~**庫存不足檢查全被註解**~~ **[非 bug]** 業務邏輯允許負庫存，三段註解（含 `/create_order`、`/order_complete` 內結果未使用的 `insufficientSizes` 計算）已清掉。
8. ~~**`stock_history.price` 語意不一致**~~ **[已修]** `/delete_order`、`/delete_pickup`、`/order_complete` 三處從 `price * total_quantity`（總價）改為 `price`（單價），與其他路由一致。歷史資料未校正（決策保留），`change_type IN (5, 6, 7)` 在此修正前的列仍為總價，查歷史報表時要分段。
9. ~~**`LEFT JOIN stock_history` 沒有指定 `change_type` 也沒 LIMIT**~~ **[已修]** 四條 JOIN ON 條件補上 change_type 過濾：`/delete` → 0、`/delete_refund` → 2、`/delete_order` → 4、`/delete_pickup` → 6（鎖定要 undo 的那筆原始事件）。順帶把 `/delete_pickup` 反向的 `ON s.order_no = sh.change_number` 統一成 `sh.change_number = s.order_no`。
10. ~~**`/delete` 不檢查 sale.type 就反向回補庫存**~~ **[已修]** 進交易後加 `SELECT status FROM sale WHERE order_no = $1` 守門，狀態 ≠ 0 一律 ROLLBACK + `invalid_action`，避免帶非銷貨單號進來時雙加庫存或誤改 status。
11. ~~**`/list` 的 `is_deleted = false` 沒指定表名**~~ **[已修]** 改為 `pm.is_deleted = false`。
12. ~~**`stock.last_out_date` 三條 UPDATE 各寫不同東西**~~ **[已修]** `/create_order` 移除 `last_out_date` 子句（訂貨建單實體沒出貨，本就不該動此欄）；`/order_complete` 從 `taipeiDate` 改 `taipeiTime`，保留時分秒；`/create` 維持原本的 `taipeiTime` 不變。
13. ~~**`/delete_refund` 把 `sale.status` 改成 3**~~ **[已修]** 改為 `5`（此單取消），語意對齊。
14. ~~**`/delete_order` 寫錯 `change_type`**~~ **[已修]** 寫死 `5`，type=4 與 type=5 在 stock_history 統一歸類為前台訂貨取消。

---

## 7. 改 sale 相關功能時的 checklist

- [ ] 動到 stock 的路徑，全部交易內加 `SELECT ... FOR UPDATE`，避免並發 lost update
- [ ] 任何 `await client.query(...)` 之後的早返回，前面**一定**先 `await client.query("ROLLBACK")`
- [ ] 寫 stock_history 時 `price` 欄位用單價（與 `/create` 對齊），不要混總價
- [ ] 動到 `change_type` 編號表時，先翻 §2.4 確認沒撞號（特別是 `/delete_order type=4` vs `/create_order` 的 4）
- [ ] 動到 status 流轉前，先回頭確認 §2.2 對應的業務語意有沒有被你改掉
- [ ] 加 endpoint 一律走 §1.5 約定的 stock_qty JSON 結構（字串數字、欄位名 `available_quantity` / `reserved_quantity` / `all_quantity`）
- [ ] 改完跑 [CLAUDE.md](../CLAUDE.md) §「實作完成後的自動檢查」全項

---

## 8. 待 Andy 確認的點

剩下一個動作：

1. **§6 列的 14 條已知問題**：請逐條標記「要修 / 暫不修 / 刻意設計」。我可以根據你的標記產 plan。
