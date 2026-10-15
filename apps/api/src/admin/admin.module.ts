import { Module } from '@nestjs/common';
import { IamModule } from '../iam/iam.module';
import { AdminController } from './admin.controller';

@Module({ imports: [IamModule], controllers: [AdminController] })
export class AdminModule {}
