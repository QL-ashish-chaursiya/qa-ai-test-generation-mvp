const express = require('express');
const path = require('path');
const fs = require('fs/promises');
const { execFile, spawn } = require('child_process');

const PROJECT_ROOT = path.join(__dirname, '..');
const TESTS_DIR = path.join(PROJECT_ROOT, 'tests');
const GENERATED_DIR = path.join(TESTS_DIR, 'generated');
const INTENT_MANIFESTS_DIR = path.join(PROJECT_ROOT, 'specs', 'intent-manifests');
const TEST_RESULTS_DIR = path.join(PROJECT_ROOT, 'test-results');
const JSON_REPORTS_DIR = path.join(PROJECT_ROOT, '.playwright-json-reports');
const CLAUDE_TIMEOUT_MS = 5 * 60 * 1000;
const TEST_RUN_TIMEOUT_MS = 2 * 60 * 1000;

const app = express();
app.use(express.json({ limit: '5mb' }));
app.use(express.static(path.join(__dirname, 'public')));
app.use('/report', express.static(path.join(PROJECT_ROOT, 'playwright-report')));
// Serves recorded run videos/screenshots so the UI can play them back after a run.
app.use('/test-results', express.static(TEST_RESULTS_DIR));

function slugify(text, maxLen = 60) {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/(^-|-$)/g, '')
    .slice(0, maxLen) || 'test';
}

const CLAUDE_MODEL = 'haiku';

// Runs claude in streaming mode so the caller gets live progress (one JSON event per
// line on stdout - tool calls, etc.) via onEvent, then resolves with the final "result"
// event once the run completes (same shape as the non-streaming --output-format json).
function runClaudeStreaming(prompt, jsonSchema, onEvent, timeoutMs = CLAUDE_TIMEOUT_MS) {
  return new Promise((resolve, reject) => {
    const args = ['-p', prompt, '--model', CLAUDE_MODEL, '--output-format', 'stream-json', '--verbose', '--permission-mode', 'bypassPermissions'];
    if (jsonSchema) args.push('--json-schema', JSON.stringify(jsonSchema));

    const child = spawn('claude', args, { cwd: PROJECT_ROOT });
    let buffer = '';
    let stderr = '';
    let finalResult = null;
    let timedOut = false;

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, timeoutMs);

    child.stdout.on('data', (chunk) => {
      buffer += chunk.toString('utf-8');
      const lines = buffer.split('\n');
      buffer = lines.pop();
      for (const line of lines) {
        if (!line.trim()) continue;
        let event;
        try {
          event = JSON.parse(line);
        } catch {
          continue;
        }
        if (event.type === 'result') finalResult = event;
        else onEvent(event);
      }
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString('utf-8');
    });

    child.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on('close', (codeNum, signal) => {
      clearTimeout(timer);
      if (finalResult) return resolve(finalResult);
      if (timedOut || signal === 'SIGKILL') {
        return reject(new Error(`claude timed out after ${Math.round(timeoutMs / 1000)}s - try a smaller/simpler request`));
      }
      reject(new Error(stderr || `claude exited with code ${codeNum} and produced no result`));
    });
  });
}

// Tool calls made via the mcp__playwright-test__ tools carry a plain-English "intent"
// describing the step - that's exactly the live progress message a user wants to see.
// Falls back to a friendly label for tools that don't have one (e.g. writing the file).
const TOOL_PROGRESS_FALLBACK = {
  'mcp__playwright-test__generator_setup_page': 'Setting up the test page...',
  'mcp__playwright-test__generator_write_test': 'Writing the test file...',
  'mcp__playwright-test__browser_snapshot': 'Inspecting the page...',
  Write: 'Saving the test file...',
  Read: 'Reading the test file...',
  StructuredOutput: 'Finalizing result...',
};

function toProgressMessage(event) {
  if (event.type === 'system' && event.subtype === 'init') return 'Starting browser session...';
  if (event.type !== 'assistant' || !event.message?.content) return null;
  for (const block of event.message.content) {
    if (block.type !== 'tool_use') continue;
    if (block.input?.intent) return block.input.intent;
    if (TOOL_PROGRESS_FALLBACK[block.name]) return TOOL_PROGRESS_FALLBACK[block.name];
    // Skip Claude Code's own incidental tool use (Bash, ToolSearch, etc.) - only
    // playwright/file tools without an "intent" are worth a generic fallback message.
    if (block.name.startsWith('mcp__playwright-test__')) return `Running ${block.name.replace('mcp__playwright-test__', '')}...`;
  }
  return null;
}

const TEST_TYPE_GUIDANCE = {
  'happy-path': 'The normal, expected successful user flow with valid input - the straightforward "this works" case.',
  'edge-case': 'Boundary conditions and unusual-but-valid input: very long strings, empty optional fields, special characters, minimum/maximum values - things that should still be handled gracefully.',
  security: "Basic security-relevant UI checks: verify malicious-looking input (e.g. script tags, SQL-like strings) is handled safely and not reflected unsafely, and that unauthorized actions are properly blocked. Do NOT attempt real exploitation or destructive actions - only verify the UI's handling of risky-looking input.",
};

function describeTestTypes(testTypes) {
  if (!testTypes || !testTypes.length) return '';
  return testTypes.map((t) => `- ${t}: ${TEST_TYPE_GUIDANCE[t] || t}`).join('\n');
}

