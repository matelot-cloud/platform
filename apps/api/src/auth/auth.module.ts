import { Module } from '@nestjs/common';
import { PassportModule } from '@nestjs/passport';
import { IamModule } from '../iam/iam.module';
import { JwtStrategy } from './jwt.strategy';

@Module({
  imports: [PassportModule.register({ defaultStrategy: 'jwt' }), IamModule],
  providers: [JwtStrategy],
})
export class AuthModule {}
