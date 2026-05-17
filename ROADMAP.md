# koishi-plugin-aka-ai-image-generator Roadmap

## Current status

- Current package version: `0.6.2`.
- Current line: `0.6.x` credit billing and user data v2 is implemented for release preparation; `0.5.x` runtime stabilization is archived as stable after remote validation.
- Current UI model: supplier credentials + model mapping unified config.
- Current publish boundary: the assistant prepares code, docs, versions, changelog, and validation notes; the user publishes manually from the workspace root with `./push.sh aka-ai-image-generator`.

## Stable scope

The plugin is intentionally scoped to image generation only.

Stable runtime direction:

1. Keep supplier credentials and model configuration completely separated:
   - **Suppliers** (credentials only): `openai-compatible`, `gemini-official`, `gpt-official`
   - **Model mappings** (runtime protocol + model ID): `openai`, `gemini`
2. The default model is determined by the **first entry** in `modelMappings`.
3. Keep third-party OpenAI-compatible aggregators configurable through `baseUrl + apiKey + extraHeaders` instead of adding hard-coded provider names.
4. Keep commands prefix-free and user-facing:
   - `文生图`
   - `图生图`
   - `合成图`
   - `图像查询`
   - `图像排行榜`
   - `图像充值`
   - `图像扣除`
   - `图像账单`
   - `图像额度`
   - `图像指令`
   - `图像参数`
5. Keep remote Koishi validation as the source of truth for runtime behavior.

## Completed milestones

### `0.2.x` V2 MVP

- Established the V2 image-only package line.
- Added Provider Registry, Service, simplified Orchestrator, and basic commands.
- Kept the first usable command set to text-to-image, image-to-image, and quota query.

### `0.3.0` OpenAI-compatible protocol MVP

- Added OpenAI-compatible image site support.
- Added OpenAI-compatible image endpoint support for Images API style endpoints.
- Switched user-facing commands to prefix-free names.

### `0.4.0` Protocol-first cleanup

- Removed historical hard-coded third-party supplier entries from the top-level runtime provider model.
- Kept OpenAI-compatible sites configurable through generic endpoint settings.
- Reworked provider routing around protocol/channel choices.

### `0.5.0` to `0.5.5` Semantic supplier UI stabilization

- Reintroduced top-level supplier names as semantic user-facing choices rather than hard-coded third-party providers.
- Routed semantic suppliers to runtime protocols internally.
- Replaced unstable Koishi Console tagged-union layouts with stable object groups.
- Consolidated supplier detail settings into one default-collapsed drawer attempt.
- Added safer diagnostic logging for OpenAI / OpenAI-compatible request paths.
- Removed runtime exposure of unfinished ChatLuna and future command-family features.

### `0.5.6` Command basics and permission completion

- Added `图像指令` and `参数指令`.
- `参数指令` was later renamed to `图像参数` in `0.5.20`.
- Explicitly registered `-n <num:number>` on `文生图` and `图生图`.
- Added command-entry restricted model blocking for model mappings marked with `restricted`.
- Documented that dynamic style commands remain deferred after the command basics patch.

### `0.5.7` Supplier settings collapse fix

- Moved supplier detail fields into a nested `providerSettings` object under the top-level supplier section.
- Applied Koishi Schema `.collapse()` to the nested object instead of a top-level `Schema.intersect` section.
- Kept runtime fallback reads for legacy flat provider fields from `0.5.6` and earlier configs.
- Superseded the previous `0.5.7` dynamic style command slot because the Console settings UI bug has higher priority.

### `0.5.8` Admin usage query, compose image interaction, and style routing

- Implemented the read-only admin command `图像查询 @用户`.
- Kept `图像查询` output minimal: user, total usage, remaining count.
- Implemented the read-only admin command `图像排行榜 [-n 数量]`.
- Kept each leaderboard row minimal: `张三｜总 128｜今日 3｜剩余 12｜`.
- Ranked users by total usage by default, with `-n` controlling the displayed count.
- Added a read-only existing-user lookup path so admin lookup does not create user data when the target user has no existing image usage record.
- Implemented the generic `合成图` multi-image interaction: after the command, the plugin accepts one or multiple images per message and starts execution only when the user sends prompt text.
- Added dynamic `styles` command registration and mode dispatch for `text-to-image`, `image-to-image`, and `compose-image`.
- Added `styles.modelSuffix` model defaults with explicit command suffix taking precedence over the style default.
- Optimized the Koishi Console configuration layout so model mappings appear above Prompt presets, while low-frequency quota and security settings are collapsed.
- Kept `风格迁移` as a future `合成图` prompt preset instead of a separate hard-coded command.
- Kept `图像充值`, credit ledger, and additional built-in preset expansion deferred.

### `0.5.9` Supplier-model separation refactor

