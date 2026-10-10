import { Global, Module } from '@nestjs/common';
import { AccessService } from './access.service';
import { AuthorizationService } from './authorization.service';
import { ScopeResolverService } from './scope-resolver.service';

@Global()
@Module({
  providers: [ScopeResolverService, AccessService, AuthorizationService],
  exports: [ScopeResolverService, AccessService, AuthorizationService],
})
export class RbacModule {}
