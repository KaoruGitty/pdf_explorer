# PDF Explorer — 設計書

> 本書は **PDF Explorer**（旧称 PDF Structure Explorer）を、ソースコードなしで再実装できる粒度の仕様書である。  
> 対象バージョン: リポジトリ内 `pdfjs-inspector/` 単体構成（standalone）。

---

## 1. プロダクト概要

### 1.1 目的

ブラウザ上で PDF ファイルを開き、**PDF.js の公開 API** を通じてページごとに以下を **情報抽出・可視化** するローカル Web アプリ。

- テキスト（`getTextContent`）
- 描画命令（`getOperatorList`）
- フォント（TextContent + 生 PDF バイナリ簡易パース）
- 画像 XObject（OperatorList + `page.objs`）
- ベクター描画（Operator フィルタ + SVG デバッグビュー）
- ページ / ドキュメント構造
- JSON エクスポート

**学習・調査ツール** として PDF 内部構造を観察する用途。PDF エディタや本格的 DTP ではない。

### 1.2 非目的（意図的にやらないこと）

- CMap / 標準フォントの同梱（`lib/cmaps/` 等なし）
- 日本語 PDF の文字化けをアプリ側で修復しない（Unicode 欠落は **警告表示** のみ）
- サーバー・ビルド・npm 不要（`file://` で動作）
- PDF の編集・保存
- 注釈編集、フォーム入力、印刷最適化

### 1.3 動作環境

| 項目 | 値 |
|------|-----|
| 実行 | ブラウザで `index.html` を開く（HTTP サーバー不要） |
| PDF 読込 | `File API`（`<input type="file">` / Drag & Drop） |
| PDF.js | **3.11.174**（`lib/pdf.min.js`, `lib/pdf.worker.min.js` を vendoring） |
| Worker | `pdfjsLib.GlobalWorkerOptions.workerSrc = "lib/pdf.worker.min.js"` |
| 言語 | UI 文言は日本語 |

---

## 2. リポジトリ構成

```
pdfjs-inspector/
├── index.html              # エントリポイント
├── app.js                  # 全ロジック（~1560行、ES module 不使用）
├── style.css               # Explorer 専用テーマ（DevTools/macOS 風）
├── .gitignore
├── lib/
│   ├── pdf.min.js          # Mozilla PDF.js 3.11.174 公式ビルド
│   └── pdf.worker.min.js
├── shared/
│   ├── minimal-ui.css      # 共通 UI 土台（レイアウト・コンポーネント）
│   └── minimal-ui.js       # MinimalUI（ページリストアニメーション）
└── dev/                    # git 管理外推奨（ローカル開発用）
    ├── generate-sample.mjs # sample.pdf 生成
    ├── test-images.mjs
    └── test-runner.html
```

### 2.1 Git に含める最小セット

```
.gitignore, index.html, app.js, style.css,
lib/pdf.min.js, lib/pdf.worker.min.js,
shared/minimal-ui.css, shared/minimal-ui.js
```

### 2.2 .gitignore

```
.DS_Store
sample.pdf
*.pdf
```

---

## 3. スクリプト読込順（index.html）

```html
<script src="shared/minimal-ui.js"></script>
<script src="lib/pdf.min.js"></script>
<script src="app.js"></script>
```

CSS:

```html
<link rel="stylesheet" href="shared/minimal-ui.css">
<link rel="stylesheet" href="style.css">
```

`<html lang="ja" class="baseline-app">` — 全テーマは `.baseline-app` スコープ。

---

## 4. アプリケーション状態

### 4.1 二画面モード

| モード | 表示要素 | トリガー |
|--------|----------|----------|
| **Welcome** | `#welcome-screen` | 初期状態 / PDF 未読込 |
| **Workspace** | `#toolbar`, `#workspace`, `#app-footer` | `loadFile()` 成功後 |

切替:

```javascript
document.documentElement.classList.add("has-document");
document.getElementById("welcome-screen").classList.add("hidden");
document.getElementById("workspace").classList.remove("hidden");
document.getElementById("toolbar").classList.remove("hidden");
document.getElementById("app-footer").classList.remove("hidden");
```