// Shared reliability standards injected into every prompt that generates or edits test
// code (initial generation, step resolution, intent-mode, and the healer) - these are the
// concrete, recurring ways generated tests break in practice (dead selectors copied from an
// accessibility snapshot, dialogs wired up too late, fixed sleeps papering over real waits,
// and row/position locators that silently target the wrong element once state changes)
// rather than generic "write good tests" advice.
const RELIABILITY_STANDARDS = `
Reliability standards - apply these to every locator and wait in the file, they are the most common reasons generated tests are flaky or wrong:
1. Strong selectors: verify every locator against the real live DOM before using it. Prefer, in order: a stable test id/data-testid attribute, ARIA role + accessible name (getByRole with { name }), unique visible text, then a tightly scoped CSS selector as a last resort. Never use a bare tag/CSS guess like locator('generic') or other pseudo-role names lifted from an accessibility snapshot - "generic" and similar are snapshot role labels, not real selectors, and will silently match nothing.
2. No position-only locators for anything whose position can change: avoid nth(0)/nth(1)/first()/last() to pick a row/item unless it is truly the only way to disambiguate AND its position is guaranteed stable. If a list/table row's order or membership can change between when the test is generated and when it runs (e.g. an item moves, gets approved/completed, is removed, or new rows are added above it), identify the target by its OWN distinguishing content at run time - its text, id, or current status/state - never by a hardcoded index or "the first row". Example: for approving a pending item, filter rows by their actual pending/unapproved status (e.g. filter({ hasText: 'Pending' }), or a status-cell/attribute check) so a later run correctly targets whichever row is still pending, not whatever happened to be first during generation.
3. Dialogs: register page.on('dialog', ...) (or page.once('dialog', ...)) BEFORE the action that triggers it, never after. Playwright auto-dismisses a dialog if no listener is attached the moment it appears, so attaching the handler after the triggering click is a no-op that silently cancels the dialog every run.
4. No fixed delays: never use page.waitForTimeout(...) or any sleep to wait for content, navigation, or an element to become ready. Rely on Playwright's built-in auto-waiting on actions and expect(...) assertions, and when something extra is needed, wait for the actual condition instead of a duration - locator.waitFor() for an element to appear/detach, page.waitForResponse() for a specific network call, page.waitForURL() for navigation, or page.waitForLoadState('networkidle') only when the page has no long-lived polling/websocket traffic that would keep it from ever going idle.
`;

function extractTokenUsage(result) {
  const u = result.usage || {};
  return {
    input: u.input_tokens || 0,
    output: u.output_tokens || 0,
    cacheRead: u.cache_read_input_tokens || 0,
    cacheCreation: u.cache_creation_input_tokens || 0,
  };
}

// Official Anthropic API list pricing (USD per token), independent of how this
// CLI session is actually authenticated/billed (e.g. a Claude subscription).
// This lets the UI show "what this would cost on metered API billing" so a
// product built on top of this can price test-case generation predictably.
// Cache write is priced at the 5-minute ephemeral rate (1.25x input).
const API_PRICING_PER_TOKEN = {
  opus: { input: 5 / 1e6, output: 25 / 1e6, cacheRead: 0.5 / 1e6, cacheWrite: 6.25 / 1e6 },
  haiku: { input: 1 / 1e6, output: 5 / 1e6, cacheRead: 0.1 / 1e6, cacheWrite: 1.25 / 1e6 },
};

function computeApiCostUsd(tokens) {
  const rates = API_PRICING_PER_TOKEN[CLAUDE_MODEL] || API_PRICING_PER_TOKEN.opus;
  return (
    tokens.input * rates.input +
    tokens.output * rates.output +
    tokens.cacheRead * rates.cacheRead +
    tokens.cacheCreation * rates.cacheWrite
  );
}

function totalTokenCount(tokens) {
  return tokens.input + tokens.output + tokens.cacheRead + tokens.cacheCreation;
}

// A test case's steps are structured (not just parsed from code) so they can be shown,
// edited, and added to directly. Both initial generation and later step edits ask Claude
// to return this same shape, so the steps always reflect what's really in the file.
const TEST_CASE_RESULT_SCHEMA = {
  type: 'object',
  properties: {
    title: { type: 'string' },
    steps: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          text: { type: 'string' },
          type: { type: 'string', enum: ['action', 'assertion'] },
        },
        required: ['text', 'type'],
      },
    },
  },
  required: ['title', 'steps'],
};

function mergeTokens(a, b) {
  return {
    input: a.input + b.input,
    output: a.output + b.output,
    cacheRead: a.cacheRead + b.cacheRead,
    cacheCreation: a.cacheCreation + b.cacheCreation,
  };
}

// Persists a fresh, fully-resolved step list against a test case, alongside whatever code
// now actually implements it. Used any time something other than resolvePendingSteps ends
// up changing the file (the healer patching a locator, intent-mode re-deriving the whole
// flow) - without this, meta.steps silently drifts from what the file actually does.
async function syncMetaSteps(meta, code, rawSteps, usage = {}, title) {
  const steps = rawSteps.map((s, i) => ({ id: `s${i + 1}`, text: s.text, type: s.type, resolved: true }));
  const updatedMeta = {
    ...meta,
    title: title || meta.title,
    steps,
    costUsd: (meta.costUsd || 0) + (usage.costUsd || 0),
    durationMs: (meta.durationMs || 0) + (usage.durationMs || 0),
    tokens: usage.tokens ? mergeTokens(meta.tokens, usage.tokens) : meta.tokens,
  };
  updatedMeta.totalTokens = totalTokenCount(updatedMeta.tokens);
  updatedMeta.apiCostUsd = computeApiCostUsd(updatedMeta.tokens);
  await fs.writeFile(path.join(GENERATED_DIR, `${meta.id}.meta.json`), JSON.stringify(updatedMeta, null, 2), 'utf-8');
  return { ...updatedMeta, code };
}

