# prloop — Azure DevOps PR 自動審查

對 Azure DevOps 的 Pull Request 執行自動程式碼審查。控制流完全在 TypeScript：模型只負責
「找出問題並引用出問題的程式碼」，**行號、去重、發佈與否一律由 pipeline 確定性決定**。

完整設計與研究依據見 [PROPOSAL.md](./PROPOSAL.md)。

## 目前進度

| 里程碑 | 內容 | 狀態 |
| --- | --- | --- |
| M1 | ADO REST 直連、本地 diff、quote 行號錨定、sticky summary + inline 留言 | ✅ 已完成 |
| M2 | 兩軸審查：Work Item 需求檢查（先讀 req 再審）+ 程式碼檢查，獨立額度不互相排擠 | ✅ 已完成 |
| M3 | 多模型平行 finder + 跨家族 skeptic 對抗 + 共識裁決 | ✅ 已完成 |
| M4 | 規則層 + Python / Java / Next.js 靜態分析整合與 LLM triage | ✅ 已完成 |
| M5 | iteration 增量審查、thread 自動 resolve、dismissal 記錄 | ✅ 已完成 |

M1–M5 全數完成。可對真實 PR 端到端執行:先讀需求、再審程式碼,兩軸分開呈現,留言錨定正確。

## 兩軸審查

一個 PR 可以在一軸過、另一軸掛:遵守所有規範但做錯東西,或做對事情但寫法有問題。
兩軸若合併排名,在留言上限之下會互相排擠——「需求根本沒做完」會被三個 critical
的 code 問題擠掉。因此 prloop 讓兩軸**各自獨立執行、各自獨立額度、summary 分區呈現**,
而且兩軸的模型看不到對方的結果,避免一軸被拿來替另一軸開脫。

- **需求軸**:抓 PR 連結的 Work Item(含向上一層找 acceptance criteria),逐條判定
  `satisfied / missing / partial / misunderstood / not-verifiable`,另外列出範圍外變更。
  判定的是「失敗的方式」而非「完成百分比」——後者給不出行動指引。
- **程式碼軸**:9 類 finding × 4 級嚴重度,嚴重度用依序判斷的決策鏈
  (最關鍵的分界是「有沒有繞過方式」),不是形容詞。

## 為什麼不用 azure-devops-mcp

留言貼錯行是結構性問題，不是設定問題：MCP 是 REST 的薄包裝，不做錨點驗證、沒有 iteration
簿記，舊版甚至取不到檔案行內容，模型只能自行推測行號（見 azure-devops-mcp #793、#868）。
prloop 因此直連 REST，並且**模型的輸出 schema 裡根本沒有行號欄位**：

1. 模型只回傳 `quote` —— 逐字複製出問題的原始碼。
2. pipeline 依 blob objectId 取得該 iteration 的**原始 bytes**（不經本地 checkout，避開
   CRLF/BOM 正規化差異），在其中搜尋 quote 得到絕對行號。
3. 同一段程式碼出現多次時，用模型提供的前後文消歧，再優先選擇落在本次變更行上的位置。
4. 找不到或無法消歧 → **降級進 summary 留言**，絕不猜行號貼上去。

副作用：引用了不存在的程式碼 = 幻覺，會在這一步被自動攔掉。

## 前置需求

- Node.js 20 以上（使用內建 fetch）。
- Azure DevOps 認證，以下**二擇一**：
  - **PAT**：需要 **Code (Read & Write)** scope，填入 `PRR_ADO_PAT`。在 pipeline 中可改用
    `$(System.AccessToken)`，但要授予 Build Service 對該 repo 的 Contribute to pull requests 權限。
  - **az CLI**：不設 PAT，改為 `az login` 即可，工具會自動用你的登入身分取 token。
    組織政策不發 PAT、或不想把 PAT 落地到 `.env` 時用這個。
- 一個 OpenAI 相容的模型 endpoint：LiteLLM proxy、vLLM 或 Ollama 的 `/v1`。

## 安裝

```bash
git clone <repo> prloop && cd prloop
npm install
cp .env.example .env      # 填入 PRR_ADO_PAT 與 PRR_LLM_BASE_URL
npm run check             # 型別檢查 + 離線 selftest
```

選用：把 wrapper 加進 PATH。

```bash
echo 'export PATH="$PATH:'$(pwd)'/bin"' >> ~/.bashrc && source ~/.bashrc
```

## 第一次執行

```bash
npx tsx scripts/doctor.ts '<PR URL>' --smoke   # preflight，並實測模型一次
prloop '<PR URL>' --dry-run                    # 只計算不發佈，先看結果對不對
prloop '<PR URL>'                              # 正式發佈留言
```