Welcome 中: `html.baseline-app:not(.has-document) body { overflow: hidden; height: 100%; }`  
Workspace 中: `html.baseline-app.has-document body { display: flex; flex-direction: column; }`

### 4.2 PDFJSInspectorApp インスタンス状態

```javascript
{
  pdf: PDFDocumentProxy | null,
  fileName: string,
  pdfBytes: ArrayBuffer | null,
  pdfBinary: PdfBinaryInspector.parse 結果 | null,
  currentPage: number,          // 1-based
  scale: number,                // デフォルト 1.0
  pageAnalysis: object | null,  // PageAnalyzer.analyzePage 結果（現在ページ）
  docInfo: object | null,       // DocumentInspector.inspect 結果
  allImagesScan: object | null,   // 全ページ画像走査結果（手動トリガ）
  renderTask: RenderTask | null,
  activeTab: string,             // "text"|"operators"|"fonts"|"images"|"vector"|"structure"|"export"
  _vectorPreview: { pageNumber, scale, svg, stats, error } | null,
  _showPageGen: number,          // ページ切替キャンセル用
  _scanGen: number,
  _pageQueue: Promise,          // PDF.js 操作直列化キュー
}
```

グローバル: `window.pdfjsInspector = new PDFJSInspectorApp()`（DOMContentLoaded）。

---

## 5. UI 構造（DOM）

### 5.1 全体

```
body
├── header#toolbar.app-titlebar.hidden
│   ├── #drop-zone                    … 別 PDF を開く（compact）
│   ├── #doc-info.hidden              … ファイル名 / PDF版 / ページ数
│   └── #nav-controls.hidden          … 前後・ズーム
├── section#welcome-screen
│   └── .welcome-split                … 左右 50:50 grid
│       ├── .welcome-left             … タイトル・説明・CTA
│       └── .welcome-demo             … CSS デモ（aria-hidden）
├── main#workspace.hidden             … 3ペイン grid
│   ├── aside.app-sidebar             … ページリスト
│   ├── section.app-canvas-pane       … Canvas ビューア
│   └── aside.app-inspector           … Inspector タブ
└── footer#app-footer.hidden          … ステータスバー
```

### 5.2 Welcome 左ペイン

- タイトル: `PDF Explorer`
- 説明: PDF からテキスト・画像・フォント等を抽出・確認
- **唯一の CTA**: `#drop-zone-welcome` → 共有 `#file-input`（hidden, accept=".pdf"）
- レイアウト: 左半分を `justify-content: center; align-items: center`（上下左右中央寄せ）

### 5.3 Welcome 右デモ（重要: JS 不使用）

`#welcome-screen .welcome-demo` 内に **本物 workspace の見た目だけ** を静的 HTML で配置。

構成:

```
.demo-shell
├── .demo-titlebar（sample.pdf, PDF 1.7, 3 ページ, 1/3）
└── .demo-workspace（grid: 3.4em | 1fr | 38%）
    ├── .demo-sidebar（Page 1,2,3）
    ├── .demo-viewer（.demo-doc ×3 重ね、opacity アニメ）
    └── .demo-inspector（タブ + .demo-panel ×4 重ね）
```

**16秒ループ** CSS `@keyframes` で同期:

| 時間帯 | ページ | タブ | Viewer doc |
|--------|--------|------|------------|
| 0–24% | 1 | Text | doc-1 |
| 25–49% | 2 | Ops | doc-2 |
| 50–74% | 3 | Fonts | doc-3 |
| 75–100% | 1 | Images | doc-1 |

追加演出:

- `.demo-chip-page::after` で `content: "1/3"` → `"2/3"` → `"3/3"` 切替
- `.demo-canvas-stage::after` スキャンライン（4秒ループ）

PDF.js・app.js は **一切使わない**。`aria-hidden="true"`。

### 5.4 Workspace 3ペイン

```css
.workspace {
  flex: 1;
  display: grid;
  grid-template-columns: var(--sidebar-w) 1fr var(--inspector-w);
  /* --sidebar-w: 196px; --inspector-w: min(400px, 38vw); */
}
```

#### 左: Pages

- `#page-list` — `buildPageList()` で `Page N` の `<li>` を生成
- クリック → `goPage(n)`
- active クラスでハイライト
- `MinimalUI.staggerList(ul)` で表示アニメ

