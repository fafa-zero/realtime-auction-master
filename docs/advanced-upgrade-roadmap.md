# 高阶升级路线：语音讲解、评论互动和防恶意竞拍

## 目标定位

当前项目已经具备基础实时竞拍能力。下一阶段可以把它升级成更完整的“AI 辅助直播竞拍平台”：

- 商家批量导入商品和竞拍规则。
- AI 生成主播讲解文案。
- Web 主播端控场，小程序买家端参与竞拍。
- 观众可以评论互动。
- 系统识别异常出价和恶意竞拍风险。
- 竞拍结束后生成订单和复盘。

本路线用于 5 月 29 日核心任务完成后的进一步升级，不要在基础登录、Excel 导入、商品队列、AI 文案展示没有跑通前过早开始。

## 推荐优先级

1. 观众评论互动。
2. 防恶意竞拍风控。
3. 语音讲解。

原因：

- 评论互动最能增强“直播感”，Web 和小程序都能明显看到效果。
- 风控能体现业务深度，让项目不只是界面演示。
- 语音讲解展示效果好，但可以先做浏览器本地朗读，不必一开始接复杂 TTS 服务。

## 1. 语音讲解功能

### 最小可用版本

先做 Web 主播端语音播放：

- AI 生成商品讲解文案后，Web 主播端显示“播放讲解”按钮。
- 使用浏览器 `SpeechSynthesis` 朗读讲解词。
- 支持暂停、继续、停止。
- 切换商品或竞拍结束时自动停止当前朗读。

优点：

- 不需要后端生成音频文件。
- 不需要额外云服务。
- 演示成本低，效果明显。

建议 commit：

```text
frontend: add ai script speech playback
```

### 升级版本

后续可以接 TTS：

- 后端把 AI 文案生成音频文件。
- 商品保存 `audioUrl`。
- Web 和小程序都播放同一段音频。
- 商家可以重新生成讲解词和语音。

新增字段建议：

```text
Product.aiScript
Product.aiScriptShort
Product.audioUrl
Product.audioGeneratedAt
```

新增接口建议：

```text
POST /api/products/:productId/ai-script
POST /api/products/:productId/ai-audio
```

暂时不要优先做真实 TTS，除非基础功能已经很稳定。

## 2. 观众评论互动

### 最小可用版本

做直播间评论区：

- 小程序买家可以发送评论。
- Web 主播端实时看到评论。
- Web 观众页也能看到评论。
- 后端保存最近 50 条评论。
- 评论通过 Socket.IO 广播。

评论类型：

```text
COMMENT      普通评论
QUICK        快捷互动
SYSTEM       系统消息
```

快捷互动建议：

```text
想看细节
能优惠吗
喜欢
还有库存吗
讲一下材质
```

后端数据结构建议：

```text
LiveComment {
  id: string
  liveRoomId: string
  userId: string
  nickname: string
  content: string
  type: "COMMENT" | "QUICK" | "SYSTEM"
  createdAt: number
}
```

接口和事件建议：

```text
GET  /api/live-rooms/:liveRoomId/comments
POST /api/live-rooms/:liveRoomId/comments

Socket.IO:
comment:new
comment:system
```

建议 commit：

```text
server: add live room comments
frontend: show live comments panel
miniprogram: add buyer comment input
```

### AI 评论增强

评论功能跑通后，再做 AI 主播回复建议：

- 根据最近评论和当前商品信息生成回复建议。
- Web 主播端显示“AI 回复建议”。
- 主播可以复制或一键发送成系统消息。

建议接口：

```text
POST /api/live-rooms/:liveRoomId/comments/ai-reply
```

建议 commit：

```text
server: generate ai comment reply suggestions
frontend: show ai comment reply suggestions
```

## 3. 防恶意竞拍风控

### 当前已有基础

项目已经具备一部分基础防护：

- `clientRequestId` 防重复提交。
- 出价状态校验：非竞拍中不能出价。
- 最低加价校验。
- 封顶价校验。
- 订单支付权限校验。

下一步要把这些规则产品化，让 Web 主播端能看到风险提示。

### 最小可用风控规则

先做规则引擎，不急着上复杂模型：

- 同一用户 10 秒内连续出价超过 5 次，标记为频繁出价。
- 单次出价跳变超过当前价的 50%，标记为异常加价。
- 临近结束 5 秒内突然封顶，标记为抢拍风险。
- 同一 `clientRequestId` 重复提交，标记为重复请求。
- 有未支付订单的用户继续高频出价，标记为支付风险。

风险等级：

```text
LOW
MEDIUM
HIGH
```

后端返回出价结果时附带：

```text
riskLevel
riskReasons
```

Web 主播端展示：

- 当前风险等级。
- 最近风险出价。
- 风险原因。
- 操作按钮：忽略、取消本场竞拍。

建议 commit：

```text
server: add bid risk scoring
frontend: show bid risk alerts
```

### AI 风控增强

规则风控跑通后，可以让 AI 生成风险解释：

示例：

```text
用户A在10秒内连续出价4次，并在临近结束时直接触达封顶价，建议主播关注是否存在恶意抬价。
```

接口建议：

```text
POST /api/live-rooms/:liveRoomId/risk-summary
```

建议 commit：

```text
server: generate ai bid risk summary
frontend: show ai risk summary
```

## 建议实施顺序

如果 5 月 29 日基础功能提前完成，按下面顺序继续：

1. `server: add live room comments`
2. `frontend: show live comments panel`
3. `miniprogram: add buyer comment input`
4. `server: add bid risk scoring`
5. `frontend: show bid risk alerts`
6. `frontend: add ai script speech playback`
7. `server: generate ai comment reply suggestions`
8. `server: generate ai bid risk summary`

## 验收标准

### 评论互动

- [ ] 小程序能发送评论。
- [ ] Web 主播端能实时看到评论。
- [ ] Web 观众页能实时看到评论。
- [ ] 刷新页面后能看到最近评论。
- [ ] 系统消息能和普通评论区分展示。

### 防恶意竞拍

- [ ] 高频出价会被标记。
- [ ] 异常加价会被标记。
- [ ] 临近结束封顶会被标记。
- [ ] Web 主播端能看到风险等级和原因。
- [ ] 风控不阻断正常出价，除非明确设计为拒绝。

### 语音讲解

- [ ] Web 主播端能播放 AI 讲解词。
- [ ] 可以停止播放。
- [ ] 切换商品或离开页面时不会继续播放旧讲解。
- [ ] 没有 AI 文案时按钮不可用或显示提示。

## 不建议优先做的内容

短期内先不要做：

- 真实语音合成云服务接入。
- 真实直播推流。
- 评论审核后台。
- 黑名单系统。
- 复杂账号注册和实名认证。
- 多商户隔离和真实权限体系。

这些内容工程量大，演示收益不如“评论互动 + 风控提示 + Web 语音朗读”直接。

## Git 规则

- 一个增强点一个 commit。
- 不要把评论、风控、语音混在同一个提交里。
- 后端接口、Web 展示、小程序展示分开提交。
- 提交前运行：

```bash
npm --workspaces run typecheck
```

- 涉及 Web 构建时运行：

```bash
npm --workspace apps/web run build
```

- 涉及小程序 JS 时运行对应 `node --check`。

建议提交前查看：

```bash
git --git-dir=.gitdata-local --work-tree=. status --short
```

