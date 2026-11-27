# 题型与提交路径

## 1. `first_column_id` 枚举

| 值 | 名称 | 值 | 名称 |
|---|---|---|---|
| 1 | 模拟考 | 88 | 听力模拟 |
| 2 | 听说专项 | 92 | 同步听说单元 |
| 3 | 专项训练 | 103 | 错题 |
| 4 | 同步练习 | 104 | 同步听力 |
| 5 | 听说同步 | 108 | 同步听说班级 |
| 6 | 音标 | 109 | 同步配音 |
| 8 | 作文 | 110 | 趣味配音 |
| 9 | 跟读（shadowing） | 112 | 假期作业 |
| 10 | 读写 | 119 | 分级阅读 |
| 11 | 非评分作文 | 127 | 词汇模块 |
| 12 | 读写模拟 | 159 | 同步课文 |
| | | 168 | 学习计划 |
| | | 215 | 课文背诵 |
| | | 331 | 音标新版 |

## 2. 按类型的完成方式

### A. 听说类（4 / 5 / 6 / 9 / 104 / 159 / 215 / 331 …）

数据来自 `g/homework/list` 的 `struct.contents[]`，每个元素是一个 `entity`。

```
checkstart → info → 逐 entity 提交 /m/audio/sync-v2 → submit
```

* `score_detail` 写成满分：`accuracy/fluency/integrity/standard = "100.000000"`，
  `total_score = real_score = 5`
* `order`：单词类（`read_type=1`）固定 1；句子/课文类从 1 递增，
  直到 `complete` 不再增长
* `complete` 到 100 即完成；未到 100 时进入补漏轮（每题重发 order=1/2，最多 4 轮）

实测：53/76/56/64 题的作业均在 50 秒内完成，`complete=100`、`avg_point=100`。

### B. 词汇训练 / 汉译英选择题（127，`pk=0`）

`struct.contents` 为空，题目来自另一接口：

```
g/homework/struct { id, resource_id, first_column_id }   // 注意是 id，不是 homework_id
  → body.word_question[]
      { content, translate, option, answer:"A", word_id, id, question_type, total_point }
```

* **答案由服务端直接下发**（`answer` 字段）
* 提交走 `g/homework/score-sync`（一次提交全部题目）
* 该接口的 `detail[]` 结构较复杂，本项目未完全还原参数，实际采用**页面内点选**：
  按 `answer` 匹配选项并触发 `click`，24 题全对 → 100/100

### C. 单词 PK（127，`pk=1`）—— 已支持（v1.1.0）

PC 客户端点「开始练习」会弹 **「电脑端暂不支持该题型，请使用移动端完成」**，
这是前端 `needDownloadRes()` 的硬编码分支（`first_column_id=127` 且
`set_module_id` 不在 2/5/3 时直接弹窗），**与接口能力无关**。

绕过弹窗、直接走接口即可，且与词汇训练同一条路径：

```
g/homework/struct { id, resource_id, first_column_id }   → word_question[]（含 answer）
g/homework/score-sync {
  detail: [{ word_id, question_id, item_id?, question_item_id?,
             score_rate: 1,
             score_detail: '{"choose":"<answer>","score":100}',
             client_time }],
  homework_id, resource_id, type: 6, use_time, mark_service: 1, seq_id
}
```

服务端返回：

```json
{ "code": 0, "body": { "complete_rate": 1, "pass": 1, "score_rate": 1 } }
```

作业随即变为 `complete=100 / avg_point=100 / pass=1`。

补充：客户端自身提交 PK 时走 `g/pk/submit-word`，参数为
`{serial_id, use_time, score_detail:[{question_id,word_id,point,answer,…}], resource_id, type:6}`，
其中 `point` 由**客户端**给出（答对 10000）。实测该接口需要 `serial_id`（来自匹配会话），
而 `score-sync` 这条路径不需要，是更省事的实现。

### D. 读写 / 作文（8 / 10 / 12）

接口为 `/m/exam/sync`、`/m/exam/submit`、`/m/composition/recognize`、`/m/composition/mark`，
评分包含服务端作文批改，结构差异较大，本项目未覆盖。

## 3. 支持矩阵

| 类型 | 方式 | 状态 |
|---|---|---|
| 单词 / 句子 / 课文跟读 | `sync-v2` 构造 | ✅ 100% |
| 听说同步 / 音标 / 跟读专项 | `sync-v2` 构造 | ✅ |
| 词汇训练（选择） | DOM 点选 | ✅ 100/100 |
| 单词 PK | `struct` + `score-sync` | ✅ 100%（v1.1.0） |
| 读写 / 作文 | — | ⚠️ 未实现 |

## 4. 判分归属（决定能否改写分数）

| 类型 | 分数由谁计算 | 是否有分数通道 | 能否直接满分 |
|---|---|---|---|
| 听说类 | 客户端 | 有（`sync-v2`） | ✅ |
| 选择题 | 服务端，但答案下发 | 有（`score-sync`） | 通过点选 |
| 单词 PK | 服务端实时 | 无 | ❌ |

一句话：**分数是否由客户端上报，决定能否改分；答案是否下发，决定能否答对。**