#### 中央: Viewer

- `#pdf-canvas` — `page.render({ canvasContext, viewport })`
- 背景: チェッカーパターン（`.viewer-wrap`）
- **余白ゼロ** edge-to-edge レイアウト（padding/box-shadow なし）

#### 右: Inspector

タブ（`data-tab`）:

| data-tab | パネル ID | 描画関数 |
|----------|-----------|----------|
| text | tab-text | renderTextTab |
| operators | tab-operators | renderOperatorsTab |
| fonts | tab-fonts | renderFontsTab |
| images | tab-images | renderImagesTab |
| vector | tab-vector | renderVectorTab |
| structure | tab-structure | renderStructureTab |
| export | tab-export | renderExportTab |

**読み込みオーバーレイ**: `#inspector-loading`（ページ切替中に全タブの代わりに1件表示）

```html
<div id="inspector-loading" class="inspector-loading hidden">
  <!-- spinner + "Page N を読み込み中…" -->
</div>
```

### 5.5 ツールバー

左: `#drop-zone`（Open PDF…）  
右（`#doc-info { margin-left: auto }` 以降）: ファイルチップ + ページ操作 + ズーム

- `#btn-prev` / `#btn-next`
- `#page-indicator` — `N / total`
- `#btn-zoom-out` / `#btn-zoom-in` / `#btn-zoom-fit`
- `#zoom-label` — パーセント表示

キーボード: `ArrowLeft` / `ArrowRight`（input フォーカス中は無効）

### 5.6 ステータスバー

- `#status-bar` — 現在の操作状態
- `.status-dot` — `body.is-busy` 時に黄色（読み込み/解析/走査中）

---

## 6. CSS アーキテクチャ

### 6.1 二層構造

1. **`shared/minimal-ui.css`** — 汎用トークン・コンポーネント  
   `.toolbar`, `.workspace`, `.pane`, `.tab`, `.item-card`, `.drop-zone`, `.hidden` 等

2. **`style.css`** — `.baseline-app` スコープで Explorer 専用上書き  
   - DevTools / macOS 風ダークテーマ（デフォルト）
   - `@media (prefers-color-scheme: light)` でライト
   - Welcome / Demo 用 `.demo-*`, `.welcome-*`
   - **minimal-ui 競合の明示上書き**（ファイル末尾 `html.baseline-app` ブロック）  
     特に `.welcome-screen { display:block; padding:0 }`（minimal-ui の中央寄せを無効化）
   - edge-to-edge フルスクリーン（カード UI・大きな box-shadow 禁止）

### 6.2 主要 CSS 変数（style.css `.baseline-app`）

```css
--header-h: 52px;
--footer-h: 28px;
--sidebar-w: 196px;
--inspector-w: min(400px, 38vw);
--accent: #0a84ff;
--canvas: #1c1c1e;      /* ダーク背景 */
--surface: #252528;
--checker-a / --checker-b  /* ビューア背景 */
```

### 6.3 タブパネル表示

```css
.baseline-app .tab-panel { display: none; }
.baseline-app .tab-panel.active { display: block; flex: 1; overflow-y: auto; }
```

読み込み中は `.tab-panel` の active を全解除し `#inspector-loading` のみ表示。

---

## 7. JavaScript モジュール構成（app.js）

単一ファイル。以下の **オブジェクトリテラル + 1 クラス**。

```
ユーティリティ関数
├── escapeHtml(s)
├── opCodeToName(code)
├── transformToXY(transform)
├── formatArgs(args)
└── pdfBytesToLatin1(buffer)

PdfBinaryInspector      … 生 PDF バイナリ簡易パース
PageAnalyzer            … 1 ページ解析
VectorOperatorFilter    … ベクター OPS フィルタ
VectorRenderer          … SVG 生成
DocumentInspector       … ドキュメント全体
PDFJSInspectorApp       … UI コントローラ（class）
```

---

## 8. PdfBinaryInspector

### 8.1 目的

PDF.js Worker **内部** に隠れる `/Font` 辞書等を、**生バイナリの regex パース** で補完観察。

### 8.2 アルゴリズム

