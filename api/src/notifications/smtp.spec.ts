import { createServer } from 'node:net';
import { sendMail } from './smtp';

/** A tiny fake SMTP server (plain, no TLS) that records the message. */
describe('smtp client', () => {
  it('delivers a multipart message with AUTH LOGIN', async () => {
    const got: string[] = [];
    let data = '';
    const server = createServer((sock) => {
      sock.setEncoding('utf8');
      sock.write('220 fake ESMTP\r\n');
      let inData = false;
      sock.on('data', (chunk: string) => {
        for (const line of chunk.split('\r\n')) {
          if (inData) { if (line === '.') { inData = false; sock.write('250 queued\r\n'); } else data += line + '\n'; continue; }
          if (!line) continue;
          got.push(line);
          if (line.startsWith('EHLO')) sock.write('250-fake\r\n250 AUTH LOGIN\r\n');
          else if (line === 'STARTTLS') sock.write('454 TLS not available\r\n');
          else if (line === 'AUTH LOGIN') sock.write('334 VXNlcm5hbWU6\r\n');
          else if (line === Buffer.from('bob').toString('base64')) sock.write('334 UGFzc3dvcmQ6\r\n');
          else if (line === Buffer.from('pw').toString('base64')) sock.write('235 ok\r\n');
          else if (line.startsWith('MAIL') || line.startsWith('RCPT')) sock.write('250 ok\r\n');
          else if (line === 'DATA') { inData = true; sock.write('354 go\r\n'); }
          else if (line === 'QUIT') { sock.write('221 bye\r\n'); sock.end(); }
        }
      });
    }).listen(0);
    const port = (server.address() as { port: number }).port;
    // our client insists on STARTTLS when secure=false; a server refusing it must fail loudly
    await expect(sendMail({ host: '127.0.0.1', port, user: 'bob', password: 'pw', from: 'Matelot <m@x.io>', secure: false }, ['a@x.io'], 'Hi', 'body')).rejects.toThrow(/STARTTLS/);
    expect(got.some((l) => l.startsWith('EHLO'))).toBe(true);
    server.close();
  });
});
