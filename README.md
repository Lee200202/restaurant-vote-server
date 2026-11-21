# 聚餐投票所

匿名的聚餐餐廳投票網站：貼上 Google Maps 連結推薦餐廳、投票、編輯、刪除。

- **網站**：https://lee200202.github.io/restaurant-vote-server/ （GitHub Pages，`public/index.html`，push 到 `main` 由 `.github/workflows/pages.yml` 自動發布）
- **資料**：直接存在 Google 試算表，透過綁定在試算表上的 Apps Script 網頁應用程式讀寫（`apps-script/`）。資料不會因為時間經過而消失，試算表本身也有版本記錄可回溯。

## 試算表分頁

| 分頁 | 內容 |
| --- | --- |
| `投票設定` | 標題、說明、投票規則（`multi` 可複選 / `single` 一人一票）、排序 |
| `候選餐廳` | 每家餐廳一列：id、名稱、地址、Google Maps 連結、建立時間、目前票數 |
| `投票紀錄` | 每一張票一列：餐廳、匿名投票者（加鹽 SHA-256 雜湊）、投票時間 |
| `操作紀錄` | 新增 / 修改 / 刪除 / 清空 的歷史，只會往下累加 |

票數以「投票紀錄」為準；「候選餐廳」的票數欄是方便閱讀的統計。

## 更新 Apps Script

```bash
cd apps-script            # 搭配 .clasp.json（scriptId 18uHPGFrBkn1vB9biharme4nkwKLld0SZ_S0J2i1DrXjzcCI2XnK6J2l9）
clasp push --force
clasp create-version "說明"
clasp update-deployment AKfycbxoKhSQcJunvy0skwvmVkBTonSmhug_TfCgSLntt18ZhFBJFLjfzMKXML1e8C7vKXXV -V <版號>
```

部署設定在 `appsscript.json`：執行身分為擁有者、存取權為所有人（匿名）。
編輯器裡的 `setup()` 用於第一次授權，`fillMissingAddresses()` 可補上空白地址。
