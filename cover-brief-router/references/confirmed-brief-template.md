# 已确认封面需求交接模板

第四轮用户确认后，将本模板填完保存到任务目录brief.md，交给选定的下游技能。所有路径用当前任务的真实路径，不套用示例人物或其他人的素材。

```yaml
status: confirmed
confirmation: 用户本次明确批准制作的答复摘要
source:
  kind: video / article / topic
  location: 用户提供的链接或文件
  verified_scope: 正文 / 字幕 / 页面介绍，按实际读取范围填写
visual:
  sample_id: 本轮展示编号
  sample_file: 实际例图路径
  style_name: 已选风格
  essential_anchors: 从例图和技能规范提取的3–5个关键视觉特征
text:
  title: 精确主标题
  subtitle: 没有则留空
  other_visible_text: 没有则为空列表
identity:
  mode: 无人物 / 用户照片 / 原视频人物 / 原创IP / 已确认IP
  subject: 需要出现的具体主体
  reference_files: 已确认的素材路径与每张角色
  forbidden: 不出现的人物或元素
outputs:
  - platform: 真正要发布的平台
    entry: 具体发布入口，未知则标明核实范围
    ratio: 已确认比例
    width: 已确认像素宽
    height: 已确认像素高
    count: 已确认张数
execution:
  skill_name: 选定下游技能
  skill_path: 检测结果中的真实目录
  backend: 当前实际可调用的图像或浏览器渲染能力
  output_directory: 当前任务输出目录
```

## 交接规则

- 如果内容读不到，不把页面简介标为完整视频理解。
- 下游默认的多张输出不替代已确认张数；不得默默增加独立锚点、三视图或其他交付，必要额外制作先说明。
- 不复问已选风格、已经确认的标题、发布平台与尺寸。
- 首次偏好配置仅补技术所需；不要为此偷偷改用户的长期默认值。
- 固定3:4的下游不能被模板强行变成任意比例；第四轮前解决路线与尺寸冲突。
- 不把未获授权的素材上传到外部服务；任务中明确要求使用的素材按当前环境的授权规则处理。
- 保存完整最终提示词；图片生成使用当前实际工具，不把提示词当成成图。
