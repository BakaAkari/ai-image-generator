<template>
  <k-layout>
    <template #header>
      <span>aka-tools · 图像生成</span>
    </template>
    <!-- 顶层浮动工具按钮：图像 / 视频 / 存储（Teleport 到 body，避免祖先 transform 使 fixed 失效） -->
    <Teleport to="body">
    <div class="floating-tools" v-if="isAkaToolsRoute">
      <div class="tool-btn" :class="{ saving }" title="保存全部设置" @click="saveAll">
        <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z"/><polyline points="17 21 17 13 7 13 7 21"/><polyline points="7 3 7 8 15 8"/></svg>
      </div>
      <div class="tool-btn active" title="图像生成设置">
        <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><path d="m21 15-5-5L5 21"/></svg>
      </div>
      <div class="tool-btn" title="视频生成设置" @click="openVideoTools">
        <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="4" width="15" height="16" rx="2"/><path d="m17 9 5-3v12l-5-3"/></svg>
      </div>
      <div class="tool-btn disabled" title="存储管理（即将推出）">
        <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><ellipse cx="12" cy="5" rx="8" ry="3"/><path d="M4 5v6c0 1.66 3.58 3 8 3s8-1.34 8-3V5"/><path d="M4 11v6c0 1.66 3.58 3 8 3s8-1.34 8-3v-6"/></svg>
      </div>
    </div>
    </Teleport>

    <div class="image-page">
      <!-- header: tabs + actions（与视频页同款页头） -->
      <div class="page-header">
        <el-radio-group v-model="activeTab" class="page-tabs">
          <el-radio-button v-for="tab in tabs" :key="tab.key" :value="tab.key">{{ tab.label }}</el-radio-button>
        </el-radio-group>
        <div class="header-actions">
          <el-button size="small" plain @click="loadState" :loading="loading">刷新</el-button>
          <el-button size="small" type="primary" :loading="saving" @click="saveAll">保存全部</el-button>
        </div>
      </div>

      <div v-if="!state" class="loading">正在加载…</div>
      <div v-else class="page-body">
        <!-- 总览 -->
        <section v-show="activeTab === 'overview'" class="tab-panel">
          <div class="stat-row">
            <div class="stat-card">
              <div class="stat-value">{{ state.catalog?.models?.length ?? 0 }}</div>
              <div class="stat-label">目录模型</div>
            </div>
            <div class="stat-card">
              <div class="stat-value">{{ catalogAge }}</div>
              <div class="stat-label">目录更新</div>
            </div>
            <div class="stat-card">
              <div class="stat-value">{{ supplierCreditsDisplay }}</div>
              <div class="stat-label">供应商积分</div>
            </div>
            <div class="stat-card">
              <div class="stat-value">{{ billingLimit }}</div>
              <div class="stat-label">Key 限额</div>
            </div>
          </div>

          <!-- 用量统计 -->
          <div class="stat-row">
            <div class="stat-card"><div class="stat-value">{{ overviewTotals?.users ?? '—' }}</div><div class="stat-label">总用户</div></div>
            <div class="stat-card"><div class="stat-value">{{ overviewTotals?.totalRequests ?? '—' }}</div><div class="stat-label">累计请求</div></div>
            <div class="stat-card"><div class="stat-value">{{ overviewTotals?.totalImages ?? '—' }}</div><div class="stat-label">累计生成</div></div>
            <div class="stat-card"><div class="stat-value">{{ overviewTotals?.totalFailed ?? '—' }}</div><div class="stat-label">累计失败</div></div>
            <div class="stat-card"><div class="stat-value">{{ successRateDisplay }}</div><div class="stat-label">成功率</div></div>
            <div class="stat-card"><div class="stat-value">{{ formatCredits(overviewTotals?.totalConsumedCredits) }}</div><div class="stat-label">累计消耗积分</div></div>
            <div class="stat-card"><div class="stat-value">{{ formatCredits(overviewTotals?.purchasedBalance) }}</div><div class="stat-label">购买余额总计</div></div>
            <div class="stat-card"><div class="stat-value">{{ overviewTotals?.trialImagesUsed ?? '—' }}</div><div class="stat-label">试用已用（张）</div></div>
          </div>

          <k-card title="模型用量" class="section" shadow="never">
            <el-table :data="overviewStats?.modelRows ?? []" size="small" class="dark-table" max-height="360">
              <el-table-column prop="modelId" label="模型" min-width="220" />
              <el-table-column prop="images" label="生成张数" width="120" sortable :sort-orders="['descending', 'ascending']" />
              <el-table-column prop="percent" label="占比" width="120" />
            </el-table>
            <div v-if="overviewStats && !overviewStats.modelRows.length" class="hint">暂无数据，生成图片后将自动统计。</div>
          </k-card>

          <k-card title="用户用量排行（Top 20）" class="section" shadow="never">
            <el-table :data="overviewStats?.userRows ?? []" size="small" class="dark-table" max-height="440">
              <el-table-column prop="userId" label="userId" min-width="140" />
              <el-table-column prop="userName" label="userName" min-width="140" />
              <el-table-column prop="images" label="生成" width="80" sortable :sort-orders="['descending', 'ascending']" />
              <el-table-column prop="requests" label="请求" width="80" />
              <el-table-column prop="failed" label="失败" width="80" />
              <el-table-column label="消耗积分" width="110">
                <template #default="{ row }">{{ formatCredits(row.consumedCredits) }}</template>
              </el-table-column>
              <el-table-column label="购买余额" width="110">
                <template #default="{ row }">{{ formatCredits(row.purchasedBalance) }}</template>
              </el-table-column>
              <el-table-column prop="trialImagesUsed" label="试用已用" width="90" />
              <el-table-column label="最近使用" width="150">
                <template #default="{ row }">{{ timeLabel(row.lastUsedAt) }}</template>
              </el-table-column>
            </el-table>
            <div v-if="overviewStats && !overviewStats.userRows.length" class="hint">暂无用户数据。</div>
          </k-card>
        </section>

        <!-- 供应商与凭证 -->
        <section v-show="activeTab === 'credentials'" class="tab-panel">
          <div class="panel-limit">
            <k-card title="供应商与凭证" class="section" shadow="never">
              <div class="supplier-picker">
                <div
                  v-for="s in supplierOptions" :key="s.value"
                  class="supplier-option" :class="{ active: cfg.activeSupplier === s.value, disabled: s.disabled }"
                  @click="!s.disabled && (cfg.activeSupplier = s.value)"
                >
                  <div class="supplier-name">{{ s.label }}</div>
                  <div class="supplier-desc">{{ s.desc }}</div>
                </div>
              </div>
              <el-form label-width="180px" class="cred-form">
                <template v-if="cfg.activeSupplier === 'newapi'">
                  <el-form-item label="NewAPI API Key">
                    <el-input v-model="cfg.providerSettings.openaiCompatibleApiKey" type="password" show-password placeholder="sk-..." />
                  </el-form-item>
                  <el-form-item label="Base URL">
                    <el-input v-model="cfg.providerSettings.openaiCompatibleApiBase" placeholder="https://api.openlux.ai/v1" />
                  </el-form-item>
                  <el-form-item label="额外请求头">
                    <div class="extra-headers">
                      <div v-for="(row, i) in extraHeadersRows" :key="i" class="extra-header-row">
                        <el-input v-model="row.key" size="small" placeholder="Header 名" style="width: 200px" @input="syncExtraHeaders" />
                        <el-input v-model="row.value" size="small" placeholder="值（字符串）" style="flex: 1" @input="syncExtraHeaders" />
                        <el-button link type="danger" size="small" @click="removeExtraHeader(i)">删</el-button>
                      </div>
                      <el-button size="small" @click="addExtraHeader">添加请求头</el-button>
                      <div class="hint">键和值都会强制转成字符串；空键或空值会在保存前被丢弃。</div>
                    </div>
                  </el-form-item>
                </template>
                <template v-else-if="cfg.activeSupplier === 'openai-official'">
                  <el-form-item label="OpenAI API Key">
                    <el-input v-model="cfg.providerSettings.gptOfficialApiKey" type="password" show-password placeholder="sk-..." />
                  </el-form-item>
                </template>
                <template v-else>
                  <el-form-item label="Gemini API Key">
                    <el-input v-model="cfg.providerSettings.geminiOfficialApiKey" type="password" show-password />
                  </el-form-item>
                </template>

              </el-form>
            </k-card>
          </div>
        </section>

        <!-- 模型目录 -->
        <section v-show="activeTab === 'catalog'" class="tab-panel">
          <k-card class="section" shadow="never">
            <template #header>
              <div class="card-header">
                <span>模型目录（{{ filteredCatalog.length }} / {{ state.catalog?.models?.length ?? 0 }}）</span>
                <div class="header-actions">
                  <el-input v-model="catalogFilter" placeholder="搜索模型" clearable style="width: 200px" />
                  <el-button :loading="refreshing" @click="refreshCatalog">刷新目录</el-button>
                </div>
              </div>
            </template>
            <el-table :data="filteredCatalog" max-height="480" size="small" class="dark-table">
              <el-table-column prop="id" label="模型" min-width="200" sortable />
              <el-table-column label="提供商" width="80">
                <template #default="{ row }">
                  <el-tag size="small" :type="row.routes?.[0]?.protocol === 'openai' ? '' : row.routes?.[0]?.protocol === 'gemini' ? 'success' : 'warning'">
                    {{ row.routes?.[0]?.protocol?.toUpperCase() || '—' }}
                  </el-tag>
                </template>
              </el-table-column>
              <el-table-column label="预估成本" width="190">
                <template #default="{ row }">
                  <span :style="{ fontWeight: 600, color: row.yunwuCost?.type === 'per-call' ? 'var(--el-color-success)' : 'var(--fg2)', whiteSpace: 'nowrap' }">{{ row.yunwuCost?.label ?? '—' }}</span>
                  <div class="hint" style="margin: 0.2rem 0 0; font-size: 0.7rem; white-space: nowrap;">仅参考，运行时以目录价格为准</div>
                </template>
              </el-table-column>
              <el-table-column label="模式" width="140">
                <template #default="{ row }">
                  <el-tag v-for="m in row.modes" :key="m" size="small" class="mode-tag">{{ modeLabel(m) }}</el-tag>
                </template>
              </el-table-column>
            </el-table>
            <div v-if="state.catalog?.error" class="error-line">上次刷新失败：{{ state.catalog.error }}（当前为缓存数据）</div>
            <el-collapse v-if="state.catalog?.unsupportedModels?.length" class="unsupported-block">
              <el-collapse-item :title="`不可执行模型（${state.catalog.unsupportedModels.length}）`">
                <el-table :data="state.catalog.unsupportedModels" size="small" class="dark-table">
                  <el-table-column prop="id" label="模型" min-width="240" />
                  <el-table-column label="状态" width="100"><template #default><el-tag type="danger" size="small">不可选择</el-tag></template></el-table-column>
                  <el-table-column label="原因" min-width="260"><template #default="{ row }">{{ row.unsupportedReasons?.join('；') || '未识别生成路由' }}</template></el-table-column>
                </el-table>
              </el-collapse-item>
            </el-collapse>
          </k-card>
        </section>

        <!-- 模型映射 -->
        <section v-show="activeTab === 'mappings'" class="tab-panel">
          <k-card title="模型映射" class="section" shadow="never">
            <template #header>
              <div class="card-header">
                <span>模型映射（第一条为默认模型）</span>
                <el-button size="small" @click="addMapping">添加映射</el-button>
              </div>
            </template>
            <div class="hint">命令后缀用于聊天中 -后缀 切换模型；新映射默认自动定价，基于目录价格估算。</div>
            <el-table :data="cfg.modelMappings" size="small" style="width: 100%">
              <el-table-column label="排序" width="60">
                <template #default="{ $index }">
                  <el-button link size="small" :disabled="$index === 0" @click="moveMapping($index, -1)">↑</el-button>
                  <el-button link size="small" :disabled="$index === cfg.modelMappings.length - 1" @click="moveMapping($index, 1)">↓</el-button>
                </template>
              </el-table-column>
              <el-table-column label="命令后缀" width="110">
                <template #default="{ row }"><el-input v-model="row.suffix" size="small" /></template>
              </el-table-column>
              <el-table-column label="模型" min-width="180">
                <template #default="{ row }">
                  <el-select v-model="row.modelId" size="small" filterable style="width: 100%">
                    <el-option v-for="m in selectableModels" :key="m.id" :value="m.id" :label="modelOptionLabel(m)" />
                  </el-select>
                </template>
              </el-table-column>
              <el-table-column label="受限" width="55">
                <template #default="{ row }"><el-checkbox v-model="row.restricted" /></template>
              </el-table-column>
              <el-table-column label="状态" width="70">
                <template #default="{ row }">
                  <el-tag :type="mappingValid(row) ? 'success' : 'danger'" size="small">{{ mappingValid(row) ? '可用' : '失效' }}</el-tag>
                </template>
              </el-table-column>
              <el-table-column label="" width="50">
                <template #default="{ $index }">
                  <el-button link type="danger" size="small" @click="cfg.modelMappings.splice($index, 1)">删</el-button>
                </template>
              </el-table-column>
            </el-table>
          </k-card>
        </section>

        <!-- Prompt 预设 -->
        <section v-show="activeTab === 'presets'" class="tab-panel">
          <k-card class="section" shadow="never">
            <template #header>
              <div class="card-header">
                <span>Prompt 预设</span>
                <div class="header-actions">
                  <el-button size="small" @click="addStylePreset(null)">添加未分组预设</el-button>
                  <el-button size="small" type="primary" @click="addStyleGroup">添加分组</el-button>
                </div>
              </div>
            </template>
            <div class="hint">分组仅用于后台分类管理；聊天中仍直接使用预设的命令名调用，不生成父级命令、不改变运行逻辑。</div>

            <!-- 未分组：固定第一块，绑定 cfg.styles -->
            <div class="preset-section">
              <div class="preset-section-header">
                <span class="preset-section-title">未分组</span>
                <el-button size="small" @click="addStylePreset(null)">添加预设</el-button>
              </div>
              <div v-if="!cfg.styles.length" class="hint">尚无未分组预设。</div>
              <el-collapse v-else>
                <el-collapse-item
                  v-for="(style, i) in cfg.styles"
                  :key="`ungrouped::${i}::${style.commandName || 'unnamed'}`"
                  :title="style.commandName || `预设 ${i + 1}`"
                >
                  <el-form label-width="110px">
                    <el-form-item label="命令名"><el-input v-model="style.commandName" style="width: 200px" /></el-form-item>
                    <el-form-item label="生成模式">
                      <el-radio-group v-model="style.mode">
                        <el-radio-button value="text-to-image">文生图</el-radio-button>
                        <el-radio-button value="image-to-image">图生图</el-radio-button>
                        <el-radio-button value="compose-image">合成图</el-radio-button>
                      </el-radio-group>
                    </el-form-item>
                    <el-form-item label="模型后缀">
                      <el-select v-model="style.modelSuffix" clearable placeholder="默认模型" style="width: 220px">
                        <el-option v-for="m in cfg.modelMappings" :key="m.suffix" :value="m.suffix" :label="`${m.suffix}（${m.modelId}）`" />
                      </el-select>
                    </el-form-item>
                    <el-form-item label="帮助说明"><el-input v-model="style.description" type="textarea" :rows="2" /></el-form-item>
                    <el-form-item label="提示词"><el-input v-model="style.prompt" type="textarea" :rows="5" /></el-form-item>
                    <el-form-item label="移动到">
                      <el-select
                        :model-value="''"
                        placeholder="选择目标分组"
                        :disabled="!moveTargets(null).length"
                        style="width: 220px"
                        @change="movePreset(null, i, $event)"
                      >
                        <el-option v-for="t in moveTargets(null)" :key="`ungrouped-mv-${t.value}`" :value="t.value" :label="t.label" />
                      </el-select>
                    </el-form-item>
                    <el-form-item><el-button type="danger" size="small" @click="removeStylePreset(null, i)">删除此预设</el-button></el-form-item>
                  </el-form>
                </el-collapse-item>
              </el-collapse>
            </div>

            <!-- 分组 -->
            <el-collapse class="prompt-groups-collapse">
              <el-collapse-item
                v-for="groupName in styleGroupNames"
                :key="`group-${groupName}`"
                :name="groupName"
                :title="`${groupName}（${cfg.styleGroups[groupName].prompts.length}）`"
                class="preset-section"
              >
                <div class="preset-section-header">
                  <el-input
                    :model-value="groupName"
                    size="small"
                    style="width: 220px"
                    @change="renameStyleGroup(groupName, String($event))"
                  />
                  <div class="header-actions">
                    <el-button size="small" @click="addStylePreset(groupName)">添加预设</el-button>
                    <el-button size="small" type="danger" @click="removeStyleGroup(groupName)">删除分组</el-button>
                  </div>
                </div>
                <div v-if="!cfg.styleGroups[groupName].prompts.length" class="hint">该分组暂无预设。</div>
                <el-collapse v-else>
                  <el-collapse-item
                    v-for="(style, i) in cfg.styleGroups[groupName].prompts"
                    :key="`${groupName}::${i}::${style.commandName || 'unnamed'}`"
                    :title="style.commandName || `预设 ${i + 1}`"
                  >
                    <el-form label-width="110px">
                      <el-form-item label="命令名"><el-input v-model="style.commandName" style="width: 200px" /></el-form-item>
                      <el-form-item label="生成模式">
                        <el-radio-group v-model="style.mode">
                          <el-radio-button value="text-to-image">文生图</el-radio-button>
                          <el-radio-button value="image-to-image">图生图</el-radio-button>
                          <el-radio-button value="compose-image">合成图</el-radio-button>
                        </el-radio-group>
                      </el-form-item>
                      <el-form-item label="模型后缀">
                        <el-select v-model="style.modelSuffix" clearable placeholder="默认模型" style="width: 220px">
                          <el-option v-for="m in cfg.modelMappings" :key="m.suffix" :value="m.suffix" :label="`${m.suffix}（${m.modelId}）`" />
                        </el-select>
                      </el-form-item>
                      <el-form-item label="帮助说明"><el-input v-model="style.description" type="textarea" :rows="2" /></el-form-item>
                      <el-form-item label="提示词"><el-input v-model="style.prompt" type="textarea" :rows="5" /></el-form-item>
                      <el-form-item label="移动到">
                        <el-select
                          :model-value="''"
                          placeholder="选择目标分组"
                          :disabled="!moveTargets(groupName).length"
                          style="width: 220px"
                          @change="movePreset(groupName, i, $event)"
                        >
                          <el-option v-for="t in moveTargets(groupName)" :key="`${groupName}-mv-${t.value}`" :value="t.value" :label="t.label" />
                        </el-select>
                      </el-form-item>
                      <el-form-item><el-button type="danger" size="small" @click="removeStylePreset(groupName, i)">删除此预设</el-button></el-form-item>
                    </el-form>
                  </el-collapse-item>
                </el-collapse>
              </el-collapse-item>
            </el-collapse>
          </k-card>
        </section>

        <!-- 定价 -->
        <section v-show="activeTab === 'pricing'" class="tab-panel">
          <div class="panel-limit">
            <k-card title="定价" class="section" shadow="never">
              <el-form label-width="260px">
                <el-divider content-position="left">A · 平台积分</el-divider>
                <el-form-item label="平台积分单位名称">
                  <el-input v-model="cfg.creditUnitName" style="width: 160px" />
                  <div class="hint">聊天里对用户展示余额/消耗时使用的单位（例如"积分"、"魔力值"）。</div>
                </el-form-item>
                <el-form-item label="试用图片张数（每用户）">
                  <el-input-number v-model="cfg.trialImageLimit" :min="0" :max="100" :step="1" />
                  <div class="hint">新用户可免费生成的图片张数；0 为禁用试用。试用不计入积分。</div>
                </el-form-item>

                <el-form-item label="每日免费试用模型">
                  <el-select v-model="cfg.freeTrialModelId" clearable placeholder="选择模型映射中的 modelId" style="width: 320px">
                    <el-option v-for="m in cfg.modelMappings" :key="m.modelId" :value="m.modelId" :label="`${m.suffix || m.modelId}（${m.modelId}）`" />
                  </el-select>
                  <div class="hint">只有选中的模型允许普通用户使用每日免费额度；为空时禁用每日免费。</div>
                </el-form-item>

                <el-divider content-position="left">B · 自动定价（供应商积分 → 平台积分 → 用户售价）</el-divider>
                <el-form-item label="1 元人民币 = N 平台积分">
                  <el-input-number v-model="cfg.creditsPerCny" :min="0.01" :step="1" :precision="2" />
                  <div class="hint">人民币与平台积分的换算比例；同时用作管理员余额/充值提示的估值。</div>
                </el-form-item>
                <el-form-item label="全局盈利加成 %">
                  <el-input-number v-model="cfg.pricingMarkupPercent" :min="0" :max="10000" :step="1" :precision="2" />
                  <div class="hint">用户扣费 = 平台积分成本 × (1 + N/100)。例如 30 表示在成本上加价 30%。</div>
                </el-form-item>
                <el-form-item label="供应商 → 人民币汇率">
                  <el-input :model-value="'1 供应商积分 = ¥0.50'" readonly style="width: 220px" />
                  <div class="hint">NewAPI 兼容站官方约定值（默认 0.5），不作为可配置项；修改需要新版本发布。</div>
                </el-form-item>
                <div class="hint" style="margin-left: 16px">
                  公式：用户扣费 = 供应商积分 × 0.5 × 「1 元 = N 平台积分」 × (1 + 加成% / 100)。
                  修改本区两项后无需重新探测，扣费会即时按持久化的探测结果重算。
                </div>

                <el-collapse>
                  <el-collapse-item title="C · 展示偏好">
                    <el-form-item label="生成结束时显示本次消耗">
                      <el-switch v-model="cfg.showCreditCostInResult" />
                    </el-form-item>
                    <el-form-item label="附带显示剩余积分明细">
                      <el-switch v-model="cfg.showQuotaInImageCommands" />
                      <div class="hint">需先开启上方"生成结束时显示本次消耗"。</div>
                    </el-form-item>
                  </el-collapse-item>
                </el-collapse>
              </el-form>
            </k-card>
          </div>
        </section>

        <!-- 运营 -->
        <section v-show="activeTab === 'operations'" class="tab-panel">
          <div class="panel-limit">
            <k-card title="运营" class="section" shadow="never">
              <el-form label-width="200px">

                <el-divider content-position="left">免计费设置</el-divider>
                <el-form-item label="免计费平台">
                  <el-select v-model="cfg.freePlatforms" multiple filterable allow-create default-first-option placeholder="输入平台 ID 后回车" style="width: 100%">
                    <el-option label="飞书 (lark)" value="lark" />
                    <el-option label="QQ (onebot)" value="onebot" />
                  </el-select>
                  <div class="hint">从列表选择或手动输入平台 ID。平台 ID 对应 Koishi 适配器标识（如 lark=飞书、onebot=QQ），可在 Koishi 插件配置中确认。</div>
                </el-form-item>

                <el-divider content-position="left">请求限流</el-divider>
                <el-form-item label="限流统计窗口（秒）">
                  <el-input-number v-model="cfg.rateLimitWindow" :min="60" :max="3600" :step="30" />
                </el-form-item>
                <el-form-item label="窗口内最大请求数（每用户）">
                  <el-input-number v-model="cfg.rateLimitMax" :min="1" :max="20" />
                </el-form-item>

                <el-divider content-position="left">安全策略</el-divider>
                <el-form-item label="拦截统计窗口（秒）"><el-input-number v-model="cfg.securityBlockWindow" :min="60" :max="3600" :step="60" /></el-form-item>
                <el-form-item label="窗口内拦截警示阈值"><el-input-number v-model="cfg.securityBlockWarningThreshold" :min="1" :max="10" /></el-form-item>

                <el-divider content-position="left">用户与权限</el-divider>
                <el-form-item label="管理员用户 ID">
                  <el-select v-model="cfg.adminUsers" multiple filterable allow-create default-first-option placeholder="输入 ID 后回车" style="width: 420px" />
                </el-form-item>
                <el-form-item label="永久会员（免扣费）">
                  <el-select v-model="cfg.permanentMembers" multiple filterable allow-create default-first-option style="width: 420px" />
                </el-form-item>
                <el-form-item label="受限模型白名单">
                  <el-select v-model="cfg.modelWhitelistUsers" multiple filterable allow-create default-first-option style="width: 420px" />
                </el-form-item>

                <el-divider content-position="left">集成</el-divider>
                <el-form-item label="启用 ChatLuna 工具"><el-switch v-model="cfg.chatlunaEnabled" /></el-form-item>
                <template v-if="cfg.chatlunaEnabled">
                  <el-form-item label="注入最近图像上下文"><el-switch v-model="cfg.chatlunaContextInjectionEnabled" /></el-form-item>
                  <el-form-item label="暴露积分查询工具"><el-switch v-model="cfg.chatlunaExposeQuotaTool" /></el-form-item>
                  <el-form-item label="暴露风格列表工具"><el-switch v-model="cfg.chatlunaExposeStyleListTool" /></el-form-item>
                  <el-form-item label="上下文保留条数"><el-input-number v-model="cfg.chatlunaContextHistorySize" :min="1" :max="100" /></el-form-item>
                  <el-form-item label="上下文过期时间（秒）"><el-input-number v-model="cfg.chatlunaContextTtlSeconds" :min="3600" :max="604800" :step="3600" /></el-form-item>
                  <el-form-item label="私聊自动映射上一张"><el-switch v-model="cfg.chatlunaPreferLastGeneratedInPrivateRoom" /></el-form-item>
                </template>
                <el-form-item label="启用 YesImBot 工具"><el-switch v-model="cfg.yesimbotEnabled" /></el-form-item>
                <template v-if="cfg.yesimbotEnabled">
                  <el-form-item label="暴露积分查询工具"><el-switch v-model="cfg.yesimbotExposeQuotaTool" /></el-form-item>
                  <el-form-item label="暴露风格列表工具"><el-switch v-model="cfg.yesimbotExposeStyleListTool" /></el-form-item>
                </template>

              </el-form>
            </k-card>

            <!-- 生成默认值 -->
            <k-card title="生成默认值" class="section">
              <el-form label-width="200px">
                <el-form-item label="默认生成张数"><el-input-number v-model="cfg.defaultNumImages" :min="1" :max="4" /></el-form-item>
                <el-form-item label="交互模式">
                  <el-select v-model="cfg.interactionMode" style="width: 220px">
                    <el-option value="auto" label="自动（群聊→高级，私聊→引导）" />
                    <el-option value="guided" label="始终引导模式（适合新手）" />
                    <el-option value="advanced" label="始终高级模式（适合熟练用户）" />
                  </el-select>
                  <div class="hint">高级模式跳过向导，使用默认值直接生成。引导模式分步选择模型与参数后生成。auto 按会话类型自动切换。</div>
                </el-form-item>
                <el-form-item label="按平台覆盖交互模式">
                  <div class="extra-headers">
                    <div v-for="(row, i) in interactionOverrideRows" :key="i" class="extra-header-row">
                      <el-input v-model="row.platform" size="small" placeholder="平台 ID（如 lark、onebot、qq）" style="width: 220px" @input="syncInteractionOverrides" />
                      <el-select v-model="row.mode" size="small" style="width: 140px" @change="syncInteractionOverrides">
                        <el-option value="auto" label="自动" />
                        <el-option value="guided" label="引导" />
                        <el-option value="advanced" label="高级" />
                      </el-select>
                      <el-button link type="danger" size="small" @click="removeInteractionOverride(i)">删</el-button>
                    </div>
                    <el-button size="small" @click="addInteractionOverride">添加平台覆盖</el-button>
                    <div class="hint">未覆盖的平台使用上方全局设置；key 为 session.platform（如 lark、onebot、qq）。</div>
                  </div>
                </el-form-item>
              </el-form>
              <div class="hint">全局超时、目录刷新间隔和日志级别请在 Koishi 插件设置页管理。</div>
            </k-card>
          </div>
        </section>
      </div>
    </div>

  </k-layout>
