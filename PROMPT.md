# PDF Explorer — 生成AI用プロンプト

生成AIにこのアプリと同等の機能を実装させるためのプロンプト集。  
設計書 [`DESIGN.md`](./DESIGN.md) ほど厳密でなくてよいが、**同じ機能**に到達できる粒度を目指している。

---

## 使い方

1. **メインプロンプト**を生成AIに貼り付けて実装させる
2. 動作確認後、不足があれば **追記プロンプト** を追加で渡す
3. PDF.js の min ファイルは [Mozilla PDF.js 3.11.174](https://github.com/mozilla/pdf.js/releases) から手動で `lib/` に配置するのが確実
4. 既存の `shared/minimal-ui.css` / `minimal-ui.js` がある場合は添付し、「この UI 土台を使う」と指定すると見た目の再現が楽

**推奨フロー:** メインプロンプト → 動作確認 → 追記プロンプト（必要に応じて）

---

## メインプロンプト

以下をそのままコピーして使う。

```
# タスク
ブラウザだけで動く「PDF Explorer」という PDF 情報抽出ツールを、
npm / ビルド / サーバーなしで作ってください。
index.html を file:// で開いて動作すること。

# 目的
PDF を開き、PDF.js の公開 API でページごとに内部情報を観察・抽出する
開発者向けツール。PDF エディタではない。

# 技術制約（必須）
- PDF.js 3.11.x を lib/ に同梱（pdf.min.js + pdf.worker.min.js）
- ES modules 不使用。Vanilla JS 1 ファイル（app.js）
- getDocument({ data: arrayBuffer }) のみ。CMap / standardFontData は設定しない
- workerSrc = "lib/pdf.worker.min.js"
- File API で PDF 読込（クリック + ドラッグ&ドロップ）
- UI 文言は日本語

# ファイル構成
pdfjs-inspector/
  index.html
  app.js
  style.css
  lib/pdf.min.js
  lib/pdf.worker.min.js
  shared/minimal-ui.css   … 共通 UI（toolbar, tabs, cards 等）
  shared/minimal-ui.js    … ページリストの stagger アニメ（任意だが推奨）

# 画面構成

## 1. Welcome 画面（PDF 未読込）
- 左右 50:50 分割
- 左: タイトル「PDF Explorer」、説明、PDF を開くボタン（1つだけ）
- 右: **CSS のみ** のデモ UI（Pages / Viewer / Inspector の見た目）
  - 3 ページ・4 タブが 16 秒ループで切り替わるアニメーション
  - PDF.js も app.js も使わない静的デモ

## 2. Workspace 画面（PDF 読込後）
- 上部ツールバー: Open PDF、ファイル名・PDF版・ページ数、前後ページ、ズーム
- 3 ペイン:
  - 左: ページリスト（Page 1, 2, …）
  - 中央: Canvas ビューア（page.render）
  - 右: Inspector（7 タブ）
- 下部ステータスバー

# Inspector 7 タブの機能

## Text
- page.getTextContent() の結果を表示
- str が空のアイテムも fontName / transform 等と一緒に表示
- OperatorList の showText 系命令数も表示
- showText はあるのに str がほぼ空 → 「Unicode 化されていない可能性」警告

## Ops
- page.getOperatorList() の全命令一覧（index, 名前, 引数）
- showText / paintImageXObject / stroke / fill 等はハイライト

## Fonts
- TextContent から得た fontName 一覧
- 生 PDF バイナリを regex で簡易パースし Font オブジェクト一覧も表示
- ページ Resources の /Font 辞書も可能なら表示

## Images
- 現在ページ: paintImageXObject 等から画像 XObject を page.objs で解決
- 解決できれば Canvas プレビュー
- 別パネル: 「全ページ走査」ボタン（手動）
  - 全ページ getOperatorList のみ（render しない）
  - 画像名と出現ページの一覧

## Vector
- OperatorList からテキスト・画像命令を除外
- 残りを pdfjsLib.SVGGraphics で SVG デバッグビュー
- パス/矩形/曲線/クリップの統計も表示
- 「ページ見た目の再現ではない」旨を明記

## Struct
- 現在ページ: rotate, viewBox, ref, viewport サイズ
- ドキュメント: numPages, metadata.info, getOutline, 全ページ ref 概要
- 生 PDF のオブジェクト種別カウント（Page/Font/XObject 等）

## Export
- 現在ページの解析結果を JSON 表示 + ダウンロード

# 重要な実装ルール

1. **showPage フロー**（ページ切替の中心処理）:
   - page.render() → getOperatorList() → 解析 → 全タブ描画
   - render と getOperatorList は **直列キュー** で実行（同時実行禁止）
   - ページ切替キャンセル用の世代番号（gen）で古い非同期結果を破棄

2. **読み込み中表示**:
   - Inspector にオーバーレイ 1 件だけ（タブごとに個別 loading は作らない）

3. **PdfBinaryInspector**（app.js 内）:
   - ArrayBuffer → latin1 → /(\d+) (\d+) obj ... endobj/g でオブジェクト抽出
   - Font / Page 等を regex で分類

4. **意図的にやらないこと**:
   - CMap 同梱や文字化け修復
   - PDF 編集・保存
   - npm / webpack / vite

# UI / デザイン
- macOS / DevTools 風。ダークデフォルト + prefers-color-scheme: light 対応
- フルスクリーン edge-to-edge（カード UI や大きな余白は避ける）
- Viewer の canvas はチェッカー背景、padding 0
- キーボード: ← → でページ切替

# 納品物
上記ファイルをすべて生成し、各ファイルの完全なソースコードを出力してください。
PDF.js の min ファイルは「lib/ に配置済み」と仮定してよい。
minimal-ui.css/js も含めて生成してください（shared/ に置く）。
```

---

## 追記プロンプト

メインプロンプトで実装したあと、不足・不具合がある場合に追加で渡す。

### Welcome デモが弱い

```
Welcome 右側のデモを CSS アニメだけで作り直してください。
16 秒ループで Page 1→2→3、タブ Text→Ops→Fonts→Images、
Viewer の疑似ページが同期して切り替わること。JavaScript は使わない。
```

### ページ切替バグ・競合

```
showPage を修正してください。
page.render と getOperatorList は Promise キューで直列化。
_showPageGen で古い showPage の結果を無視。
Inspector の loading は #inspector-loading 1 件だけ。
```

### Unicode 警告・Fonts タブ

```
Text タブ: showText 系命令があるのに getTextContent の str がほぼ空なら警告。
Fonts タブ: TextContent の fontName に加え、生 PDF バイナリ regex パースで
Font オブジェクト（BaseFont, Subtype, ToUnicode, 埋め込み有無）も表示。
```

### Vector タブ

```
Vector タブ: OperatorList から text/image 命令を除外し、
pdfjsLib.SVGGraphics.getSVG で SVG プレビュー。
15 秒タイムアウト。stats（paths, rectangles, curves, clip, removed counts）も表示。
```

### Images 全ページ走査

```
Images タブを2パネル構成にしてください。
上: 現在ページの画像（page.objs 解決 + Canvas プレビュー）
下: 「全ページ走査」ボタン（手動トリガ）
走査は getOperatorList のみ（render しない）で pageQueue 経由実行。
```

### 設計書参照（精度を上げたいとき）

```
添付の DESIGN.md を参照し、同等機能を実装してください。
特に showPage フロー、PdfBinaryInspector、Inspector 7 タブの仕様に従うこと。
```

---

## 注意事項

| 項目 | 推奨 |
|------|------|
| PDF.js 本体 | AI 生成に頼らず公式リリースから `lib/` に配置 |
| 1 回での完成 | 難しい。メイン → 追記の反復が現実的 |
| minimal-ui | 既存 `shared/` を添付して再利用指定 |
| CMap | 意図的に未設定。日本語 PDF の文字化けは警告のみ |

---

## 関連ドキュメント

- [`DESIGN.md`](./DESIGN.md) — 厳密な設計書（再現用）
- ソース — `index.html`, `app.js`, `style.css`, `shared/`