// Generates one Playwright test via a live browser session and persists it
// (file + metadata sidecar with structured, editable steps).
async function generateTestCase({ url, prompt, context, title, testTypes }, onEvent) {
  const timestamp = Date.now().toString(36);
  const slug = `${slugify(title || prompt, 60 - timestamp.length - 1)}-${timestamp}`;
  const outPath = path.join(GENERATED_DIR, `${slug}.spec.ts`);
  const relOutPath = path.relative(PROJECT_ROOT, outPath);
  const typeGuidance = describeTestTypes(testTypes);

  const claudePrompt = `You are generating a single Playwright test file for a QA automation product.

Target URL: ${url}
Test intent (plain English): ${prompt}
${context ? `\nContext for this test (credentials, session/OTP info, test data - use only what's relevant to this test's intent): ${context}\n` : ''}${typeGuidance ? `\nGenerate this test with the following focus (blend all listed if more than one applies):\n${typeGuidance}\n` : '\nFocus: the normal happy-path flow.\n'}
${RELIABILITY_STANDARDS}
Instructions:
1. Use the mcp__playwright-test__ browser tools to actually navigate to the target URL and interact with the live page. Call mcp__playwright-test__generator_setup_page first, then use browser_* tools to perform each step. Verify real selectors against the live DOM - do not guess them. Pass a short, specific "intent" string with every browser tool call describing that step in plain English (e.g. "Click the Submit button") - this is shown to the user live as progress.
2. Generate exactly ONE Playwright test (@playwright/test, TypeScript) implementing the scenario described above per the stated focus, with a real, meaningful assertion (expect(...)) that proves the scenario succeeded.
3. Include ONLY the steps required for THIS test's intent - add a login step only if the intent explicitly targets an authenticated area/action that is unreachable without logging in first.
4. Follow the conventions used elsewhere in this repo's tests/ directory: import { test, expect } from '@playwright/test'; one test.describe containing one test.
5. Write the final file using the Write tool to exactly this absolute path: ${outPath}
6. Do not ask any questions - make reasonable judgment calls yourself, you are running unattended.
7. Respond with ONLY the structured JSON result: a short "title" for this test case, and its ordered "steps" - every real action/assertion in the file restated as one short plain-English sentence, each with a "type" of "action" or "assertion".`;

  const result = await runClaudeStreaming(claudePrompt, TEST_CASE_RESULT_SCHEMA, onEvent);

  if (result.is_error || !result.structured_output) {
    const err = new Error(result.result || 'Claude run failed');
    err.detail = result.result;
    throw err;
  }

  let code;
  try {
    code = await fs.readFile(outPath, 'utf-8');
  } catch {
    const err = new Error('Claude did not write the expected test file');
    err.detail = result.result;
    throw err;
  }

  const tokens = extractTokenUsage(result);
  const steps = result.structured_output.steps.map((s, i) => ({ id: `s${i + 1}`, text: s.text, type: s.type, resolved: true }));
  const meta = {
    id: slug,
    title: result.structured_output.title || title || prompt,
    url,
    prompt,
    context: context || null,
    testTypes: testTypes && testTypes.length ? testTypes : ['happy-path'],
    steps,
    file: relOutPath,
    costUsd: result.total_cost_usd,
    durationMs: result.duration_ms,
    tokens,
    totalTokens: totalTokenCount(tokens),
    apiCostUsd: computeApiCostUsd(tokens),
    createdAt: new Date().toISOString(),
  };
  await fs.writeFile(path.join(GENERATED_DIR, `${slug}.meta.json`), JSON.stringify(meta, null, 2), 'utf-8');

  return { ...meta, code };
}

