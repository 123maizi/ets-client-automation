# ets-client-automation

A local, client-side automation layer for the **ETS / e听说** desktop client (CEF shell).
It bridges the client's native request-signing routine into page JavaScript, then exposes a
single floating button that completes pending homework.

纯客户端侧的本地自动化层：把客户端的原生请求签名能力桥接到页面里，并在页面右下角提供一个
「一键完成」按钮。**不修改服务端、不改客户端二进制、不接触他人账号数据。**

> 仅用于本机学习与自测。请自行确认你所在地区/学校对自动化工具的要求。

---

## 设计约束（Design constraints）

本项目刻意保持三条边界，代码里也都能对上：

1. **Client-side only.** 只构造客户端本来就会发出的请求，不伪造服务端响应、不改数据库、
   不绕过付费墙。签名仍然由客户端自己的原生模块计算（`EtsHelper.encode_api_body_v2`），
   脚本只是把请求体在签名前改写。
2. **Fail-safe.** 服务端拒绝（HTTP 400 / `code != 0`）时，单题最多重试 3 次即放弃，
   整份作业连续失败 8 次判定为「不支持」并跳过，不会反复轰炸接口。
3. **Throttled.** 起始请求间隔 300 ms，连续成功 25 次才下调 50 ms，下限 120 ms；
   作业级并发默认 2。不是压测工具。

---

## 工作原理

```
页面 (statics.ets100.com)
   │  ① 原生桥接：cef.message.sendMessage(uid, "EtsHelper", "encode_api_body_v2", {body,time})
   ▼
原生插件 etshelper.pln ──► 返回 {"key_id":"YYYYMM","pid":"pcWin","sign":"<32hex>","sign_version":"2"}
   │
   ▼
② 请求体 base64 明文在签名前被 hook 改写（分数改满分）
   │
   ▼
POST https://api.ets100.com/{endpoint}   { body, head:{version,sign,pid,time,time_second} }
```

关键点：**签名对象就是将要发送的 body 本身**。只要在 `encode_api_body` 之前把 base64 解开、
改字段、再 base64 回去，原生模块就会对改后的内容签名，签名始终有效。

完整的协议、字段、计分机制见 [`docs/PROTOCOL.md`](docs/PROTOCOL.md)，
题型与提交路径见 [`docs/TYPES.md`](docs/TYPES.md)。

---

## 使用

### 1. 注入

脚本以页面内脚本方式运行（本仓库只提供脚本本体，注入方式取决于你的客户端环境）。
调试期可用自带的极简 CDP 客户端：

```bash
# 客户端开启 DevTools 端口后（DevToolsActivePort 文件里能看到端口）
node tools/cdp.mjs list
node tools/cdp.mjs file autocomp.js      # 注入
node tools/cdp.mjs eval "window.ETSX.state"
```

### 2. 操作

页面右下角会出现悬浮按钮（可拖动）：

```
[⚡ 一键完成]  [■]
状态：正在完成 Unit 2 Words 跟读 / 进度 64% (41/76)
```

* 点击 `⚡ 一键完成` → 拉取待完成作业 → 过滤（跳过已完成 / 已过期 / 无题目实体的作业）→ 并发执行
* `■` → 中止
* 结束后面板显示：请求数 / 成功数 / 跳过数与原因

### 3. 运行时配置

```js
window.ETSX_CONF = {
  AUTO_MAXOUT: true,       // 拦截页面自身请求，把分数归一化为满分
  AUTO_RUN: false,         // true = 页面加载后自动执行
  CONCURRENCY: 2,          // 同时处理几份作业
  PER_REQUEST_DELAY: 300,  // 起始间隔 ms
  MIN_DELAY: 120,          // 自适应下限 ms
  FULL_SCORE: 5            // 单题满分（服务端按 real = total / 5 归一化）
};
```

---

## 支持矩阵

| 作业类型 | `first_column_id` | 方式 | 状态 |
|---|---|---|---|
| 单词跟读 / 句子跟读 / 课文跟读 | 4 / 9 / 104 / 159 | `sync-v2` 逐题构造 | ✅ 实测 100% |
| 听说同步 / 音标 / 跟读专项 | 5 / 6 / 331 | 同上 | ✅ |
| 词汇训练（选择题） | 127 | 页面内按标准答案点选 | ✅ 实测 100/100 |
| 单词 PK（双人对战） | 127 (`pk=1`) | `struct` + `score-sync` | ✅ 实测 100%（v1.1.0） |
| 读写 / 作文 | 10 / 12 / 8 | 接口结构不同 | ⚠️ 未覆盖 |

---

## 目录

```
autocomp.js        # 核心：签名 hook + 请求构造 + 悬浮按钮
tools/cdp.mjs      # 无依赖 CDP 客户端（零第三方包，手写 WebSocket 帧）
docs/PROTOCOL.md   # 协议 / 签名 / 计分机制
docs/TYPES.md      # 题型枚举与提交路径
```

---

## 已知问题

* 个别作业完成度停在 99%：已用「多轮补漏」处理（每轮从当前进度续跑，最多 4 轮，
  单题失败重试 3 次）。
* 词汇类作业走 DOM 点选，依赖页面类名（`.container-items-item`），页面改版会失效。
* 单词 PK 的 PC 入口被前端硬编码拦截（「电脑端暂不支持」），但 `score-sync` 接口可用，
  脚本绕过 UI 直接提交（见 docs/TYPES.md）。

---

## License

MIT — 见 [LICENSE](LICENSE)。