</template>

<script lang="ts" setup>
import { computed, onActivated, onDeactivated, onMounted, ref } from 'vue'
import { router, send, store } from '@koishijs/client'
import { ElMessage } from 'element-plus'
import { normalizeConfig, objectToRows, rowsToObject, sanitizeHeaders } from './normalize'

// 浮动元素仅在本页面激活时显示：koishi console 对页面组件做 keep-alive，
// Teleport 到 body 的节点脱离页面容器，靠 activated/deactivated 生命周期控制显隐。
const isAkaToolsRoute = ref(true)
onActivated(() => { isAkaToolsRoute.value = true })
onDeactivated(() => { isAkaToolsRoute.value = false })

function openVideoTools(): void {
  void router.push('/aka-tools-video')
}

const tabs = [
  { key: 'overview', label: '总览' },
  { key: 'credentials', label: '供应商' },
  { key: 'catalog', label: '模型目录' },
  { key: 'mappings', label: '模型映射' },
  { key: 'presets', label: '预设' },
  { key: 'pricing', label: '定价' },
  { key: 'operations', label: '运营' },
]
const activeTab = ref('overview')

const overviewStats = ref<any>(null)
const overviewTotals = computed(() => overviewStats.value?.totals ?? null)
const successRateDisplay = computed(() => {
  const rate = overviewStats.value?.totals?.successRate
  return typeof rate === 'number' ? `${(rate * 100).toFixed(1)}%` : '—'
})

