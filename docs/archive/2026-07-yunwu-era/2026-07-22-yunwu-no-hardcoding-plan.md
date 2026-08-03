# Yunwu No-Hardcoding Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development. Every task follows RED → GREEN → refactor → independent review. Track progress in `.superpowers/sdd/progress.md`.

**Goal:** 将 `aka-ai-image-generator` 重构为 yunwu 单供应商优先、目录/能力/路由/价格/售价/预授权/结算分层、无模型和价格业务硬编码的可验证实现。

**Architecture:** yunwu 原始 HTTP 快照经规范化 adapter 生成 fail-closed Catalog；生成请求从 Catalog route 选择协议，由 Quote/Charge/Reservation/Settlement 服务完成成本证据、用户售价、真实预留和最终扣费。Console 只消费后端视图模型，不计算价格。

**Tech Stack:** TypeScript 5.9、Node.js 22、Koishi 4、Vitest、tsup、koishi-console/Vue、Docker `mita_koishi`。

## Global Constraints

- 当前仅完整维护 yunwu；其他供应商只保留结构化 `unsupported` 边界。
- 不得以具体 yunwu 模型 ID 作为运行默认值，不得维护静态模型价格表。
- 不得按模型名猜协议；未知 endpoint/capability 必须 fail-closed。
- 目录报价、估算、实际成本、用户售价、预授权、结算独立建模。
- 前端不得包含成本公式。
- 旧 `creditCostPerImage` 必须无损迁移为 fixed policy；旧流水不重写。
- 每个任务同步更新 `docs/working/YUNWU_IMPLEMENTATION_BASELINE.md` 的实现状态/验证证据。
- 每个任务使用 targeted `git add` 和独立 Conventional Commit。
- 每个生产代码行为必须先有失败测试；测试文件不得删除或缩减。
- 每个任务结束运行 `npm run test`、`npm run typecheck`；涉及 bundle 再运行 `npm run build`。
- 运行容器部署必须先备份现有插件，复制 `lib/`、`dist/`、`package.json`，重启并核验日志与文件哈希。

---

### Task 1: 测试基础、Yunwu 原始契约和 Client

**Files:**
- Modify: `package.json`
- Modify: `package-lock.json`
- Modify: `tsconfig.json`
- Create: `vitest.config.ts`
- Create: `src/suppliers/types.ts`
- Create: `src/suppliers/yunwu/raw-types.ts`
- Create: `src/suppliers/yunwu/client.ts`
- Create: `tests/fixtures/yunwu/models.json`
- Create: `tests/fixtures/yunwu/pricing.json`
- Create: `tests/fixtures/yunwu/billing.json`
- Create: `tests/fixtures/yunwu/status.json`
- Create: `tests/suppliers/yunwu/client.test.ts`
- Create: `tests/suppliers/yunwu/contract.test.ts`
- Modify: `docs/working/YUNWU_IMPLEMENTATION_BASELINE.md`

**Interfaces:**
- Produces: `YunwuClient.fetchSnapshot(signal?): Promise<SupplierRawSnapshot>`
- Produces: `createKeyScopeFingerprint({ supplier, apiBase, apiKey }): string`
- Produces: complete `YunwuModelItem` / `YunwuPricingItem` types preserving unknown fields through `raw`.

- [ ] RED: add Vitest and tests asserting `/v1/models`, `/api/pricing`, billing and status requests, auth redaction, base `/v1` normalization, timeout/AbortSignal, and fingerprint changes when base/key changes.
- [ ] RED command: `npm run test -- tests/suppliers/yunwu/client.test.ts tests/suppliers/yunwu/contract.test.ts`; expected FAIL because modules do not exist.
- [ ] GREEN: implement pure fetch transport injection and raw snapshot; snapshot must not serialize `apiKey` or Authorization.
- [ ] Fixture: collect current production responses through a one-shot redacting script; preserve fields including `image_ratio`, `completion_ratio`, `available`, `type`, `tags`, `vendor_id`, `sort_order`; never commit credentials/user billing identity.
- [ ] GREEN command: targeted tests PASS, then `npm run typecheck` PASS.
- [ ] Update baseline fields/counts and append Task 1 verification.
- [ ] Commit: `feat(yunwu): add raw catalog client and contract fixtures`.

**Stop:** any fixture contains API Key, Authorization, token name tied to a secret, or client drops unknown pricing fields.

---

### Task 2: Fail-Closed Catalog、Capability 和 Route Resolver

**Files:**
- Create: `src/catalog/model-catalog.ts`
- Create: `src/suppliers/yunwu/capability.ts`
- Create: `src/suppliers/yunwu/routes.ts`
- Create: `src/suppliers/yunwu/normalizer.ts`
- Create: `tests/catalog/yunwu-normalizer.test.ts`
- Create: `tests/catalog/capability.test.ts`
- Create: `tests/catalog/routes.test.ts`
- Modify: `docs/working/YUNWU_IMPLEMENTATION_BASELINE.md`

