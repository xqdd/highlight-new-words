# 有道/欧路词典生词本网页高亮
chrome插件，根据有道词典导出的xml生词文件或有道和欧路网上的生词本，在网页中标出生词，达到单词加强记忆效果


# 快速使用
> 欧路词典步骤一致
### 1. 登录有道同步生词本
![](./images/getting-started/1_new.jpg '登录有道步骤1')
![](./images/getting-started/2_new.jpg '登录有道步骤2')
![](./images/getting-started/3_new.jpg '登录有道步骤3')


### 2. 刷新页面并使用
![](./images/getting-started/5.jpg '效果演示')



> <s># 为什么是有道词典
> 1. 有道老牌单词软件，用户量较多
> 2. 有道查词方便，支持快捷键呼出界面查词
> 3. 有道支持将查询过的单词自动加入生词本功能（不足的是中文也会自动加入）
> 4. 有道支持生词本导出功能
> 5. 有道支持自定义释义功能
> 6. 我在使用有道词典</s>

# 待加强功能
- [x] 鼠标悬浮提示单词意思
- [ ] <s>支持根据文件路径解析xml文件</s>
- [x] 校验文件类型
- [ ] <s>记忆xml导出路径，自动更新xml文件 </s>
- [x] 鼠标悬浮发音
- [x] 发音可配置（开关、语速、男女、种类等）
- [x] 提供多种高亮样式和自定义高亮样式
- [ ] <s>支持高亮短语</s>
- [x] 手动导入导出生词本确实不便，寻找后台自动导入的可能性
- [x] 拓展图标显示页面生词个数

# 鸣谢
- https://github.com/mechatroner/aided_reading
- http://iconfont.cn/
>待研究
>- https://github.com/waynecz/dadda-translate-crx
>- https://github.com/cclient/chrome-extensions-youdaowithwordnode
# 开发（v3）
基于 WXT + TypeScript + Vue 3 重写，架构、目录分工与契约见 [docs/architecture.md](./docs/architecture.md)。

```bash
npm install
npm run dev        # 开发模式
npm run build      # 构建到 .output/chrome-mv3（可用 OUT_DIR 覆盖输出根目录）
npm run typecheck && npm test
```
