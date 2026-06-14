/**
 * PDF 内部構造 Explorer — app.js
 * =================================
 * PDF.js（Mozilla 参照実装）を使い、PDF が内部的にどのような
 * オブジェクト・演算子・フォント・画像で構成されているかを観察する学習ツール。
 *
 * file:// でも動作（ローカル PDF を File API で読み込み。HTTP サーバー不要）。
 *
 * 使用する PDF.js API（主要）:
 *   pdfjsLib.getDocument({ data })  … PDF バイナリから PDFDocumentProxy を取得
 *   page.getTextContent()           … テキストアイテム（Unicode 化できた範囲）
 *   page.getOperatorList()          … 描画命令 fnArray + argsArray
 *   page.render()                   … Canvas プレビュー（表示できる範囲）
 *
 * npm / Node.js 不要。lib/pdf.min.js + lib/pdf.worker.min.js を同梱。
 */

/* =============================================================================
 * 初期化 — Worker パス（index.html と同じディレクトリ基準）
 * ============================================================================= */

if (typeof pdfjsLib !== "undefined") {
  pdfjsLib.GlobalWorkerOptions.workerSrc = "lib/pdf.worker.min.js";
}

/* =============================================================================
 * ユーティリティ
 * ============================================================================= */

/** HTML エスケープ */
function escapeHtml(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** OPS 命令コード → 名前（pdfjsLib.OPS の逆引き） */
function opCodeToName(code) {
  if (!pdfjsLib?.OPS) return `op_${code}`;
  for (const [name, val] of Object.entries(pdfjsLib.OPS)) {
    if (val === code) return name;
  }
  return `op_${code}`;
}

/** transform [a,b,c,d,e,f] から PDF 座標系の x,y を取得 */
function transformToXY(transform) {
  if (!transform || transform.length < 6) return { x: 0, y: 0 };
  return {
    x: Math.round(transform[4] * 100) / 100,
    y: Math.round(transform[5] * 100) / 100,
  };
}

/** argsArray の要素を JSON 表示用に短縮 */
function formatArgs(args) {
  if (args == null) return "";
  try {
    const s = JSON.stringify(args, (_, v) => {
      if (v instanceof Uint8Array || v instanceof Uint8ClampedArray) {
        return `<Uint8Array len=${v.length}>`;
      }
      if (typeof v === "object" && v !== null && v.length > 20 && typeof v[0] === "number") {
        return `<array len=${v.length}>`;
      }
      return v;
    });
    return s.length > 120 ? s.slice(0, 120) + "…" : s;
  } catch {
    return String(args);
  }
}

/** PDF バイナリを latin1 文字列として走査（簡易オブジェクト抽出） */
function pdfBytesToLatin1(buffer) {
  const bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
  let s = "";
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return s;
}

/* =============================================================================
 * PdfBinaryInspector — PDF 生バイナリからオブジェクト辞書を簡易抽出
 * （Worker 内部に隠れている /Font 辞書等を観察するため）
 * ============================================================================= */

const PdfBinaryInspector = {
  OBJ_RE: /(\d+)\s+(\d+)\s+obj([\s\S]*?)endobj/g,

  parse(buffer) {
    const raw = pdfBytesToLatin1(buffer);
    const objects = new Map();
    for (const m of raw.matchAll(this.OBJ_RE)) {
      objects.set(Number(m[1]), { num: Number(m[1]), gen: Number(m[2]), body: m[3] });
    }
    const fonts = this.extractFontObjects(objects);
    const stats = this.summarizeTypes(objects);
    return { objects, fonts, stats, rawLength: raw.length };
  },

  pick(body, key) {
    const m = body.match(new RegExp(`/${key}\\s*(/[^\\s/\\[\\]<>()]+|\\d+\\s+\\d+\\s+R)`));
    return m ? m[1] : null;
  },

  refNum(body, key) {
    const m = body.match(new RegExp(`/${key}\\s+(\\d+)\\s+\\d+\\s+R`));
    return m ? Number(m[1]) : null;
  },

  arrayRefNum(body, key) {
    const m = body.match(new RegExp(`/${key}\\s*\\[\\s*(\\d+)\\s+\\d+\\s+R`));
    return m ? Number(m[1]) : null;
  },

  extractFontObjects(objects) {
    const fonts = [];
    for (const obj of objects.values()) {
      if (!obj.body.includes("/BaseFont")) continue;
      const subtype = this.pick(obj.body, "Subtype");
      if (!subtype && !obj.body.includes("/Type /Font")) continue;

      const fdNum = this.refNum(obj.body, "FontDescriptor");
      let embedded = false;
      if (fdNum && objects.has(fdNum)) {
        const fd = objects.get(fdNum).body;
        embedded = /\/FontFile(?:2|3)?\s+\d+\s+\d+\s+R/.test(fd);
      }

      fonts.push({
        object: `${obj.num} ${obj.gen} obj`,
        objectNum: obj.num,
        baseFont: this.pick(obj.body, "BaseFont") || "—",
        subtype: subtype || this.pick(obj.body, "Type") || "—",
        encoding: this.pick(obj.body, "Encoding") || "—",
        descendantFonts: this.arrayRefNum(obj.body, "DescendantFonts"),
        toUnicode: this.refNum(obj.body, "ToUnicode"),
        fontDescriptor: fdNum,
        embedded,
      });
    }
    return fonts.sort((a, b) => a.objectNum - b.objectNum);
  },

  summarizeTypes(objects) {
    const counts = { Page: 0, Pages: 0, Font: 0, XObject: 0, Catalog: 0, Metadata: 0, Other: 0 };
    for (const obj of objects.values()) {
      const b = obj.body;
      if (/\/Type\s*\/Page\b/.test(b) && /\/MediaBox/.test(b)) counts.Page++;
      else if (/\/Type\s*\/Pages\b/.test(b)) counts.Pages++;
      else if (/\/Type\s*\/Font\b/.test(b) || (/\/BaseFont/.test(b) && /\/Subtype/.test(b))) counts.Font++;
      else if (/\/Subtype\s*\/Image\b/.test(b) || /\/Subtype\s*\/Form\b/.test(b)) counts.XObject++;
      else if (/\/Type\s*\/Catalog\b/.test(b)) counts.Catalog++;
      else if (/\/Type\s*\/Metadata\b/.test(b)) counts.Metadata++;
      else counts.Other++;
    }
    counts.total = objects.size;
    return counts;
  },

  /** ページオブジェクトの /Resources → /Font 辞書 */
  getPageResourceFonts(objects, pageObjectNum) {
    const page = objects.get(pageObjectNum);
    if (!page) return [];
    const idx = page.body.indexOf("/Font");
    if (idx < 0) return [];
    const start = page.body.indexOf("<<", idx);
    if (start < 0) return [];
    let depth = 0;
    let i = start;
    while (i < page.body.length) {
      if (page.body.startsWith("<<", i)) { depth++; i += 2; continue; }
      if (page.body.startsWith(">>", i)) {
        depth--;
        if (depth === 0) {
          const chunk = page.body.slice(start, i + 2);
          const pairs = [...chunk.matchAll(/\/(\w+)\s+(\d+)\s+\d+\s+R/g)];
          return pairs.map(m => {
            const refNum = Number(m[2]);
            const fontObj = objects.get(refNum);
            const body = fontObj?.body || "";
            return {
              resourceName: m[1],
              ref: `${refNum} 0 R`,
              baseFont: this.pick(body, "BaseFont") || "—",
              subtype: this.pick(body, "Subtype") || "—",
              encoding: this.pick(body, "Encoding") || "—",
              toUnicode: this.refNum(body, "ToUnicode"),
              fontDescriptor: this.refNum(body, "FontDescriptor"),
            };
          });
        }
        i += 2;
        continue;
      }
      i++;
    }
    return [];
  },

  lookupFont(objects, objectNum) {
    return this.extractFontObjects(objects).find(f => f.objectNum === objectNum) || null;
  },
};

/* =============================================================================
 * PageAnalyzer — 1 ページ分の PDF.js 解析結果を収集
 * ============================================================================= */

const PageAnalyzer = {
  /** 画像描画に関係する OPS コード */
  imageOpCodes() {
    const O = pdfjsLib.OPS;
    return new Set([
      O.paintImageXObject,
      O.paintInlineImageXObject,
      O.paintImageMaskXObject,
      O.paintJpegXObject,
    ].filter(v => v != null));
  },

  /**
   * page.getTextContent() を観察用に変換（str が空でもメタデータを保持）。
   */
  parseTextContent(textContent) {
    const styles = textContent.styles || {};
    const items = (textContent.items || []).map((item, i) => {
      const { x, y } = transformToXY(item.transform);
      const str = item.str ?? "";
      return {
        index: i + 1,
        str,
        text: str,
        x,
        y,
        width: item.width,
        height: item.height,
        fontName: item.fontName || "",
        hasEOL: !!item.hasEOL,
        transform: item.transform ? [...item.transform] : [],
        dir: item.dir || "",
        isEmpty: str.length === 0,
      };
    });
    const fullText = items.map(it => it.str + (it.hasEOL ? "\n" : "")).join("");
    const emptyCount = items.filter(it => it.isEmpty).length;
    return {
      items,
      fullText,
      count: items.length,
      emptyCount,
      nonEmptyCount: items.length - emptyCount,
      styles,
    };
  },

  /** OperatorList からテキスト描画命令を集計 */
  summarizeTextOperators(operators) {
    const textNames = new Set([
      "showText", "showSpacedText", "nextLineShowText",
      "setFont", "beginText", "endText",
    ]);
    const counts = {};
    const showTextSamples = [];
    for (const op of operators.ops) {
      if (textNames.has(op.name)) {
        counts[op.name] = (counts[op.name] || 0) + 1;
      }
      if (op.name === "showText" && showTextSamples.length < 5) {
        showTextSamples.push({ index: op.index, args: op.args });
      }
    }
    const showTextTotal = (counts.showText || 0) + (counts.showSpacedText || 0) + (counts.nextLineShowText || 0);
    return { counts, showTextTotal, showTextSamples };
  },

  /** OperatorList 命令名ごとの出現回数 */
  summarizeOperators(operators) {
    const counts = {};
    for (const op of operators.ops) {
      counts[op.name] = (counts[op.name] || 0) + 1;
    }
    return counts;
  },

  /**
   * page.getOperatorList() の結果を命令名リストに変換。
   *
   * OperatorList:
   *   fnArray[i]   … 命令コード（pdfjsLib.OPS と対応）
   *   argsArray[i] … 引数（命令ごとに異なる）
   */
  parseOperatorList(opList) {
    const ops = [];
    for (let i = 0; i < opList.fnArray.length; i++) {
      ops.push({
        index: i + 1,
        code: opList.fnArray[i],
        name: opCodeToName(opList.fnArray[i]),
        args: opList.argsArray[i],
      });
    }
    return { ops, count: ops.length };
  },

  /**
   * OperatorList から paintImageXObject 等を検出し、
   * page.objs 経由で画像メタデータを解決。
   *
   * objs.get(name, callback) … XObject 名 → 画像データ（width, height, data/bitmap）
   */
  async extractImages(page, opList) {
    const unique = this.extractImageNamesFromOpList(opList);
    return Promise.all(unique.map(async name => {
      const img = await this.resolveObject(page.objs, name)
        || await this.resolveObject(page.commonObjs, name);
      if (!img) {
        return { name, width: null, height: null, error: "objs.get で解決不可" };
      }
      return {
        name,
        width: img.width ?? null,
        height: img.height ?? null,
        kind: img.kind ?? null,
        interpolate: img.interpolate ?? null,
        _raw: img,
      };
    }));
  },

  /** OperatorList から画像 XObject 名だけ抽出（render 不要） */
  extractImageNamesFromOpList(opList) {
    const imageOps = this.imageOpCodes();
    const names = [];
    for (let i = 0; i < opList.fnArray.length; i++) {
      if (!imageOps.has(opList.fnArray[i])) continue;
      const args = opList.argsArray[i];
      if (args && args[0] != null) names.push(String(args[0]));
    }
    return [...new Set(names)];
  },

  /**
   * 全ページを走査（getOperatorList のみ — page.render と競合させない）
   */
  async scanAllPagesImages(pdf, isAborted = () => false) {
    const byPage = [];
    const uniqueMap = new Map();

    for (let pageNum = 1; pageNum <= pdf.numPages; pageNum++) {
      if (isAborted()) return null;
      const page = await pdf.getPage(pageNum);
      const opList = await page.getOperatorList();
      const names = this.extractImageNamesFromOpList(opList);
      byPage.push({
        page: pageNum,
        images: names.map(name => ({ name, width: null, height: null })),
      });
      for (const name of names) {
        const prev = uniqueMap.get(name);
        if (!prev) {
          uniqueMap.set(name, { name, width: null, height: null, pages: [pageNum] });
        } else if (!prev.pages.includes(pageNum)) {
          prev.pages.push(pageNum);
        }
      }
    }

    return {
      byPage,
      unique: [...uniqueMap.values()].sort((a, b) => a.name.localeCompare(b.name)),
      totalPaintOps: byPage.reduce((s, p) => s + p.images.length, 0),
    };
  },

  /** page.objs / commonObjs から非同期でオブジェクトを取得（タイムアウト付き） */
  resolveObject(store, name, timeoutMs = 3000) {
    return new Promise(resolve => {
      if (!store || typeof store.get !== "function") {
        resolve(null);
        return;
      }
      let settled = false;
      const finish = val => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(val);
      };
      const timer = setTimeout(() => finish(null), timeoutMs);
      try {
        store.get(name, obj => finish(obj || null));
      } catch {
        finish(null);
      }
    });
  },

  /** テキストアイテムから fontName を重複除去して収集 */
  collectFonts(textItems) {
    const set = new Set();
    for (const it of textItems) {
      if (it.fontName) set.add(it.fontName);
    }
    return [...set].sort();
  },

  /**
   * ページ構造情報。
   * PDFPageProxy:
   *   rotate  … 回転（0, 90, 180, 270）
   *   view    … MediaBox [x0, y0, x1, y1]（PDF 座標）
   *   ref     … オブジェクト参照 { num, gen }
   */
  pageStructure(page, pageNumber, viewport) {
    const view = page.view || [];
    const width = view.length >= 4 ? Math.abs(view[2] - view[0]) : viewport.width;
    const height = view.length >= 4 ? Math.abs(view[3] - view[1]) : viewport.height;
    return {
      pageNumber,
      rotate: page.rotate || 0,
      viewBox: view,
      width: Math.round(width * 100) / 100,
      height: Math.round(height * 100) / 100,
      viewportWidth: Math.round(viewport.width * 100) / 100,
      viewportHeight: Math.round(viewport.height * 100) / 100,
      ref: page.ref ? `${page.ref.num} ${page.ref.gen} R` : null,
      userUnit: page.userUnit ?? 1,
    };
  },

  /**
   * PDF.js Image オブジェクトを Canvas に描画（可能な場合）。
   * kind: 1=Gray, 2=RGB, 3=RGBA（PDF.js 内部）
   */
  drawImageToCanvas(img) {
    const canvas = document.createElement("canvas");
    const w = img.width;
    const h = img.height;
    if (!w || !h) return null;

    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext("2d");

    if (img.bitmap) {
      ctx.drawImage(img.bitmap, 0, 0);
      return canvas;
    }

    if (!img.data) return null;

    const data = img.data;
    const imageData = ctx.createImageData(w, h);
    const kind = img.kind || 2;

    if (kind === 1) {
      for (let i = 0; i < w * h; i++) {
        const g = data[i];
        imageData.data[i * 4] = g;
        imageData.data[i * 4 + 1] = g;
        imageData.data[i * 4 + 2] = g;
        imageData.data[i * 4 + 3] = 255;
      }
    } else if (kind === 2) {
      for (let i = 0; i < w * h; i++) {
        imageData.data[i * 4] = data[i * 3];
        imageData.data[i * 4 + 1] = data[i * 3 + 1];
        imageData.data[i * 4 + 2] = data[i * 3 + 2];
        imageData.data[i * 4 + 3] = 255;
      }
    } else if (kind === 3) {
      imageData.data.set(data.subarray(0, w * h * 4));
    } else {
      return null;
    }

    ctx.putImageData(imageData, 0, 0);
    return canvas;
  },

  /** 1 ページ分をまとめて解析（opList は render 直後に取得したものを渡す） */
  async analyzePage(page, pageNumber, scale, opList) {
    const viewport = page.getViewport({ scale });
    const textContent = await page.getTextContent();
    const operatorList = opList || await page.getOperatorList();
    const text = this.parseTextContent(textContent);
    const operators = this.parseOperatorList(operatorList);
    const operatorCounts = this.summarizeOperators(operators);
    const textOps = this.summarizeTextOperators(operators);
    const fonts = this.collectFonts(text.items);
    const images = await this.extractImages(page, operatorList);
    const structure = this.pageStructure(page, pageNumber, viewport);

    const unicodeLikelyMissing =
      textOps.showTextTotal > 0 &&
      (text.nonEmptyCount === 0 || text.emptyCount > text.nonEmptyCount * 2);

    return {
      pageNumber,
      scale,
      text,
      operators,
      operatorCounts,
      textOps,
      unicodeLikelyMissing,
      fonts,
      images,
      structure,
      /** JSON エクスポート用（_raw 画像は除外） */
      toExportJSON() {
        return {
          page: structure,
          text: text.items,
          textOps,
          unicodeLikelyMissing,
          fullText: text.fullText,
          operatorCounts,
          operators: operators.ops.map(o => ({
            index: o.index,
            name: o.name,
            code: o.code,
            args: o.args,
          })),
          fonts,
          images: images.map(({ name, width, height, kind, error }) => ({
            name, width, height, kind, error,
          })),
        };
      },
    };
  },
};