1. `ArrayBuffer` → latin1 文字列
2. `/(\d+) (\d+) obj([\s\S]*?)endobj/g` で全オブジェクト抽出 → `Map<num, {num, gen, body}>`
3. `extractFontObjects()` — `/BaseFont` を含む obj を Font 候補に
4. `summarizeTypes()` — Page/Pages/Font/XObject/Catalog/Metadata カウント
5. `getPageResourceFonts(objects, pageObjectNum)` — ページ obj の `/Font << ... >>` 辞書を手動パース
6. `lookupFont(objects, objectNum)`

### 8.3 制限

- 完全な PDF パーサではない（正規表現ベース）
- 継承 Resources・圧縮ストリーム内オブジェクトは取れない場合あり
- `loadFile()` 時に **1 回だけ** `parse(buf)` し `this.pdfBinary` に保持

---

## 9. PageAnalyzer

### 9.1 analyzePage(page, pageNumber, scale, opList)

入力: 既に取得済みの `opList`（`showPage` 内で render 後に取得）

処理順:

1. `viewport = page.getViewport({ scale })`
2. `textContent = await page.getTextContent()`
3. `text = parseTextContent(textContent)`
4. `operators = parseOperatorList(opList)`
5. `operatorCounts = summarizeOperators(operators)`
6. `textOps = summarizeTextOperators(operators)`
7. `fonts = collectFonts(text.items)` — fontName の Set
8. `images = await extractImages(page, opList)`
9. `structure = pageStructure(page, pageNumber, viewport)`
10. `unicodeLikelyMissing` 判定:

```javascript
unicodeLikelyMissing =
  textOps.showTextTotal > 0 &&
  (text.nonEmptyCount === 0 || text.emptyCount > text.nonEmptyCount * 2);
```

返却オブジェクトに `toExportJSON()` メソッド付与。

### 9.2 parseTextContent

各 item から:

```javascript
{ index, str, x, y, width, height, fontName, hasEOL, transform, dir, isEmpty }
```

**str が空でも表示する**（Inspector Text タブの要件）。

### 9.3 extractImages

1. `extractImageNamesFromOpList` — `paintImageXObject` 等の args[0] を unique 化
2. 各 name について `page.objs.get(name, cb)` または `page.commonObjs.get`
3. `resolveObject(store, name, timeoutMs=3000)` — Promise 化 + タイムアウト
4. 返却: `{ name, width, height, kind, interpolate, _raw }`

### 9.4 drawImageToCanvas(img)

Images タブのプレビュー用。`kind`: 1=Gray, 2=RGB, 3=RGBA。`img.bitmap` があれば `drawImage`。

### 9.5 scanAllPagesImages(pdf, isAborted)

- 全ページ `getOperatorList()` のみ（**render しない** — showPage と競合回避）
- 返却: `{ byPage, unique: [{name, pages[]}], totalPaintOps }`
- **手動トリガ**（Images タブ内「全ページ走査」ボタン）— 自動実行しない

---

## 10. VectorOperatorFilter / VectorRenderer

### 10.1 目的

テキスト・画像を **除外** したベクター描画命令だけを SVG 化（デバッグビュー）。  
**ページ見た目の再現ではない**。

### 10.2 フィルタ

- **除外**: `textOpCodes()` + `imageOpCodes()`
- **保持**: path, stroke, fill, clip, transform, color, gstate 等（`keepOpCodes()`）
- `process(opList)` → `{ stats, filtered: { fnArray, argsArray, ... } }`

stats: `{ paths, rectangles, curves, clipPaths, imagesRemoved, textRemoved, kept, removed, total }`

### 10.3 VectorRenderer.renderToElement

1. `VectorOperatorFilter.process(opList)`
2. `new pdfjsLib.SVGGraphics(page.commonObjs, page.objs)`
3. `svgGfx.embedFonts = false`
4. `svgGfx.getSVG(filtered, viewport)` — **15秒タイムアウト**
5. SVG に class `pdf-svg-output pdf-vector-debug`

---

## 11. DocumentInspector.inspect(pdf)

