# Protocol Notes

> 所有示例中的 `TOKEN` / `USER_ID` / `HOMEWORK_ID` / `SET_ID` 均为占位符。

## 1. 客户端组成

| 组件 | 说明 |
|---|---|
| `ETSShell.exe` | CEF 外壳（STIC 框架），manifest `requireAdministrator` |
| `Ets.exe` | preshell 启动器（环境校验后 `ShellExecuteExW` 拉起 ETSShell） |
| `libcef.dll` | Chromium |
| `plugins/*/*.pln` | 原生插件：`etshelper` `httphelper` `filehelper` `sevenzip` `sqlitepln` `soundhelper` `appcontroller` `shellhelper` `window_control` |
| mq_server | Node 本地服务（127.0.0.1:40001），接收页面日志 |
| 远程页面 | `https://statics.ets100.com/ets-student-pc-web/`（Vue3 + Pinia + Element Plus） |

页面 ↔ 原生桥：

```js
cef.message.sendMessage(uid, pluginKey, actionKey, jsonString)
cef.message.setMessageCallback(uid, cb)
```

## 2. 请求格式

```
POST {BASE_URL}{r}
Accept: application/json, text/plain, */*
Content-Type: application/json

{
  "body": "<base64( JSON.stringify([{ r, params }]) )>",
  "head": {
    "version": "1.0",
    "sign": "<32 hex>",
    "pid": "pcWin",
    "time": "<ms timestamp string>",
    "time_second": 1790000000000
  }
}
```

`params` 固定字段：

```json
{
  "sign_response": 1,
  "sn": "test",
  "system": 4,
  "global_client_version": "x.y.z",
  "token": "TOKEN"
}
```

响应为明文 JSON 数组：

```json
[{ "msg": "成功", "code": 0, "body": { } }]
```

`BASE_URL` 取自 `localStorage.clientConfig.VITE_BASE_URL`（生产为 `https://api.ets100.com`）。

## 3. 签名

页面通过适配器优先调用 `encode_api_body_v2`，失败回落 `encode_api_body`：

```js
// encode_api_body_v2 返回 JSON 字符串
{"key_id":"202608","pid":"pcWin","sign":"<32 hex>","sign_version":"2"}
```

* `key_id` 为**按月滚动**的密钥标识（`YYYYMM`）
* 签名算法位于原生插件 `etshelper.pln` 的 `OnEncodeAPIBody` 处理器：
  对 `time + body` 做流式摘要（MD5 IV `0x67452301`），输出 32 位小写 hex
* `head` 只需 5 个字段，`key_id` 不下发

**重要推论**：签名对象就是即将发送的 `body`。因此在 JS 侧解开 base64、改字段、
再编码回去，仍交给同一个原生方法签名，签名必然与服务端校验一致。

## 4. 认证

* `token` 为 JWT，payload 形如 `{"create":<unix>,"id":"USER_ID","login":"<masked>"}`
* 存放在 Pinia `userInfo`（localStorage）与 `sessionStorage.token`
* 服务端对无效 token 返回 `code: 20004`（登录状态失效）
* **每次请求前都要重新扫最新 token**：页面可能在会话中刷新过 token，
  复用启动时捕获的旧 token 会得到 20004

## 5. 作业模型

`g/homework/list`（`version: 11`）返回 `body.data[]`：

| 字段 | 含义 |
|---|---|
| `id` | homework_id |
| `set_id` / `resource_id` | 资源集 / 教材资源 id |
| `first_column_id` | 题型（见 TYPES.md） |
| `set_module_id` | 模块 |
| `complete` / `point` / `avg_point` / `total_point` / `pass_line` | 进度与得分 |
| `struct.contents[]` | 题目实体：`real_id`（entity_id）、`url`（资源 zip）、`read_type`、`first_type_name` |
| `plat_data[].item_orders[]` | 平台题序（含 `order` 与 `total_point`） |

`parent_account_id` 为必填（家长/班级维度），取值位置随账号结构不同：
`userInfo.parent_id` 或 `userInfo.userInfo.parent_id` 或 `ecardInfo.parent_id`。

## 6. 完成 / 上传链路

```
g/homework/checkstart            { homework_id }
m/homework/info                  { resource_id, homework_id, first_column_id, version:2, pk:0 }
  ├─ 逐题（听说类）: /m/audio/sync-v2
  │    { resource_id, set_id, entity_id, order, real_score, score,
  │      score_detail(JSON string), upload_file_url, spx_file_url,
  │      detail_file_url, mark_trace_id, mark_service:1, seq_id,
  │      version:"2", homework_id, auto_submit, correct, client_time }
  ├─ 批量: m/audio/batch-sync-v2   { resource_id, id, set_id, info:[...] }
  ├─ 选择题: g/homework/score-sync { detail[] | score_detail[], homework_id, ... }
  └─ 读写:  /m/exam/sync → /m/exam/submit
m/homework/submit                { id, homework_id, resource_id, first_column_id, version:2, use_time }
```

语音上传（原生 `httphelper.upload`）：

```
STS:  p1/student/config/config/ossEvaluateUploadStsToken
上传: https://ets60.ets100.com/ugc/evaluate/{mp3,speex,xml}/...
```

## 7. 计分

对同一作业的 `m/homework/info` 记录做统计，`real_score` 与客户端上报的
`score_detail.real_score` 完全一致，且满足：

```
real_score = total_score / 5        (clamp 到 1.0)
avg_point  = mean(real_score / standard_score)
point      = avg_point × total_point
```

结论：**服务端直接采用客户端上报的分数**，不做二次语音评测。
把 `score_detail` 的 `total_score / real_score / accuracy / fluency / integrity / standard`
全部写成满分，即可得到 `avg_point = 1.0`。

`sync-v2` 的 `complete` 按题累加（单词类每题约 +1.3%，课文跟读每句约 +4.8%），
到 100 即整份完成；`order` 对单句实体固定为 1，对多句实体从 1 递增。

## 8. 错误码

| code | 含义 | 处理 |
|---|---|---|
| 0 | 成功 | — |
| 20004 | 登录失效 | 重新取 token |
| 80004 | 无有效班级 | 检查 `parent_account_id` |
| 91002 | 作业不存在 | 参数缺 `resource_id` / `first_column_id` |
| HTTP 400（空 body） | 网关层拒绝 | 判断为「不支持该作业」并跳过 |
