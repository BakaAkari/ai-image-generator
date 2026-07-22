<template>
  <k-layout>
    <template #header>
      <span>aka-tools · 图像生成</span>
    </template>
    <!-- 顶层浮动工具按钮：图像 / 视频 / 存储（Teleport 到 body，避免祖先 transform 使 fixed 失效） -->
    <Teleport to="body">
    <div class="floating-tools" v-if="isAkaToolsRoute">
      <div class="tool-btn active" title="图像生成设置">
        <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><path d="m21 15-5-5L5 21"/></svg>
      </div>
      <div class="tool-btn disabled" title="视频生成设置（即将推出）">
        <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="4" width="15" height="16" rx="2"/><path d="m17 9 5-3v12l-5-3"/></svg>
      </div>
      <div class="tool-btn disabled" title="存储管理（即将推出）">
        <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><ellipse cx="12" cy="5" rx="8" ry="3"/><path d="M4 5v6c0 1.66 3.58 3 8 3s8-1.34 8-3V5"/><path d="M4 11v6c0 1.66 3.58 3 8 3s8-1.34 8-3v-6"/></svg>
      </div>
    </div>
    </Teleport>

    <div v-if="!state" class="loading">正在加载…</div>
    <div v-else class="page-scroll">

      <!-- ══ 状态总览 ══ -->
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
          <div class="stat-value">{{ billingUsage }}</div>
          <div class="stat-label">平台累计消耗</div>
        </div>
        <div class="stat-card">
          <div class="stat-value">{{ billingLimit }}</div>
          <div class="stat-label">Key 限额</div>
        </div>
      </div>

      <!-- ══ ① 供应商与凭证 ══ -->
      <k-card title="供应商与凭证" class="section">
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
          <template v-if="cfg.activeSupplier === 'yunwu' || cfg.activeSupplier === 'gptgod'">
            <el-form-item :label="cfg.activeSupplier === 'yunwu' ? 'yunwu API Key' : 'GPTGod API Key'">
              <el-input v-model="cfg.providerSettings.openaiCompatibleApiKey" type="password" show-password placeholder="sk-..." />
            </el-form-item>
            <el-form-item label="Base URL">
              <el-input v-model="cfg.providerSettings.openaiCompatibleApiBase" :placeholder="cfg.activeSupplier === 'yunwu' ? 'https://yunwu.ai/v1' : 'https://gptgod.cloud/v1'" />
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
          <el-form-item label="目录刷新间隔（小时）">
            <el-input-number v-model="cfg.catalogRefreshHours" :min="1" :max="72" />
          </el-form-item>
        </el-form>
      </k-card>

      <!-- ══ ② 模型目录 ══ -->
      <k-card class="section">
        <template #header>
          <div class="card-header">
            <span>模型目录（{{ filteredCatalog.length }} / {{ state.catalog?.models?.length ?? 0 }}）</span>
            <div class="header-actions">
              <el-input v-model="catalogFilter" placeholder="搜索模型" clearable style="width: 200px" />
              <el-button :loading="refreshing" @click="refreshCatalog">刷新目录</el-button>
            </div>
          </div>
        </template>
        <el-table :data="filteredCatalog" max-height="360" size="small" class="dark-table">
          <el-table-column prop="id" label="模型" min-width="220" sortable />
          <el-table-column label="模式" width="150">
            <template #default="{ row }">
              <el-tag v-for="m in row.modes" :key="m" size="small" class="mode-tag">{{ modeLabel(m) }}</el-tag>
            </template>
          </el-table-column>
          <el-table-column label="计价" width="160">
            <template #default="{ row }">{{ row.catalogPrice.label }}</template>
          </el-table-column>
          <el-table-column label="成本报价" width="190">
            <template #default="{ row }">{{ row.costQuote.label }}</template>
          </el-table-column>
          <el-table-column label="运营收费" width="190">
            <template #default="{ row }">{{ row.chargePolicy.label }}</template>
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

      <!-- ══ ③ 模型映射 ══ -->
      <k-card title="模型映射" class="section">
        <template #header>
          <div class="card-header">
            <span>模型映射（第一条为默认模型）</span>
            <el-button size="small" @click="addMapping">添加映射</el-button>
          </div>
        </template>
        <div class="hint">命令后缀用于聊天中 -后缀 切换模型；新映射默认禁用，必须显式选择固定积分或目录成本加成。</div>
        <el-table :data="cfg.modelMappings" size="small">
          <el-table-column label="排序" width="70">
            <template #default="{ $index }">
              <el-button link size="small" :disabled="$index === 0" @click="moveMapping($index, -1)">↑</el-button>
              <el-button link size="small" :disabled="$index === cfg.modelMappings.length - 1" @click="moveMapping($index, 1)">↓</el-button>
            </template>
          </el-table-column>
          <el-table-column label="命令后缀" width="130">
            <template #default="{ row }"><el-input v-model="row.suffix" size="small" /></template>
          </el-table-column>
          <el-table-column label="模型" min-width="260">
            <template #default="{ row }">
              <el-select v-model="row.modelId" size="small" filterable style="width: 100%">
                <el-option v-for="m in selectableModels" :key="m.id" :value="m.id" :label="modelOptionLabel(m)" />
              </el-select>
            </template>
          </el-table-column>
          <el-table-column label="收费策略" min-width="260">
            <template #default="{ row }">
              <el-select v-model="row.chargePolicy.type" size="small" style="width: 110px">
                <el-option value="disabled" label="禁用" />
                <el-option value="fixed" label="固定积分" />
                <el-option value="cost-plus" label="目录加成" />
              </el-select>
              <el-input-number v-if="row.chargePolicy.type === 'fixed'" v-model="row.chargePolicy.creditsPerImage" size="small" :min="0" :step="0.5" style="width: 110px; margin-left: 6px" />
            </template>
          </el-table-column>
          <el-table-column label="受限" width="70">
            <template #default="{ row }"><el-checkbox v-model="row.restricted" /></template>
          </el-table-column>
          <el-table-column label="状态" width="90">
            <template #default="{ row }">
              <el-tag :type="mappingValid(row) ? 'success' : 'danger'" size="small">{{ mappingValid(row) ? '可用' : '失效' }}</el-tag>
            </template>
          </el-table-column>
          <el-table-column label="" width="60">
            <template #default="{ $index }">
              <el-button link type="danger" size="small" @click="cfg.modelMappings.splice($index, 1)">删</el-button>
            </template>
          </el-table-column>
        </el-table>
      </k-card>

      <!-- ══ ④ 积分与运营 ══ -->
      <k-card title="积分与运营" class="section">
        <el-form label-width="200px">
          <el-form-item label="积分单位名称"><el-input v-model="cfg.creditUnitName" style="width: 160px" /></el-form-item>
          <el-form-item label="每日免费积分"><el-input-number v-model="cfg.dailyFreeCredits" :min="0" :step="1" /></el-form-item>
          <el-form-item label="积分汇率（1 美元 = N 积分）"><el-input-number v-model="cfg.creditExchangeRate" :min="0" :step="100" /></el-form-item>
          <el-form-item label="定价加成倍率"><el-input-number v-model="cfg.costMarkup" :min="0.1" :step="0.05" /></el-form-item>
          <el-form-item label="1 元 = N 积分（经营参考）"><el-input-number v-model="cfg.creditsPerCny" :min="0" :step="10" /></el-form-item>
          <el-form-item label="生成结果中显示消耗"><el-switch v-model="cfg.showCreditCostInResult" /></el-form-item>
          <el-form-item label="限流窗口（秒）"><el-input-number v-model="cfg.rateLimitWindow" :min="60" :max="3600" :step="30" /></el-form-item>
          <el-form-item label="窗口内最大请求数"><el-input-number v-model="cfg.rateLimitMax" :min="1" :max="20" /></el-form-item>
        </el-form>
      </k-card>

      <!-- ══ ⑤ Prompt 预设 / 快捷命令 ══ -->
      <k-card class="section">
        <template #header>
          <div class="card-header">
            <span>Prompt 预设 / 快捷命令</span>
            <el-button size="small" @click="addStyle">添加预设</el-button>
          </div>
        </template>
        <el-collapse>
          <el-collapse-item v-for="(style, i) in cfg.styles" :key="i" :title="style.commandName || `预设 ${i + 1}`">
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
              <el-form-item><el-button type="danger" size="small" @click="cfg.styles.splice(i, 1)">删除此预设</el-button></el-form-item>
            </el-form>
          </el-collapse-item>
        </el-collapse>
      </k-card>

      <!-- ══ ⑥ 用户与权限 ══ -->
      <k-card title="用户与权限" class="section">
        <el-form label-width="200px">
          <el-form-item label="管理员用户 ID">
            <el-select v-model="cfg.adminUsers" multiple filterable allow-create default-first-option placeholder="输入 ID 后回车" style="width: 420px" />
          </el-form-item>
          <el-form-item label="永久会员（免扣费）">
            <el-select v-model="cfg.permanentMembers" multiple filterable allow-create default-first-option style="width: 420px" />
          </el-form-item>
          <el-form-item label="受限模型白名单">
            <el-select v-model="cfg.modelWhitelistUsers" multiple filterable allow-create default-first-option style="width: 420px" />
          </el-form-item>
          <el-form-item label="豁免平台（跳过扣费限流）">
            <el-select v-model="cfg.unlimitedPlatforms" multiple filterable allow-create default-first-option style="width: 420px" />
          </el-form-item>
        </el-form>
      </k-card>

      <!-- ══ ⑦ 集成 ══ -->
      <k-card title="集成" class="section">
        <el-form label-width="240px">
          <el-divider content-position="left">ChatLuna</el-divider>
          <el-form-item label="启用 ChatLuna 工具"><el-switch v-model="cfg.chatlunaEnabled" /></el-form-item>
          <template v-if="cfg.chatlunaEnabled">
            <el-form-item label="注入最近图像上下文"><el-switch v-model="cfg.chatlunaContextInjectionEnabled" /></el-form-item>
            <el-form-item label="暴露积分查询工具"><el-switch v-model="cfg.chatlunaExposeQuotaTool" /></el-form-item>
            <el-form-item label="暴露风格列表工具"><el-switch v-model="cfg.chatlunaExposeStyleListTool" /></el-form-item>
          </template>
          <el-divider content-position="left">YesImBot</el-divider>
          <el-form-item label="启用 YesImBot 工具"><el-switch v-model="cfg.yesimbotEnabled" /></el-form-item>
          <template v-if="cfg.yesimbotEnabled">
            <el-form-item label="暴露积分查询工具"><el-switch v-model="cfg.yesimbotExposeQuotaTool" /></el-form-item>
            <el-form-item label="暴露风格列表工具"><el-switch v-model="cfg.yesimbotExposeStyleListTool" /></el-form-item>
          </template>
        </el-form>
      </k-card>

      <!-- ══ ⑧ 运行与诊断 ══ -->
      <k-card title="运行与诊断" class="section">
        <el-form label-width="200px">
          <el-form-item label="日志级别">
            <el-radio-group v-model="cfg.logLevel">
              <el-radio-button value="simple">simple</el-radio-button>
              <el-radio-button value="detail">detail</el-radio-button>
            </el-radio-group>
          </el-form-item>
          <el-form-item label="默认生成张数"><el-input-number v-model="cfg.defaultNumImages" :min="1" :max="4" /></el-form-item>
          <el-form-item label="上游超时（秒）"><el-input-number v-model="cfg.apiTimeout" :min="10" :max="600" :step="10" /></el-form-item>
        </el-form>
      </k-card>

      <div class="bottom-spacer"></div>
    </div>

    <!-- 固定底部保存栏：常驻可视窗口底部，不随内容滚动 -->
    <Teleport to="body">
      <div class="save-bar" v-if="isAkaToolsRoute">
        <el-button class="save-btn" type="primary" :loading="saving" @click="saveAll">保存全部设置</el-button>
      </div>
    </Teleport>
  </k-layout>