PR URL 格式為 `https://dev.azure.com/{org}/{project}/_git/{repo}/pullrequest/{id}`。

**強烈建議第一次先跑 `--dry-run`**，確認 finding 的行號與內容正確，再開放發佈。

退出碼：`0` 兩軸皆無阻擋項目、`2` 有未滿足的驗收條件或 critical/high 問題、`1` 致命錯誤。

## 每次執行的產出

`runs/<org>/<project>/<repo>/pr-<id>/iter-<N>-<時間戳>/`：

| 檔案 | 內容 |
| --- | --- |
| `context.json` | PR 資訊、iteration、納入與略過的檔案清單 |
| `finder-prompt.md` | 送給模型的完整 prompt |
| `finder-*-raw.txt` | 每顆模型的原始輸出（debug 幻覺與格式問題用） |
| `requirement.json` | 需求軸結果：work items、逐條判定、範圍外變更 |
| `static.json` / `static-findings.json` | 靜態工具原始結果與 triage 後的 findings |
| `skeptic.json` | 每筆 finding 的對抗驗證判定與理由 |
| `requirement-prompt.md` / `requirement-raw.txt` | 需求軸的 prompt 與原始輸出 |
| `findings.json` | 定位後的 findings：inline / 未達門檻 / 無法定位 |
| `publish.json` | 實際發佈結果與失敗原因 |

## 參數

全部為環境變數、全部選填，詳見 `.env.example`。常用的幾個：

| 變數 | 預設 | 說明 |
| --- | --- | --- |
| `PRR_ADO_PAT` | - | PAT，需 Code (Read & Write) scope。不設則走 az CLI |
| `PRR_AUTH_MODE` | `auto` | `auto`（有 PAT 用 PAT，否則 az）｜`pat`｜`azcli` |
| `PRR_LLM_BASE_URL` | `http://localhost:4000/v1` | OpenAI 相容 endpoint |
| `PRR_FINDER_MODELS` | `qwen3-coder` | 逗號分隔。M3 起請填多顆不同家族的模型 |
| `PRR_MAX_INLINE_COMMENTS` | 10 | 程式碼軸的 inline 留言上限 |
| `PRR_MAX_INLINE_REQ_COMMENTS` | 3 | 需求軸的 inline 留言上限（與程式碼軸各自獨立） |
| `PRR_REQ_MODEL` | 同 finder | 需求軸模型。驗收條件長時建議指定較強的模型 |
| `PRR_SKIP_REQUIREMENT` | - | 1 = 跳過需求軸 |
| `PRR_MIN_INLINE_SEVERITY` | `medium` | 低於此嚴重度只進 summary，不留 inline |
| `PRR_DRY_RUN` | - | 1 = 只計算不發佈 |
| `PRR_POST_STATUS` | - | 1 = 同時回報 PR status（需搭配 branch policy 才會擋 merge） |
| `PRR_LLM_STRUCTURED` | 1 | 0 = 不送 `response_format`（後端 schema 支援有問題時） |

## 留言行為

- **一則 sticky summary**：原地更新，不會每次推送都新增一則。狀態設為 closed，不會觸發
  「comment resolution required」policy。
- **少量 inline 留言**：狀態為 active，帶 `changeTrackingId` 與 `iterationContext`，
  推送新 commit 後 ADO 會自行追蹤位置。
- **不重複留言**：每則留言嵌入 finding 指紋，重跑時已留過的自動略過。
- **乾淨的 PR 會安靜**：沒發現問題時只更新 summary 說明，不製造噪音。
- 風格、命名、格式問題一律不留言 —— 那是 linter 的工作（M4 會納入）。

## 多模型對抗驗證

單顆開源模型做 code review 的誤報率很高,所以精度不是靠「叫模型小心一點」得來的——
finder 反而被要求**全部回報、包含不確定的**(要求模型自我審查會明顯傷害 recall),
過濾交給下游三道獨立的關卡:

1. **錨定**:引用不存在的程式碼 = 幻覺,在定位階段就被攔掉。
2. **對抗驗證(skeptic)**:每個 finding 交給**不同家族**的模型,任務是「推翻它」而不是
   「評估它」。被問「這對嗎?」的驗證者會附和;被要求「證明這是錯的」才會真的去檢查。
   而且 skeptic **看不到 finder 的推理過程**,只看到指控和程式碼——共用推理會造成錨定效應,
   驗證者會順著原作者的思路走而不是重新判斷。
