import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: '.',
  fullyParallel: true,
  reporter: 'html',
  use: {
    // 'on' (not the default 'on-first-retry') so every run - pass or fail - gets a trace,
    // not just retries. The HTML reporter below embeds the Trace Viewer automatically per
    // test once a trace exists: a step-by-step timeline that highlights the exact element
    // each action targeted, with before/after DOM snapshots - this is what actually answers
    // "what did it click and where", which slowed-down video playback alone can't show.
    trace: 'on',
    screenshot: 'on',
    video: 'on',
    // Real, visible pacing between actions during execution (not just video playback speed) -
    // so a fast-running test still reads as a clear, followable sequence of steps when watched,
    // whether live or in the recording. This does add real wall-clock time to every run
    // (roughly +slowMo ms per action) - tune down or unset PLAYWRIGHT_SLOW_MO_MS for contexts
    // where total scan duration matters more than per-action clarity (e.g. a large batch scan).
    launchOptions: {
      slowMo: process.env.PLAYWRIGHT_SLOW_MO_MS ? Number(process.env.PLAYWRIGHT_SLOW_MO_MS) : 500,
    },
  },
  projects: [
    { name: 'chromium', use: { ...devices['Desktop Chrome'] } },
  ],
});
