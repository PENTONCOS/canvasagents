# image-parse service (第三期地基)

本地「版面分析 + OCR」HTTP 服务，把一张图解析成带类型的区域，供画布前端按需调用。

## 位置与运行

- 代码：`tools/image-parse/`（`app.py`、`vision_ocr.swift`、`build_swift.sh`、`make_sample.py`、`requirements.txt`）
- 默认端口：`17410`
- 主后端：macOS Vision（pyobjc），降级链：Vision → 自带 Swift CLI → 系统 tesseract
- 完整契约、安装步骤、类型启发式规则与已知限制：见 `tools/image-parse/README.md`

## 快速自检

```bash
cd tools/image-parse
~/.venvs/image-parse/bin/python make_sample.py
~/.venvs/image-parse/bin/python app.py --port 17410 &
curl -s http://127.0.0.1:17410/health
```

## 契约速览（冻结，勿改字段名）

- `GET /health` → `{"ok":true,"engine":"vision","version":"0.1.0"}`
- `POST /parse` body `{image?|path?|url?, options?:{lang?, maxRegions?}}`
  → `{ok,width,height,engine,regions:[{id,type,bbox{x,y,w,h},text,confidence,font{sizePx,weight,align,familyGuess}}],warnings}`
- `bbox` 原点左上，单位 px；`type` ∈ `title|subtitle|body|button|label|logo|image|unknown`
- 失败返回 HTTP 200 + `{ok:false,error}`

## 证据产物

- `tools/image-parse/samples/sample.png` — 测试图（标题/副标题/正文/按钮/logo/图片，中英混合）
- `tools/image-parse/samples/sample.regions.json` — 真实 `/parse` 输出

## 未验证项（详见 README §8）

- Swift 兜底 CLI 源码已实现，但本机 swiftc 与 SDK 版本不匹配，**未能编译产出二进制**，该分支未经真机验证。
- `tesseract` 分支本机未安装，未验证。
