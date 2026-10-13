export interface RegistryInfo { available: boolean; host: string | null; convention?: string; login?: string | null; pathRule?: string; pathCommand?: string }
/** `matelot registry info`: the host, how to log in, what a repository must be called and why other names are refused. */
export function registryInfoText(info: RegistryInfo): string {
  if (!info.available || !info.host) return 'built-in registry: not configured on this cell (REGISTRY_HOST)';
  const lines = [
    `built-in registry: ${info.host}`,
    `login:             matelot registry login   (CI token: MATELOT_KEY_ID/MATELOT_SECRET; personal token: MATELOT_TOKEN or a stored matelot login)`,
    `image path:        ${info.host}/<workspace>/<team>/<project>/<service>:<tag>   (lower-case slugs of the service path)`,
    `environment path:  ${info.host}/<workspace>/<team>/<project>/<service>/<environment>:<tag>   = deployed to that environment`,
    `exact reference:   ${info.pathCommand ?? 'matelot registry path --service <serviceId> [--env <environmentId>]'}   (prints host + path: docker push "$(matelot registry path --service <serviceId>)":<tag>)`,
    `other names:       refused — docker push answers "insufficient_scope: authorization failed" for a repository that is not a service path the token may push to`,
  ];
  return lines.join('\n');
}