// Catches a test file up with whatever steps were added/edited (in meta.steps, marked
// resolved: false) since the code was last compiled - re-driving a live browser session
// ONCE for the whole batch, then rewriting the file and returning the FULL, now-resolved
// step list. This is the only place step edits actually cost AI/browser time, and it's
// deferred to run time (see /api/run-adaptive) rather than paid on every edit - mirroring
// how bug0/Passmark cache resolved steps and only re-resolve on a cache miss.
async function resolvePendingSteps(meta, code, onEvent) {
  const outPath = path.join(PROJECT_ROOT, meta.file);

  const claudePrompt = `You are updating an existing Playwright test file for a QA automation product to catch it up with plain-English step changes that were queued (added/edited) since the file was last compiled.

Test file (absolute path): ${outPath}
Target URL: ${meta.url}
${meta.context ? `Context for this test (credentials, session/OTP info, test data): ${meta.context}\n` : ''}
Full step list, in order. Steps marked [NEEDS IMPLEMENTING] are new or edited and not yet reflected in the code below - implement those. Steps without that marker are already correctly implemented in the code and must be left exactly as they are:
${meta.steps.map((s, i) => `${i + 1}. [${s.type}]${s.resolved ? '' : ' [NEEDS IMPLEMENTING]'} ${s.text}`).join('\n')}

Current file contents:
${code}
${RELIABILITY_STANDARDS}
Instructions:
1. Use the mcp__playwright-test__ browser tools to navigate to ${meta.url} (call mcp__playwright-test__generator_setup_page first) and verify real selectors live against the current page for the [NEEDS IMPLEMENTING] steps only - do not guess. Pass a short, specific "intent" string with every browser tool call describing what you're doing - this is shown to the user live as progress.
2. Implement ONLY the [NEEDS IMPLEMENTING] steps, inserting/updating them at their correct position in the step order. Leave every other step's existing behavior untouched. If an existing (already-implemented) step you're leaving untouched uses a position-only locator, a dialog handler registered after its triggering action, or a fixed delay, leave it as-is unless fixing it is necessary to implement a [NEEDS IMPLEMENTING] step - this pass targets only the queued changes.
3. Write the complete updated file back with the Write tool to exactly this path: ${outPath}
4. Respond with ONLY the structured JSON result: this test's "title" and its FULL ordered list of "steps" as they now exist in the updated file (including the unchanged ones), each restated as one short plain-English sentence with a "type" of "action" or "assertion".
5. Do not ask any questions - make reasonable judgment calls, you are running unattended.`;

  const result = await runClaudeStreaming(claudePrompt, TEST_CASE_RESULT_SCHEMA, onEvent);
  if (result.is_error || !result.structured_output) {
    const err = new Error(result.result || 'Claude run failed');
    err.detail = result.result;
    throw err;
  }

  let updatedCode;
  try {
    updatedCode = await fs.readFile(outPath, 'utf-8');
  } catch {
    const err = new Error('Claude did not rewrite the expected test file');
    err.detail = result.result;
    throw err;
  }

  return syncMetaSteps(
    meta,
    updatedCode,
    result.structured_output.steps,
    { costUsd: result.total_cost_usd, durationMs: result.duration_ms, tokens: extractTokenUsage(result) },
    result.structured_output.title
  );
}

// Loads a test case's metadata + current code by id (== its filename slug).
async function loadTestCase(id) {
  if (slugify(id) !== id) return null; // reject anything that isn't already a clean slug
  try {
    const meta = JSON.parse(await fs.readFile(path.join(GENERATED_DIR, `${id}.meta.json`), 'utf-8'));
    let code = '';
    try {
      code = await fs.readFile(path.join(PROJECT_ROOT, meta.file), 'utf-8');
    } catch {
      // spec file missing independently of its metadata; keep metadata, code stays empty
    }
    return { meta, code };
  } catch {
    return null;
  }
}

// Sets up an ndjson response and returns (send, onEvent) helpers: onEvent turns each
// live claude stream event into a human-readable progress message pushed to the client.
function streamRoute(res) {
  res.setHeader('Content-Type', 'application/x-ndjson');
  res.setHeader('Cache-Control', 'no-cache');
  const send = (obj) => {
    try {
      res.write(JSON.stringify(obj) + '\n');
    } catch (err) {
      console.error(`[stream] write failed (client likely disconnected): ${err.message}`);
    }
  };
  const onEvent = (event) => {
    const message = toProgressMessage(event);
    if (message) send({ type: 'progress', message });
  };
  return { send, onEvent };
}

// Creates a new test case. Streams live progress messages as the browser session runs,
// then a final "done" (with the saved item) or "error" event.
app.post('/api/test-cases', async (req, res) => {
  const { url, prompt, context, title, testTypes } = req.body || {};
  if (!url || typeof url !== 'string') return res.status(400).json({ error: 'url is required' });
  if (!prompt || typeof prompt !== 'string') return res.status(400).json({ error: 'prompt is required' });
  try {
    new URL(url);
  } catch {
    return res.status(400).json({ error: 'url must be a valid absolute URL' });
  }

  console.log(`[test-cases] create: url=${url} prompt=${prompt} testTypes=${testTypes}`);
  const { send, onEvent } = streamRoute(res);
  try {
    const item = await generateTestCase({ url, prompt, context, title, testTypes }, onEvent);
    send({ type: 'done', item });
  } catch (err) {
    console.error(`[test-cases] create failed: ${err.message}`);
    send({ type: 'error', message: err.message, detail: err.detail });
  }
  res.end();
});