```javascript
{
  numPages, fingerprints,
  info: metadata.info,           // Title, Author, PDFFormatVersion 等
  metadataRaw,
  outline: await pdf.getOutline(),
  pageSummaries: [{ page, ref, rotate, view }, ...],
  note: "Catalog は Worker 内部…"  // 説明文
}
```

`loadFile()` 成功時に **1 回** 実行。Structure タブで使用。

---

## 12. コアフロー

### 12.1 loadFile(file)

```
1. arrayBuffer 取得
2. 既存 pdf.destroy()
3. pdfBinary = PdfBinaryInspector.parse(buf)
4. pdf = await pdfjsLib.getDocument({ data: buf }).promise
   ※ CMap 設定なし。標準 fonts 同梱なし。
5. docInfo = await DocumentInspector.inspect(pdf)
6. UI 切替（welcome → workspace）
7. doc-info チップ更新
8. buildPageList()
9. await showPage(1)
```

### 12.2 showPage(pageNumber) — 最重要

**世代番号** `_showPageGen` で古い非同期結果を破棄。

```
gen = ++_showPageGen
_scanGen++, _vectorGen++, _vectorPreview = null
setInspectorTabsLoading(pageNumber)

runInPageQueue(async () => {
  if (gen !== _showPageGen) return

  page = await pdf.getPage(pageNumber)
  viewport = page.getViewport({ scale })
  await renderPageToCanvas(page, viewport, canvas)   // ① render 先行
  opList = await page.getOperatorList()               // ② その後 ops
  await buildVectorPreview(page, viewport, opList)    // ③ SVG（任意失敗）
  pageAnalysis = await PageAnalyzer.analyzePage(...)  // ④ 解析
  renderTextTab / Operators / Fonts / Images / Structure / Export / Vector
  clearInspectorTabsLoading()
})
```

**pageQueue**: `getPage` + `render` + `getOperatorList` を直列化。同時実行すると別ページ結果が混ざる。

**render キャンセル**: 新 render 前に `renderTask.cancel()`。

### 12.3 ズーム

- `setZoom(scale)` → `showPage(currentPage)`
- `zoomFit()` — viewer-wrap 幅に合わせ scale 計算（0.25–2.0）

---

## 13. Inspector タブ詳細

### 13.1 Text

- stats-bar: item 数、str 空/非空、showText 系命令数
- `unicodeLikelyMissing` → 黄色 `.notice-banner.notice-warn`
- fullText（最大 8000 文字）
- showText 引数サンプル最大 5 件
- Text Items 先頭 100 件（str 空でも fontName/transform 表示）
- styles JSON

### 13.2 Ops

- 全 Operator 一覧（index, name, args）
- highlight 命令（showText, paintImageXObject, stroke, fill 等）は `.op-row-highlight`

### 13.3 Fonts

- PDF.js fontName 一覧（TextContent 由来）
- ページ Resources → Font（PdfBinaryInspector.getPageResourceFonts）
- PDF 全体 Font オブジェクト一覧（pdfBinary.fonts）

### 13.4 Images

2 パネル構造:

```html
<div id="images-current-panel">…</div>  <!-- 現在ページ、毎 showPage 更新 -->
<div id="images-scan-panel">…</div>     <!-- 全ページ走査結果 -->
```

- 現在ページ: 各画像 card + `drawImageToCanvas` プレビュー
- 走査パネル: 未走査時は「全ページ走査」ボタン → `scanAllImagesInBackground()`
- 走査は `_scanGen` でキャンセル可能

### 13.5 Vector

- stats グリッド（Paths, Rectangles, Curves, Clip, Images/Text Removed）
- SVG プレビュー（cloneNode して width 100%）
- エラー時: メッセージ + 再試行ボタン → `showPage(currentPage)`
- `_isVectorPreviewValid()` — pageNumber + scale 一致確認

### 13.6 Structure

- 現在ページ PDFPageProxy 情報
- pdfBinary.stats グリッド
- docInfo（info JSON, pageSummaries, outline）

### 13.7 Export

- `pageAnalysis.toExportJSON()` を `<pre>` 表示（最大 20000 文字）
- 「JSON をダウンロード」→ Blob `{filename}_page{N}_pdfjs.json`

---

## 14. MinimalUI（shared/minimal-ui.js）

