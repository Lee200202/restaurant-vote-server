# 聚餐投票所 — 匿名餐廳投票（Google Sheets 雲端資料庫版）

多人即時同步的匿名餐廳投票網站。貼上或拖曳 Google Maps 連結就能新增候選餐廳。所有資料都存在 **Google Sheets**：Render 免費版休眠或重新啟動時，資料不會消失，也可以直接打開試算表查看。

**零依賴**：只用 Node.js 內建模組，不必 `npm install`。

## 功能

- 貼上或拖曳 Google Maps 連結（支援 `maps.app.goo.gl` 短網址），伺服器會自動擷取餐廳名稱與地址
  - 連結下方另外貼的兩行文字，會當成店名與地址
  - 連結裡有座標時，會用 OpenStreetMap 反查地址
  - 選用：設定 `GOOGLE_MAPS_API_KEY` 後，會透過 Google Places API 補上精準的店名與地址（金鑰只放在後端）
- **匿名投票**：每個瀏覽器有一組隨機匿名 ID，資料庫只存它的加鹽 SHA-256 雜湊值。API 只會告訴你自己投了哪些餐廳，看不到別人的投票紀錄
- 投票規則：可複選，或一人一票（隨時可以改投）
- 每 3 秒同步一次，最高票會顯示在頂部（含得票率、同票並列）
- 排序（票數 / 最新）、編輯、刪除、複製連結、修改標題與說明、清空所有餐廳
- 動畫：漣漪點擊、+1 浮字與火花、票數彈跳、卡片光暈、進度條閃光、聚光燈流動背景

## 網站與資料的架構

- **網頁**：GitHub Pages（`public/`，由 `.github/workflows/pages.yml` 自動發布）→ https://lee200202.github.io/restaurant-vote-server/
- **API**：Render（`node server.js`，只允許上面這個網址跨網域呼叫）
- **資料**：Google 試算表，經由 Apps Script 網頁應用程式存取（Render 重啟不會掉資料）

### 設定 Google 試算表後端（Apps Script，不需要 Google Cloud 金鑰）
1. 建一個空白 Google 試算表。
2. 擴充功能 → Apps Script，貼上 `apps-script/Code.gs`，把 `TOKEN` 改成一串長的隨機字。
3. 部署 → 新增部署 → 網頁應用程式：執行身分「我」、存取權「所有人」，複製 `…/exec` 網址。
4. Render → Environment 設定：
   - `APPS_SCRIPT_URL`：上一步的 `/exec` 網址
   - `APPS_SCRIPT_TOKEN`：與 `Code.gs` 內相同的 TOKEN
   - `VOTER_SALT`：任意隨機字串（設定後不要再改）
5. 打開 Render 網站的 `/healthz`，看到 `"storage":"apps-script-sheets"` 就成功了。

> TOKEN 與 `/exec` 網址等同密碼，請只放在 Apps Script 與 Render，不要提交到 GitHub。
> 存取優先順序：Apps Script → Supabase → Google 服務帳戶 → `data.json`。

## Supabase 資料庫（選用）

資料存在 Supabase 的 `poll_state` 資料表（一列 jsonb），Render 重啟、休眠或重新部署都不會消失。

1. 在 Supabase SQL Editor 執行 `schema.sql` 建立資料表（已啟用 RLS，只有伺服器的 secret key 能存取）。
2. 在 Render → Environment 設定：
   - `SUPABASE_URL`：專案網址，例如 `https://xxxx.supabase.co`
   - `SUPABASE_SERVICE_KEY`：Supabase 的 secret key（只放在 Render，**不要提交到 GitHub**）
3. 打開 `/healthz`，看到 `"storage":"supabase"` 就成功了。

啟動時讀不到資料庫會直接結束並由 Render 重試，**不會用空資料開始**，避免蓋掉既有紀錄；寫入有重試，收到 SIGTERM 時會先存檔。

## 免設定的資料保存（未設定資料庫時）

不設定 Google Sheets 也能長期保存資料：

1. `.github/workflows/keepalive-backup.yml` 每 5 分鐘呼叫一次網站，讓 Render 免費版不會進入休眠。
2. 同一個工作也會把所有餐廳、連結和票數備份到這個 repo 的 **`data` 分支**（`state.json`，`README.md` 裡有票數表）。
3. 伺服器重新啟動後，如果 `data.json` 不見了，就會自動從 `data` 分支還原。

備份只存匿名雜湊值，不含任何個人身分。

## Google Sheets 資料結構（選用）

伺服器第一次啟動時會自動建立三個分頁：

| 分頁 | 內容 |
| --- | --- |
| `投票設定` | 標題、說明、投票規則（`multi` / `single`）、排序方式 |
| `候選餐廳` | id、餐廳名稱、地址、Google Maps 連結、建立時間、**票數** |
| `投票紀錄` | 每一張票：餐廳、匿名投票者雜湊值、投票時間 |

直接在試算表裡修改「投票設定」或「候選餐廳」，約 60 秒內就會同步到網站上。

## 部署到 Render（選用：改用 Google Sheets）

1. **建立試算表**：在 Google Sheets 新增一個空白試算表。網址 `https://docs.google.com/spreadsheets/d/<這一段>/edit` 中間那段就是 `GOOGLE_SHEET_ID`。
2. **共用給服務帳戶**：按「共用」，把服務帳戶的 email（金鑰 JSON 裡的 `client_email`）加為「**編輯者**」。
3. **設定 Render 環境變數**（Web Service → Environment）：
   - `GOOGLE_SHEET_ID`：第 1 步取得的 ID
   - `GOOGLE_SERVICE_ACCOUNT`：服務帳戶金鑰 JSON 的完整內容（也可以用 base64 編碼後的字串）
   - `VOTER_SALT`：任意一串隨機文字（匿名雜湊用的鹽，設定後請不要再更改）
4. 儲存後 Render 會自動重新部署。打開 `/healthz`，看到 `"storage":"google-sheets"` 就成功了。

> 沒設定上面的環境變數時，伺服器會退回使用 `data.json`（Render 免費版重新啟動後，這個檔案的資料會消失）。

## API

| 方法 | 路徑 | 說明 |
| --- | --- | --- |
| GET | `/api/state` | 取得完整狀態 |
| PATCH | `/api/poll` | 更新 `title` / `description` / `voteMode` / `sortBy` |
| POST | `/api/restaurants` | `{ input }` 新增 Google Maps 連結 |
| DELETE | `/api/restaurants` | 清空所有餐廳 |
| PATCH | `/api/restaurants/:id` | 編輯 `name` / `address` / `url` |
| DELETE | `/api/restaurants/:id` | 刪除 |
| POST | `/api/restaurants/:id/vote` | 投票或取消投票（匿名 ID 放在 `X-Voter-Id` 標頭） |
| GET | `/api/backup` | 完整匯出（給備份工作使用） |
| GET | `/healthz` | 健康檢查，會顯示目前使用的儲存方式 |

## 本機開發與測試

```bash
npm start                                  # 使用 data.json
BASE=http://localhost:3000 npm test        # API 冒煙測試
node test/mock-sheets.js                   # 模擬 Google Sheets API（搭配 SHEETS_API_BASE=http://127.0.0.1:9555）
```