- **Removed the global `provider` single-select** from Koishi Console: suppliers now only hold credentials, and the default model is determined by the first entry in `modelMappings`.
- **Renamed suppliers** to avoid confusion:
  - `openai-compatible` — third-party OpenAI-compatible sites (apiKey + apiBase)
  - `gemini-official` — Google Gemini official (apiKey only, fixed base)
  - `gpt-official` — OpenAI official GPT (apiKey only, fixed base)
- **Removed `modelId` from all supplier settings**: model ID is now configured exclusively in `modelMappings`.
- **Unified model mapping `provider` options**: OpenAI Images API or Gemini generateContent protocol.
- **Runtime credential routing**: `openai` reads from `openai-compatible` credentials; `gemini` reads from `gemini-official` credentials with fallback to `openai-compatible` base URL for third-party Gemini-compatible endpoints (e.g. yunwu).
- **Gemini provider imageSize mapping**: added yunwu-compatible `1K / 2K / 4K` mapping for non-official Gemini endpoints, while official endpoints continue using `LOW / MEDIUM / 4K`.
- **Breaking change**: existing `provider` single-select value and supplier-level `modelId` fields are no longer read. Users must reconfigure via the new `modelMappings` + supplier credentials layout after upgrading.

### `0.5.10` Explicit supplier routing fix

- **Model mapping becomes a model route**: each row now explicitly contains supplier credentials source + runtime protocol + model ID.
- **Added explicit supplier selection** in model mappings: `openai-compatible` / `gpt-official` / `gemini-official`.
- **Renamed routing semantics**: the protocol choices are `openai` / `gemini`; the old `provider` field from `0.5.9` is treated as legacy protocol input.
- **Fixed GPT official usability**: `gpt-official` credentials can now be selected by model mappings and route to OpenAI official Images API.
- **Route validation**: `gpt-official` is limited to `openai`, `gemini-official` is limited to `gemini`, and `openai-compatible` may use all implemented protocols.

### `0.5.11` Console wording stabilization

- Shortened Koishi Console configuration text for supplier credentials, model routes, prompt presets, permissions, quota, security, and general settings.
- Kept the change UI-only: runtime route resolution, command behavior, and configuration field semantics are unchanged from `0.5.10`.

### `0.5.12` Task lock cleanup fix

- Fixed stale image task locks after upstream provider failures, network interruptions, or command-level exceptions.
- Added per-task `requestId` ownership so cleanup only releases the current task.
- Added task lock TTL cleanup as a final in-process fallback for leaked locks.

## Archived line: Phase 5 stabilization

Primary plan: `plans/archive/ai-image-generator/ai-image-generator-phase5-command-prompt-plan.md`.

The `0.5.x` command, Console wording, logging, and failure-message stabilization line is archived after `0.5.23` remote validation. Future `0.5.24` patches should only be used for urgent remote bugfixes discovered before or during `0.6.0` work.

Completed patch split:

### `0.5.13` Protocol cleanup

Completed scope:

- Reduced runtime protocol names to `openai` and `gemini`.
- Removed the unused chat-completions image path from source and current documentation.
- Renamed the OpenAI Images runtime registration key to `openai` so model mappings no longer expose endpoint-shape implementation names.

### `0.5.14` Console supplier label cleanup

Completed scope:

- Kept internal supplier keys unchanged for compatibility.
- Shortened Koishi Console supplier display names to third-party / OpenAI / Gemini.
- Shortened credential field labels so users do not need to read long provider descriptions while configuring model routes.

### `0.5.15` Dynamic style command reload fix

Completed scope:

- Made dynamic `styles` / `styleGroups` commands disposable and refreshable.
- Ensured config reload updates the service config before refreshing dynamic commands, so newly configured styleGroup commands become callable without an external plugin restart.
- Updated `图像指令` to list currently active dynamic style commands; this detailed output was later simplified in `0.5.18`.

### `0.5.16` Console field description rebalance

Completed scope:

- Rebalanced Koishi Console wording after the `0.5.14` simplification pass.
- Kept option labels and table column labels short while adding clearer field descriptions for supplier credentials, model routes, prompt presets, grouped styles, permissions, quota, security, and common settings.
- Clarified high-risk configuration semantics in field descriptions: supplier chooses credentials, protocol chooses request format, model suffix selects model mappings, config reload refreshes dynamic style commands, and permanent members do not automatically bypass restricted model permissions.

### `0.5.17` Console initialization guide

Completed scope:

- Added a top-level read-only initialization guide to the Koishi Console config page.
- Guided first-time setup order: supplier credentials, model mappings, then optional shortcut commands.
- Summarized the key routing and permission concepts before users enter detailed config fields.

### `0.5.18` Command help output cleanup

Completed scope:

- Rewrote `图像指令` into compact sections for core generation commands and configured shortcut commands.
- Kept each shortcut command to one line: command name, generation type, and prompt description.
- Removed prompt group names, default model suffixes, model mapping details, query commands, admin commands, and help commands from `图像指令`.
- Rewrote `参数指令` into compact parameter sections for general options, sizes, aspect ratios, and restricted model suffixes.

### `0.5.19` Chat output wording cleanup