const state = ref<any>(null)
const cfg = ref<any>(null)
const loading = ref(false)
const saving = ref(false)
const refreshing = ref(false)
const catalogFilter = ref('')
const setupGuideOpen = ref(false)
const extraHeadersRows = ref<Array<{ key: string; value: string }>>([])
const interactionOverrideRows = ref<Array<{ platform: string; mode: 'auto' | 'guided' | 'advanced' }>>([])

const supplierOptions = computed(() => state.value?.suppliers?.map((item: any) => ({
  value: item.id,
  label: item.label,
  desc: item.status === 'maintained' ? '当前完整维护' : '暂未适配',
  disabled: item.status !== 'maintained',
})) ?? [])

async function loadState() {
  loading.value = true
  try {
    state.value = await send('image-generator/get-state')
    cfg.value = normalizeConfig(state.value.config)
    extraHeadersRows.value = objectToRows(cfg.value.providerSettings?.openaiCompatibleExtraHeaders)
    interactionOverrideRows.value = Object.entries(cfg.value.interactionModeOverrides ?? {})
      .map(([platform, mode]) => ({
        platform,
        mode: (mode === 'auto' || mode === 'guided' || mode === 'advanced') ? mode : 'auto',
      }))
    await loadOverview()
  } finally {
    loading.value = false
  }
}

