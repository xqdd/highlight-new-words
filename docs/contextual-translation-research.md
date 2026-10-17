# 上下文释义方案调研

调研日期：2026-10-07。

本文整理当前项目的上下文释义问题、可选 API、本地翻译模型及浏览器 WebGPU 部署条件。额度和模型文件大小来自调研时的官方资料或模型仓库；尚未在本扩展中运行模型或调用翻译 API，不能将文档中的方案判断当作准确率、延迟或设备兼容性的实测结果。

## 1. 需求与现状

目标是让高亮生词的中文短释义贴合所在句子，同时保持现有阅读体验、加载速度和移动端可用性。

当前实现：

- `src/core/dict/types.ts` 中的 `DictEntry.short` 提供固定短释义，`shortVerb` 提供补充动词义。
- `src/content/engine/engine.ts` 的 `fillTranslations()` 按词条批量查询并缓存释义；`translationOf()` 综合词形、搭配及动词位置选择释义。
- `src/core/dict/collocation.ts` 用相邻词匹配固定搭配。
- 引擎已有接近视口时插入译文的 `IntersectionObserver` 机制，可作为后续调度上下文请求的入口。

这些方法能修正部分常见错误，但未利用完整句子。同一个词在不同语境中仍容易显示相同释义。继续扩充搭配表只能覆盖有限情况。

期望结果示例，以下不是模型实测输出：

```text
He deposited money at the bank. → bank：银行
They rested on the river bank.  → bank：河岸
```

本项目需要的是“指定位置上的词或短语的上下文短释义”。整句翻译 API 不一定直接满足需求：还需解决原词与译文对应、短语边界以及释义长度问题。

### 1.1 筛选前提：词典可能缺词、缺义

内置词典不能假定覆盖所有词条、专业义、俚语和短语。例如 AI 文章中的 `agent` 可能需要显示“智能体”，即使词典只有“代理人、经纪人”，也应允许生成新的短释义。

因此，上下文服务必须能在没有词典条目或候选义不全时，直接根据原文生成释义。词典只负责即时显示、提供可选参考和失败回退；“只能从词典候选义中选答案”不作为主方案。词典无释义且上下文请求失败时，只保留高亮，不强行显示不相关解释。

本次推荐按任务匹配、工程接入、下载负担和桌面/手机覆盖筛选；均为待实测的方案判断，不是模型准确率排名。优先候选及暂缓理由见第 7 节。

## 2. 云端 API 候选

| 服务 | 调研时确认的免费政策 | 对本项目的适用性 |
| --- | --- | --- |
| DeepL API Free | 每月最多 50 万字符；`context` 参数中的字符不计入翻译计费 | 目标词放入 `text`，所在句子或段落放入 `context`，接入较直接；需验证消歧及输出长度 |
| Gemini Flash-Lite | 官方提供免费层；具体请求、Token 和每日限额以账户的 AI Studio 配额为准 | 可提交句子、目标位置和输出约束，一次生成多个生词的短释义；需验证结构化输出和词义准确性 |
| DeepSeek `deepseek-flash` | 按 Token 计费，不作为长期免费方案 | 支持 JSON 输出与非思考模式，适合按句批量生成指定位置的短释义；无需已有词典候选 |
| Azure Translator F0 | 每月 200 万字符，标准翻译与自定义翻译训练共用额度 | 额度较大，适合整句翻译；行内词义对应需额外处理 |
| Google Cloud Translation NMT | Basic 与 Advanced 合计每月前 50 万字符免费，LLM 不适用此额度 | 适合整句翻译；行内短释义需额外处理 |

官方来源：

