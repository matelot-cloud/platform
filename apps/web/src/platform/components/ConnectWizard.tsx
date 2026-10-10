import Label from "@/components/form/Label";
import { cloudKindOf, KeylessIdentity } from "./KeylessIdentity";
import { Modal } from "@/components/ui/modal";
import { useCreateIntegration, useGithubInstallUrl, useLinkInstallation, useTestIntegration, useVerifyIntegration } from "@/platform/api/hooks";
import type { CreateIntegrationInput, IntegrationCreated, Provider, ScopeType } from "@/platform/api/types";
import { cn } from "@/utils";
import { useState, type FormEvent, type ReactNode } from "react";
import { CodeBlock } from "./CodeBlock";
import { BrandIcon, type BRAND_ICON } from "./EnvironmentManager";
import { ErrorNotice, inputClass, muted, outlineButton, primaryButton, SelectField } from "./ui";

export type ConnectKind = "github_app" | "github_own_app" | "github_deploy_key" | "deploy_key" | "github_token" | "gitlab" | "git" | "registry" | "ecr" | "acr" | "gar" | "jira" | "bitbucket" | "matelot";
type Kind = ConnectKind;
type Auth = "none" | "token" | "basic" | "ssh";

const textareaClass = "w-full rounded-lg border border-gray-300 bg-transparent px-4 py-2.5 font-mono text-xs text-gray-800 shadow-theme-xs focus:border-brand-300 focus:ring-3 focus:ring-brand-500/10 focus:outline-hidden dark:border-gray-700 dark:bg-gray-900 dark:text-white/90 dark:focus:border-brand-800";
const AUTH_LABEL: Record<Auth, string> = { none: "No authentication (public repository)", token: "Access token", basic: "Username and password", ssh: "SSH private key (deploy key)" };
const LEVEL_LABEL: Record<ScopeType, string> = { ORGANIZATION: "organization", WORKSPACE: "workspace", TEAM: "team", PROJECT: "project", SERVICE: "service", ENVIRONMENT: "environment" };

interface Choice {
  kind: Kind;
  title: string;
  text: string;
  badge?: string;
}

function Field({ label, hint, children, htmlFor }: { label: string; hint?: string; children: ReactNode; htmlFor?: string }) {
  return (
    <div>
      <Label htmlFor={htmlFor}>{label}</Label>
      {children}
      {hint && <p className={`mt-1.5 text-xs ${muted}`}>{hint}</p>}
    </div>
  );
}

/**
 * Connect a source at the given level: choose what → fill in → test → connect (→ install on GitHub).
 * Used from the project page (level = project) and the Integrations page (any level).
 */