**Interfaces:**
- Produces: `normalizeYunwuSnapshot(snapshot): CatalogSnapshot`
- Produces: `resolveYunwuCapabilities(model): ModelCapability[]`
- Produces: `resolveYunwuRoutes(model): GenerationRoute[]`
- `CatalogModel.executable = availability === 'available' && routes.length > 0`.

- [ ] RED tests: verified endpoint fixtures generate explicit OpenAI Images/Gemini routes; unknown endpoint yields no route; models with recognition/upload/video only are non-executable.
- [ ] Mandatory negatives: `kling-avatar-image2video`, `kling-image-recognize`, `mj_upload`, `pixverse-image-template`, `mj_video` not executable.
- [ ] RED command: `npm run test -- tests/catalog`; expected missing exports/failing assertions.
- [ ] GREEN: implement endpoint mapping as supplier protocol constants, each mapping annotated by fixture case; model-name keywords may only populate diagnostics.
- [ ] Assert full catalog retains unsupported models while executable selector projection excludes them.
- [ ] Run targeted tests, full test, typecheck.
- [ ] Update baseline with recognized/unsupported/unknown counts.
- [ ] Commit: `feat(catalog): normalize yunwu capabilities and routes fail closed`.

**Stop:** any unknown endpoint falls back to OpenAI/Gemini or a negative model is executable.

---

### Task 3: Pricing、CostQuote、ChargePolicy 与 Settlement 纯领域层

**Files:**
- Create: `src/suppliers/yunwu/pricing.ts`
- Create: `src/billing/types.ts`
- Create: `src/billing/quote-service.ts`
- Create: `src/billing/charge-policy.ts`
- Create: `src/billing/settlement-service.ts`
- Create: `tests/billing/pricing.test.ts`
- Create: `tests/billing/quote-service.test.ts`
- Create: `tests/billing/charge-policy.test.ts`
- Create: `tests/billing/settlement-service.test.ts`
- Modify: `docs/working/YUNWU_IMPLEMENTATION_BASELINE.md`

**Interfaces:**
- Produces: `normalizeYunwuPrice(raw): SupplierPrice`
- Produces: `quoteSupplierCost(model, request, formulaRegistry): CostQuote`
- Produces: `quoteUserCharge(costQuote, policy, count): UserChargeQuote`
- Produces: `settleGeneration(reservation, deliveredImages): GenerationSettlement`.

- [ ] RED: per-call gives `catalog-quote`; per-token without configured formula gives `unknown`; no built-in 2000-token/$2 formula; fixed policy independent of supplier price; unknown cost-plus rejected; settlement conservation `reserved = settled + released`.
- [ ] RED command: `npm run test -- tests/billing`; expected FAIL.
- [ ] GREEN: preserve all pricing fields and evidence; `actual` unavailable unless explicit request-level evidence supplied.
- [ ] Delete no old runtime code yet; this task is pure additive domain layer.
- [ ] Full test/typecheck.
- [ ] Update baseline with formula removal target now implemented in new layer.
- [ ] Commit: `feat(billing): separate catalog quotes charge policies and settlement`.

**Stop:** public catalog price is labeled actual/exact, or unknown quote silently becomes a charge.

---

### Task 4: Config Schema 与无损迁移，移除默认模型/隐式价格/名称路由

**Files:**
- Modify: `src/shared/types.ts`
- Modify: `src/shared/config.ts`
- Create: `src/config/migrate-config.ts`
- Create: `tests/config/migrate-config.test.ts`
- Modify: `src/service/AiImageGeneratorService.ts`
- Modify: `src/commands/image.ts`
- Modify: `src/utils/parser.ts`
- Create: `tests/service/model-route-selection.test.ts`
- Modify: `docs/working/YUNWU_IMPLEMENTATION_BASELINE.md`

**Interfaces:**
- `ModelMappingConfig.chargePolicy: ChargePolicy`
- Produces: `migrateLegacyConfig(config): { config; warnings; changed }`
- `ImageRequestContext.routeId` replaces name-derived provider choice.

