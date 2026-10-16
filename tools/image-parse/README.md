# image-parse — 本地版面分析 + OCR HTTP 服务

把一张图片解析成**带类型的区域**（title / subtitle / body / button / label / logo / image），
每个区域给出 bbox、识别文本与字体估计。主要面向 infinite-canvas 前端的「截图 → 结构化版面」流程。

- **版本**: `0.1.0`
- **默认端口**: `17410`（`--port` 覆盖）
- **栈**: Python 3 + FastAPI + uvicorn；主后端 macOS Vision（pyobjc）
- **实测环境**: macOS 15.0 (x64 / Intel)，CPython 3.9.6

---

## 1. 接口契约（冻结，勿改字段名）

### `GET /health`

```json
{"ok": true, "engine": "vision", "version": "0.1.0"}
```

`engine` ∈ `vision | swift | tesseract`（`paddle` 仅为可选钩子，见 §4）。

### `POST /parse`

请求体：

```json
{
  "image": "<base64>",     // 三选一
  "path": "/abs/path.png",
  "url": "https://.../x.png",
  "options": { "lang": "zh-Hans", "maxRegions": 50 }
}
```

- `image` / `path` / `url` 三选一（同时给出时优先级 `image > path > url`）。
- `options.lang` ∈ `zh-Hans | en-US`，缺省 `zh-Hans`。
- `options.maxRegions` 为可选截断（按 y→x 排序后取前 N）。

成功 200：

```json
{
  "ok": true, "width": 900, "height": 1200, "engine": "vision",
  "regions": [
    {
      "id": "r1", "type": "title",
      "bbox": {"x": 250.9, "y": 302.6, "w": 403.4, "h": 56.9},
      "text": "智能画布工作台", "confidence": 1.0,
      "font": {"sizePx": 41, "weight": "bold", "align": "center", "familyGuess": "PingFang SC"}
    }
  ],
  "warnings": []
}
```

- `bbox` 原点 **左上**、单位 **px**（Vision 的归一化左下原点已在服务内换算）。
- `type` 允许值：`title|subtitle|body|button|label|logo|image|unknown`。
- 失败一律 **HTTP 200 + `{"ok": false, "error": "..."}`**（契约要求，不抛 500）。

---

## 2. 后端与降级链

服务启动时按优先级探测并选定引擎：

| 顺序 | 引擎 | 依赖 | 说明 |
|---|---|---|---|
| 1 | `vision` | `pyobjc-framework-Vision` + Quartz | **主后端**。零模型下载、中文原生 |
| 2 | `swift` | 自带 `vision_ocr.swift` 编译出的 `vision_ocr` | pyobjc 不可用时 subprocess 调用 |
| 3 | `tesseract` | 系统 `tesseract` 可执行文件 | 以上都不可用时 |
| — | `paddle` | 可选钩子 | import 失败即静默禁用，绝不报错 |

三者皆不可用 → `/parse` 返回 `{"ok":false,"error":"no OCR engine available ..."}`。

> **本机实测结论**：`vision` 可用并作为实际引擎；`tesseract` 未安装（`which tesseract` 为空）；
> `swift` 分支**源码已实现但本机未能编译产出二进制**（见 §7 未验证项）。

---

## 3. 安装

```bash
export PATH="/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"
# 需要联网时走代理（示例）：
export HTTPS_PROXY=http://127.0.0.1:7897

python3 -m venv ~/.venvs/image-parse          # 本机实测使用仓库外的 venv
~/.venvs/image-parse/bin/python -m pip install --only-binary=:all: -r requirements.txt
```

> **重要**：Python 3.9 **必须** `--only-binary=:all:` 并锁 pyobjc `11.1`。
> pyobjc 12.x 没有 cp39 wheel，pip 会退化为源码编译并失败
> （`ModuleNotFoundError: No module named 'pkg_resources'`）。
> Python 3.10+ 可放宽到 pyobjc `>=12`。

---

## 4. 可选 paddle 钩子

`app.py` 中 `_probe_paddle()` 仅做 `import paddleocr` 尝试。装了就可能在 `--engine paddle`
时被选中（当前该分支未实现解析，会显式报错）；没装则完全禁用、不影响主链路。
`requirements.txt` 里相关依赖保持注释状态。

---

## 5. 编译 Swift 兜底 CLI（可选）

```bash
cd tools/image-parse
./build_swift.sh          # 等价于: swiftc -O -o vision_ocr vision_ocr.swift
```

用法：`./vision_ocr <image.png> [zh-Hans,en-US]` → 输出单个 JSON
（`{"width","height","observations":[{"text","confidence","x","y","w","h"}]}`，坐标同为左上原点 px）。

> 需要有与当前 macOS SDK 版本**匹配**的 Swift 工具链。若 CommandLineTools 的编译器与 SDK
> 版本不一致，会报 `This SDK is not supported by the compiler ... Please select a toolchain
> which matches the SDK`，需安装完整 Xcode（`xcode-select --switch /Applications/Xcode.app`）
> 或更新 Command Line Tools。

