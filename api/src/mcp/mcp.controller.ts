import { Body, Controller, Delete, Get, HttpCode, Post, Req, Res } from '@nestjs/common';
import { ApiExcludeController } from '@nestjs/swagger';
import type { Request, Response } from 'express';
import { INSTRUCTIONS, McpService, type McpPrincipal } from './mcp.service';

const PROTOCOL = '2025-06-18';
const SUPPORTED = new Set(['2024-11-05', '2025-03-26', PROTOCOL]);

/**
 * MCP Streamable HTTP transport (stateless, JSON responses). Authenticated by the usual guards
 * (Bearer personal token or JWT); the same header is forwarded to the tool calls.
 */
@ApiExcludeController()
@Controller('mcp')
export class McpController {
  constructor(private readonly mcp: McpService) {}

  @Get()
  info(@Res() res: Response) {
    // No server-initiated stream: tell SSE-capable clients to use POST only.
    res.status(405).setHeader('Allow', 'POST, DELETE').json({ error: 'Use POST with JSON-RPC (stateless Streamable HTTP)' });
  }

  @Delete()
  @HttpCode(204)
  end() { /* stateless: nothing to close */ }

  @Post()
  async rpc(@Body() body: unknown, @Req() req: Request, @Res() res: Response) {
    const auth = req.headers.authorization;
    const messages = Array.isArray(body) ? body : [body];
    const scope = ((req as Request & { personalTokenScope?: string }).personalTokenScope ?? 'session') as 'read' | 'write' | 'sudo' | 'session';
    const needsPrincipal = messages.some((m: any) => m && m.id !== undefined && ['initialize', 'tools/list', 'tools/call'].includes(m.method));
    const principal = needsPrincipal ? await this.mcp.principal(auth, scope) : null;
    const responses: unknown[] = [];
    for (const m of messages as Record<string, any>[]) {
      if (!m || typeof m !== 'object' || m.jsonrpc !== '2.0') { responses.push({ jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Invalid request' } }); continue; }
      if (m.id === undefined) continue; // notification (initialized, cancelled, …)
      responses.push(await this.handle(m, auth, principal));
    }
    if (!responses.length) { res.status(202).end(); return; }
    res.status(200).setHeader('content-type', 'application/json').json(Array.isArray(body) ? responses : responses[0]);
  }

  private async handle(m: Record<string, any>, auth: string | undefined, principal: McpPrincipal | null) {
    const reply = (result: unknown) => ({ jsonrpc: '2.0', id: m.id, result });
    const fail = (code: number, message: string) => ({ jsonrpc: '2.0', id: m.id, error: { code, message } });
    switch (m.method) {
      case 'initialize': {
        const requested = String(m.params?.protocolVersion ?? PROTOCOL);
        return reply({ protocolVersion: SUPPORTED.has(requested) ? requested : PROTOCOL, capabilities: { tools: { listChanged: false } }, serverInfo: { name: 'matelot', version: '1.1.0' }, instructions: INSTRUCTIONS + this.mcp.identity(principal) });
      }
      case 'ping': return reply({});
      case 'tools/list': return reply({ tools: this.mcp.list(principal) });
      case 'tools/call': {
        const name = String(m.params?.name ?? '');
        const args = (m.params?.arguments ?? {}) as Record<string, unknown>;
        return reply(await this.mcp.call(name, args, auth, principal));
      }
      case 'resources/list': return reply({ resources: [] });
      case 'resources/templates/list': return reply({ resourceTemplates: [] });
      case 'prompts/list': return reply({ prompts: [] });
      case 'completion/complete': return reply({ completion: { values: [] } });
      default: return fail(-32601, `Method not found: ${m.method}`);
    }
  }
}
