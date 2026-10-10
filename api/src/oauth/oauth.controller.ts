import { Body, Controller, Get, HttpCode, Post, Query, Req, Res } from '@nestjs/common';
import { ApiExcludeController, ApiTags } from '@nestjs/swagger';
import type { Request, Response } from 'express';
import type { AuthenticatedUser } from '../auth/authenticated-user';
import { CurrentUser } from '../auth/current-user.decorator';
import { Public } from '../auth/public.decorator';
import { OauthService, type OauthScope } from './oauth.service';

/** Discovery documents live at the origin root (RFC 8414 / RFC 9728), outside the api/v1 prefix. */
@ApiExcludeController()
@Controller({ path: '.well-known', host: undefined })
export class OauthWellKnownController {
  constructor(private readonly oauth: OauthService) {}
  @Public() @Get('oauth-authorization-server') server() { return this.oauth.metadata(); }
  @Public() @Get(['oauth-protected-resource', 'oauth-protected-resource/api/v1/mcp']) resource() { return this.oauth.protectedResource(); }
}

@ApiTags('oauth')
@Controller('oauth')
export class OauthController {
  constructor(private readonly oauth: OauthService) {}

  /** Dynamic client registration (RFC 7591): public clients with PKCE. */
  @Public() @Post('register') @HttpCode(201)
  register(@Body() body: Record<string, unknown>) { return this.oauth.register(body as never); }

  /** Browser entry point: validates the request and sends the user to the web consent page. */
  @Public() @Get('authorize')
  async authorize(@Query() q: Record<string, string>, @Res() res: Response) {
    const { consentUrl } = await this.oauth.authorizeRequest(q);
    res.redirect(302, consentUrl);
  }

  /** The web consent page (signed-in user) approves: returns the client redirect carrying the code. */
  @Post('approve')
  approve(@CurrentUser() user: AuthenticatedUser, @Body() body: { client_id: string; redirect_uri: string; scope: OauthScope; state?: string; code_challenge: string; resource?: string }) {
    return this.oauth.approve(user, body);
  }

  /** Token endpoint: authorization_code (+PKCE) and refresh_token, form-encoded or JSON. */
  @Public() @Post('token')
  async token(@Body() body: Record<string, string>, @Req() req: Request, @Res() res: Response) {
    try { res.setHeader('Cache-Control', 'no-store'); res.json(await this.oauth.token(body)); }
    catch (e) { const r = (e as { getResponse?: () => unknown }).getResponse?.() ?? { error: 'invalid_request' }; res.status(400).json(typeof r === 'object' ? r : { error: 'invalid_request', error_description: String(r) }); }
    void req;
  }

  @Public() @Post('revoke') @HttpCode(200)
  revoke(@Body() body: { token?: string }) { return this.oauth.revoke(body.token ?? ''); }
}
