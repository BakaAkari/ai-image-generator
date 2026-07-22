import { Context } from '@koishijs/client'
import Page from './page.vue'

import 'virtual:uno.css'

export default (ctx: Context) => {
  ctx.page({
    path: '/aka-tools',
    name: 'aka-tools',
    component: Page,
  })
}
