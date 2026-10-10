import { Module } from '@nestjs/common';
import { PoliciesController } from './policies.controller';
import { PoliciesService } from './policies.service';
import { ExceptionsService } from './exceptions.service';

@Module({ controllers: [PoliciesController], providers: [PoliciesService, ExceptionsService], exports: [PoliciesService, ExceptionsService] })
export class PoliciesModule {}
