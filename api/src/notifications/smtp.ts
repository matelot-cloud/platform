import { createConnection, Socket } from 'node:net';
import { connect as tlsConnect, TLSSocket } from 'node:tls';

export interface SmtpConfig { host: string; port: number; user?: string; password?: string; from: string; secure: boolean }

/** Minimal SMTP client (no dependency): implicit TLS (465) or STARTTLS (587/25), AUTH LOGIN, one message. */
export async function sendMail(cfg: SmtpConfig, to: string[], subject: string, text: string, html?: string): Promise<void> {
  let socket: Socket | TLSSocket = cfg.secure ? tlsConnect({ host: cfg.host, port: cfg.port, servername: cfg.host }) : createConnection({ host: cfg.host, port: cfg.port });
  let buffer = '';
  const waiters: ((line: string) => void)[] = [];
  const wire = (s: Socket | TLSSocket) => { s.setEncoding('utf8'); s.on('data', (d: string) => { buffer += d; let i; while ((i = buffer.indexOf('\r\n')) >= 0) { const line = buffer.slice(0, i); buffer = buffer.slice(i + 2); if (/^\d{3} /.test(line)) waiters.shift()?.(line); } }); };
  wire(socket);
  const read = () => new Promise<string>((resolve, reject) => { const t = setTimeout(() => reject(new Error('SMTP timeout')), 15_000); waiters.push((l) => { clearTimeout(t); resolve(l); }); });
  const send = async (cmd: string, ok = /^[23]\d\d/) => { socket.write(cmd + '\r\n'); const r = await read(); if (!ok.test(r)) throw new Error(`SMTP ${cmd.split(' ')[0]}: ${r}`); return r; };
  try {
    await new Promise<void>((resolve, reject) => { socket.once('connect', () => resolve()); socket.once('secureConnect', () => resolve()); socket.once('error', reject); });
    await read();
    await send(`EHLO matelot`);
    if (!cfg.secure) {
      await send('STARTTLS', /^220/);
      socket = tlsConnect({ socket, servername: cfg.host });
      wire(socket);
      await new Promise<void>((resolve, reject) => { (socket as TLSSocket).once('secureConnect', resolve); socket.once('error', reject); });
      await send('EHLO matelot');
    }
    if (cfg.user) {
      await send('AUTH LOGIN', /^334/);
      await send(Buffer.from(cfg.user).toString('base64'), /^334/);
      await send(Buffer.from(cfg.password ?? '').toString('base64'), /^235/);
    }
    await send(`MAIL FROM:<${cfg.from.replace(/^.*<|>.*$/g, '')}>`);
    for (const r of to) await send(`RCPT TO:<${r.trim()}>`);
    await send('DATA', /^354/);
    const boundary = `----matelot-${Date.now()}`;
    const headers = [`From: ${cfg.from}`, `To: ${to.join(', ')}`, `Subject: =?UTF-8?B?${Buffer.from(subject).toString('base64')}?=`, `Date: ${new Date().toUTCString()}`, `MIME-Version: 1.0`, `X-Mailer: Matelot`, `Content-Type: multipart/alternative; boundary="${boundary}"`];
    const body = [`--${boundary}`, 'Content-Type: text/plain; charset=UTF-8', 'Content-Transfer-Encoding: base64', '', Buffer.from(text).toString('base64'), `--${boundary}`, 'Content-Type: text/html; charset=UTF-8', 'Content-Transfer-Encoding: base64', '', Buffer.from(html ?? `<pre>${text.replace(/</g, '&lt;')}</pre>`).toString('base64'), `--${boundary}--`];
    socket.write([...headers, '', ...body].join('\r\n').replace(/\r\n\./g, '\r\n..') + '\r\n.\r\n');
    const r = await read();
    if (!/^250/.test(r)) throw new Error(`SMTP DATA: ${r}`);
    socket.write('QUIT\r\n');
  } finally {
    socket.destroy();
  }
}
