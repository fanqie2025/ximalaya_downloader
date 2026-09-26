import log4js from 'log4js'

log4js.configure({
    appenders: {
        // 加轮转：容器是无人值守长跑的，日志不封顶迟早把飞牛的盘写满
        file: {
            type: 'file',
            filename: 'logs/app.log',
            maxLogSize: 10 * 1024 * 1024,
            backups: 5,
            compress: true,
        },
        console: {type: 'console'}
    },
    categories: {
        default: {appenders: ['file', 'console'], level: 'info'}
    }
});

export const log = log4js.getLogger('app')