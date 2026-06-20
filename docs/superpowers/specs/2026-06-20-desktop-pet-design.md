# 桌宠(阿尼亚)设计文档

- 日期:2026-06-20
- 状态:已与用户对齐,待评审
- 分支:`feat/desktop-pet`(从 `main` 拉,本功能与波形相互独立)
- 关联记忆:`bugzia-desk-assistant`、`bugzia-waveform-wip`

## 1. 目标

给 Bugzia 桌面加一个**自包含的桌面陪伴宠**:屏幕上贴一只阿尼亚(Any​a)风格的桌面宠,有少量姿态动画,能与你互动(看向你、被摸头、被拖动、随机冒口癖气泡),空闲时自己眨眼/东张西望。

定位:**桌面陪伴**(非助手化身、非状态映照)——与 Bugzia 现有功能(AI/搜索/天气/波形)解耦,纯靠前端定时器与指针事件自驱动,不监听任何系统/音频事件。

素材策略:**占位图先做,随时替换**。功能先用内置 SVG 占位图完整跑通,渲染器按固定文件名从运行时目录加载真图;用户把阿尼亚 PNG 丢进该目录即换肤,无需重新编译。版权姿态最干净:由用户自选图片个人自用,不从仓库抓取版权图。

## 2. 非目标(YAGNI)

- 不做 AI 对话化身(不绑定 chat 流)。
- 不做音乐/天气/时间等状态映照。
- 不做多帧 sprite 连续动画(无现成阿尼亚 sprite sheet,成本过高)。
- 不做多宠、不做人设切换(单一形象)。
- 不内置任何受版权保护的官方图片(只内置占位 SVG)。

## 3. 设计决策(采用值 + 理由)

| 项 | 默认 | 理由 |
|---|---|---|
| 渲染方式 | DOM `<img>` 分镜 + CSS 切换/动效 | 与"少量静态图 + 丢 PNG 即换"1:1 吻合;CPU 极低(99% 待机) |
| 姿态集 | idle / blink / happy / drag / surprise(5 张) | 覆盖待机/眨眼/被摸头/拖动/惊讶;hover 朝向用 idle + CSS transform,不多耗图 |
| 素材来源 | 运行时目录 `${appDataDir}/pet/{pose}.png`,缺失回退内置 SVG | dev 与打包后都"丢即换";不进仓库、不抓版权图 |
| 点击 vs 拖动 | 指针阈值:移动 >5px→`startDragging`;否则=点击 | 规避 `data-tauri-drag-region` 吃点击的经典坑 |
| 互动深度 | hover 看你 + 点击摸头(+气泡)+ 拖动 + 空闲定时 | 用户选定"互动陪伴" |
| 说话 | 口癖气泡,文本在设置里可改 | 个人自用、用户可控;避免硬编码固定版权台词 |
| 窗口形态 | 透明、无装饰、不进任务栏、无阴影、可置顶/锁定 | 复用 result/waveform 浮窗形态 |
| 默认尺寸 | 150×200 逻辑像素 | 桌宠偏小 |
| 默认位置 | 屏幕右下角(x/y=-1 哨兵=未放置) | 不挡主卡片(主卡片居中/上方) |
| always_on_top | **开**(可切换) | 桌宠要看得见 |
| locked(穿透) | **关**(可切换) | 默认可互动;想不挡桌面操作时再锁定 |
| enabled | **关**(托盘/设置切换) | 同 waveform,默认不主动开 |

## 4. 架构

复用已验证的 result/waveform 浮窗骨架,新增窗口 label `"pet"`。后端极轻(无新模块、无 `.manage()` 状态),因为宠是纯前端。

```
托盘 "桌宠" ──toggle──> settings.pet.enabled ──> 主窗口 CommandCard
                                                    │
                          show/hide PetWindow (label="pet")
                                                    │
                          PetWindow.tsx (姿态状态机 + CSS)
                            ├─ 资源:${appDataDir}/pet/{pose}.png ─convertFileSrc─> <img>;onError 回退 SVG
                            ├─ hover:鼠标坐标→CSS 变量→idle 朝向
                            ├─ click(短按):摸头 happy + 随机口癖气泡
                            ├─ drag(移动>阈值):window.startDragging()
                            └─ 空闲定时器:随机眨眼/东张西望/偶发说话
```

