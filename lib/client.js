// dsh-font-picker client half（静态插件，随 dsh web 常驻；刷新页面设置不丢）
//
// 在「设置 → General」注册两行：UI 字体 / 代码字体。
//   · 首屏种子：host 已经在 index.html 注入 window.__DSH_FONT_PICKER__（当前选择）
//     与一段 <style>（防闪），所以这里不需要等任何异步就能显示正确初值。
//   · 字体清单：同源 HTTP API /font-picker/api/fonts?q=&limit=（过滤 + 分页，
//     445 条不会一次过塞进 HTML）。
//   · 即时套用：自己维护一个 <style id="dsh-font-picker-style"> 元素 ——
//     静态插件没有动态插件的 styles.insert 服务，直接操作 document 即可。
//   · 持久化：POST /font-picker/api/set，host 落盘到 $DSH_HOME\font-picker.json。
//
// 格式说明：这就是 tsdown 产出的 lazy-CJS 约定 —— 外层 window.__ModuleLoader__ 壳，
// factory 里普通模块代码；require('react') 拿的是 baseline external（React / Cordis /
// client-store / ui-primitives / ui-slots / ui-dockkit），不需要声明 dsh.client.external。
// 参照实作：profiles\web\node_modules\dsh-sticky-notes\lib\client.js
window.__ModuleLoader__.load({
  id: 'dsh-font-picker',
  factory: (require) => {
    const module = { exports: {} }
    const exports = module.exports
    const React = require('react')
    const h = React.createElement

    const CSS_VARS = { ui: '--dsw-font-family', code: '--ds-font-family-code', terminal: '--ds-font-family-terminal' }
    const STYLE_ID = 'dsh-font-picker-style'

    // 首屏种子（host 注入；取不到就退化成空选择）
    const seed = (typeof window !== 'undefined' && window.__DSH_FONT_PICKER__) ? window.__DSH_FONT_PICKER__ : {}
    const picked = {
      ui: typeof seed.uiFont === 'string' ? seed.uiFont : '',
      code: typeof seed.codeFont === 'string' ? seed.codeFont : '',
      terminal: typeof seed.terminalFont === 'string' ? seed.terminalFont : '',
    }

    /**
     * 0.2.1 的 ui-theme 配置表单（entry id = 'ui-theme'）。
     * 真正的字体变量由 theme-presenter 写到 document.body 的
     * --dsh-font-family-text / -code，所以选择必须同步进这个配置，
     * 只写旧的 :root 变量不会影响主界面。
     */
    let themeForm = null

    /**
     * 把一个选择值变成 CSS 值：含逗号视为完整 font-family 串，否则加引号。
     * @param value - 用户选择。
     * @returns 可直接写进 CSS 的文本。
     */
    function cssValue(value) {
      return value.indexOf(',') >= 0 ? value : '"' + value.replace(/"/g, '') + '"'
    }

    /** 把当前选择写进 :root 覆盖样式（自己维护一个 <style> 元素，不依赖任何服务）。 */
    function renderRootStyle() {
      let el = document.getElementById(STYLE_ID)
      if (el === null) {
        el = document.createElement('style')
        el.id = STYLE_ID
        document.head.appendChild(el)
      }
      const parts = []
      if (picked.ui !== '') parts.push(':root{' + CSS_VARS.ui + ':' + cssValue(picked.ui) + ' !important;}')
      if (picked.code !== '') parts.push(':root{' + CSS_VARS.code + ':' + cssValue(picked.code) + ' !important;}')
      if (picked.terminal !== '') parts.push(':root{' + CSS_VARS.terminal + ':' + cssValue(picked.terminal) + ' !important;}')
      el.textContent = parts.join('')
    }

    /**
     * 套用并持久化一个选择。
     * @param which - 'ui' 或 'code'。
     * @param value - 新值（空串 = 还原成 DSH 默认）。
     */
    function persist(which, value) {
      picked[which] = value
      renderRootStyle()
      if (themeForm !== null) {
        const field = which === 'ui' ? 'textFontFamily' : (which === 'terminal' ? 'terminalFontFamily' : 'codeFontFamily')
        themeForm.set(field, value).catch(() => {})
      }
      try {
        fetch('/font-picker/api/set', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ which: which, value: value }),
        }).catch(() => {})
      } catch (e) {
        /* 离线时只影响持久化，界面仍然生效 */
      }
    }

    /**
     * 安装时间戳 → MM-DD-YYYY。
     * @param ms - 毫秒时间戳。
     * @returns 显示用日期；取不到时给一串横线占位。
     */
    function fullDate(ms) {
      if (!ms) return '----------'
      const d = new Date(ms)
      const mm = ('0' + (d.getMonth() + 1)).slice(-2)
      const dd = ('0' + d.getDate()).slice(-2)
      return mm + '-' + dd + '-' + d.getFullYear()
    }

    /**
     * 造一行偏好 UI。
     * @param which - 'ui' 或 'code'。
     * @param label - 行标题。
     * @returns 组件。
     */
    function makeRow(which, label) {
      return function FontPickerRow() {
        const [data, setData] = React.useState({ phase: 'loading', items: [], total: 0, allTotal: 0, error: '' })
        const [value, setValue] = React.useState(picked[which])
        const [filter, setFilter] = React.useState('')
        const [custom, setCustom] = React.useState('')

        React.useEffect(() => {
          let alive = true
          fetch('/font-picker/api/fonts?q=' + encodeURIComponent(filter) + '&limit=80')
            .then((res) => res.json())
            .then((r) => {
              if (!alive) return
              setData({
                phase: 'ready',
                items: (r && r.items) ? r.items : [],
                total: (r && typeof r.total === 'number') ? r.total : -1,
                allTotal: (r && typeof r.allTotal === 'number') ? r.allTotal : -1,
                error: (r && r.error) ? String(r.error) : '',
              })
            })
            .catch((err) => {
              if (!alive) return
              setData({ phase: 'ready', items: [], total: -1, allTotal: -1, error: String((err && err.message) || err) })
            })
          return () => { alive = false }
        }, [filter])

        const choose = (next) => {
          setValue(next)
          persist(which, next)
        }

        const names = data.items.map((it) => it.name)
        const needExtra = value !== '' && names.indexOf(value) < 0

        const line1 = data.error !== ''
          ? ('错误：' + data.error)
          : (data.phase === 'loading'
            ? '读取中…'
            : ('匹配 ' + data.total + ' / 全部 ' + data.allTotal + ' 个名字 · 按安装日 MM-DD-YYYY 新→旧 · 下拉列前 80'))
        const line2 = '当前：' + (value === '' ? '（跟随 DSH 默认）' : value)

        const inputStyle = { fontSize: '12px', padding: '3px 6px', borderRadius: '4px', border: '1px solid rgba(128,128,128,0.35)', background: 'transparent', color: 'inherit' }
        const applyCustom = () => {
          const v = custom.trim()
          if (v !== '') choose(v)
        }

        const optionNodes = []
        optionNodes.push(h('option', { key: '__default', value: '' }, '（跟随 DSH 默认）'))
        if (needExtra) optionNodes.push(h('option', { key: '__custom', value: value }, '★ ' + value))
        for (const it of data.items) {
          optionNodes.push(h('option', { key: it.name, value: it.name }, fullDate(it.installedAt) + '  ' + it.name))
        }

        return h(
          'div',
          { style: { display: 'flex', flexDirection: 'column', gap: '8px', padding: '10px 0' } },
          h(
            'div',
            { style: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '12px' } },
            h(
              'div',
              { style: { flex: '1 1 auto', minWidth: '0' } },
              h('div', { style: { fontSize: '13px', fontWeight: 600 } }, label),
              h('div', { style: { fontSize: '12px', opacity: 0.6, marginTop: '2px' } }, line1),
              h('div', { style: { fontSize: '11px', opacity: 0.5, marginTop: '2px', wordBreak: 'break-all' } }, line2),
            ),
            h(
              'div',
              { style: { display: 'flex', alignItems: 'center', gap: '6px', flex: '0 0 auto' } },
              h('input', {
                type: 'text',
                value: filter,
                placeholder: '过滤…',
                onChange: (e) => { setFilter(e.target.value) },
                style: Object.assign({ width: '92px' }, inputStyle),
              }),
              h(
                'select',
                {
                  value: value,
                  onChange: (e) => { choose(e.target.value) },
                  style: Object.assign({ maxWidth: '380px' }, inputStyle),
                },
                optionNodes,
              ),
              h('button', {
                type: 'button',
                onClick: () => { choose('') },
                style: Object.assign({ cursor: 'pointer' }, inputStyle),
              }, '还原'),
            ),
          ),
          h(
            'div',
            { style: { display: 'flex', alignItems: 'center', gap: '6px' } },
            h('span', { style: { fontSize: '11px', opacity: 0.5, flex: '0 0 auto' } }, '自订：'),
            h('input', {
              type: 'text',
              value: custom,
              placeholder: '手打字体名，或完整 font-family 串（含逗号当整串用）',
              onChange: (e) => { setCustom(e.target.value) },
              onKeyDown: (e) => { if (e.key === 'Enter') applyCustom() },
              style: Object.assign({ flex: '1 1 auto', minWidth: '0' }, inputStyle),
            }),
            h('button', {
              type: 'button',
              onClick: applyCustom,
              style: Object.assign({ cursor: 'pointer', flex: '0 0 auto' }, inputStyle),
            }, '套用'),
            h('button', {
              type: 'button',
              title: '重新枚举系统字体（装完新字体后按一下；但 Chromium 仍需重开窗口才渲染得到）',
              onClick: () => {
                fetch('/font-picker/api/refresh', { method: 'POST' })
                  .then(() => { setFilter((f) => f) })
                  .catch(() => {})
              },
              style: Object.assign({ cursor: 'pointer', flex: '0 0 auto' }, inputStyle),
            }, '🔄 重新枚举'),
          ),
        )
      }
    }

    const inject = ['slots', 'configForms']
    /**
     * 插件入口。
     * @param ctx - client cordis context。
     */
    function apply(ctx) {
      const slots = ctx.get('slots')
      if (slots === undefined) return

      // 读一次 ui-theme 的当前值，让下拉和设置页的「正文字体/代码字体」文本框
      // 共用同一个来源；之后 ui-theme 那边的改动也会同步回来。
      const forms = ctx.configForms
      if (forms !== undefined) {
        themeForm = forms.get('ui-theme')
        const adopt = () => {
          const snapshot = themeForm.getSnapshot()
          const value = snapshot && snapshot.value
          if (value === undefined) return
          if (typeof value.textFontFamily === 'string' && value.textFontFamily !== '') picked.ui = value.textFontFamily
          if (typeof value.codeFontFamily === 'string' && value.codeFontFamily !== '') picked.code = value.codeFontFamily
          if (typeof value.terminalFontFamily === 'string' && value.terminalFontFamily !== '') picked.terminal = value.terminalFontFamily
          renderRootStyle()
        }
        adopt()
        themeForm.subscribe(adopt)
      }

      slots.inject('settings.general.item', () => slots.register(
        { name: 'settings.general.item', id: 'font-picker-ui', order: 13 },
        makeRow('ui', 'UI 字体'),
      ))

      slots.inject('settings.general.item', () => slots.register(
        { name: 'settings.general.item', id: 'font-picker-code', order: 14 },
        makeRow('code', '代码字体'),
      ))

      slots.inject('settings.general.item', () => slots.register(
        { name: 'settings.general.item', id: 'font-picker-terminal', order: 15 },
        makeRow('terminal', '终端字体'),
      ))

      console.log('dsh-font-picker client ready (static)')
    }

    exports.name = 'dsh-font-picker'
    exports.inject = inject
    exports.apply = apply
    return module.exports
  },
})