</template>

<script lang="ts" setup>
import { computed, onActivated, onDeactivated, onMounted, ref } from 'vue'
import { send, store } from '@koishijs/client'
import { ElMessage } from 'element-plus'

// 浮动元素仅在本页面激活时显示：koishi console 对页面组件做 keep-alive，
// Teleport 到 body 的节点脱离页面容器，靠 activated/deactivated 生命周期控制显隐。
const isAkaToolsRoute = ref(true)
onActivated(() => { isAkaToolsRoute.value = true })
onDeactivated(() => { isAkaToolsRoute.value = false })

const state = ref<any>(null)
const cfg = ref<any>(null)
const saving = ref(false)
const refreshing = ref(false)
const catalogFilter = ref('')

const supplierOptions = computed(() => state.value?.suppliers?.map((item: any) => ({
  value: item.id,
  label: item.label,
  desc: item.status === 'maintained' ? '当前完整维护' : '暂未适配',
  disabled: item.status !== 'maintained',
})) ?? [])

onMounted(async () => {
  state.value = await send('image-generator/get-state')
  cfg.value = normalizeConfig(state.value.config)
})

function normalizeConfig(raw: any) {
  const c = { ...raw }
  c.providerSettings = { openaiCompatibleApiKey: '', openaiCompatibleApiBase: '', gptOfficialApiKey: '', geminiOfficialApiKey: '', ...(raw.providerSettings ?? {}) }
  c.activeSupplier ??= 'yunwu'
  c.catalogRefreshHours ??= 6
  c.creditExchangeRate ??= 1000
  c.costMarkup ??= 1.3
  c.modelMappings = (raw.modelMappings ?? []).map((m: any) => ({ ...m, chargePolicy: m.chargePolicy ?? { type: 'disabled', reason: 'pricing unavailable' } }))
  c.styles = (raw.styles ?? []).map((s: any) => ({ ...s }))
  for (const k of ['adminUsers', 'permanentMembers', 'modelWhitelistUsers', 'unlimitedPlatforms']) c[k] = [...(raw[k] ?? [])]
  return c
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
const billingUsage = computed(() => state.value?.billing?.totalUsageUsd != null ? `$${state.value.billing.totalUsageUsd.toFixed(2)}` : '—')
const billingLimit = computed(() => state.value?.billing?.hardLimitUsd != null ? `$${state.value.billing.hardLimitUsd.toFixed(0)}` : '—')

function modeLabel(m: string) {
  return { 'text-to-image': '文生图', 'image-to-image': '图生图', 'compose-image': '合成图' }[m] ?? m
}
function modelOptionLabel(m: any) {
  return `${m.id}（${m.catalogPrice?.label ?? '目录价格未知'}）`
}
function mappingValid(row: any) {
  return selectableModels.value.some((m: any) => m.id === row.modelId) && row.chargePolicy?.type !== 'disabled'
}

function addMapping() {
  cfg.value.modelMappings.push({ suffix: '', modelId: selectableModels.value[0]?.id ?? '', restricted: false, chargePolicy: { type: 'disabled', reason: '请显式配置收费策略' } })
}
function moveMapping(i: number, dir: number) {
  const arr = cfg.value.modelMappings
  const [item] = arr.splice(i, 1)
  arr.splice(i + dir, 0, item)
}
function addStyle() {
  cfg.value.styles.push({ commandName: '', mode: 'image-to-image', modelSuffix: '', description: '', prompt: '' })
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
  saving.value = true
  try {
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

/* 页面滚动容器：k-layout 内容区撑满并自行滚动 */
.page-scroll { height: 100%; overflow-y: auto; padding: 1rem; box-sizing: border-box; }
.bottom-spacer { height: 3.5rem; }

.save-btn { flex-shrink: 0; width: auto; }

</style>

<style lang="scss">
/* 固定底部保存栏：常驻可视底部，横向对齐内容区（避开左侧 ~4rem 菜单栏），不随滚动 */
.save-bar { position: fixed; left: 4rem; right: 0; bottom: 0; z-index: 1990;
  display: flex; justify-content: flex-end; padding: 0.6rem 1.2rem;
  background: var(--bg0, rgba(20,20,20,0.92)); backdrop-filter: blur(6px);
  border-top: 1px solid var(--border); }
.save-bar .save-btn { flex-shrink: 0; width: auto; }

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
.stat-row { display: grid; grid-template-columns: repeat(4, 1fr); gap: 1rem; margin-bottom: 1rem; }
.stat-card { background: var(--card-bg); border: 1px solid var(--border); border-radius: 8px; padding: 1rem; text-align: center; }
.stat-value { font-size: 1.4rem; font-weight: 600; }
.stat-label { font-size: 0.8rem; color: var(--fg3); margin-top: 0.25rem; }
.section { margin-bottom: 1rem; }
.card-header { display: flex; justify-content: space-between; align-items: center; width: 100%; gap: 1rem; }
.header-actions { display: flex; gap: 0.5rem; align-items: center; }
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
</style>