## 5. 组件清单(逐文件)

### 后端(无新模块)

**`src-tauri/src/settings.rs`** — 加 `PetSettings`(手动 `Default` + 字段级 `#[serde(default)]`),`AppSettings` 加 `#[serde(default)] pub pet: PetSettings`。字段(snake_case,向后兼容旧 settings.json):

```
enabled: bool(false) | always_on_top: bool(true) | locked: bool(false)
scale: f32(1.0)                         // 整体缩放倍数(替代透明度;宠是不透明精灵)
blink_interval_ms: u32(4000)            // 眨眼间隔
speech_enabled: bool(true)              // 是否说话
speech_interval_ms: u32(20000)          // 空闲偶发说话间隔
speech_lines: Vec<String>(默认几条 Anya 口癖)  // 带 serde 默认函数,旧文件无此字段仍加载
x: i32(-1) | y: i32(-1) | w: u32(150) | h: u32(200)  // -1=未放置,用默认位
```

**`src-tauri/src/lib.rs`** — 三处小改:
- 内联两条命令 `pet_set_locked(app, locked)` / `pet_set_always_on_top(app, top)`,照搬 `set_result_always_on_top` 的写法,目标窗口 `"pet"`(锁定额外 emit `pet://lock-changed` 通知前端,与 waveform 一致)。
- 托盘加 `CheckMenuItem "桌宠"`,镜像 `settings.pet.enabled`(切换时持久化 + `app.emit("settings://changed", ())` + `set_checked`)。
- `invoke_handler` 注册上述两条命令。
- **不**加 `mod pet`、**不**加 `.manage()`(无后端状态)。

### 前端

**`src/features/settings/settingsTypes.ts`** — 加 `PetSettings` interface + `DEFAULT_PET`(值同上 Rust 默认),挂进 `AppSettings` / `DEFAULT_SETTINGS`,并在 `SettingsPatch` 加 `pet`。

**`src/features/pet/petWindow.ts`**(新)— 克隆 `waveformWindow.ts`:`ensurePetWindow / showPetWindow(geom?, {alwaysOnTop?}) / hidePetWindow / onPetGeometryChange`。`LABEL = "pet"`,`DEFAULT_W=150`、`DEFAULT_H=200`、`MIN_W=80`、`MIN_H=100`。几何持久化(onResized/onMoved → scaleFactor 转逻辑像素,`suppressGeomPersist` 防初始化抖动)。**默认放置改屏幕右下角**(非波形的下方居中):`x = waW - w - 24`、`y = waH - h - 80`。窗口创建参数同 waveform(`decorations:false, transparent:true, shadow:false, skipTaskbar:true, visible:false`)。

**`src/components/PetWindow.tsx` + `.css`**(新)— 渲染器核心:
- 挂载 `loadSettings().pet`;监听全局 `settings:updated` 事件合并 `.pet` 段 live 套用(scale/置顶/锁定/口癖/频率)。
- 资源加载:用 `@tauri-apps/api/path` 的 `appDataDir()` 解析 `pet/{pose}.png`,`@tauri-apps/api/core` 的 `convertFileSrc` 转 URL;每姿态 `<img>` 带 `onError` 回退到内置 SVG 占位(绝不空白)。
- 姿态状态机(useReducer):state ∈ {idle, blink, happy, drag, surprise};reducer 是纯函数,接收事件(pet/drag-start/drag-end/timer-blink/timer-look/timer-speak)返回下一态。
- 指针处理(根容器):`pointerdown` 记起点 + 时间;`pointermove` 移动超 `DRAG_THRESHOLD=5px` 进 drag 模式 → `getCurrentWindow().startDragging()` + 置 drag 姿态 + 标记 suppress-click;`pointerup` 若未进 drag 模式 → 派发 pet 事件(happy + 随机气泡)。
- hover:根容器 `pointermove`(未按下时)把鼠标相对坐标写 CSS 变量 `--look-x/--look-y`,CSS 让 idle 朝向轻微偏移。
- 气泡:绝对定位 div,淡入淡出;文本从 `speech_lines` 随机取;`speech_enabled=false` 或 `speech_lines` 为空则不显示。
- 空闲定时器:`useEffect` 按 `blink_interval_ms` / `speech_interval_ms` 排程 `setTimeout`(组件卸载清掉);窗口隐藏时暂停。
- 全窗根元素承载拖动/点击(非 `data-tauri-drag-region`,见 §7)。