/* =============================================================================
 * VectorOperatorFilter — ベクター演算子のみ抽出（PDF Explorer 用デバッグビュー）
 * ============================================================================= */

const VectorOperatorFilter = {
  /** 除外: テキスト描画・フォント設定 */
  textOpCodes() {
    const O = pdfjsLib.OPS;
    return new Set([
      O.beginText,
      O.endText,
      O.showText,
      O.showSpacedText,
      O.nextLineShowText,
      O.setFont,
      O.setTextMatrix,
      O.setTextRise,
      O.setTextRenderingMode,
      O.setCharSpacing,
      O.setWordSpacing,
      O.setLeading,
      O.setHScale,
      O.setLeadingMoveText,
      O.moveText,
      O.nextLine,
      O.nextLineSetSpacingShowText,
      O.setCharWidth,
      O.setCharWidthAndBounds,
    ].filter(v => v != null));
  },

  /** 除外: 画像・マスク・フォーム XObject */
  imageOpCodes() {
    const O = pdfjsLib.OPS;
    return new Set([
      O.paintImageXObject,
      O.paintInlineImageXObject,
      O.paintJpegXObject,
      O.paintImageMaskXObject,
      O.paintImageXObjectRepeat,
      O.paintImageMaskXObjectRepeat,
      O.paintInlineImageXObjectGroup,
      O.paintImageMaskXObjectGroup,
      O.paintSolidColorImageMask,
      O.paintXObject,
      O.beginInlineImage,
      O.beginImageData,
      O.endInlineImage,
      O.paintFormXObjectBegin,
      O.paintFormXObjectEnd,
      O.shadingFill,
    ].filter(v => v != null));
  },

  /** 保持: パス・塗り・線・クリップ・描画状態 */
  keepOpCodes() {
    const O = pdfjsLib.OPS;
    return new Set([
      O.constructPath,
      O.rectangle,
      O.moveTo,
      O.lineTo,
      O.curveTo,
      O.curveTo2,
      O.curveTo3,
      O.closePath,
      O.stroke,
      O.closeStroke,
      O.fill,
      O.eoFill,
      O.fillStroke,
      O.eoFillStroke,
      O.closeFillStroke,
      O.closeEOFillStroke,
      O.endPath,
      O.save,
      O.restore,
      O.transform,
      O.clip,
      O.eoClip,
      O.setLineWidth,
      O.setLineCap,
      O.setLineJoin,
      O.setMiterLimit,
      O.setDash,
      O.setFlatness,
      O.setRenderingIntent,
      O.setGState,
      O.setStrokeColorSpace,
      O.setFillColorSpace,
      O.setStrokeColor,
      O.setStrokeColorN,
      O.setFillColor,
      O.setFillColorN,
      O.setStrokeGray,
      O.setFillGray,
      O.setStrokeRGBColor,
      O.setFillRGBColor,
      O.setStrokeCMYKColor,
      O.setFillCMYKColor,
    ].filter(v => v != null));
  },

  /** constructPath 内のベジェ曲線セグメント数 */
  countCurvesInConstructPath(args) {
    const O = pdfjsLib.OPS;
    const segOps = args?.[1];
    if (!segOps || typeof segOps.length !== "number") return 0;
    let n = 0;
    for (let i = 0; i < segOps.length; i++) {
      const op = segOps[i];
      if (op === O.curveTo || op === O.curveTo2 || op === O.curveTo3) n++;
    }
    return n;
  },

  /** OperatorList をフィルタし Vector Inspector 用統計を返す */
  process(opList) {
    const O = pdfjsLib.OPS;
    const textOps = this.textOpCodes();
    const imageOps = this.imageOpCodes();
    const keepOps = this.keepOpCodes();

    const fnArray = [];
    const argsArray = [];
    const stats = {
      paths: 0,
      rectangles: 0,
      curves: 0,
      clipPaths: 0,
      imagesRemoved: 0,
      textRemoved: 0,
      kept: 0,
      removed: 0,
      total: opList.fnArray.length,
    };

    for (let i = 0; i < opList.fnArray.length; i++) {
      const fn = opList.fnArray[i];
      const args = opList.argsArray[i];

      if (textOps.has(fn)) {
        stats.textRemoved++;
        stats.removed++;
        continue;
      }
      if (imageOps.has(fn)) {
        stats.imagesRemoved++;
        stats.removed++;
        continue;
      }
      if (!keepOps.has(fn)) {
        stats.removed++;
        continue;
      }

      if (fn === O.constructPath) stats.paths++;
      if (fn === O.rectangle) stats.rectangles++;
      if (fn === O.clip || fn === O.eoClip) stats.clipPaths++;
      if (fn === O.curveTo || fn === O.curveTo2 || fn === O.curveTo3) stats.curves++;
      if (fn === O.constructPath) stats.curves += this.countCurvesInConstructPath(args);
      if (fn === O.moveTo || fn === O.lineTo || fn === O.closePath) stats.paths++;

      fnArray.push(fn);
      argsArray.push(args);
      stats.kept++;
    }

    return {
      stats,
      filtered: {
        fnArray,
        argsArray,
        lastChunk: opList.lastChunk,
        separateAnnots: opList.separateAnnots,
      },
    };
  },
};

