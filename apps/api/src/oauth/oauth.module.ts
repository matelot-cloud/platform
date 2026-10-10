import { Module } from '@nestjs/common';
import { OauthController, OauthWellKnownController } from './oauth.controller';
import { OauthService } from './oauth.service';

@Module({ controllers: [OauthController, OauthWellKnownController], providers: [OauthService], exports: [OauthService] })
export class OauthModule {}