3. **共識裁決**:要留 inline 留言需要佐證——**兩個模型獨立發現**,或**通過對抗驗證**。
   單一模型提出且沒被驗證過的 finding 只會列在 summary,不佔用留言額度。

幾個刻意的不對稱設計:

- skeptic 可以**下修**嚴重度,不能上修。finder 決定上限,讓驗證者能加碼會把它存在的意義
  (對抗附和傾向)還回去。
- skeptic 壞掉或回傳無法解析時 **fail-open**(finding 存活)。壞掉的驗證者不該有刪除
  真實 bug 的權力;共識裁決那關仍然會要求佐證。
- 錨定失敗則相反,是 **fail-closed**。貼錯行的傷害大於漏報。

設定 `PRR_SKEPTIC_MODELS` 才會啟用。**務必與 finder 用不同家族的模型**——同家族的驗證者
共用 finder 的盲點,最該抓到的錯誤反而會被確認。`doctor` 會檢查並警告這件事。

## Runner

兩種:

- **`openai`(預設)**:直接打 OpenAI 相容 endpoint(LiteLLM proxy / vLLM / Ollama)。
  支援 **guided decoding**,schema 由推論引擎在 token 層強制——這是弱模型能穩定輸出
  合法 JSON 的關鍵。
- **`opencode`**:透過 opencode CLI,沿用你既有的 provider 設定。
  **但 opencode 不會把 `response_format` 傳給後端**,schema 從「引擎強制」降級為
  「prompt 要求」,弱模型的格式服從度會下降。

用 opencode 前先跑 `npm run setup` 安裝 agent 定義(所有工具關閉——審查所需的內容
全部由 prloop 注入,執行環境裡沒有目標專案的原始碼可讀)。

```bash
npm run setup
PRR_RUNNER=opencode prloop '<PR URL>' --dry-run
```

## 靜態分析（需要工作目錄）

linter 需要原始碼落在磁碟上，但 prloop 平常是直接從 Azure DevOps 讀 blob 的。
因此靜態分析需要 `PRR_WORKDIR` 指向 PR 來源分支的 checkout——在 pipeline 中
就是 agent 自己的工作目錄。沒設就整段跳過，並在 summary 說明原因。

工具結果**先過 diff filter**（只留落在本次變更行上的），再依工具特性分三層：

| 層級 | 工具 | 處理方式 |
| --- | --- | --- |
| **事實** | `tsc`、`mypy` | 型別錯誤是事實，直接留言，不叫模型重新推導 |
| **triage** | `bandit`、`PMD`、`SpotBugs`、`ruff`、`eslint` | 有 recall 但誤報高，交由模型判斷實際脈絡下是否成立 |
| **抑制** | `checkstyle`、格式類規則 | 永不留言，只在 summary 計數 |

triage 那層是實證最強的混合做法（Semgrep 誤報 560 → 64）。工具負責 recall——
它不會忘記任何一個樣式；模型補上樣式比對看不到的脈絡：這個值真的來自外部嗎、
前面的檢查是不是讓這條路徑走不到、這個 API 用法在這個框架下是不是慣例。

**未設 `PRR_TRIAGE_MODEL` 時，triage 層的結果會被丟棄而不是直接留言。** 這是刻意的
fail-closed：未經判定的高誤報結果就是噪音。

SpotBugs 需要編譯後的 class，找不到 `target/classes` 就跳過——對著過期的 class 掃描
會回報早就修好的問題。

## 增量審查與留言生命週期

```bash
prloop '<PR URL>' --since auto    # 只審查上次之後的新 commit
```

`--since auto` 從我們自己的 summary 留言裡讀回上次審查的 iteration（狀態存在 PR 上，
不存在磁碟上——這樣 pipeline agent、你的筆電、cron 機器不需要共用檔案系統）。

每次發佈前還會做兩件事：

- **自動關閉過時留言**：我們自己貼的、指向的程式碼已經不存在的 thread 會被標為 fixed。
  判定條件刻意收得很窄——錯誤關閉一個還活著的問題，比留一則過時留言讓人手動關掉更糟。
- **記錄 dismissal**：被人工標記為 wontFix / byDesign 的留言會被記錄下來。
  這是未來收斂規則的原始素材——某一類 findings 老是被駁回，就代表不該再回報。
  現在只記錄不行動：用少量樣本去建排除規則會過度擬合。

## 審查規則（rules/）

`rules/*.md` 是可直接編輯的審查規則,每份用 frontmatter 的 `applyTo` 指定 glob。
**只有 glob 命中本次變更檔案的規則才會進 prompt**——沒改到 Java 就完全不載入 Java 規則,
所以規則集可以持續長大而不會撐爆每次的 prompt。

