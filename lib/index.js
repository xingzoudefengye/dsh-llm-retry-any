import { randomUUID } from "node:crypto";
import z from "@deepseek-ai/schemastery";
import { z as z$1 } from "zod";
//#region lib/types/brand.js
/**
* Brand an implementation-minted retry-chain identity.
* @param id - opaque retry identity.
* @returns the same string, branded; no validation is performed.
*/
function RetryId(id) {
	return id;
}
//#endregion
//#region lib/types/index.js
/**
* Provider-routed model-request retry policy on the agent loop's request
* recovery extension point. Each scheduled retry is durable before its cancellable wait.
*
* ## 本 fork 与上游 @deepseek-ai/dsh-llm-retry 的唯一语义差异
*
* 上游 normal 模式只重试 `retryableCodes` 白名单里的失败码，白名单外的失败直接
* 委派下游 → 整轮结束。实测自建 newapi 网关在上游渠道抖动时会返回
* `400 {"type":"bad_response_status_code","message":" (request id: …)"}`，
* harness 归类为 `INVALID_REQUEST`，不在默认白名单里，于是一次抖动就废掉整轮。
*
* 本 fork 改为：**normal 模式不按 code 过滤，任何 failure.code 都重试**，
* 并且重试次数有下限 `minRetries`（默认 3）—— 即使 provider 把 maxRetries 配成
* 0/1，也至少重试 3 次。上限取 `max(provider.maxRetries, minRetries)`。
* `always` 模式（无上限）行为不变。
*
* 之所以 fork 而不是配置：白名单匹配是精确字符串集合，没有通配符，
* 无法用配置表达「不管什么错误都重试」。
*
* @module dsh-llm-retry-any
*/
const name = "llm-retry-any";
const inject = ["agents", "sessionProjections"];
/** 重试次数下限：无论 provider 怎么配，任何失败至少重试这么多次。 */
const DEFAULT_MIN_RETRIES = 3;
/** Runtime schema for {@link Config}. */
const Config = z.object({
	minRetries: z.number().step(1).min(1).default(DEFAULT_MIN_RETRIES)
});
function validateConfig(config) {
	for (const key of Object.keys(config)) {
		if (key === "retryPolicy") throw new Error("llm-retry-any: retryPolicy belongs under each provider configuration");
		if (key !== "minRetries") throw new Error(`llm-retry-any: unknown key "${key}"`);
	}
	if (config.minRetries !== void 0 && (!Number.isSafeInteger(config.minRetries) || config.minRetries < 1)) throw new Error("llm-retry-any: minRetries must be a positive safe integer");
}
async function settleDownstream(next) {
	try {
		return {
			type: "decision",
			decision: await next()
		};
	} catch (error) {
		return {
			type: "error",
			error
		};
	}
}
function localDelay(config, retry, random) {
	const exponent = Math.min(retry - 1, 1024);
	const exponential = Math.min(config.initialDelayMs * 2 ** exponent, config.maxDelayMs);
	const jitter = 1 - config.jitterRatio + 2 * config.jitterRatio * random();
	return Math.min(exponential * jitter, config.maxDelayMs);
}
function retryPolicyKey(policy) {
	return policy.mode === "always" ? JSON.stringify([
		policy.mode,
		policy.initialDelayMs,
		policy.maxDelayMs,
		policy.jitterRatio
	]) : JSON.stringify([
		policy.mode,
		policy.maxRetries,
		[...policy.retryableCodes].sort(),
		policy.initialDelayMs,
		policy.maxDelayMs,
		policy.jitterRatio
	]);
}
function retryStateKey(provider, policyKey) {
	return JSON.stringify([provider, policyKey]);
}
function cancellableDelay(delayMs, signal) {
	if (signal.aborted) return Promise.resolve(false);
	return new Promise((resolve) => {
		const timer = setTimeout(() => {
			signal.removeEventListener("abort", onAbort);
			resolve(true);
		}, delayMs);
		function onAbort() {
			clearTimeout(timer);
			resolve(false);
		}
		signal.addEventListener("abort", onAbort, { once: true });
	});
}
const llmRetryStateSchema = z$1.record(z$1.string(), z$1.object({
	retry: z$1.number().int().nonnegative(),
	retryId: z$1.string()
}));
function apply(ctx, config = {}, internals = {}) {
	validateConfig(config);
	const minRetries = config.minRetries ?? DEFAULT_MIN_RETRIES;
	ctx.sessionProjections.register({
		key: "llmRetry",
		stateVersion: 1,
		stateSchema: llmRetryStateSchema,
		init: () => ({}),
		apply: (state, event) => {
			if (event.type === "step/start" || event.type === "turn/end") return {};
			if (event.type !== "llm/retry") return state;
			const key = retryStateKey(event.data.provider, event.data.policyKey);
			const entry = state[key];
			if (entry?.retry === event.data.retry && entry.retryId === event.data.retryId) return state;
			return {
				...state,
				[key]: {
					retry: event.data.retry,
					retryId: event.data.retryId
				}
			};
		}
	});
	const random = internals.random ?? Math.random;
	const lifetime = new AbortController();
	const active = /* @__PURE__ */ new Set();
	function track(operation) {
		const tracked = operation.finally(() => active.delete(tracked));
		active.add(tracked);
		return tracked;
	}
	async function backoff(agent, turn, step, failure, provider, policy, policyKey, retry, retryId, delayMs, signal) {
		const fusedSignal = AbortSignal.any([signal, lifetime.signal]);
		if (fusedSignal.aborted) return;
		// normal 模式下 maxRetries 记为生效上限，便于日志里看到真实预算
		const effectiveMaxRetries = Math.max(policy.maxRetries ?? 0, minRetries);
		const eventData = policy.mode === "normal" ? {
			retryId,
			turn,
			step,
			provider,
			mode: policy.mode,
			policyKey,
			retry,
			maxRetries: effectiveMaxRetries,
			delayMs,
			failure
		} : {
			retryId,
			turn,
			step,
			provider,
			mode: policy.mode,
			policyKey,
			retry,
			delayMs,
			failure
		};
		agent.session.append("llm/retry", eventData);
		if (!await cancellableDelay(delayMs, fusedSignal)) return;
		agent.session.append("llm/retry-started", {
			retryId,
			turn,
			step,
			retry
		});
		return { kind: "retry" };
	}
	async function recover({ agent, turn, step, provider, failure, retryPolicy: policy, signal }, next) {
		if (policy === void 0) return next();
		if (policy.mode === "always") {
			if (signal.aborted || lifetime.signal.aborted) return;
			const fusedSignal = AbortSignal.any([signal, lifetime.signal]);
			const downstream = await settleDownstream(next);
			if (fusedSignal.aborted) return;
			if (downstream.type === "error") ctx.logger.warn(`llm-retry-any: provider "${provider}" always policy ignored a downstream recovery failure: %o`, downstream.error);
			if (downstream.type === "decision" && downstream.decision?.kind === "retry") return downstream.decision;
		}
		// fork 的关键差异：不检查 policy.retryableCodes —— 任何 failure.code 都重试。
		const policyKey = retryPolicyKey(policy);
		const previous = ctx.sessionProjections.stateOf(agent.session, "llmRetry")[retryStateKey(provider, policyKey)];
		const previousRetry = previous?.retry ?? 0;
		const effectiveMaxRetries = Math.max(policy.maxRetries ?? 0, minRetries);
		if (policy.mode === "normal" && previousRetry >= effectiveMaxRetries) return next();
		const retry = previousRetry + 1;
		const retryId = previous?.retryId ?? RetryId(randomUUID());
		let delayMs;
		if (failure.providerRetryAfterMs !== void 0 && Number.isFinite(failure.providerRetryAfterMs) && failure.providerRetryAfterMs > 0) if (failure.providerRetryAfterMs > policy.maxDelayMs) {
			if (policy.mode === "normal") return next();
			delayMs = localDelay(policy, retry, random);
		} else delayMs = failure.providerRetryAfterMs;
		else delayMs = localDelay(policy, retry, random);
		return backoff(agent, turn, step, failure, provider, policy, policyKey, retry, retryId, delayMs, signal);
	}
	const disposeListener = ctx.on("agent/request-error", (payload, next) => {
		if (lifetime.signal.aborted) return Promise.resolve(void 0);
		return track(recover(payload, next));
	});
	ctx.effect(() => async () => {
		disposeListener();
		lifetime.abort(/* @__PURE__ */ new Error("llm-retry-any plugin disposed"));
		await Promise.allSettled([...active]);
	}, "llm-retry-any: abort and drain active recovery");
}
//#endregion
export { Config, RetryId, apply, inject, name };