/* =============================================================================
 * VectorRenderer — フィルタ済み OperatorList を SVG デバッグビューに変換
 * ============================================================================= */

const VectorRenderer = {
  /** ベクター演算子のみ SVG 化（テキスト・画像なし） */
  async renderToElement(page, viewport, opList, timeoutMs = 15000) {
    if (!pdfjsLib?.SVGGraphics) {
      throw new Error("SVGGraphics が読み込まれていません");
    }

    const { filtered, stats } = VectorOperatorFilter.process(opList);

    const work = (async () => {
      const svgGfx = new pdfjsLib.SVGGraphics(page.commonObjs, page.objs);
      svgGfx.embedFonts = false;
      const svg = await svgGfx.getSVG(filtered, viewport);
      svg.classList.add("pdf-svg-output", "pdf-vector-debug");
      svg.setAttribute("width", String(viewport.width));
      svg.setAttribute("height", String(viewport.height));
      svg.style.width = `${viewport.width}px`;
      svg.style.height = `${viewport.height}px`;
      return { svg, stats };
    })();

    let timer;
    const timeout = new Promise((_, reject) => {
      timer = setTimeout(
        () => reject(new Error(`SVG 生成が ${timeoutMs / 1000} 秒以内に完了しませんでした`)),
        timeoutMs,
      );
    });

    try {
      return await Promise.race([work, timeout]);
    } finally {
      clearTimeout(timer);
    }
  },
};