async function loadOverview() {
  try {
    overviewStats.value = await send('image-generator/get-overview-stats')
  } catch (err) {
    ElMessage.error(`加载用量统计失败：${err instanceof Error ? err.message : String(err)}`)
  }
}

function formatCredits(v?: number): string {
  return typeof v === 'number' && Number.isFinite(v) ? v.toFixed(2) : '—'
}
function timeLabel(t?: string): string {
  if (!t) return '—'
  const d = new Date(t)
  if (Number.isNaN(d.getTime())) return '—'
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
}

onMounted(loadState)

function syncExtraHeaders() {
  cfg.value.providerSettings.openaiCompatibleExtraHeaders = rowsToObject(extraHeadersRows.value)
}

function addExtraHeader() {
  extraHeadersRows.value.push({ key: '', value: '' })
}

function removeExtraHeader(index: number) {
  extraHeadersRows.value.splice(index, 1)
  syncExtraHeaders()
}

function syncInteractionOverrides() {
  const out: Record<string, 'auto' | 'guided' | 'advanced'> = {}
  for (const row of interactionOverrideRows.value) {
    const platform = (row.platform ?? '').trim()
    if (!platform) continue
    if (row.mode !== 'auto' && row.mode !== 'guided' && row.mode !== 'advanced') continue
    out[row.platform.trim()] = row.mode
  }
  cfg.value.interactionModeOverrides = out
}

