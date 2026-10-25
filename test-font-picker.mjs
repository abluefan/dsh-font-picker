// dsh-font-picker 离线自测
//
// 只测纯函数 parseFontRegistry —— 不跑 reg query、不碰运行中的 DSH、不写任何文件。
// 跑法：
//     cd <插件合集目录>\dsh-font-picker
//     node test-font-picker.mjs
// 期望：全过，退出码 0。
//
// 为什么这条断言值得留着：Phase 1 就是靠一份等价脚本抓出「注册表名会被错误摊平」
// 和「中文名要保留 Regular 后缀」两件事，所以格式一改就要重跑这里。

import { parseFontRegistry } from './index.js'

let passed = 0
let failed = 0

/**
 * 断言并记分。
 * @param name - 用例名。
 * @param ok - 是否通过。
 * @param detail - 失败时附加的说明。
 */
function assert(name, ok, detail) {
  if (ok) {
    passed += 1
    console.log('  ok   ' + name)
  } else {
    failed += 1
    console.log('  FAIL ' + name + (detail === undefined ? '' : '  → ' + detail))
  }
}

/**
 * 名字数组是否包含某条（精确匹配）。
 * @param rows - parseFontRegistry 的结果。
 * @param name - 期望的字体名。
 * @returns 布尔。
 */
function has(rows, name) {
  return rows.some((r) => r.name === name)
}

console.log('== parseFontRegistry ==')

// 1. 基本一行
{
  const text = '    Arial (TrueType)    REG_SZ    arial.ttf'
  const rows = parseFontRegistry(text)
  assert('单行解析出 1 条', rows.length === 1, 'got ' + rows.length)
  assert('名字剥掉 (TrueType)', has(rows, 'Arial'))
  assert('文件名带出来', rows[0] && rows[0].file === 'arial.ttf', rows[0] && rows[0].file)
}

// 2. 变体后缀必须保留（用户明确要求「要能选不同粗度」）
{
  const text = '    Arial Bold (TrueType)    REG_SZ    arialbd.ttf'
  const rows = parseFontRegistry(text)
  assert('Arial Bold 不被摊平成 Arial', has(rows, 'Arial Bold'))
}

// 3. 中文名 + 后缀（Phase 1 实测能 match 的那一类）
{
  const text = '    霞鹜文楷 屏幕阅读版 Regular (TrueType)    REG_SZ    LXGWWenKaiScreen.ttf'
  const rows = parseFontRegistry(text)
  assert('中文名 + Regular 后缀原样保留', has(rows, '霞鹜文楷 屏幕阅读版 Regular'))
}

// 4. 一个条目含多个族名（& 分隔）
{
  const text = '    Microsoft YaHei & Microsoft YaHei UI (TrueType)    REG_SZ    msyh.ttc'
  const rows = parseFontRegistry(text)
  assert('& 拆成 2 条', rows.length === 2, 'got ' + rows.length)
  assert('拆出前半', has(rows, 'Microsoft YaHei'))
  assert('拆出后半', has(rows, 'Microsoft YaHei UI'))
}

// 5. 竖排字体（@ 开头）跳过
{
  const text = '    @SimSun (TrueType)    REG_SZ    simsun.ttc'
  const rows = parseFontRegistry(text)
  assert('@ 开头跳过', rows.length === 0, 'got ' + rows.length)
}

// 6. 表头 / chcp 回显 / 空行跳过
{
  const text = [
    '',
    'HKEY_LOCAL_MACHINE\\SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion\\Fonts',
    'Active code page: 65001',
    '    Consolas (TrueType)    REG_SZ    consola.ttf',
    '',
  ].join('\r\n')
  const rows = parseFontRegistry(text)
  assert('杂行被跳过、只留字体行', rows.length === 1, 'got ' + rows.length)
  assert('留下的是 Consolas', has(rows, 'Consolas'))
}

// 7. 制表符分隔也认（reg query 不同代码页下可能用 tab）
{
  const text = '\tCascadia Code (TrueType)\tREG_SZ\tCascadiaCode.ttf'
  const rows = parseFontRegistry(text)
  assert('tab 分隔可解析', has(rows, 'Cascadia Code'), JSON.stringify(rows))
}

// 8. 绝对路径型条目（用户字体）
{
  const text = '    悠哉字体 Regular (TrueType)    REG_SZ    C:\\Users\\<user>\\AppData\\Local\\Microsoft\\Windows\\Fonts\\Yozai-Regular.ttf'
  const rows = parseFontRegistry(text)
  assert('绝对路径条目可解析', has(rows, '悠哉字体 Regular'))
  assert('绝对路径完整保留', rows[0] && rows[0].file.indexOf('C:\\Users\\') === 0, rows[0] && rows[0].file)
}

// 9. 畸形行忽略，不抛错
{
  const text = '    sdk_init_timestamp    REG_DWORD    0x6a8c021b\n不是一行注册表输出'
  const rows = parseFontRegistry(text)
  assert('REG_DWORD 与乱码行被忽略', rows.length === 0, 'got ' + rows.length)
}

// 10. 空输入
{
  const rows = parseFontRegistry('')
  assert('空输入返回空数组', Array.isArray(rows) && rows.length === 0)
}

console.log('')
console.log(passed + ' passed, ' + failed + ' failed')
process.exit(failed === 0 ? 0 : 1)
