# Bercy 真实 Codex 回归集

在仓库根目录运行。每次启动一个新的 Electron 桌面进程和独立工作区，只连接本机已登录的 Codex。默认测试当前源码；要测已打包版本，可把环境变量 `BERCY_APP` 设为 Bercy 的可执行文件路径。运行会使用模型额度，结果可能随模型更新而变化。

```sh
npm run test:regression -- --list
npm run test:regression
npm run test:regression -- coding
npm run test:regression -- race exhausted
node regression/local-folder.mjs
```

可按组名 `business`、`flow`、`coding`，也可按案例 ID 组合选择。单选 `reuse` 会先运行它要复用的 `timezone`。库中的 30 条场景按独立用户需求计数。仓库的 Node 自动化测试单独用 `npm test` 运行。

| 组别 | 条数 | 覆盖 |
| --- | ---: | --- |
| business | 20 | 写作、排期、大小账本、文件与图片输入、工作簿、字幕、音轨、日历、可运行脚本、联网引用和流程复用 |
| flow | 5 | 并行文件和正文汇合、待补件恢复、中断重试、复核退回期间旧分支写回、退回上限 |
| coding | 5 | 从零开发 CLI、修复已有函数、向后兼容地扩展 API、只写测试、先复现再修复 |

## 代码案例怎样验收

| ID | 交给 Codex 的工作 | 独立验收 |
| --- | --- | --- |
| stock-cli | 实现 CSV 库存汇总 CLI，第二个节点编写运行测试 | 用 3 组标准输入运行交付程序，检查引号、前导零、负数、坏行和空表 |
| rounding | 修复已有金额转换函数，补回归测试 | 保留旧测试，校验 6 个金额；把旧实现换回临时副本，交付的测试须失败 |
| paging | 给现有目录接口加分页 | 校验旧调用、过滤后分页、零条、越界、负参数和输入未变；换回旧实现后交付的测试须失败 |
| tests-only | 只给运费函数补 unittest | 校验原文件逐字节不变；对两个重量分界、会员优惠、布尔类型分别引入一处错误，交付的测试须全部检出 |
| fix-and-test | 先编写重复投递的失败用例，再交给另一个节点修复 | 读取两个节点的真实测试命令及状态；在原版和修复版复跑同一套测试，另外校验跨仓重复和负数 |

## 环境与结果

- 需要桌面会话、Node.js 22.13+、仓库 npm 依赖、Python 3.9+ 和已登录的 Codex CLI。使用源码首次运行前确保 Electron 已安装，可执行 `npm run prestart`。全部 5 条代码案例自身只使用 Python 标准库。
- Excel 的独立验收需要 Python 包 openpyxl 和 LibreOffice；WAV 频谱验收需要 numpy。可用 `REGRESSION_PYTHON` 指定 Python，用 `SOFFICE` 指定 LibreOffice 可执行文件。运行器也会查找本机 Codex 随附的 Python 和 LibreOffice。
- 业务需求通过 Bercy 的规划、执行和附件接口提交。代码案例与流转案例使用固定节点图，便于比较同一职责划分在不同版本上的表现。代码案例的已有项目种子在启动节点前复制到新工作区。并行旧版本写回案例单独关闭动态观察者，以便稳定触发复核退回与并行执行重叠。其他案例保留默认观察者配置。
- 每次运行的目录为 `build/regression/<时间>-<随机后缀>/`。`config.json` 记录配置和范围，`executions.json` 保留节点、命令状态和实际交付，`report.json` 列出逐项验收；生成的代码在该目录的 `profile/projects/`。原始工作区可能较大。
- PASS 表示该案例的自动断言通过。FAIL 表示断言失败或执行中断。REVIEW 表示有内容或过程证据需要人工核对。只有全部 PASS 时进程才返回 0。两条复核退回场景分别检查旧输入失效和退回上限，防止同类问题再次出现。自然语言检查只覆盖列明的可观测特征。
- 保留运行目录后，可用同一 Python 执行 `python3 -B regression/grade.py <运行目录>`，重新检查现有产物，无需再次调用模型。案例原文和验收要求在 [cases.json](cases.json)，固定输入在 [inputs](inputs)，代码种子在 [projects](projects)。

本地目录另有专项集成测试 `node regression/local-folder.mjs`，独立于上述 30 条案例。它在临时仓库中使用真实 Codex 执行修改和附件交付，系统目录选择器的返回值由测试提供。
