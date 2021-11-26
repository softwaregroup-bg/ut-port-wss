const http = require('http');
const { JWT } = require('jose');
const WebSocket = require('ws');
const {URL} = require('url');
module.exports = function wss({registerErrors}) {
    let currentId = Date.now();
    const id = () => {
        if (currentId === 1) currentId = Date.now(); // just in case
        return currentId--;
    };

    return class wss extends require('ut-port-script')(...arguments) {
        constructor(...params) {
            super(...params);
            this.httpServer = null;
            this.socketServers = {};
        }

        get defaults() {
            return {
                namespace: 'wss',
                rooms: [],
                pingInterval: 30000
            };
        }

        get schema() {
            return {
                type: 'object',
                properties: {
                    pingInterval: {
                        type: 'number'
                    },
                    server: {
                        type: 'object',
                        properties: {
                            port: {
                                type: 'number'
                            }
                        },
                        required: ['port'],
                        additionalProperties: false
                    },
                    rooms: {
                        type: 'array',
                        items: {
                            type: 'string'
                        }
                    }
                },
                required: ['server', 'rooms']
            };
        }

        init(...params) {
            Object.assign(this.errors, registerErrors(require('./errors')));

            this.httpServer = http.createServer();

            [].concat(this.config.namespace).forEach(namespace => {
                const wss = new WebSocket.Server({ noServer: true });
                this.config.rooms.forEach(room => { this.socketServers[`/wss/${namespace}/${room}`] = wss; });

                wss.on('connection', ws => {
                    ws.isAlive = true;
                    ws.on('pong', () => {
                        ws.isAlive = true;
                    });
                });
                const interval = setInterval(() => {
                    wss.clients.forEach(ws => {
                        if (ws.isAlive === false) return ws.terminate();
                        ws.isAlive = false;
                        ws.ping(() => {});
                    });
                }, this.config.pingInterval);

                wss.on('close', () => clearInterval(interval));
            });

            this.httpServer.on('upgrade', (request, socket, head) => {
                const destroy = err => {
                    this.log.error && this.log.error(this.errors[err]());
                    socket.destroy();
                };
                const {pathname, searchParams} = new URL(request.url, 'http://localhost');
                const wss = this.socketServers[pathname];
                if (!wss) return destroy('wss.invalidPath');

                const token = searchParams.get('access_token');

                if (!token) return destroy('wss.securityViolation');

                const auth = {};
                try {
                    const decoded = JWT.decode(token, {complete: true}).payload;
                    auth.actorId = decoded.sub;
                    auth.sessionId = decoded.ses;
                } catch (e) {
                    return destroy('wss.securityViolation');
                }

                wss.handleUpgrade(request, socket, head, ws => {
                    ws.auth = auth;
                    wss.emit('connection', ws, request);
                });
            });

            this.config.k8s = {
                ports: [].concat(this.config.namespace).map((namespace) => ({
                    name: 'http-' + namespace.replace(/\//, '-').toLowerCase(),
                    service: true,
                    ingress: this.config.rooms.map(room => ({
                        host: this.config.server.host,
                        ...this.config.server.host && {name: this.config.server.host.replace(/\./g, '-')},
                        path: `/wss/${namespace}/${room}`
                    })),
                    containerPort: this.config.server.port
                }))
            };
            return super.init(...params);
        }

        async start(...params) {
            const result = await super.start(...params);
            this.httpServer.listen(this.config.server);
            return result;
        }

        async stop(...params) {
            const result = await super.stop(...params);
            await Object
                .values(this.socketServers)
                .concat(this.httpServer)
                .reduce((promise, server) => {
                    return promise.then(new Promise(resolve => server.close(resolve)));
                }, Promise.resolve());
            return result;
        }

        handlers() {
            const send = (ws, method, params) => {
                return ws.send(JSON.stringify({
                    jsonrpc: '2.0',
                    id: id(),
                    method,
                    params
                }));
            };
            return []
                .concat(this.config.namespace)
                .filter(Boolean)
                .reduce((handlers, namespace) => {
                    return Object
                        .entries(this.socketServers)
                        .reduce((handlers, [path, wss]) => {
                            const room = path.slice(1);
                            const push = ({actorId, method, params}) => {
                                for (const ws of wss.clients) {
                                    if (ws.auth.actorId === actorId) {
                                        if (ws.readyState !== WebSocket.OPEN) break;
                                        // maybe implement ack
                                        return send(ws, method, params);
                                    }
                                }
                                throw this.errors['ws.clientNotConnected']();
                            };
                            return {
                                ...handlers,
                                [`${namespace}.${room}.list`]: () => {
                                    return Array.from(wss.clients)
                                        .filter(({readyState}) => readyState === WebSocket.OPEN)
                                        .map(({auth}) => auth.actorId);
                                },
                                [`${namespace}.${room}.push`]: ({actorId, method, params}) => {
                                    if (Array.isArray(actorId)) return actorId.map(actorId => push({actorId, method, params}));
                                    return push({actorId, method, params});
                                },
                                [`${namespace}.${room}.broadcast`]: ({method, params}) => {
                                    wss.clients.forEach(ws => {
                                        if (ws.readyState === WebSocket.OPEN) return send(ws, method, params);
                                    });
                                }
                            };
                        }, handlers);
                }, {});
        }
    };
};