```javascript
const MinimalUI = {
  observe(root) { /* IntersectionObserver → .reveal.is-visible */ },
  staggerList(listEl) { /* li に reveal + delay */ },
};
```

使用箇所: `buildPageList()` のみ。無くても動作する。

---

## 15. getDocument 設定

```javascript
pdfjsLib.getDocument({ data: buf })
```

**意図的に含めないもの:**

- `cMapUrl` / `cMapPacked`
- `standardFontDataUrl`
- `useWorkerFetch: true`（file:// で Worker fetch 失敗するため）

---

## 16. エラーハンドリング

| 状況 | 動作 |
|------|------|
| pdf.min.js 未読込 | status-bar にエラー、App 起動しない |
| getDocument 失敗 | alert + status-bar |
| showPage 失敗 | setInspectorTabsError + status-bar |
| Vector SVG タイムアウト | vectorPreview.error にメッセージ、stats は表示 |
| RenderingCancelledException | 無視（ページ切替キャンセル） |

---

## 17. レスポンシブ

`@media (max-width: 960px)`:

- workspace → 1 列（sidebar / viewer / inspector 縦積み）
- inspector max-height: 42dvh

`@media (max-width: 860px)` Welcome:

- 上下分割（説明上、デモ下）

---

## 18. 再実装チェックリスト

AI が本アプリを再現する際の順序:

### Phase 1: 骨格

- [ ] ディレクトリ構成・PDF.js 3.11.174 vendoring
- [ ] index.html DOM（Welcome + Workspace + 全 ID）
- [ ] minimal-ui.css/js + style.css テーマ変数
- [ ] file-input + drop-zone（welcome + toolbar）
- [ ] loadFile → workspace 表示切替

### Phase 2: Viewer

- [ ] showPage: render → getOperatorList
- [ ] pageQueue 直列化 + _showPageGen
- [ ] ページリスト・前後・キーボード・ズーム

### Phase 3: 解析

- [ ] PageAnalyzer（text, ops, images, structure）
- [ ] PdfBinaryInspector
- [ ] DocumentInspector
- [ ] 各 Inspector タブ render 関数

### Phase 4: 高度機能

- [ ] VectorOperatorFilter + VectorRenderer
- [ ] Images 全ページ走査（手動）
- [ ] Export JSON ダウンロード
- [ ] inspector-loading オーバーレイ

### Phase 5: Welcome

- [ ] 左右 split レイアウト
- [ ] 右デモ HTML + 16秒 CSS アニメ（JS 不要）
- [ ] minimal-ui welcome 上書き（padding/central 解除）

### Phase 6: 仕上げ

- [ ] unicodeLikelyMissing 警告
- [ ] prefers-color-scheme light
- [ ] prefers-reduced-motion
- [ ] edge-to-edge レイアウト（viewer padding 0）

---

## 19. PDF.js API 参照表

| API | 用途 |
|-----|------|
| `pdfjsLib.getDocument({ data })` | PDF 読込 |
| `pdf.getPage(n)` | ページ取得 |
| `page.getViewport({ scale })` | 表示サイズ |
| `page.render({ canvasContext, viewport })` | Canvas 描画 |
| `page.getOperatorList()` | fnArray + argsArray |
| `page.getTextContent()` | テキストアイテム |
| `page.objs.get(name, cb)` | XObject 解決 |
| `page.commonObjs.get(name, cb)` | 共通 XObject |
| `pdf.getMetadata()` | ドキュメント info |
| `pdf.getOutline()` | しおり |
| `pdfjsLib.OPS` | 命令コード定数 |
| `pdfjsLib.SVGGraphics` | OperatorList → SVG |

---

## 20. 既知の UX 仕様（細部）

- Toolbar `#doc-info` は `margin-left: auto` で右寄せ
- Welcome CTA は **1 つだけ**（`#drop-zone-welcome`）
- ページ切替中タブクリック → タブ見た目は変わるがパネルは loading のまま
- status-bar 左: `PDF.js 3.11` 固定表記
- Images タブ: `pageAnalysis.pageNumber !== forPageNumber` なら render スキップ
- zoomFit の wrap 幅計算: `wrap.clientWidth - 32`（legacy、viewer padding 0 でも動作）

---

## 付録 A — DOM ID / クラス一覧