function addInteractionOverride() {
  interactionOverrideRows.value.push({ platform: '', mode: 'auto' })
}

function removeInteractionOverride(index: number) {
  interactionOverrideRows.value.splice(index, 1)
  syncInteractionOverrides()
}

const catalogModels = computed(() => state.value?.catalog?.models ?? [])
const selectableModels = computed(() => state.value?.catalog?.selectableModels ?? [])
const filteredCatalog = computed(() => {
  const kw = catalogFilter.value.trim().toLowerCase()
  if (!kw) return catalogModels.value
  return catalogModels.value.filter((m: any) => m.id.toLowerCase().includes(kw))
})

const catalogAge = computed(() => {
  const t = state.value?.catalog?.fetchedAt
  if (!t) return '—'
  const min = Math.round((Date.now() - t) / 60000)
  return min < 60 ? `${min} 分钟前` : `${Math.round(min / 60)} 小时前`
})
const supplierCreditsDisplay = computed(() => {
  const billing = state.value?.billing
  const credits = billing?.supplierCredits ?? billing?.platformCredits ?? billing?.totalUsageUsd
  return typeof credits === 'number' ? credits.toFixed(2) : '—'
})
const billingLimit = computed(() => state.value?.billing?.hardLimitUsd != null ? `$${state.value.billing.hardLimitUsd.toFixed(0)}` : '—')

