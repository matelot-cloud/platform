import { Controller, Get, Module } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { createServer, Server } from 'node:net';
import { listenWithRetry } from './listen';

@Controller() class PingController { @Get('ping') ping() { return { ok: true }; } }
@Module({ controllers: [PingController] }) class PingModule {}

const occupy = () => new Promise<{ server: Server; port: number }>((ok) => { const server = createServer(); server.listen(0, '127.0.0.1', () => ok({ server, port: (server.address() as { port: number }).port })); });

describe('listenWithRetry (dev restarts: the previous instance still holds the port)', () => {
  it('waits until the port is released, then serves', async () => {
    const { server, port } = await occupy(); // the old instance, still shutting down
    const app = await NestFactory.create(PingModule, { logger: false });
    const log: string[] = [];
    setTimeout(() => server.close(), 600); // released ~600 ms later
    const started = Date.now();
    await listenWithRetry(app, port, '127.0.0.1', { delayMs: 100, attempts: 50, log: (m) => log.push(m) });
    expect(Date.now() - started).toBeGreaterThanOrEqual(500);
    expect(await (await fetch(`http://127.0.0.1:${port}/ping`)).json()).toEqual({ ok: true });
    expect(log[0]).toMatch(/still held/);
    expect(log[1]).toMatch(/free after/);
    await app.close();
  });

  it('gives up after the attempts with the original EADDRINUSE; other errors are not retried', async () => {
    const { server, port } = await occupy();
    const app = await NestFactory.create(PingModule, { logger: false });
    await expect(listenWithRetry(app, port, '127.0.0.1', { delayMs: 20, attempts: 3 })).rejects.toMatchObject({ code: 'EADDRINUSE' });
    server.close();
    await app.close();
    let calls = 0;
    const failing = { listen: async () => { calls++; throw Object.assign(new Error('nope'), { code: 'EACCES' }); } };
    await expect(listenWithRetry(failing as never, 80, '0.0.0.0', { delayMs: 1 })).rejects.toMatchObject({ code: 'EACCES' });
    expect(calls).toBe(1);
  });
});
