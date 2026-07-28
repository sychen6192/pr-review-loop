# prloop — 多模型對抗式 PR Review Pipeline 提案

> 2026-07-28 草案 v1。基於三方調查:GitHub 最熱門 PR review 專案架構、2026 業界最佳實務、
> Azure DevOps REST API 機制;並繼承一個已在正式環境驗證過的 loop engineering 工具的設計哲學（以下稱「前作」）。

## 1. 定位

對 Azure DevOps PR 執行自動 review 的 pipeline:先驗證 PR 是否滿足 Work Item 需求,
再以「多個開源模型互相對抗」產生高精度 findings,行號錨定由本工具確定性計算,
不信任任何 LLM 或 MCP 回報的行號。控制流 100% 在 TypeScript,LLM 只做判斷、不做決策。

支援語言:Python、Java、Next.js/React(TypeScript)。

## 2. 痛點 → 對策

| 痛點 | 對策 | 依據 |
| --- | --- | --- |
| 自架開源模型單顆精度不足 | 多模型「平行獨立 finder + 跨家族 skeptic 否決 + 共識投票」,不用多輪辯論 | NeurIPS 2025《Debate or Vote》:辯論的增益幾乎全來自投票;異質模型混編 MMLU 88.2% vs 單模型 79.0%;MoA 純開源模型組合勝過 GPT-4o(AlpacaEval 65.1 vs 57.5) |
| evaluation criteria 難以 by 語言訂定 | 分層:客觀標準交給各語言靜態工具(ruff/spotbugs/eslint…)當基準線,LLM 只審工具抓不到的語意層;rubric 拆成 per-language profile 設定檔 | CodeRabbit 三層網(57 個 linter 餵 LLM);IRIS/Datadog 實證 LLM triage 靜態分析誤報可減 88% |
| azure-mcp 行號常抓錯、comment 歪掉 | 完全不經 MCP 發 comment。模型必須引用原始碼片段(quote),由 pipeline 在 iteration blob 原始 bytes 中重新定位行號;找不到 quote 就 fail-closed 降級為 summary,絕不猜行號 | azure-devops-mcp #793(錯誤 threadContext 弄壞 ADO UI)、#868(MCP 拿不到行內容,模型只能瞎編行號)——這是結構性問題,不是 bug |
| 要先讀 req 確認有沒有滿足 | pipeline 第一個 LLM 階段就是 Requirement Gate:抓 PR 連結的 Work Item(含 `Microsoft.VSTS.Common.AcceptanceCriteria`),逐條比對 diff,產出需求覆蓋矩陣 | ADO PR work items API + PR-Agent「ticket compliance」做法 |
| 目前資訊都從 azure-mcp 來 | 資料面改直連 ADO REST(iterations / threads / statuses / work items 四組 API);azure-mcp 保留給人工互動查詢,pipeline 不依賴 | azure-mcp 設計哲學是 thin wrapper、無 iteration 簿記、無錨點驗證,做不了嚴肅的 bot |

## 3. 從各專案吸收了什麼

- **前作(已在正式環境驗證)**:單一確定性 orchestrator、驗證權不外包、injection over
  discovery、state in artifacts、fail-closed parse、startup guard、runner adapter。
  全數繼承,是本框架的骨架。
- **PR-Agent(12.3k★)**:token 預算式 diff 壓縮(附加優先於刪除、按語言排序、硬截斷)、
  sticky comment 原地更新、self-reflection 二次評分過濾建議、incremental review。
- **CodeRabbit**:judge model 對每個 finding 做證據審查後才發佈(「grep 沒撈到東西不構成
  bug 證據」)、cheap model 先壓縮大輸入、linter 結果餵進 LLM context、
  resolve-then-approve 的 comment 生命週期。
- **Ellipsis(架構公開)**:平行 comment generators → 去重 → 以 Evidence 做幻覺過濾 →
  信心門檻 → 行號修正的多層過濾管線;evidence(程式碼引用)是過濾的核心貨幣。
- **reviewdog(9.5k★)**:diff filter(只留落在變更行上的 linter findings)、
  以 fingerprint 比對既有 comment 去重、SARIF 正規化。