```markdown
---
applyTo: "**/*.java"
---
# Java 審查規則
...
```

內建 `_base.md`(全語言適用)收錄《Refactoring》第 3 章的 12 個 code smell,
並綁定兩條約束:repo 自己的規範永遠覆蓋 baseline、每個 smell 都是判斷題而非硬性違規
(severity 上限 medium)。第二條是防過度回報的內建機制。

用 `PRR_RULES_DIR` 可指向別處的規則目錄。

## Troubleshooting

**先跑 `npx tsx scripts/doctor.ts '<PR URL>' --smoke`**，多數問題會直接指出修法。

連不上而 doctor 說不清楚時，用 **probe** 直測：

```bash
npx tsx scripts/probe.ts '<PR URL>'
```

它會攤開 doctor 隱藏起來的東西：每個設定值**實際來自哪裡**（`.env` / shell 環境變數 /
預設值）、組出來的完整 URL、原始 HTTP 狀態與**伺服器自己的錯誤訊息**，最後逐一測試
各 api-version 找出這台伺服器接受哪個。

⚠️ **`.env` 永遠不會覆蓋已存在的環境變數**（避免蓋掉 CI 注入的值）。所以 shell 裡若有
`export PRR_XXX=...`，`.env` 的同名設定會被靜默忽略。probe 的第 1 節會標出這種情況。

- **on-prem（Azure DevOps Server）連不上。** 先跑 `doctor <PR URL>`，它會印出 **API base**
  與**實際請求位址**——這兩行就能看出問題。API 位址是從你給的 PR URL 推導的，
  `https://tfs.corp.com/tfs/{collection}/{project}/_git/...` 會正確解析出
  `https://tfs.corp.com/tfs/{collection}`（含虛擬目錄）。若仍不對，用 `PRR_ADO_BASE_URL` 覆蓋。
- **on-prem 出現 api-version 不支援。** 各版本上限不同：Server 2019 → `5.0`、
  2020 → `6.0`、2022 → `7.0`、雲端 → `7.1`。設 `PRR_ADO_API_VERSION` 調整。
- **`ECONNREFUSED` / 連線被拒。** 最常見的原因是**公司 proxy**。
  **Node 內建的 `fetch` 不會讀 `HTTP_PROXY` / `HTTPS_PROXY`**（curl、git、pip 都會讀，
  所以那些工具能通、Node 卻不行）。prloop 會自己讀這些變數並套用，但前提是變數有設。

  ```bash
  export HTTPS_PROXY=http://proxy.corp:8080
  # 內部主機（自架模型端點等）必須繞過 proxy，否則會被導去外部出口
  export NO_PROXY=localhost,127.0.0.1,.corp.local
  ```

  `probe` 的第 1 節會顯示目前的 proxy 設定，第 4 節會標明是直連還是經由 proxy——
  有 proxy 時 TLS 檢測會走 CONNECT 隧道，不會把防火牆的拒絕誤判成憑證問題。
- **TLS 憑證錯誤（企業 TLS 攔截）。** 瀏覽器能開但工具連不上，幾乎都是這個。
  **Node 有自己內建的 CA 清單，不讀作業系統的信任存放區**——所以公司的攔截設備
  （Zscaler、Blue Coat 等）重簽的憑證，瀏覽器接受、Node 不接受。

  `npx tsx scripts/probe.ts '<PR URL>'` 的「TLS 握手」那一節會把伺服器實際出示的
  憑證鏈印出來。若最末端的簽發者不是公開 CA（Microsoft、DigiCert 之類），就確定是攔截。

  **最快的解法**是讓 probe 自己把憑證抓出來：

  ```bash
  npx tsx scripts/probe.ts '<PR URL>' --export-ca ./corporate-ca.pem
  export NODE_EXTRA_CA_CERTS=$PWD/corporate-ca.pem
  ```

  驗證失敗時 probe 會把伺服器實際出示的憑證鏈寫成 PEM，省去跟 IT 要檔案的來回。
  ⚠️ 這份是從連線當下取得的——若攔截你的不是你信任的對象就不該採用；正式使用
  建議改用 IT 提供的公司根 CA。

  **Node 24 以上最簡單**——直接用系統信任存放區，不需要憑證檔：

  ```bash
  export NODE_OPTIONS=--use-system-ca
  ```

  版本差異（皆為實測）：

  | Node 版本 | `--use-system-ca` | 放進 `NODE_OPTIONS` |
  | --- | --- | --- |
  | 24+ | ✅ | ✅ 可以，搭配 `npx tsx` 最方便 |
  | 22.15–23.x | ✅ | ❌ 不允許，只能 `node --use-system-ca` 直接跑 |
  | 22.14 以下 | ❌ 沒有這個旗標 | — |

  這個旗標只是讓 Node 改讀作業系統的信任存放區，**不會放行未受信任的憑證**
  （對自簽憑證實測仍然拒絕）。

  其他做法：Linux 上系統憑證包通常已含公司 CA，可試
  `export NODE_EXTRA_CA_CERTS=/etc/ssl/certs/ca-certificates.crt`。

  確認用途可以暫時 `NODE_TLS_REJECT_UNAUTHORIZED=0`，但**不要留著**——那會關閉所有
  憑證驗證，等於接受任何中間人。確認完立刻改回 `NODE_EXTRA_CA_CERTS`。