- [ ] RED migration tests: legacy explicit `creditCostPerImage` -> fixed; no explicit model price + catalog-quote -> cost-plus with `acceptEstimated=false`; unknown -> disabled; user/account/ledger files untouched.
- [ ] RED behavior tests: empty mappings produce explicit configuration error; no fallback to `gpt-image-2`; model ID containing/omitting `gemini` has no effect on protocol.
- [ ] GREEN: remove Schema default mappings, `DEFAULT_OPENAI_MODEL_ID`, `/gemini/i` route inference and implicit `defaultCreditCostPerImage` runtime fallback.
- [ ] Keep old fields readable for one release; issue one deduplicated migration warning.
- [ ] Update style/default mapping behavior to require configured first mapping.
- [ ] Full test/typecheck/build.
- [ ] Update baseline hardcoding inventory and migration status.
- [ ] Commit: `refactor(config): migrate explicit charge policies and catalog routes`.

**Stop:** any production path still selects protocol from model name or invokes a concrete default model without mapping.

---

### Task 5: 原子 CatalogRepository、Key Scope 和可热更新 Scheduler

**Files:**
- Create: `src/catalog/catalog-repository.ts`
- Create: `src/catalog/catalog-scheduler.ts`
- Create: `tests/catalog/catalog-repository.test.ts`
- Create: `tests/catalog/catalog-scheduler.test.ts`
- Modify: `src/catalog/image-catalog.ts`
- Modify: `src/index.ts`
- Modify: `docs/working/YUNWU_IMPLEMENTATION_BASELINE.md`

**Interfaces:**
- `CatalogRepository.load(scope): Promise<CatalogCacheEnvelope | null>`
- `CatalogRepository.save(envelope): Promise<void>`
- `CatalogScheduler.start(hours)`, `updateInterval(hours)`, `refreshNow()`, `stop()`.

- [ ] RED repository tests: different key/base fingerprint rejects cache; corrupt temp/final file does not destroy last complete cache; stale cache marked stale; write uses temp+fsync+rename.
- [ ] RED scheduler tests with fake timers: update interval disposes old timer; single-flight merges concurrent refresh; stop prevents ticks.
- [ ] GREEN: replace synchronous `writeFileSync` cache path and fixed startup interval.
- [ ] Wire current config acceptor so `catalogRefreshHours` updates scheduler even when credentials unchanged.
- [ ] Full test/typecheck/build.
- [ ] Update baseline cache schema/parser version and verification.
- [ ] Commit: `feat(catalog): add scoped atomic cache and hot reload scheduler`.

**Stop:** changing Key/base restores old catalog or two timers remain active after hot reload.

---

### Task 6: 真实预授权、生成链路接入和结算账本

**Files:**
- Modify: `src/services/UserManager.ts`
- Modify: `src/service/AiImageGeneratorService.ts`
- Modify: `src/orchestrators/ImageGenerationOrchestrator.ts`
- Modify: `src/providers/types.ts`
- Modify: `src/providers/openai.ts`
- Modify: `src/providers/gemini.ts`
- Create: `tests/services/user-reservation.test.ts`
- Create: `tests/orchestrators/generation-settlement.test.ts`
- Create: `tests/service/catalog-route-execution.test.ts`
- Modify: `docs/working/YUNWU_IMPLEMENTATION_BASELINE.md`

**Interfaces:**
- Replace check-only reservation with persisted/in-memory locked `CreditReservation` keyed by requestId.
- `reserveCredits`, `settleReservation`, `releaseReservation`; operations idempotent.
- Provider creation consumes `GenerationRoute`, not inferred provider/model pair.

- [ ] RED tests: concurrent reservations cannot overspend same balance; failed/timeout request releases reservation; partial delivery settles exact delivered count; repeated settle/release is idempotent; exempt users record settlement without debit.
- [ ] RED integration test: routeId selects OpenAI/Gemini provider independent of model name.
- [ ] GREEN: implement reservation state under `dataLock`; use deterministic requestId from task; add ledger metadata with quote status, routeId, policy and reserved/settled/released.
- [ ] Ensure process crash recovery policy: reservations have expiry and are released/reconciled on startup without rewriting old consume events.
- [ ] Full test/typecheck/build.
- [ ] Update baseline with reservation semantics and ledger schema compatibility.
- [ ] Commit: `feat(billing): reserve and settle generation credits atomically`.

**Stop:** balance can be oversubscribed, conservation fails, or timeout leaves active reservation.

---

### Task 7: aka-tools 后端契约和页面重构

**Files:**
- Modify: `src/console/service.ts`
- Create: `src/console/view-model.ts`
- Create: `tests/console/view-model.test.ts`
- Modify: `client/page.vue`
- Modify: `src/shared/config.ts`
- Modify: `docs/working/YUNWU_IMPLEMENTATION_BASELINE.md`

**Interfaces:**
- Produces: `buildConsoleState(config, catalog, billing): ImageGeneratorConsoleState`.
- Console rows include capability/routes/availability/catalogPrice/costQuote/chargePolicy/source/freshness/unsupportedReasons.