/* =============================================================================
 * DocumentInspector — ドキュメント全体のデバッグ情報
 * ============================================================================= */

const DocumentInspector = {
  /**
   * PDF.js が公開している範囲の Catalog / ドキュメント情報。
   * （生の xref / オブジェクトツリーは Worker 内部のため直接は取れない）
   */
  async inspect(pdf) {
    let metadata = {};
    try {
      metadata = await pdf.getMetadata();
    } catch { /* optional */ }

    let outline = null;
    try {
      outline = await pdf.getOutline();
    } catch { /* optional */ }

    const pageSummaries = [];
    for (let i = 1; i <= pdf.numPages; i++) {
      const page = await pdf.getPage(i);
      pageSummaries.push({
        page: i,
        ref: page.ref ? `${page.ref.num} ${page.ref.gen} R` : "?",
        rotate: page.rotate,
        view: page.view,
      });
    }

    return {
      numPages: pdf.numPages,
      fingerprints: pdf.fingerprints || [],
      info: metadata.info || {},
      metadataRaw: metadata.metadata?.getAll?.() ?? metadata.metadata ?? null,
      outline,
      pageSummaries,
      note: "Catalog / Pages ツリーの生オブジェクトは PDF.js Worker 内部にあり、"
        + "getMetadata()・page.ref・page.view 等の公開 API 経由で確認します。",
    };
  },
};

/* =============================================================================
 * PDFJSInspectorApp — UI と描画
 * ============================================================================= */

class PDFJSInspectorApp {
  constructor() {
    this.pdf = null;
    this.fileName = "";
    this.pdfBytes = null;
    this.pdfBinary = null;
    this.currentPage = 1;
    this.scale = 1.0;
    this.pageAnalysis = null;
    this.docInfo = null;
    this.allImagesScan = null;
    this.renderTask = null;
    this.activeTab = "text";
    this._vectorPreview = null;
    this._vectorLoading = false;
    this._vectorGen = 0;
    this._showPageGen = 0;
    this._scanGen = 0;
    /** PDF.js の page.render / getOperatorList を直列化（同時実行すると別ページの結果が混ざる） */
    this._pageQueue = Promise.resolve();

    this.bindUI();
  }

  /** ページ操作を1本のキューで直列実行 */
  runInPageQueue(fn) {
    const next = this._pageQueue.then(fn, fn);
    this._pageQueue = next.catch(() => {});
    return next;
  }

  /** Inspector にページ読み込み中を1件だけ表示 */
  setInspectorTabsLoading(pageNumber) {
    const loading = document.getElementById("inspector-loading");
    if (!loading) return;
    loading.innerHTML = `<span class="tab-loading-spinner" aria-hidden="true"></span>
      <p class="tab-loading-msg">Page ${pageNumber} を読み込み中…</p>`;
    loading.classList.remove("hidden");
    document.querySelectorAll(".tab-panel").forEach(p => p.classList.remove("active"));
    document.querySelector(".app-inspector")?.classList.add("is-tab-loading");
  }

  /** Inspector の読み込み中表示を解除し、アクティブタブを復元 */
  clearInspectorTabsLoading() {
    const loading = document.getElementById("inspector-loading");
    loading?.classList.add("hidden");
    loading?.classList.remove("inspector-loading-error");
    document.querySelectorAll(".tab-panel").forEach(p => p.classList.remove("active"));
    document.getElementById("tab-" + this.activeTab)?.classList.add("active");
    document.querySelector(".app-inspector")?.classList.remove("is-tab-loading");
  }

  /** Inspector にエラーを1件表示 */
  setInspectorTabsError(pageNumber, message) {
    const loading = document.getElementById("inspector-loading");
    if (!loading) return;
    loading.innerHTML = `<p class="tab-loading-msg tab-loading-error-title">Page ${pageNumber} の読み込みに失敗しました</p>
      <p class="placeholder">${escapeHtml(message)}</p>`;
    loading.classList.add("inspector-loading-error");
    loading.classList.remove("hidden");
    document.querySelectorAll(".tab-panel").forEach(p => p.classList.remove("active"));
    document.querySelector(".app-inspector")?.classList.remove("is-tab-loading");
  }