// Lists all test cases (metadata + code) so the UI can render the dashboard on load.
app.get('/api/test-cases', async (_req, res) => {
  try {
    const entries = await fs.readdir(GENERATED_DIR);
    const metaFiles = entries.filter((f) => f.endsWith('.meta.json'));

    const items = await Promise.all(
      metaFiles.map(async (metaFile) => {
        const meta = JSON.parse(await fs.readFile(path.join(GENERATED_DIR, metaFile), 'utf-8'));
        let code = '';
        try {
          code = await fs.readFile(path.join(PROJECT_ROOT, meta.file), 'utf-8');
        } catch {
          // spec file was deleted/moved independently of its metadata; skip code, keep metadata
        }
        return { ...meta, code };
      })
    );

    items.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
    res.json(items);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.delete('/api/test-cases/:id', async (req, res) => {
  const { id } = req.params;
  if (slugify(id) !== id) return res.status(400).json({ error: 'invalid id' });

  let deleted = false;
  for (const p of [path.join(GENERATED_DIR, `${id}.spec.ts`), path.join(GENERATED_DIR, `${id}.meta.json`)]) {
    try {
      await fs.unlink(p);
      deleted = true;
    } catch {
      // already absent, fine
    }
  }

  if (!deleted) return res.status(404).json({ error: `test case not found: ${id}` });
  console.log(`[test-cases] deleted ${id}`);
  res.json({ ok: true });
});

// Adds a new plain-English step to the end of a test case. This is a pure text/metadata
// edit - no AI call, no browser, instant - matching how bug0/Passmark treat step edits:
// the step is queued as unresolved (resolved: false) and only actually gets compiled into
// real Playwright code the next time the test runs (see resolvePendingSteps, wired into
// /api/run-adaptive as rung 0), which also means several queued edits get resolved
// together in one browser session instead of one per edit.
app.post('/api/test-cases/:id/steps', async (req, res) => {
  const { id } = req.params;
  const { text, type } = req.body || {};
  if (!text || typeof text !== 'string') return res.status(400).json({ error: 'text is required' });
  const stepType = type === 'assertion' ? 'assertion' : 'action';

  const loaded = await loadTestCase(id);
  if (!loaded) return res.status(404).json({ error: `test case not found: ${id}` });

  const newStep = { id: `s${loaded.meta.steps.length + 1}`, text, type: stepType, resolved: false };
  const updatedMeta = { ...loaded.meta, steps: [...loaded.meta.steps, newStep] };
  await fs.writeFile(path.join(GENERATED_DIR, `${id}.meta.json`), JSON.stringify(updatedMeta, null, 2), 'utf-8');
  console.log(`[test-cases] queued new step on ${id} (resolves on next run): ${text}`);
  res.json({ ...updatedMeta, code: loaded.code });
});

// Edits an existing step's plain-English text (and optionally its type). Also a pure,
// instant text edit - marks the step unresolved so it gets recompiled on the next run.
app.patch('/api/test-cases/:id/steps/:stepId', async (req, res) => {
  const { id, stepId } = req.params;
  const { text, type } = req.body || {};
  if (!text || typeof text !== 'string') return res.status(400).json({ error: 'text is required' });

  const loaded = await loadTestCase(id);
  if (!loaded) return res.status(404).json({ error: `test case not found: ${id}` });
  const stepIndex = loaded.meta.steps.findIndex((s) => s.id === stepId);
  if (stepIndex === -1) return res.status(404).json({ error: `step not found: ${stepId}` });

  const steps = [...loaded.meta.steps];
  const prevStep = steps[stepIndex];
  const stepType = type === 'assertion' || type === 'action' ? type : prevStep.type;
  steps[stepIndex] = { ...prevStep, text, type: stepType, resolved: false };
  const updatedMeta = { ...loaded.meta, steps };
  await fs.writeFile(path.join(GENERATED_DIR, `${id}.meta.json`), JSON.stringify(updatedMeta, null, 2), 'utf-8');
  console.log(`[test-cases] queued edit on ${id} step ${stepId} (resolves on next run): ${text}`);
  res.json({ ...updatedMeta, code: loaded.code });
});

// Recursively walks a Playwright JSON-reporter report for the first "video" attachment -
// the report nests specs under an arbitrary number of suite levels depending on
// test.describe nesting, so index-based access isn't reliable.
function findVideoAttachment(node) {
  for (const spec of node.specs || []) {
    for (const test of spec.tests || []) {
      for (const result of test.results || []) {
        const video = (result.attachments || []).find((a) => a.name === 'video');
        if (video) return video.path;
      }
    }
  }
  for (const suite of node.suites || []) {
    const found = findVideoAttachment(suite);
    if (found) return found;
  }
  return null;
}

// Runs headless (this drives a real deployed server with no display, not just a local
// desktop) and always records video (playwright.config.ts: video: 'on'). Pulls the
// resulting video's URL out via the JSON reporter so the UI can play back the run
// afterward - since `--headed` (visible on the server's own screen) means nothing to a
// remote user, this recording is how they actually get to see the browser session.
async function runPlaywrightTest(relFile) {
  await fs.mkdir(JSON_REPORTS_DIR, { recursive: true });
  const jsonOutPath = path.join(JSON_REPORTS_DIR, `${slugify(relFile)}-${Date.now()}.json`);

  const { passed, output } = await new Promise((resolve) => {
    execFile(
      'npx',
      ['playwright', 'test', relFile, '--reporter=list,html,json'],
      {
        cwd: PROJECT_ROOT,
        timeout: TEST_RUN_TIMEOUT_MS,
        killSignal: 'SIGKILL',
        maxBuffer: 20 * 1024 * 1024,
        env: { ...process.env, PLAYWRIGHT_JSON_OUTPUT_NAME: jsonOutPath },
      },
      (error, stdout, stderr) => {
        resolve({ passed: !error, output: stdout + (stderr ? `\n${stderr}` : '') });
      }
    );
  });

  let videoUrl = null;
  try {
    const report = JSON.parse(await fs.readFile(jsonOutPath, 'utf-8'));
    const videoPath = findVideoAttachment(report);
    if (videoPath) videoUrl = '/test-results/' + encodeURI(path.relative(TEST_RESULTS_DIR, videoPath));
    await fs.unlink(jsonOutPath);
  } catch (err) {
    console.error(`[run-test] could not read video from JSON report: ${err.message}`);
  }

  return { passed, output, videoUrl };
}

app.post('/api/run-test', async (req, res) => {
  const { file } = req.body || {};
  if (!file || typeof file !== 'string') {
    return res.status(400).json({ error: 'file is required' });
  }

  // Resolve and confirm the requested file stays inside tests/ - reject path traversal.
  const resolved = path.resolve(PROJECT_ROOT, file);
  if (!resolved.startsWith(TESTS_DIR + path.sep)) {
    return res.status(400).json({ error: 'file must be inside the tests/ directory' });
  }
  try {
    await fs.access(resolved);
  } catch {
    return res.status(404).json({ error: `file not found: ${file}` });
  }

  console.log(`[run-test] running: ${file}`);
  const relFile = path.relative(PROJECT_ROOT, resolved);
  const result = await runPlaywrightTest(relFile);
  console.log(`[run-test] ${file} -> ${result.passed ? 'PASSED' : 'FAILED'}`);

  res.json({ ...result, reportUrl: '/report' });
});

const INTENT_RESULT_SCHEMA = {
  type: 'object',
  properties: {
    passed: { type: 'boolean' },
    steps: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          actionTaken: { type: 'string' },
          outcome: { type: 'string', enum: ['ok', 'skipped', 'failed'] },
        },
        required: ['id', 'actionTaken', 'outcome'],
      },
    },
    generatedCode: { type: 'string' },
    // Distinct from "steps" above (which is the per-intent execution log): this is the
    // FINAL "generatedCode" test's own steps in the same plain-English shape used
    // elsewhere, so a caller can keep a test case's step list in sync with the code.
    testSteps: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          text: { type: 'string' },
          type: { type: 'string', enum: ['action', 'assertion'] },
        },
        required: ['text', 'type'],
      },
    },
  },
  required: ['passed', 'steps', 'generatedCode', 'testSteps'],
};

