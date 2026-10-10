import { SetMetadata } from '@nestjs/common';

export const IS_PUBLIC_KEY = 'secops:public';
/** Marks a route as reachable without a bearer token (health checks only). */
export const Public = () => SetMetadata(IS_PUBLIC_KEY, true);