- **claude-code-security-review(5.7k★)**:generate → 獨立 FP-filter pass 的兩段式結構,
  與可設定的誤報排除類別清單。
- **Refute-or-Promote(arXiv 2604.19049)**:kill mandate(驗證者的任務是「摧毀」finding
  而非附和)、cold-start(驗證者只拿 claim 不拿 finder 推理,防 anchoring,p=0.008)、
  跨模型 critic 殺掉同家族全體漏看的錯誤。整條 pipeline 殺掉 ~79% 候選 findings。

## 4. 架構總覽(控制流)

```
觸發:ADO Service Hook(git.pullrequest.created/updated)或 CLI「prloop <PR URL>」
        │
        ▼
intake ────── ADO REST:PR 資訊、iterations、上次已審 iteration、changeEntries、
        │     左右 blob 原始 bytes、連結 Work Items(含 acceptance criteria)
        │     → 本地產生 unified diff + 行號索引(SSOT,之後所有階段共用)
        ▼
orchestrator.ts ←── 唯一 loop controller(確定性,繼承 前作)
        │
        │  A) Requirement Gate(LLM):acceptance criteria 逐條 × diff → 覆蓋矩陣
        │  B) Deterministic Gates(script):per-language profile 跑
        │     ruff/mypy/bandit｜checkstyle/spotbugs/error-prone/PMD｜eslint/tsc
        │     → SARIF 正規化 → diff filter(只留變更行)→ 分流:
        │     事實級(型別錯誤/編譯錯)直接發佈;高誤報類交給 LLM triage
        │  C) Finder(多模型平行,N≥3 顆異質模型 × 檔案序隨機化):
        │     「回報所有問題含低信心者,過濾是下游的事」;強制 JSON schema
        │     (vLLM guided decoding),每個 finding 必附 quote + evidence
        │  D) Skeptic(對抗驗證,跨模型家族,cold-start context):
        │     kill mandate——嘗試反駁每個 finding;可行時做 empirical check
        │     (patch 套得上嗎、引用的 symbol 存在嗎)
        │  E) Aggregate(純 code,零 LLM):
        │     quote 定位行號 → 以 (file, 錨定行, category) 去重 →
        │     共識計分(幾顆 finder 獨立發現 × skeptic 存活)→ severity 分層 →
        │     comment 上限 → no-comment gate(乾淨就安靜)
        ▼
publish ───── ADO REST threads API:sticky summary(原地更新,含需求覆蓋矩陣)
        │     + 少量 inline threads(自算 rightFileStart/End + changeTrackingId
        │     + iterationContext)+ PR Status API(可掛 branch policy 當 merge gate)
        ▼
state ─────── runs/<org>/<repo>/<PR>/iter-N/ 全 artifacts 落盤;
              finding fingerprints 跨 push 去重;下次 push 只審
              iterations $compareTo=<上次> 的增量
```

## 5. 三大核心設計

### 5.1 行號錨定:quote-based re-anchoring(根治 comment 歪掉)

