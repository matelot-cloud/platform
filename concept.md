# AI Product Security, DevSecOps & Compliance Platform

The platform is a **complete B2B SaaS for Product Security, DevSecOps, Security Governance, and Compliance**, designed for companies that develop and commercialize software products, IoT solutions, embedded systems, or connected hardware.

The goal of the platform is to become the central operating system through which an organization manages:

* software product security;
* vulnerabilities;
* software components and SBOMs;
* security policies;
* risks;
* CI/CD security;
* remediation;
* audit evidence;
* compliance;
* incidents;
* access control;
* security automation;
* Agentic AI.

The platform combines:

**Product Security + DevSecOps + Vulnerability Management + Policy Management + Risk Management + Compliance Automation + Audit + Agentic AI + Distributed Security Execution.**

Instead of security and compliance data being scattered across GitHub, GitLab, Jira, SonarQube, Snyk, cloud platforms, Kubernetes, spreadsheets, documents, and consultants, the platform centralizes, correlates, evaluates, and continuously monitors the entire software security lifecycle.

---

# Platform Structure

The platform is organized hierarchically:

Organization
→ Workspaces / Namespaces
→ Teams
→ Projects
→ Services
→ Environments

Example:

ACME Organization

Payments Workspace
→ Backend Team
→ Payment API Project
→ Payment Service
→ Development / Staging / Production

IoT Workspace
→ Embedded Team
→ Gateway Project
→ Firmware Service
→ Testing / Production

Each workspace can contain multiple teams.

Each team can contain multiple developers.

Each project becomes an independent security and compliance context inside the platform.

A project can contain its own:

* repositories;
* pipelines;
* services;
* environments;
* infrastructure;
* cloud resources;
* containers;
* dependencies;
* SBOMs;
* vulnerabilities;
* policies;
* compliance controls;
* risks;
* incidents;
* evidence;
* remediation tasks;
* runners;
* AI context.

---

# Project-Centric Model

The **Project** is one of the main units of the platform.

When creating a project, the team can decide exactly what systems should be connected.

Example:

Payment API

Connected resources:

* GitHub repository;
* Jira project;
* Kubernetes namespace;
* AWS account;
* GitHub Actions pipeline;
* SonarQube project;
* container registry;
* security scanners.

The platform then understands that all these resources belong to the same technical and security context.

---

# Integrations

The platform connects to the systems already used by engineering and security teams.

## Source Code

* GitHub
* GitLab
* Bitbucket
* Azure DevOps

## Project Management

* Jira
* other issue and task management platforms

## CI/CD

* GitHub Actions
* GitLab CI/CD
* Azure Pipelines
* Jenkins
* other pipeline systems

## Cloud

* AWS
* Microsoft Azure
* GCP

## Infrastructure

* Kubernetes
* Docker
* container registries
* cloud environments

## Security

* SonarQube
* Snyk
* Trivy
* SAST tools
* SCA tools
* container scanners
* infrastructure security tools

## Identity

* Microsoft Entra ID
* Okta
* SAML
* OIDC
* SCIM
* MFA

## Notifications

* Slack
* Microsoft Teams
* email
* alerting platforms

---

# SaaS Control Plane

The SaaS platform acts as the **Control Plane**.

The Control Plane manages:

* organizations;
* workspaces;
* projects;
* users;
* RBAC;
* policies;
* compliance frameworks;
* vulnerabilities;
* risks;
* findings;
* remediation;
* dashboards;
* audit;
* Agentic AI;
* job scheduling;
* runner management.

The Control Plane does not necessarily execute all security workloads itself.

Execution can be delegated to distributed runners.

---

# Security Runners

The platform includes a **Runner architecture similar to GitLab Runner**.

Runners form the **Execution Plane** of the platform.

Architecture:

SaaS Control Plane
→ Job Scheduler
→ Runner
→ Security Execution
→ Results
→ SaaS Platform

Runners can execute security and compliance tasks close to the customer's code and infrastructure.

Examples of runner workloads:

