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
const UPLOADS_DIR = path.join(PROJECT_ROOT, '.uploads');
const CLAUDE_TIMEOUT_MS = 5 * 60 * 1000;
// Site scans drive a much longer-running agent session (crawling several pages, planning,
// then generating multiple test cases) - give it far more headroom than a single generation.
const SCAN_TIMEOUT_MS = 20 * 60 * 1000;
const TEST_RUN_TIMEOUT_MS = 2 * 60 * 1000;
const MAX_SCAN_TEST_CASES = 30;

// Test-case ids currently being generated/run/healed - guards against a client deleting
// (or otherwise mutating) a test case out from under an in-flight operation on it, which
// otherwise crashes that operation with an ENOENT reading a file that was just deleted.
const busyIds = new Set();

const app = express();
// Raised above the default 5mb so an uploaded PRD/requirements doc (base64-encoded in the
// JSON body for the site-scan feature) has room - a scanned PDF can be a few MB before
// base64's ~33% overhead.
app.use(express.json({ limit: '25mb' }));
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

// Every runClaudeStreaming call spawns its own `claude -p` process, which in turn spawns
// its own Playwright MCP server for the mcp__playwright-test__ browser tools - and those
// all share ONE fixed Chrome profile directory (~/.cache/ms-playwright-mcp/mcp-chrome-*).
// Only one process can hold that profile's lock at a time, so two of these running at once
// (two generations, or a generate overlapping a run/heal) causes the second one to hang
// indefinitely waiting on that lock - which looks exactly like "stuck starting the browser"
// with no error, no timeout, nothing. Serialize every call through one queue so at most one
// `claude -p` browser session is ever alive at a time; this also naturally paces how fast
// the target site gets hit, which helps with login/rate-limit flakiness under load.
let aiQueueTail = Promise.resolve();
function runClaudeStreaming(prompt, jsonSchema, onEvent, timeoutMs = CLAUDE_TIMEOUT_MS) {
  const run = () => runClaudeStreamingNow(prompt, jsonSchema, onEvent, timeoutMs);
  const scheduled = aiQueueTail.then(run, run);
  aiQueueTail = scheduled.then(
    () => {},
    () => {}
  );
  return scheduled;
}