| ID / セレクタ | 要素 | 用途 |
|---------------|------|------|
| `#toolbar` | `<header>` | 解析画面ヘッダー |
| `#drop-zone` | div | ツールバー PDF 再オープン |
| `#doc-info` | div | ファイル名・版・ページ数チップ |
| `#info-filename` | span | ファイル名 |
| `#info-version` | span | `PDF 1.x` |
| `#info-pages` | span | `N ページ` |
| `#nav-controls` | div | ページ操作 + ズーム |
| `#btn-prev` / `#btn-next` | button | 前後ページ |
| `#page-indicator` | span | `N / total` |
| `#btn-zoom-out/in/fit` | button | ズーム |
| `#zoom-label` | span | `100%` |
| `#welcome-screen` | section | Welcome 全体 |
| `#drop-zone-welcome` | div | Welcome CTA |
| `#file-input` | input[file] | 共有ファイル選択 |
| `#workspace` | main | 3ペイン workspace |
| `#page-list` | ul | ページリスト |
| `#pdf-canvas` | canvas | PDF 描画 |
| `#viewer-wrap` | div | チェッカー背景 + canvas ラッパ |
| `#inspector-loading` | div | ページ読込オーバーレイ |
| `#tab-{name}` | div | 各 Inspector パネル |
| `#images-current-panel` | div | Images 現在ページ（動的生成） |
| `#images-scan-panel` | div | Images 全ページ走査（動的生成） |
| `#btn-scan-all-images` | button | 全ページ走査トリガ |
| `#btn-download-json` | button | Export ダウンロード（動的生成） |
| `#app-footer` | footer | ステータスバー |
| `#status-bar` | span | ステータス文言 |

**html クラス:**

- `baseline-app` — 常時
- `has-document` — PDF 読込後

**body クラス:**

- `is-busy` — 読み込み/解析/走査中（status-dot 黄色）

**Inspector クラス:**

- `.app-inspector.is-tab-loading` — 読込中（タブクリックでパネル切替抑制）

---

## 付録 B — PDFJSInspectorApp メソッド一覧

| メソッド | 説明 |
|----------|------|
| `constructor()` | 状態初期化 + `bindUI()` |
| `runInPageQueue(fn)` | Promise チェーンで PDF.js 操作直列化 |
| `setInspectorTabsLoading(n)` | 全 tab-panel 非表示 + loading 表示 |
| `clearInspectorTabsLoading()` | loading 非表示 + activeTab 復元 |
| `setInspectorTabsError(n, msg)` | loading をエラー表示に |
| `bindDropZone(zone, input)` | click / keydown / D&D |
| `bindUI()` | 全イベント登録 |
| `setStatus(msg)` | status-bar + is-busy |
| `loadFile(file)` | PDF 読込 + UI 切替 |
| `scanAllImagesInBackground()` | 全ページ画像走査 |
| `buildPageList()` | page-list 生成 |
| `goPage(n)` | ページ切替 |
| `setZoom(scale)` | ズーム + showPage |
| `zoomFit()` | 幅フィット |
| `renderPageToCanvas(page, vp, canvas)` | page.render |
| `_isVectorPreviewValid()` | vector キャッシュ検証 |
| `buildVectorPreview(page, vp, opList, n)` | SVG 生成 |
| `showPage(pageNumber)` | **メインフロー** |
| `renderTextTab()` … `renderExportTab()` | 各タブ HTML 生成 |
| `renderImagesTab(forPageNumber)` | 2 パネル管理 |
| `renderImagesCurrentPanel(forPageNumber)` | 現在ページ画像 |
| `renderImagesScanPanel()` | 走査結果 or ボタン |

---

## 付録 C — Welcome デモ CSS 仕様

### C.1 レイアウト

```css
.welcome-split {
  display: grid;
  grid-template-columns: 1fr 1fr;
  height: 100%;
}
.demo-workspace {
  display: grid;
  grid-template-columns: 3.4em 1fr 38%;
}
```

### C.2 アニメーション割当（すべて **16s infinite**）