---

## 6. 启动与验证

```bash
cd tools/image-parse
PY=~/.venvs/image-parse/bin/python

# 生成测试图（标题/副标题/正文/按钮/logo/图片，中英混合）
$PY make_sample.py                       # -> samples/sample.png (900x1200)

# 启动
$PY app.py --port 17410                  # 或: $PY app.py --port 17410 --engine vision

# 健康检查
curl -s http://127.0.0.1:17410/health
# -> {"ok":true,"engine":"vision","version":"0.1.0"}

# 解析（base64）
B64=$($PY -c "import base64;print(base64.b64encode(open('samples/sample.png','rb').read()).decode())")
curl -s -X POST http://127.0.0.1:17410/parse -H 'Content-Type: application/json' \
     -d "{\"image\":\"$B64\",\"options\":{\"lang\":\"zh-Hans\"}}" > samples/sample.regions.json
```

`sample.regions.json` 已随仓库提交（真实服务输出），断言脚本见 §6.1。

### 6.1 断言（真实输出）

```bash
$PY - <<'EOF'
import json
j = json.load(open('samples/sample.regions.json'))
assert j['ok'] is True and j['engine'] == 'vision'
rs = j['regions']
assert len(rs) >= 4
for r in rs:
    assert 'bbox' in r and all(k in r['bbox'] for k in 'xywh')
    assert 'text' in r and isinstance(r['text'], str)
print('PASS', len(rs), 'regions')
EOF
```

> **注意**：非文本区域（`logo` / `image` 无文字）其 `text` 为 `""` —— 字段存在但为空是预期行为。
> 若上层要求「每区域必须有非空文本」，请先过滤 `type ∈ {logo,image}`。

---

## 7. `type` 分类启发式（全部为概率性规则，非像素级还原）

记：`H` 图高，`h_max` 页面最高一行的高度，`fh = h/H`，`ratio = h/h_max`，
`centered = |cx − W/2| < 0.07·W`，`top = y < 0.35·H`，`n` = 文本字符数。

**文本区域**，按优先级：

1. **button**：文字坐落在**填充背景**上（文字 bbox 外扩环带中 ≥55% 像素偏离画布角点底色），
   且 `n ≤ 24` 且 `fh < 0.06`。
2. **title**：`ratio ≥ 0.72` 且 `n ≤ 24` 且（`centered` 或 `top`）。
3. **subtitle**：`ratio ≥ 0.42` 且 `n ≤ 40` 且（`centered` 或 `top`）。
4. **label**：`n ≤ 12` 且（`centered` 或 `fh ≥ 0.018`）。
5. **body**：其余全部。

**非文本区域**（`logo` / `image`）：把图降采样成网格 → 标记偏离背景色的「墨迹」格 →
并查集连通域 → 每个连通域转回 px bbox；
若被任一文本框覆盖 >25%，或某文本框中心落在其内部 → 视为文字/按钮底衬，**丢弃**；
否则面积 < 图面积 6% 且长宽比 ∈ [0.25, 4] → `logo`，反之 `image`。

**字体估计**（同样为启发式）：

- `font.sizePx = round(h · 0.72)`（Vision 的 bbox 高≈上伸+下伸，0.72 折向 cap/x-height）。
- `font.weight`：title/button → `bold`；subtitle → `ratio ≥ 0.6` 为 `bold` 否则 `regular`；其余 `regular`。
- `font.align`：`|cx−W/2| < 0.05·W` → `center`；右边缘 > 0.92·W 且 x > 0.5·W → `right`；否则 `left`。
- `font.familyGuess`：文本含 CJK 字符 → `PingFang SC`，否则 `Helvetica Neue`。

> ⚠️ **weight / familyGuess / sizePx 全部是概率识别，不是像素级还原。**
> 未做字重（笔画粗细）量化，也未做真实字体族匹配；仅根据区域类型、相对字号与是否含 CJK 推断。
> 上层如需精确字体，请自行对 bbox 裁剪后另跑字体识别。

---

## 8. 已知限制 / 未验证项

- **Swift 兜底未在本机编译验证**：`vision_ocr.swift` 已实现，但本机 CommandLineTools 的
  swiftc (6.0.0.9.10) 与所有可用 SDK 版本不匹配，编译失败，故 `swift_ocr()` 分支**未经真机运行验证**。
- **tesseract 分支未验证**：本机未安装 `tesseract`，`tesseract_ocr()` 未实际执行过；
  中文需额外安装 `chi_sim` 语言数据。
- **paddle**：仅钩子，未实现解析。
- `confidence` 为 Vision 原始置信度（本机对多数字行返回 `0.5`，非归一化改写）。
- OCR 存在真实误识（本样例把 `AI` 识成 `Al`），属引擎能力而非服务缺陷。
- 非文本区域检测基于颜色阈值，彩色渐变/浅色 logo 可能漏检。
- 只做**行级**合并；复杂多列/表格不含阅读顺序重排。