  /** ドロップゾーンにクリック・D&D を紐付け */
  bindDropZone(zone, input) {
    if (!zone || !input) return;
    zone.addEventListener("click", () => input.click());
    zone.addEventListener("keydown", e => {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        input.click();
      }
    });
    zone.addEventListener("dragover", e => {
      e.preventDefault();
      zone.classList.add("dragover");
    });
    zone.addEventListener("dragleave", () => zone.classList.remove("dragover"));
    zone.addEventListener("drop", e => {
      e.preventDefault();
      zone.classList.remove("dragover");
      if (e.dataTransfer.files[0]) this.loadFile(e.dataTransfer.files[0]);
    });
  }

  bindUI() {
    const input = document.getElementById("file-input");
    this.bindDropZone(document.getElementById("drop-zone-welcome"), input);
    this.bindDropZone(document.getElementById("drop-zone"), input);
    input.addEventListener("change", e => {
      if (e.target.files[0]) this.loadFile(e.target.files[0]);
    });

    document.getElementById("btn-prev").addEventListener("click", () => this.goPage(this.currentPage - 1));
    document.getElementById("btn-next").addEventListener("click", () => this.goPage(this.currentPage + 1));
    document.getElementById("btn-zoom-in").addEventListener("click", () => this.setZoom(this.scale + 0.25));
    document.getElementById("btn-zoom-out").addEventListener("click", () => this.setZoom(Math.max(0.25, this.scale - 0.25)));
    document.getElementById("btn-zoom-fit").addEventListener("click", () => this.zoomFit());

    document.querySelectorAll(".tab").forEach(btn => {
      btn.addEventListener("click", () => {
        document.querySelectorAll(".tab").forEach(b => b.classList.remove("active"));
        document.querySelectorAll(".tab-panel").forEach(p => p.classList.remove("active"));
        btn.classList.add("active");
        this.activeTab = btn.dataset.tab;
        if (document.querySelector(".app-inspector.is-tab-loading")) return;
        document.getElementById("tab-" + btn.dataset.tab).classList.add("active");
        if (btn.dataset.tab === "images") {
          this.renderImagesTab(this.currentPage);
        }
        if (btn.dataset.tab === "vector") {
          this.renderVectorTab();
        }
      });
    });

    document.getElementById("tab-export").addEventListener("click", () => {
      if (this.pageAnalysis) this.renderExportTab();
    }, { once: false });

    document.addEventListener("keydown", e => {
      if (!this.pdf || e.target.closest("input, textarea, select, pre")) return;
      if (e.key === "ArrowLeft") { e.preventDefault(); this.goPage(this.currentPage - 1); }
      if (e.key === "ArrowRight") { e.preventDefault(); this.goPage(this.currentPage + 1); }
    });
  }

  setStatus(msg) {
    document.getElementById("status-bar").textContent = msg;
    const busy = /読み込み|解析中|走査中/.test(msg);
    document.body.classList.toggle("is-busy", busy);
  }

  /** getDocument() で PDF を読み込み */
  async loadFile(file) {
    this.setStatus("読み込み中…");
    this.fileName = file.name;

    const buf = await file.arrayBuffer();

    if (this.pdf) {
      try { await this.pdf.destroy(); } catch { /* ignore */ }
    }
    this._scanGen++;
    this.allImagesScan = null;

    try {
      this.pdfBytes = buf;
      this.pdfBinary = PdfBinaryInspector.parse(buf);
      const loadingTask = pdfjsLib.getDocument({ data: buf });
      this.pdf = await loadingTask.promise;
    } catch (e) {
      this.setStatus("エラー: " + e.message);
      alert("PDF 読み込みエラー:\n" + e.message);
      return;
    }

    this.docInfo = await DocumentInspector.inspect(this.pdf);
    this.currentPage = 1;

    document.getElementById("workspace").classList.remove("hidden");
    document.getElementById("welcome-screen")?.classList.add("hidden");
    document.getElementById("toolbar").classList.remove("hidden");
    document.getElementById("app-footer")?.classList.remove("hidden");
    document.documentElement.classList.add("has-document");
    document.getElementById("doc-info").classList.remove("hidden");
    document.getElementById("nav-controls").classList.remove("hidden");

    document.getElementById("info-filename").textContent = file.name;
    document.getElementById("info-version").textContent =
      `PDF ${this.pdf._pdfInfo?.PDFFormatVersion || this.docInfo.info?.PDFFormatVersion || "?"}`;
    document.getElementById("info-pages").textContent = `${this.pdf.numPages} ページ`;

    this.buildPageList();
    await this.showPage(1);
  }

  /** 全ページの画像走査 — pageQueue 経由で showPage と競合しない */
  async scanAllImagesInBackground() {
    const scanGen = ++this._scanGen;
    const isAborted = () => scanGen !== this._scanGen;
    return this.runInPageQueue(async () => {
      if (isAborted()) return;
      this.setStatus("全ページ画像を走査中…");
      try {
        const result = await PageAnalyzer.scanAllPagesImages(this.pdf, isAborted);
        if (!result || isAborted()) return;
        this.allImagesScan = result;
        this.renderImagesScanPanel();
        const u = result.unique.length;
        const t = result.totalPaintOps;
        this.setStatus(`${this.fileName} — Page ${this.currentPage} / 全 ${u} 種類の画像 XObject（描画 ${t} 回）`);
      } catch (e) {
        console.error(e);
        if (!isAborted()) this.setStatus(`画像走査エラー: ${e.message}`);
      }
    });
  }

  buildPageList() {
    const ul = document.getElementById("page-list");
    ul.innerHTML = "";
    for (let i = 1; i <= this.pdf.numPages; i++) {
      const li = document.createElement("li");
      li.textContent = `Page ${i}`;
      li.dataset.page = i;
      if (i === this.currentPage) li.classList.add("active");
      li.addEventListener("click", () => this.goPage(i));
      ul.appendChild(li);
    }
    if (typeof MinimalUI !== "undefined") MinimalUI.staggerList(ul);
  }

  async goPage(n) {
    if (n < 1 || n > this.pdf.numPages) return;
    this.currentPage = n;
    document.querySelectorAll("#page-list li").forEach(li => {
      li.classList.toggle("active", parseInt(li.dataset.page, 10) === n);
    });
    await this.showPage(n);
  }

  async setZoom(scale) {
    this.scale = scale;
    await this.showPage(this.currentPage);
  }

  async zoomFit() {
    const page = await this.pdf.getPage(this.currentPage);
    const wrap = document.getElementById("viewer-wrap");
    const vp1 = page.getViewport({ scale: 1 });
    const maxW = wrap.clientWidth - 32;
    this.scale = Math.min(2, Math.max(0.25, maxW / vp1.width));
    await this.showPage(this.currentPage);
  }

  /** page.render() を Canvas に実行 */
  async renderPageToCanvas(page, viewport, canvas) {
    const ctx = canvas.getContext("2d");
    canvas.width = viewport.width;
    canvas.height = viewport.height;

    if (this.renderTask) {
      try { this.renderTask.cancel(); } catch { /* ignore */ }
    }

    this.renderTask = page.render({
      canvasContext: ctx,
      viewport,
    });

    try {
      await this.renderTask.promise;
    } catch (e) {
      if (e?.name !== "RenderingCancelledException") {
        throw e;
      }
    }
  }

  /** キャッシュ済み Vector プレビューが現在ページと一致するか */
  _isVectorPreviewValid() {
    const p = this._vectorPreview;
    return !!(p && p.pageNumber === this.currentPage && p.scale === this.scale);
  }

  /** ベクター演算子のみの SVG デバッグビューを生成 */
  async buildVectorPreview(page, viewport, opList, pageNumber) {
    try {
      const { svg, stats } = await VectorRenderer.renderToElement(page, viewport, opList);
      this._vectorPreview = { pageNumber, scale: this.scale, svg, stats, error: null };
    } catch (e) {
      console.warn("Vector デバッグビュー:", e);
      const { stats } = VectorOperatorFilter.process(opList);
      this._vectorPreview = {
        pageNumber,
        scale: this.scale,
        svg: null,
        stats,
        error: e.message,
      };
    }
  }

  /**
   * ページ表示の中心処理:
   *   1. page.render() → Canvas（getOperatorList より先）
   *   2. getOperatorList → Inspector / Vector
   */
  async showPage(pageNumber) {
    const gen = ++this._showPageGen;
    this._scanGen++;
    this._vectorGen++;
    this._vectorPreview = null;
    this._vectorLoading = false;
    this.currentPage = pageNumber;
    this.setInspectorTabsLoading(pageNumber);
    return this.runInPageQueue(async () => {
      if (gen !== this._showPageGen) return;

      this.setStatus(`Page ${pageNumber} を解析中…`);
      document.getElementById("page-indicator").textContent = `${pageNumber} / ${this.pdf.numPages}`;
      document.getElementById("zoom-label").textContent = `${Math.round(this.scale * 100)}%`;

      try {
        const page = await this.pdf.getPage(pageNumber);
        if (gen !== this._showPageGen) return;

        const viewport = page.getViewport({ scale: this.scale });
        const canvas = document.getElementById("pdf-canvas");

        await this.renderPageToCanvas(page, viewport, canvas);
        if (gen !== this._showPageGen) return;

        const opList = await page.getOperatorList();
        if (gen !== this._showPageGen) return;

        this._vectorLoading = true;
        await this.buildVectorPreview(page, viewport, opList, pageNumber);
        this._vectorLoading = false;
        if (gen !== this._showPageGen) return;

        this.pageAnalysis = await PageAnalyzer.analyzePage(page, pageNumber, this.scale, opList);
        if (gen !== this._showPageGen) return;

        const names = this.pageAnalysis.images.map(i => i.name).join(", ") || "なし";
        this.setStatus(`Page ${pageNumber} — 画像: ${names}`);

        this.renderTextTab();
        this.renderOperatorsTab();
        this.renderFontsTab();
        await this.renderImagesTab(pageNumber);
        this.renderStructureTab();
        this.renderExportTab();
        this.renderVectorTab();
        this.clearInspectorTabsLoading();
      } catch (e) {
        this._vectorLoading = false;
        console.error(e);
        if (gen === this._showPageGen) {
          this.setStatus(`Page ${pageNumber} エラー: ${e.message}`);
          this.setInspectorTabsError(pageNumber, e.message);
        }
      }
    });
  }

  /* --- Inspector タブ --- */

  renderTextTab() {
    const el = document.getElementById("tab-text");
    const { text, textOps, unicodeLikelyMissing } = this.pageAnalysis;

    let html = `<div class="stats-bar">
      getTextContent() — <strong>${text.count}</strong> アイテム
      · str 非空 <strong>${text.nonEmptyCount}</strong>
      · str 空 <strong>${text.emptyCount}</strong>
      · showText 系命令 <strong>${textOps.showTextTotal}</strong>
    </div>`;

    if (unicodeLikelyMissing) {
      html += `<div class="notice-banner notice-warn">
        <strong>Unicode 化されていないテキストの可能性</strong><br>
        OperatorList に showText 等（${textOps.showTextTotal} 回）がありますが、
        getTextContent() の str が空、またはほとんど空です。
        PDF 内部に文字列命令は存在するが、PDF.js が Unicode 文字列に変換できていない状態です
        （Identity-H / ToUnicode なし等）。
      </div>`;
    } else if (textOps.showTextTotal === 0) {
      html += `<div class="notice-banner">
        このページに showText / showSpacedText / nextLineShowText 命令は検出されませんでした。
      </div>`;
    }

    html += `<div class="inspector-section"><h3>str 連結（Unicode 化できた部分のみ）</h3>
      <pre class="code-block">${escapeHtml(text.fullText.slice(0, 8000)) || "(空)"}${text.fullText.length > 8000 ? "\n…" : ""}</pre></div>`;

    if (textOps.showTextSamples.length) {
      html += `<div class="inspector-section"><h3>showText 引数サンプル（OperatorList）</h3>
        <p class="placeholder">PDF.js が解釈した glyph 配列。空配列 [[]] は Unicode/glyph 未解決を示します。</p>`;
      for (const s of textOps.showTextSamples) {
        html += `<div class="item-card">
          <div><span class="label">命令 #${s.index}</span> showText</div>
          <pre class="code-block">${escapeHtml(formatArgs(s.args))}</pre>
        </div>`;
      }
      html += `</div>`;
    }

    html += `<div class="inspector-section"><h3>Text Items（先頭 100 件）</h3>
      <p class="placeholder">str が空でも fontName / transform / width 等を表示します。</p>`;
    for (const it of text.items.slice(0, 100)) {
      const strDisplay = it.str.length
        ? escapeHtml(it.str)
        : `<span class="tag-muted">(str 空 — width=${Math.round(it.width * 100) / 100})</span>`;
      html += `<div class="item-card${it.isEmpty ? " item-card-muted" : ""}">
        <div><span class="label">#${it.index}</span></div>
        <div><span class="label">str:</span> <span class="value">${strDisplay}</span></div>
        <div><span class="label">fontName:</span> ${escapeHtml(it.fontName) || "—"}
             &nbsp; <span class="label">dir:</span> ${escapeHtml(it.dir) || "—"}
             &nbsp; <span class="label">hasEOL:</span> ${it.hasEOL}</div>
        <div><span class="label">width:</span> ${Math.round(it.width * 100) / 100}
             &nbsp; <span class="label">height:</span> ${Math.round((it.height || 0) * 100) / 100}
             &nbsp; <span class="label">x,y:</span> ${it.x}, ${it.y}</div>
        <div><span class="label">transform:</span> <code class="mono-inline">${escapeHtml(JSON.stringify(it.transform))}</code></div>
      </div>`;
    }
    if (text.count > 100) html += `<p class="placeholder">… 他 ${text.count - 100} 件（Export で全件 JSON）</p>`;
    html += `</div>`;

    if (Object.keys(text.styles).length) {
      html += `<div class="inspector-section"><h3>styles（getTextContent）</h3>
        <pre class="code-block">${escapeHtml(JSON.stringify(text.styles, null, 2))}</pre></div>`;
    }

    el.innerHTML = html;
  }

  renderOperatorsTab() {
    const el = document.getElementById("tab-operators");
    const { operators, operatorCounts } = this.pageAnalysis;

    const highlight = ["showText", "showSpacedText", "nextLineShowText", "paintImageXObject",
      "paintInlineImageXObject", "stroke", "fill", "eoFill", "moveTo", "lineTo", "curveTo", "rectangle"];
    const summary = highlight
      .filter(n => operatorCounts[n])
      .map(n => `${n}: ${operatorCounts[n]}`)
      .join(" · ");

    let html = `<div class="stats-bar">getOperatorList() — <strong>${operators.count}</strong> 命令</div>`;
    if (summary) {
      html += `<div class="stats-bar stats-bar-sub">${escapeHtml(summary)}</div>`;
    }
    html += `<div class="inspector-section op-list"><h3>命令一覧</h3>`;

    for (const op of operators.ops) {
      const hl = highlight.includes(op.name) ? " op-row-highlight" : "";
      html += `<div class="op-row${hl}">
        <span class="idx">${op.index}</span>
        <span class="name">${escapeHtml(op.name)}</span>
        <span class="args">${escapeHtml(formatArgs(op.args))}</span>
      </div>`;
    }
    html += `</div>`;
    el.innerHTML = html;
  }

  renderFontsTab() {
    const el = document.getElementById("tab-fonts");
    const { fonts, structure } = this.pageAnalysis;
    const binary = this.pdfBinary;

    let html = `<div class="stats-bar">
      PDF.js fontName — <strong>${fonts.length}</strong> 種類（当ページテキストより）
    </div>`;

    if (fonts.length) {
      html += `<div class="inspector-section"><h3>PDF.js 内部 fontName</h3>`;
      for (const f of fonts) {
        const style = this.pageAnalysis.text.styles?.[f];
        html += `<div class="item-card">
          <div><span class="label">fontName:</span> <span class="value">${escapeHtml(f)}</span></div>
          ${style ? `<pre class="code-block">${escapeHtml(JSON.stringify(style, null, 2))}</pre>` : ""}
        </div>`;
      }
      html += `</div>`;
    }

    if (binary && structure.ref) {
      const pageObjNum = parseInt(structure.ref, 10);
      const pageFonts = PdfBinaryInspector.getPageResourceFonts(binary.objects, pageObjNum);
      html += `<div class="inspector-section"><h3>ページ Resources → Font（生 PDF 辞書）</h3>`;
      if (!pageFonts.length) {
        html += `<p class="placeholder">Page ${structure.pageNumber}（obj ${pageObjNum}）に /Font 辞書が見つかりません（継承 Resources の可能性）。</p>`;
      } else {
        for (const pf of pageFonts) {
          const detail = PdfBinaryInspector.lookupFont(binary.objects, parseInt(pf.ref, 10));
          html += `<div class="item-card">
            <div><span class="label">/${pf.resourceName}</span> → ${escapeHtml(pf.ref)}</div>
            <div><span class="label">BaseFont:</span> ${escapeHtml(pf.baseFont)}</div>
            <div><span class="label">Subtype:</span> ${escapeHtml(pf.subtype)}</div>
            <div><span class="label">Encoding:</span> ${escapeHtml(pf.encoding)}</div>
            <div><span class="label">ToUnicode:</span> ${pf.toUnicode ? pf.toUnicode + " 0 R" : "(none)"}</div>
            <div><span class="label">FontDescriptor:</span> ${pf.fontDescriptor ? pf.fontDescriptor + " 0 R" : "(none)"}</div>
            ${detail ? `<div><span class="label">埋め込み:</span> ${detail.embedded ? "あり" : "なし"}</div>` : ""}
          </div>`;
        }
      }
      html += `</div>`;
    }

    if (binary?.fonts?.length) {
      html += `<div class="inspector-section"><h3>PDF 内 Font オブジェクト一覧（${binary.fonts.length} 件）</h3>`;
      for (const f of binary.fonts) {
        html += `<div class="item-card item-card-compact">
          <div><span class="label">${escapeHtml(f.object)}</span> ${escapeHtml(f.baseFont)}</div>
          <div><span class="label">Subtype:</span> ${escapeHtml(f.subtype)}
               · <span class="label">Encoding:</span> ${escapeHtml(f.encoding)}
               · <span class="label">ToUnicode:</span> ${f.toUnicode ? f.toUnicode + " 0 R" : "(none)"}
               · <span class="label">埋め込み:</span> ${f.embedded ? "あり" : "なし"}</div>
        </div>`;
      }
      html += `<p class="placeholder">※ 生 PDF バイナリを簡易パースした結果です。</p></div>`;
    } else {
      html += `<p class="placeholder">Font オブジェクトを PDF バイナリから抽出できませんでした。</p>`;
    }

    el.innerHTML = html;
  }

  async renderImagesTab(forPageNumber = this.currentPage) {
    const el = document.getElementById("tab-images");
    if (!el) return;
    if (!this.pageAnalysis || this.pageAnalysis.pageNumber !== forPageNumber) {
      return;
    }

    if (!document.getElementById("images-current-panel")) {
      el.innerHTML = `<div id="images-current-panel"></div><div id="images-scan-panel"></div>`;
      this.renderImagesScanPanel();
    }

    await this.renderImagesCurrentPanel(forPageNumber);
  }

  /** 現在ページの画像（ページ切替のたびに更新） */
  async renderImagesCurrentPanel(forPageNumber) {
    const panel = document.getElementById("images-current-panel");
    if (!panel || !this.pageAnalysis) return;
    if (this.pageAnalysis.pageNumber !== forPageNumber) return;

    const { images } = this.pageAnalysis;
    const pageNum = forPageNumber;

    let html = `<div class="stats-bar">
      <strong>現在ページ (Page ${pageNum})</strong> — paintImageXObject 等 <strong>${images.length}</strong> 件
    </div>`;
    html += `<div class="inspector-section" id="images-current-cards"><h3>Page ${pageNum} の画像</h3>`;
    if (!images.length) {
      html += `<p class="placeholder">このページに画像描画命令がありません。</p>`;
    }
    html += `</div>`;
    panel.innerHTML = html;

    const section = panel.querySelector("#images-current-cards");
    for (const img of images) {
      const card = document.createElement("div");
      card.className = "item-card";
      card.innerHTML = `
        <div><span class="label">Image Name:</span> <span class="value">${escapeHtml(img.name)}</span></div>
        <div><span class="label">Size:</span> ${img.width ?? "?"} × ${img.height ?? "?"}</div>
        ${img.error ? `<div><span class="label">Note:</span> ${escapeHtml(img.error)}</div>` : ""}
      `;
      if (img._raw) {
        const previewCanvas = PageAnalyzer.drawImageToCanvas(img._raw);
        if (previewCanvas) {
          const wrap = document.createElement("div");
          wrap.className = "image-preview";
          wrap.appendChild(previewCanvas);
          card.appendChild(wrap);
        }
      }
      section.appendChild(card);
    }
  }

  /** 全ページ走査結果（背景走査完了時のみ更新 — 現在ページを上書きしない） */
  renderImagesScanPanel() {
    let panel = document.getElementById("images-scan-panel");
    if (!panel) {
      const el = document.getElementById("tab-images");
      if (!el) return;
      panel = document.createElement("div");
      panel.id = "images-scan-panel";
      el.appendChild(panel);
    }

    const scan = this.allImagesScan;
    if (!scan) {
      panel.innerHTML = `<div class="inspector-section"><h3>全 PDF 画像一覧</h3>
        <p class="placeholder">ページ切替と競合しないよう、手動で走査してください。</p>
        <button type="button" id="btn-scan-all-images" class="scan-btn">全ページ走査</button>
      </div>`;
      panel.querySelector("#btn-scan-all-images")?.addEventListener("click", () => {
        this.scanAllImagesInBackground();
      });
      return;
    }

    let shtml = `<div class="inspector-section"><h3>全 PDF 画像一覧（${scan.unique.length} 種類 / 描画 ${scan.totalPaintOps} 回）</h3>`;
    shtml += `<table class="kv-table" style="width:100%;font-size:0.72rem;margin-bottom:0.6rem">
      <tr><th>名前</th><th>サイズ</th><th>描画されるページ</th></tr>`;
    for (const u of scan.unique) {
      shtml += `<tr><td>${escapeHtml(u.name)}</td><td>${u.width ?? "?"}×${u.height ?? "?"}</td><td>${u.pages.join(", ")}</td></tr>`;
    }
    shtml += `</table><h3>ページ別内訳</h3>`;
    for (const row of scan.byPage) {
      const names = row.images.map(i => i.name).join(", ") || "（なし）";
      shtml += `<div class="item-card"><span class="label">Page ${row.page}:</span> ${escapeHtml(names)}</div>`;
    }
    shtml += `</div>`;
    panel.innerHTML = shtml;
  }

  renderVectorTab() {
    const el = document.getElementById("tab-vector");
    if (!el) return;

    if (this._vectorLoading) {
      el.innerHTML = `<p class="placeholder">ベクター演算子を解析中…</p>`;
      return;
    }

    const preview = this._vectorPreview;
    if (!this._isVectorPreviewValid()) {
      el.innerHTML = `<p class="placeholder">ページ切替後に Vector デバッグビューを生成します。</p>`;
      return;
    }

    const s = preview.stats || {};
    let html = `<div class="stats-bar">Vector Debug — Page <strong>${this.currentPage}</strong> · 演算子 ${s.kept ?? "?"}/${s.total ?? "?"} 保持</div>`;

    html += `<div class="inspector-section">
      <h3>Vector Inspector</h3>
      <p class="placeholder vector-debug-note">パス・線・矩形・クリップのみ可視化。テキスト・画像は含みません。ページ見た目の再現ではありません。</p>
      <dl class="vector-inspector-grid">
        <div class="vector-stat"><dt>Paths</dt><dd>${s.paths ?? 0}</dd></div>
        <div class="vector-stat"><dt>Rectangles</dt><dd>${s.rectangles ?? 0}</dd></div>
        <div class="vector-stat"><dt>Curves</dt><dd>${s.curves ?? 0}</dd></div>
        <div class="vector-stat"><dt>Clip Paths</dt><dd>${s.clipPaths ?? 0}</dd></div>
        <div class="vector-stat vector-stat-muted"><dt>Images Removed</dt><dd>${s.imagesRemoved ?? 0}</dd></div>
        <div class="vector-stat vector-stat-muted"><dt>Text Removed</dt><dd>${s.textRemoved ?? 0}</dd></div>
      </dl>
    </div>`;

    if (preview.error) {
      html += `<div class="inspector-section">
        <p class="placeholder viewer-error">SVG 生成エラー: ${escapeHtml(preview.error)}</p>
        <button type="button" class="btn-ghost" id="btn-retry-vector">再試行</button>
      </div>`;
      el.innerHTML = html;
      el.querySelector("#btn-retry-vector")?.addEventListener("click", () => {
        this.showPage(this.currentPage);
      });
      return;
    }

    if (!s.kept) {
      html += `<div class="inspector-section"><p class="placeholder">このページにベクター描画命令がありません（テキスト・画像のみの可能性）。</p></div>`;
      el.innerHTML = html;
      return;
    }

    html += `<div class="inspector-section"><h3>Vector Preview</h3><div class="vector-preview-wrap"></div></div>`;
    el.innerHTML = html;
    const svg = preview.svg.cloneNode(true);
    svg.style.width = "100%";
    svg.style.height = "auto";
    el.querySelector(".vector-preview-wrap").appendChild(svg);
  }

  renderStructureTab() {
    const el = document.getElementById("tab-structure");
    const s = this.pageAnalysis.structure;
    const doc = this.docInfo;
    const binary = this.pdfBinary;

    let html = `<div class="inspector-section"><h3>現在ページ (PDFPageProxy)</h3>
      <div class="item-card">
        <div><span class="label">pageNumber:</span> ${s.pageNumber}</div>
        <div><span class="label">ref:</span> ${s.ref || "—"}</div>
        <div><span class="label">Rotate:</span> ${s.rotate}°</div>
        <div><span class="label">view (MediaBox):</span> [${s.viewBox.join(", ")}]</div>
        <div><span class="label">Width × Height:</span> ${s.width} × ${s.height}</div>
        <div><span class="label">Viewport (${Math.round(this.scale * 100)}%):</span> ${s.viewportWidth} × ${s.viewportHeight} px</div>
      </div></div>`;

    if (binary?.stats) {
      const st = binary.stats;
      html += `<div class="inspector-section"><h3>PDF オブジェクト概観（生バイナリ簡易パース）</h3>
        <dl class="vector-inspector-grid">
          <div class="vector-stat"><dt>Total</dt><dd>${st.total}</dd></div>
          <div class="vector-stat"><dt>Page</dt><dd>${st.Page}</dd></div>
          <div class="vector-stat"><dt>Pages</dt><dd>${st.Pages}</dd></div>
          <div class="vector-stat"><dt>Font</dt><dd>${st.Font}</dd></div>
          <div class="vector-stat"><dt>XObject</dt><dd>${st.XObject}</dd></div>
          <div class="vector-stat"><dt>Catalog</dt><dd>${st.Catalog}</dd></div>
          <div class="vector-stat"><dt>Metadata</dt><dd>${st.Metadata}</dd></div>
        </dl>
        <p class="placeholder">file サイズ ${Math.round(binary.rawLength / 1024)} KB · xref オブジェクト数の目安です。</p>
      </div>`;
    }

    html += `<div class="inspector-section"><h3>ドキュメント (PDFDocumentProxy)</h3>
      <div class="item-card">
        <div><span class="label">numPages:</span> ${doc.numPages}</div>
        <div><span class="label">fingerprints:</span> ${escapeHtml(JSON.stringify(doc.fingerprints))}</div>
      </div>
      <pre class="code-block">${escapeHtml(JSON.stringify(doc.info, null, 2))}</pre>
    </div>`;

    html += `<div class="inspector-section"><h3>Page ツリー（PDF.js 公開情報）</h3>
      <pre class="code-block">${escapeHtml(JSON.stringify(doc.pageSummaries, null, 2))}</pre>
      <p class="placeholder">${escapeHtml(doc.note)}</p>
    </div>`;

    if (doc.outline?.length) {
      html += `<div class="inspector-section"><h3>Outline (getOutline)</h3>
        <pre class="code-block">${escapeHtml(JSON.stringify(doc.outline, null, 2).slice(0, 3000))}</pre></div>`;
    }

    el.innerHTML = html;
  }

  renderExportTab() {
    const el = document.getElementById("tab-export");
    if (!this.pageAnalysis) {
      el.innerHTML = `<p class="placeholder">ページを選択してください。</p>`;
      return;
    }

    const json = this.pageAnalysis.toExportJSON();
    const pretty = JSON.stringify(json, null, 2);

    el.innerHTML = `
      <div class="inspector-section">
        <h3>JSON エクスポート（現在ページ）</h3>
        <p class="placeholder">PDF.js が解釈した生データに近い形です。自作パーサとの diff に利用できます。</p>
        <button type="button" class="btn-primary" id="btn-download-json">JSON をダウンロード</button>
        <pre class="code-block" style="max-height:360px;margin-top:0.6rem">${escapeHtml(pretty.slice(0, 20000))}${pretty.length > 20000 ? "\n…" : ""}</pre>
      </div>`;

    document.getElementById("btn-download-json").addEventListener("click", () => {
      const blob = new Blob([JSON.stringify(json, null, 2)], { type: "application/json" });
      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = `${this.fileName.replace(/\.pdf$/i, "")}_page${this.currentPage}_pdfjs.json`;
      a.click();
      URL.revokeObjectURL(a.href);
    });
  }
}

/* =============================================================================
 * 起動
 * ============================================================================= */

document.addEventListener("DOMContentLoaded", () => {
  if (typeof MinimalUI !== "undefined") MinimalUI.observe(document);
  if (typeof pdfjsLib === "undefined") {
    document.getElementById("status-bar").textContent =
      "エラー: lib/pdf.min.js が読み込めません。lib/ フォルダを確認してください。";
    return;
  }
  window.pdfjsInspector = new PDFJSInspectorApp();
});