- **203 / 登入頁錯誤。** PAT 無效或缺少 scope（需要 Code Read & Write）。若走 az CLI，
  多半是 `az login` 過期或登入到錯的 tenant，重跑 `az login` 即可。
- **az 相關錯誤。** `doctor` 會顯示目前的認證模式與 az 登入身分。要強制走某一種認證，
  設 `PRR_AUTH_MODE=pat` 或 `azcli`。az 的 token 會在程序內快取，不會每次請求都呼叫 az。
- **留言貼到錯誤的行。** 這正是本工具要根治的問題。若仍發生，檢查 `findings.json` 中該筆
  的 `anchor`，並比對 `runs/` 內的 `finder-*-raw.txt`：若模型的 quote 與檔案內容不同
  （例如自行改寫了縮排或內容），錨定會失敗而非貼錯位置。真的貼錯請附上該次 run 目錄回報。
- **大量 findings 落在「無法定位」。** 通常是模型不照指示逐字複製 quote。優先確認
  `PRR_LLM_STRUCTURED=1` 且後端真的支援 guided decoding；弱模型在沒有 schema 強制時
  格式服從度會明顯下降。
- **模型輸出無法解析。** 後端未支援 `response_format`。改用 vLLM（xgrammar guided
  decoding）或 LiteLLM proxy；或設 `PRR_LLM_STRUCTURED=0` 觀察原始輸出再調整。
- **留言太多。** 調低 `PRR_MAX_INLINE_COMMENTS`，或把 `PRR_MIN_INLINE_SEVERITY` 提到 `high`。
- **想擋住 merge。** 設 `PRR_POST_STATUS=1`，並在 branch policy 加入 genre `prloop` /
  name `ai-review` 的 status 檢查。不要用 bot 投 -10 票的方式，會與 reviewer policy 打架。
- **PR 很大導致部分檔案沒被審查。** summary 會列出未納入的檔案。調高 `PRR_MAX_DIFF_CHARS`
  或提高模型 context 上限。

## 本地模式（不需要 ADO 憑證）

從 git 分支建立 review context，用來在開 PR 前先審、或在沒有 ADO 存取權時驗證流程。
走的是**完全相同的** diff 與錨定程式碼路徑。

```bash
# 產生 finder 會收到的完整 prompt
npx tsx scripts/local-review.ts prompt <repo> <base> <head> [out.md]

# 帶著 findings JSON 跑真實的錨定與裁決，看每則留言會落在哪一行
npx tsx scripts/local-review.ts anchor <repo> <base> <head> <findings.json>
```

## 開發

```bash
npm run typecheck   # tsc --noEmit
npm run selftest    # 離線測試：diff、錨定、URL 解析、JSON 解析
npm run check       # 兩者都跑
npx tsx scripts/demo.ts  # 用假資料渲染留言，看留言長什麼樣（不連 ADO、不呼叫模型）
```

`scripts/selftest.ts` 是行號錨定的回歸網。**改動 `libs/diff.ts` 或 `anchoring/locate.ts`
之後一定要跑**，其中的斷言直接對應「留言貼錯行」的各種成因。

其中 `fixtures/seeded-pr.ts` 是一份植入已知缺陷的真實 PR（Python / Java / Next.js
三語言），每個預期行號都用 `grep -n` 對真實檔案驗證過。它涵蓋四個關鍵邊界：

- 同一行在檔案中出現兩次且模型未給 context → **必須判定歧義，不得猜第一個**
- 同樣的重複行但給了不同的 `context_before` → 必須分別錨定到正確的那一個
- 模型引用了不存在的程式碼 → 必須攔下（錨定同時是幻覺過濾器）
- 模型改寫了縮排 → 第二層匹配仍須定位成功

玩具測資（`a();`、`b();`）只能證明演算法會跑；這份 fixture 證明它在**看起來像真的
程式碼**上會落在正確的行。
