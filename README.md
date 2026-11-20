# 聚餐投票所 — 完整前後端版本（支援多人同步記憶 & Google Maps 連結解析）

這個專案**不需要安裝任何外部套件（零依賴）**，內建：
1. **後端持久化記憶（`data.json`）**：所有新增的餐廳、編輯內容與匿名票數都會即時寫入伺服器記憶體與 `data.json`，重新整理或不同裝置打開都會即時同步看到最新狀態。
2. **伺服器端 Google Maps 連結解析**：自動追蹤 `maps.app.goo.gl` 短網址轉址、擷取餐廳名稱與座標地址；若設定環境變數 `GOOGLE_MAPS_API_KEY`，會直接透過官方 **Google Places API** 補齊最精準的店名與完整地址（金鑰只存在後端，不會暴露給瀏覽器）。

## 本機啟動（10 秒測試）
```bash
node server.js
```
打開瀏覽器前往 `http://localhost:3000` 即可使用。

## 免費部署上線（1–2 天臨時活動）
將此資料夾上傳到 GitHub 後，匯入以下任一免費平台即可自動部署（啟動指令為 `node server.js`）：
- **Render**（Web Service）
- **Zeabur**
- **Railway**

（選填）若想啟用 Google Maps 官方 Places API，在平台的 **Environment Variables** 新增 `GOOGLE_MAPS_API_KEY=你的金鑰` 即可。