- [DeepL API 用量与计费](https://support.deepl.com/hc/en-us/articles/360020685720-Usage-count-and-billing-in-DeepL-API)
- [DeepL 翻译接口与 context 参数](https://developers.deepl.com/api-reference/translate/request-translation)
- [Gemini API 定价](https://ai.google.dev/gemini-api/docs/pricing)
- [Gemini API 限额](https://ai.google.dev/gemini-api/docs/rate-limits)
- [DeepSeek 型号与定价](https://api-docs.deepseek.com/quick_start/pricing/)
- [DeepSeek JSON 输出](https://api-docs.deepseek.com/guides/json_mode/)
- [Azure Translator 定价](https://azure.microsoft.com/en-us/pricing/details/translator/)
- [Google Cloud Translation 产品与免费额度](https://cloud.google.com/translate)

注意事项：

- 免费层不等于无限请求。实际开户套餐、地区支持、配额及超额行为必须在接入前确认。
- Gemini 免费层的数据使用政策与付费层不同；官方定价页注明免费层内容会用于产品改进。
- 调研时 Gemini 定价页列有 `gemini-3.5-flash-lite` 等型号。接入时应重新确认模型可用性，型号应可配置。
- DeepSeek 当前推荐名称为 `deepseek-flash`，价格页对应 DeepSeek-V4.1-Flash；首轮测试使用非思考模式。JSON 模式仍可能返回空内容，合法 JSON 也不代表目标齐全、词义正确，需业务校验。
- 腾讯混元云端也有翻译服务和试用资源包，但本次未确认其为持续每月补充的免费额度，因此不列为长期免费首选。[计费说明](https://intl.cloud.tencent.com/zh/document/product/1284/77186)

DeepL 额度估算：若每次仅翻译平均 8 个英文字符的目标词，50 万字符约对应 6.25 万次词语翻译。此估算不含重试、短语长度变化和其他调用；上下文仍会传给服务，只是不计费。

## 3. 专门翻译的小模型

### 3.1 HY-MT1.5-1.8B

腾讯专门翻译模型。官方仓库明确提供上下文翻译、术语干预和保留格式的提示模板，并提供 GGUF、Int4 等版本。

上下文模板的核心形式：

```text
{上下文}
参考上面的信息，把下面的文本翻译成中文，注意不需要翻译上文，也不要额外解释：
{目标词或短语}
```

这是候选调用方式，不代表模型一定能正确处理指定位置、重复词或多义短语。

- [腾讯官方模型说明](https://github.com/Tencent-Hunyuan/Hy-MT/blob/main/README_CN.md)
- [社区 ONNX 浏览器版本](https://huggingface.co/onnx-community/HY-MT1.5-1.8B-ONNX)

### 3.2 TranslateGemma 4B

Google 基于 Gemma 3 的专门翻译模型系列，包含 4B、12B 和 27B，官方评测覆盖 55 种语言。已有社区 ONNX 版本及 WebGPU 演示。

其整句翻译能力与“指定词的简短中文释义”能力应分别评估。4B 版本的下载和运行负担更大，暂不作为轻量扩展的默认候选。

- [Google 官方介绍](https://blog.google/innovation-and-ai/technology/developers-tools/translategemma/)
- [社区 ONNX 版本](https://huggingface.co/onnx-community/translategemma-text-4b-it-ONNX)
- [公开 WebGPU 演示](https://huggingface.co/spaces/webml-community/TranslateGemma-WebGPU)

## 4. 在扩展中使用 WebGPU

### 4.1 已有运行路径

HY-MT 的社区模型页直接给出 Transformers.js 的 WebGPU 加载示例：

```ts
import { pipeline } from '@huggingface/transformers';

const translator = await pipeline(
  'text-generation',
  'onnx-community/HY-MT1.5-1.8B-ONNX',
  { dtype: 'q4', device: 'webgpu' },
);
```

这段代码来自模型页所示用法，本项目尚未验证所需运行库版本、完整构建配置及执行结果。

| ONNX 模型 | Q4 权重文件总量 | Q4F16 权重文件总量 |
| --- | --- | --- |
| HY-MT1.5-1.8B | 约 1.41 GB | 约 1.23 GB |
| TranslateGemma 4B | 约 3.09 GB | 约 2.71 GB |

这里只统计相应精度的模型数据文件，不是整个仓库大小，也未包含 tokenizer、配置和运行库。下载大小不等于内存或显存占用；运行还需要中间张量、KV 缓存，加载过程也可能产生额外副本。

- [HY-MT ONNX 文件列表](https://huggingface.co/onnx-community/HY-MT1.5-1.8B-ONNX/tree/main/onnx)
- [TranslateGemma ONNX 文件列表](https://huggingface.co/onnx-community/translategemma-text-4b-it-ONNX/tree/main/onnx)
- [Transformers.js WebGPU 文档](https://huggingface.co/docs/transformers.js/guides/webgpu)

### 4.2 扩展架构建议

- 用户主动开启本地模型功能后再下载权重，显示进度并提供删除缓存入口。
- 扩展统一管理一个推理实例，页面通过消息提交请求，避免每个标签页各加载一份模型。
- Chrome 124 起已支持 Service Worker 与 Shared Worker 中的 WebGPU；仍需处理扩展后台被回收后的模型重载。
- 根据运行库及浏览器条件，也可考虑扩展隐藏页面加 Worker；是否需要 `offscreen` 权限应由实际实现决定。
- 推理运行库的 JS/WASM 随扩展打包，权重作为数据按需下载；构建时确认 CSP、WASM 和商店远程代码规则。
- 检测实际 GPU 适配器及所需特性；GPU 不可用、内存不足或加载失败时保留词典释义。

项目当前使用 MV3/WXT，尚未包含推理运行库和模型加载配置。

- [Chrome 124 发布说明](https://developer.chrome.com/release-notes/124)
- [WebLLM 扩展和自定义模型说明](https://webllm.mlc.ai/docs/user/advanced_usage.html)
- [Chrome 扩展安全与远程代码说明](https://developer.chrome.com/docs/extensions/develop/migrate/improve-security)

## 5. 核显与手机是否适合

“支持 WebGPU”“能够加载模型”和“适合日常阅读”是三个不同判断。

| 设备场景 | 当前方案判断，未经实测 |
| --- | --- |
| 较新的桌面核显 | 可以作为实验候选；共享内存带宽、可用内存和驱动会影响表现 |
| 老核显或低内存电脑 | 不宜默认加载 GB 级模型 |
| 中高端手机 | 部分设备可能可运行；需验证加载时间、峰值内存、持续速度、耗电与发热 |
| 面向普通手机用户 | 不推荐默认加载 GB 级模型，优先可选 API |

Chrome 官方记录的 Android 初始支持范围为 Chrome 121、Android 12+ 的部分 Qualcomm 和 ARM GPU 设备。这不是当前所有设备的完整兼容列表，也不能直接证明 Edge 手机扩展中的运行情况；应对目标浏览器与设备进行实际检测。

- [Chrome WebGPU 支持概述](https://developer.chrome.com/docs/web-platform/webgpu/overview/)

## 6. 更小的离线候选

### 6.1 HY-MT1.5-1.8B 的 1.25-bit 版本

腾讯提供约 440 MB 的 1.25-bit 版本和手机端演示。该版本使用特殊量化，模型页提供配套 `llama.cpp` 使用方式；不能直接把它当作前述 ONNX 模型交给 Transformers.js 加载。本次未确认其可直接用于浏览器 WebGPU 的现成运行方案。

- [腾讯 1.25-bit 模型页](https://huggingface.co/tencent/Hy-MT1.5-1.8B-1.25bit)

### 6.2 OPUS-MT 英译中

`Xenova/opus-mt-en-zh` 已有 Transformers.js/ONNX 版本。量化编码器约 52.9 MB，合并解码器约 60.2 MB，两者合计约 113 MB，另需 tokenizer、配置及运行库。不同加载方式可能选择其他解码器文件，最终下载量应以实际请求为准。

它主要执行整句翻译。要服务于本项目，还需验证上下文词义准确性、原词与译文对应方式，以及具体量化格式的 WebGPU 兼容性。不能仅凭体积更小就认为能满足上下文短释义需求。

- [OPUS-MT 模型页](https://huggingface.co/Xenova/opus-mt-en-zh)
- [ONNX 文件列表](https://huggingface.co/Xenova/opus-mt-en-zh/tree/main/onnx)

### 6.3 Qwen3-0.6B 与 Qwen3.5-0.8B

这两个通用指令小模型可以直接接收句子、目标位置和短释义要求，不依赖词典候选义。是否能正确补充词典外含义仍需实测。

| 模型 | 已确认的运行资料 | 文件体积与主要限制 |
| --- | --- | --- |
| Qwen3-0.6B | 社区 ONNX 模型卡提供 Transformers.js WebGPU 示例；WebLLM 配置中也有该模型 | ONNX `model_q4f16.onnx` 约 569.8 MB；优先用于验证较明确的浏览器接入路径，不保证专业义准确 |
| Qwen3.5-0.8B | 有社区 ONNX 与 ONNX-OPT 仓库 | 优化版 q4f16 decoder、embedding 数据和小型图合计约 583.5 MB；纯文本实际请求文件、运行库版本及混合架构算子支持待验证 |

这些是模型文件核算，不含 tokenizer、运行库和运行内存，不能按参数量或量化位数直接推算。建议关闭思考、限制输出长度，分别测试无词条、新义和短语；若质量不足，再考虑 Qwen3.5-2B，首轮不同时扩展多个尺寸。

- [Qwen3-0.6B 官方模型卡](https://huggingface.co/Qwen/Qwen3-0.6B)
- [Qwen3 ONNX 示例及文件](https://huggingface.co/onnx-community/Qwen3-0.6B-ONNX)
- [WebLLM 模型配置](https://github.com/mlc-ai/web-llm/blob/main/src/config.ts)
- [Qwen3.5-0.8B 官方模型卡](https://huggingface.co/Qwen/Qwen3.5-0.8B)
- [Qwen3.5 优化 ONNX 文件](https://huggingface.co/onnx-community/Qwen3.5-0.8B-ONNX-OPT/tree/main/onnx)

## 7. 推荐的产品与实现方案

### 7.1 优先保留的可行候选

默认保留现有本地词典；上下文短释义优先作为可选 API 功能。以下是基于已有资料的验证优先级，尚未证明任何候选在本项目中达到验收标准。

| 优先级 | 方案与候选 | 保留理由 | 接入前必须验证 |
| --- | --- | --- | --- |
| 第一优先 | 通用云端模型直接生成：Gemini Flash-Lite、DeepSeek Flash | 可明确指定目标位置、短语边界、输出长度和 JSON；能处理无词条或缺义；手机无需下载模型 | 新义准确率、批量漏项、延迟、实际配额/费用及隐私条件；首轮不预判两者谁更准 |
| 第一轮对照 | DeepL：目标词或短语作为 `text`，句子作为 `context` | 官方有独立上下文参数，接入简单，无需词典候选；上下文不计翻译字符额度 | 指定位置的消歧、短语义与中文输出长度；接口不保证返回适合行内的短释义 |
| 离线质量候选 | HY-MT1.5-1.8B | 专门翻译，官方已有上下文翻译模板；可生成词典外译法 | 重复词位置区分、专业义、输出长度、约 1.23 GB 的 q4f16 下载及峰值内存 |
| 离线体积候选 | Qwen3-0.6B，随后对照 Qwen3.5-0.8B | 约 570～584 MB 的相关 ONNX 文件，有现成运行资料，可直接接受释义指令 | 自由释义质量、实际下载、运行库兼容和设备表现；体积小不能替代准确率验证 |

本地 WebGPU 暂作为桌面端实验功能，手机端优先可选 API。当前未验证到一个同时满足“小体积、手机浏览器可跑、上下文短释义准确”的现成方案。若允许安装常驻本机服务，可另外测试原生量化的 HY-MT 等模型；这增加安装成本，不能直接算作浏览器内离线方案。

### 7.2 暂不进入首轮的方案

| 方案 | 暂缓理由 |
| --- | --- |
| 词典候选选择、MiniLM/WSD 排序 | 不能补出候选外的新义；现有词典也没有完整独立义项结构。可作辅助实验，但不满足缺词、缺义的核心需求 |
| OPUS-MT、Azure/Google NMT、Qwen-MT | 主要是整句或文本翻译，需额外解决词级对应；Qwen-MT 的术语干预不等于自动消歧。当前不优先承担这些额外工程 |
| Chrome 内置 Translator API | 可作桌面整句翻译辅助；官方明确不支持手机，也不能在 Web Workers 使用，未核实有目标位置短释义输出 |
| TranslateGemma 4B、Gemma 4 E2B | 下载/运行负担较大，暂不用于轻量浏览器首轮。Gemma 4 E2B 含 embedding 共 5.1B 参数，不能按完整 2B 权重估算 |
| HY-MT 1.25-bit 直接浏览器部署 | 约 440 MB 很有吸引力，但配套原生运行路径不等于已有浏览器 WebGPU 路径；先保留为本机服务候选 |

补充来源：[Qwen-MT 接口限制](https://www.alibabacloud.com/help/en/model-studio/machine-translation)、[Chrome Translator API](https://developer.chrome.com/docs/ai/translator-api)、[Gemma 4 E2B 模型卡](https://huggingface.co/google/gemma-4-E2B-it)。

### 7.3 产品与接口要求

建议新增独立上下文释义服务，输入句子、目标词或短语、目标位置、可选前后文与可选词典参考，输出按位置绑定的短释义。参考义项不构成答案范围；允许返回新释义，也允许在上下文不足时返回无结果。

关键实现要求：

1. 有词典释义时先显示，再异步修正；没有时先只高亮，随后补充上下文释义，阅读不等待网络或模型加载。
2. 只处理视口附近内容，按句子或小段落合并请求；YouTube 用前后字幕补足上下文。
3. 从原文提取上下文时排除扩展注入的译文和界面文本，并保留跨 DOM 节点的句子内容。
4. 缓存键包含上下文、目标位置、目标语言和模型版本，不能只按词条缓存。
5. 对 `give up`、`account for` 等短语整体判断；同一句中的重复词按位置区分。
6. 校验输出格式、目标 ID 和长度；无效结果、超时或限流时保留已有词典释义，无词典释义时保持只高亮。不要用模型自报置信度直接判定正确。
7. 页面内容变化后丢弃旧结果，避免把旧句子的释义写到新内容中。
8. 云端使用用户自己的 Key，由扩展后台发送请求，并提供用量限制与失败回退。

现有 `shortenTranslation()` 默认截短至 6 字。上下文结果应在生成时要求简短，并处理超长结果；直接截断可能损害含义。

云端功能会发送网页句子。当前 README 与隐私政策强调网页文字在本地处理，启用此功能时应说明发送内容、服务提供方和开启条件，并同步更新相关声明。

## 8. 验证顺序与验收

先建立 50～100 条人工核对的真实样本，覆盖多义词、短语动词、技术文章、口语字幕、重复词、词形变化和跨节点句子。单独分组统计“词典完全无条目”“有条目但缺当前义”“已有正确候选义”，防止总体分数掩盖补义失败。

建议顺序：

1. 第一轮对照现有词典、Gemini、DeepSeek 和 DeepL；通用模型直接生成指定位置短释义，不强制从词典选答案。
2. 按错译、漏项、延迟、用量和隐私要求选出一个云端默认候选；质量接近时优先接入简单、实际成本可控的方案。
3. 需要离线时做独立验证页：HY-MT 作为专门翻译对照，Qwen3-0.6B 作为较轻的指令模型对照；随后视结果补测 Qwen3.5-0.8B。不要只测试模型加载。
4. 云端在桌面和 Edge Android 验证完整流程；本地模型先在实际桌面核显验证，再决定是否开展手机实验，通过后才接入正式阅读流程。

记录指标：分组词义正确率、词典外含义补全、短语处理、位置绑定、无效/漏项/超长输出比例、首个结果延迟、整批耗时、API 用量、模型下载量、加载时间、内存占用及设备持续运行表现。模型生成新义不代表正确，必须对照原句人工核验。

应使用人工核对的期望释义评估效果，不能仅凭接口返回成功或模型加载成功判定完成。目前所有候选均处于调研阶段。