* SBOM generation;
* dependency analysis;
* SCA;
* SAST;
* container scanning;
* secrets scanning;
* IaC scanning;
* Kubernetes checks;
* configuration analysis;
* policy evaluation;
* license checks;
* artifact scanning;
* custom security jobs.

---

# Managed Runners

The platform can provide cloud-hosted runners managed by us.

Example:

Developer Push
→ CI Pipeline
→ Platform Security Job
→ Managed Runner
→ Scan
→ Results returned to SaaS

Managed runners are ideal for:

* smaller companies;
* quick onboarding;
* public repositories;
* standard workloads;
* teams that do not want to manage runner infrastructure.

---

# Self-Hosted Runners

Enterprise customers can deploy runners inside their own environment.

Example:

Customer Network

GitLab
Kubernetes
Private Registry
Source Code
Internal Services

↓

Self-Hosted Security Runner

↓

Scan / SBOM / Policy Evaluation

↓

Security Results

↓

SaaS Control Plane

This means source code, container images, or internal artifacts do not necessarily need to leave the customer environment.

Only the required findings, metadata, evidence, and security results are sent back to the SaaS platform.

This is particularly important for:

* enterprise customers;
* regulated environments;
* private GitLab installations;
* restricted networks;
* sensitive intellectual property;
* internal container registries;
* air-gapped or highly controlled infrastructure.

---

# Runner Types

The platform can support multiple runner types:

### Cloud Runner

Managed entirely by the SaaS provider.

### Self-Hosted Runner

Installed by the customer on:

* VM;
* Docker;
* bare metal;
* private cloud.

### Kubernetes Runner

Runs workloads dynamically inside the customer's Kubernetes cluster.

### Ephemeral Runner

Created only when a security job starts.

Example:

Job received
→ Temporary execution environment created
→ Scan executed
→ Results uploaded
→ Environment destroyed

This improves isolation and reduces long-lived execution environments.

---

# Runner Pools

Enterprise organizations can create runner pools.

Example:

Production Security Pool

* security-runner-01
* security-runner-02
* security-runner-03
* security-runner-04

The platform scheduler sends each job to an available runner.

Runner pools can be associated with:

* organizations;
* workspaces;
* teams;
* projects;
* environments.

---

# Runner Tags

Runners can have tags or capabilities.

Example:

linux
docker
kubernetes
production
high-memory
embedded
security

A project can request a specific type of runner.

Example:

Payment API

Required Runner Tags:

* linux
* docker
* security

---

# Secure Runner Architecture

The AI should not directly control runners.

Instead:

Agentic AI
→ Platform Tool
→ RBAC
→ Policy Engine
→ Approval Check
→ Job Scheduler
→ Runner

This ensures that AI actions remain controlled and auditable.

The runner executes only jobs authorized by the platform.

---

# Product & Software Catalog

The platform builds a continuously updated catalog of the organization's software.

It can map:

Product
→ Service
→ Repository
→ Build
→ Release
→ Container
→ Dependency
→ Deployment
→ Cloud Resource
→ Environment

Example:

Payment Platform

* Payment API
* Payment Worker
* Payment Web
* PostgreSQL
* Redis
* Docker images
* Kubernetes deployments
* Git repositories
* production infrastructure

---

# Security Graph

One of the core platform components is a **Security / Product Graph**.

The graph represents the relationships between software, infrastructure, vulnerabilities, teams, and environments.

Example:

Product
→ Service
→ Repository
→ Build
→ Container
→ Library
→ Deployment
→ Production Environment

When a vulnerability appears, the graph can determine the actual impact.

Example:

CVE-X
→ OpenSSL 3.x
→ 14 repositories
→ 6 container images
→ 3 products
→ 2 production deployments

This allows the platform to answer:

“What is actually affected?”

rather than only:

“A vulnerable dependency exists.”

---

# SBOM Management

The platform automatically generates and maintains **Software Bills of Materials**.

For every product and release it can manage:

* components;
* versions;
* dependencies;
* transitive dependencies;
* licenses;
* vulnerabilities;
* SBOM history;
* component changes.

Example:

