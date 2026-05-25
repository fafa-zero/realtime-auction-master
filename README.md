# 实时竞拍大师

这是一个用于课程设计/毕业设计的直播电商实时竞拍 MVP 项目。

## 技术栈

- 前端：React + TypeScript + Vite
- 后端：Node.js + Express + Socket.IO
- 第一阶段存储：内存数据
- 后续扩展：MySQL / PostgreSQL + Redis

## 项目结构

```text
realtime-auction-master
├── apps
│   ├── server   后端 API 与 WebSocket 服务
│   └── web      前端页面
└── docs         项目文档
```

## 当前 MVP 功能

- 查看竞拍商品
- 启动竞拍
- 用户实时出价
- 广播当前最高价
- 结束前自动延时
- 达到封顶价自动成交
- 主播取消异常竞拍
- 成交后生成模拟订单

## 运行方式

安装依赖：

```bash
npm install
```

启动前后端：

```bash
npm run dev
```

默认地址：

- 前端：http://localhost:5173
- 后端：http://localhost:4000

## 演示流程

1. 打开前端页面。
2. 点击“开始/重开竞拍”。
3. 修改昵称和出价金额。
4. 点击出价，观察当前最高价和出价记录实时变化。
5. 在倒计时最后 10 秒内出价，观察自动延时。
6. 出价达到封顶价，观察自动成交和订单生成。
7. 点击“模拟支付”，观察订单状态变为已支付。

## 关键代码位置

- 后端入口：`apps/server/src/index.ts`
- 竞拍规则：`apps/server/src/store.ts`
- 前端页面：`apps/web/src/App.tsx`
- 页面样式：`apps/web/src/styles.css`

## 后续开发建议

第一阶段先跑通完整业务闭环，再逐步加入数据库、Redis、登录鉴权和更完整的管理后台。
