import { Context } from '@koishijs/client'
import Page from './page.vue'

import 'virtual:uno.css'

export default (ctx: Context) => {
  ctx.page({
    path: '/aka-tools',
    name: 'aka-tools',
    component: Page,
    // 安全：声明需要登录用户身份。启用 Koishi auth 后，未登录访问会被路由守卫拦到登录页；
    // 未启用 auth 时该字段无副作用（守卫仅由 auth 插件注册）。
    fields: ['user'],
  })
}