問題本質:ADO threads API 要的是「該 iteration 檔案版本中 1-based 絕對行號」,而 LLM
看到的是 diff,天然會回 hunk 相對行號或 GitHub 式 position;azure-mcp 不做任何驗證,
照單全收後 UI 直接歪(甚至曾把整個 PR 頁面弄到 crash,#793)。

解法——行號從頭到尾不由 LLM 決定:

1. Finder 的 JSON schema 中**沒有行號欄位**,只有 `quote`(該行原始碼精確引用,
   含前後各一行的 `context_before/after` 消歧義)。
2. Aggregate 階段在 intake 抓好的**右側 blob 原始 bytes**(依 objectId 取,不經本地
   checkout,避開 CRLF/BOM 正規化差異)中搜尋 quote → 得到絕對行號。
3. 發佈時完整帶上 `threadContext.rightFileStart/End`(offset 用 1,start/end 都給)、
   `pullRequestThreadContext.changeTrackingId`(從 changeEntries 來,iteration 支援的
   PR 必填)與 `iterationContext {firstComparingIteration: 1, secondComparingIteration: N}`。
4. quote 找不到或多處命中無法消歧 → **fail-closed**:該 finding 降級進 summary comment
   的「無法定位」區塊,絕不猜行號發 inline。
5. 刪除行的 finding 錨在 `leftFileStart/End`(左側=target 版本),不錨右側。

副作用紅利:quote 同時是 Ellipsis 式幻覺過濾的證據(引用不存在的程式碼=幻覺,直接殺)
與跨模型 finding 匹配的 key。

### 5.2 多模型對抗:平行投票,不辯論

研究結論很一致:**多輪辯論不值得,異質性才是有效成分**。所以架構是:

- **Finder × N(N=3 起)**:各自獨立、平行、看同樣的 diff+context,檔案順序隨機化
  (Cursor BugBot 做法)。prompt 走 coverage 模式:「全部回報,含不確定的,附
  confidence」——過濾交給下游,避免新模型過度服從『只報嚴重的』而傷 recall。
- **Skeptic(不同模型家族)**:對每個 finding 用 cold-start context(只給 claim + 相關
  程式碼,不給 finder 推理)嘗試反駁。反駁成功即殺。
- **共識裁決(純 code)**:`score = severity × 獨立發現數 × skeptic 存活`。
  預設門檻:≥2 顆 finder 獨立發現、或 1 顆發現但 skeptic 明確確認,才發 inline。
- 結構化輸出由 **vLLM guided decoding(xgrammar)/ Ollama format** 在引擎層強制——
  弱模型的能力預算全花在判斷,不用浪費在格式服從。這正是弱模型 ensemble 可行的關鍵。

模型配置(經 LiteLLM proxy 統一路由,pipeline 核心零 SDK 依賴):

| 角色 | 建議 | 說明 |
| --- | --- | --- |
| Finder A | Qwen3-Coder 系(27B 級 dense 模型即可) | recall 主力 |
| Finder B/C | Devstral Small 24B / GLM-4.5-Air / gpt-oss-20b 擇二 | 重點是**不同家族** |
| Skeptic | gpt-oss-120b 或 DeepSeek-R1 蒸餾版(要會長推理) | kill mandate 需要推理深度 |
| Triage(選配) | Qwen3-30B-A3B 等便宜快模型 | 大 PR 先分類 hunk 風險、壓縮輸入 |

單卡部署的現實(前作已踩過):多模型不必同時常駐——pipeline 是批次的,
Finder 全跑完 → 卸載 → 載 Skeptic,階段間換模可接受;或 27B(Q4)+ 20B 級各一常駐;
多台機器時 LiteLLM 直接 fan-out。Runner adapter 讓這些部署差異不進核心。

### 5.3 語言別 evaluation criteria:分層 + profile 化

不要試圖為每個語言寫一份大 rubric 讓 LLM 打分(前作 已證明弱模型 follow 長 rubric
不穩)。改為三層,每層責任不同:

1. **事實層(零 LLM)**:`tsc --noEmit`、error-prone、mypy 的輸出是事實,直接當 gate
   或直接發佈;編譯不過就短路整條 LLM review(省錢省噪音)。
2. **Triage 層(LLM 審工具)**:bandit、spotbugs、PMD 這類高誤報工具的 findings,
   由 LLM 結合 diff 上下文判斷 exploitability(實證:Semgrep 誤報 560→64)。
   checkstyle/eslint 風格類永不逐條發 comment——要嘛 CI 擋、要嘛彙總一行。
3. **語意層(LLM 主場)**:只審工具抓不到的——邏輯、併發、API 誤用、React hooks 依賴
   正確性、server/client component 邊界、hydration、Java 資源洩漏與交易邊界等。
   Finder prompt 明確附上「以下是 linter 已涵蓋的清單,不要重複回報」。

每語言一個 profile 檔(`profiles/python.ts` 等)定義:跑哪些工具與參數、SARIF 對映、
哪些 rule 屬 triage 層、語意層 review focus 清單、severity 對映。新增語言=新增一個
profile,不動核心。

## 6. 兩軸審查:需求軸與程式碼軸

### 6.1 為什麼要分軸(而且刻意不合併)

一個 PR 可以在一軸過、另一軸掛:**遵守所有規範但做錯東西**(程式碼軸過、需求軸掛),
**做對事情但違反專案慣例**(需求軸過、程式碼軸掛)。兩軸合併排名時,
一軸會掩蓋另一軸——尤其在有 comment 上限的情況下:一個「需求根本沒做完」的 finding
會被三個 critical 的 code 問題擠掉,反之亦然。

因此:**兩軸各自獨立產生、各自獨立的 comment 額度、summary 分區呈現、不跨軸重排名。**

### 6.2 需求軸(Requirement Gate)

1. `GET .../pullRequests/{id}/workitems` 取 ResourceRef(注意:PR 物件上的
   `workItemRefs` 不會自動填,必須打這支專用 API)。
2. 取 Work Item fields(`$expand=relations`):PBI/User Story 的
   `Microsoft.VSTS.Common.AcceptanceCriteria`(HTML,需轉純文字);PR 若掛在 Task 上,
   向上走一層 `System.LinkTypes.Hierarchy-Reverse` 找帶 AC 的父項;Bug 取 `ReproSteps`。
3. LLM 逐條比對 AC 與 diff。**判定用「失敗的方式」而非「覆蓋的程度」**——
   後者只說做了多少,前者才給得出行動指引。三種失敗模式(superpowers 的
   Missing/Extra/Misunderstood 與 mattpocock code-review skill 的 Spec 軸獨立收斂到同一組):

   | verdict | 意義 |
   | --- | --- |
   | `satisfied` | 有做到,且 diff 中找得到對應證據 |
   | `missing` | 完全沒做 |
   | `partial` | 做了一部分,有明確缺口 |
   | `misunderstood` | 做了,但做錯方向——解錯問題,或用錯方式滿足 |
   | `not-verifiable` | 無法從 diff 判斷(例如需要看設定或外部系統) |

   另外獨立回報 **`extra`(範圍蔓延)**:diff 中沒有任何 AC 要求、也不是必要重構的變更。
4. 結果佔據 sticky summary 最上方的獨立區塊;`missing` / `misunderstood` 可設定為
   PR Status `failed` → 掛 branch policy 成為真 merge gate(比 vote -10 乾淨;
   bot vote 建議只用 -5「waiting for author」或不投)。
5. 找不到連結 Work Item 時的行為可設定:警告即可(預設)或 gate 擋下。

### 6.3 程式碼軸

即 §7 的分類/嚴重度體系與 §5.2 的多模型對抗。與需求軸完全獨立執行,
兩軸都不知道對方的結果——避免「需求有做到」被拿來降低程式碼問題的嚴重度,反之亦然。

## 7. 審查維度:分類、嚴重度、規則層

### 7.1 為什麼不用前作的評分制

前作 審的是「一個測試檔的整體品質」,六維加權打分有意義。PR review 審的是「一組具體
缺陷」,「這個 PR 可讀性 7 分」給不了 reviewer 任何行動指引。所以 prloop 用
**分類 + 嚴重度 + 信心**,不是評分。這也和業界一致:調查過的商用工具沒有一個對 PR 打總分,
唯一的例外是 PR-Agent 的 `score` 0-100,而它是報告用途、不影響任何決策。

### 7.2 Category(9 類)

以 CodeRabbit 收斂出的六大類為基礎(調查中命名最完整的一套),另外保留三類:

| category | 為什麼獨立成一類 |
| --- | --- |
| correctness / security / reliability / data-integrity / performance / maintainability | 業界共識的六類,直接對應開發者的心智模型 |
| **concurrency** | 別家折進 reliability,但併發是 Java 服務最常見也最難測的缺陷類型,值得獨立的審查視角而非被稀釋 |
| **leftover-code** | 只有 Graphite 命名這一類(debug 輸出、被註解的程式碼、殘留 TODO),而它的採納率一直是最高的幾類之一 |
| **req-mismatch** | M2 用:變更沒有滿足連結的 Work Item |

### 7.3 Severity(4 級,依判斷順序定義)

嚴重度不能只給形容詞,弱模型會全部標成 high。改用**依序判斷的決策鏈**,取自
Bugzilla / Mozilla / Atlassian / Microsoft 四套 severity 定義共同的五個判別因子
(有無繞過方式、是否資料遺失或安全、影響廣度、是否擋住他人、是否純外觀):

1. 資料遺失/損毀、安全漏洞可被利用、服務中斷 → **critical**
2. 功能會壞且**無繞過方式**,或這段程式碼修好前不能信任 → **high**
3. 功能會壞但**有繞過方式**,或只在特定路徑出錯 → **medium**
4. 以上皆非 → **low**

「有無繞過方式」是這五個因子中最關鍵、也是四套定義都採用的判別點。

另外採用 superpowers `task-reviewer-prompt.md` 的一條規則:
**作者的說詞不會降低嚴重度**。PR 描述寫「這是刻意的」「YAGNI」都是主張不是證據,
依程式碼事實判斷。這條在 LLM review 特別重要——模型很容易被 PR 描述說服。

### 7.4 規則層(M4):evaluation criteria by language 的解法

不要寫一份大 rubric 讓模型記住所有語言的規則(前作 已證實弱模型 follow 長 rubric
不穩)。改為**按 glob 掛載、只注入相關規則**:

```
rules/
  _base.md                    # 全語言共用:Fowler 12 code smells
  python.md                   # applyTo: **/*.py
  java.md                     # applyTo: **/*.java
  nextjs.md                   # applyTo: **/*.{tsx,jsx}, app/**
  <team>/payment.md           # applyTo: services/payment/**
```

`_base.md` 放《Refactoring》第 3 章的 12 個 code smell(Mysterious Name、Duplicated Code、
Feature Envy、Data Clumps、Primitive Obsession、Repeated Switches、Shotgun Surgery、
Divergent Change、Speculative Generality、Message Chains、Middle Man、Refused Bequest),
每條寫成「是什麼 → 怎麼修」。這組有兩條綁定約束,缺一不可:

- **repo 自己的規範永遠覆蓋 baseline**——專案文件認可的寫法,baseline 不得反對
- **每個 smell 都是判斷題,不是硬性違規**——回報時標為「possible Feature Envy」

第二條是內建的防過度回報機制:code smell 本質上是啟發式,若當成規則執行會製造大量噪音。

每個規則檔的 frontmatter 帶 `applyTo`(glob)、`severity_min`、`categories`;
loop 依本次變更的檔案路徑決定注入哪幾份,**沒有變更到的語言,其規則完全不進 prompt**。
這同時解決三件事:prompt 不膨脹、規則可由 team lead 直接編輯不用改 code、
新增語言 = 新增一個檔案。

規則內容格式採 Graphite 驗證過的四段式:**規則 → 壞例子 → 好例子 → 為什麼**。
研究顯示只寫規則不給對照例子的效果明顯較差。

**相容既有慣例檔**:自動讀取 repo 內既有的 `CLAUDE.md`、`AGENTS.md`、
`.cursor/rules/*.mdc`,作為額外規則來源。CodeRabbit、Kodus、GitHub Copilot code review
(2026-07 起)都已支援這組檔案,等於團隊寫一次規則可以跨工具通用,不用為 prloop 重寫。
最相關的先例是 `supabase/supabase` 的 `.coderabbit.yaml`——直接把 Claude Code 的
`SKILL.md` 當成 glob-scoped 的 review 規則餵給 reviewer。

各語言規則的初始內容有現成的高品質來源可以直接轉寫(都是有 rule ID 可查證的):

- **Python**:ruff 的 `B006` 可變預設值、`B023` 迴圈變數閉包、`RUF006` fire-and-forget
  task、`SIM115` 未用 context manager 開檔、`ASYNC2xx` async 中的阻塞呼叫、
  `PLW1641` 有 `__eq__` 沒 `__hash__`、`TRY400` 該用 `logging.exception`
- **Java**:SpotBugs 的 `AT_*`(ConcurrentHashMap 上的非原子複合操作)、`VO_VOLATILE_INCREMENT`、
  `STCAL_*`(static SimpleDateFormat)、`OBL_*`(資源義務未履行);Sonar 的
  `java:S6809`(`@Transactional` self-invocation)、`java:S3655`(未檢查就 `Optional.get()`)、
  `java:S3959`(stream 重複使用);以及 Spring `@Transactional` 的 checked exception
  預設不回滾、`readOnly=true` 靜默丟棄變更、`@Async` 下交易不傳播
- **Next.js/React**:Server Action 必須自己重新驗證授權(page 層驗證不會延伸進去,
  且 Server Action 可被直接 POST 呼叫)、`'use client'` 放在 layout/barrel 會把整棵子樹
  拉進 client bundle、hydration 不匹配的七種成因、`useEffect` 的 12 種不該用的情境、
  Next 16 的 `"use cache"` / `cacheLife` / `updateTag` 新模型

**注意**:`Collectors.toMap` 重複 key、parallel stream 共用可變狀態這兩類,
Sonar 和 Error Prone **都沒有規則**——正好是 LLM 語意層該補的位置,規則檔要明確涵蓋。

### 7.5 Findings Schema(SSOT,所有階段共用)

```jsonc
{
  "category": "correctness|concurrency|security|reliability|...",  // 見 §7.2 九類
  "severity": "critical|high|medium|low",
  "confidence": 0.0,           // finder 自評,aggregate 只做參考權重
  "file": "/src/foo/bar.py",
  "quote": "exact source line(s)",   // 沒有行號欄位——行號是 aggregate 算的
  "context_before": "...", "context_after": "...",
  "side": "right|left",             // left = 針對被刪除的程式碼
  "claim": "一句話說明缺陷",
  "evidence": "為什麼這是真問題(可指向 linter finding id / AC 條目)",
  "suggested_fix": "可選;若給,aggregate 會驗證 patch 套得上才附上",
  "boundary_owner": "current|external"  // external 不進收斂判斷,防震盪
}
```

## 8. 專案結構(比前作大一號,但同哲學)

```
pr-review-loop/
  loop.ts                 # 入口:參數驗證、startup guard、runs/ 建立
  orchestrator.ts         # 唯一 loop controller(確定性)
  config.ts               # SSOT:全部門檻與參數,PRR_* env 可覆蓋
  ado/                    # Azure DevOps 整合層(全部直連 REST)
    client.ts             #   認證(PAT / pipeline AccessToken)、重試
    iterations.ts         #   iteration 簿記、$compareTo 增量、changeEntries
    blobs.ts              #   依 objectId 取原始 bytes、本地 unified diff
    threads.ts            #   thread CRUD、fingerprint 去重、sticky summary
    statuses.ts           #   PR Status API(merge gate)
    workitems.ts          #   PR→WI→AC 抓取(含向上走一層)
  anchoring/
    locate.ts             #   quote → 絕對行號(含消歧、fail-closed 降級)
  gates/
    requirement.ts        #   A) 需求覆蓋矩陣
    static.ts             #   B) 跑 profile 工具 + SARIF 正規化 + diff filter
    finder.ts             #   C) 多模型平行 finder
    skeptic.ts            #   D) 對抗驗證(cold-start + kill mandate)
    aggregate.ts          #   E) 去重/投票/severity/上限/no-comment gate(零 LLM)
  profiles/
    python.ts  java.ts  nextjs.ts   # 語言 profile(工具、triage 規則、review focus)
  models/
    runner.ts             #   ModelRunner interface(LiteLLM/Ollama/vLLM adapters)
    schemas.ts            #   findings/verdict JSON schema(引擎層強制)
  prompts/                # 各角色 prompt 模板(rubric 由 loop 注入,不靠 discovery)
  libs/                   # log、shell、guard、types、fingerprint
  runs/                   # artifacts:每 PR 每 iteration 全落盤,可重現可審計
```

## 9. 設計原則(前作七條全繼承,新增四條)

8. **行號主權在 pipeline**:任何要落到檔案座標的資訊,LLM 只准給 quote,
   座標由 anchoring 層確定性計算;算不出來就降級,絕不猜。
9. **Coverage 前置、過濾後置**:finder 不做自我審查(會傷 recall),
   精度全靠 skeptic + 共識投票 + no-comment gate。
10. **異質性優先**:finder/skeptic 盡可能跨模型家族;同家族多顆的價值遠低於
    跨家族兩顆(correlated error 殺不掉)。
11. **安靜是功能**:乾淨 PR 就只更新 summary 說「no high-confidence issues」;
    comment 數上限預設 10;風格問題永不 inline。

## 10. 已否決方案(防止重新提案)

- **多輪 LLM 辯論(debate)**:實證顯示增益≈純投票,token 成本數倍,且有
  conformity cascade 風險。採平行獨立 + 單輪對抗驗證。
- **經 azure-mcp 發 comment / 取 diff**:MCP 是 thin wrapper,無錨點驗證、無
  iteration 簿記、(舊版)無行內容;行號歪掉是結構性後果。pipeline 直連 REST。
- **讓 LLM 回報行號(即使要求它從 diff 讀)**:hunk 相對 vs 絕對行號的混淆無法用
  prompt 根治;quote-based 錨定同時解掉幻覺過濾與跨模型匹配,一石三鳥。
- **預建 embeddings 索引(RAG)**:每 commit 就過期,similarity 撈到「長得像」而非
  「結構相依」的程式碼(CodeRabbit 明確棄用)。context 走 diff + 一跳依賴(tree-sitter
  /LSP),之後有需求再評估混合檢索。
- **LLM orchestrator / agent 自主決定重試**:前作 已否決,理由不變。
- **binary 零缺陷 review gate**:LLM judge 幾乎不回空 issues,會震盪;
  改為 findings 分層 + 門檻制。
- **bot vote -10 擋 merge**:粗暴且與 policy 打架;用 PR Status + branch policy。
- **一開始就上 per-repo 學習記憶(CodeRabbit learnings 式)**:先把 dismissal
  記錄落盤(fingerprint + 處置),累積夠了再做排除規則,不預先蓋系統。

## 11. 分階段交付

- ✅ **M1(可用骨架)**:intake(REST 直連 + 本地 diff + 行號索引)→ 單模型 finder →
  quote 錨定 → sticky summary + inline threads。先解「行號歪掉」與「不經 MCP」。
- ✅ **M2(需求 gate)**:Work Item → AC 覆蓋矩陣 → summary 置頂 + PR Status。
- ✅ **M3(對抗與投票)**:多 finder 平行 + skeptic + 共識裁決 + no-comment gate。
- ✅ **M4(規則層 + 靜態工具層)**:§7.4 的 glob-scoped 規則檔、既有慣例檔(CLAUDE.md /
  AGENTS.md / .cursor/rules)自動載入;三語言 profile、SARIF 正規化、diff filter、LLM triage。
- ✅ **M5(增量與生命週期)**:iterations $compareTo 增量 review、fingerprint 跨 push
  去重、thread 自動 resolve(被 flag 的程式碼已改就關)、dismissal 記錄。

每個里程碑都端到端可跑(對真 PR 發得出正確錨定的 comment),不是水平切層。

## 12. 如何評估(避免「感覺有變好」)

- **離線**:從歷史 PR 挑 30-50 個「後來真的出過 bug 又被修掉」的案例做 golden set
  (Entelligence 方法);另備已知乾淨 PR 做誤報審計。指標:precision / recall /
  每 PR comment 數。多模型 vs 單模型的效果差異在這裡用數字驗證。
- **線上**:implementation rate(comment 後真的改了)、dismissal rate、
  repeat-comment rate、no-comment rate。北極星:高信心 comment 的採納率。
- 業界現況校準:最強商用工具 F1 也僅 ~45-47%、單次 pass F1 ~19%——目標訂在
  「發出的 comment ≥60% 被採納、乾淨 PR 保持安靜」比追 recall 實際。

## 13. 主要參考

PR-Agent diff 壓縮/自省(docs/core-abilities)· CodeRabbit pipeline(The AI Engineer)·
Ellipsis 過濾管線(nsbradford.com)· reviewdog diff filter · Refute-or-Promote
(arXiv 2604.19049)· Debate-or-Vote(NeurIPS 2025)· Mixture-of-Agents(arXiv
2406.04692)· IRIS / Datadog SAST triage · ADO REST 7.1(pull-request-threads /
iterations / statuses / work-items)· azure-devops-mcp issues #793 #868 ·
vLLM structured outputs
