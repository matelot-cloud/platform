import { Module } from '@nestjs/common';
import { GraphService } from './graph.service';
import { LineageService } from './lineage.service';
import { RiskController } from './risk.controller';
import { RiskService } from './risk.service';

@Module({ controllers: [RiskController], providers: [RiskService, GraphService, LineageService], exports: [RiskService, GraphService, LineageService] })
export class RiskModule {}
