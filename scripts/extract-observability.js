#!/usr/bin/env node
/**
 * Extract a draft OBSERVABILITY block from IaC code.
 *
 * Walks the workspace's repos, recognizes 5 IaC shapes, and emits a JSON
 * draft of the OBSERVABILITY block matching `templates/blocks/observability.example.json`.
 * The draft is a STARTING POINT — the LLM curates with the user during
 * `/discover` Phase B to fill the parts no parser can extract:
 *   - trace.correlation_header (lives in middleware code, hard to grep reliably)
 *   - dashboards[] (lives in user knowledge, not in any repo)
 *   - runbooks.index (sometimes the user knows; sometimes "docs/runbooks/" exists)
 *
 * Recognized IaC shapes (regex-based, zero-deps):
 *   1. AWS CDK TypeScript:
 *        new logs.LogGroup(...)              → cloudwatch
 *        new lambda.Function(...)            → cloudwatch /aws/lambda/{name}
 *        new ecs.FargateService(...)         → cloudwatch /aws/ecs/{cluster}
 *   2. Terraform:
 *        resource "aws_cloudwatch_log_group" → cloudwatch
 *        resource "aws_lambda_function"      → cloudwatch /aws/lambda/{name}
 *   3. Kubernetes manifests:
 *        kind: Deployment | StatefulSet | Job → kubectl
 *   4. docker-compose.yml top-level services → docker
 *   5. Ansible systemd units                  → journalctl
 *
 * Usage:
 *   node extract-observability.js <workspace-config.json>
 *
 * Reads the workspace config, iterates every repo with `role: infrastructure`
 * (and `mock-server` repos for docker-compose), and emits the merged JSON
 * to stdout. Empty arrays/objects are emitted for sections nothing matched.
 *
 * Exit codes:
 *   0 — extraction completed (may be empty)
 *   1 — config unreadable or no repos to scan
 *   2 — usage error
 *
 * Zero dependencies — pure Node stdlib.
 */

const fs = require('fs');
const path = require('path');

const configPath = process.argv[2];
if (!configPath) {
  console.error('Usage: node extract-observability.js <workspace-config.json>');
  process.exit(2);
}

let config;
try { config = JSON.parse(fs.readFileSync(configPath, 'utf8')); }
catch (e) { console.error(`Cannot read config: ${e.message}`); process.exit(1); }

const repos = config.repos || {};
const services = config.services || {};
const envs = (config.workspace && config.workspace.envs) || ['prod'];

// Service name candidates — we try to match an extracted resource name back
// to a service the workspace knows about. Used by all extractors.
const serviceNames = Object.keys(services);

function guessService(name) {
  if (!name) return null;
  const lower = name.toLowerCase();
  let best = null;
  let bestLen = 0;
  for (const s of serviceNames) {
    const sl = s.toLowerCase();
    if (lower.includes(sl) && sl.length > bestLen) { best = s; bestLen = sl.length; }
  }
  return best;
}

// Stripping common env suffixes when the resource name embeds it.
function guessEnv(name) {
  if (!name) return null;
  for (const e of envs) {
    if (new RegExp(`[-_/]${e}\\b`, 'i').test(name)) return e;
  }
  return null;
}

const rows = [];

// ── Walker ────────────────────────────────────────────────────────────
function walk(dir, predicate, limit = 5000) {
  const out = [];
  const stack = [dir];
  let count = 0;
  while (stack.length && count < limit) {
    const cur = stack.pop();
    let entries;
    try { entries = fs.readdirSync(cur, { withFileTypes: true }); } catch { continue; }
    for (const ent of entries) {
      if (ent.name === 'node_modules' || ent.name === '.git' || ent.name === 'dist' ||
          ent.name === 'build' || ent.name === '.next' || ent.name === 'cdk.out') continue;
      const p = path.join(cur, ent.name);
      if (ent.isDirectory()) stack.push(p);
      else if (predicate(p)) { out.push(p); count++; }
    }
  }
  return out;
}

function lineOf(content, idx) {
  let n = 1;
  for (let i = 0; i < idx && i < content.length; i++) if (content[i] === '\n') n++;
  return n;
}