function modeLabel(m: string) {
  return { 'text-to-image': '文生图', 'image-to-image': '图生图', 'compose-image': '合成图' }[m] ?? m
}
function modelOptionLabel(m: any) {
  return `${m.id}（${m.yunwuCost?.label ?? '成本未知'}）`
}
function mappingValid(row: any) {
  return selectableModels.value.some((m: any) => m.id === row.modelId)
}

function addMapping() {
  cfg.value.modelMappings.push({ suffix: '', modelId: selectableModels.value[0]?.id ?? '', restricted: false })
}
function moveMapping(i: number, dir: number) {
  const arr = cfg.value.modelMappings
  const [item] = arr.splice(i, 1)
  arr.splice(i + dir, 0, item)
}
// Prompt 预设 / 分组：groupName === null 表示未分组，绑定 cfg.styles；
// 其他分组绑定 cfg.styleGroups[groupName].prompts。分组仅用于后台分类，
// 聊天命令仍以每个预设自己的 commandName 直接调用（不生成父命令）。
const styleGroupNames = computed(() => Object.keys(cfg.value?.styleGroups ?? {}))

function makeEmptyPreset() {
  return { commandName: '', mode: 'image-to-image', modelSuffix: '', description: '', prompt: '' }
}

function getPresetArray(groupName: string | null): any[] | null {
  if (groupName == null) return cfg.value.styles
  const group = cfg.value.styleGroups?.[groupName]
  if (!group) return null
  if (!Array.isArray(group.prompts)) group.prompts = []
  return group.prompts
}

