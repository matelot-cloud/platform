import { Module } from '@nestjs/common';
import { MetaController } from './meta.controller';
import { VersionController } from './version.controller';

@Module({ controllers: [MetaController, VersionController] })
export class MetaModule {}