// ── CDK TypeScript ────────────────────────────────────────────────────
function extractFromCDK(repoPath) {
  const tsFiles = walk(repoPath, p => p.endsWith('.ts') && !p.endsWith('.d.ts') && !p.endsWith('.test.ts'));
  for (const f of tsFiles) {
    let content;
    try { content = fs.readFileSync(f, 'utf8'); } catch { continue; }
    const rel = path.relative(repoPath, f).replace(/\\/g, '/');

    // Explicit log groups: new logs.LogGroup(this, 'Foo', { logGroupName: '/aws/...' })
    const lgPattern = /new\s+(?:logs\.)?LogGroup\s*\([^)]*?logGroupName\s*:\s*['"`]([^'"`]+)['"`]/g;
    let m;
    while ((m = lgPattern.exec(content)) !== null) {
      const logGroup = m[1];
      const service = guessService(logGroup) || guessService(rel);
      const env = guessEnv(logGroup) || guessEnv(rel) || envs[0];
      if (service) rows.push({
        service, env, type: 'cloudwatch', log_group: logGroup,
        query: "aws logs tail {log_group} --since {since} --filter-pattern '{filter}'",
        source: `${rel}:${lineOf(content, m.index)}`,
      });
    }

    // Lambda functions: new lambda.Function(this, 'Foo', { functionName: 'foo-prod', ... })
    const lambdaPattern = /new\s+(?:lambda\.)?Function\s*\([^)]*?functionName\s*:\s*['"`]([^'"`]+)['"`]/g;
    while ((m = lambdaPattern.exec(content)) !== null) {
      const fnName = m[1];
      const service = guessService(fnName) || guessService(rel);
      const env = guessEnv(fnName) || envs[0];
      if (service) rows.push({
        service, env, type: 'cloudwatch', log_group: `/aws/lambda/${fnName}`,
        query: 'aws logs tail {log_group} --since {since}',
        source: `${rel}:${lineOf(content, m.index)}`,
      });
    }

    // Fargate services: new ecs.FargateService(this, 'Foo', { serviceName: 'bar-prod', cluster: { ... clusterName: 'baz' } })
    const fargatePattern = /new\s+(?:ecs\.)?(?:FargateService|Ec2Service|ApplicationLoadBalancedFargateService)\s*\([^)]*?serviceName\s*:\s*['"`]([^'"`]+)['"`]/g;
    while ((m = fargatePattern.exec(content)) !== null) {
      const svcName = m[1];
      const service = guessService(svcName) || guessService(rel);
      const env = guessEnv(svcName) || envs[0];
      // Best-effort: extract clusterName if present in the same file
      const clusterMatch = content.match(/clusterName\s*:\s*['"`]([^'"`]+)['"`]/);
      const cluster = clusterMatch ? clusterMatch[1] : svcName;
      if (service) rows.push({
        service, env, type: 'cloudwatch', log_group: `/aws/ecs/${cluster}`,
        query: "aws logs tail {log_group} --since {since} --filter-pattern '{filter}'",
        source: `${rel}:${lineOf(content, m.index)}`,
      });
    }
  }
}

// ── Terraform ─────────────────────────────────────────────────────────
function extractFromTerraform(repoPath) {
  const tfFiles = walk(repoPath, p => p.endsWith('.tf'));
  for (const f of tfFiles) {
    let content;
    try { content = fs.readFileSync(f, 'utf8'); } catch { continue; }
    const rel = path.relative(repoPath, f).replace(/\\/g, '/');

    // resource "aws_cloudwatch_log_group" "x" { name = "/foo/bar" }
    const lgPattern = /resource\s+"aws_cloudwatch_log_group"\s+"[^"]+"\s*\{[^}]*?name\s*=\s*"([^"]+)"/g;
    let m;
    while ((m = lgPattern.exec(content)) !== null) {
      const logGroup = m[1];
      const service = guessService(logGroup) || guessService(rel);
      const env = guessEnv(logGroup) || envs[0];
      if (service) rows.push({
        service, env, type: 'cloudwatch', log_group: logGroup,
        query: "aws logs tail {log_group} --since {since} --filter-pattern '{filter}'",
        source: `${rel}:${lineOf(content, m.index)}`,
      });
    }

    // resource "aws_lambda_function" "x" { function_name = "foo-prod" }
    const lambdaPattern = /resource\s+"aws_lambda_function"\s+"[^"]+"\s*\{[^}]*?function_name\s*=\s*"([^"]+)"/g;
    while ((m = lambdaPattern.exec(content)) !== null) {
      const fnName = m[1];
      const service = guessService(fnName) || guessService(rel);
      const env = guessEnv(fnName) || envs[0];
      if (service) rows.push({
        service, env, type: 'cloudwatch', log_group: `/aws/lambda/${fnName}`,
        query: 'aws logs tail {log_group} --since {since}',
        source: `${rel}:${lineOf(content, m.index)}`,
      });
    }
  }
}

// ── Kubernetes manifests ──────────────────────────────────────────────
// Light YAML reading — only what we need: kind, metadata.namespace, metadata.labels.app
function extractFromK8s(repoPath) {
  const yamlFiles = walk(repoPath, p => /\.(ya?ml)$/.test(p) && !/docker-compose/i.test(p));
  for (const f of yamlFiles) {
    let content;
    try { content = fs.readFileSync(f, 'utf8'); } catch { continue; }
    const rel = path.relative(repoPath, f).replace(/\\/g, '/');

    // Split on YAML doc separator and process each
    const docs = content.split(/^---\s*$/m);
    let cursor = 0;
    for (const doc of docs) {
      const docStartLine = lineOf(content, cursor);
      cursor += doc.length + 4; // approximate; --- is 3 chars + newline

      const kindMatch = doc.match(/^kind:\s*(Deployment|StatefulSet|Job|CronJob|DaemonSet)\s*$/m);
      if (!kindMatch) continue;
      const nsMatch = doc.match(/^\s{0,4}namespace:\s*([\w-]+)/m);
      // metadata.labels.app — under `metadata:` then `labels:` then `app:`
      const labelsBlock = doc.match(/^\s{0,4}labels:\s*\n([\s\S]*?)(?:^\s{0,4}\S|\Z)/m);
      let appLabel = null;
      if (labelsBlock) {
        const lm = labelsBlock[1].match(/^\s+app:\s*([\w.-]+)/m);
        if (lm) appLabel = lm[1];
      }
      if (!appLabel) {
        const nameMatch = doc.match(/^\s{0,4}name:\s*([\w-]+)/m);
        appLabel = nameMatch ? nameMatch[1] : null;
      }
      if (!appLabel) continue;

      const service = guessService(appLabel) || appLabel;
      const namespace = nsMatch ? nsMatch[1] : 'default';
      const env = guessEnv(namespace) || guessEnv(appLabel) || envs[0];

      rows.push({
        service, env, type: 'kubectl',
        namespace, selector: `app=${appLabel}`,
        query: 'kubectl logs -n {namespace} -l {selector} --since={since}',
        source: `${rel}:${docStartLine}`,
      });
    }
  }
}

// ── docker-compose.yml ────────────────────────────────────────────────
// Line-by-line scan — JS regex has no \Z, and naive multi-line matching breaks
// when the services block is the last thing in the file. Indent-based scanning
// is more robust for the small subset of YAML we care about.
function extractFromDockerCompose(repoPath) {
  const composeFiles = walk(repoPath, p => /docker-compose(\.[\w-]+)?\.ya?ml$/i.test(p));
  for (const f of composeFiles) {
    let content;
    try { content = fs.readFileSync(f, 'utf8'); } catch { continue; }
    const rel = path.relative(repoPath, f).replace(/\\/g, '/');

    const lines = content.split(/\r?\n/);
    let inServices = false;
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (/^services:\s*$/.test(line)) { inServices = true; continue; }
      if (!inServices) continue;
      // Exit services block when we hit a top-level (non-indented, non-blank, non-comment) key
      if (/^[A-Za-z]/.test(line)) { inServices = false; continue; }
      // Match exactly 2-space-indented service key
      const m = line.match(/^  ([\w.-]+):\s*$/);
      if (m) {
        const containerName = m[1];
        const service = guessService(containerName) || containerName;
        rows.push({
          service, env: 'local', type: 'docker',
          container: containerName,
          query: 'docker logs {container} --since {since}',
          source: `${rel}:${i + 1}`,
        });
      }
    }
  }
}

// ── Ansible systemd units (best-effort) ───────────────────────────────
function extractFromAnsible(repoPath) {
  const ymlFiles = walk(repoPath, p => /\.(ya?ml)$/.test(p) && /(ansible|playbook|role|tasks)/i.test(p));
  for (const f of ymlFiles) {
    let content;
    try { content = fs.readFileSync(f, 'utf8'); } catch { continue; }
    const rel = path.relative(repoPath, f).replace(/\\/g, '/');

    // ansible.builtin.systemd: \n   name: foo.service
    const sysdPattern = /(?:ansible\.builtin\.)?systemd:\s*\n\s+name:\s*([\w.-]+\.service)/g;
    let m;
    while ((m = sysdPattern.exec(content)) !== null) {
      const unit = m[1];
      const service = guessService(unit) || unit.replace(/\.service$/, '');
      rows.push({
        service, env: envs[0], type: 'journalctl',
        unit,
        query: "journalctl -u {unit} --since '{since}'",
        source: `${rel}:${lineOf(content, m.index)}`,
      });
    }
  }
}

// ── Drive ─────────────────────────────────────────────────────────────
const repoEntries = Array.isArray(repos) ? repos : Object.entries(repos).map(([n, r]) => ({ name: n, ...r }));
let scanned = 0;

for (const repo of repoEntries) {
  if (!repo.path || !fs.existsSync(repo.path)) continue;
  scanned++;
  if (repo.type === 'cdk' || repo.type === 'aws-cdk') extractFromCDK(repo.path);
  if (repo.type === 'terraform') extractFromTerraform(repo.path);
  // k8s, docker-compose, ansible are not strict types — scan any infra/mock repo
  if (repo.role === 'infrastructure' || repo.role === 'mock-server') {
    extractFromK8s(repo.path);
    extractFromDockerCompose(repo.path);
    extractFromAnsible(repo.path);
  }
}

if (scanned === 0) {
  console.error('No repos found to scan');
  process.exit(1);
}

// Dedupe identical (service, env, type, log_group/container/unit) rows — same
// resource referenced from multiple stack files would otherwise double up.
const seen = new Set();
const deduped = [];
for (const r of rows) {
  const key = `${r.service}|${r.env}|${r.type}|${r.log_group || r.container || r.unit || ''}|${r.namespace || ''}|${r.selector || ''}`;
  if (seen.has(key)) continue;
  seen.add(key);
  deduped.push(r);
}

const out = {
  log_destinations: deduped,
  trace: {},
  dashboards: [],
  runbooks: {},
};

process.stdout.write(JSON.stringify(out, null, 2) + '\n');
process.exit(0);
