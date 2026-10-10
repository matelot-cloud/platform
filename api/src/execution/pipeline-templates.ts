import type { JobType } from '../database/schema';

export interface StageDefinition {
  name: string;
  jobs: { name: string; type: JobType; payload?: Record<string, unknown> }[];
}

export interface PipelineTemplate {
  key: string;
  name: string;
  description: string;
  stages: StageDefinition[];
}

/**
 * Built-in pipeline definitions. Stages run in order; jobs inside a stage run in parallel.
 * Job types no runner implements yet are reported as "skipped" by the runner, so the security
 * pipeline is honest today and lights up as steps 04–06 ship the scanners.
 */
export const PIPELINE_TEMPLATES: PipelineTemplate[] = [
  {
    key: 'security',
    name: 'Security pipeline',
    description: 'Checkout, software bill of materials, then the scanners. The standard run for a service.',
    stages: [
      { name: 'source', jobs: [{ name: 'checkout', type: 'repository_check' }] },
      { name: 'inventory', jobs: [{ name: 'sbom', type: 'sbom', payload: { target: 'source' } }] },
      {
        name: 'scan',
        jobs: [
          { name: 'dependencies', type: 'sca' },
          { name: 'code', type: 'sast' },
          { name: 'secrets', type: 'secrets' },
          { name: 'infrastructure', type: 'iac' },
        ],
      },
      { name: 'policy', jobs: [{ name: 'evaluate', type: 'policy_eval' }] },
    ],
  },
  {
    key: 'checkout',
    name: 'Repository check',
    description: 'Only clones the repository through the configured credentials and reports what it found. Use it to validate a connection or a runner.',
    stages: [{ name: 'source', jobs: [{ name: 'checkout', type: 'repository_check' }] }],
  },
];

export const templateByKey = (key: string) => PIPELINE_TEMPLATES.find((t) => t.key === key);