function addStylePreset(groupName: string | null = null) {
  const arr = getPresetArray(groupName)
  if (!arr) {
    ElMessage.error(`分组不存在：${groupName}`)
    return
  }
  arr.push(makeEmptyPreset())
}

function removeStylePreset(groupName: string | null, index: number) {
  const arr = getPresetArray(groupName)
  if (!arr || index < 0 || index >= arr.length) return
  arr.splice(index, 1)
}

function moveTargets(currentGroupName: string | null) {
  const targets: Array<{ value: string; label: string }> = []
  if (currentGroupName !== null) targets.push({ value: '__ungrouped__', label: '未分组' })
  for (const name of styleGroupNames.value) {
    if (name !== currentGroupName) targets.push({ value: name, label: name })
  }
  return targets
}

function movePreset(sourceGroup: string | null, index: number, rawTarget: string) {
  if (!rawTarget) return
  const targetGroup = rawTarget === '__ungrouped__' ? null : rawTarget
  if (sourceGroup === targetGroup) return
  const sourceArr = getPresetArray(sourceGroup)
  if (!sourceArr || index < 0 || index >= sourceArr.length) return
  const targetArr = getPresetArray(targetGroup)
  if (!targetArr) {
    ElMessage.error(`目标分组不存在：${targetGroup}`)
    return
  }
  const [item] = sourceArr.splice(index, 1)
  targetArr.push(item)
  ElMessage.success(`已移动到 ${targetGroup ?? '未分组'}`)
}

function addStyleGroup() {
  let index = 1
  let name = `分组${index}`
  while (cfg.value.styleGroups[name]) name = `分组${++index}`
  cfg.value.styleGroups = { ...cfg.value.styleGroups, [name]: { prompts: [] } }
}

function removeStyleGroup(name: string) {
  const group = cfg.value.styleGroups?.[name]
  if (!group) return
  const prompts = Array.isArray(group.prompts) ? group.prompts : []
  if (prompts.length > 0) {
    cfg.value.styles.push(...prompts.map((p: any) => ({ ...p })))
    ElMessage.info(`分组 "${name}" 内 ${prompts.length} 个预设已移至未分组`)
  }
  const next = { ...cfg.value.styleGroups }
  delete next[name]
  cfg.value.styleGroups = next
}

function renameStyleGroup(oldName: string, rawName: string) {
  const name = String(rawName ?? '').trim()
  if (!name) {
    ElMessage.error('分组名不能为空')
    return
  }
  if (name === oldName) return
  if (cfg.value.styleGroups[name]) {
    ElMessage.error(`分组名重复：${name}`)
    return
  }
  const next: Record<string, any> = {}
  for (const [key, value] of Object.entries(cfg.value.styleGroups)) {
    next[key === oldName ? name : key] = value
  }
  cfg.value.styleGroups = next
}

async function refreshCatalog() {
  refreshing.value = true
  try {
    const res: any = await send('image-generator/refresh-catalog')
    state.value = await send('image-generator/get-state')
    ElMessage[res.success ? 'success' : 'warning'](res.success ? `目录已刷新：${res.modelCount} 个模型` : `刷新失败：${res.error ?? '未知错误'}`)
  } finally {
    refreshing.value = false
  }
}

async function saveAll() {
  // 校验：选中供应商时必须填写对应 API Key
  const supplier = cfg.value.activeSupplier
  const providerSettings = cfg.value.providerSettings || {}
  let missingField = ''
  if (supplier === 'newapi') {
    const key = (providerSettings.openaiCompatibleApiKey || '').trim()
    if (!key) missingField = 'NewAPI API Key'
  } else if (supplier === 'openai-official') {
    const key = (providerSettings.gptOfficialApiKey || '').trim()
    if (!key) missingField = 'OpenAI 官方 API Key'
  } else if (supplier === 'gemini-official') {
    const key = (providerSettings.geminiOfficialApiKey || '').trim()
    if (!key) missingField = 'Gemini API Key'
  }
  if (missingField) {
    ElMessage.warning(`请先填写 ${missingField}`)
    return
  }

  saving.value = true
  try {
    syncExtraHeaders()
    syncInteractionOverrides()
    cfg.value.providerSettings.openaiCompatibleExtraHeaders = sanitizeHeaders(cfg.value.providerSettings.openaiCompatibleExtraHeaders)
    const res: any = await send('image-generator/save-config', cfg.value)
    if (res.success) ElMessage.success('设置已保存并热重载')
    else ElMessage.error(`保存失败：${res.error}`)
  } finally {
    saving.value = false
  }
}
</script>