Completed scope:

- Standardized chat-visible quota, admin query, ranking, permission, input prompt, generation status, completion, and failure messages.
- Used short titles and one-line `field｜value` rows for query-style outputs.
- Kept process prompts concise while preserving actionable next steps for errors and blocked requests.

### `0.5.20` Image parameter command rename

Completed scope:

- Renamed the parameter help command from `参数指令` to `图像参数`.
- Updated the `图像参数` response title to match the command name.
- Kept `图像指令` pointing to the parameter help entry through the shared command constant, so both help commands now start with `图像`.

### `0.5.21` Log level semantics and diagnostics cleanup

Completed scope:

- Changed the user-facing log level labels to `simple` and `detail`.
- Kept backward compatibility for legacy `info` and `debug` config values through log level normalization.
- Made `detail` explicitly control provider request diagnostics instead of depending on Koishi debug visibility.
- Reduced normal request logs to key routing and generation information.
- Removed prompt previews from OpenAI request diagnostics while preserving prompt length and image payload summaries.

### `0.5.22` Console table label compaction

Completed scope:

- Shortened model mapping table column labels to reduce wrapping in Koishi Console.
- Renamed model mapping labels to `命令名`, `模型 ID`, `供应商`, `接口格式`, and `限制项`.
- Shortened Prompt preset labels to `命令名`, `生成模式`, `生成模型`, `帮助说明`, and `提示词`.
- Kept runtime field names and behavior unchanged; this is a Console wording-only patch.

### `0.5.23` Final failure chat delivery stabilization

Completed scope:

- Changed final no-image generation failures to explicitly send a chat message before returning from the command action.
- Changed final provider exceptions to explicitly send `生成失败` in chat instead of relying on Koishi action auto-reply behavior.
- Changed content safety final warnings to explicitly send `内容安全拦截` when the warning threshold is reached.
- Kept intermediate provider fallback and retry warnings log-only, because those states can recover and still produce images.

## Completed line: `0.6.0` credit billing and user data v2

Reference: `plans/ai-image-generator-credit-billing.md`.

Status: implemented for release preparation after `0.5.23` stabilization was confirmed in the remote Koishi environment; pending user publish and remote validation.

Implemented scope:

- Upgraded user-facing quota semantics from image-count based quota to credit based billing.
- Added per-model credit cost configuration while keeping the default behavior simple: 1 generated image consumes 1 credit.
- Kept image generation statistics separate from credit consumption statistics.
- Introduced user data v2 files: `users.v2.json`, `credit-ledger.v2.jsonl`, and `recharge-records.v2.jsonl` with atomic user-store writes and backup file handling.
- Added generation precheck by estimated credits and post-success deduction by successfully sent image count.
- Added administrator recharge, deduction, ledger, query, ranking, and user quota outputs using credit terminology.
- Kept the first `0.6.0` implementation focused on billing and data durability; Console WebUI, ChatLuna bridge, and unrelated preset expansion remain deferred.

Remote validation focus:

1. Default cost: 1 generated image consumes 1 credit.
2. Per-model cost: a model mapping with custom `creditCostPerImage` changes precheck and deduction.
3. Balance shortage: insufficient credit shows required, daily free, purchased balance, and total available.
4. Decimal credits: model and global credit settings accept decimal values and normalize balances to two decimal places.
5. Admin / permanent member / platform bypass: generation records statistics but does not deduct credits, and first-time exempt user snapshots follow the current daily free credit config.
6. Partial success: only successfully sent images are charged.
7. Ledger traceability: generation, recharge, and deduction appear in `图像账单` and JSONL files.
8. Admin deduction feedback: insufficient purchased balance returns partial deduction or deduction failure instead of a normal completion message.

## Deferred lines

### Console WebUI

Reference: `plans/archive/ai-image-generator/ai-image-generator-optional-console-webui.md`.

Status: low-priority optional future direction.

Do not use the Console WebUI document as implementation input for the current runtime plugin.

### ChatLuna bridge and migration tooling

Status: retained as future planning only.

The current `0.6.x` runtime must not expose incomplete ChatLuna configuration, ChatLuna tools, or V1 migration commands.

## Documentation maintenance rules

Active document index: `docs/active-documents.md`.

Historical design, V2 scaffolding, protocol research, Phase 5 stabilization, supplier settings patch, old send-failure analysis, and optional Console WebUI notes have been archived under `docs/archive/ai-image-generator/` and `plans/archive/ai-image-generator/`. Do not use archived documents as active implementation requirements unless the user explicitly asks to revive one of those lines.

Before any publishable change in this plugin:

1. Update this roadmap if the active line or deferred scope changes.
2. Update `CHANGELOG.md` with version impact and known limitations.
3. Update `README.md` so it only documents currently implemented user-facing behavior.
4. Keep related plan documents marked as active, completed, deferred, or historical to avoid stale guidance.
5. Do not run publish commands automatically; the user publishes manually with `./push.sh aka-ai-image-generator`.