Product v1.0 → SBOM
Product v1.1 → SBOM
Product v1.2 → SBOM

This makes it possible to determine when a specific dependency was introduced, changed, or removed.

---

# Vulnerability Management

The platform continuously correlates software components with vulnerability intelligence.

For every vulnerability it can determine:

* affected component;
* affected version;
* affected repository;
* affected product;
* affected container image;
* affected deployment;
* affected environment;
* production exposure;
* responsible team;
* security severity;
* contextual risk;
* remediation status.

---

# Risk Engine

The platform does not rely only on CVSS.

Risk can include:

CVSS

* exploit availability
* active exploitation
* internet exposure
* production exposure
* business criticality
* customer impact
* number of affected assets
* environment
* compensating controls
* remediation status

Example:

Same CVE:

Development → Medium Risk

Production Internet-Facing → Critical Risk

---

# Security Policies

Organizations can define policies such as:

* no Critical CVEs in Production;
* SBOM required before release;
* mandatory security scanning;
* mandatory code review;
* branch protection required;
* approved dependencies only;
* approved licenses only;
* minimum test coverage;
* trusted container images only;
* mandatory MFA;
* mandatory encryption;
* required security controls.

Policies can exist at multiple levels:

Organization
→ Workspace
→ Team
→ Project

Policies can be inherited.

Example:

Organization Policy:

“No Critical vulnerabilities in Production.”

Payments Workspace:

“Every release requires an SBOM.”

Payment API Project:

“Minimum code coverage: 80%.”

---

# Policy-as-Code

Policies can also be evaluated automatically inside pipelines.

Example:

security policy-check

The result can be:

PASS

or:

FAIL

Policy violated:

SEC-PROD-001

Critical vulnerability detected in production artifact.

---

# Policy Exceptions

Teams can request controlled exceptions.

Example:

Vulnerability:

Critical CVE

Reason:

Vendor fix unavailable

Exception:

30 days

Approver:

Security Manager

The exception is:

* temporary;
* approved;
* documented;
* auditable;
* automatically re-evaluated.

---

# CI/CD Security & Compliance Gates

The platform can be used directly inside CI/CD pipelines similarly to SonarQube.

Example:

Developer Push
→ Build
→ Tests
→ Security Scan
→ SBOM Generation
→ Vulnerability Analysis
→ Policy Evaluation
→ Compliance Gate
→ PASS / FAIL
→ Deployment

Example result:

Payment API

Security Gate: FAILED

Policy:

SEC-PROD-001

Reason:

Critical vulnerability detected.

Deployment blocked.

Security therefore becomes part of software delivery rather than something checked after release.

---

# CLI

The platform can provide a CLI for developers and CI/CD systems.

Examples:

security scan

security sbom

security policy-check

security compliance-check

security project status

security vulnerabilities

security risk-check

The CLI can return non-zero exit codes and therefore block a pipeline.

---

# API, SDKs, and Webhooks

The platform can expose:

* REST APIs;
* GraphQL APIs;
* SDKs;
* webhooks;
* CLI;
* automation endpoints.

This allows integration with custom internal systems.

---

# Remediation Management

When a security issue is found:

Critical CVE
→ Identify affected project
→ Find project owner
→ Create remediation
→ Assign responsible team
→ Apply SLA
→ Track progress
→ New build
→ Rescan
→ Verify fix
→ Store evidence
→ Close finding

The platform can synchronize remediation tasks with Jira or other issue management systems.

---

# Security SLA Management

Organizations can define remediation timelines.

Example:

Critical → 24 hours
High → 7 days
Medium → 30 days
Low → 90 days

The platform tracks:

* deadlines;
* overdue findings;
* responsible teams;
* escalation;
* SLA compliance.

---

# Notifications & Escalation

Example escalation:

Day 0 → Developer
Day 2 → Team Lead
Day 5 → Security Team
Day 7 → CISO

Notifications can be delivered through:

* Slack;
* Teams;
* email;
* other alerting systems.

---

# RBAC

The platform includes enterprise-grade **Role-Based Access Control**.

