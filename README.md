# dsh-font-picker

在「设置 → General」加字体选择（UI 字体 / 代码字体 / 终端字体）：枚举系统已装字体、选完即时套用、持久化。

## 功能

- **枚举系统字体** —— 直接跑 `reg query`（零第三方依赖），按字体文件 `birthtime`（安装时间）新 → 旧排序
- **持久化** —— `$DSH_HOME/font-picker.json`
- **首屏注入** —— 把当前选择的 `<style>` 与 `window.__DSH_FONT_PICKER__` 塞进 `index.html`
  （字体清单**不**注入 —— 数量太大，改走 HTTP API 按需取）
- **重新枚举** —— 装完新字体不用重启，点一下刷新

## HTTP API（同源 fetch）

| 方法 | 路径 | 作用 |
|---|---|---|
| GET | `/font-picker/api/fonts?q=&limit=` | 字体清单（过滤 + 分页，默认 80 / 上限 300） |
| GET | `/font-picker/api/state` | 当前选择 |
| POST | `/font-picker/api/set` | 写入选择 |
| POST | `/font-picker/api/refresh` | 重新枚举 |

## 生命周期

枚举挂在 `tapIndex` 上 —— 每次页面加载（开窗 / F5）检查一次 TTL（30 秒），过期就重新枚举。

这与「Chromium 进程级缓存字体枚举、装完新字体必须重开窗口」的节拍天然对齐：重开窗口 = 重新枚举，零手工步骤。

## 安装

### ① 通过插件市场（推荐）

在 [awesome-dsh-plugin](https://awesome-dsh-plugin.com) 的目录里找到本插件，
或在 dsh 的 **插件 → 发现** 里搜索 `dsh-font-picker`，点安装。

### ② 手动安装

任选一种，**不要两种同时用**：

**A. 复制 + 手写 insert（适合本地开发）**

1. 把本目录复制到 `$DSH_HOME/profiles/web/node_modules/dsh-font-picker/`
2. 在 `$DSH_HOME/profiles/web/cordis.patch.yml` 加：

   ```yaml
   - insert:
       - id: font-picker
         name: 'dsh-font-picker'
   ```

3. 重启 dsh，或让 Loader 重载配置

**B. `dsh plugin add`（需要包已发布到 npm）**

```sh
dsh plugin --profile web add dsh-font-picker
```

> ⚠ 用 B 之后，包名会进 `dsh.profile.bundles`，bundles 层会读本包自带的
> `cordis.patch.yml`；此时**不要**再做 A 的第 2 步 —— 同一个 id 会被插两次，
> DSH 启动会直接失败。

## 平台

Windows（读注册表 `HKLM\SOFTWARE\Microsoft\Windows NT\CurrentVersion\Fonts` + `C:\Windows\Fonts`）。

## 环境

- DSH ≥ 0.2.1
