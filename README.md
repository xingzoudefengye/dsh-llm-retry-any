# dsh-llm-retry-any（已弃用）

> **状态：弃用（2026-11-18）。不要在新 profile 里安装。**
>
> 本插件曾 fork 自 `@deepseek-ai/dsh-llm-retry`，用于「不管网关返回什么错误码都重试，且至少重试 3 次」。
> harness 0.2.2 起，上游已能覆盖它的全部实用功能，因此停用。

## 为什么弃用

插件当初 fork 的直接理由写在 `lib/index.js` 的模块注释里：

> 上游 normal 模式只重试 `retryableCodes` 白名单里的失败码，白名单外的失败直接结束整轮。
> 实测自建 newapi 网关抖动时返回 `400 ...`，harness 归类为 `INVALID_REQUEST`，不在默认白名单里。

这个理由在 0.2.2 下不再成立，有三条上游路径可以替代：

### 1. 官方 `retryableCodes` 支持自定义码

`normal` 模式的 `retryableCodes` 是 `z.array(z.union([...内置码常量, z.string().min(1)]))`：
除了内置码，**任何字符串都合法**。因此把 `INVALID_REQUEST`、`PI_AI_ERROR` 等网关实际会返回的码
写进白名单即可，不需要 fork。

0.2.2 还给了这块一个完整界面：设置 → 模型 → 编辑提供商 → 重试策略，
可以勾选内置码，也可以输入任意自定义码。

### 2. 官方 `mode: always` 就是「任何错误都重试」

`AlwaysRetryPolicyConfig` 的语义是：忽略 `failure.code`，重试到成功、取消或插件卸载为止。
这比插件的「不看码」更彻底（插件在 `normal` 下仍有次数上限）。

注意它的代价：**永久性错误也会无限重试**（例如模型 ID 写错），会按 `maxDelayMs` 反复重试而不会结束。
需要有限次数时用 `normal` + 显式白名单，不要用 `always`。

### 3. 官方 `maxRetries` 就是次数控制

插件独有的语义只有一条：

```
生效上限 = max(provider 配置的 maxRetries, 3)
```

也就是「即使 provider 把 `maxRetries` 配成 0 或 1，也至少重试 3 次」。
这是**防御性护栏**，不是功能差异：只要配置里写的是 `maxRetries: 3` 或更大，两者行为完全一致。
上游无法表达「下限」，但把 `maxRetries` 直接写成想要的值就能达到同样效果。

## 功能对照

| 能力 | 官方 0.2.2 | 本插件 |
|---|---|---|
| 不按错误码过滤 | ✅ `mode: always` | ✅ |
| 白名单可含非内置码 | ✅ `retryableCodes` 接受任意字符串 | ✅ |
| 有限次数重试 | ✅ `normal` + `maxRetries` | ✅ |
| 无限重试 | ✅ `always` | ✅ |
| 指数退避 / 抖动 / 最大延迟 | ✅ `backoff` | ✅ |
| 尊重 provider 的 `retryAfter` | ✅ | ✅ |
| 事件 `llm/retry`、`llm/retry-started` | ✅ 同名同结构 | ✅ |
| projection key `llmRetry` | ✅ 同名 | ✅ |
| 「至少 N 次」硬下限 | ❌ | ✅ |
| 重试策略设置界面 | ✅ 0.2.2 新增 | ❌ 只能改 yml |

## 怎么从本插件迁回官方

1. 从 profile 的 `package.json` 移除依赖与 `dsh.profile.bundles` 里的 `dsh-llm-retry-any`：

   ```bash
   dsh plugin --profile web remove dsh-llm-retry-any
   ```

2. 删掉 profile 的 `cordis.patch.yml` 里停用官方重试的那两行：

   ```yaml
   - id: llm-retry
     disabled: true
   ```

3. 确认每个 provider 都有显式的重试策略。示例（覆盖网关常见抖动码）：

   ```yaml
   retryPolicy:
     mode: normal
     maxRetries: 5
     retryableCodes:
       - EMPTY_RESPONSE
       - RATE_LIMIT
       - SERVER
       - TIMEOUT
       - TRANSPORT
       - PI_AI_ERROR
       - INVALID_REQUEST
     backoff:
       initialDelayMs: 5000
       maxDelayMs: 5000
       jitterRatio: 0
   ```

4. 重启宿主（`dsh web`），在 设置 → 模型 → 编辑提供商 → 重试策略 里确认
   模式与错误码正确显示并可编辑。

### 迁移时的一个坑

本插件与官方 `@deepseek-ai/dsh-llm-retry` 注册同一个 session projection key `llmRetry`，
两者**不能同时挂载**。所以第 2 步必须做；如果只删依赖却留着 `disabled: true`，
官方重试不会生效，整轮请求就完全没有重试。

## 保留本仓库的原因

代码留作参考：

- `lib/index.js` 里对「白名单无法表达通配」的说明，解释了官方后来补 `z.string()` 分支的动机
- `test/` 里有针对「任意错误码都重试」和「minRetries 下限」的用例

如果将来上游加了「重试次数下限」的配置，本仓库就可以彻底归档。