Possible roles:

* Organization Admin
* Security Admin
* Compliance Officer
* CISO
* CTO
* Team Lead
* Product Security Engineer
* Developer
* Auditor
* External Consultant
* Read Only

Permissions can be scoped to:

Organization
→ Workspace
→ Team
→ Project
→ Service
→ Environment

---

# Enterprise Identity

Supported enterprise identity capabilities can include:

* SSO;
* SAML;
* OIDC;
* Entra ID;
* Okta;
* MFA;
* SCIM provisioning.

---

# Continuous Compliance

The platform continuously evaluates security and compliance posture.

Possible frameworks:

* CRA;
* NIS2;
* ISO 27001;
* SOC 2;
* DORA;
* PCI DSS;
* CIS;
* additional security frameworks.

---

# Compliance Mapping Engine

The same technical control or evidence can satisfy multiple requirements.

Example:

MFA Enabled

→ Internal Policy
→ ISO 27001
→ NIS2
→ SOC 2

This prevents the organization from repeatedly collecting the same evidence.

---

# Evidence Automation

Evidence can be collected automatically from:

* source control;
* CI/CD;
* cloud;
* Kubernetes;
* identity systems;
* security scanners;
* Jira;
* runner results;
* platform activity.

Example:

GitHub Branch Protection Enabled

→ Evidence recorded

→ linked to internal security policy

→ linked to compliance control

→ versioned

→ auditable

---

# Audit Management

Auditors can receive restricted access.

They can inspect:

* controls;
* policies;
* evidence;
* risks;
* vulnerabilities;
* exceptions;
* remediation history;
* compliance status;
* audit logs.

---

# Risk Register

The platform maintains a centralized risk register.

Risk states:

Open
Accepted
Mitigated
Transferred
Closed

Each risk can contain:

* description;
* impact;
* probability;
* owner;
* affected products;
* mitigation;
* evidence;
* review date;
* expiration date.

---

# Incident Management

The platform can manage security incidents through:

Detect
→ Investigate
→ Determine Impact
→ Assign
→ Contain
→ Remediate
→ Report
→ Preserve Evidence
→ Close

Each incident receives a complete timeline.

---

# CRA / NIS2 Reporting Support

For relevant incidents, the platform can centralize:

* affected product;
* product version;
* vulnerability;
* impact;
* timeline;
* affected deployments;
* affected customers;
* remediation;
* technical evidence.

The platform can prepare reporting drafts while an authorized user performs the final review and approval.

---

# Security Dashboards

Different users see different views.

## Developer

* My Projects
* My Vulnerabilities
* My Policy Violations
* My Tasks
* My Pipelines

## Team Lead

* Team Security Score
* Projects at Risk
* SLA Violations
* Open Vulnerabilities
* Remediation Status

## CISO / CTO

* Organization Security Score
* Critical Risks
* Compliance Readiness
* Policy Violations
* Open Incidents
* Mean Time to Remediate
* Security Trends
* Vulnerability Exposure

---

# Security Score

Projects, teams, and organizations can receive security scores based on:

* vulnerabilities;
* policy violations;
* risk exposure;
* remediation speed;
* incidents;
* compliance status;
* missing evidence;
* security baselines.

Example:

Payment API

Security Score: 86/100
Critical CVEs: 0
High CVEs: 3
Policy Violations: 2
Compliance Readiness: 92%

---

# Templates / Golden Projects

Organizations can create secure project templates.

Example:

Secure Java Microservice

Includes:

* Git policies;
* mandatory scans;
* SBOM;
* SAST;
* SCA;
* container scanning;
* required approvals;
* compliance baseline;
* default policies.

New teams can create projects using these templates.

---

# Security Baselines

Organizations can define mandatory security standards.

Every new project is automatically compared against the baseline.

---

# Asset Discovery

The platform can identify resources that exist but are not managed properly.

Examples:

* orphan repositories;
* unmanaged cloud resources;
* shadow services;
* unknown container images;
* unregistered applications.

---

# Multi-Tenant Architecture