export function ConnectWizard({ organizationId, scopeType, scopeId, scopeName, providers, onClose, initialKind }: { initialKind?: ConnectKind; organizationId: string; scopeType: ScopeType; scopeId: string; scopeName: string; providers: Provider[]; onClose: () => void }) {
  const github = providers.find((p) => p.provider === "github");
  const credentialStorage = providers.some((p) => p.provider !== "github" && p.available);
  const choices: Choice[] = [
    ...(github?.platformApp ? [{ kind: "github_app" as Kind, title: "GitHub — install the platform App", text: "One click: choose your GitHub organization and repositories. Webhooks included.", badge: "recommended" }] : []),
    ...(credentialStorage ? [{ kind: "github_own_app" as Kind, title: "GitHub — your organization's own App", text: "The App is the identity, owned by your organization, installed on the repositories you choose. Webhooks included. No personal token.", badge: github?.platformApp ? undefined : "recommended" }] : []),
    ...(credentialStorage ? [{ kind: "github_deploy_key" as Kind, title: "GitHub — deploy key for one repository", text: "The platform generates the key; you add the public half to the repository's deploy keys. Read-only, no user involved." }] : []),
    { kind: "gitlab", title: "GitLab — group or project token", text: "gitlab.com or self-managed. Use a group or project access token (scope read_api): not tied to a person." },
    { kind: "git", title: "Other git repository", text: "Bitbucket, Azure DevOps, Gitea, internal servers — one repository over HTTPS (repository/project token) or SSH (deploy key, generated here or your own)." },
    { kind: "github_token", title: "GitHub — personal access token", text: "Quick for a trial. Tied to the person who created it, so not for production use.", badge: "personal" },
    ...(scopeType !== "ORGANIZATION" && providers.find((p) => p.provider === "matelot")?.available ? [{ kind: "matelot" as Kind, title: "Matelot registry (built in)", text: `A registry namespace for this ${scopeType.toLowerCase()}: images of its services are scanned on push and promoted per environment. Nothing to configure, CI logs in with its CI token.` }] : []),
    ...(credentialStorage ? [{ kind: "registry" as Kind, title: "Container registry", text: "GHCR, Docker Hub, GitLab, Harbor or any v2 registry: lets the inventory read image tags and digests. Use a robot / deploy token." }] : []),
    ...(credentialStorage ? [{ kind: "ecr" as Kind, title: "AWS Elastic Container Registry", text: "An IAM access key with ecr:GetAuthorizationToken and pull rights. The platform exchanges it for 12-hour Docker tokens; the key never leaves the cell." }] : []),
    ...(credentialStorage ? [{ kind: "gar" as Kind, title: "Google Artifact Registry / GCR", text: "Service-account key exchanged for 1-hour tokens; also used for CI logins." }] : []),
    ...(credentialStorage ? [{ kind: "bitbucket" as Kind, title: "Bitbucket Cloud", text: "All repositories of a workspace. Username + app password (or x-token-auth + workspace access token). Clones, tags and issues." }] : []),
    ...(credentialStorage ? [{ kind: "jira" as Kind, title: "Jira Cloud — issue tracking", text: "Remediation opens Jira issues with severity, component, fix and SLA. Atlassian e-mail + API token." }] : []),
    ...(credentialStorage ? [{ kind: "acr" as Kind, title: "Azure Container Registry", text: "A service principal (tenant, client id, secret) with AcrPull. The platform exchanges it for short-lived ACR tokens; the secret never leaves the cell." }] : []),
  ];

  const [step, setStep] = useState<"choose" | "form" | "deploy-key" | "done">(initialKind && initialKind !== "github_app" ? "form" : "choose");
  const [deployKeyMode, setDeployKeyMode] = useState(initialKind === "github_deploy_key");
  const verify = useVerifyIntegration(organizationId);
  const [kind, setKind] = useState<Kind | null>(initialKind && initialKind !== "github_app" ? (initialKind === "github_deploy_key" ? "git" : initialKind) : null);
  const [created, setCreated] = useState<IntegrationCreated | null>(null);
  const [testResult, setTestResult] = useState<string | null>(null);

  const [name, setName] = useState("");
  const [baseUrl, setBaseUrl] = useState("");
  const [owner, setOwner] = useState("");
  const [saJson, setSaJson] = useState("");
  // Keyless (workload identity federation): the cloud trusts this cell's OIDC issuer; nothing secret is stored.
  const [keyless, setKeyless] = useState(false);
  const [wifProvider, setWifProvider] = useState("");
  const [wifServiceAccount, setWifServiceAccount] = useState("");
  const [wifRoleArn, setWifRoleArn] = useState("");
  const [repositoryUrl, setRepositoryUrl] = useState(initialKind === "github_deploy_key" ? "git@github.com:" : "");
  const [auth, setAuth] = useState<Auth>(initialKind === "github_deploy_key" ? "ssh" : initialKind === "jira" || initialKind === "bitbucket" ? "basic" : "token");
  const [token, setToken] = useState("");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [privateKey, setPrivateKey] = useState("");
  const [appId, setAppId] = useState("");
  const [slug, setSlug] = useState("");
  const [webhookSecret, setWebhookSecret] = useState("");
  const [awsAccountId, setAwsAccountId] = useState("");
  const [awsRegion, setAwsRegion] = useState("eu-central-1");
  const [awsKeyId, setAwsKeyId] = useState("");
  const [awsSecret, setAwsSecret] = useState("");
  const [acrName, setAcrName] = useState("");
  const [azTenant, setAzTenant] = useState("");
  const [azClient, setAzClient] = useState("");
  const [azSecret, setAzSecret] = useState("");

  const test = useTestIntegration(organizationId);
  const create = useCreateIntegration(organizationId);
  const installPlatform = useGithubInstallUrl();

  const authChoices: Auth[] = kind === "git" ? ["none", "token", "basic", "ssh"] : kind === "registry" ? ["basic", "token", "none"] : kind === "jira" || kind === "bitbucket" ? ["basic"] : ["token"];
  const effectiveAuth: Auth = authChoices.includes(auth) ? auth : authChoices[0]!;
  const isSsh = /^(ssh:\/\/|[^@\s]+@[^:\s]+:)/.test(repositoryUrl);

  const input = (): CreateIntegrationInput => {
    if (kind === "github_own_app") return { scopeType, scopeId, provider: "github", name, baseUrl: baseUrl || undefined, auth: { type: "app", appId, slug: slug || undefined, privateKey, webhookSecret: webhookSecret || undefined } };
    if (kind === "ecr") return { scopeType, scopeId, provider: "registry", name: name || `ECR · ${awsAccountId} · ${awsRegion}`, baseUrl: `${awsAccountId}.dkr.ecr.${awsRegion}.amazonaws.com`, auth: keyless ? { type: "aws_wif", roleArn: wifRoleArn, region: awsRegion } : { type: "aws", accessKeyId: awsKeyId, secretAccessKey: awsSecret, region: awsRegion } };
    if (kind === "matelot") return { scopeType, scopeId, provider: "matelot", name: name || `Matelot registry · ${scopeName}`, auth: { type: "none" } };
    if (kind === "gar") return { scopeType, scopeId, provider: "registry", name: name || `Artifact Registry · ${baseUrl.replace(/^https?:\/\//, "")}`, baseUrl: baseUrl.replace(/^https?:\/\//, "").replace(/\/.*$/, "") || "europe-docker.pkg.dev", auth: keyless ? { type: "gcp_wif", provider: wifProvider, serviceAccount: wifServiceAccount } : { type: "gcp", serviceAccountJson: saJson } };
    if (kind === "acr") return { scopeType, scopeId, provider: "registry", name: name || `ACR · ${acrName}`, baseUrl: `${acrName.replace(/\.azurecr\.io$/, "")}.azurecr.io`, auth: keyless ? { type: "azure_wif", tenantId: azTenant, clientId: azClient } : { type: "azure", tenantId: azTenant, clientId: azClient, clientSecret: azSecret } };
    return {
      scopeType,
      scopeId,
      provider: kind === "github_token" ? "github_token" : kind === "gitlab" ? "gitlab" : kind === "registry" ? "registry" : kind === "jira" ? "jira" : kind === "bitbucket" ? "bitbucket" : "git",
      name: name || (kind === "git" ? repositoryUrl : choices.find((c) => c.kind === kind)?.title ?? "Connection"),
      baseUrl: baseUrl || undefined,
      owner: owner || undefined,
      repositoryUrl: kind === "git" ? repositoryUrl : undefined,
      auth: { type: effectiveAuth, token: token || undefined, username: username || undefined, password: password || undefined, privateKey: privateKey || undefined },
    };
  };

  const brandOf = (k: Kind): keyof typeof BRAND_ICON => (k.startsWith("github") ? "github" : k === "gitlab" ? "gitlab" : k === "registry" ? "docker" : k === "ecr" ? "ecr" : k === "acr" ? "acr" : k === "gar" ? "gar" : k === "matelot" ? "matelot" : k === "jira" ? "jira" : k === "bitbucket" ? "bitbucket" : "git");

  const choose = (c: Kind) => {
    if (c === "github_app") {
      installPlatform.mutate({ organizationId, scopeType, scopeId }, { onSuccess: ({ url }) => window.location.assign(url) });
      return;
    }
    if (c === "github_deploy_key") {
      setKind("git");
      setAuth("ssh");
      setDeployKeyMode(true);
      setRepositoryUrl("git@github.com:");
      setTestResult(null);
      setStep("form");
      return;
    }
    setDeployKeyMode(false);
    setKind(c);
    setTestResult(null);
    setStep("form");
  };

  const generatedKey = kind === "git" && effectiveAuth === "ssh" && (deployKeyMode || !privateKey.trim());

  const submit = (e: FormEvent) => {
    e.preventDefault();
    const body = input();
    if (generatedKey) body.auth = { type: "ssh", generateKey: true };
    create.mutate(body, {
      onSuccess: (result) => {
        setCreated(result);
        setStep(result.publicKey ? "deploy-key" : "done");
      },
    });
  };

  const webhookUrl = created ? `${window.location.origin}/api/v1/webhooks/github/${created.id}` : "";
  const isPrivateHost = /^(localhost|127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|\[::1\]|.*\.local)$/i.test(window.location.hostname) || /^(localhost|127\.|10\.|192\.168\.)/.test(window.location.hostname);
  const link = useLinkInstallation(organizationId);

  return (
    <Modal isOpen onClose={onClose} className="max-w-190 p-6 lg:p-10">
      <h4 className="mb-1 text-lg font-semibold text-gray-800 dark:text-white/90">Connect a source</h4>
      <p className={`mb-6 text-sm ${muted}`}>
        For the {LEVEL_LABEL[scopeType]} <strong className="text-gray-800 dark:text-white/90">{scopeName}</strong>{scopeType !== "PROJECT" ? " and everything below it" : ""}. Credentials are stored encrypted; code stays where it is.
        {scopeType === "PROJECT" && <> If your organization already connected GitHub, you don't need this — attach repositories from a service instead.</>}
      </p>

      {step === "choose" && (
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          {choices.map((c) => (
            <button key={c.kind} type="button" onClick={() => choose(c.kind)} className="flex gap-3 rounded-2xl border border-gray-200 p-4 text-start transition hover:border-brand-300 hover:bg-brand-50/40 dark:border-gray-800 dark:hover:border-brand-500/40 dark:hover:bg-brand-500/5">
              <BrandIcon name={brandOf(c.kind)} className="mt-0.5 size-8" />
              <span className="min-w-0 flex-1">
              <div className="flex items-center justify-between gap-2">
                <span className="text-sm font-medium text-gray-800 dark:text-white/90">{c.title.replace(/^(GitHub|GitLab) — /, "")}</span>
                {c.badge && <span className={c.badge === "personal" ? "rounded-full bg-warning-50 px-2 py-0.5 text-theme-xs font-medium text-warning-600 dark:bg-warning-500/15 dark:text-orange-400" : "rounded-full bg-success-50 px-2 py-0.5 text-theme-xs font-medium text-success-600 dark:bg-success-500/15 dark:text-success-500"}>{c.badge}</span>}
              </div>
              <p className={`mt-1 text-xs ${muted}`}>{c.text}</p>
              </span>
            </button>
          ))}
          {installPlatform.error ? <div className="sm:col-span-2"><ErrorNotice error={installPlatform.error} /></div> : null}
          {!credentialStorage && <p className={`text-xs ${muted} sm:col-span-2`}>Token, password and SSH connections need credential storage (CELL_ENCRYPTION_KEY) on this cell.</p>}
        </div>
      )}

      {step === "form" && kind && (
        <form onSubmit={submit} className="space-y-5">
          <p className="flex items-center gap-2 text-sm font-medium text-gray-800 dark:text-white/90"><BrandIcon name={brandOf(deployKeyMode ? "github_deploy_key" : kind)} /> {choices.find((c) => c.kind === (deployKeyMode ? "github_deploy_key" : kind))?.title}</p>

          {kind === "github_own_app" && (
            <>
              <div className="rounded-xl bg-gray-50 p-4 text-xs text-gray-700 dark:bg-white/3 dark:text-gray-400">
                <p className="font-medium text-gray-800 dark:text-white/90">Create the App in your GitHub organization first</p>
                <ol className="mt-1 list-decimal space-y-1 ps-4">
                  <li>Organization → Settings → Developer settings → GitHub Apps → New GitHub App. One App per Matelot environment (dev with a tunnel, staging, prod): an App has a single webhook URL and separate keys limit the blast radius.</li>
                  <li><strong>Redirect URI</strong> (GitHub's name for the callback) and <strong>Setup URL</strong>, both: <code>{window.location.origin}/api/v1/integrations/github/callback</code>; tick "Redirect on update". Leave "Request user authorization (OAuth) during installation", "Enable Device Flow" and wildcard matching unchecked.</li>
                  <li><strong>Webhook</strong>: Active, URL shown after this step (it is different from the Setup URL: the browser is sent to the Setup URL, GitHub's servers POST to the webhook URL), secret = what you enter below. Events can only be ticked once the webhook is active: push, repository, installation, installation repositories.</li>
                  <li><strong>Repository permissions</strong>: Metadata read, Contents read, Administration read, Issues read & write. <strong>Organization permission</strong>: Projects read & write (to add issues to a board).</li>
                  <li>"Where can this App be installed": "Only on this account" means it installs only on the owning organization and GitHub skips the account picker.</li>
                  <li>Generate a private key; note the App ID. The slug (github.com/apps/&lt;slug&gt;) is read from GitHub on connect, you only need it as a hint.</li>
                </ol>
              </div>
              <Field label="Name" htmlFor="w-name"><input id="w-name" className={inputClass} placeholder="GitHub App · ACME" value={name} onChange={(e) => setName(e.target.value)} /></Field>
              <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                <Field label="App ID" htmlFor="w-appid"><input id="w-appid" required className={inputClass} value={appId} onChange={(e) => setAppId(e.target.value)} /></Field>
                <Field label="App slug (optional hint)" htmlFor="w-slug" hint="read from GitHub on connect; a mismatch is reported"><input id="w-slug" className={inputClass} value={slug} onChange={(e) => setSlug(e.target.value)} /></Field>
              </div>
              <Field label="Private key (.pem)" htmlFor="w-key"><textarea id="w-key" required rows={6} className={textareaClass} placeholder="-----BEGIN RSA PRIVATE KEY-----" value={privateKey} onChange={(e) => setPrivateKey(e.target.value)} /></Field>
              <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                <Field label="Webhook secret (optional)" htmlFor="w-secret"><input id="w-secret" type="password" autoComplete="off" className={inputClass} value={webhookSecret} onChange={(e) => setWebhookSecret(e.target.value)} /></Field>
                <Field label="GitHub Enterprise API URL (optional)" htmlFor="w-ghe"><input id="w-ghe" className={inputClass} placeholder="https://ghe.example.com/api/v3" value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} /></Field>
              </div>
            </>
          )}

          {kind === "github_token" && (
            <>
              <Field label="Name" htmlFor="w-name"><input id="w-name" className={inputClass} placeholder="GitHub · acme-org" value={name} onChange={(e) => setName(e.target.value)} /></Field>
              <Field label="Organization or user (optional)" htmlFor="w-owner" hint="Limits the inventory; leave empty for everything the token can read."><input id="w-owner" className={inputClass} placeholder="acme-org" value={owner} onChange={(e) => setOwner(e.target.value)} /></Field>
              <Field label="Fine-grained token" htmlFor="w-token" hint="Repository permissions: Metadata read, Contents read, Administration read, Issues read & write. Organization permission Projects read & write for boards."><input id="w-token" type="password" required autoComplete="off" className={inputClass} value={token} onChange={(e) => setToken(e.target.value)} /></Field>
            </>
          )}

          {kind === "gitlab" && (
            <>
              <Field label="Name" htmlFor="w-name"><input id="w-name" className={inputClass} placeholder="GitLab · payments" value={name} onChange={(e) => setName(e.target.value)} /></Field>
              <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                <Field label="GitLab URL" htmlFor="w-base" hint="Leave empty for gitlab.com"><input id="w-base" className={inputClass} placeholder="https://gitlab.example.com" value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} /></Field>
                <Field label="Group path (optional)" htmlFor="w-group" hint="Includes subgroups"><input id="w-group" className={inputClass} placeholder="payments/backend" value={owner} onChange={(e) => setOwner(e.target.value)} /></Field>
              </div>
              <Field label="Access token" htmlFor="w-token" hint="Group or project access token with scope read_api (Group/Project → Settings → Access tokens). Personal tokens work but are tied to a person."><input id="w-token" type="password" required autoComplete="off" className={inputClass} value={token} onChange={(e) => setToken(e.target.value)} /></Field>
            </>
          )}

          {kind === "ecr" && (
            <>
              <KeylessToggle checked={keyless} onChange={setKeyless} />
              <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                <Field label="AWS account id" htmlFor="w-aws-acc" hint="12 digits — the registry is <account>.dkr.ecr.<region>.amazonaws.com"><input id="w-aws-acc" required pattern="[0-9]{12}" className={inputClass} placeholder="123456789012" value={awsAccountId} onChange={(e) => setAwsAccountId(e.target.value.trim())} /></Field>
                <Field label="Region" htmlFor="w-aws-region"><input id="w-aws-region" required className={inputClass} placeholder="eu-central-1" value={awsRegion} onChange={(e) => setAwsRegion(e.target.value.trim())} /></Field>
                {!keyless && (<Field label="Access key id" htmlFor="w-aws-key" hint="IAM key with ecr:GetAuthorizationToken, BatchGetImage, GetDownloadUrlForLayer, ListImages, DescribeImages, DescribeRepositories (+ CreateRepository to create repositories from here, + push actions for CI pushes)"><input id="w-aws-key" required className={inputClass} placeholder="AKIA…" value={awsKeyId} onChange={(e) => setAwsKeyId(e.target.value.trim())} /></Field>)}
                {!keyless && (<Field label="Secret access key" htmlFor="w-aws-secret"><input id="w-aws-secret" type="password" required autoComplete="off" className={inputClass} value={awsSecret} onChange={(e) => setAwsSecret(e.target.value)} /></Field>)}
                {keyless && <Field label="IAM role ARN" htmlFor="w-wif-role" hint="role whose trust policy accepts this cell (Manage → Identity shows the exact policy after connecting)"><input id="w-wif-role" required className={inputClass} placeholder="arn:aws:iam::123456789012:role/matelot-ecr" value={wifRoleArn} onChange={(e) => setWifRoleArn(e.target.value)} /></Field>}
              </div>
              <Field label="Name" htmlFor="w-name"><input id="w-name" className={inputClass} placeholder="ECR · production" value={name} onChange={(e) => setName(e.target.value)} /></Field>
            </>
          )}
          {kind === "acr" && (
            <>
              <KeylessToggle checked={keyless} onChange={setKeyless} />
              <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                <Field label="Registry name" htmlFor="w-acr" hint="the part before .azurecr.io"><input id="w-acr" required className={inputClass} placeholder="acmeregistry" value={acrName} onChange={(e) => setAcrName(e.target.value.trim())} /></Field>
                <Field label="Tenant id" htmlFor="w-az-tenant"><input id="w-az-tenant" required className={inputClass} placeholder="00000000-0000-…" value={azTenant} onChange={(e) => setAzTenant(e.target.value.trim())} /></Field>
                <Field label="Client (application) id" htmlFor="w-az-client" hint="service principal with the AcrPull role on the registry (AcrPush if the platform should push)"><input id="w-az-client" required className={inputClass} value={azClient} onChange={(e) => setAzClient(e.target.value.trim())} /></Field>
                {!keyless && (<Field label="Client secret" htmlFor="w-az-secret"><input id="w-az-secret" type="password" required autoComplete="off" className={inputClass} value={azSecret} onChange={(e) => setAzSecret(e.target.value)} /></Field>)}
              </div>
              <Field label="Name" htmlFor="w-name"><input id="w-name" className={inputClass} placeholder="ACR · acmeregistry" value={name} onChange={(e) => setName(e.target.value)} /></Field>
            </>
          )}
          {kind === "matelot" && (
            <>
              <div className="rounded-xl bg-gray-50 p-4 text-sm text-gray-700 dark:bg-white/3 dark:text-gray-400">
                <p className="font-medium text-gray-800 dark:text-white/90">Built-in registry for {scopeType.toLowerCase()} {scopeName}</p>
                <p className="mt-1 text-xs">Nothing to configure: images of every service below this level live under <code>&lt;host&gt;/{scopeType === "PROJECT" ? "<workspace>/<team>/<project>" : scopeType === "TEAM" ? "<workspace>/<team>" : "<workspace>"}/…/&lt;service&gt;</code>, are scanned on every push and promoted per environment (<code>…/&lt;service&gt;/&lt;environment&gt;</code>). CI logs in with its CI token, people with a personal token — no registry passwords.</p>
                {scopeType === "ORGANIZATION" && <p className="mt-2 text-xs font-medium text-warning-600">Choose a workspace, team or project in "Connect at": registry namespaces start at the workspace.</p>}
              </div>
              <Field label="Name (optional)" htmlFor="w-name"><input id="w-name" className={inputClass} placeholder={`Matelot registry · ${scopeName}`} value={name} onChange={(e) => setName(e.target.value)} /></Field>
            </>
          )}
          {kind === "gar" && (
            <>
              <KeylessToggle checked={keyless} onChange={setKeyless} />
              <Field label="Registry host" htmlFor="w-gar" hint="Artifact Registry: <region>-docker.pkg.dev (europe-west3-docker.pkg.dev, us-docker.pkg.dev…); legacy Container Registry: gcr.io / eu.gcr.io"><input id="w-gar" required className={inputClass} placeholder="europe-west3-docker.pkg.dev" value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} /></Field>
              {!keyless && (<Field label="Service-account key (JSON)" htmlFor="w-sa" hint="IAM → Service accounts → Keys → Add key (JSON). Roles: Artifact Registry Reader (Writer if the platform pushes). The key is stored encrypted and exchanged for 1-hour tokens. Key creation blocked? New Google Cloud organizations enforce the policy iam.disableServiceAccountKeyCreation (and iam.managed.disableServiceAccountKeyCreation): an Organization Policy Administrator can override it for this one project (IAM → Organization policies → the constraint → Override parent → Off), create the key, then re-enable it."><textarea id="w-sa" required rows={6} className={`${inputClass} font-mono text-xs`} placeholder='{"type": "service_account", "project_id": "...", "client_email": "...", "private_key": "-----BEGIN PRIVATE KEY-----..."}' value={saJson} onChange={(e) => setSaJson(e.target.value)} /></Field>)}
              {keyless && (<div className="grid grid-cols-1 gap-4"><Field label="Workload identity provider" htmlFor="w-wif-provider" hint="projects/NUMBER/locations/global/workloadIdentityPools/POOL/providers/PROVIDER"><input id="w-wif-provider" required className={inputClass} value={wifProvider} onChange={(e) => setWifProvider(e.target.value)} /></Field><Field label="Service account to impersonate" htmlFor="w-wif-sa" hint="needs roles/iam.workloadIdentityUser for this cell's principal and Artifact Registry Reader/Writer"><input id="w-wif-sa" required className={inputClass} placeholder="puller@project.iam.gserviceaccount.com" value={wifServiceAccount} onChange={(e) => setWifServiceAccount(e.target.value)} /></Field></div>)}
              <Field label="Name" htmlFor="w-name"><input id="w-name" className={inputClass} placeholder="Artifact Registry · acme-prod" value={name} onChange={(e) => setName(e.target.value)} /></Field>
            </>
          )}
          {kind === "bitbucket" && (
            <>
              <Field label="Workspace" htmlFor="w-owner" hint="The Bitbucket workspace id (the part after bitbucket.org/). All its repositories are listed."><input id="w-owner" required className={inputClass} placeholder="acme" value={owner} onChange={(e) => setOwner(e.target.value)} /></Field>
              <Field label="Name" htmlFor="w-name"><input id="w-name" className={inputClass} placeholder="Bitbucket · acme" value={name} onChange={(e) => setName(e.target.value)} /></Field>
              <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                <Field label="Username" htmlFor="w-user" hint="Bitbucket username (not e-mail), or x-token-auth for an access token"><input id="w-user" required className={inputClass} value={username} onChange={(e) => setUsername(e.target.value)} /></Field>
                <Field label="App password / access token" htmlFor="w-pass" hint="Permissions: repository read, pull requests read, issues write"><input id="w-pass" type="password" required autoComplete="off" className={inputClass} value={password} onChange={(e) => setPassword(e.target.value)} /></Field>
              </div>
            </>
          )}
          {kind === "jira" && (
            <>
              <Field label="Jira site" htmlFor="w-jira" hint="Jira Cloud site URL. Issues are created in the project key set under Remediation → SLAs & issues (or per call)."><input id="w-jira" required className={inputClass} placeholder="https://acme.atlassian.net" value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} /></Field>
              <Field label="Name" htmlFor="w-name"><input id="w-name" className={inputClass} placeholder="Jira · acme" value={name} onChange={(e) => setName(e.target.value)} /></Field>
              <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                <Field label="Atlassian account e-mail" htmlFor="w-user"><input id="w-user" required type="email" className={inputClass} value={username} onChange={(e) => setUsername(e.target.value)} /></Field>
                <Field label="API token" htmlFor="w-pass" hint="id.atlassian.com → Security → API tokens"><input id="w-pass" type="password" required autoComplete="off" className={inputClass} value={password} onChange={(e) => setPassword(e.target.value)} /></Field>
              </div>
            </>
          )}
          {kind === "registry" && (
            <>
              <Field label="Registry host" htmlFor="w-reg" hint="ghcr.io · registry-1.docker.io · registry.gitlab.com · harbor.example.com"><input id="w-reg" required className={inputClass} placeholder="ghcr.io" value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} /></Field>
              <Field label="Name" htmlFor="w-name"><input id="w-name" className={inputClass} placeholder="GHCR · acme" value={name} onChange={(e) => setName(e.target.value)} /></Field>
              <Field label="Authentication">
                <SelectField value={effectiveAuth} onChange={(v) => setAuth(v as Auth)} options={authChoices.map((a) => ({ value: a, label: a === "basic" ? "Username and password / robot token" : a === "token" ? "Token (username optional)" : "Public registry" }))} />
              </Field>
              {effectiveAuth === "basic" && (
                <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                  <Field label="Username" htmlFor="w-user"><input id="w-user" required className={inputClass} value={username} onChange={(e) => setUsername(e.target.value)} /></Field>
                  <Field label="Password / token" htmlFor="w-pass"><input id="w-pass" type="password" required autoComplete="off" className={inputClass} value={password} onChange={(e) => setPassword(e.target.value)} /></Field>
                </div>
              )}
              {effectiveAuth === "token" && (
                <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                  <Field label="Token" htmlFor="w-token"><input id="w-token" type="password" required autoComplete="off" className={inputClass} value={token} onChange={(e) => setToken(e.target.value)} /></Field>
                  <Field label="Username (optional)" htmlFor="w-tuser" hint="GHCR: your GitHub user; GitLab: any"><input id="w-tuser" className={inputClass} value={username} onChange={(e) => setUsername(e.target.value)} /></Field>
                </div>
              )}
            </>
          )}

          {kind === "git" && (
            <>
              <Field label="Repository URL" htmlFor="w-url" hint="HTTPS or SSH: https://host/group/repo.git or git@host:group/repo.git"><input id="w-url" required className={inputClass} value={repositoryUrl} onChange={(e) => setRepositoryUrl(e.target.value)} /></Field>
              <Field label="Name (optional)" htmlFor="w-name"><input id="w-name" className={inputClass} placeholder="Bitbucket · payment-api" value={name} onChange={(e) => setName(e.target.value)} /></Field>
              <Field label="Authentication">
                <SelectField value={effectiveAuth} onChange={(v) => setAuth(v as Auth)} options={authChoices.map((a) => ({ value: a, label: AUTH_LABEL[a] }))} />
                {isSsh && effectiveAuth !== "ssh" && effectiveAuth !== "none" && <p className="mt-1.5 text-xs text-warning-600">SSH URLs authenticate with an SSH key.</p>}
              </Field>
              {effectiveAuth === "token" && (
                <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                  <Field label="Token" htmlFor="w-token"><input id="w-token" type="password" required autoComplete="off" className={inputClass} value={token} onChange={(e) => setToken(e.target.value)} /></Field>
                  <Field label="Token username (optional)" htmlFor="w-tuser" hint="Some hosts need it (Azure DevOps: any value, Bitbucket: your username)"><input id="w-tuser" className={inputClass} value={username} onChange={(e) => setUsername(e.target.value)} /></Field>
                </div>
              )}
              {effectiveAuth === "basic" && (
                <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                  <Field label="Username" htmlFor="w-user"><input id="w-user" required className={inputClass} value={username} onChange={(e) => setUsername(e.target.value)} /></Field>
                  <Field label="Password" htmlFor="w-pass"><input id="w-pass" type="password" required autoComplete="off" className={inputClass} value={password} onChange={(e) => setPassword(e.target.value)} /></Field>
                </div>
              )}
              {effectiveAuth === "ssh" && (
                <div className="rounded-xl bg-gray-50 p-4 text-sm text-gray-700 dark:bg-white/3 dark:text-gray-400">
                  <p className="font-medium text-gray-800 dark:text-white/90">The platform will generate the deploy key for you.</p>
                  <p className={`mt-1 text-xs ${muted}`}>Click <em>Generate key</em>; the next screen shows the public key to add to the repository. The private key never leaves this cell.</p>
                  {!deployKeyMode && (
                    <details className="mt-3">
                      <summary className="cursor-pointer text-xs text-brand-500">I already have a private key</summary>
                      <textarea rows={5} className={`${textareaClass} mt-2`} placeholder="-----BEGIN OPENSSH PRIVATE KEY-----" value={privateKey} onChange={(e) => setPrivateKey(e.target.value)} />
                    </details>
                  )}
                </div>
              )}
            </>
          )}

          {keyless && (kind === "ecr" || kind === "gar" || kind === "acr") && <p className={`text-xs ${muted}`}>Keyless connections are checked after they are created: the cloud trusts the exact subject <code>integration:&lt;connection id&gt;</code>, which is assigned when you connect. The next step shows the trust to configure and a Verify button.</p>}
          {testResult && <div className="rounded-xl border border-success-500/30 bg-success-50 px-4 py-3 text-sm text-success-600 dark:bg-success-500/15 dark:text-success-500">Connection works: {testResult}</div>}
          {test.error ? <ErrorNotice error={test.error} /> : null}
          {create.error ? <ErrorNotice error={create.error} /> : null}

          <div className="flex flex-wrap items-center justify-between gap-3 pt-2">
            <button type="button" className={outlineButton} onClick={() => setStep("choose")}>Back</button>
            <div className="flex gap-3">
              {!generatedKey && !(keyless && (kind === "ecr" || kind === "gar" || kind === "acr")) && <button type="button" className={outlineButton} disabled={test.isPending} onClick={() => test.mutate(input(), { onSuccess: (r) => setTestResult(r.account) })}>{test.isPending ? "Testing…" : "Test connection"}</button>}
              <button type="submit" className={cn(primaryButton)} disabled={create.isPending || (kind === "git" && !repositoryUrl.trim())}>{create.isPending ? "Working…" : kind === "github_own_app" ? "Register App" : generatedKey ? "Generate key" : "Connect"}</button>
            </div>
          </div>
        </form>
      )}

      {step === "deploy-key" && created?.publicKey && (
        <div className="space-y-5">
          <div className="rounded-xl bg-gray-50 p-4 text-sm text-gray-700 dark:bg-white/3 dark:text-gray-400">
            <p className="font-medium text-gray-800 dark:text-white/90">1. Add this public key to the repository</p>
            <p className={`mt-1 text-xs ${muted}`}>GitHub: repository → Settings → Deploy keys → Add deploy key (read-only). GitLab: Settings → Repository → Deploy keys. Bitbucket: Repository settings → Access keys.</p>
            <textarea readOnly rows={4} className={`${textareaClass} mt-2`} value={created.publicKey} onFocus={(e) => e.currentTarget.select()} />
            <div className="mt-2 flex items-center justify-between gap-3">
              <span className={`text-xs ${muted}`}>Fingerprint {created.fingerprint}</span>
              <button type="button" className={outlineButton} onClick={() => void navigator.clipboard?.writeText(created.publicKey!)}>Copy key</button>
            </div>
            <p className="mt-4 font-medium text-gray-800 dark:text-white/90">2. Test the connection</p>
            <p className={`text-xs ${muted}`}>Once the key is on the repository, click <em>Test connection</em>. You can also close this and test later from the connections table.</p>
          </div>
          {verify.error ? <ErrorNotice error={verify.error} /> : null}
          <div className="flex justify-end gap-3">
            <button type="button" className={outlineButton} onClick={onClose}>Later</button>
            <button type="button" className={primaryButton} disabled={verify.isPending} onClick={() => verify.mutate(created.id, { onSuccess: () => { setCreated({ ...created, publicKey: undefined }); setStep("done"); } })}>{verify.isPending ? "Testing…" : "Test connection"}</button>
          </div>
        </div>
      )}

      {step === "done" && created && (
        <div className="space-y-5">
          {created.installUrl ? (
            <>
              <div className="rounded-xl border border-success-500/30 bg-success-50 px-4 py-3 text-sm text-success-600 dark:bg-success-500/15 dark:text-success-500">{created.externalAccountId ? "App registered and linked to its existing installation." : "App registered. Two things left:"}</div>
              {(created.warnings ?? []).map((w) => <p key={w} className="rounded-xl border border-warning-500/30 bg-warning-50 px-4 py-2 text-xs text-warning-700 dark:bg-warning-500/10 dark:text-warning-400">{w}</p>)}
              {(created.missingPermissions ?? []).length > 0 && <div className="rounded-xl border border-warning-500/30 bg-warning-50 px-4 py-3 text-xs text-warning-700 dark:bg-warning-500/10 dark:text-warning-400"><p className="font-medium">The installation is missing permissions:</p><ul className="mt-1 list-disc ps-4">{created.missingPermissions!.map((m) => <li key={m.key}>{m.key} ({m.level}) — {m.why}</li>)}</ul><p className="mt-1">Add them in the App settings, then accept the request on GitHub under Organization → Settings → GitHub Apps → this App, then "Check again" in Manage.</p></div>}
              <div className="rounded-xl bg-gray-50 p-4 text-sm text-gray-700 dark:bg-white/3 dark:text-gray-400">
                <p className="font-medium text-gray-800 dark:text-white/90">1. Webhook URL — in the App settings (GitHub servers POST here)</p>
                <CodeBlock code={webhookUrl} lines={false} wrap className="mt-1" />
                <p className={`mt-1 text-xs ${muted}`}>With the webhook secret you entered. Pushes, repository changes and installation changes then arrive live.</p>
                {isPrivateHost && <p className="mt-2 rounded-lg border border-warning-500/30 bg-warning-50 px-3 py-2 text-xs text-warning-700 dark:bg-warning-500/10 dark:text-warning-400">GitHub cannot reach <code>{window.location.hostname}</code>. Either expose the platform through a tunnel (smee.io, ngrok, Tailscale Funnel) and use that host in the webhook URL, or click "Later": the connection then works without webhooks, with "Sync now" and periodic polling keeping repositories fresh.</p>}
                <p className="mt-3 font-medium text-gray-800 dark:text-white/90">Setup URL / Redirect URI — in the App settings (the browser is sent here)</p>
                <CodeBlock code={`${window.location.origin}/api/v1/integrations/github/callback`} lines={false} wrap className="mt-1" />
                {!created.externalAccountId && <><p className="mt-3 font-medium text-gray-800 dark:text-white/90">2. Install the App on your GitHub organization</p>
                <p className={`text-xs ${muted}`}>Choose the repositories; you come back here when done. Already installed? GitHub then opens the installation settings instead of coming back — use "Link existing installation".</p></>}
              </div>
              {link.error ? <ErrorNotice error={link.error} /> : null}
              <div className="flex justify-end gap-3">
                <button type="button" className={outlineButton} onClick={onClose}>Later</button>
                {!created.externalAccountId && <button type="button" className={outlineButton} disabled={link.isPending} onClick={() => link.mutate(created.id, { onSuccess: (r) => setCreated({ ...created, ...r }) })}>{link.isPending ? "Checking…" : "Link existing installation"}</button>}
                {!created.externalAccountId ? <button type="button" className={primaryButton} onClick={() => window.location.assign(created.installUrl!)}>Install on GitHub</button> : <button type="button" className={primaryButton} onClick={onClose}>Done</button>}
              </div>
            </>
          ) : created.keyless && cloudKindOf(created.provider, created.authType) ? (
            <>
              <p className={`text-sm ${muted}`}>Connection created — nothing secret stored. Configure this trust in your cloud for the exact subject below, then Verify. You can also close this and verify later under Manage → Identity.</p>
              <KeylessIdentity integrationId={created.id} organizationId={organizationId} cloudKind={cloudKindOf(created.provider, created.authType)!} keyless />
              <div className="flex justify-end">
                <button type="button" className={outlineButton} onClick={onClose}>Close</button>
              </div>
            </>
          ) : (
            <>
              <div className="rounded-xl border border-success-500/30 bg-success-50 px-4 py-3 text-sm text-success-600 dark:bg-success-500/15 dark:text-success-500">Connected. Repositories are being synced and will appear in a few seconds.</div>
              <p className={`text-sm ${muted}`}>Next: open a service and use <em>Attach repository</em> to link the repositories that build it.</p>
              <div className="flex justify-end">
                <button type="button" className={primaryButton} onClick={onClose}>Done</button>
              </div>
            </>
          )}
        </div>
      )}
    </Modal>
  );
}

/** Keyless switch shared by the cloud registry forms. */
function KeylessToggle({ checked, onChange }: { checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <label className="flex cursor-pointer items-start gap-3 rounded-xl border border-gray-200 p-3 text-sm dark:border-gray-800">
      <input type="checkbox" className="mt-0.5" checked={checked} onChange={(e) => onChange(e.target.checked)} />
      <span>
        <span className="font-medium text-gray-800 dark:text-white/90">Keyless — workload identity federation</span>
        <span className="block text-xs text-gray-500 dark:text-gray-400">No key or secret is stored. The cloud trusts this cell as an OpenID issuer; after connecting, Manage → Identity shows the issuer, subject and the exact steps. Works when your organization forbids long-lived keys.</span>
      </span>
    </label>
  );
}