- [ ] RED tests: fixed price labeled operational; catalog quote not actual; unknown token quote has no numeric per-image amount; unsupported models grouped separately; only executable models selectable.
- [ ] GREEN backend state contract.
- [ ] Remove frontend `autoCredits()` and all pricing arithmetic; render backend labels/data only.
- [ ] UI exposes yunwu as maintained supplier; other supplier options hidden or disabled with “暂未适配”.
- [ ] New mapping defaults to `disabled`; old invalid mapping remains visible/red, never auto-deleted.
- [ ] Run tests/typecheck/build; inspect built bundle contains no `0.004` pricing formula.
- [ ] Deploy bundle to test container only after backup; restart and verify aka-tools state and browser-visible categories.
- [ ] Update baseline UI state and screenshots/observations if available.
- [ ] Commit: `feat(aka-tools): expose sourced pricing and executable yunwu catalog`.

**Stop:** frontend computes price, fixed price is shown as supplier cost, or unsupported model can be newly selected.

---

### Task 8: Probe、真实 Smoke、旧代码清理、文档与版本

**Files:**
- Create: `scripts/probe-yunwu-catalog.mjs`
- Create: `tests/scripts/probe-yunwu-catalog.test.ts`
- Delete after zero-consumer proof: `src/catalog/newapi-client.ts`
- Refactor/delete after zero-consumer proof: `src/shared/billing.ts`
- Modify: `src/catalog/image-catalog.ts`
- Modify: `README.md`
- Modify: `ROADMAP.md`
- Modify: `CHANGELOG.md`
- Modify: `docs/working/YUNWU_IMPLEMENTATION_BASELINE.md`
- Modify: `package.json`
- Modify: `package-lock.json`

**Interfaces:**
- Probe accepts config path/env, prints fingerprint, field/endpoint/count/price diff, never secrets, no writes except optional report path.

- [ ] RED probe tests: redaction, read-only behavior, unknown endpoint report, schema diff, exit codes.
- [ ] GREEN probe and npm script `probe:yunwu`.
- [ ] Search/cleanup gate: no `DEFAULT_OPENAI_MODEL_ID`, no `ESTIMATED_TOKENS_PER_IMAGE`, no `TOKEN_BASE_PRICE_PER_MILLION`, no `0.004 *`, no `/gemini/i` route inference, no executable fallback in `inferModes`.
- [ ] Remove obsolete files/types/fields only after `search_files` proves no consumers.
- [ ] Run real probe against production key; update fixture/baseline only after reviewing sanitized diff.
- [ ] Version bump to next semver minor (`0.9.0`) because config/billing contract changes; document migration and rollback.
- [ ] Full tests/typecheck/build.
- [ ] Container backup/deploy/restart/hash verification.
- [ ] Real smoke: one approved low-cost text-to-image and one image-to-image route; verify returned image, request logs, reservation, settlement, ledger and no secret leak.
- [ ] Update README/ROADMAP/CHANGELOG/baseline with exact final behavior and test evidence.
- [ ] Commit: `release: prepare 0.9.0 yunwu catalog and billing architecture`.

**Stop:** probe leaks credentials, old hardcoding search finds production consumers, smoke debit differs from delivered images, or container artifact hash differs from local build.

---

### Task 9: Whole-Branch Review、Final Verification 与 GitHub

**Files:**
- Create: `docs/verification/2026-07-22-yunwu-no-hardcoding-verification.md`
- Modify if findings: affected code/tests/docs only.

- [ ] Generate full diff review package from merge base `8ba6c1c`/branch base and dispatch independent code reviewer.
- [ ] Fix every Critical/Important finding in one review-fix wave; re-review until clean.
- [ ] Fresh verification: `npm ci`, `npm run test`, `npm run typecheck`, `npm run build`, `npm run probe:yunwu`.
- [ ] Verify `git diff --check`, no unexpected generated/tracked files, no test deletion, no secrets, clean worktree.
- [ ] Write verification document with commands, outputs, container hashes, smoke request IDs with internal IDs redacted from user-facing docs, ledger conservation and known limitations.
- [ ] Commit verification: `docs: record yunwu 0.9.0 verification evidence`.
- [ ] Git pre-push audit: remote URL, `origin/main..HEAD`, diff stat, symlinks, `git push --dry-run`.
- [ ] Push `refactor/yunwu-no-hardcoding` to GitHub; create PR to `main` with design, migration and test evidence.
- [ ] Monitor CI and fix failures up to three evidence-based cycles.
- [ ] When green, merge PR using squash unless repository policy requires merge commit; update local main, verify local HEAD equals remote main SHA.

**Final acceptance:** all design invariants pass; docs fresh; GitHub main contains verified code; production container is running matching built artifacts; no open P0/P1 findings.