// Executes a manifest of STEP INTENTS (not fixed code/selectors) against a live URL.
// The agent decides the real actions per-page at run time, so one manifest can drive
// fundamentally different flows (e.g. products that need variant selection vs. ones
// that don't) without a separate hardcoded script for each.
async function executeIntentManifest(manifest, url, onEvent = () => {}) {
  console.log(`[run-intent] manifest=${manifest.name} url=${url}`);

  const claudePrompt = `You are an intent-driven test executor. You are given a sequence of STEP INTENTS (not fixed code or selectors) for a scenario called "${manifest.name}": ${manifest.description}

Target URL: ${url}

Steps (execute in order, using your own judgment for HOW to satisfy each intent on the actual live page - do not assume a fixed sequence of actions, discover what this specific page actually needs):
${manifest.steps.map((s, i) => `${i + 1}. [${s.id}]${s.optional ? ' (optional - skip if not applicable to this page)' : ''} ${s.intent}`).join('\n')}
${RELIABILITY_STANDARDS}
Instructions:
1. Use the mcp__playwright-test__ browser tools to navigate to the URL and actually drive the live page. Call mcp__playwright-test__generator_setup_page first.
2. For each step, inspect the live page state and decide the real action(s) needed to satisfy that step's intent - verify real selectors against the live DOM, do not guess. Different pages may need completely different actions to satisfy the same intent.
3. If a step is marked optional and doesn't apply to this page, record its outcome as "skipped" and move on.
4. If a step's action fails, you may retry once with a different approach before marking its outcome as "failed".
5. After completing all steps, write out the exact sequence of actions you actually performed as a single, valid Playwright test (TypeScript, @playwright/test, one test.describe with one test) that would reproduce this specific run against this specific URL - this is the "generatedCode" field. This is a record of what happened, not a general-purpose script.
6. Also include "testSteps": that same generatedCode test's real actions/assertions restated as one short plain-English sentence each, with a "type" of "action" or "assertion" - this describes the final generatedCode, not the original manifest steps.
7. Do not ask any questions - make reasonable judgment calls, you are running unattended.
8. Respond with ONLY the structured JSON result matching the required schema.`;

  try {
    const result = await runClaudeStreaming(claudePrompt, INTENT_RESULT_SCHEMA, onEvent);

    if (result.is_error || !result.structured_output) {
      console.error(`[run-intent] failed. manifest=${manifest.name} url=${url}\nclaude said: ${result.result}`);
      return { ok: false, error: 'Intent run failed', detail: result.result };
    }

    console.log(`[run-intent] ${url} -> ${result.structured_output.passed ? 'PASSED' : 'FAILED'}`);
    return {
      ok: true,
      ...result.structured_output,
      costUsd: result.total_cost_usd,
      durationMs: result.duration_ms,
      tokens: extractTokenUsage(result),
    };
  } catch (err) {
    console.error(`[run-intent] threw: ${err.message}`);
    return { ok: false, error: err.message };
  }
}

// Loads a hand-authored, multi-step manifest by name (e.g. specs/intent-manifests/add-to-cart.json).
async function runIntentManifestByName(manifestName, url, onEvent = () => {}) {
  const manifestPath = path.join(INTENT_MANIFESTS_DIR, `${slugify(manifestName)}.json`);
  let manifest;
  try {
    manifest = JSON.parse(await fs.readFile(manifestPath, 'utf-8'));
  } catch {
    return { ok: false, error: `manifest not found: ${manifestName}` };
  }
  return executeIntentManifest(manifest, url, onEvent);
}

// Builds a single-step manifest on the fly from a generated test's own original
// plain-English prompt - so ANY generated test can fall back to live intent
// execution without needing a hand-authored manifest file.
function buildAdHocManifest(prompt) {
  return { name: 'ad-hoc', description: prompt, steps: [{ id: 'execute', intent: prompt }] };
}

