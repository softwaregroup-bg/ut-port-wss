const WebSocket = require('ws');
const { JWT, JWK } = require('jose');
const jwtPayload = {
    typ: 'Bearer',
    ses: 'f4279a1a-209c-4447-b0ed-53566737d51b'
};
const jwtKey = {
    crv: 'Ed25519',
    x: 'hhcGW1iHk_YWlNYDxn7P4PGV1N6mPjghBge4O7zterQ',
    d: 'KGpSfEzpbelEdQStQBlYmHPkHrG4cEcRx_yJZkRc_qY',
    kty: 'OKP',
    kid: 'kMfX1WoDc9dWVRugwGh9sSL956JS7yB8jE1ylo71Z-M',
    use: 'sig'
};
const jwtOptions = {
    subject: '1000',
    issuer: 'ut-login',
    audience: 'ut-bus',
    expiresIn: '900 seconds'
};
const jwt = JWT.sign(jwtPayload, JWK.asKey(jwtKey), jwtOptions);

require('ut-run').run({
    main: require('..'),
    method: 'unit',
    config: {
        wss: {
            server: {
                port: 8044
            },
            rooms: ['test']
        }
    },
    params: {
        steps: [
            {
                name: 'ws',
                async params(context) {
                    const ws = new WebSocket('ws://localhost:8044/wss/wss/test?access_token=' + jwt);
                    function heartbeat() {
                        clearTimeout(this.pingTimeout);
                        this.pingTimeout = setTimeout(() => {
                            this.terminate();
                        }, 31000);
                    }
                    ws.on('open', heartbeat);
                    ws.on('ping', heartbeat);
                    ws.on('close', function clear() {
                        clearTimeout(this.pingTimeout);
                    });
                    ws.on('message', data => {
                        context.notification = JSON.parse(data); // check in next step
                    });
                    return ws;
                },
                result(result, assert) {
                    assert.ok(result.url, 'ws');
                }
            },
            {
                name: 'serverPush',
                method: 'wss.test.push',
                params: {
                    actorId: jwtOptions.subject,
                    method: 'test',
                    params: {
                        test: true
                    }
                },
                result(result, assert) {
                    assert.ok(true, 'serverPush');
                }
            },
            {
                name: 'message',
                params(context) {
                    return new Promise((resolve, reject) => {
                        setTimeout(() => {
                            return context.notification ? resolve(context.notification) : reject(new Error('message not received'));
                        }, 3000);
                    });
                },
                result(result, assert) {
                    assert.ok(result.params.test, 'message');
                }
            }
        ]
    }
});
