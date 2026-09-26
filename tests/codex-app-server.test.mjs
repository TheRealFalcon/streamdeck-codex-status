import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { setImmediate } from 'node:timers/promises';
import { test } from 'node:test';
import ts from 'typescript';

const source = await readFile(new URL('../src/codex-app-server.ts', import.meta.url), 'utf8');
const { outputText } = ts.transpileModule(source, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022 },
});
const { CodexAppServer } = await import(`data:text/javascript;base64,${Buffer.from(outputText).toString('base64')}`);

function thread(id, status = { type: 'idle' }, parentThreadId = null) {
    return { id, status, parentThreadId, cwd: '/projects/example', createdAt: 1, updatedAt: 1, recencyAt: null };
}

async function setup(t, respond) {
    const requests = [];
    const sockets = [];
    const originalSocket = globalThis.WebSocket;
    const originalUrl = process.env.CODEX_APP_SERVER_URL;
    process.env.CODEX_APP_SERVER_URL = 'ws://fixture';
    t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
    class Socket extends EventTarget {
        static OPEN = 1;
        readyState = 1;
        constructor() {
            super();
            sockets.push(this);
            queueMicrotask(() => this.dispatchEvent(new Event('open')));
        }
        deliver(message) {
            this.dispatchEvent(new MessageEvent('message', { data: JSON.stringify(message) }));
        }
        send(data) {
            const message = JSON.parse(data);
            if (message.method === 'initialized') return;
            requests.push(message);
            const result = message.method === 'initialize' ? {} : respond(message, this);
            queueMicrotask(() => this.deliver({ id: message.id, result }));
        }
        close() {
            this.readyState = 3;
            this.dispatchEvent(new Event('close'));
        }
    }
    globalThis.WebSocket = Socket;
    t.after(() => {
        t.mock.timers.reset();
        globalThis.WebSocket = originalSocket;
        if (originalUrl === undefined) delete process.env.CODEX_APP_SERVER_URL;
        else process.env.CODEX_APP_SERVER_URL = originalUrl;
    });
    const client = new CodexAppServer();
    client.start();
    t.mock.timers.tick(100);
    await setImmediate();
    return { client, requests, sockets };
}

test('idle observer avoids history scans; lifecycle events update cached sessions without reads', async t => {
    const { client, requests, sockets } = await setup(t, message => {
        assert.equal(message.method, 'thread/loaded/list');
        return { data: [], nextCursor: null };
    });
    const socket = sockets[0];
    assert.deepEqual(client.sessions, []);
    t.mock.timers.tick(29_000);
    await setImmediate();
    assert.equal(requests.length, 2, 'no repeated requests while idle before reconciliation');
    socket.deliver({ method: 'thread/started', params: { thread: thread('new') } });
    socket.deliver({ method: 'thread/status/changed', params: { threadId: 'new', status: { type: 'active', activeFlags: ['waitingOnApproval'] } } });
    assert.equal(client.sessions[0].status, 'WAIT');
    assert.equal(client.sessions[0].project, 'example');
    assert.equal(requests.length, 2, 'known session updates use cached metadata');
    socket.deliver({ method: 'thread/closed', params: { threadId: 'new' } });
    assert.deepEqual(client.sessions, []);
    t.mock.timers.tick(1_000);
    await setImmediate();
    assert.equal(requests.length, 3, 'empty reconciliation makes only one request');
});

test('paginated snapshots preserve live waits and closures, exclude children, and recover missed events', async t => {
    let initial = true;
    const { client } = await setup(t, (message, socket) => {
        if (message.method === 'thread/loaded/list') {
            if (!initial) return { data: [], nextCursor: null };
            return message.params.cursor
                ? { data: ['child', 'closed'], nextCursor: null }
                : { data: ['worker'], nextCursor: 'next' };
        }
        assert.equal(message.method, 'thread/read');
        assert.equal(message.params.includeTurns, false);
        const id = message.params.threadId;
        if (id === 'worker') {
            // An approval request with a colliding ID must not consume the response.
            socket.deliver({ id: message.id, method: 'item/commandExecution/requestApproval', params: {} });
            socket.deliver({ method: 'thread/status/changed', params: { threadId: id, status: { type: 'active', activeFlags: ['waitingOnUserInput'] } } });
        }
        if (id === 'closed') {
            socket.deliver({ method: 'thread/closed', params: { threadId: id } });
        }
        return { thread: thread(id, { type: 'idle' }, id === 'child' ? 'worker' : null) };
    });
    assert.deepEqual(client.sessions.map(({ id, status }) => ({ id, status })), [{ id: 'worker', status: 'WAIT' }]);
    initial = false;
    t.mock.timers.tick(30_000);
    await setImmediate();
    assert.deepEqual(client.sessions, [], 'reconciliation removes a session whose close notification was missed');
});

test('unknown sessions are discovered promptly and reconnect refreshes server state', async t => {
    let loaded = [];
    const { client, sockets } = await setup(t, message => {
        if (message.method === 'thread/loaded/list') return { data: loaded, nextCursor: null };
        assert.equal(message.method, 'thread/read');
        return { thread: thread(message.params.threadId, { type: 'active' }) };
    });
    loaded = ['discovered'];
    sockets[0].deliver({ method: 'thread/status/changed', params: { threadId: 'discovered', status: { type: 'active' } } });
    await setImmediate();
    assert.equal(client.sessions[0].status, 'WORK');
    sockets[0].close();
    loaded = [];
    t.mock.timers.tick(5_000);
    await setImmediate();
    assert.equal(sockets.length, 2);
    assert.deepEqual(client.sessions, []);
});
