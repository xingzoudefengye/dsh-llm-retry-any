import test from "node:test";
import assert from "node:assert/strict";
import { apply } from "../lib/index.js";

/**
 * 造一个最小 ctx / agent：只实现本插件实际用到的几个面。
 * 关键是把 `agent.session.append("llm/retry", …)` 回灌成 projection 状态，
 * 这样「已重试几次」的记账与真实运行一致。
 */
function makeHarness({ policy = {}, minRetries } = {}) {
	const state = {};
	const events = [];
	let listener;
	const ctx = {
		logger: { warn() {} },
		sessionProjections: {
			register() {},
			stateOf: () => state,
		},
		on(event, fn) {
			if (event === "agent/request-error") listener = fn;
			return () => {};
		},
		effect() {},
	};
	apply(ctx, minRetries === undefined ? {} : { minRetries }, { random: () => 0.5 });

	const agent = {
		session: {
			append(type, data) {
				events.push({ type, data });
				if (type === "llm/retry") {
					state[JSON.stringify([data.provider, data.policyKey])] = {
						retry: data.retry,
						retryId: data.retryId,
					};
				}
			},
		},
	};

	const effectivePolicy = {
		mode: "normal",
		maxRetries: 5,
		retryableCodes: ["EMPTY_RESPONSE", "RATE_LIMIT", "SERVER", "TIMEOUT", "TRANSPORT"],
		initialDelayMs: 1,
		maxDelayMs: 1,
		jitterRatio: 0,
		...policy,
	};

	const attempt = (code, provider = "newapi-messages") =>
		listener(
			{
				agent,
				turn: 1,
				step: 1,
				provider,
				failure: { code },
				retryPolicy: effectivePolicy,
				signal: new AbortController().signal,
			},
			async () => ({ kind: "fail" }),
		);

	return { attempt, events, state };
}

test("任何错误码都重试 —— 白名单外的码同样重试", async () => {
	const codes = [
		"INVALID_REQUEST", // 2026-10-21 实际踩到的：网关把上游抖动错标成 400
		"QUOTA",
		"CONTEXT_WINDOW_EXCEEDED",
		"INVALID_CREDENTIAL",
		"NO_SUCH_CODE_2026", // 连上游将来新增的未知码也覆盖
	];
	for (const code of codes) {
		const h = makeHarness();
		assert.deepEqual(await h.attempt(code), { kind: "retry" }, `${code} 应触发重试`);
		assert.equal(h.events.filter((e) => e.type === "llm/retry").length, 1);
	}
});

test("重试次数下限 3：provider 配 maxRetries=0 也至少重试 3 次，第 4 次才交下游", async () => {
	const h = makeHarness({ policy: { maxRetries: 0 } });
	const decisions = [];
	for (let i = 0; i < 4; i += 1) decisions.push(await h.attempt("INVALID_REQUEST"));

	assert.deepEqual(decisions.slice(0, 3), [
		{ kind: "retry" },
		{ kind: "retry" },
		{ kind: "retry" },
	]);
	assert.deepEqual(decisions[3], { kind: "fail" }, "第 4 次应委派下游，不再重试");
	const retries = h.events.filter((e) => e.type === "llm/retry");
	assert.equal(retries.length, 3);
	assert.equal(retries[0].data.maxRetries, 3, "生效上限应被抬到下限 3");
});

test("provider 的 maxRetries 高于下限时，以下限之上的配置为准", async () => {
	const h = makeHarness({ policy: { maxRetries: 5 } });
	for (let i = 0; i < 5; i += 1) {
		assert.deepEqual(await h.attempt("SERVER"), { kind: "retry" }, `第 ${i + 1} 次应重试`);
	}
	assert.deepEqual(await h.attempt("SERVER"), { kind: "fail" }, "第 6 次应委派下游");
	assert.equal(h.events.filter((e) => e.type === "llm/retry").length, 5);
});

test("minRetries 可调高", async () => {
	const h = makeHarness({ policy: { maxRetries: 0 }, minRetries: 4 });
	for (let i = 0; i < 4; i += 1) {
		assert.deepEqual(await h.attempt("INVALID_REQUEST"), { kind: "retry" });
	}
	assert.deepEqual(await h.attempt("INVALID_REQUEST"), { kind: "fail" });
});

test("always 模式仍无上限，且先问下游", async () => {
	const h = makeHarness({ policy: { mode: "always" } });
	for (let i = 0; i < 8; i += 1) {
		assert.deepEqual(await h.attempt("INVALID_REQUEST"), { kind: "retry" }, `always 第 ${i + 1} 次仍应重试`);
	}
});

test("没有 provider 策略时原样委派下游", async () => {
	const h = makeHarness();
	let listener;
	const ctx = {
		logger: { warn() {} },
		sessionProjections: { register() {}, stateOf: () => ({}) },
		on(event, fn) {
			if (event === "agent/request-error") listener = fn;
			return () => {};
		},
		effect() {},
	};
	apply(ctx, {}, { random: () => 0.5 });
	const decision = await listener(
		{
			agent: { session: { append() {} } },
			turn: 1,
			step: 1,
			provider: "some-provider",
			failure: { code: "INVALID_REQUEST" },
			retryPolicy: undefined,
			signal: new AbortController().signal,
		},
		async () => ({ kind: "fail" }),
	);
	assert.deepEqual(decision, { kind: "fail" });
	assert.equal(h.events.length, 0);
});