// Runs claude in streaming mode so the caller gets live progress (one JSON event per
// line on stdout - tool calls, etc.) via onEvent, then resolves with the final "result"
// event once the run completes (same shape as the non-streaming --output-format json).
function runClaudeStreamingNow(prompt, jsonSchema, onEvent, timeoutMs = CLAUDE_TIMEOUT_MS) {
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

// Pulls a live screenshot out of a browser_take_screenshot tool result, if this event is
// one - lets the UI show a "live view" of the site the agent is actually looking at, not
// just a text log of its actions. Tool results land on a "user"-type stream-json event
// (the CLI's own protocol for feeding a tool's output back to the model), with the image
// as a base64 content block alongside the tool's normal text summary.
function extractScreenshot(event) {
  if (event.type !== 'user' || !event.message?.content) return null;
  for (const block of event.message.content) {
    if (block.type !== 'tool_result' || !Array.isArray(block.content)) continue;
    for (const inner of block.content) {
      if (inner.type === 'image' && inner.source?.type === 'base64' && inner.source.data) {
        return { mediaType: inner.source.media_type || 'image/png', data: inner.source.data };
      }
    }
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
5. Skeleton/loading placeholders: a row or card existing in the DOM and being "visible" does NOT mean its real data has loaded - many apps render an empty shimmer/skeleton placeholder for each row immediately, then fill in real text a moment later once a request resolves. Before reading a cell's text or matching on its content (e.g. a status column, or a name column you're about to capture as an identifier), first confirm the content is real - e.g. wrap the read in expect(async () => { const t = await cell.textContent(); expect(t?.trim()).not.toBe(''); }).toPass({ timeout: 15000 }) - instead of assuming toBeVisible() on the row already implies its data is populated, and don't assume a generic waitForSelector('table') means the rows inside it are populated.
6. Toggle/paired-state action buttons: an icon-only button in a row or action menu can silently flip MEANING based on the item's current state - e.g. the same-position button is "Block" when a user is Active but becomes "Unblock" once that user is already Blocked ("Enable"/"Disable", "Activate"/"Deactivate", "Approve"/"Reject" follow the same pattern). Never assume the Nth button, or "the last button", always performs one specific action - identify it by something that encodes ITS CURRENT MEANING (a real icon class, aria-label, or title attribute unique to that action, verified against the live DOM). Read the item's current status first, and either target the correct action directly or normalize to a known starting state first (e.g. unblock as setup, if the item happens to already be blocked) before performing the intended action. This applies even when the row itself was already picked correctly by content, not just when it's picked by position.
7. Paired-opposite-label substring matching: role/text matchers do a case-insensitive SUBSTRING match by default, not an exact match. A heading or button named "Block User?" / "Block" will also match against "Unblock User?" / "Unblock" (since "Unblock" contains "block" as a substring), silently mis-verifying which dialog/action actually happened. Whenever the expected text could be a substring of an opposite-action label (Block/Unblock, Enable/Disable, Approve/Disapprove, etc.), pass { exact: true } to getByRole/getByText rather than relying on the default substring match.
8. Scope form fields to their open context: a generic locator like page.locator('textarea') or page.locator('input') matches ANY such element anywhere on the page, not just the one inside the dialog/modal/panel currently open - if the page can have more than one (e.g. a "reason" textarea in both a Block dialog and an Unblock dialog), scope the locator to the specific open dialog/container, or match it by its own accessible name (e.g. getByRole('textbox', { name: 'Reason for Blocking *' })), instead of matching page-wide.
9. NEVER write a vacuous/escape-hatch assertion: no "if I couldn't find the button/element, just expect(true).toBe(true) and pass anyway" fallback branches, and no defensive if/else-guarded action ("if (await x.isVisible().catch(() => false)) { click it } else { do nothing }") around a step that is actually required for the scenario. A test exists to PROVE the scenario happened - if the real element genuinely can't be found with a correct, live-DOM-verified selector, let the test FAIL loudly there (a normal unguarded action/expect that throws) so the failure is visible, rather than silently no-op past it and still report success. The only acceptable defensive branching is for a state that legitimately varies per run and where EVERY branch performs and verifies a real, meaningful action for that state (e.g. standard #6's Block-vs-Unblock branch) - never a branch whose entire job is to avoid failing.
`;

// Mechanical safety net for standards #2, #6, and #9 above: prompt text alone doesn't
// reliably stop a model from hardcoding a row's position, an action button's position
// within a row, or writing a vacuous fallback assertion that passes without proving
// anything (especially the cheaper model this runs on) - it tends to just transcribe "I
// clicked the 2nd row" / "I clicked the last button" / "couldn't find it so just pass"
// literally instead of doing the harder, correct thing. This runs as an immediate,
// PRE-EXECUTION static check on freshly generated code - it forces one corrective pass
// based on the code's own shape, not on whether the test happened to pass or fail, so
// generation itself gets more stable instead of leaning on healing-after-failure.
function findPositionalRowViolations(code) {
  const violations = [];
  code.split('\n').forEach((line, i) => {
    if (/\b(?:tr|tbody\s+tr|\[role=["']row["']\])\s*:nth-child\(\s*\d+\s*\)/i.test(line)) {
      violations.push({ line: i + 1, text: line.trim(), reason: 'hardcoded row position via :nth-child(N)' });
    } else if (/\.nth\(\s*\d+\s*\)/.test(line) && /\b(?:tr|row|rows|tbody)\b/i.test(line) && !/\.filter\(/.test(line)) {
      violations.push({ line: i + 1, text: line.trim(), reason: 'hardcoded row/item position via .nth(N) without filtering by content first' });
    } else if (/\bbutton\s*:\s*(?:last-child|first-child|nth-child\(\s*\d+\s*\)|nth-of-type\(\s*\d+\s*\))/i.test(line)) {
      violations.push({ line: i + 1, text: line.trim(), reason: 'action button picked by CSS position (e.g. button:last-child) instead of a real, state-aware attribute - the same position can mean a different action (e.g. Block vs Unblock) depending on current item state' });
    } else if (/\bbutton[a-z]*\s*\.\s*(?:last|first)\(\)/i.test(line) || /\.locator\(\s*['"]button['"]\s*\)\s*\.\s*(?:last|first|nth)\(/i.test(line)) {
      violations.push({ line: i + 1, text: line.trim(), reason: 'action button picked by position (.last()/.first()/.nth(N)) instead of a real, state-aware attribute - the same position can mean a different action (e.g. Block vs Unblock) depending on current item state' });
    } else if (/expect\(\s*true\s*\)\s*\.\s*(?:toBe\(\s*true\s*\)|toBeTruthy\(\s*\))/.test(line) || /expect\(\s*1\s*\)\s*\.\s*toBe\(\s*1\s*\)/.test(line)) {
      violations.push({ line: i + 1, text: line.trim(), reason: 'vacuous/tautological assertion (e.g. expect(true).toBe(true)) - this always passes regardless of whether the real scenario happened, almost always used as a silent fallback when the real target couldn\'t be found' });
    }
  });
  return violations;
}

// Runs one bounded corrective pass when findPositionalRowViolations finds something -
// returns null if there was nothing to fix (caller keeps its own result), or the
// corrected { code, steps, title, usage } if a fix was attempted (whether or not it fully
// resolved every violation - logged either way so it's visible in the server output).
// This is a STATIC, code-shape-driven pass - it runs whether or not the test has even
// been executed yet, so it tightens up generation itself rather than reacting to failure.
async function enforceRowLocatorRobustness(outPath, onEvent) {
  const code = await fs.readFile(outPath, 'utf-8');
  const violations = findPositionalRowViolations(code);
  if (!violations.length) return null;

  const relPath = path.relative(PROJECT_ROOT, outPath);
  console.log(`[reliability-check] ${relPath}: ${violations.length} violation(s) found, requesting a fix`);

  const fixPrompt = `You are fixing specific, mechanical robustness bugs in this Playwright test file. It has one or more of:
- a table/list row, and/or an action button within a row, selected by hardcoded POSITION (a CSS ":nth-child(N)"/":last-child", or a Playwright ".nth(N)"/".last()"/".first()") instead of by that element's own stable, identifying content or state;
- a vacuous/tautological assertion (e.g. "expect(true).toBe(true)") used as a silent fallback that makes the test pass without actually proving the scenario happened.

These are real correctness bugs, not style nits:
- For ROWS: the very action this test performs (blocking, approving, completing, deleting, etc.) is likely to change that row's order or remove it from view. On the next run, the same fixed position will point at a DIFFERENT, unrelated row - the test will then silently act on or verify the wrong user/item.
- For ACTION BUTTONS: a button picked by position within a row (e.g. "the last button") often TOGGLES meaning based on that item's current state - e.g. it performs "Block" when the user is Active but the same-position button performs "Unblock" once already Blocked (same pattern for Enable/Disable, Activate/Deactivate, Approve/Reject). Picking it by position silently performs the WRONG action, or fails outright, depending on whatever state the item happens to be in when the test runs.
- For VACUOUS ASSERTIONS: a test with a fallback like "if (couldn't find the button) { expect(true).toBe(true) }" reports as PASSING even when it never actually performed the scenario at all - this is worse than a failing test, because it hides real breakage behind a green checkmark.

File (absolute path): ${outPath}

Violations found:
${violations.map((v) => `- Line ${v.line}: ${v.reason}\n  ${v.text}`).join('\n')}

Current file contents:
${code}
${RELIABILITY_STANDARDS}
Fix instructions:
1. For a flagged ROW locator: replace it with one resolved via the row's own real, distinguishing content - e.g. capture the row's identifying cell text (name/email) into a variable BEFORE any mutating action, then re-locate that same row later via something like page.locator('tbody tr').filter({ hasText: capturedText }) rather than a fixed index. If the position was only used to pick WHICH row to act on (not to re-verify it later), select it by a real state condition instead (e.g. a status cell containing "Active"/"Pending"), not by index.
2. For a flagged ACTION BUTTON locator: replace it with one resolved via a real, stable attribute that identifies that specific action regardless of position - an icon class (e.g. svg.lucide-ban vs svg.lucide-user-check), an aria-label, or a title attribute, verified against the live DOM if you need to (do not guess the class/attribute name). Read the item's current status first, and either target the correct action directly, or normalize to a known starting state first (e.g. perform the opposite action as setup if the item is already in the target state) before performing the test's intended action. Also check nearby assertions for the same substring-matching trap (e.g. a "Block User?" heading/text check without { exact: true } will also match "Unblock User?") and add { exact: true } where that risk applies.
3. For a flagged VACUOUS ASSERTION: remove the escape-hatch entirely. Find the REAL selector for whatever it was trying to find (verify against the live DOM), and make that the actual, unguarded step - if the real element genuinely doesn't exist, the test should throw/fail there, not fall back to a no-op pass. Do not leave an if/else where one branch does nothing but still "succeeds."
4. Do not change the test's overall intent, or anything not required to fix the flagged issue(s).
5. Use the mcp__playwright-test__ browser tools to confirm the live DOM for whatever you need to fix correctly - do not guess selectors, icon classes, or attributes.
6. Write the corrected file back with the Write tool to exactly this path: ${outPath}
7. Do not ask any questions - make reasonable judgment calls, you are running unattended.
8. Respond with ONLY the structured JSON result: this test's "title", a "description" (1-3 plain-English sentences summarizing what the test covers and what it proves - keep it as-is if the fix didn't change the test's overall intent), and its FULL ordered list of "steps" as they now exist in the corrected file, each restated as one short plain-English sentence with a "type" of "action" or "assertion".`;

  const result = await runClaudeStreaming(fixPrompt, TEST_CASE_RESULT_SCHEMA, onEvent);
  if (result.is_error || !result.structured_output) {
    console.error(`[reliability-check] ${relPath}: fix pass failed - ${result.result}`);
    return null;
  }

  let fixedCode;
  try {
    fixedCode = await fs.readFile(outPath, 'utf-8');
  } catch {
    console.error(`[reliability-check] ${relPath}: fix pass did not rewrite the file`);
    return null;
  }

  const remaining = findPositionalRowViolations(fixedCode);
  console.log(
    remaining.length
      ? `[reliability-check] ${relPath}: ${remaining.length} violation(s) still present after fix pass - proceeding anyway, review recommended`
      : `[reliability-check] ${relPath}: violation(s) resolved`
  );

  return {
    code: fixedCode,
    steps: result.structured_output.steps,
    title: result.structured_output.title,
    description: result.structured_output.description,
    usage: { costUsd: result.total_cost_usd, durationMs: result.duration_ms, tokens: extractTokenUsage(result) },
  };
}

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
    description: { type: 'string' },
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
  required: ['title', 'description', 'steps'],
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
async function syncMetaSteps(meta, code, rawSteps, usage = {}, title, description) {
  const steps = rawSteps.map((s, i) => ({ id: `s${i + 1}`, text: s.text, type: s.type, resolved: true }));
  const updatedMeta = {
    ...meta,
    title: title || meta.title,
    description: description || meta.description,
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

// Generates one Playwright test via a live browser session, runs it once, and - if that
// run fails - immediately auto-heals it right then (one healer attempt, re-run to confirm)
// before ever handing the result back. This is the full generate -> run -> heal-if-needed
// lifecycle in one shot, so a test that needed healing on its first run doesn't require a
// separate manual step - it comes back already fixed (or, if the healer couldn't fix it,
// honestly reported as failed with why). Persists the file + metadata sidecar with
// structured, editable steps. `slug` is reserved by the caller before this starts (see
// /api/test-cases) so the id is known for busy-tracking from the very first moment.
async function generateTestCase({ url, prompt, context, title, testTypes, slug }, send, onEvent) {
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
7. Respond with ONLY the structured JSON result: a "title" for this test case (a specific, descriptive sentence-fragment naming the exact scenario and outcome - e.g. "Admin can block an active user and see their status change to Blocked" rather than a generic "Block user test" - someone scanning a list of titles should be able to tell this test apart from other tests on the same page/feature without opening it), a "description" (1-3 plain-English sentences explaining what this test covers, what user-facing behavior it exercises, and what it proves when it passes - written for someone deciding whether this test is relevant without reading the code), and its ordered "steps" - every real action/assertion in the file restated as one short plain-English sentence, each with a "type" of "action" or "assertion".`;

  // Persisted (meta.generationPrompt) so the exact prompt used is still inspectable via the
  // API/meta.json later, even though it's no longer surfaced in the UI.
  send({ type: 'prompt', text: claudePrompt });

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

  let tokens = extractTokenUsage(result);
  let costUsd = result.total_cost_usd;
  let durationMs = result.duration_ms;
  let finalTitle = result.structured_output.title || title || prompt;
  let finalDescription = result.structured_output.description || '';
  let rawSteps = result.structured_output.steps;

  // Static, code-shape corrective pass BEFORE ever running the test - catches position-only
  // locators and vacuous assertions regardless of whether the test happens to pass.
  const rowFix = await enforceRowLocatorRobustness(outPath, onEvent);
  if (rowFix) {
    code = rowFix.code;
    rawSteps = rowFix.steps;
    finalTitle = rowFix.title || finalTitle;
    finalDescription = rowFix.description || finalDescription;
    tokens = mergeTokens(tokens, rowFix.usage.tokens);
    costUsd += rowFix.usage.costUsd;
    durationMs += rowFix.usage.durationMs;
  }

  // Run it once. If it fails, heal it right then (one attempt) and re-run to confirm -
  // the whole generate -> run -> heal-if-needed lifecycle happens here, so the caller gets
  // back a test that's already been made to work, not one that still needs a manual step.
  send({ type: 'progress', message: 'Verifying the generated test actually passes...' });
  let verifyRun = await runPlaywrightTest(relOutPath);
  let verified = verifyRun.passed;
  let healSummary = null;

  if (!verified) {
    console.log(`[test-cases] ${slug}: first run failed - attempting one automatic heal`);
    send({ type: 'progress', message: 'First run failed - healing it now...' });
    const healerAttempt = await runHealer(outPath, relOutPath, verifyRun.output, onEvent);
    if (healerAttempt.ok) {
      costUsd += healerAttempt.costUsd || 0;
      durationMs += healerAttempt.durationMs || 0;
      tokens = mergeTokens(tokens, healerAttempt.tokens || { input: 0, output: 0, cacheRead: 0, cacheCreation: 0 });
      healSummary = healerAttempt.summary;
    }
    if (healerAttempt.ok && !healerAttempt.gaveUp) {
      // The healer edits the file directly - re-check it against the same static rules
      // (it can just as easily reintroduce a hardcoded row position as generation did).
      const healRowFix = await enforceRowLocatorRobustness(outPath, onEvent);
      if (healRowFix) {
        rawSteps = healRowFix.steps;
        finalTitle = healRowFix.title || finalTitle;
        finalDescription = healRowFix.description || finalDescription;
        tokens = mergeTokens(tokens, healRowFix.usage.tokens);
        costUsd += healRowFix.usage.costUsd;
        durationMs += healRowFix.usage.durationMs;
      } else if (healerAttempt.steps?.length) {
        rawSteps = healerAttempt.steps;
      }

      send({ type: 'progress', message: 'Re-running after the fix...' });
      verifyRun = await runPlaywrightTest(relOutPath);
      verified = verifyRun.passed;
    }
    try {
      code = await fs.readFile(outPath, 'utf-8');
    } catch {
      // file should still be there - the healer edits in place, doesn't delete it
    }
    console.log(`[test-cases] ${slug}: ${verified ? 'passed after heal' : 'still failing after heal'}`);
  }

  const steps = rawSteps.map((s, i) => ({ id: `s${i + 1}`, text: s.text, type: s.type, resolved: true }));
  const meta = {
    id: slug,
    title: finalTitle,
    description: finalDescription,
    url,
    prompt,
    context: context || null,
    testTypes: testTypes && testTypes.length ? testTypes : ['happy-path'],
    steps,
    file: relOutPath,
    // The exact prompt sent to the generator agent, kept so it's still inspectable after
    // the fact (not just while the live stream is running).
    generationPrompt: claudePrompt,
    costUsd,
    durationMs,
    tokens,
    totalTokens: totalTokenCount(tokens),
    apiCostUsd: computeApiCostUsd(tokens),
    createdAt: new Date().toISOString(),
    verified,
    healed: healSummary ? { summary: healSummary } : undefined,
    // Only kept when NOT verified, so the caller/UI can surface why - trimmed since
    // Playwright output can be long and this isn't needed once a test is passing.
    verificationFailureOutput: verified ? undefined : (verifyRun.output || '').slice(-4000),
  };
  await fs.writeFile(path.join(GENERATED_DIR, `${slug}.meta.json`), JSON.stringify(meta, null, 2), 'utf-8');

  return { ...meta, code };
}

const SCAN_PLAN_SCHEMA = {
  type: 'object',
  properties: {
    sitesSummary: { type: 'string' },
    scenarios: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          url: { type: 'string' },
          title: { type: 'string' },
          prompt: { type: 'string' },
          testTypes: { type: 'array', items: { type: 'string', enum: ['happy-path', 'edge-case', 'security'] } },
        },
        required: ['url', 'title', 'prompt'],
      },
    },
  },
  required: ['sitesSummary', 'scenarios'],
};

// Crawls a live site with a browser session, optionally reads an uploaded PRD/requirements
// document, and plans up to `maxTestCases` distinct, high-value test scenarios grounded in
// what the site actually does (not guessed) - the same live-DOM-verification standard
// generation itself follows, just applied to picking WHAT to test rather than HOW.
async function scanWebsiteAndPlan({ url, context, maxTestCases, prdPath, prdFileName }, onEvent) {
  const claudePrompt = `You are planning a batch of Playwright test cases for a QA automation product by exploring a live website.

Target URL (starting point): ${url}
${context ? `\nContext for this scan (credentials, session/OTP info, test data, priorities - use only what's relevant): ${context}\n` : ''}${
    prdPath
      ? `\nA requirements/PRD document was uploaded: "${prdFileName}" (absolute path: ${prdPath}). Read it first (it may be a PDF, Word doc, or plain text) with the Read tool and use it to understand what features/flows matter most - prioritize test scenarios that cover requirements it describes.\n`
      : ''
  }
Instructions:
1. Use the mcp__playwright-test__ browser tools to actually explore the live site - call mcp__playwright-test__generator_setup_page first, then navigate through its main pages/nav links/primary flows (forms, listings, auth, CRUD screens, checkout, dashboards, etc.) to understand what it actually does. Verify real pages/elements exist - do not invent scenarios for features you haven't actually seen on the site. Pass a short "intent" string with each browser tool call.
2. Do not attempt to exhaustively crawl every page - explore enough of the site's main navigation and distinct page types to identify its most important, distinct user-facing flows.
3. Based on what you actually found (and the PRD/context above, if given), select up to ${maxTestCases} of the most valuable, DISTINCT test scenarios - prioritize covering different features/flows over minor variations of the same one. Each scenario must target a real page you actually visited.
4. For each scenario, write it in the exact same shape a human would type into this product's single-test-case generator: a specific "url" (the real page this scenario starts from), a "title" (specific sentence-fragment naming the exact scenario and outcome, not generic), a "prompt" (plain-English description of the scenario to verify, written the same way a QA person would describe a test case), and "testTypes" (one or more of "happy-path"/"edge-case"/"security" - default to ["happy-path"] if none clearly apply).
5. Do not ask any questions - make reasonable judgment calls, you are running unattended.
6. Respond with ONLY the structured JSON result: a "sitesSummary" (1-2 sentences on what the site is and what you explored) and "scenarios" (the ordered list described above, most valuable first, capped at ${maxTestCases}).`;

  const result = await runClaudeStreaming(claudePrompt, SCAN_PLAN_SCHEMA, onEvent, SCAN_TIMEOUT_MS);
  if (result.is_error || !result.structured_output) {
    const err = new Error(result.result || 'Claude run failed');
    err.detail = result.result;
    throw err;
  }

  const scenarios = (result.structured_output.scenarios || []).slice(0, maxTestCases);
  return { sitesSummary: result.structured_output.sitesSummary, scenarios };
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
4. Respond with ONLY the structured JSON result: this test's "title", a "description" (1-3 plain-English sentences summarizing what the test covers and what it proves, updated to reflect the newly implemented steps), and its FULL ordered list of "steps" as they now exist in the updated file (including the unchanged ones), each restated as one short plain-English sentence with a "type" of "action" or "assertion".
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
    result.structured_output.title,
    result.structured_output.description
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
    const screenshot = extractScreenshot(event);
    if (screenshot) send({ type: 'screenshot', dataUrl: `data:${screenshot.mediaType};base64,${screenshot.data}` });
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

  // Reserve the id up front (before any AI/browser work starts) so it's busy-tracked for
  // its ENTIRE lifetime - otherwise a delete sent in the first moments of generation could
  // race a slug that doesn't have a file on disk to protect yet.
  const timestamp = Date.now().toString(36);
  const slug = `${slugify(title || prompt, 60 - timestamp.length - 1)}-${timestamp}`;

  console.log(`[test-cases] create: id=${slug} url=${url} prompt=${prompt} testTypes=${testTypes}`);
  const { send, onEvent } = streamRoute(res);
  busyIds.add(slug);
  try {
    const item = await generateTestCase({ url, prompt, context, title, testTypes, slug }, send, onEvent);
    send({ type: 'done', item });
  } catch (err) {
    console.error(`[test-cases] create failed: ${err.message}`);
    send({ type: 'error', message: err.message, detail: err.detail });
  } finally {
    busyIds.delete(slug);
  }
  res.end();
});

// Scans an entire live website and generates up to MAX_SCAN_TEST_CASES test cases from it in
// one batch: crawl + plan scenarios (optionally grounded in an uploaded PRD/requirements doc
// and free-text context), then run the SAME generate -> run -> heal-if-needed pipeline as a
// single test case for each planned scenario, one at a time. Streams a "prompt"-shaped
// progress log plus an "item" event as each test case finishes (so the UI can render cards
// incrementally instead of waiting for the whole batch), then a final "done" summary.
app.post('/api/scan-site', async (req, res) => {
  const { url, context, maxTestCases, prdFileName, prdFileBase64 } = req.body || {};
  if (!url || typeof url !== 'string') return res.status(400).json({ error: 'url is required' });
  try {
    new URL(url);
  } catch {
    return res.status(400).json({ error: 'url must be a valid absolute URL' });
  }
  const cappedMax = Math.min(Math.max(parseInt(maxTestCases, 10) || 10, 1), MAX_SCAN_TEST_CASES);

  let prdPath = null;
  if (prdFileBase64) {
    if (!prdFileName || typeof prdFileName !== 'string') {
      return res.status(400).json({ error: 'prdFileName is required when prdFileBase64 is provided' });
    }
    await fs.mkdir(UPLOADS_DIR, { recursive: true });
    const safeName = `${Date.now().toString(36)}-${slugify(prdFileName.replace(/\.[^.]+$/, ''), 60)}${path.extname(prdFileName) || ''}`;
    prdPath = path.join(UPLOADS_DIR, safeName);
    try {
      await fs.writeFile(prdPath, Buffer.from(prdFileBase64, 'base64'));
    } catch (err) {
      return res.status(400).json({ error: `could not save uploaded file: ${err.message}` });
    }
  }

  const scanId = `scan-${Date.now().toString(36)}`;
  console.log(`[scan-site] start: id=${scanId} url=${url} maxTestCases=${cappedMax} prd=${prdFileName || 'none'}`);
  const { send, onEvent } = streamRoute(res);
  busyIds.add(scanId);
  try {
    send({ type: 'progress', message: 'Scanning the website and planning test cases...' });
    const { sitesSummary, scenarios } = await scanWebsiteAndPlan(
      { url, context, maxTestCases: cappedMax, prdPath, prdFileName },
      onEvent
    );
    send({ type: 'progress', message: `${sitesSummary} Planned ${scenarios.length} test case(s) - generating them now...` });

    let generated = 0;
    let failed = 0;
    for (let i = 0; i < scenarios.length; i++) {
      const scenario = scenarios[i];
      const timestamp = Date.now().toString(36);
      const slug = `${slugify(scenario.title || scenario.prompt, 60 - timestamp.length - 1)}-${timestamp}`;
      send({ type: 'progress', message: `[${i + 1}/${scenarios.length}] Generating: ${scenario.title}` });
      busyIds.add(slug);
      try {
        const item = await generateTestCase(
          {
            url: scenario.url || url,
            prompt: scenario.prompt,
            context,
            title: scenario.title,
            testTypes: scenario.testTypes,
            slug,
          },
          send,
          onEvent
        );
        send({ type: 'item', item });
        generated++;
      } catch (err) {
        console.error(`[scan-site] scenario "${scenario.title}" failed: ${err.message}`);
        send({ type: 'progress', message: `[${i + 1}/${scenarios.length}] Failed: ${scenario.title} - ${err.message}` });
        failed++;
      } finally {
        busyIds.delete(slug);
      }
    }

    send({ type: 'done', item: { sitesSummary, planned: scenarios.length, generated, failed } });
  } catch (err) {
    console.error(`[scan-site] failed: ${err.message}`);
    send({ type: 'error', message: err.message, detail: err.detail });
  } finally {
    busyIds.delete(scanId);
    if (prdPath) {
      fs.unlink(prdPath).catch(() => {});
    }
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
  if (busyIds.has(id)) {
    return res.status(409).json({ error: 'this test case is still generating/running/healing - wait for it to finish before deleting it' });
  }

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

  const id = path.basename(resolved, '.spec.ts');
  if (busyIds.has(id)) {
    return res.status(409).json({ error: 'this test case is currently generating/running/healing - wait for it to finish first' });
  }
  busyIds.add(id);

  console.log(`[run-test] running: ${file}`);
  try {
    const relFile = path.relative(PROJECT_ROOT, resolved);
    const result = await runPlaywrightTest(relFile);
    console.log(`[run-test] ${file} -> ${result.passed ? 'PASSED' : 'FAILED'}`);
    res.json({ ...result, reportUrl: '/report' });
  } finally {
    busyIds.delete(id);
  }
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

  // Guard against a concurrent delete (or another run-adaptive call) yanking this file out
  // from under this in-flight run - previously that crashed with an ENOENT mid-healer.
  const id = path.basename(resolvedPath, '.spec.ts');
  if (busyIds.has(id)) {
    return res.status(409).json({ error: 'this test case is still generating/running/healing - wait for it to finish first' });
  }
  busyIds.add(id);

  try {

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

  } finally {
    busyIds.delete(id);
  }
});

app.get('/health', (_req, res) => res.json({ ok: true }));

const PORT = process.env.PORT || 4000;
app.listen(PORT, () => console.log(`QA generation API listening on http://localhost:${PORT}`));