app.post('/api/run-intent', async (req, res) => {
  const { manifest: manifestName, url } = req.body || {};
  if (!manifestName || typeof manifestName !== 'string') {
    return res.status(400).json({ error: 'manifest is required (e.g. "add-to-cart")' });
  }
  if (!url || typeof url !== 'string') {
    return res.status(400).json({ error: 'url is required' });
  }

  const result = await runIntentManifestByName(manifestName, url);
  if (!result.ok) {
    return res.status(result.error.includes('not found') ? 404 : 502).json(result);
  }
  const { ok, ...body } = result;
  res.json(body);
});

const HEALER_RESULT_SCHEMA = {
  type: 'object',
  properties: {
    attemptedFix: { type: 'boolean' },
    summary: { type: 'string' },
    gaveUp: { type: 'boolean' },
    // Only meaningful when a fix was actually applied (gaveUp: false) - the file's real
    // steps after the fix, so a caller can keep a test case's step list in sync with it.
    steps: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          text: { type: 'string' },
          type: { type: 'string', enum: ['action', 'assertion'] },
        },
        required: ['text', 'type'],
      },
    },
  },
  required: ['attemptedFix', 'summary', 'gaveUp'],
};

// Replicates the playwright-test-healer agent's documented workflow (test_run /
// test_debug / browser_generate_locator / inspect / Edit-in-place / re-run) against
// one specific failing test file, using the same MCP healer tools it's defined with.
async function runHealer(resolvedTestPath, relFile, lastFailureOutput, onEvent = () => {}) {
  const currentCode = await fs.readFile(resolvedTestPath, 'utf-8');

  const claudePrompt = `You are acting as this project's Playwright test healer, following the exact workflow defined in .claude/agents/playwright-test-healer.md.

Failing test file (absolute path): ${resolvedTestPath}

Current file contents:
${currentCode}

Failure output from the last run:
${lastFailureOutput}
${RELIABILITY_STANDARDS}
When fixing, actively check whether the failure is actually caused by one of the patterns above (a dead/generic selector, a position-only locator that now points at the wrong row because state changed, a dialog handler wired up after its trigger, or a fixed-delay wait that's too short/long) - these are the most common root causes, not just a one-off drifted attribute.

Your workflow:
1. Use mcp__playwright-test__test_run and mcp__playwright-test__test_debug on this test to reproduce the failure and pause on it.
2. Use browser_snapshot, browser_evaluate, browser_console_messages, browser_network_request(s), and browser_generate_locator to find the root cause: has a selector drifted, is there a timing/synchronization issue, or has the assertion gone stale?
3. Edit the test file in place (Edit/MultiEdit/Write) to fix ONLY what's broken - updated locators, wait conditions, or assertions.
4. Do NOT change the test's overall intent or add fundamentally new steps/flow logic. If the real problem is that the flow itself no longer matches this page (not just a broken selector/timing issue), do not force a fix - set gaveUp: true instead and explain why in summary.
5. Use mcp__playwright-test__test_run again to re-run the test and confirm your fix actually works before finishing.
6. If you cannot confidently fix it within 2 attempts, revert any partial edit and set gaveUp: true.
7. If you applied a fix (gaveUp: false), also include "steps": the FULL ordered list of the file's real actions/assertions after your fix, each restated as one short plain-English sentence with a "type" of "action" or "assertion". Omit it if you gave up.
8. Do not ask any questions - make reasonable judgment calls, you are running unattended.
9. Respond with ONLY the structured JSON result matching the required schema.`;

  try {
    const result = await runClaudeStreaming(claudePrompt, HEALER_RESULT_SCHEMA, onEvent);
    if (result.is_error || !result.structured_output) {
      return { ok: false, error: 'Healer run failed', detail: result.result };
    }
    return {
      ok: true,
      ...result.structured_output,
      costUsd: result.total_cost_usd,
      durationMs: result.duration_ms,
      tokens: extractTokenUsage(result),
    };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

// The full escalation ladder: resolve any pending step edits (cheap - only runs when
// there's something to resolve, and resolves everything queued in one pass) -> static
// (cache hit, free) -> healer (locator-level fix) -> intent-mode (live re-derivation) ->
// write successful result back as the new static test, so the next run is cheap again.
app.post('/api/run-adaptive', async (req, res) => {
  const { file, manifest: manifestName, url: bodyUrl, prompt: bodyPrompt } = req.body || {};
  if (!file || typeof file !== 'string') return res.status(400).json({ error: 'file is required' });

  const resolvedPath = path.resolve(PROJECT_ROOT, file);
  if (!resolvedPath.startsWith(TESTS_DIR + path.sep)) {
    return res.status(400).json({ error: 'file must be inside the tests/ directory' });
  }
  try {
    await fs.access(resolvedPath);
  } catch {
    return res.status(404).json({ error: `file not found: ${file}` });
  }

  // Fall back to the test's own stored metadata (url/prompt) if not passed explicitly,
  // so any test generated through the UI can self-heal with no extra input required.
  const metaPath = resolvedPath.replace(/\.spec\.ts$/, '.meta.json');
  let meta = null;
  try {
    meta = JSON.parse(await fs.readFile(metaPath, 'utf-8'));
  } catch {
    // no sidecar metadata available - url/prompt must come from the request body, and
    // there's nothing to check for pending step edits
  }
  const url = bodyUrl || meta?.url;
  const prompt = bodyPrompt || meta?.prompt;
  if (!url) return res.status(400).json({ error: 'url is required (or must be resolvable from the test\'s .meta.json)' });
  if (!manifestName && !prompt) {
    return res.status(400).json({ error: 'either manifest or prompt is required (or a prompt resolvable from the test\'s .meta.json)' });
  }

  const relFile = path.relative(PROJECT_ROOT, resolvedPath);
  const rungs = {};
  const { send, onEvent } = streamRoute(res);

  // Rung 0: catch the file up with any steps added/edited since it was last compiled.
  // This is where the AI/browser cost of an edit actually gets paid - once, on demand,
  // here at run time - not at edit time. Several queued edits resolve in one pass.
  if (meta?.steps?.some((s) => !s.resolved)) {
    console.log(`[run-adaptive] rung 0 (resolve pending steps): ${file}`);
    send({ type: 'progress', message: 'Catching the test up with your pending step changes...' });
    try {
      const code = await fs.readFile(resolvedPath, 'utf-8');
      const resolvedItem = await resolvePendingSteps(meta, code, onEvent);
      rungs.resolvePending = { applied: true, item: resolvedItem };
    } catch (err) {
      console.error(`[run-adaptive] rung 0 failed: ${err.message}`);
      rungs.resolvePending = { applied: false, error: err.message };
      send({ type: 'done', item: { finalPassed: false, resolvedAtRung: 'resolvePending', rungs, reportUrl: '/report' } });
      return res.end();
    }
  }

  // Rung 1: static
  console.log(`[run-adaptive] rung 1 (static): ${file}`);
  send({ type: 'progress', message: 'Running the test...' });
  const staticResult = await runPlaywrightTest(relFile);
  rungs.static = staticResult;
  if (staticResult.passed) {
    send({ type: 'done', item: { finalPassed: true, resolvedAtRung: 'static', rungs, reportUrl: '/report', videoUrl: staticResult.videoUrl } });
    return res.end();
  }

  // Rung 2: healer (locator-level fix, in place, then re-run for ground truth)
  console.log(`[run-adaptive] rung 2 (healer): ${file}`);
  send({ type: 'progress', message: 'Test failed - trying to heal it (locator/assertion patch)...' });
  const healerAttempt = await runHealer(resolvedPath, relFile, staticResult.output, onEvent);
  rungs.healer = healerAttempt;
  if (healerAttempt.ok && !healerAttempt.gaveUp) {
    const healerRerun = await runPlaywrightTest(relFile);
    rungs.healer.rerun = healerRerun;
    if (healerRerun.passed) {
      // The healer edits the file directly - keep meta.steps in sync with what it
      // actually changed, so the step list doesn't silently drift from the real test.
      if (meta && healerAttempt.steps?.length) {
        try {
          const healedCode = await fs.readFile(resolvedPath, 'utf-8');
          rungs.healer.item = await syncMetaSteps(meta, healedCode, healerAttempt.steps, {
            costUsd: healerAttempt.costUsd,
            durationMs: healerAttempt.durationMs,
            tokens: healerAttempt.tokens,
          });
        } catch (err) {
          console.error(`[run-adaptive] failed to sync meta.steps after healer fix: ${err.message}`);
        }
      }
      send({ type: 'done', item: { finalPassed: true, resolvedAtRung: 'healer', rungs, reportUrl: '/report', videoUrl: healerRerun.videoUrl } });
      return res.end();
    }
  }

  // Rung 3: intent-mode (live re-derivation, ignores the broken script). Uses the
  // named manifest if given, otherwise the test's own original prompt as an ad-hoc
  // single-step intent - so this works for any generated test, not just hand-authored ones.
  console.log(`[run-adaptive] rung 3 (intent): ${file}`);
  send({ type: 'progress', message: "Healer couldn't fix it - re-deriving the flow live..." });
  const intentResult = manifestName
    ? await runIntentManifestByName(manifestName, url, onEvent)
    : await executeIntentManifest(buildAdHocManifest(prompt), url, onEvent);
  rungs.intent = intentResult;
  if (!intentResult.ok || !intentResult.passed) {
    send({ type: 'done', item: { finalPassed: false, resolvedAtRung: 'intent', rungs, reportUrl: '/report' } });
    return res.end();
  }

  // Rung 4: write the successful intent-mode run back as the new static test.
  console.log(`[run-adaptive] rung 4 (write-back): ${file}`);
  send({ type: 'progress', message: 'Fixed - saving the working version so future runs stay fast...' });
  await fs.writeFile(resolvedPath, intentResult.generatedCode, 'utf-8');
  const confirmRun = await runPlaywrightTest(relFile);
  rungs.writeBack = { applied: true, confirmRunPassed: confirmRun.passed, confirmRunOutput: confirmRun.output };

  // Intent-mode rewrote the whole file - sync meta.steps to the FINAL generatedCode's
  // real steps (testSteps), not the original manifest, so the two stay consistent.
  if (meta && intentResult.testSteps?.length) {
    try {
      rungs.writeBack.item = await syncMetaSteps(meta, intentResult.generatedCode, intentResult.testSteps, {
        costUsd: intentResult.costUsd,
        durationMs: intentResult.durationMs,
        tokens: intentResult.tokens,
      });
    } catch (err) {
      console.error(`[run-adaptive] failed to sync meta.steps after intent write-back: ${err.message}`);
    }
  }

  send({ type: 'done', item: { finalPassed: true, resolvedAtRung: 'intent', rungs, reportUrl: '/report', videoUrl: confirmRun.videoUrl } });
  res.end();
});

app.get('/health', (_req, res) => res.json({ ok: true }));

const PORT = process.env.PORT || 4000;
app.listen(PORT, () => console.log(`QA generation API listening on http://localhost:${PORT}`));