| 要素クラス | keyframes |
|------------|-----------|
| `.demo-page-1` | `demo-page-1` |
| `.demo-page-2` | `demo-page-2` |
| `.demo-page-3` | `demo-page-3` |
| `.demo-doc-1/2/3` | `demo-doc-1/2/3` |
| `.demo-tab-text/ops/fonts/images` | 同名 |
| `.demo-panel-text/ops/fonts/images` | 同名 |
| `.demo-chip-page::after` | `demo-page-indicator`（steps(1)） |
| `.demo-canvas-stage::after` | `demo-scan`（**4s** スキャンライン） |

### C.3 タイムライン（% は 16秒ループ内）

| 区間 | ページ active | タブ active | パネル visible | doc visible |
|------|---------------|-------------|----------------|-------------|
| 0–24% | 1 | Text | text | doc-1 |
| 25–49% | 2 | Ops | ops | doc-2 |
| 50–74% | 3 | Fonts | fonts | doc-3 |
| 75–100% | 1 | Images | images | doc-1 |

---

## 付録 D — Export JSON スキーマ

`pageAnalysis.toExportJSON()` の返却構造:

```json
{
  "page": {
    "pageNumber": 1,
    "rotate": 0,
    "viewBox": [0, 0, 595, 842],
    "width": 595,
    "height": 842,
    "viewportWidth": 595,
    "viewportHeight": 842,
    "ref": "3 0 R",
    "userUnit": 1
  },
  "text": [ /* parseTextContent items */ ],
  "textOps": { "counts": {}, "showTextTotal": 0, "showTextSamples": [] },
  "unicodeLikelyMissing": false,
  "fullText": "...",
  "operatorCounts": { "showText": 5 },
  "operators": [ { "index": 1, "name": "save", "code": 10, "args": [] } ],
  "fonts": ["g_d0_f1"],
  "images": [ { "name": "Im1", "width": 100, "height": 50, "kind": 2 } ]
}
```

画像 `_raw` は **含めない**。

---

## 付録 E — イベントバインディング

| 要素 | イベント | 動作 |
|------|----------|------|
| `#drop-zone-welcome`, `#drop-zone` | click, keydown(Enter/Space), dragover, drop | `#file-input` 経由で loadFile |
| `#file-input` | change | loadFile |
| `#btn-prev/next` | click | goPage |
| `#btn-zoom-in/out/fit` | click | setZoom / zoomFit |
| `.tab[data-tab]` | click | activeTab 切替（loading 中はパネル非切替） |
| `#tab-export` | click | renderExportTab 再描画 |
| `document` | keydown ArrowLeft/Right | goPage（input/textarea/pre 内は無視） |
| `#btn-scan-all-images` | click（動的） | scanAllImagesInBackground |
| `#btn-download-json` | click（動的） | Blob ダウンロード |
| `#btn-retry-vector` | click（動的） | showPage(currentPage) |

---

## 付録 F — shared/minimal-ui.css の役割

Explorer 専用ではないが **必須依存**。提供する主なもの:

- `.hidden { display: none !important }`
- `.toolbar`, `.workspace`, `.pane`, `.pane-header`
- `.tab-bar`, `.tab`, `.tab-panel`
- `.drop-zone`, `.item-card`, `.code-block`, `.stats-bar`
- `.page-list`, `.reveal` / `.is-visible`（スクロールアニメ）
- `.welcome-screen` — **中央寄せ flex**（style.css 末尾で上書き必須）

`minimal-ui.js` は `MinimalUI.observe` + `staggerList` のみ。`DOMContentLoaded` で `observe(document)` も実行。

---

## 付録 G — dev/ ツール

### generate-sample.mjs

Node ESM。3 ページの最小 PDF を `sample.pdf` に出力（gitignore）。  
ローカル動作確認用。アプリ本体には不要。

実行: `node dev/generate-sample.mjs`

---

## 付録 H — 再現時のファイルサイズ目安

| ファイル | 行数（目安） |
|----------|--------------|
| index.html | ~207 |
| app.js | ~1563 |
| style.css | ~1432 |
| shared/minimal-ui.css | ~数百行 |
| shared/minimal-ui.js | ~30 |
| lib/pdf.min.js | 公式 min ビルド（そのまま vendoring） |
| lib/pdf.worker.min.js | 同上 |

---

*End of design document.*