The SaaS is multi-tenant.

Example:

Organization
→ Workspaces
→ Teams
→ Projects

Large enterprises can also use:

Parent Organization
→ Subsidiary A
→ Subsidiary B
→ Subsidiary C

Data remains isolated between tenants and organizational units.

---

# Consultant / MSSP Mode

Consultants and managed security providers can manage multiple customer organizations.

Example:

Security Provider

* Client A
* Client B
* Client C
* Client D

Each client's data remains isolated.

This allows the platform to be sold both directly to organizations and through cybersecurity partners.

---

# Agentic AI

A major component of the platform is a **24/7 Agentic AI Security & Compliance Consultant**.

The AI is not just a chatbot.

It follows the cycle:

Observe
→ Analyze
→ Recommend
→ Act
→ Verify
→ Report

For the initial architecture, the AI operates only through our platform.

It does not receive uncontrolled direct access to GitHub, cloud environments, or customer infrastructure.

Architecture:

External Systems
→ Platform Connectors / Runners
→ Platform Data
→ Platform APIs
→ Agentic AI
→ Controlled Platform Actions

---

# AI Internal Tool Layer

The AI can use platform tools such as:

get_projects()

get_project_details()

get_vulnerabilities()

analyze_vulnerability()

get_sbom()

compare_sboms()

evaluate_policy()

get_policy_violations()

get_compliance_status()

get_missing_controls()

get_risks()

get_incidents()

create_remediation_task()

generate_report()

collect_evidence()

get_security_score()

trigger_security_job()

search_platform_data()

---

# AI Security Consultant

Users can ask:

“What are our current critical risks?”

“Which products are affected by CVE-X?”

“Why did my pipeline fail?”

“What should we fix first?”

“Which projects are exposed in production?”

“What changed since yesterday?”

“Create remediation tasks for the critical findings.”

---

# AI Compliance Consultant

Users can ask:

“What are we missing for ISO 27001?”

“Which NIS2 controls are failing?”

“What evidence is missing?”

“Are we ready for a CRA review?”

“Prepare our audit evidence.”

---

# AI Support Agent

The platform can also provide 24/7 product support.

Examples:

“Why is my project not syncing?”

“Why did this runner fail?”

“Why did my security job fail?”

“How do I connect GitLab?”

“Why is my Security Score 72?”

“Which policy blocked my pipeline?”

The AI can inspect platform-level data and provide contextual support.

---

# AI + Runners

The AI can request platform actions that eventually result in runner jobs.

Example:

User:

“Rescan Payment API.”

Flow:

User
→ AI Agent
→ Platform Tool
→ RBAC Check
→ Policy Check
→ Job Created
→ Scheduler
→ Runner
→ Security Scan
→ Results
→ Platform
→ AI explains results

The AI does not directly execute arbitrary code on the runner.

---

# Proactive AI

The AI can also operate proactively.

Example:

New Critical CVE
→ Platform detects it
→ AI analyzes affected SBOMs
→ Security Graph identifies affected products
→ AI evaluates production exposure
→ AI creates remediation proposal
→ Team is notified
→ New scan is triggered after remediation
→ Fix is verified
→ Evidence is stored

---

# Specialized AI Agents

The platform can contain multiple specialized AI agents.

**Security Agent**
General security analysis.

**Vulnerability Agent**
CVE investigation and vulnerability prioritization.

**Product Security Agent**
Product impact analysis.

**Compliance Agent**
CRA, NIS2, ISO 27001, and other frameworks.

**Policy Agent**
Policy evaluation and explanation.

**Evidence Agent**
Evidence collection and organization.

**Remediation Agent**
Remediation planning and tracking.

**Incident Agent**
Incident handling.

**Audit Agent**
Audit preparation.

**Support Agent**
24/7 user support.

An AI Orchestrator coordinates these agents.

---

# AI + RBAC

The AI inherits the permissions of the current user.

Example:

Developer has access to:

Payments Workspace
→ Payment API

The AI cannot access:

IoT Workspace
→ Gateway Project

Flow:

User
→ Authentication
→ RBAC
→ AI Permissions
→ Platform Tools
→ Data

---

# AI Action Permissions

AI actions can be divided into levels.

## Automatic

* read vulnerabilities;
* inspect SBOM;
* analyze risks;
* evaluate policies;
* analyze compliance;
* generate recommendations.

## Controlled Write

Depending on permissions:

* create remediation;
* generate report;
* create risk;
* collect evidence;
* trigger approved scans.

## Human Approval Required

Examples:

* change organization-wide policy;
* accept major risk;
* override production gate;
* close critical incident;
* delete evidence;
* change compliance status;
* perform high-impact administrative actions.

---

# AI Audit Trail

Every AI action is recorded.

Example:

Agent: Vulnerability Agent
User: John Smith
Project: Payment API
Action: Trigger Security Scan
Reason: Critical CVE detected
Runner: security-runner-03
Timestamp: 10:41
Result: Success

---

# Internal MCP Layer

The platform can expose its own internal MCP Server.

Architecture:

AI Model
→ MCP
→ Platform Tools
→ RBAC
→ Policies
→ Approvals
→ Platform APIs
→ Job Scheduler / Platform Database

MCP is used only as a controlled interface to our platform capabilities.

---

# Model-Agnostic AI

The Agentic AI architecture should not depend on one model provider.

AI Gateway

→ OpenAI
→ Anthropic
→ other providers
→ private models
→ on-premise models

The internal tool interface remains stable regardless of the model.

---

# Complete Audit Trail

The platform records all important activity:

* authentication;
* RBAC changes;
* policy changes;
* vulnerability findings;
* risk changes;
* evidence;
* project configuration;
* compliance changes;
* policy exceptions;
* runner jobs;
* pipeline gates;
* AI actions;
* administrative activity.

Every important action can include:

Who
What
When
Where
Why
Before
After

---

# High-Level Architecture

The complete architecture becomes:

Organization
→ Workspaces
→ Teams
→ Projects
→ Services / Environments

↓

Integrations

GitHub / GitLab / Azure DevOps
AWS / Azure / GCP
Kubernetes / Docker
Jira / Security Tools

↓

SaaS Control Plane

Projects
RBAC
Policies
Security Graph
Risk Engine
Compliance Engine
Audit
Agentic AI

↓

Job Scheduler

↓

Managed Runners / Self-Hosted Runners / Kubernetes Runners

↓

SBOM
SAST
SCA
Container Scan
IaC Scan
Policy Evaluation
Security Checks

↓

Security Findings

↓

Vulnerability Management
Risk Analysis
Remediation
Evidence
Compliance
Audit

↓

Agentic AI

Analyze
Recommend
Act
Verify
Support

---

# Final Product Vision

The platform is not simply:

* a vulnerability scanner;
* a compliance checklist;
* a CRA tool;
* an SBOM generator;
* an AI chatbot;
* a pipeline scanner;
* a policy engine.

It becomes a **Security & Compliance Operating System for modern software organizations**.

The complete lifecycle is:

**Code
→ Build
→ Runner
→ Security Scan
→ SBOM
→ Vulnerabilities
→ Risk
→ Policies
→ Security Gate
→ Remediation
→ Evidence
→ Compliance
→ Audit
→ Agentic AI**

Everything is connected inside a single platform.

## In Short

**The platform is a B2B SaaS Security & Compliance Operating System that connects to a company's development and infrastructure ecosystem, organizes teams into workspaces and projects, maintains a software and asset inventory, generates SBOMs, detects and prioritizes vulnerabilities, enforces security policies directly in CI/CD, executes security workloads through managed or self-hosted runners, manages risks and remediation, automates compliance evidence and audits, provides enterprise-grade RBAC and governance, and includes a 24/7 Agentic AI consultant that analyzes platform data, assists users, recommends actions, triggers controlled operations, and continuously helps improve the organization's security and compliance posture.**

The product vision can be summarized as:

**Code → Build → Security Execution → Risk → Compliance → Remediation → Audit → AI Automation**

All in one platform.
