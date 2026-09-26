FROM node:22-slim

# 容器时区跟宿主机一致，日志时间才看得懂
ENV TZ=Asia/Shanghai
RUN ln -snf /usr/share/zoneinfo/$TZ /etc/localtime && echo $TZ > /etc/timezone

WORKDIR /app

# 依赖不在 build 阶段装。
#
# 飞牛上的 npm 10.9.9 跑 `npm ci` 会以 "Exit handler never called!" 崩掉
# （不是内存问题，机器还有 5.5G 可用；换 `npm install` 也一样）。
# 改成在宿主机上先装好、build 时直接拷进来：
#
#   docker run --rm -v "$PWD":/app -w /app \
#     -e npm_config_registry=https://registry.npmmirror.com \
#     node:22-slim npm install --omit=dev --no-audit --no-fund
#
# 生产依赖全是纯 JS 包（唯一的原生模块是 dev 依赖 rollup 的 win32 包，
# --omit=dev 不会装），所以不存在跨平台二进制不兼容的问题。
# 注意 .dockerignore 里**不能**排除 node_modules，否则这一行拷不到东西。
COPY . .

CMD ["node", "scheduler.js"]