**`src/App.tsx`** — 加 `if (label === "pet") return <PetWindow />;`。

**`src/components/CommandCard.tsx`** — 镜像 waveform 接线:
- `onPetGeometryChange` 持久化几何到 settings.pet。
- `useEffect([settings?.pet.enabled])`:enabled → `showPetWindow(geom)` + 顺序应用 `pet_set_always_on_top`/`pet_set_locked`;否则 `hidePetWindow`。
- `useEffect([settings?.pet.always_on_top, settings?.pet.locked])`:字段变化时 live 应用(让设置面板切换即时生效)。
- 监听 `settings:updated`(合并 pet 段)+ `settings://changed`(托盘切换→从盘重载)。
- 主窗口仍是 settings.json 唯一写盘者。

**`src/components/SettingsPanel.tsx`** — 加"桌宠"段:开关 / 置顶 / 锁定 / 缩放 / 眨眼频率 / 说话开关 + 频率 / 口癖文本框(每行一条)/ 重置位置(把 x/y 写回 -1)/ 打开素材文件夹按钮。编辑经现有 `settings:updated` patch 广播。「打开素材文件夹」用已引入的 opener 插件(`tauri-plugin-opener`)打开 `${appDataDir}/pet`,settings 窗口的 capability 需加 opener 相关权限。

### Capability

**`src-tauri/capabilities/pet.json`**(新)— 克隆 `waveform.json`,`windows: ["pet"]`,权限 `core:default` + window `allow-close/hide/show/set-focus/start-dragging` + `core:event:allow-listen/default`。
**外加(本功能特有,见 §6)**:`core:asset:default` + asset 作用域允许 `$APPDATA/pet/**`(供 `convertFileSrc` 读本地 PNG);若 asset 协议走不通,回退用 `@tauri-apps/plugin-fs` 读字节→`URL.createObjectURL`(则权限换 `core:fs:allow-read-file` + fs 作用域)。

`tauri.conf.json` 不改(pet 由前端动态创建,创建权限 `core:webview:allow-create-webview-window` 已在 main 的 default.json)。

## 6. 素材加载(关键细节 + 待验证集成点)

**主方案**:`convertFileSrc(appDataDir()/pet/{pose}.png)` → webview 经 asset 协议读本地文件。缺失/失败 → 组件内置 SVG 占位回退。
- 设置面板显示解析出的目录绝对路径 + "打开文件夹"按钮,用户把 `idle.png / blink.png / happy.png / drag.png / surprise.png` 丢进去即换肤。
- **唯一需实编时验证的集成点**:Tauri v2 asset 协议的作用域语法(`core:asset` 权限 + 对 `$APPDATA/pet/**` 的 scope 授权)。这是本次唯一的真实未知。

**回退方案**(若 asset 协议不顺):用 `@tauri-apps/plugin-fs` 的 `readFile` 读字节 → `new Blob` → `URL.createObjectURL` 显示;权限改 `core:fs:allow-read-file` + fs scope。代码多约 15 行,同样可行。

## 7. 点击 vs 拖动(经典坑的解法)

`data-tauri-drag-region` 会让整个元素成为 OS 拖动手柄并**吃掉点击事件**,导致"可拖动 + 可点击"无法兼得。解法:**不用** drag-region,改用根容器的指针事件 + 阈值:

- `pointerdown`:记录起点 (x0,y0) + 时间戳,设 `potentialDrag=true`、`suppressClick=false`。
- `pointermove`:`dist = hypot(x-x0, y-y0)`;若 `> DRAG_THRESHOLD(5px)` 且 `potentialDrag` → 调 `getCurrentWindow().startDragging()`(OS 原生移动,最顺,无逐帧 IPC),置 drag 姿态,`suppressClick=true`,`potentialDrag=false`。
- `pointerup`:若 `!suppressClick` → 视为点击 → 派发 pet 事件(happy 姿态 + 随机口癖气泡)。

阈值判定的 `isDrag(startX,startY,endX,endY)` 提成纯函数,便于单测。

## 8. 数据流

- 持久化:`PetSettings` 在 settings.json(主窗口唯一写盘)。
- 托盘"桌宠"→ 切 `enabled` → 存 → emit `settings://changed` → 主窗口重载 → show/hide。
- 设置面板改 → `settings:updated` patch → 主合并存盘 + pet 窗口收到 live 套用(置顶/锁定/口癖/缩放/频率)。
- 几何:pet 窗口 onResized/onMoved → `onPetGeometryChange` → 主窗口持久化 x/y/w/h(scaleFactor→逻辑像素,init suppress)。
- 无音频/系统事件(区别于 waveform),宠纯靠定时器 + 指针自驱动。

## 9. 错误处理

- 缺图/加载失败 → 该姿态回退 SVG 占位(绝不空白)。
- `${appDataDir}/pet` 不存在 → 全占位,不崩。
- `startDragging` 抛错 → 吞掉(不崩)。
- 锁定(穿透)开启时,指针直达桌面,宠的点击/拖动自然失效——这是锁定的预期行为(想互动时关掉锁定)。
- `speech_lines` 为空 或 `speech_enabled=false` → 静默不说话。
- `pet_set_locked` / `pet_set_always_on_top` 目标窗口不存在 → 返回 `Err`(与 waveform 一致)。
- 旧 settings.json 无 `pet` 段 → `#[serde(default)]` 兜底默认值,不擦除其它设置。

## 10. 测试与交付闸口(CLAUDE.md 规则二)

- 前端无测试框架(`package.json` 仅 `tsc && vite build`),前端纯逻辑(姿态状态机 reducer、`isDrag` 阈值)保持独立可测;本期以**手动闸口**为主。
- Rust:`cargo test` 加 `PetSettings::Default` + serde 往返(旧 settings.json 无 `pet` 段仍能加载)。
- 闸口全过才算完成:
  1. `tsc --noEmit` 0 错误
  2. `cargo check`(+ `generate_context` 校验 conf/capabilities,含 §6 的 asset scope)
  3. `pnpm build` 出 dist
  4. `pnpm tauri dev` 桌面手动:托盘&设置开"桌宠"→浮窗右下角出现(占位 SVG);hover 朝向你;点击→摸头 happy + 气泡;拖动→移位并记位;眨眼/空闲定时器跑;锁定→鼠标穿透;置顶切换;往 `${appDataDir}/pet/` 丢真 PNG→出现真图;设置面板各项 live 生效;几何重启恢复。

## 11. 风险与回退

- **§6 asset 协议 scope**:唯一真实未知,实编时先验证;不顺则走 fs→blob 回退(已在 §6 写明)。两者都不破坏既有契约。
- **纯新增、不改既有契约**:`AppSettings` 只**新增** `pet` 段(`#[serde(default)]` 全兼容),不改任何现有命令/字段;不触碰既有功能。
- **点击/拖动**:若阈值方案在某 webview2 版本上 startDragging 与 click 仍冲突,回退为"长按拖动 / 短按互动"或加一个可见拖动手柄区(均不破坏契约)。
- 本功能走新分支 `feat/desktop-pet`,与已完成的波形(`feat/audio-waveform`)相互独立,可各自合并。

## 12. 待评审问题

无。所有方向(定位=桌面陪伴、深度=少量分镜、互动=互动陪伴、素材=占位先做随时替换、骨架=复用 waveform 浮窗、点击/拖动=指针阈值、默认值)均已与用户对齐。
