#!/usr/bin/env node
/**
 * Unit tests for extract-observability.js.
 * Zero deps: run with `node extract-observability.test.js`.
 *
 * Synthesizes fixture repos in a temp dir, points the script at a generated
 * config.json, runs it, and asserts the emitted OBSERVABILITY draft has
 * the expected shape for each IaC type. Cleans up at the end.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const SCRIPT = path.join(__dirname, 'extract-observability.js');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'extract-observability-test-'));

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); console.log(`  ok  ${name}`); passed++; }
  catch (e) { console.error(`  FAIL ${name}\n       ${e.message}`); failed++; }
}
function assert(cond, msg) { if (!cond) throw new Error(msg || 'assertion failed'); }

function mkRepo(name, files) {
  const p = path.join(TMP, name);
  for (const [rel, content] of Object.entries(files)) {
    const fp = path.join(p, rel);
    fs.mkdirSync(path.dirname(fp), { recursive: true });
    fs.writeFileSync(fp, content);
  }
  return p;
}

function mkConfig(repos, services = {}, envs = ['prod', 'dev', 'local']) {
  const cfgPath = path.join(TMP, `config-${Math.random().toString(36).slice(2, 8)}.json`);
  fs.writeFileSync(cfgPath, JSON.stringify({
    workspace: { name: 'test', slug: 'test', envs },
    repos,
    services,
  }, null, 2));
  return cfgPath;
}

function run(configPath) {
  const r = spawnSync('node', [SCRIPT, configPath], { encoding: 'utf8' });
  return { exitCode: r.status, stdout: r.stdout || '', stderr: r.stderr || '', json: r.stdout ? JSON.parse(r.stdout) : null };
}

// ── CDK extractor ─────────────────────────────────────────────────────
test('CDK: explicit LogGroup with logGroupName', () => {
  const repo = mkRepo('cdk-loggroup', {
    'lib/payments-stack.ts': `
import * as logs from 'aws-cdk-lib/aws-logs';
export class PaymentsStack {
  constructor() {
    new logs.LogGroup(this, 'PaymentsLogs', {
      logGroupName: '/aws/ecs/payments-prod',
      retention: 30,
    });
  }
}
`,
  });
  const cfg = mkConfig(
    [{ name: 'infra', path: repo, type: 'cdk', role: 'infrastructure' }],
    { 'payments': {} }
  );
  const { exitCode, json } = run(cfg);
  assert(exitCode === 0, `exit ${exitCode}`);
  const row = json.log_destinations.find(r => r.log_group === '/aws/ecs/payments-prod');
  assert(row, 'expected /aws/ecs/payments-prod row');
  assert(row.service === 'payments', `wrong service: ${row.service}`);
  assert(row.env === 'prod', `wrong env: ${row.env}`);
  assert(row.type === 'cloudwatch');
  assert(row.source.startsWith('lib/payments-stack.ts:'), `wrong source: ${row.source}`);
});

test('CDK: lambda function expands to /aws/lambda/{name}', () => {
  const repo = mkRepo('cdk-lambda', {
    'lib/worker-stack.ts': `
import * as lambda from 'aws-cdk-lib/aws-lambda';
new lambda.Function(this, 'NotificationWorker', {
  functionName: 'notification-worker-prod',
  runtime: lambda.Runtime.NODEJS_20_X,
});
`,
  });
  const cfg = mkConfig(
    [{ name: 'infra', path: repo, type: 'cdk', role: 'infrastructure' }],
    { 'notification-worker': {} }
  );
  const { exitCode, json } = run(cfg);
  assert(exitCode === 0, `exit ${exitCode}`);
  const row = json.log_destinations.find(r => r.log_group === '/aws/lambda/notification-worker-prod');
  assert(row, 'expected lambda row');
  assert(row.service === 'notification-worker');
  assert(row.env === 'prod');
  assert(row.query.includes('aws logs tail'), 'query template missing');
});

// ── Terraform extractor ───────────────────────────────────────────────
test('Terraform: aws_cloudwatch_log_group resource', () => {
  const repo = mkRepo('tf-loggroup', {
    'main.tf': `
resource "aws_cloudwatch_log_group" "billing" {
  name = "/aws/ecs/billing-prod"
  retention_in_days = 14
}
`,
  });
  const cfg = mkConfig(
    [{ name: 'infra', path: repo, type: 'terraform', role: 'infrastructure' }],
    { 'billing': {} }
  );
  const { exitCode, json } = run(cfg);
  assert(exitCode === 0, `exit ${exitCode}`);
  const row = json.log_destinations.find(r => r.log_group === '/aws/ecs/billing-prod');
  assert(row, 'expected billing row');
  assert(row.type === 'cloudwatch');
  assert(row.env === 'prod');
});

test('Terraform: aws_lambda_function resource', () => {
  const repo = mkRepo('tf-lambda', {
    'lambda.tf': `
resource "aws_lambda_function" "ingestor" {
  function_name = "data-ingestor-prod"
  handler       = "index.handler"
}
`,
  });
  const cfg = mkConfig(
    [{ name: 'infra', path: repo, type: 'terraform', role: 'infrastructure' }],
    { 'data-ingestor': {} }
  );
  const { exitCode, json } = run(cfg);
  assert(exitCode === 0, `exit ${exitCode}`);
  const row = json.log_destinations.find(r => r.log_group === '/aws/lambda/data-ingestor-prod');
  assert(row, 'expected lambda row');
});

// ── Kubernetes extractor ──────────────────────────────────────────────
test('k8s: Deployment with namespace + labels', () => {
  const repo = mkRepo('k8s', {
    'manifests/bulk-uploader/deployment.yaml': `
apiVersion: apps/v1
kind: Deployment
metadata:
  name: bulk-uploader
  namespace: data
  labels:
    app: bulk-uploader
spec:
  replicas: 2
`,
  });
  const cfg = mkConfig(
    [{ name: 'infra', path: repo, type: 'k8s', role: 'infrastructure' }],
    { 'bulk-uploader': {} }
  );
  const { exitCode, json } = run(cfg);
  assert(exitCode === 0, `exit ${exitCode}`);
  const row = json.log_destinations.find(r => r.type === 'kubectl');
  assert(row, 'expected kubectl row');
  assert(row.namespace === 'data', `wrong namespace: ${row.namespace}`);
  assert(row.selector === 'app=bulk-uploader', `wrong selector: ${row.selector}`);
  assert(row.service === 'bulk-uploader');
});

// ── docker-compose extractor ──────────────────────────────────────────
test('docker-compose: top-level services', () => {
  const repo = mkRepo('compose', {
    'docker-compose.yml': `
version: '3.9'
services:
  publisher-api:
    image: publisher:latest
  worker:
    image: worker:latest
`,
  });
  const cfg = mkConfig(
    [{ name: 'mock', path: repo, type: 'node-mock', role: 'mock-server' }],
    { 'publisher-api': {}, 'worker': {} }
  );
  const { exitCode, json } = run(cfg);
  assert(exitCode === 0, `exit ${exitCode}`);
  const pub = json.log_destinations.find(r => r.container === 'publisher-api');
  const wk = json.log_destinations.find(r => r.container === 'worker');
  assert(pub, 'expected publisher-api container row');
  assert(wk, 'expected worker container row');
  assert(pub.env === 'local');
  assert(pub.query === 'docker logs {container} --since {since}');
});

// ── Ansible journalctl extractor ──────────────────────────────────────
test('Ansible: systemd unit becomes journalctl row', () => {
  const repo = mkRepo('ansible', {
    'roles/edge-gateway/tasks/main.yml': `
- name: ensure edge-gateway is running
  ansible.builtin.systemd:
    name: edge-gateway.service
    state: started
    enabled: true
`,
  });
  const cfg = mkConfig(
    [{ name: 'infra', path: repo, type: 'ansible', role: 'infrastructure' }],
    { 'edge-gateway': {} }
  );
  const { exitCode, json } = run(cfg);
  assert(exitCode === 0, `exit ${exitCode}`);
  const row = json.log_destinations.find(r => r.type === 'journalctl');
  assert(row, 'expected journalctl row');
  assert(row.unit === 'edge-gateway.service', `wrong unit: ${row.unit}`);
  assert(row.service === 'edge-gateway');
});

// ── Empty workspace ───────────────────────────────────────────────────
test('Empty workspace: emits empty arrays, not failure', () => {
  const repo = mkRepo('empty', { 'README.md': '# Nothing here' });
  const cfg = mkConfig(
    [{ name: 'infra', path: repo, type: 'cdk', role: 'infrastructure' }],
    {}
  );
  const { exitCode, json } = run(cfg);
  assert(exitCode === 0, `exit ${exitCode}`);
  assert(Array.isArray(json.log_destinations) && json.log_destinations.length === 0);
  assert(typeof json.trace === 'object');
  assert(Array.isArray(json.dashboards));
});

// ── Output shape ──────────────────────────────────────────────────────
test('Output shape matches OBSERVABILITY block contract', () => {
  const repo = mkRepo('shape', {
    'lib/x.ts': "new logs.LogGroup(this, 'X', { logGroupName: '/aws/ecs/svc-prod' });",
  });
  const cfg = mkConfig(
    [{ name: 'infra', path: repo, type: 'cdk', role: 'infrastructure' }],
    { 'svc': {} }
  );
  const { exitCode, json } = run(cfg);
  assert(exitCode === 0);
  assert('log_destinations' in json && 'trace' in json && 'dashboards' in json && 'runbooks' in json,
    'top-level keys missing');
});

// ── Dedup ─────────────────────────────────────────────────────────────
test('Dedup: same resource referenced twice yields one row', () => {
  const repo = mkRepo('dedup', {
    'lib/a.ts': "new logs.LogGroup(this, 'A', { logGroupName: '/aws/ecs/svc-prod' });",
    'lib/b.ts': "new logs.LogGroup(this, 'B', { logGroupName: '/aws/ecs/svc-prod' });",
  });
  const cfg = mkConfig(
    [{ name: 'infra', path: repo, type: 'cdk', role: 'infrastructure' }],
    { 'svc': {} }
  );
  const { exitCode, json } = run(cfg);
  assert(exitCode === 0);
  const matching = json.log_destinations.filter(r => r.log_group === '/aws/ecs/svc-prod');
  assert(matching.length === 1, `expected 1, got ${matching.length}`);
});

// Cleanup
fs.rmSync(TMP, { recursive: true, force: true });

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