<style lang="scss" scoped>
.loading { padding: 2rem; text-align: center; color: var(--fg3); }

/* 页面骨架：与视频页同款 —— 顶部分页 + 右侧为浮动工具条让位 + 1320px 收敛 */
.image-page {
  display: flex;
  flex-direction: column;
  height: 100%;
  min-height: 0;
  padding: 1rem 4.5rem 1rem 1rem;
  gap: 1rem;
  overflow: hidden;
}
.page-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 0.75rem;
  flex-wrap: wrap;
  padding: 0.25rem 0.25rem 0.75rem;
  border-bottom: 1px solid var(--border);
  flex: 0 0 auto;
  width: 100%;
  max-width: 1320px;
  margin: 0 auto;
}
.page-tabs { flex-wrap: wrap; row-gap: 0.4rem; }
.page-body {
  flex: 1 1 auto;
  min-height: 0;
  overflow: hidden;
  display: flex;
  flex-direction: column;
  width: 100%;
  max-width: 1320px;
  margin: 0 auto;
}
.tab-panel {
  flex: 1 1 auto;
  min-height: 0;
  overflow-y: auto;
  padding: 0.25rem 4px 1rem 0.25rem;
  display: flex;
  flex-direction: column;
  gap: 1rem;
}
/* 表单类 tab 限宽居中，表格类 tab 在 1320px 容器内全宽 */
.panel-limit {
  width: 100%;
  max-width: 900px;
  margin: 0 auto;
  display: flex;
  flex-direction: column;
  gap: 1rem;
}

/* 顶层浮动工具按钮组：固定定位，不占用布局区域（全局样式，Teleport 目标在组件外） */
.floating-tools { position: fixed; top: 3.5rem; right: 1rem; z-index: 2000;
  display: flex; flex-direction: column; gap: 0.5rem; }
.tool-btn { width: 40px; height: 40px; border-radius: 8px; display: flex; align-items: center; justify-content: center;
  background: var(--card-bg); border: 1px solid var(--border); color: var(--fg2);
  cursor: pointer; transition: all 0.15s; box-shadow: 0 2px 8px rgba(0,0,0,0.15); }
.tool-btn:hover { border-color: var(--primary); color: var(--primary); }
.tool-btn.active { background: var(--primary); border-color: var(--primary); color: #fff; }
.tool-btn.disabled { opacity: 0.45; cursor: not-allowed; }
.tool-btn.disabled:hover { border-color: var(--border); color: var(--fg2); }

/* 暗色主题表格：统一行背景，避免斑马白行 */
.dark-table { --el-table-bg-color: transparent; --el-table-tr-bg-color: transparent;
  --el-table-header-bg-color: var(--card-bg); --el-table-border-color: var(--border);
  --el-table-text-color: var(--fg1); --el-table-header-text-color: var(--fg2);
  --el-table-row-hover-bg-color: rgba(128, 128, 128, 0.12); background: transparent; }
.dark-table :deep(.el-table__cell) { background: transparent !important; }
.dark-table :deep(th.el-table__cell) { background: var(--card-bg) !important; }
.stat-row { display: grid; grid-template-columns: repeat(4, 1fr); gap: 1rem; }
.stat-card { background: var(--card-bg); border: 1px solid var(--border); border-radius: 8px; padding: 1rem; text-align: center; }
.stat-value { font-size: 1.4rem; font-weight: 600; }
.stat-label { font-size: 0.8rem; color: var(--fg3); margin-top: 0.25rem; }
.section { }
.card-header { display: flex; justify-content: space-between; align-items: center; width: 100%; gap: 1rem; flex-wrap: wrap; }
.header-actions { display: flex; gap: 0.5rem; align-items: center; flex-wrap: wrap; }
.supplier-picker { display: grid; grid-template-columns: repeat(4, 1fr); gap: 0.75rem; margin-bottom: 1rem; }
.supplier-option { border: 1px solid var(--border); border-radius: 8px; padding: 0.75rem; cursor: pointer; transition: all 0.15s; }
.supplier-option:hover { border-color: var(--primary); }
.supplier-option.active { border-color: var(--primary); background: rgba(var(--primary-rgb, 64 158 255), 0.08); }
.supplier-name { font-weight: 600; }
.supplier-desc { font-size: 0.75rem; color: var(--fg3); margin-top: 0.25rem; }
.cred-form { max-width: 640px; }
.mode-tag { margin-right: 4px; }
.hint { font-size: 0.8rem; color: var(--fg3); margin-bottom: 0.5rem; }
.error-line { color: var(--el-color-danger); font-size: 0.8rem; margin-top: 0.5rem; }
.unsupported-block { margin-top: 0.75rem; }
.extra-headers { display: flex; flex-direction: column; gap: 0.4rem; align-items: flex-start; }
.extra-header-row { display: flex; gap: 0.4rem; align-items: center; width: 100%; }
.probe-cell { display: flex; flex-direction: column; gap: 0.25rem; align-items: flex-start; }
.probe-line { font-size: 0.75rem; line-height: 1.2; }
.probe-line.probe-ok { color: var(--el-color-success); }
.probe-line.probe-err { color: var(--el-color-danger); }
.preset-section { border: 1px solid var(--border); border-radius: 8px; padding: 0.75rem; margin-top: 0.75rem; }
.preset-section-header { display: flex; align-items: center; justify-content: space-between; gap: 0.5rem; margin-bottom: 0.5rem; }
.preset-section-title { font-weight: 600; color: var(--fg1); }
</style>
