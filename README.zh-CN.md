# Simula Playable Simulation Agent（中文说明）

给它任何一个没见过的 HTML5 playable：它在手机尺寸的浏览器里加载游戏，从画面上自己弄懂玩法，像真人一样玩，
以 30 fps 录下每一帧（带游戏原声），剪出一支 20 秒 9:16 的高光视频，写出新手 friction 报告，并给自己的成片打分。

```bash
./run --playable ./game.html --out highlight.mp4
```

没有任何 per-game 代码、规则或坐标：游戏相关的一切都在运行时从像素、DOM（如果有）和游戏注册的输入事件中得到。

## 核心设计

1. **虚拟时钟，而不是实时。** 注入的 shim 接管游戏能读到的所有时钟（rAF、定时器、performance.now、Date、
   event.timeStamp、CSS/Web Animations、AudioContext.currentTime），游戏只在 agent “推进一帧”时前进。
   模型思考时游戏冻结，思考时间不会出现在画面里；每一帧之间严格相隔 1/30 秒游戏时间，与机器快慢无关
   （无 GPU 时 3D 样例实时只有 2–5 fps，实时录制根本做不到 30 fps）。两个通用护栏：忙等循环检测
   （启动时的 CPU 跑分）和显式结束 Web Animations（否则 `.finished` 回调不触发、特效会冻在屏幕上）。
2. **按游戏时间重建游戏音频。** shim 记录游戏启动的每一个声音（解码后的 buffer、带通路增益的 buffer source、
   `<audio>` 及其音量渐变、振荡器）和它的游戏时间，离线混音，和视频逐帧同步。
3. **像玩家一样看，加上通用辅助。** 主观察是截图；DOM 游戏额外给可交互元素画编号（set-of-marks），
   并告诉规划器游戏监听了哪些输入事件（能不能拖拽）。从不读取游戏内部变量。
4. **慢而聪明的规划器 + 快而便宜的判断。** 规划器（Gemini 4 Hydrogen）每回合看截图、写笔记、给出 1–4 个手势；
   Decider（Perplexity Decider，Decisions API，约 0.3 秒、免费）在同一冻结帧上回答类型化问题：屏幕阶段、
   上一个输入是否生效（前后两张图）、新手是否知道下一步做什么、画面刺激程度。
5. **像人的手。** 对数正态反应时间 + 画面大变后的阅读时间、Fitts 定律、贝塞尔曲线拖拽 + 抖动、按压持续几帧、
   偶尔点偏（“熟练但不完美”）。高光视频里按动作日志画出手机式触摸指示，让观众一眼看懂核心玩法。
6. **模型决定故事，代码保证数字。** Director 写三份不同策略的剪辑表（EDL）；代码保证严格 20.0 秒、
   速度 1.0–1.5×、素材 ≤ 30 秒、不在手势中途切、去掉死画面（保留约 1 秒自然停顿）、结尾是 end card。
7. **多候选 + 评估 + 对照组。** 规格门槛 + 可解释启发式 + VLM 评审 + 两两比较；两个“偷懒剪法”
   （前 20 秒、随机片段）用同样方式打分，评估必须把它们明显排在真实剪辑之下。
8. **end card 是广告的一部分。** 停留 2.5 秒后点一次 CTA；剪辑以它结尾。

## 编排与可追溯性

每个 playable 是一个 Pi Durable `SessionTask`：play → index → cut → render → eval → friction → report，
每个阶段提交 checkpoint，崩溃或 Ctrl-C 后从断点继续；`--redo <phase>` 可以不重玩直接重剪/重评。
每个 session 目录里有：`trace.html`（整个会话逐回合：看到了什么、笔记、动作、Decider 判断、成本，点击时间跳转原始录像）、
`plans.jsonl`、`actions.jsonl`（逐帧手势）、`observations.jsonl`、`ledger.jsonl`（每次付费调用）、`trace.jsonl` 等。

## 文档

- 英文主文档：[README.md](README.md)（设计取舍、Goal 3/4 细节、结果、运行方式）
- 生产化方案（Goal 5）：[docs/productionization.md](docs/productionization.md)
