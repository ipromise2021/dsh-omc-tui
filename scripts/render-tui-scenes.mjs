import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { THEMES } from '../src/renderer/themes.js';

const theme = THEMES.claude;

// ANSI 256 to Hex color map for accurate terminal rendering
const COLOR_MAP = {
  '38;5;209': '#ff875f', // coral / terracotta
  '38;5;214': '#ffaf00', // amber / accent
  '38;5;250': '#bcbcbc', // text / ink (soft white)
  '38;5;241': '#626262', // thinking / muted
  '38;5;245': '#8a8a8a', // code / comment
  '38;5;251': '#e4e4e4', // bright text
  '38;5;108': '#87af87', // green / ok / diff+
  '38;5;203': '#ff5f5f', // red / error / diff-
  '38;5;75': '#5fafff',  // blue / keyword
  '38;5;178': '#d7af00', // yellow
  '38;5;236': '#303030', // rule / border
  '38;5;238': '#444444', // subtle rule
  '38;5;235': '#262626', // card bg
  '48;5;238': 'background-color: #444444;', // selected item bg
  '48;5;235': 'background-color: #262626;',
};

function ansiToHtml(text) {
  let html = '';
  let openSpans = 0;
  const parts = text.split(/(\x1b\[[0-9;]*m)/g);

  for (const part of parts) {
    if (!part) continue;
    if (part === '\x1b[0m' || part === '\x1b[m') {
      while (openSpans > 0) {
        html += '</span>';
        openSpans--;
      }
    } else if (part.startsWith('\x1b[')) {
      const code = part.slice(2, -1);
      let style = '';
      if (COLOR_MAP[code]) {
        if (code.startsWith('48;')) {
          style = COLOR_MAP[code];
        } else {
          style = `color: ${COLOR_MAP[code]};`;
        }
      } else if (code === '1') {
        style = 'font-weight: bold;';
      } else if (code === '2') {
        style = 'opacity: 0.7;';
      } else if (code === '7') {
        style = 'background-color: #ff875f; color: #1e1e1e; font-weight: bold;';
      } else if (code.startsWith('38;5;')) {
        style = `color: #ff875f;`;
      }
      if (style) {
        html += `<span style="${style}">`;
        openSpans++;
      }
    } else {
      // Escape HTML
      const escaped = part
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;');
      html += escaped;
    }
  }

  while (openSpans > 0) {
    html += '</span>';
    openSpans--;
  }
  return html;
}

function createTerminalHtml(title, contentRows) {
  const contentHtml = contentRows.map(row => ansiToHtml(row)).join('\n');
  return `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body {
    background-color: #121214;
    display: flex;
    justify-content: center;
    align-items: flex-start;
    padding: 24px;
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
  }
  .terminal-window {
    width: 1060px;
    background-color: #1e1e1e;
    border-radius: 10px;
    box-shadow: 0 20px 60px rgba(0, 0, 0, 0.65), 0 0 0 1px rgba(255, 255, 255, 0.08);
    overflow: hidden;
  }
  .terminal-header {
    background-color: #2d2d2d;
    height: 36px;
    display: flex;
    align-items: center;
    padding: 0 14px;
    border-bottom: 1px solid rgba(0, 0, 0, 0.4);
    position: relative;
  }
  .traffic-lights {
    display: flex;
    gap: 8px;
  }
  .dot {
    width: 12px;
    height: 12px;
    border-radius: 50%;
  }
  .dot-red { background-color: #ff5f56; border: 1px solid #e0443e; }
  .dot-yellow { background-color: #ffbd2e; border: 1px solid #dea123; }
  .dot-green { background-color: #27c93f; border: 1px solid #1aab29; }
  .terminal-title {
    position: absolute;
    left: 0; right: 0;
    text-align: center;
    font-size: 12px;
    color: #9a9a9a;
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
    letter-spacing: 0.3px;
  }
  .terminal-body {
    padding: 16px 20px 24px 20px;
    font-family: "SF Mono", Menlo, Monaco, "Cascadia Code", "Courier New", monospace;
    font-size: 13.5px;
    line-height: 1.45;
    color: #bcbcbc;
    white-space: pre;
    tab-size: 2;
    overflow-x: hidden;
  }
</style>
</head>
<body>
  <div class="terminal-window">
    <div class="terminal-header">
      <div class="traffic-lights">
        <div class="dot dot-red"></div>
        <div class="dot dot-yellow"></div>
        <div class="dot dot-green"></div>
      </div>
      <div class="terminal-title">${title}</div>
    </div>
    <div class="terminal-body">${contentHtml}</div>
  </div>
</body>
</html>`;
}

// Scene 1: Stream Dialogue, Thinking fold, Markdown, and Diff Output
const ANSI = theme;
const sceneStreamAndDiff = [
  `${ANSI.blue}YOU${ANSI.reset} ${ANSI.dim}· 14:32${ANSI.reset}`,
  `${ANSI.rule}╭────────────────────────────────────────────────────────────────────────────────────────╮${ANSI.reset}`,
  `${ANSI.rule}│${ANSI.reset} 重构 src/renderer/diff.js 中的 approvalDiffLines 函数，使其支持灵活的 2/4 参数调用       ${ANSI.rule}│${ANSI.reset}`,
  `${ANSI.rule}╰────────────────────────────────────────────────────────────────────────────────────────╯${ANSI.reset}`,
  `  ${ANSI.dim}◫ 上下文注入 · skill-catalog (11 skills) · git status${ANSI.reset}`,
  ``,
  `${ANSI.coral}DSH${ANSI.reset}  ${ANSI.dim}deepseek-v4-flash · 14:32${ANSI.reset}`,
  ``,
  `  ${ANSI.coral}✻${ANSI.reset} ${ANSI.dim}thinking · 18 lines · 1.2s${ANSI.reset}`,
  ``,
  `  已完成对 ${ANSI.accent}\`approvalDiffLines\`${ANSI.reset} 的参数鲁棒性重构，自动从 \`request\` 中解析参数：`,
  ``,
  `${ANSI.coral}diff --git a/src/renderer/diff.js b/src/renderer/diff.js${ANSI.reset}`,
  `${ANSI.dim}--- a/src/renderer/diff.js${ANSI.reset}`,
  `${ANSI.dim}+++ b/src/renderer/diff.js${ANSI.reset}`,
  `${ANSI.dim}@@ -28,15 +28,29 @@${ANSI.reset}`,
  `${ANSI.dim} export function renderDiffLines(text, contentWidth, ANSI = defaultAnsi) {${ANSI.reset}`,
  `${ANSI.dim}   return rows${ANSI.reset}`,
  `${ANSI.dim} }${ANSI.reset}`,
  `${ANSI.dim} ${ANSI.reset}`,
  `${ANSI.coral}-export function approvalDiffLines(request, args, columns, ANSI = defaultAnsi) {${ANSI.reset}`,
  `${ANSI.ok}+export function approvalDiffLines(request, argsOrColumns, columnsOrAnsi, ANSI = defaultAnsi) {${ANSI.reset}`,
  `${ANSI.ok}+  let args = typeof argsOrColumns === 'object' && argsOrColumns !== null ? argsOrColumns : undefined${ANSI.reset}`,
  `${ANSI.ok}+  let columns = typeof argsOrColumns === 'number' ? argsOrColumns : (typeof columnsOrAnsi === 'number' ? columnsOrAnsi : 80)${ANSI.reset}`,
  `${ANSI.ok}+  let ansiTheme = typeof columnsOrAnsi === 'object' && columnsOrAnsi !== null ? columnsOrAnsi : (ANSI ?? defaultAnsi)${ANSI.reset}`,
  `${ANSI.dim}   const command = args.command${ANSI.reset}`,
  ``,
  `  ${ANSI.ok}✓${ANSI.reset} ${ANSI.dim}finished in 1.8s · 1 tool (str-replace-editor)${ANSI.reset}`,
  ``,
  `${ANSI.rule}──────────────────────────────────────────────────────────────────────────────────────────${ANSI.reset}`,
  `${ANSI.coral}❯${ANSI.reset} `,
  `${ANSI.rule}──────────────────────────────────────────────────────────────────────────────────────────${ANSI.reset}`,
  `${ANSI.dim}BUILD | [deepseek-v4-flash] | dsh-omc-tui | "重构 approvalDiffLines"          preset standard · effort DEFAULT${ANSI.reset}`,
  `${ANSI.dim}Context ${ANSI.ok}████░░░░░░░░░░${ANSI.dim} 12.4k / 200k tokens · 6% | in 11.2k · out 1.2k · cache 8.4k${ANSI.reset}`,
  `${ANSI.dim}prompt system · 11 skills · 5 MCPs · 0 hooks · tools edit · jobs 0${ANSI.reset}`,
  `${ANSI.coral}▶▶${ANSI.reset} ${ANSI.dim}permission ${ANSI.coral}workspace-write${ANSI.reset} ${ANSI.dim}· Shift+Tab${ANSI.reset}`
];

// Scene 2: Interactive Approval Card
const sceneApprovalCard = [
  `${ANSI.coral}DSH${ANSI.reset}  ${ANSI.dim}deepseek-v4-flash · 14:35${ANSI.reset}`,
  `  ${ANSI.dim}⚛ Thought for 12s (ctrl+o to expand)${ANSI.reset}`,
  `  ${ANSI.blueSoft}● Edit(src/renderer/diff.js)${ANSI.reset}`,
  ``,
  `  ${ANSI.bold}${ANSI.ink}Edit file${ANSI.reset}`,
  `  ${ANSI.dim}src/renderer/diff.js${ANSI.reset}`,
  `${ANSI.rule}──────────────────────────────────────────────────────────────────────────────────────────${ANSI.reset}`,
  `  ${ANSI.dim} 31${ANSI.reset} ${ANSI.coral}- export function approvalDiffLines(request, args, columns, ANSI = defaultAnsi) {${ANSI.reset}`,
  `  ${ANSI.dim} 32${ANSI.reset} ${ANSI.blue}+ export function approvalDiffLines(request, argsOrColumns, columnsOrAnsi, ANSI = defaultAnsi) {${ANSI.reset}`,
  `  ${ANSI.dim} 33${ANSI.reset} ${ANSI.blue}+   let args = typeof argsOrColumns === 'object' && argsOrColumns !== null ? argsOrColumns : undefined${ANSI.reset}`,
  `  ${ANSI.dim} 34${ANSI.reset} ${ANSI.blue}+   let columns = typeof argsOrColumns === 'number' ? argsOrColumns : 80${ANSI.reset}`,
  `${ANSI.rule}──────────────────────────────────────────────────────────────────────────────────────────${ANSI.reset}`,
  `  ${ANSI.ink}${ANSI.bold}Do you want to make this edit to src/renderer/diff.js?${ANSI.reset}`,
  `  ${ANSI.blue}❯ 1. Yes (Y)${ANSI.reset}`,
  `    ${ANSI.dim}2. No (N)${ANSI.reset}`,
  ``,
  `  ${ANSI.muted}Esc to cancel · Tab / ↑↓ to navigate · Enter to confirm · y / n quick keys${ANSI.reset}`
];

// Scene 3: @ File Tree Autocomplete Picker
const sceneFilePicker = [
  `${ANSI.rule}╭────────────────────────────────────────────────────────────────────╮${ANSI.reset}`,
  `${ANSI.rule}│${ANSI.reset} ${ANSI.coral}✻ DSH OMC${ANSI.reset}  ${ANSI.dim}Oh-My-Claude · keyboard-first terminal${ANSI.reset}                  ${ANSI.rule}│${ANSI.reset}`,
  `${ANSI.rule}│${ANSI.reset}                                                                    ${ANSI.rule}│${ANSI.reset}`,
  `${ANSI.rule}│${ANSI.reset} ${ANSI.dim}model${ANSI.reset}     deepseek-official/deepseek-v4-flash ${ANSI.dim}DEFAULT${ANSI.reset}              ${ANSI.rule}│${ANSI.reset}`,
  `${ANSI.rule}│${ANSI.reset} ${ANSI.dim}directory${ANSI.reset} /Users/yy0812024/work/dsh-plugin/dsh-omc-tui              ${ANSI.rule}│${ANSI.reset}`,
  `${ANSI.rule}╰────────────────────────────────────────────────────────────────────╯${ANSI.reset}`,
  ``,
  `${ANSI.rule}──────────────────────────────────────────────────────────────────────────────────────────${ANSI.reset}`,
  `${ANSI.coral}❯${ANSI.reset} 请审查 @src/`,
  `${ANSI.rule}──────────────────────────────────────────────────────────────────────────────────────────${ANSI.reset}`,
  `  ${ANSI.accent}FILES · @src/ · 6 matching${ANSI.reset}`,
  ``,
  `  ${ANSI.coral}>${ANSI.reset}  ${ANSI.accent}commands/${ANSI.reset}                                       ${ANSI.dim}(DIR)${ANSI.reset}`,
  `     ${ANSI.dim}core/${ANSI.reset}                                           ${ANSI.dim}(DIR)${ANSI.reset}`,
  `     ${ANSI.dim}input/${ANSI.reset}                                          ${ANSI.dim}(DIR)${ANSI.reset}`,
  `     ${ANSI.dim}panels/${ANSI.reset}                                         ${ANSI.dim}(DIR)${ANSI.reset}`,
  `     ${ANSI.dim}renderer/${ANSI.reset}                                       ${ANSI.dim}(DIR)${ANSI.reset}`,
  `     ${ANSI.dim}index.js${ANSI.reset}                                         ${ANSI.dim}(JS, 129KB)${ANSI.reset}`,
  ``,
  `  ${ANSI.dim}↑↓ navigate  ·  Enter open/select  ·  Esc up/close${ANSI.reset}`
];

// Scene 4: /status Global Diagnostic Dashboard
const sceneStatusDashboard = [
  `${ANSI.coral}❯ /status${ANSI.reset}`,
  `  ${ANSI.accent}⎿ Model:${ANSI.reset}        deepseek-official/deepseek-v4-flash ${ANSI.dim}· effort DEFAULT${ANSI.reset}`,
  `  ${ANSI.accent}⎿ Mode:${ANSI.reset}         BUILD ${ANSI.dim}· Preset: standard${ANSI.reset}`,
  `  ${ANSI.accent}⎿ Directory:${ANSI.reset}    /Users/yy0812024/work/dsh-plugin/dsh-omc-tui`,
  `  ${ANSI.accent}⎿ Session:${ANSI.reset}      9c16d39a ${ANSI.dim}· "重构 approvalDiffLines" (4 turns, 28 events)${ANSI.reset}`,
  `  ${ANSI.accent}⎿ Context:${ANSI.reset}      12.4k / 200k tokens (6%) ${ANSI.dim}· in 11.2k, out 1.2k, cache 8.4k (75%)${ANSI.reset}`,
  `  ${ANSI.accent}⎿ Permission:${ANSI.reset}   workspace-write`,
  `  ${ANSI.accent}⎿ Extensions:${ANSI.reset}   11 skills · 5 MCPs · 0 hooks · 0 active jobs`,
  `  ${ANSI.accent}⎿ Preferences:${ANSI.reset}  theme: claude · density: detailed · history: on`,
  ``,
  `${ANSI.rule}──────────────────────────────────────────────────────────────────────────────────────────${ANSI.reset}`,
  `${ANSI.coral}❯${ANSI.reset} `,
  `${ANSI.rule}──────────────────────────────────────────────────────────────────────────────────────────${ANSI.reset}`,
  `${ANSI.dim}BUILD | [deepseek-v4-flash] | dsh-omc-tui | "重构 approvalDiffLines"          preset standard · effort DEFAULT${ANSI.reset}`,
  `${ANSI.dim}Context ${ANSI.ok}████░░░░░░░░░░${ANSI.dim} 12.4k / 200k tokens · 6% | in 11.2k · out 1.2k · cache 8.4k${ANSI.reset}`,
  `${ANSI.dim}prompt system · 11 skills · 5 MCPs · 0 hooks · tools — · jobs 0${ANSI.reset}`,
  `${ANSI.coral}▶▶${ANSI.reset} ${ANSI.dim}permission ${ANSI.coral}workspace-write${ANSI.reset} ${ANSI.dim}· Shift+Tab${ANSI.reset}`
];

// Write HTMLs
fs.mkdirSync('/tmp/tui-shots', { recursive: true });

const scenes = [
  { name: 'stream-and-diff', title: 'dsh --profile tui (Stream & Diff)', rows: sceneStreamAndDiff },
  { name: 'approval-card', title: 'dsh --profile tui (Inline Approval)', rows: sceneApprovalCard },
  { name: 'file-picker', title: 'dsh --profile tui (@ File Completion)', rows: sceneFilePicker },
  { name: 'status-dashboard', title: 'dsh --profile tui (/status Diagnostic)', rows: sceneStatusDashboard }
];

for (const s of scenes) {
  const html = createTerminalHtml(s.title, s.rows);
  const htmlPath = `/tmp/tui-shots/${s.name}.html`;
  fs.writeFileSync(htmlPath, html, 'utf8');
  console.log(`Wrote ${htmlPath}`);

  // Capture screenshot with headless Chrome
  const outPng = path.resolve(`assets/${s.name}.png`);
  try {
    execSync(
      `"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" --headless --disable-gpu --screenshot="${outPng}" --window-size=1100,750 "file://${htmlPath}"`,
      { stdio: 'pipe' }
    );
    console.log(`✓ Generated ${outPng}`);
  } catch (err) {
    console.error(`Failed to capture ${s.name}:`, err.message);
  }
}
